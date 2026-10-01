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
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HANDLE_RE = /^[a-z0-9_]{1,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

// The SPA's CSS/JS are inlined directly into the single HTML document at
// boot (read once, synchronously, from disk) so the served page needs no
// further requests and no outbound network at runtime -- everything is in
// this one image.
const UI_CSS = fs.readFileSync(path.join(__dirname, 'ui', 'app.css'), 'utf8');
const UI_JS = fs.readFileSync(path.join(__dirname, 'ui', 'app.js'), 'utf8');

const PAGE_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocketful</title>
<style>${UI_CSS}</style>
</head>
<body>
<div id="app"><main><div class="card">Loading Pocketful...</div></main></div>
<script>${UI_JS}</script>
</body>
</html>`;

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
    authorizations: new Map(), // id -> authorization (holds)
    authorizationTtlSeconds: 600,
    settlementOperatorIds: new Set(),
    idempotency: new Map(), // userId -> Map(key -> record)
    counters: { user: 0, payment: 0, request: 0, split: 0, settlement: 0, authorization: 0, token: 0 },
    seq: 0, // monotonic tiebreaker for ordering
  };
}

let state = freshState();

const ID_PREFIX = { user: 'u', payment: 'p', request: 'rq', split: 'sp', settlement: 'st', authorization: 'a' };
const ID_MAP_FOR = {
  user: () => state.users,
  payment: () => state.payments,
  request: () => state.requests,
  split: () => state.splits,
  settlement: () => state.settlements,
  authorization: () => state.authorizations,
};

// A generated id must never equal any existing id of that kind (seeded or
// imported ids are not necessarily sequential, e.g. u_9 for a fixture with
// only two users). Loop past collisions rather than trusting the counter
// alone.
//
// MAJOR-A hardening: a seeded/imported id can carry a numeric suffix at or
// beyond Number.MAX_SAFE_INTEGER (e.g. p_9007199254740993, a 20-digit
// suffix). `+= 1` on a counter already at/above that bound stops advancing
// (float precision loss), so the old "increment then check existence" loop
// never terminates and blocks the event loop. nextId must provably
// terminate for ANY existing id set: cap plain counter-increment attempts,
// then fall back to a random extended suffix (still existence-checked) so
// the loop is always bounded regardless of what ids already exist.
const ID_GEN_COUNTER_ATTEMPT_LIMIT = 1000;

function nextId(prefix) {
  const existing = ID_MAP_FOR[prefix]();
  const p = ID_PREFIX[prefix];
  let id;
  let attempts = 0;
  do {
    attempts += 1;
    if (attempts <= ID_GEN_COUNTER_ATTEMPT_LIMIT && state.counters[prefix] < Number.MAX_SAFE_INTEGER) {
      state.counters[prefix] += 1;
      id = `${p}_${state.counters[prefix]}`;
    } else {
      // Bounded fallback: a short random suffix guarantees the loop cannot
      // spin forever no matter how many (or how large) ids already exist.
      // Stays well under the 64-char id cap.
      id = `${p}_r${crypto.randomBytes(8).toString('hex')}`;
    }
  } while (existing.has(id));
  return id;
}

// After loading a fixture or import, set each counter so freshly generated
// ids start past the highest numeric suffix seen for that kind (still
// guarded by the existence check in nextId for any gaps or non-numeric ids).
// Operates on an explicit target state (used while building newState before
// it becomes the live `state`).
//
// MAJOR-A hardening: parse suffixes with BigInt so an enormous suffix (e.g.
// a 20-digit number, or anything the fixture/import shape validator allows
// through) never produces a non-finite or imprecise counter value; clamp
// the result to a safe JS integer. nextId's bounded fallback above then
// guarantees termination regardless of how the counter ends up seeded.
function seedCounterFromIds(targetState, prefix, ids) {
  const p = ID_PREFIX[prefix];
  let max = BigInt(targetState.counters[prefix] || 0);
  const re = new RegExp(`^${p}_(\\d+)$`);
  for (const id of ids) {
    const m = re.exec(id);
    if (m) {
      let n;
      try {
        n = BigInt(m[1]);
      } catch {
        continue; // not parseable as an integer literal; ignore
      }
      if (n > max) max = n;
    }
  }
  const safeMax = max > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(max);
  targetState.counters[prefix] = safeMax;
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
// Stage 2: authorization (hold) expiry
// ---------------------------------------------------------------------------

// Lazy, clock-true expiry: no timers are needed. Every read AND write calls
// this once, under the lock, using a single "now" for that request, so an
// authorization whose expires_at is at or before now is treated as expired
// consistently for the whole request — its remainder is released back into
// `available` and it can never be captured or voided again.
function sweepExpiredAuthorizations(nowMs) {
  for (const a of state.authorizations.values()) {
    if (a.status === 'open' && Date.parse(a.expiresAt) <= nowMs) {
      a.status = 'expired';
    }
  }
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
    const [saltHex, keyHex] = (stored || '').split(':');
    let salt, key;
    try {
      salt = Buffer.from(saltHex, 'hex');
      key = Buffer.from(keyHex, 'hex');
    } catch (e) {
      return resolve(false);
    }
    if (!salt.length || key.length !== 64) {
      // Malformed stored hash (e.g. imported from an untrusted source):
      // never crash the process on a shape mismatch, just fail the login.
      return resolve(false);
    }
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
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) throw err(401, 'unauthenticated', 'authorization must be a bearer token');
  const token = m[1];
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

// held = sum of remaining_amount over this user's OPEN (unexpired, by the
// caller's responsibility to have swept first) holds where they are the
// payer. available = total - held, clamped to never go negative (it
// shouldn't mathematically, but a clamp costs nothing and is a good last
// line of defense).
function heldAmount(userId) {
  let held = 0;
  for (const a of state.authorizations.values()) {
    if (a.fromUserId === userId && a.status === 'open') {
      held += a.amount - a.capturedAmount;
    }
  }
  return held;
}

function availableBalance(user) {
  const held = heldAmount(user.id);
  const available = user.balance - held;
  return available < 0 ? 0 : available;
}

function userMe(user) {
  const held = heldAmount(user.id);
  const available = user.balance - held < 0 ? 0 : user.balance - held;
  return {
    user_id: user.id,
    display_name: user.displayName,
    handle: user.handle,
    balance: user.balance,
    total: user.balance,
    available,
    held,
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
    authorization_id: p.authorizationId || null,
    created_at: p.createdAt,
  };
}

function authorizationView(a) {
  return {
    authorization_id: a.id,
    from_user_id: a.fromUserId,
    from_handle: state.users.get(a.fromUserId).handle,
    to_user_id: a.toUserId,
    to_handle: state.users.get(a.toUserId).handle,
    amount: a.amount,
    captured_amount: a.capturedAmount,
    remaining_amount: a.status === 'open' ? a.amount - a.capturedAmount : 0,
    currency: state.currency,
    note: a.note,
    visibility: a.visibility,
    status: a.status,
    expires_at: a.expiresAt,
    payment_id: a.paymentIds.length ? a.paymentIds[a.paymentIds.length - 1] : null,
    payment_ids: [...a.paymentIds],
    created_at: a.createdAt,
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

// Resolves an idempotency key. The record is scoped to (authenticated user,
// method, path, key) — the same key string on a different path is an
// independent request, never overwriting or being resolved against the
// other path's record (MAJOR-1). Returns { existing } with the original
// record if this exact (method,path,body) was already claimed, throws 409
// on key reuse with a different body on the SAME (method,path), or returns
// { existing: null } meaning "proceed, then claim on success".
function idempotencyMapKey(method, path, key) {
  return `${method} ${path}\u0000${key}`;
}

function resolveIdempotency(user, method, path, key, body) {
  let userMap = state.idempotency.get(user.id);
  if (!userMap) {
    userMap = new Map();
    state.idempotency.set(user.id, userMap);
  }
  const mapKey = idempotencyMapKey(method, path, key);
  const rec = userMap.get(mapKey);
  if (!rec) return { userMap, mapKey, existing: null };
  if (bodyEqual(rec.body, body)) {
    return { userMap, mapKey, existing: rec };
  }
  throw err(409, 'idempotency_key_reuse', 'idempotency key reused with a different body');
}

function claimIdempotency(userMap, mapKey, method, path, body, status, response) {
  // Only 2xx claims a key.
  if (status >= 200 && status < 300) {
    userMap.set(mapKey, { method, path, body: canonicalize(body), status, response });
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
  const authorizationsFixture = Array.isArray(fixture.authorizations) ? fixture.authorizations : [];
  const ttl = fixture.authorization_ttl_seconds === undefined ? 600 : fixture.authorization_ttl_seconds;
  if (!isIntegralNumber(ttl) || ttl < 1) {
    throw err(422, 'validation_failed', 'invalid authorization_ttl_seconds');
  }

  const newState = freshState();
  newState.currency = currency;
  newState.minorUnits = minorUnits;
  newState.authorizationTtlSeconds = ttl;

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
      authorizationId: null,
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

  const nowMs = Date.now();
  const heldByUser = new Map();
  for (const a of authorizationsFixture) {
    if (!isPlainObject(a)) throw err(422, 'validation_failed', 'invalid authorization in fixture');
    const {
      id,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      amount,
      note,
      visibility,
      status,
      expires_at: expiresAt,
      captured_amount: capturedAmount,
      payment_ids: paymentIds,
    } = a;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid authorization id');
    if (!newState.users.has(fromUserId) || !newState.users.has(toUserId)) {
      throw err(422, 'validation_failed', 'unknown user in seeded authorization');
    }
    if (!isIntegralNumber(amount) || amount < 1) {
      throw err(422, 'validation_failed', 'invalid seeded authorization amount');
    }
    const vis = visibility === undefined ? 'public' : visibility;
    if (vis !== 'public' && vis !== 'private') throw err(422, 'validation_failed', 'invalid seeded visibility');
    let st = status === undefined ? 'open' : status;
    if (!['open', 'captured', 'voided', 'expired'].includes(st)) {
      throw err(422, 'validation_failed', 'invalid seeded authorization status');
    }
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      throw err(422, 'validation_failed', 'invalid seeded authorization expires_at');
    }
    const captured = capturedAmount === undefined ? 0 : capturedAmount;
    if (!isIntegralNumber(captured) || captured < 0 || captured > amount) {
      throw err(422, 'validation_failed', 'invalid seeded authorization captured_amount');
    }
    const pids = paymentIds === undefined ? [] : paymentIds;
    if (!Array.isArray(pids) || pids.some((pid) => typeof pid !== 'string')) {
      throw err(422, 'validation_failed', 'invalid seeded authorization payment_ids');
    }
    // A past expiry always wins over a seeded "open" status.
    if (st === 'open' && Date.parse(expiresAt) <= nowMs) {
      st = 'expired';
    }
    newState.authorizations.set(id, {
      id,
      fromUserId,
      toUserId,
      amount,
      capturedAmount: captured,
      note: typeof note === 'string' ? note : '',
      visibility: vis,
      status: st,
      expiresAt,
      paymentIds: [...pids],
      createdAt: nowIsoFor(newState),
      seq: (newState.seq += 1),
    });
    if (st === 'open') {
      heldByUser.set(fromUserId, (heldByUser.get(fromUserId) || 0) + (amount - captured));
    }
  }

  // A user's sum of seeded UNEXPIRED open holds must not exceed their
  // balance, or the whole reset is rejected unchanged.
  for (const [uid, held] of heldByUser) {
    const u = newState.users.get(uid);
    if (held > u.balance) {
      throw err(422, 'validation_failed', 'seeded open holds exceed balance');
    }
  }

  seedCounterFromIds(newState, 'user', [...newState.users.keys()]);
  seedCounterFromIds(newState, 'payment', [...newState.payments.keys()]);
  seedCounterFromIds(newState, 'request', [...newState.requests.keys()]);
  seedCounterFromIds(newState, 'split', []);
  seedCounterFromIds(newState, 'settlement', []);
  seedCounterFromIds(newState, 'authorization', [...newState.authorizations.keys()]);

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
    authorizations: [...state.authorizations.values()],
    authorizationTtlSeconds: state.authorizationTtlSeconds,
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
  if (typeof s.currency !== 'string' || s.currency.length === 0) return false;
  if (![0, 2, 3].includes(s.minorUnits)) return false;
  if (!isPlainObject(s.counters)) return false;
  if (typeof s.seq !== 'number') return false;
  // Stage 2 additions: accept an unchanged Stage 1 export where these are
  // simply absent — default them rather than fail shape validation.
  if (s.authorizations !== undefined && !Array.isArray(s.authorizations)) return false;
  if (s.authorizationTtlSeconds !== undefined && typeof s.authorizationTtlSeconds !== 'number') return false;
  return true;
}

// Full semantic validation of an import payload (MAJOR-4): beyond the basic
// shape check above, every reference must resolve, every id/handle/email
// must be unique, and every record must satisfy the same invariants the
// service otherwise enforces by construction. Throws 422 validation_failed
// on the first problem found; the destination is untouched until this
// function returns without throwing.
function validateImportSemantics(s) {
  const userIds = new Set();
  const handles = new Set();
  const emails = new Set();
  for (const u of s.users) {
    if (!isPlainObject(u)) throw err(422, 'validation_failed', 'invalid user record');
    const { id, email, passwordHash, displayName, handle, balance } = u;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid user id');
    if (userIds.has(id)) throw err(422, 'validation_failed', 'duplicate user id');
    userIds.add(id);
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw err(422, 'validation_failed', 'invalid user email');
    if (emails.has(email)) throw err(422, 'validation_failed', 'duplicate user email');
    emails.add(email);
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) throw err(422, 'validation_failed', 'invalid user handle');
    if (handles.has(handle)) throw err(422, 'validation_failed', 'duplicate user handle');
    handles.add(handle);
    if (typeof passwordHash !== 'string' || !/^[0-9a-f]{2,}:[0-9a-f]{128}$/.test(passwordHash)) {
      // salt is any even-length hex string (16-byte salts hex-encode to 32
      // chars, but be lenient on salt length while pinning the derived key
      // to exactly 64 bytes / 128 hex chars, matching hashPassword above).
      throw err(422, 'validation_failed', 'missing or invalid password hash');
    }
    if (typeof displayName !== 'string') throw err(422, 'validation_failed', 'invalid display_name');
    if (!isIntegralNumber(balance) || balance < 0) {
      throw err(422, 'validation_failed', 'invalid or negative balance');
    }
  }

  for (const t of s.tokens) {
    if (!isPlainObject(t) || typeof t.token !== 'string' || typeof t.userId !== 'string') {
      throw err(422, 'validation_failed', 'invalid token record');
    }
    if (!userIds.has(t.userId)) throw err(422, 'validation_failed', 'token references unknown user');
  }

  const paymentIds = new Set();
  for (const p of s.payments) {
    if (!isPlainObject(p)) throw err(422, 'validation_failed', 'invalid payment record');
    const { id, fromUserId, toUserId, amount, note, visibility, requestId, settlementId, authorizationId, createdAt } = p;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid payment id');
    if (paymentIds.has(id)) throw err(422, 'validation_failed', 'duplicate payment id');
    paymentIds.add(id);
    if (!userIds.has(fromUserId) || !userIds.has(toUserId)) {
      throw err(422, 'validation_failed', 'payment references unknown user');
    }
    // MAJOR-B: import must accept anything the service can legitimately
    // produce (e.g. a 0-amount request/payment from a zero-share split) or
    // that reset accepts (seeded amounts up to 2e9). Stored records are not
    // subject to the API's 1..1e9 request-body range; only non-negative
    // safe-integer is required here. (Splits pay out a share to each
    // participant; a share can legitimately be 0 per spec §9 equal-split.)
    if (!isIntegralNumber(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
      throw err(422, 'validation_failed', 'invalid payment amount');
    }
    if (typeof note !== 'string') throw err(422, 'validation_failed', 'invalid payment note');
    if (visibility !== 'public' && visibility !== 'private') {
      throw err(422, 'validation_failed', 'invalid payment visibility');
    }
    if (requestId !== null && typeof requestId !== 'string') {
      throw err(422, 'validation_failed', 'invalid payment request_id');
    }
    if (settlementId !== null && typeof settlementId !== 'string') {
      throw err(422, 'validation_failed', 'invalid payment settlement_id');
    }
    if (authorizationId !== undefined && authorizationId !== null && typeof authorizationId !== 'string') {
      throw err(422, 'validation_failed', 'invalid payment authorization_id');
    }
    if (typeof createdAt !== 'string') throw err(422, 'validation_failed', 'invalid payment created_at');
  }

  const requestIds = new Set();
  for (const r of s.requests) {
    if (!isPlainObject(r)) throw err(422, 'validation_failed', 'invalid request record');
    const { id, requesterId, payerId, amount, note, status, paymentId, createdAt } = r;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid request id');
    if (requestIds.has(id)) throw err(422, 'validation_failed', 'duplicate request id');
    requestIds.add(id);
    if (!userIds.has(requesterId) || !userIds.has(payerId)) {
      throw err(422, 'validation_failed', 'request references unknown user');
    }
    // MAJOR-B: see payment amount comment above — 0 is legitimate (a
    // zero-share split request), and reset accepts seeded amounts up to 2e9.
    if (!isIntegralNumber(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
      throw err(422, 'validation_failed', 'invalid request amount');
    }
    if (typeof note !== 'string') throw err(422, 'validation_failed', 'invalid request note');
    if (!['pending', 'paid', 'declined', 'cancelled'].includes(status)) {
      throw err(422, 'validation_failed', 'invalid request status');
    }
    if (paymentId !== null && typeof paymentId !== 'string' && typeof paymentId !== 'number') {
      throw err(422, 'validation_failed', 'invalid request payment_id');
    }
    // MINOR-C: reset accepts a seeded paid request whose payment_id names a
    // payment that was never seeded (or is a bare number), so import must
    // not impose a dangling-reference check here that reset doesn't. Real
    // integrity checks (dangling USER references, duplicate ids, negative
    // balances, bad password hashes) are still enforced above/elsewhere.
    if (typeof createdAt !== 'string') throw err(422, 'validation_failed', 'invalid request created_at');
  }

  const splitIds = new Set();
  for (const sp of s.splits) {
    if (!isPlainObject(sp)) throw err(422, 'validation_failed', 'invalid split record');
    if (typeof sp.id !== 'string' || !sp.id) throw err(422, 'validation_failed', 'invalid split id');
    if (splitIds.has(sp.id)) throw err(422, 'validation_failed', 'duplicate split id');
    splitIds.add(sp.id);
    if (!isIntegralNumber(sp.amount) || sp.amount < 1) throw err(422, 'validation_failed', 'invalid split amount');
    if (!Array.isArray(sp.shares)) throw err(422, 'validation_failed', 'invalid split shares');
    if (!Array.isArray(sp.requestIds)) throw err(422, 'validation_failed', 'invalid split requestIds');
    for (const rid of sp.requestIds) {
      if (typeof rid !== 'string' || !requestIds.has(rid)) {
        throw err(422, 'validation_failed', 'split references unknown request');
      }
    }
  }

  const settlementIds = new Set();
  for (const st of s.settlements) {
    if (!isPlainObject(st)) throw err(422, 'validation_failed', 'invalid settlement record');
    if (typeof st.id !== 'string' || !st.id) throw err(422, 'validation_failed', 'invalid settlement id');
    if (settlementIds.has(st.id)) throw err(422, 'validation_failed', 'duplicate settlement id');
    settlementIds.add(st.id);
    if (!Array.isArray(st.paymentIds)) throw err(422, 'validation_failed', 'invalid settlement paymentIds');
    for (const pid of st.paymentIds) {
      if (typeof pid !== 'string' || !paymentIds.has(pid)) {
        throw err(422, 'validation_failed', 'settlement references unknown payment');
      }
    }
  }

  for (const opId of s.settlementOperatorIds) {
    if (typeof opId !== 'string' || !userIds.has(opId)) {
      throw err(422, 'validation_failed', 'settlement operator references unknown user');
    }
  }

  // Stage 2: authorizations (holds). Missing entirely (Stage 1 export) is
  // fine -- default to none / default ttl at the importSnapshot() call site.
  const authorizationIds = new Set();
  const authorizations = Array.isArray(s.authorizations) ? s.authorizations : [];
  for (const a of authorizations) {
    if (!isPlainObject(a)) throw err(422, 'validation_failed', 'invalid authorization record');
    const { id, fromUserId, toUserId, amount, capturedAmount, note, visibility, status, expiresAt, paymentIds: pids } = a;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid authorization id');
    if (authorizationIds.has(id)) throw err(422, 'validation_failed', 'duplicate authorization id');
    authorizationIds.add(id);
    if (!userIds.has(fromUserId) || !userIds.has(toUserId)) {
      throw err(422, 'validation_failed', 'authorization references unknown user');
    }
    if (!isIntegralNumber(amount) || amount < 1 || amount > Number.MAX_SAFE_INTEGER) {
      throw err(422, 'validation_failed', 'invalid authorization amount');
    }
    if (!isIntegralNumber(capturedAmount) || capturedAmount < 0 || capturedAmount > amount) {
      throw err(422, 'validation_failed', 'invalid authorization captured_amount');
    }
    if (typeof note !== 'string') throw err(422, 'validation_failed', 'invalid authorization note');
    if (visibility !== 'public' && visibility !== 'private') {
      throw err(422, 'validation_failed', 'invalid authorization visibility');
    }
    if (!['open', 'captured', 'voided', 'expired'].includes(status)) {
      throw err(422, 'validation_failed', 'invalid authorization status');
    }
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      throw err(422, 'validation_failed', 'invalid authorization expires_at');
    }
    if (!Array.isArray(pids) || pids.some((pid) => typeof pid !== 'string' || !paymentIds.has(pid))) {
      throw err(422, 'validation_failed', 'authorization references unknown payment');
    }
  }
  // Mirror reset: a wallet's unexpired open holds may never exceed its total.
  {
    const importNow = Date.now();
    const balanceById = new Map(s.users.map((u) => [u.id, u.balance]));
    const heldById = new Map();
    for (const a of authorizations) {
      if (a.status !== 'open' || Date.parse(a.expiresAt) <= importNow) continue;
      heldById.set(a.fromUserId, (heldById.get(a.fromUserId) || 0) + (a.amount - a.capturedAmount));
    }
    for (const [uid, held] of heldById) {
      if (held > balanceById.get(uid)) {
        throw err(422, 'validation_failed', 'open holds exceed wallet total');
      }
    }
  }
  if (s.authorizationTtlSeconds !== undefined) {
    if (!isIntegralNumber(s.authorizationTtlSeconds) || s.authorizationTtlSeconds < 1) {
      throw err(422, 'validation_failed', 'invalid authorization_ttl_seconds');
    }
  }

  for (const entry of s.idempotency) {
    if (!isPlainObject(entry) || typeof entry.userId !== 'string' || !Array.isArray(entry.records)) {
      throw err(422, 'validation_failed', 'invalid idempotency entry');
    }
    if (!userIds.has(entry.userId)) {
      throw err(422, 'validation_failed', 'idempotency record references unknown user');
    }
    for (const rec of entry.records) {
      if (!isPlainObject(rec) || typeof rec.key !== 'string' || !isPlainObject(rec.rec)) {
        throw err(422, 'validation_failed', 'invalid idempotency record');
      }
      const { method, path, body, status, response } = rec.rec;
      if (typeof method !== 'string' || typeof path !== 'string' || typeof status !== 'number') {
        throw err(422, 'validation_failed', 'invalid idempotency record shape');
      }
      if (body === undefined || response === undefined) {
        throw err(422, 'validation_failed', 'invalid idempotency record body/response');
      }
    }
  }

  if (!isPlainObject(s.counters)) throw err(422, 'validation_failed', 'invalid counters');
  for (const k of Object.keys(ID_PREFIX)) {
    // A Stage 1 export predates the `authorization` counter; default it so
    // such exports still import successfully.
    if (s.counters[k] === undefined) s.counters[k] = 0;
    if (typeof s.counters[k] !== 'number' || !Number.isFinite(s.counters[k]) || s.counters[k] < 0) {
      throw err(422, 'validation_failed', 'invalid counters');
    }
    // MAJOR-A: clamp an imported counter value to a safe integer so a
    // maliciously/accidentally huge counters value can never itself push
    // nextId()'s plain-increment path into float-precision-loss territory;
    // combined with the BigInt-based seedCounterFromIds and nextId's bounded
    // random fallback, id generation remains provably terminating.
    s.counters[k] = Math.min(Math.floor(s.counters[k]), Number.MAX_SAFE_INTEGER);
  }
}

function importSnapshot(snapshot) {
  if (!validateImportShape(snapshot)) {
    throw err(422, 'validation_failed', 'invalid import shape');
  }
  const s = deepCopy(snapshot.state);
  // Validate everything BEFORE touching the live state, so a rejected
  // import never mutates the destination (MAJOR-4).
  validateImportSemantics(s);

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
  for (const a of s.authorizations || []) newState.authorizations.set(a.id, a);
  newState.authorizationTtlSeconds =
    s.authorizationTtlSeconds === undefined ? 600 : s.authorizationTtlSeconds;
  for (const opId of s.settlementOperatorIds) newState.settlementOperatorIds.add(opId);
  for (const entry of s.idempotency) {
    const m = new Map();
    for (const { key, rec } of entry.records) m.set(key, rec);
    newState.idempotency.set(entry.userId, m);
  }
  newState.counters = { ...s.counters };
  newState.seq = s.seq;
  // Single synchronous assignment: no handler can ever observe a
  // half-swapped state (MAJOR-3).
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
  // The body has been fully read by now and everything from here to the end
  // of `fn` is synchronous, so take "now" and expire holds at the instant the
  // state is judged and mutated -- not at the start of a possibly slow request.
  sweepExpiredAuthorizations(Date.now());
  const key = validateIdempotencyKeyHeader(req);
  const { userMap, mapKey, existing } = resolveIdempotency(user, method, path, key, body);
  if (existing) {
    return { status: 200, body: existing.response };
  }
  const result = fn();
  claimIdempotency(userMap, mapKey, method, path, body, result.status, result.body);
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
  if (availableBalance(user) < amt) throw err(409, 'insufficient_funds', 'balance too low');

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
    authorizationId: null,
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
  if (availableBalance(user) < request.amount) throw err(409, 'insufficient_funds', 'balance too low');

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
    authorizationId: null,
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
    const held = heldAmount(u.id);
    if (u.balance + delta - held < 0) throw err(409, 'insufficient_funds', 'settlement not affordable');
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
      authorizationId: null,
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
// Authorizations (holds)
// ---------------------------------------------------------------------------

function doCreateAuthorization(user, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const { to_handle: toHandle, amount, note, visibility } = body;
  if (typeof toHandle !== 'string') throw err(422, 'validation_failed', 'to_handle required');
  const amt = validateAmount(amount);
  const n = validateNote(note);
  const vis = validateVisibility(visibility);
  if (toHandle === user.handle) throw err(422, 'self_payment', 'cannot pay yourself');
  const toUserId = state.usersByHandle.get(toHandle);
  if (!toUserId) throw err(404, 'not_found', 'no such user');
  if (availableBalance(user) < amt) throw err(409, 'insufficient_funds', 'balance too low');

  const id = nextId('authorization');
  // One clock read: expires_at is exactly created_at + ttl, never off by the
  // milliseconds between two separate reads.
  const createdMs = Date.now();
  const createdAt = new Date(createdMs).toISOString().replace('Z', '+00:00');
  const expiresAt = new Date(createdMs + state.authorizationTtlSeconds * 1000).toISOString().replace('Z', '+00:00');
  const authorization = {
    id,
    fromUserId: user.id,
    toUserId,
    amount: amt,
    capturedAmount: 0,
    note: n,
    visibility: vis,
    status: 'open',
    expiresAt,
    paymentIds: [],
    createdAt,
    seq: nextSeq(),
  };
  state.authorizations.set(id, authorization);
  return { status: 201, body: authorizationView(authorization) };
}

function doCaptureAuthorization(user, authorizationId, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const authorization = state.authorizations.get(authorizationId);
  if (!authorization) throw err(404, 'not_found', 'no such authorization');
  if (authorization.toUserId !== user.id) throw err(403, 'forbidden', 'not the receiver');

  const remaining = authorization.amount - authorization.capturedAmount;
  // Precedence: captured/voided -> not_open; open-but-clock-expired -> expired.
  if (authorization.status === 'captured' || authorization.status === 'voided') {
    throw err(409, 'authorization_not_open', 'authorization is not open');
  }
  if (authorization.status === 'expired') {
    throw err(409, 'authorization_expired', 'authorization has expired');
  }

  const { amount, final: finalRaw } = body;
  const amt = amount === undefined ? remaining : validateAmount(amount);
  if (finalRaw !== undefined && typeof finalRaw !== 'boolean') {
    throw err(400, 'malformed_request', 'final must be a boolean');
  }
  const final = finalRaw === undefined ? true : finalRaw;
  if (amt > remaining) throw err(422, 'capture_exceeds_authorization', 'capture exceeds remaining amount');

  const fromUser = state.users.get(authorization.fromUserId);
  const toUser = state.users.get(authorization.toUserId);
  // Captures spend money already reserved by the hold, so they must succeed
  // even when `available` is 0 (it always is, or near it, once the full
  // amount is held) — we only move the ledger balances here, never check
  // `available` again.
  fromUser.balance -= amt;
  toUser.balance += amt;
  authorization.capturedAmount += amt;

  const newRemaining = authorization.amount - authorization.capturedAmount;
  if (final || newRemaining === 0) {
    authorization.status = 'captured';
  }

  const pid = nextId('payment');
  const payment = {
    id: pid,
    fromUserId: authorization.fromUserId,
    toUserId: authorization.toUserId,
    amount: amt,
    note: authorization.note,
    visibility: authorization.visibility,
    requestId: null,
    settlementId: null,
    authorizationId: authorization.id,
    createdAt: nowIso(),
    seq: nextSeq(),
  };
  state.payments.set(pid, payment);
  authorization.paymentIds.push(pid);

  return { status: 201, body: paymentView(payment) };
}

function doVoidAuthorization(user, authorizationId) {
  const authorization = state.authorizations.get(authorizationId);
  if (!authorization) throw err(404, 'not_found', 'no such authorization');
  if (authorization.fromUserId !== user.id) throw err(403, 'forbidden', 'not the payer');
  if (authorization.status === 'voided') {
    return { status: 200, body: authorizationView(authorization) };
  }
  if (authorization.status === 'captured' || authorization.status === 'expired') {
    throw err(409, 'authorization_not_open', 'authorization is not open');
  }
  authorization.status = 'voided';
  return { status: 200, body: authorizationView(authorization) };
}

function doListAuthorizations(user, query) {
  const { limit, offset } = parseLimitOffset(query);
  let direction = null;
  if (query.has('direction')) {
    direction = query.get('direction');
    if (!['incoming', 'outgoing'].includes(direction)) throw err(422, 'validation_failed', 'invalid direction');
  }
  let status = null;
  if (query.has('status')) {
    status = query.get('status');
    if (!['open', 'captured', 'voided', 'expired'].includes(status)) {
      throw err(422, 'validation_failed', 'invalid status');
    }
  }
  let items = [...state.authorizations.values()].filter(
    (a) => a.fromUserId === user.id || a.toUserId === user.id
  );
  if (direction === 'incoming') items = items.filter((a) => a.toUserId === user.id);
  if (direction === 'outgoing') items = items.filter((a) => a.fromUserId === user.id);
  if (status) items = items.filter((a) => a.status === status);
  items.sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : b.seq - a.seq));
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return { status: 200, body: { authorizations: page.map(authorizationView), has_more: hasMore } };
}

// ---------------------------------------------------------------------------
// Content negotiation & static HTML shell
// ---------------------------------------------------------------------------

const STATIC_PAGE_ROUTES = new Set(['/', '/split', '/signup', '/login', '/authorizations']);

function wantsHtml(req) {
  const accept = req.headers['accept'];
  if (!accept || typeof accept !== 'string') return false;
  // Only prefer HTML when it's explicitly requested and preferred over JSON;
  // a bare "*/*" (e.g. curl default) or a client that also accepts JSON
  // explicitly should get JSON, since the JS app itself always sends
  // "Accept: application/json" for its API fetches.
  if (accept.includes('application/json')) return false;
  return /text\/html/i.test(accept);
}

let cachedPageShell = null;
function servePageShell(res) {
  if (cachedPageShell === null) {
    cachedPageShell = buildPageShell();
  }
  const buf = Buffer.from(cachedPageShell, 'utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

function buildPageShell() {
  return PAGE_SHELL_HTML;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(req, res) {
  // Lazy expiry sweep: every request (read or write) sees a consistent view
  // where any hold whose expires_at has passed is already "expired", using
  // one `now` snapshot for the whole request.
  sweepExpiredAuthorizations(Date.now());

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

  // Authentication must be checked BEFORE the body is read, so a
  // missing/invalid token wins over a malformed body (401, not 400) per the
  // spec's error-check ordering (MINOR-D). But the *user object* used in the
  // synchronous critical section must always be re-resolved from CURRENT
  // state immediately before that critical section runs, never carried
  // across an `await` (MAJOR-3) — a concurrent reset/import could have
  // replaced state while the body was being read. authenticate() only
  // checks the header format + token lookup (cheap, synchronous, no
  // `await` inside it), so calling it twice — once up front for the early
  // 401, once again right before the critical section for a fresh user
  // reference — satisfies both requirements at once.

  if (method === 'GET' && pathname === '/me') {
    const user = authenticate(req);
    return json(res, 200, userMe(user));
  }

  if (method === 'POST' && pathname === '/payments') {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doPayment(user, body));
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/requests') {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doCreateRequest(user, body));
    return json(res, result.status, result.body);
  }

  const payMatch = /^\/requests\/([^/]+)\/pay$/.exec(pathname);
  if (method === 'POST' && payMatch) {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () =>
      doPayRequest(user, payMatch[1], body)
    );
    return json(res, result.status, result.body);
  }

  const declineMatch = /^\/requests\/([^/]+)\/decline$/.exec(pathname);
  if (method === 'POST' && declineMatch) {
    const user = authenticate(req);
    const result = doDeclineRequest(user, declineMatch[1]);
    return json(res, result.status, result.body);
  }

  const cancelMatch = /^\/requests\/([^/]+)\/cancel$/.exec(pathname);
  if (method === 'POST' && cancelMatch) {
    const user = authenticate(req);
    const result = doCancelRequest(user, cancelMatch[1]);
    return json(res, result.status, result.body);
  }

  if (method === 'GET' && pathname === '/requests') {
    // The HTML shell itself requires no auth: it is the same static SPA
    // document for every route, and the browser's own script re-fetches
    // /requests as JSON using the token in localStorage. Only the JSON API
    // branch needs a caller.
    if (wantsHtml(req)) return servePageShell(res);
    const user = authenticate(req);
    const result = doListRequests(user, url.searchParams);
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/authorizations') {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doCreateAuthorization(user, body));
    return json(res, result.status, result.body);
  }

  const captureMatch = /^\/authorizations\/([^/]+)\/capture$/.exec(pathname);
  if (method === 'POST' && captureMatch) {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () =>
      doCaptureAuthorization(user, captureMatch[1], body)
    );
    return json(res, result.status, result.body);
  }

  const voidMatch = /^\/authorizations\/([^/]+)\/void$/.exec(pathname);
  if (method === 'POST' && voidMatch) {
    const user = authenticate(req);
    const result = doVoidAuthorization(user, voidMatch[1]);
    return json(res, result.status, result.body);
  }

  if (method === 'GET' && pathname === '/authorizations') {
    if (wantsHtml(req)) return servePageShell(res);
    const user = authenticate(req);
    const result = doListAuthorizations(user, url.searchParams);
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/splits') {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doSplit(user, body));
    return json(res, result.status, result.body);
  }

  if (method === 'GET' && pathname === '/activity') {
    const user = authenticate(req);
    const result = doActivity(user, url.searchParams);
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/settlements') {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doSettlement(user, body));
    return json(res, result.status, result.body);
  }

  // Browser-navigable HTML shell routes. These serve the SPA shell; the
  // client-side router then renders the right screen. Any of these requested
  // without an HTML-accepting client (e.g. a bare curl) still gets the shell
  // -- these paths are never part of the JSON API surface.
  if (method === 'GET' && STATIC_PAGE_ROUTES.has(pathname)) {
    return servePageShell(res);
  }

  // An unrecognised route still requires authentication first, per §6: every
  // endpoint other than health, the _test/* endpoints, and auth/* requires a
  // bearer token, and that check precedes 404 "route not found".
  authenticate(req);
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
    // A client that destroys its socket mid-request (aborted body) makes
    // parseJsonBody reject; that's not a server bug and there is no one to
    // answer, so just drop it quietly. Only check the RESPONSE/socket
    // state here — req.destroyed also flips true after an ordinary,
    // fully-read request body (not just an abort), so checking it would
    // wrongly swallow legitimate error responses on every normal request.
    if (res.writableEnded || !res.socket || res.socket.destroyed) {
      return;
    }
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
  console.log(`pocketful stage-2 listening on 0.0.0.0:${PORT}`);
});

module.exports = { server, applyFixture };
