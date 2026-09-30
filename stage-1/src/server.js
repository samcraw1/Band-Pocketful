'use strict';
/*
 * Pocketful — Stage 1 service.
 *
 * Single process, single Node.js event loop, in-memory state. Node's event loop
 * is single-threaded: as long as a request's state read-modify-write happens in
 * one synchronous block (no `await` between reading and committing state), two
 * concurrent requests can never interleave mid-mutation. That is our "global
 * lock" — slow work (password hashing) is done with `crypto.scrypt` BEFORE the
 * synchronous state-mutation block, so it never holds up other requests nor is
 * itself part of the atomic section.
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HANDLE_RE = /^[a-z0-9_]{1,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function freshState() {
  return {
    currency: 'EUR',
    minorUnits: 2,
    users: new Map(), // id -> user
    usersByHandle: new Map(), // handle -> id
    usersByEmail: new Map(), // email -> id
    tokens: new Map(), // token -> user id
    payments: new Map(), // id -> payment
    requests: new Map(), // id -> request
    splits: new Map(), // id -> split
    settlements: new Map(), // id -> settlement
    settlementOperatorIds: new Set(),
    idempotency: new Map(), // userId -> Map(key -> record)
    counters: { user: 0, payment: 0, request: 0, split: 0, settlement: 0, token: 0 },
    seq: 0, // monotonic tiebreaker for ordering
  };
}

let state = freshState();

function nextId(prefix) {
  state.counters[prefix] += 1;
  return `${prefix === 'user' ? 'u' : prefix === 'payment' ? 'p' : prefix === 'request' ? 'rq' : prefix === 'split' ? 'sp' : prefix === 'settlement' ? 'st' : 'x'}_${state.counters[prefix]}`;
}

function nextSeq() {
  state.seq += 1;
  return state.seq;
}

function nowIso() {
  // RFC3339 with explicit offset; Date#toISOString always uses "Z" which is a
  // valid explicit offset (+00:00 equivalent).
  return new Date().toISOString().replace('Z', '+00:00');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function err(status, code, message) {
  return new ApiError(status, code, message);
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt), async so it never blocks the event loop.
// ---------------------------------------------------------------------------

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (e, derivedKey) => {
      if (e) return reject(e);
      resolve(`${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [saltHex, keyHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const key = Buffer.from(keyHex, 'hex');
    crypto.scrypt(password, salt, 64, (e, derivedKey) => {
      if (e) return reject(e);
      resolve(crypto.timingSafeEqual(key, derivedKey));
    });
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isIntegralNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
}

function validateAmount(v) {
  if (!isIntegralNumber(v)) throw err(422, 'validation_failed', 'amount must be an integral number');
  if (v < 1 || v > 1000000000) throw err(422, 'validation_failed', 'amount out of range');
  return v;
}

function validateNote(v) {
  if (v === undefined) return '';
  if (typeof v !== 'string') throw err(422, 'validation_failed', 'note must be a string');
  if ([...v].length > 200) throw err(422, 'validation_failed', 'note too long');
  return v;
}

function validateVisibility(v) {
  if (v === undefined) return 'public';
  if (v !== 'public' && v !== 'private') throw err(422, 'validation_failed', 'invalid visibility');
  return v;
}

function validateIdempotencyKeyHeader(req) {
  const key = req.headers['idempotency-key'];
  if (key === undefined || key === '' || (Array.isArray(key) && key.length === 0)) {
    throw err(400, 'missing_idempotency_key', 'Idempotency-Key header required');
  }
  const k = Array.isArray(key) ? key[0] : key;
  if (k.length === 0) throw err(400, 'missing_idempotency_key', 'Idempotency-Key header required');
  if (k.length > 255) throw err(422, 'validation_failed', 'Idempotency-Key too long');
  return k;
}

function parsePlainDecimalInt(str, name) {
  if (!/^[0-9]+$/.test(str)) throw err(422, 'validation_failed', `${name} must be a plain decimal integer`);
  const n = parseInt(str, 10);
  if (!Number.isFinite(n)) throw err(422, 'validation_failed', `${name} invalid`);
  return n;
}

function parseLimitOffset(query) {
  let limit = 50;
  let offset = 0;
  if (query.has('limit')) {
    limit = parsePlainDecimalInt(query.get('limit'), 'limit');
    if (limit < 1 || limit > 200) throw err(422, 'validation_failed', 'limit out of range');
  }
  if (query.has('offset')) {
    offset = parsePlainDecimalInt(query.get('offset'), 'offset');
    if (offset < 0) throw err(422, 'validation_failed', 'offset out of range');
  }
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') throw err(401, 'unauthenticated', 'missing bearer token');
  let token = auth;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) token = m[1];
  const userId = state.tokens.get(token);
  if (!userId) throw err(401, 'unauthenticated', 'unknown token');
  const user = state.users.get(userId);
  if (!user) throw err(401, 'unauthenticated', 'unknown token');
  return user;
}

function deriveHandleFromEmail(email) {
  const local = email.split('@')[0];
  let handle = local.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  handle = handle.slice(0, 20);
  if (handle.length === 0) handle = '_';
  return handle;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function userMe(user) {
  return {
    user_id: user.id,
    display_name: user.displayName,
    handle: user.handle,
    balance: user.balance,
    currency: state.currency,
    minor_units: state.minorUnits,
  };
}

function paymentView(p) {
  return {
    payment_id: p.id,
    from_user_id: p.fromUserId,
    from_handle: state.users.get(p.fromUserId).handle,
    to_user_id: p.toUserId,
    to_handle: state.users.get(p.toUserId).handle,
    amount: p.amount,
    currency: state.currency,
    note: p.note,
    visibility: p.visibility,
    request_id: p.requestId,
    settlement_id: p.settlementId,
    created_at: p.createdAt,
  };
}

function requestView(r) {
  return {
    request_id: r.id,
    requester_id: r.requesterId,
    requester_handle: state.users.get(r.requesterId).handle,
    payer_id: r.payerId,
    payer_handle: state.users.get(r.payerId).handle,
    amount: r.amount,
    currency: state.currency,
    note: r.note,
    status: r.status,
    payment_id: r.paymentId,
    created_at: r.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

function canonicalize(v) {
  // JSON-value equality independent of key order: sort object keys recursively.
  if (Array.isArray(v)) return v.map(canonicalize);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

function bodyEqual(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

// Resolves an idempotency key. Returns { replay: response } if this exact
// (method,path,body) was already claimed, throws 409 on key reuse with a
// different body, or returns null meaning "proceed, then claim on success".
function resolveIdempotency(user, method, path, key, body) {
  let userMap = state.idempotency.get(user.id);
  if (!userMap) {
    userMap = new Map();
    state.idempotency.set(user.id, userMap);
  }
  const rec = userMap.get(key);
  if (!rec) return { userMap, existing: null };
  if (rec.method === method && rec.path === path && bodyEqual(rec.body, body)) {
    return { userMap, existing: rec };
  }
  if (rec.method === method && rec.path === path) {
    throw err(409, 'idempotency_key_reuse', 'idempotency key reused with a different body');
  }
  // Same key, different path: not a replay, treat as unused for this path.
  return { userMap, existing: null, differentPath: true };
}

function claimIdempotency(userMap, key, method, path, body, status, response) {
  // Only 2xx claims a key.
  if (status >= 200 && status < 300) {
    userMap.set(key, { method, path, body: canonicalize(body), status, response });
  }
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(err(400, 'malformed_request', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  let text;
  try {
    text = buf.toString('utf8');
  } catch (e) {
    throw err(400, 'malformed_request', 'invalid utf-8');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw err(400, 'malformed_request', 'invalid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw err(400, 'malformed_request', 'body must be a JSON object');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Reset / fixture
// ---------------------------------------------------------------------------

function applyFixture(fixture) {
  if (!isPlainObject(fixture)) throw err(422, 'validation_failed', 'fixture must be an object');
  const currency = fixture.currency;
  const minorUnits = fixture.minor_units;
  if (typeof currency !== 'string' || currency.length === 0) {
    throw err(422, 'validation_failed', 'invalid currency');
  }
  if (![0, 2, 3].includes(minorUnits)) {
    throw err(422, 'validation_failed', 'invalid minor_units');
  }
  const usersFixture = Array.isArray(fixture.users) ? fixture.users : [];
  const paymentsFixture = Array.isArray(fixture.payments) ? fixture.payments : [];
  const requestsFixture = Array.isArray(fixture.requests) ? fixture.requests : [];
  const operatorIds = Array.isArray(fixture.settlement_operator_ids)
    ? fixture.settlement_operator_ids
    : [];

  const newState = freshState();
  newState.currency = currency;
  newState.minorUnits = minorUnits;

  const seenHandles = new Set();
  const seenEmails = new Set();
  const seenUserIds = new Set();
  for (const u of usersFixture) {
    if (!isPlainObject(u)) throw err(422, 'validation_failed', 'invalid user in fixture');
    const { id, email, password, display_name: displayName, handle, balance } = u;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid user id');
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw err(422, 'validation_failed', 'invalid user email');
    if (typeof password !== 'string' || password.length === 0) throw err(422, 'validation_failed', 'invalid user password');
    if (typeof displayName !== 'string') throw err(422, 'validation_failed', 'invalid display_name');
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) throw err(422, 'validation_failed', 'invalid handle');
    if (!isIntegralNumber(balance) || balance < 0) {
      throw err(422, 'validation_failed', 'invalid or negative balance');
    }
    if (seenHandles.has(handle) || seenEmails.has(email) || seenUserIds.has(id)) {
      throw err(422, 'validation_failed', 'duplicate user in fixture');
    }
    seenHandles.add(handle);
    seenEmails.add(email);
    seenUserIds.add(id);
  }

  // All validated: commit users (hash passwords synchronously via scryptSync
  // here — reset is not on the hot path and the spec requires seeded users to
  // be able to log in immediately; simplicity wins over marginal blocking).
  for (const u of usersFixture) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(u.password, salt, 64);
    const passwordHash = `${salt.toString('hex')}:${key.toString('hex')}`;
    const user = {
      id: u.id,
      email: u.email,
      passwordHash,
      displayName: u.display_name,
      handle: u.handle,
      balance: u.balance,
    };
    newState.users.set(user.id, user);
    newState.usersByHandle.set(user.handle, user.id);
    newState.usersByEmail.set(user.email, user.id);
  }

  for (const p of paymentsFixture) {
    if (!isPlainObject(p)) throw err(422, 'validation_failed', 'invalid payment in fixture');
    const { id, from_user_id: fromUserId, to_user_id: toUserId, amount, note, visibility } = p;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid payment id');
    if (!newState.users.has(fromUserId) || !newState.users.has(toUserId)) {
      throw err(422, 'validation_failed', 'unknown user in seeded payment');
    }
    if (!isIntegralNumber(amount) || amount < 1) throw err(422, 'validation_failed', 'invalid seeded payment amount');
    const vis = visibility === undefined ? 'public' : visibility;
    if (vis !== 'public' && vis !== 'private') throw err(422, 'validation_failed', 'invalid seeded visibility');
    newState.payments.set(id, {
      id,
      fromUserId,
      toUserId,
      amount,
      note: typeof note === 'string' ? note : '',
      visibility: vis,
      requestId: null,
      settlementId: null,
      createdAt: nowIsoFor(newState),
      seq: (newState.seq += 1),
    });
  }

  for (const r of requestsFixture) {
    if (!isPlainObject(r)) throw err(422, 'validation_failed', 'invalid request in fixture');
    const { id, requester_id: requesterId, payer_id: payerId, amount, note, status, payment_id: paymentId } = r;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid request id');
    if (!newState.users.has(requesterId) || !newState.users.has(payerId)) {
      throw err(422, 'validation_failed', 'unknown user in seeded request');
    }
    if (!isIntegralNumber(amount) || amount < 1) throw err(422, 'validation_failed', 'invalid seeded request amount');
    const st = status === undefined ? 'pending' : status;
    if (!['pending', 'paid', 'declined', 'cancelled'].includes(st)) {
      throw err(422, 'validation_failed', 'invalid seeded request status');
    }
    newState.requests.set(id, {
      id,
      requesterId,
      payerId,
      amount,
      note: typeof note === 'string' ? note : '',
      status: st,
      paymentId: paymentId || null,
      createdAt: nowIsoFor(newState),
      seq: (newState.seq += 1),
    });
  }

  for (const opId of operatorIds) {
    if (typeof opId !== 'string' || !newState.users.has(opId)) {
      throw err(422, 'validation_failed', 'unknown settlement operator id');
    }
    newState.settlementOperatorIds.add(opId);
  }

  newState.counters.user = usersFixture.length;
  newState.counters.payment = paymentsFixture.length;
  newState.counters.request = requestsFixture.length;

  state = newState;
}

function nowIsoFor() {
  return nowIso();
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

function serializeState() {
  return {
    currency: state.currency,
    minorUnits: state.minorUnits,
    users: [...state.users.values()],
    tokens: [...state.tokens.entries()].map(([token, userId]) => ({ token, userId })),
    payments: [...state.payments.values()],
    requests: [...state.requests.values()],
    splits: [...state.splits.values()],
    settlements: [...state.settlements.values()],
    settlementOperatorIds: [...state.settlementOperatorIds],
    idempotency: [...state.idempotency.entries()].map(([userId, m]) => ({
      userId,
      records: [...m.entries()].map(([key, rec]) => ({ key, rec })),
    })),
    counters: { ...state.counters },
    seq: state.seq,
  };
}

function exportSnapshot() {
  // Deep-copied atomic snapshot: since we are in a synchronous block, no
  // concurrent write can interleave with this read.
  return deepCopy(serializeState());
}

function validateImportShape(snapshot) {
  if (!isPlainObject(snapshot)) return false;
  if (snapshot.track !== 'pocketful') return false;
  if (snapshot.format_version !== 1) return false;
  if (!isPlainObject(snapshot.state)) return false;
  const s = snapshot.state;
  const requiredArrays = ['users', 'tokens', 'payments', 'requests', 'splits', 'settlements', 'settlementOperatorIds', 'idempotency'];
  for (const k of requiredArrays) {
    if (!Array.isArray(s[k])) return false;
  }
  if (typeof s.currency !== 'string') return false;
  if (![0, 2, 3].includes(s.minorUnits)) return false;
  if (!isPlainObject(s.counters)) return false;
  if (typeof s.seq !== 'number') return false;
  return true;
}

function importSnapshot(snapshot) {
  if (!validateImportShape(snapshot)) {
    throw err(422, 'validation_failed', 'invalid import shape');
  }
  const s = deepCopy(snapshot.state);
  const newState = freshState();
  newState.currency = s.currency;
  newState.minorUnits = s.minorUnits;
  for (const u of s.users) {
    newState.users.set(u.id, u);
    newState.usersByHandle.set(u.handle, u.id);
    newState.usersByEmail.set(u.email, u.id);
  }
  for (const t of s.tokens) newState.tokens.set(t.token, t.userId);
  for (const p of s.payments) newState.payments.set(p.id, p);
  for (const r of s.requests) newState.requests.set(r.id, r);
  for (const sp of s.splits) newState.splits.set(sp.id, sp);
  for (const st of s.settlements) newState.settlements.set(st.id, st);
  for (const opId of s.settlementOperatorIds) newState.settlementOperatorIds.add(opId);
  for (const entry of s.idempotency) {
    const m = new Map();
    for (const { key, rec } of entry.records) m.set(key, rec);
    newState.idempotency.set(entry.userId, m);
  }
  newState.counters = { ...s.counters };
  newState.seq = s.seq;
  state = newState;
}

// ---------------------------------------------------------------------------
// Equal split (§9)
// ---------------------------------------------------------------------------

function equalSplit(amount, n) {
  const base = Math.floor(amount / n);
  const remainder = amount - base * n;
  const shares = [];
  for (let i = 0; i < n; i++) shares.push(base + (i < remainder ? 1 : 0));
  return shares;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleSignup(body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const { email, password, display_name: displayName } = body;
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw err(422, 'validation_failed', 'invalid email');
  if (typeof password !== 'string' || password.length < 8) throw err(422, 'validation_failed', 'password too short');
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw err(422, 'validation_failed', 'invalid display_name');
  }
  if (state.usersByEmail.has(email)) throw err(409, 'email_taken', 'email already registered');
  const handle = deriveHandleFromEmail(email);
  if (state.usersByHandle.has(handle)) throw err(409, 'handle_taken', 'derived handle already taken');

  const passwordHash = await hashPassword(password); // slow work, outside any mutation

  // Synchronous commit section.
  if (state.usersByEmail.has(email)) throw err(409, 'email_taken', 'email already registered');
  if (state.usersByHandle.has(handle)) throw err(409, 'handle_taken', 'derived handle already taken');
  const id = nextId('user');
  const user = { id, email, passwordHash, displayName, handle, balance: 0 };
  state.users.set(id, user);
  state.usersByHandle.set(handle, id);
  state.usersByEmail.set(email, id);
  state.counters.token += 1;
  const token = `tok_${state.counters.token}_${crypto.randomBytes(12).toString('hex')}`;
  state.tokens.set(token, id);
  return { status: 201, body: { user_id: id, display_name: displayName, token } };
}

async function handleLogin(body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const { email, password } = body;
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw err(401, 'unauthenticated', 'wrong password or unknown email');
  }
  const userId = state.usersByEmail.get(email);
  if (!userId) throw err(401, 'unauthenticated', 'wrong password or unknown email');
  const user = state.users.get(userId);
  const ok = await verifyPassword(password, user.passwordHash); // slow work outside mutation
  if (!ok) throw err(401, 'unauthenticated', 'wrong password or unknown email');
  // Re-check user still exists (defensive against a reset racing in).
  if (!state.users.has(userId)) throw err(401, 'unauthenticated', 'wrong password or unknown email');
  state.counters.token += 1;
  const token = `tok_${state.counters.token}_${crypto.randomBytes(12).toString('hex')}`;
  state.tokens.set(token, userId);
  return { status: 200, body: { user_id: userId, display_name: user.displayName, token } };
}

function withIdempotency(user, method, path, req, body, fn) {
  const key = validateIdempotencyKeyHeader(req);
  const { userMap, existing } = resolveIdempotency(user, method, path, key, body);
  if (existing) {
    return { status: 200, body: existing.response };
  }
  const result = fn();
  claimIdempotency(userMap, key, method, path, body, result.status, result.body);
  return result;
}

function doPayment(user, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const { to_handle: toHandle, amount, note, visibility } = body;
  if (typeof toHandle !== 'string') throw err(422, 'validation_failed', 'to_handle required');
  const amt = validateAmount(amount);
  const n = validateNote(note);
  const vis = validateVisibility(visibility);
  if (toHandle === user.handle) throw err(422, 'self_payment', 'cannot pay yourself');
  const toUserId = state.usersByHandle.get(toHandle);
  if (!toUserId) throw err(404, 'not_found', 'no such user');
  if (user.balance < amt) throw err(409, 'insufficient_funds', 'balance too low');

  const toUser = state.users.get(toUserId);
  user.balance -= amt;
  toUser.balance += amt;
  const id = nextId('payment');
  const payment = {
    id,
    fromUserId: user.id,
    toUserId,
    amount: amt,
    note: n,
    visibility: vis,
    requestId: null,
    settlementId: null,
    createdAt: nowIso(),
    seq: nextSeq(),
  };
  state.payments.set(id, payment);
  return { status: 201, body: paymentView(payment) };
}

function doCreateRequest(user, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const { payer_handle: payerHandle, amount, note } = body;
  if (typeof payerHandle !== 'string') throw err(422, 'validation_failed', 'payer_handle required');
  const amt = validateAmount(amount);
  const n = validateNote(note);
  if (payerHandle === user.handle) throw err(422, 'self_request', 'cannot request from yourself');
  const payerId = state.usersByHandle.get(payerHandle);
  if (!payerId) throw err(404, 'not_found', 'no such user');

  const id = nextId('request');
  const request = {
    id,
    requesterId: user.id,
    payerId,
    amount: amt,
    note: n,
    status: 'pending',
    paymentId: null,
    createdAt: nowIso(),
    seq: nextSeq(),
  };
  state.requests.set(id, request);
  return { status: 201, body: requestView(request) };
}

function doPayRequest(user, requestId, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const vis = validateVisibility(body.visibility);
  const request = state.requests.get(requestId);
  if (!request) throw err(404, 'not_found', 'no such request');
  if (request.payerId !== user.id) throw err(403, 'forbidden', 'not your request');
  if (request.status !== 'pending') throw err(409, 'request_not_pending', 'request already settled');
  if (user.balance < request.amount) throw err(409, 'insufficient_funds', 'balance too low');

  const toUser = state.users.get(request.requesterId);
  user.balance -= request.amount;
  toUser.balance += request.amount;
  const id = nextId('payment');
  const payment = {
    id,
    fromUserId: user.id,
    toUserId: request.requesterId,
    amount: request.amount,
    note: '',
    visibility: vis,
    requestId: request.id,
    settlementId: null,
    createdAt: nowIso(),
    seq: nextSeq(),
  };
  state.payments.set(id, payment);
  request.status = 'paid';
  request.paymentId = id;
  return { status: 201, body: paymentView(payment) };
}

function doDeclineRequest(user, requestId) {
  const request = state.requests.get(requestId);
  if (!request) throw err(404, 'not_found', 'no such request');
  if (request.payerId !== user.id) throw err(403, 'forbidden', 'not your request');
  if (request.status === 'declined') return { status: 200, body: requestView(request) };
  if (request.status !== 'pending') throw err(409, 'request_not_pending', 'request already settled');
  request.status = 'declined';
  return { status: 200, body: requestView(request) };
}

function doCancelRequest(user, requestId) {
  const request = state.requests.get(requestId);
  if (!request) throw err(404, 'not_found', 'no such request');
  if (request.requesterId !== user.id) throw err(403, 'forbidden', 'not your request');
  if (request.status === 'cancelled') return { status: 200, body: requestView(request) };
  if (request.status !== 'pending') throw err(409, 'request_not_pending', 'request already settled');
  request.status = 'cancelled';
  return { status: 200, body: requestView(request) };
}

function doListRequests(user, query) {
  const { limit, offset } = parseLimitOffset(query);
  let direction = null;
  if (query.has('direction')) {
    direction = query.get('direction');
    if (!['incoming', 'outgoing'].includes(direction)) throw err(422, 'validation_failed', 'invalid direction');
  }
  let status = null;
  if (query.has('status')) {
    status = query.get('status');
    if (!['pending', 'paid', 'declined', 'cancelled'].includes(status)) {
      throw err(422, 'validation_failed', 'invalid status');
    }
  }
  let items = [...state.requests.values()].filter((r) => r.requesterId === user.id || r.payerId === user.id);
  if (direction === 'incoming') items = items.filter((r) => r.payerId === user.id);
  if (direction === 'outgoing') items = items.filter((r) => r.requesterId === user.id);
  if (status) items = items.filter((r) => r.status === status);
  items.sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : b.seq - a.seq));
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return { status: 200, body: { requests: page.map(requestView), has_more: hasMore } };
}

function doSplit(user, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const { amount, participant_handles: handles, note } = body;
  const amt = validateAmount(amount);
  const n = validateNote(note);
  if (!Array.isArray(handles) || handles.length === 0) {
    throw err(422, 'validation_failed', 'participant_handles required');
  }
  if (handles.some((h) => typeof h !== 'string')) {
    throw err(422, 'validation_failed', 'participant_handles must be strings');
  }
  if (new Set(handles).size !== handles.length) {
    throw err(422, 'validation_failed', 'duplicate participant handle');
  }
  const participantIds = [];
  for (const h of handles) {
    const uid = state.usersByHandle.get(h);
    if (!uid) throw err(404, 'not_found', 'no such user');
    participantIds.push(uid);
  }

  const shareAmounts = equalSplit(amt, handles.length);
  const shares = handles.map((h, i) => ({ handle: h, amount: shareAmounts[i] }));

  const id = nextId('split');
  const createdAt = nowIso();
  const requests = [];
  for (let i = 0; i < handles.length; i++) {
    if (participantIds[i] === user.id) continue; // no request for the caller
    const rid = nextId('request');
    const request = {
      id: rid,
      requesterId: user.id,
      payerId: participantIds[i],
      amount: shareAmounts[i],
      note: n,
      status: 'pending',
      paymentId: null,
      createdAt: nowIso(),
      seq: nextSeq(),
    };
    state.requests.set(rid, request);
    requests.push(requestView(request));
  }

  const split = { id, amount: amt, note: n, shares, requestIds: requests.map((r) => r.request_id), createdAt, seq: nextSeq() };
  state.splits.set(id, split);

  return {
    status: 201,
    body: {
      split_id: id,
      amount: amt,
      currency: state.currency,
      note: n,
      shares,
      requests,
      created_at: createdAt,
    },
  };
}

function doActivity(user, query) {
  const { limit, offset } = parseLimitOffset(query);
  let items = [...state.payments.values()].filter(
    (p) => p.visibility === 'public' || p.fromUserId === user.id || p.toUserId === user.id
  );
  items.sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : b.seq - a.seq));
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return { status: 200, body: { payments: page.map(paymentView), has_more: hasMore } };
}

function doSettlement(user, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  if (!state.settlementOperatorIds.has(user.id)) throw err(403, 'forbidden', 'not an operator');
  const { transfers } = body;
  if (!Array.isArray(transfers) || transfers.length < 1 || transfers.length > 32) {
    throw err(422, 'validation_failed', 'transfers must have 1..32 entries');
  }

  // Entry errors first, in input order.
  const parsed = [];
  for (const t of transfers) {
    if (!isPlainObject(t)) throw err(422, 'validation_failed', 'invalid transfer shape');
    const { from_handle: fromHandle, to_handle: toHandle, amount, note, visibility } = t;
    if (typeof fromHandle !== 'string' || typeof toHandle !== 'string') {
      throw err(422, 'validation_failed', 'invalid transfer shape');
    }
    const amt = validateAmount(amount);
    const n = validateNote(note);
    const vis = validateVisibility(visibility);
    if (fromHandle === toHandle) throw err(422, 'self_payment', 'cannot transfer to self');
    const fromId = state.usersByHandle.get(fromHandle);
    if (!fromId) throw err(404, 'not_found', 'no such user');
    const toId = state.usersByHandle.get(toHandle);
    if (!toId) throw err(404, 'not_found', 'no such user');
    parsed.push({ fromId, toId, amount: amt, note: n, visibility: vis });
  }

  // Affordability on net final balances.
  const deltas = new Map();
  for (const t of parsed) {
    deltas.set(t.fromId, (deltas.get(t.fromId) || 0) - t.amount);
    deltas.set(t.toId, (deltas.get(t.toId) || 0) + t.amount);
  }
  for (const [uid, delta] of deltas) {
    const u = state.users.get(uid);
    if (u.balance + delta < 0) throw err(409, 'insufficient_funds', 'settlement not affordable');
  }

  // Commit all-or-nothing.
  const id = nextId('settlement');
  const committedAt = nowIso();
  const payments = [];
  for (const t of parsed) {
    const fromUser = state.users.get(t.fromId);
    const toUser = state.users.get(t.toId);
    fromUser.balance -= t.amount;
    toUser.balance += t.amount;
    const pid = nextId('payment');
    const payment = {
      id: pid,
      fromUserId: t.fromId,
      toUserId: t.toId,
      amount: t.amount,
      note: t.note,
      visibility: t.visibility,
      requestId: null,
      settlementId: id,
      createdAt: committedAt,
      seq: nextSeq(),
    };
    state.payments.set(pid, payment);
    payments.push(paymentView(payment));
  }
  const settlement = { id, committedAt, paymentIds: payments.map((p) => p.payment_id) };
  state.settlements.set(id, settlement);

  return { status: 201, body: { settlement_id: id, committed_at: committedAt, payments } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  if (method === 'GET' && pathname === '/health') {
    return json(res, 200, { status: 'ok' });
  }

  if (method === 'POST' && pathname === '/_test/reset') {
    const body = await parseJsonBody(req);
    applyFixture(body);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === 'GET' && pathname === '/_test/export') {
    const snapshot = exportSnapshot();
    return json(res, 200, { track: 'pocketful', format_version: 1, state: snapshot });
  }

  if (method === 'POST' && pathname === '/_test/import') {
    const body = await parseJsonBody(req);
    importSnapshot(body);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === 'POST' && pathname === '/auth/signup') {
    const body = await parseJsonBody(req);
    const result = await handleSignup(body);
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/auth/login') {
    const body = await parseJsonBody(req);
    const result = await handleLogin(body);
    return json(res, result.status, result.body);
  }

  // Everything below requires authentication.
  const user = authenticate(req);

  if (method === 'GET' && pathname === '/me') {
    return json(res, 200, userMe(user));
  }

  if (method === 'POST' && pathname === '/payments') {
    const body = await parseJsonBody(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doPayment(user, body));
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/requests') {
    const body = await parseJsonBody(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doCreateRequest(user, body));
    return json(res, result.status, result.body);
  }

  const payMatch = /^\/requests\/([^/]+)\/pay$/.exec(pathname);
  if (method === 'POST' && payMatch) {
    const body = await parseJsonBody(req);
    const result = withIdempotency(user, method, pathname, req, body, () =>
      doPayRequest(user, payMatch[1], body)
    );
    return json(res, result.status, result.body);
  }

  const declineMatch = /^\/requests\/([^/]+)\/decline$/.exec(pathname);
  if (method === 'POST' && declineMatch) {
    const result = doDeclineRequest(user, declineMatch[1]);
    return json(res, result.status, result.body);
  }

  const cancelMatch = /^\/requests\/([^/]+)\/cancel$/.exec(pathname);
  if (method === 'POST' && cancelMatch) {
    const result = doCancelRequest(user, cancelMatch[1]);
    return json(res, result.status, result.body);
  }

  if (method === 'GET' && pathname === '/requests') {
    const result = doListRequests(user, url.searchParams);
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/splits') {
    const body = await parseJsonBody(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doSplit(user, body));
    return json(res, result.status, result.body);
  }

  if (method === 'GET' && pathname === '/activity') {
    const result = doActivity(user, url.searchParams);
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/settlements') {
    const body = await parseJsonBody(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doSettlement(user, body));
    return json(res, result.status, result.body);
  }

  throw err(404, 'not_found', 'no such route');
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof ApiError) {
      json(res, e.status, { error: { code: e.code, message: e.message } });
    } else {
      // Never 5xx per spec: fall back to a generic 500 only as an absolute
      // last resort while surfacing the failure in logs for debugging.
      // eslint-disable-next-line no-console
      console.error('unexpected error', e);
      json(res, 500, { error: { code: 'internal_error', message: 'unexpected error' } });
    }
  });
});

server.on('clientError', (err_, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`pocketful stage-1 listening on 0.0.0.0:${PORT}`);
});

module.exports = { server, applyFixture };
