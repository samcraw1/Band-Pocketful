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
    counters: { user: 0, payment: 0, request: 0, split: 0, settlement: 0, authorization: 0, batch: 0, token: 0 },
    seq: 0, // monotonic tiebreaker for ordering
    // Stage 3: per-user indexes (so statements and as_of reads never scan every
    // payment), statement snapshots, and the payment clock's high-water mark.
    userPayments: new Map(), // userId -> payments the user sent or received
    userAuths: new Map(), // payer userId -> authorizations
    batches: new Map(), // correction batch id -> { id, recordedAt }
    refundsOf: new Map(), // target payment id -> refund payments
    ledgerVersion: 0, // bumped whenever a payment or revision is added
    statementCache: new Map(),
    statementCacheVersion: 0,
    snapshots: new Map(), // token -> frozen statement result
    resetNs: 0n,
    lastNs: 0n,
  };
}

let state = freshState();

const ID_PREFIX = { user: 'u', payment: 'p', request: 'rq', split: 'sp', settlement: 'st', authorization: 'a', batch: 'cb' };
const ID_MAP_FOR = {
  user: () => state.users,
  payment: () => state.payments,
  request: () => state.requests,
  split: () => state.splits,
  settlement: () => state.settlements,
  authorization: () => state.authorizations,
  batch: () => state.batches,
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
      // Payment ids are zero-padded so plain string order of ids agrees with
      // creation order (statements break instant ties by id).
      id = prefix === 'payment'
        ? `${p}_${String(state.counters[prefix]).padStart(6, '0')}`
        : `${p}_${state.counters[prefix]}`;
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

// ---------------------------------------------------------------------------
// Stage 3: instants, the payment clock and the ledger
// ---------------------------------------------------------------------------

// Every instant the service compares is an integer count of nanoseconds since
// the Unix epoch held as a BigInt, so comparisons are exact however many
// fractional digits a client supplies. The strings shown to clients keep
// microsecond resolution.
//
// Instant objects keep their ns value in a NON-enumerable property so exports
// (which JSON-serialise state) never see a BigInt and imports re-derive it.
const NS_PER_MS = 1000000n;
const CLOCK_RES = 1000n; // output resolution: 1 microsecond

function hidden(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: false, configurable: true });
}

let clockBaseNs = BigInt(Date.now()) * NS_PER_MS;
let clockBaseHr = process.hrtime.bigint();

// Wall clock with sub-millisecond resolution: Date.now() anchors it, hrtime
// supplies the fraction; it re-anchors if the two ever disagree by >50ms.
function wallNs() {
  const hr = process.hrtime.bigint();
  let ns = clockBaseNs + (hr - clockBaseHr);
  const dateNs = BigInt(Date.now()) * NS_PER_MS;
  const drift = ns > dateNs ? ns - dateNs : dateNs - ns;
  if (drift > 50n * NS_PER_MS) {
    clockBaseNs = dateNs;
    clockBaseHr = hr;
    ns = dateNs;
  }
  return ns;
}

// "Now" without consuming a tick: never earlier than anything already issued.
function peekNs() {
  const w = (wallNs() / CLOCK_RES) * CLOCK_RES;
  return w > state.lastNs ? w : state.lastNs;
}

// A fresh, strictly increasing timestamp: every API-created record gets an
// instant later than the reset instant and than every earlier one.
function tickNs() {
  const w = (wallNs() / CLOCK_RES) * CLOCK_RES;
  const n = w > state.lastNs ? w : state.lastNs + CLOCK_RES;
  state.lastNs = n;
  return n;
}

function nsToIso(ns) {
  const ms = Number(ns / NS_PER_MS);
  const micro = Number((ns % NS_PER_MS) / 1000n);
  return `${new Date(ms).toISOString().slice(0, 23)}${String(micro).padStart(3, '0')}+00:00`;
}

function stampNow() {
  const ns = tickNs();
  return { ns, iso: nsToIso(ns) };
}

function nowIso() {
  return nsToIso(tickNs());
}

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

// RFC 3339 date-time with a REQUIRED offset (Z or +hh:mm); anything else
// (naive time, bare date, empty, garbage, impossible dates) is null.
function parseInstant(s) {
  if (typeof s !== 'string') return null;
  const m = INSTANT_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const H = Number(m[4]);
  const M = Number(m[5]);
  const S = Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || H > 23 || M > 59 || S > 59) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(H, M, S, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  let offsetMin = 0;
  if (m[8] !== 'Z' && m[8] !== 'z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const frac = m[7] ? BigInt(m[7].slice(0, 9).padEnd(9, '0')) : 0n;
  return (BigInt(dt.getTime()) - BigInt(offsetMin) * 60000n) * NS_PER_MS + frac;
}

// A temporal query parameter: null when absent, else { raw, ns }. A '+' in the
// offset that arrived unencoded was turned into a space by URL decoding; put
// it back so the value the client typed is what is parsed and echoed.
function temporalParam(query, name) {
  if (!query.has(name)) return null;
  let raw = query.get(name);
  if (!/[+Zz]/.test(raw)) {
    const m = /^(.+[Tt][\d:.]+) (\d{2}:\d{2})$/.exec(raw);
    if (m) raw = `${m[1]}+${m[2]}`;
  }
  const ns = parseInstant(raw);
  if (ns === null) throw err(422, 'validation_failed', `${name} must be an RFC 3339 instant with an offset`);
  return { raw, ns };
}

// ---- revisions and payments ------------------------------------------------

function makeRevision(revision, amount, effectiveAt, effNs, recordedAt, recNs, reason, correctionBatchId = null) {
  const r = { revision, amount, effectiveAt, recordedAt, reason, correctionBatchId };
  hidden(r, 'effNs', effNs);
  hidden(r, 'recNs', recNs);
  return r;
}

// A revision as clients see it. Only revisions made by a batch carry
// correction_batch_id; every other revision keeps exactly the Stage 3 shape.
function revisionView(p, r) {
  const view = {
    payment_id: p.id,
    revision: r.revision,
    amount: r.amount,
    effective_at: r.effectiveAt,
    recorded_at: r.recordedAt,
    reason: r.reason,
  };
  if (r.correctionBatchId) view.correction_batch_id = r.correctionBatchId;
  return view;
}

function paymentsOf(st, userId) {
  return st.userPayments.get(userId) || [];
}

function authsOf(st, userId) {
  return st.userAuths.get(userId) || [];
}

function indexPayment(st, p) {
  for (const uid of p.fromUserId === p.toUserId ? [p.fromUserId] : [p.fromUserId, p.toUserId]) {
    let list = st.userPayments.get(uid);
    if (!list) {
      list = [];
      st.userPayments.set(uid, list);
    }
    list.push(p);
  }
}

// Refunds are indexed under the payment they refund.
function indexRefund(st, p) {
  if (!p.refundOf) return;
  let list = st.refundsOf.get(p.refundOf);
  if (!list) {
    list = [];
    st.refundsOf.set(p.refundOf, list);
  }
  list.push(p);
}

// Total already refunded against a payment.
function refundedTotal(p) {
  let total = 0;
  for (const r of state.refundsOf.get(p.id) || []) total += r.amount;
  return total;
}

// Registers a payment with revision 1 (effective = recorded = created_at).
function registerPayment(st, p, createdNs) {
  hidden(p, 'createdNs', createdNs);
  if (p.refundOf === undefined) p.refundOf = null;
  p.revisions = [makeRevision(1, p.amount, p.createdAt, createdNs, p.createdAt, createdNs, '')];
  st.payments.set(p.id, p);
  indexPayment(st, p);
  indexRefund(st, p);
  st.ledgerVersion += 1;
}

function registerAuthorization(st, a, { createdNs, expiresNs, closedNs, baseCaptured }) {
  hidden(a, 'createdNs', createdNs);
  hidden(a, 'expiresNs', expiresNs);
  hidden(a, 'closedNs', closedNs);
  hidden(a, 'baseCaptured', baseCaptured);
  st.authorizations.set(a.id, a);
  let list = st.userAuths.get(a.fromUserId);
  if (!list) {
    list = [];
    st.userAuths.set(a.fromUserId, list);
  }
  list.push(a);
}

function deltaFor(p, amount, userId) {
  return (p.toUserId === userId ? amount : 0) - (p.fromUserId === userId ? amount : 0);
}

function latestRevision(p) {
  return p.revisions[p.revisions.length - 1];
}

// The latest revision recorded at or before kNs, or null when none was yet.
function selectRevision(p, kNs) {
  for (let i = p.revisions.length - 1; i >= 0; i--) {
    if (p.revisions[i].recNs <= kNs) return p.revisions[i];
  }
  return null;
}

// Balance of a wallet after every selected movement effective at or before
// tNs (null = no upper bound).
function totalAt(user, tNs, kNs) {
  let total = user.openingBalance;
  for (const p of paymentsOf(state, user.id)) {
    const rev = selectRevision(p, kNs);
    if (!rev) continue;
    if (tNs !== null && rev.effNs > tNs) continue;
    total += deltaFor(p, rev.amount, user.id);
  }
  return total;
}

// When a hold stops holding, as known at kNs: its close event if that was
// already known, else its deadline (known as soon as creation is known).
function holdEnd(a, kNs) {
  return a.closedNs !== null && a.closedNs <= kNs ? a.closedNs : a.expiresNs;
}

// Funds held for a payer at instant tNs, as known at kNs.
function heldAt(userId, tNs, kNs) {
  let held = 0;
  for (const a of authsOf(state, userId)) {
    if (a.createdNs > kNs || a.createdNs > tNs) continue;
    const end = holdEnd(a, kNs);
    if (end <= a.createdNs || tNs >= end) continue;
    let captured = a.baseCaptured;
    for (const pid of a.paymentIds) {
      const pay = state.payments.get(pid);
      if (pay && pay.createdNs <= tNs && pay.createdNs <= kNs) captured += pay.amount;
    }
    if (a.amount > captured) held += a.amount - captured;
  }
  return held;
}

// ---- statements --------------------------------------------------------------

// All of a user's selected movements in statement order: effective time, then
// payment id as plain strings.
function selectedMovements(userId, kNs) {
  const out = [];
  for (const p of paymentsOf(state, userId)) {
    const rev = selectRevision(p, kNs);
    if (!rev) continue;
    out.push({ p, rev, delta: deltaFor(p, rev.amount, userId) });
  }
  out.sort((a, b) => {
    if (a.rev.effNs !== b.rev.effNs) return a.rev.effNs < b.rev.effNs ? -1 : 1;
    return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0;
  });
  return out;
}

// The full result of a statement read: opening and closing balances and every
// entry of the window [fromNs, toNs) with its running balance. A window that
// is empty or inverted has no entries and opening == closing.
function computeStatement(user, fromNs, toNs, kNs) {
  const moves = selectedMovements(user.id, kNs);
  let running = user.openingBalance;
  let opening = null;
  const entries = [];
  const empty = fromNs !== null && fromNs >= toNs;
  for (const m of moves) {
    if (fromNs !== null && m.rev.effNs < fromNs) {
      running += m.delta;
      continue;
    }
    if (opening === null) opening = running;
    if (empty || m.rev.effNs >= toNs) break;
    running += m.delta;
    entries.push({ p: m.p, rev: m.rev, delta: m.delta, balanceAfter: running });
  }
  if (opening === null) opening = running;
  const closing = empty ? opening : running;
  return { opening, closing, entries };
}

function statementEntryView(e) {
  return {
    payment: { ...paymentView(e.p), amount: e.rev.amount },
    delta: e.delta,
    balance_after: e.balanceAfter,
    revision: e.rev.revision,
    effective_at: e.rev.effectiveAt,
    recorded_at: e.rev.recordedAt,
  };
}

// ---- corrections: the historical overdraft check ----------------------------

// Would applying (newAmount, newEffNs) to payment p leave either party with a
// negative TOTAL or negative AVAILABLE at any boundary up to now, under the
// latest known revisions? Movements and hold events at one instant are
// combined before the balance is judged.
function wouldOverdraft(p, newAmount, newEffNs) {
  return wouldOverdraftWith(new Map([[p, { amount: newAmount, effNs: newEffNs }]]));
}

// The same check for several tentative revisions applied together (a batch):
// `overrides` maps each payment to the amount and effective instant its new
// latest revision would have. Every party of every overridden payment is judged.
function wouldOverdraftWith(overrides) {
  const nowNs = peekNs();
  const affected = new Set();
  for (const p of overrides.keys()) {
    affected.add(p.fromUserId);
    affected.add(p.toUserId);
  }
  for (const uid of affected) {
    const user = state.users.get(uid);
    const ev = []; // [instant, change in total, change in held]
    for (const q of paymentsOf(state, uid)) {
      const o = overrides.get(q);
      if (o) {
        ev.push([o.effNs, deltaFor(q, o.amount, uid), 0]);
      } else {
        const rev = latestRevision(q);
        ev.push([rev.effNs, deltaFor(q, rev.amount, uid), 0]);
      }
    }
    for (const a of authsOf(state, uid)) {
      const end = a.closedNs !== null ? a.closedNs : a.expiresNs;
      if (end <= a.createdNs) continue; // never held
      ev.push([a.createdNs, 0, a.amount - a.baseCaptured]);
      let captured = a.baseCaptured;
      for (const pid of a.paymentIds) {
        const pay = state.payments.get(pid);
        if (pay && pay.createdNs >= a.createdNs && pay.createdNs <= end) {
          ev.push([pay.createdNs, 0, -pay.amount]);
          captured += pay.amount;
        }
      }
      ev.push([end, 0, -(a.amount - captured)]);
    }
    ev.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    let total = user.openingBalance;
    let held = 0;
    for (let i = 0; i < ev.length; ) {
      const t = ev[i][0];
      if (t > nowNs) break;
      while (i < ev.length && ev[i][0] === t) {
        total += ev[i][1];
        held += ev[i][2];
        i += 1;
      }
      if (total < 0 || total - held < 0) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage 2: authorization (hold) expiry
// ---------------------------------------------------------------------------

// Lazy, clock-true expiry: no timers are needed. Every read AND write calls
// this once, under the lock, using a single "now" for that request, so an
// authorization whose expires_at is at or before now is treated as expired
// consistently for the whole request — its remainder is released back into
// `available` and it can never be captured or voided again. Expiry takes
// effect at expires_at, so that is its closed_at.
function sweepExpiredAuthorizations(nowNs) {
  for (const a of state.authorizations.values()) {
    if (a.status === 'open' && a.expiresNs <= nowNs) {
      a.status = 'expired';
      a.closedAt = a.expiresAt;
      a.closedNs = a.expiresNs;
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
  for (const a of authsOf(state, userId)) {
    if (a.status === 'open') held += a.amount - a.capturedAmount;
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
    refund_of: p.refundOf || null,
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
    closed_at: a.closedAt === undefined ? null : a.closedAt,
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
  // Reset time: the instant seeded records without a created_at are given. The
  // payment clock continues strictly after it.
  const resetNs = (wallNs() / CLOCK_RES) * CLOCK_RES;
  const resetIso = nsToIso(resetNs);
  newState.resetNs = resetNs;
  newState.lastNs = resetNs;

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
      openingBalance: u.balance, // adjusted below by the seeded payments
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
    if (newState.payments.has(id)) throw err(422, 'validation_failed', 'duplicate seeded payment id');
    let createdAt = resetIso;
    let createdNs = resetNs;
    if (p.created_at !== undefined) {
      createdNs = parseInstant(p.created_at);
      if (createdNs === null) throw err(422, 'validation_failed', 'invalid seeded payment created_at');
      if (createdNs > resetNs) throw err(422, 'validation_failed', 'seeded payment created_at is in the future');
      createdAt = p.created_at;
    }
    registerPayment(newState, {
      id,
      fromUserId,
      toUserId,
      amount,
      note: typeof note === 'string' ? note : '',
      visibility: vis,
      requestId: null,
      settlementId: null,
      authorizationId: null,
      createdAt,
      seq: (newState.seq += 1),
    }, createdNs);
  }
  // Opening balance = the seeded balance minus the net effect of the original
  // seeded payments, so loading them leaves every fixture balance unchanged.
  for (const p of newState.payments.values()) {
    newState.users.get(p.fromUserId).openingBalance += p.amount;
    newState.users.get(p.toUserId).openingBalance -= p.amount;
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
      createdAt: resetIso,
      seq: (newState.seq += 1),
    });
  }

  for (const opId of operatorIds) {
    if (typeof opId !== 'string' || !newState.users.has(opId)) {
      throw err(422, 'validation_failed', 'unknown settlement operator id');
    }
    newState.settlementOperatorIds.add(opId);
  }

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
    const expiresNs = parseInstant(expiresAt);
    if (expiresNs === null) {
      throw err(422, 'validation_failed', 'invalid seeded authorization expires_at');
    }
    let authCreatedAt = resetIso;
    let authCreatedNs = resetNs;
    if (a.created_at !== undefined) {
      authCreatedNs = parseInstant(a.created_at);
      if (authCreatedNs === null) throw err(422, 'validation_failed', 'invalid seeded authorization created_at');
      if (authCreatedNs > resetNs) throw err(422, 'validation_failed', 'seeded authorization created_at is in the future');
      authCreatedAt = a.created_at;
    }
    if (newState.authorizations.has(id)) throw err(422, 'validation_failed', 'duplicate seeded authorization id');
    const captured = capturedAmount === undefined ? 0 : capturedAmount;
    if (!isIntegralNumber(captured) || captured < 0 || captured > amount) {
      throw err(422, 'validation_failed', 'invalid seeded authorization captured_amount');
    }
    const pids = paymentIds === undefined ? [] : paymentIds;
    if (!Array.isArray(pids) || pids.some((pid) => typeof pid !== 'string')) {
      throw err(422, 'validation_failed', 'invalid seeded authorization payment_ids');
    }
    // A past expiry always wins over a seeded "open" status.
    if (st === 'open' && expiresNs <= resetNs) {
      st = 'expired';
    }
    // Lifecycle: an open hold has not closed; one that expired by the clock
    // closed at its deadline; seeded closed holds do not reconstruct a prior
    // lifecycle, so they are treated as never held (closed at creation).
    let closedAt = null;
    let closedNs = null;
    if (st === 'expired' && expiresNs <= resetNs && status !== 'expired') {
      closedAt = expiresAt;
      closedNs = expiresNs;
    } else if (st !== 'open') {
      closedAt = authCreatedAt;
      closedNs = authCreatedNs;
    }
    let capturedByPayments = 0;
    for (const pid of pids) {
      const pay = newState.payments.get(pid);
      if (pay) capturedByPayments += pay.amount;
    }
    registerAuthorization(newState, {
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
      createdAt: authCreatedAt,
      closedAt,
      seq: (newState.seq += 1),
    }, {
      createdNs: authCreatedNs,
      expiresNs,
      closedNs,
      baseCaptured: Math.max(0, captured - capturedByPayments),
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

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

// Frozen statement snapshots travel with an export so a token issued before it
// still pages the same result after import. Identical results are written once
// and shared by their tokens; entries are compact [paymentId, revision, delta,
// balance_after] rows that import resolves back to the immutable records.
function serializeSnapshots() {
  const resultIndex = new Map();
  const snapshotResults = [];
  const snapshotTokens = [];
  for (const [token, snap] of state.snapshots) {
    let idx = resultIndex.get(snap);
    if (idx === undefined) {
      idx = snapshotResults.length;
      resultIndex.set(snap, idx);
      snapshotResults.push({
        userId: snap.userId,
        opening: snap.opening,
        closing: snap.closing,
        entries: snap.entries.map((e) => [e.p.id, e.rev.revision, e.delta, e.balanceAfter]),
      });
    }
    snapshotTokens.push({ token, result: idx });
  }
  return { snapshotResults, snapshotTokens };
}

function serializeState() {
  return {
    ...serializeSnapshots(),
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
  const paymentById = new Map();
  const batchRecorded = new Map();
  for (const p of s.payments) {
    if (!isPlainObject(p)) throw err(422, 'validation_failed', 'invalid payment record');
    const { id, fromUserId, toUserId, amount, note, visibility, requestId, settlementId, authorizationId, createdAt } = p;
    if (typeof id !== 'string' || !id) throw err(422, 'validation_failed', 'invalid payment id');
    if (paymentIds.has(id)) throw err(422, 'validation_failed', 'duplicate payment id');
    paymentIds.add(id);
    paymentById.set(id, p);
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
    const createdNs = parseInstant(createdAt);
    if (createdNs === null) throw err(422, 'validation_failed', 'invalid payment created_at');
    hidden(p, 'createdNs', createdNs);
    // Stage 4: refund_of (absent in a Stage 1-3 export = not a refund).
    if (p.refundOf === undefined) p.refundOf = null;
    if (p.refundOf !== null && (typeof p.refundOf !== 'string' || p.refundOf.length === 0)) {
      throw err(422, 'validation_failed', 'invalid payment refund_of');
    }
    // Revision history. A Stage 1/2 export has none: revision 1 is the payment
    // as it was paid, effective and recorded at created_at.
    if (p.revisions === undefined) {
      p.revisions = [makeRevision(1, amount, createdAt, createdNs, createdAt, createdNs, '')];
    } else {
      if (!Array.isArray(p.revisions) || p.revisions.length < 1) {
        throw err(422, 'validation_failed', 'invalid payment revisions');
      }
      let prevRecorded = null;
      p.revisions = p.revisions.map((r, i) => {
        if (!isPlainObject(r) || r.revision !== i + 1) throw err(422, 'validation_failed', 'invalid revision numbering');
        if (!isIntegralNumber(r.amount) || r.amount < 0 || r.amount > Number.MAX_SAFE_INTEGER) {
          throw err(422, 'validation_failed', 'invalid revision amount');
        }
        if (typeof r.reason !== 'string') throw err(422, 'validation_failed', 'invalid revision reason');
        const batchId = r.correctionBatchId === undefined ? null : r.correctionBatchId;
        if (batchId !== null && (typeof batchId !== 'string' || batchId.length === 0)) {
          throw err(422, 'validation_failed', 'invalid revision correction_batch_id');
        }
        const effNs = parseInstant(r.effectiveAt);
        const recNs = parseInstant(r.recordedAt);
        if (effNs === null || recNs === null) throw err(422, 'validation_failed', 'invalid revision instant');
        if (prevRecorded !== null && recNs <= prevRecorded) {
          throw err(422, 'validation_failed', 'revision recorded_at must strictly increase');
        }
        prevRecorded = recNs;
        // Revision 1 IS the payment as originally paid: the payment record is
        // authoritative for its amount and times (import has never cross-checked
        // those fields), so a stored revision 1 is normalised to it.
        if (i === 0) return makeRevision(1, amount, createdAt, createdNs, createdAt, createdNs, '');
        if (batchId !== null) {
          if (batchRecorded.has(batchId) && batchRecorded.get(batchId) !== recNs) {
            throw err(422, 'validation_failed', 'revisions of one batch must share recorded_at');
          }
          batchRecorded.set(batchId, recNs);
        }
        return makeRevision(r.revision, r.amount, r.effectiveAt, effNs, r.recordedAt, recNs, r.reason, batchId);
      });
    }
  }

  // Refunds must be consistent with the payments they refund.
  const refundTotals = new Map();
  for (const p of s.payments) {
    if (p.refundOf === null) continue;
    const target = paymentById.get(p.refundOf);
    if (!target) throw err(422, 'validation_failed', 'refund references an unknown payment');
    if (target.refundOf !== null) throw err(422, 'validation_failed', 'a refund cannot refund a refund');
    if (p.fromUserId !== target.toUserId || p.toUserId !== target.fromUserId) {
      throw err(422, 'validation_failed', 'a refund must reverse the payment it refunds');
    }
    if (p.requestId !== null || p.settlementId !== null || (p.authorizationId !== undefined && p.authorizationId !== null)) {
      throw err(422, 'validation_failed', 'a refund carries no request, settlement or authorization link');
    }
    refundTotals.set(target.id, (refundTotals.get(target.id) || 0) + p.amount);
  }
  for (const [tid, total] of refundTotals) {
    const t = paymentById.get(tid);
    if (total > t.revisions[t.revisions.length - 1].amount) {
      throw err(422, 'validation_failed', 'refunds exceed the corrected payment amount');
    }
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
    const expiresNs = parseInstant(expiresAt);
    if (expiresNs === null) throw err(422, 'validation_failed', 'invalid authorization expires_at');
    const createdNs = parseInstant(a.createdAt);
    if (createdNs === null) throw err(422, 'validation_failed', 'invalid authorization created_at');
    if (!Array.isArray(pids) || pids.some((pid) => typeof pid !== 'string' || !paymentIds.has(pid))) {
      throw err(422, 'validation_failed', 'authorization references unknown payment');
    }
    // Lifecycle. A Stage 2 export has no closed_at: a closed hold closed at
    // its deadline if it expired, otherwise at its last capture (or at
    // creation when it never had one) -- the last known event time.
    let closedAt = null;
    let closedNs = null;
    if (a.closedAt !== undefined && a.closedAt !== null) {
      closedNs = parseInstant(a.closedAt);
      if (closedNs === null) throw err(422, 'validation_failed', 'invalid authorization closed_at');
      closedAt = a.closedAt;
    } else if (status !== 'open') {
      if (status === 'expired') {
        closedAt = expiresAt;
        closedNs = expiresNs;
      } else {
        closedAt = a.createdAt;
        closedNs = createdNs;
        for (const pid of pids) {
          const pay = paymentById.get(pid);
          if (pay && pay.createdNs > closedNs) {
            closedAt = pay.createdAt;
            closedNs = pay.createdNs;
          }
        }
      }
    }
    if (status === 'open') {
      closedAt = null;
      closedNs = null;
    }
    let capturedByPayments = 0;
    for (const pid of pids) capturedByPayments += paymentById.get(pid).amount;
    a.closedAt = closedAt;
    hidden(a, 'createdNs', createdNs);
    hidden(a, 'expiresNs', expiresNs);
    hidden(a, 'closedNs', closedNs);
    hidden(a, 'baseCaptured', Math.max(0, capturedAmount - capturedByPayments));
  }
  // Mirror reset: a wallet's unexpired open holds may never exceed its total.
  {
    const importNow = (wallNs() / CLOCK_RES) * CLOCK_RES;
    const balanceById = new Map(s.users.map((u) => [u.id, u.balance]));
    const heldById = new Map();
    for (const a of authorizations) {
      if (a.status !== 'open' || a.expiresNs <= importNow) continue;
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

  // Statement snapshots (absent in a Stage 1-3 export).
  const snapshotResults = s.snapshotResults === undefined ? [] : s.snapshotResults;
  const snapshotTokens = s.snapshotTokens === undefined ? [] : s.snapshotTokens;
  if (!Array.isArray(snapshotResults) || !Array.isArray(snapshotTokens)) {
    throw err(422, 'validation_failed', 'invalid snapshots');
  }
  for (const r of snapshotResults) {
    if (!isPlainObject(r) || !userIds.has(r.userId) || !isIntegralNumber(r.opening) || !isIntegralNumber(r.closing) || !Array.isArray(r.entries)) {
      throw err(422, 'validation_failed', 'invalid snapshot result');
    }
    for (const e of r.entries) {
      if (!Array.isArray(e) || e.length !== 4) throw err(422, 'validation_failed', 'invalid snapshot entry');
      const pay = typeof e[0] === 'string' ? paymentById.get(e[0]) : undefined;
      if (!pay || !isIntegralNumber(e[1]) || e[1] < 1 || e[1] > pay.revisions.length || !isIntegralNumber(e[2]) || !isIntegralNumber(e[3])) {
        throw err(422, 'validation_failed', 'invalid snapshot entry');
      }
    }
  }
  const seenTokens = new Set();
  for (const t of snapshotTokens) {
    if (!isPlainObject(t) || typeof t.token !== 'string' || t.token.length === 0 || t.token.length > 255
      || !isIntegralNumber(t.result) || t.result < 0 || t.result >= snapshotResults.length || seenTokens.has(t.token)) {
      throw err(422, 'validation_failed', 'invalid snapshot token');
    }
    seenTokens.add(t.token);
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
  let maxNs = (wallNs() / CLOCK_RES) * CLOCK_RES;
  for (const p of s.payments) {
    newState.payments.set(p.id, p);
    indexPayment(newState, p);
    indexRefund(newState, p);
    for (const r of p.revisions) {
      if (r.recNs > maxNs) maxNs = r.recNs;
      if (r.correctionBatchId) newState.batches.set(r.correctionBatchId, { id: r.correctionBatchId, recordedAt: r.recordedAt });
    }
    if (p.createdNs > maxNs) maxNs = p.createdNs;
  }
  for (const r of s.requests) newState.requests.set(r.id, r);
  for (const sp of s.splits) newState.splits.set(sp.id, sp);
  for (const st of s.settlements) newState.settlements.set(st.id, st);
  for (const a of s.authorizations || []) {
    newState.authorizations.set(a.id, a);
    let list = newState.userAuths.get(a.fromUserId);
    if (!list) {
      list = [];
      newState.userAuths.set(a.fromUserId, list);
    }
    list.push(a);
    if (a.createdNs > maxNs) maxNs = a.createdNs;
    if (a.closedNs !== null && a.closedNs > maxNs) maxNs = a.closedNs;
  }
  // Opening balance = balance minus the net effect of every payment's latest
  // revision. For an export that already carries corrections this is exactly
  // the opening it was taken with; for a Stage 1/2 export it is derived.
  for (const u of newState.users.values()) u.openingBalance = u.balance;
  for (const p of newState.payments.values()) {
    const amount = latestRevision(p).amount;
    newState.users.get(p.fromUserId).openingBalance += amount;
    newState.users.get(p.toUserId).openingBalance -= amount;
  }
  newState.lastNs = maxNs;
  newState.resetNs = 0n;
  newState.authorizationTtlSeconds =
    s.authorizationTtlSeconds === undefined ? 600 : s.authorizationTtlSeconds;
  for (const opId of s.settlementOperatorIds) newState.settlementOperatorIds.add(opId);
  for (const entry of s.idempotency) {
    const m = new Map();
    for (const { key, rec } of entry.records) m.set(key, rec);
    newState.idempotency.set(entry.userId, m);
  }
  newState.counters = { ...s.counters };
  seedCounterFromIds(newState, 'user', [...newState.users.keys()]);
  seedCounterFromIds(newState, 'payment', [...newState.payments.keys()]);
  seedCounterFromIds(newState, 'request', [...newState.requests.keys()]);
  seedCounterFromIds(newState, 'split', [...newState.splits.keys()]);
  seedCounterFromIds(newState, 'settlement', [...newState.settlements.keys()]);
  seedCounterFromIds(newState, 'authorization', [...newState.authorizations.keys()]);
  seedCounterFromIds(newState, 'batch', [...newState.batches.keys()]);
  // Restore the frozen statement snapshots, replacing any in the destination.
  const restored = (s.snapshotResults || []).map((r) => ({
    userId: r.userId,
    opening: r.opening,
    closing: r.closing,
    entries: r.entries.map(([pid, revision, delta, balanceAfter]) => {
      const p = newState.payments.get(pid);
      return { p, rev: p.revisions[revision - 1], delta, balanceAfter };
    }),
  }));
  for (const t of s.snapshotTokens || []) newState.snapshots.set(t.token, restored[t.result]);
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
  const user = { id, email, passwordHash, displayName, handle, balance: 0, openingBalance: 0 };
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
  sweepExpiredAuthorizations(peekNs());
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
  const stamp = stampNow();
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
    createdAt: stamp.iso,
    seq: nextSeq(),
  };
  registerPayment(state, payment, stamp.ns);
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
  const stamp = stampNow();
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
    createdAt: stamp.iso,
    seq: nextSeq(),
  };
  registerPayment(state, payment, stamp.ns);
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
  items.sort((a, b) => (b.createdNs !== a.createdNs ? (b.createdNs < a.createdNs ? -1 : 1) : b.seq - a.seq));
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
  const committed = stampNow();
  const committedAt = committed.iso;
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
    registerPayment(state, payment, committed.ns);
    payments.push(paymentView(payment));
  }
  const settlement = { id, committedAt, paymentIds: payments.map((p) => p.payment_id) };
  state.settlements.set(id, settlement);

  return { status: 201, body: { settlement_id: id, committed_at: committedAt, payments } };
}


// ---------------------------------------------------------------------------
// Stage 3: GET /me as of an instant, statements, corrections
// ---------------------------------------------------------------------------

// GET /me. Without temporal parameters this is exactly Stage 2's response.
// With as_of and/or known_at all four money fields describe one view: the
// movements known at known_at (default: everything known now), applied at
// their effective times up to and including as_of (default: now), and the
// holds as they stood at that instant.
function doMe(user, query) {
  const asOf = temporalParam(query, 'as_of');
  const knownAt = temporalParam(query, 'known_at');
  if (!asOf && !knownAt) return userMe(user);
  const nowNs = peekNs();
  const kNs = knownAt ? knownAt.ns : nowNs;
  const total = totalAt(user, asOf ? asOf.ns : null, kNs);
  const held = heldAt(user.id, asOf ? asOf.ns : nowNs, kNs);
  const body = {
    user_id: user.id,
    display_name: user.displayName,
    handle: user.handle,
    balance: total,
    total,
    available: total - held,
    held,
    currency: state.currency,
    minor_units: state.minorUnits,
  };
  if (asOf) body.as_of = asOf.raw;
  if (knownAt) body.known_at = knownAt.raw;
  return body;
}

function statementPage(token, snap, limit, offset) {
  const page = snap.entries.slice(offset, offset + limit).map(statementEntryView);
  return {
    status: 200,
    body: {
      opening_balance: snap.opening,
      entries: page,
      closing_balance: snap.closing,
      has_more: offset + limit < snap.entries.length,
      snapshot: token,
    },
  };
}

// GET /statement. The first read computes the whole window once and freezes
// it under an opaque snapshot token; paging that token never recomputes.
function doStatement(user, query) {
  if (query.has('snapshot')) {
    for (const k of ['from', 'to', 'known_at']) {
      if (query.has(k)) throw err(422, 'validation_failed', `${k} cannot accompany a snapshot`);
    }
    const { limit, offset } = parseLimitOffset(query);
    const token = query.get('snapshot');
    const snap = state.snapshots.get(token);
    if (!snap || snap.userId !== user.id) throw err(404, 'not_found', 'unknown snapshot');
    return statementPage(token, snap, limit, offset);
  }
  const from = temporalParam(query, 'from');
  const to = temporalParam(query, 'to');
  const knownAt = temporalParam(query, 'known_at');
  const { limit, offset } = parseLimitOffset(query);
  const nowNs = peekNs();
  const kNs = knownAt ? knownAt.ns : nowNs;
  // Default `to` is now, frozen at this read; nothing is effective after now,
  // so +1ns makes the window cover everything up to and including this instant.
  const toNs = to ? to.ns : nowNs + 1n;
  const fromNs = from ? from.ns : null;

  // Identical reads of an unchanged ledger share one frozen result, which keeps
  // the memory held by snapshots proportional to distinct results.
  if (state.statementCacheVersion !== state.ledgerVersion) {
    state.statementCache = new Map();
    state.statementCacheVersion = state.ledgerVersion;
  }
  const cacheKey = `${user.id}|${fromNs === null ? '-' : fromNs}|${to ? toNs : 'now'}|${knownAt ? kNs : 'now'}`;
  let snap = state.statementCache.get(cacheKey);
  if (!snap) {
    snap = { userId: user.id, ...computeStatement(user, fromNs, toNs, kNs) };
    state.statementCache.set(cacheKey, snap);
  }
  const token = `snap_${crypto.randomBytes(18).toString('base64url')}`;
  state.snapshots.set(token, snap);
  return statementPage(token, snap, limit, offset);
}

function doCorrection(user, paymentId, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const p = state.payments.get(paymentId);
  if (!p) throw err(404, 'not_found', 'no such payment');
  if (p.fromUserId !== user.id) throw err(403, 'forbidden', 'only the sender may correct a payment');
  if (p.settlementId !== null || p.authorizationId || p.refundOf) {
    throw err(422, 'linked_payment_immutable', 'settlement members, captures and refunds cannot be corrected');
  }

  const { expected_revision: expectedRevision, amount, effective_at: effectiveAt, reason } = body;
  if (!isIntegralNumber(expectedRevision) || expectedRevision < 1) {
    throw err(422, 'validation_failed', 'expected_revision must be a positive integer');
  }
  if (!isIntegralNumber(amount) || amount < 0 || amount > 1000000000) {
    throw err(422, 'validation_failed', 'amount must be an integer from 0 to 1000000000');
  }
  if (typeof reason !== 'string' || [...reason].length < 1 || [...reason].length > 200) {
    throw err(422, 'validation_failed', 'reason must be 1..200 characters');
  }
  const effNs = parseInstant(effectiveAt);
  if (effNs === null) throw err(422, 'validation_failed', 'effective_at must be an RFC 3339 instant with an offset');
  if (effNs > peekNs()) throw err(422, 'validation_failed', 'effective_at cannot be in the future');

  const latest = latestRevision(p);
  if (expectedRevision !== latest.revision) throw err(409, 'stale_revision', 'the payment has a newer revision');
  if (amount < refundedTotal(p)) throw err(422, 'refund_exceeds_payment', 'cannot correct below the amount already refunded');

  // The difference moves between the same two wallets: an increase debits the
  // sender, a decrease debits the receiver. A current shortfall wins over a
  // historical one.
  const delta = amount - latest.amount;
  const sender = state.users.get(p.fromUserId);
  const receiver = state.users.get(p.toUserId);
  if (delta > 0 && availableBalance(sender) < delta) throw err(409, 'insufficient_funds', 'sender cannot afford the increase');
  if (delta < 0 && availableBalance(receiver) < -delta) throw err(409, 'insufficient_funds', 'receiver cannot afford the decrease');
  if (wouldOverdraft(p, amount, effNs)) throw err(409, 'historical_overdraft', 'the correction would overdraw a wallet in the past');

  let recNs = tickNs();
  if (recNs <= latest.recNs) {
    recNs = latest.recNs + CLOCK_RES;
    if (recNs > state.lastNs) state.lastNs = recNs;
  }
  const revision = makeRevision(latest.revision + 1, amount, effectiveAt, effNs, nsToIso(recNs), recNs, reason);
  p.revisions.push(revision);
  sender.balance -= delta;
  receiver.balance += delta;
  state.ledgerVersion += 1;
  return { status: 201, body: revisionView(p, revision) };
}

function doListRevisions(user, paymentId) {
  const p = state.payments.get(paymentId);
  // A third party learns nothing about the payment, public or not.
  if (!p || (p.fromUserId !== user.id && p.toUserId !== user.id)) throw err(404, 'not_found', 'no such payment');
  return { status: 200, body: { revisions: p.revisions.map((r) => revisionView(p, r)) } };
}


// ---------------------------------------------------------------------------
// Stage 4: refunds and batch corrections
// ---------------------------------------------------------------------------

// POST /payments/{id}/refunds: the original receiver sends part (or all) of a
// payment back as a NEW payment in the opposite direction. The refund never
// touches the original, its request, its authorization or any settlement.
function doRefund(user, paymentId, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  const target = state.payments.get(paymentId);
  if (!target) throw err(404, 'not_found', 'no such payment');
  if (target.toUserId !== user.id) throw err(403, 'forbidden', 'only the receiver may refund a payment');
  if (target.refundOf) throw err(422, 'invalid_refund_target', 'a refund cannot be refunded');
  const amt = validateAmount(body.amount);
  // Cumulative refunds may not exceed what the payment is currently worth.
  if (refundedTotal(target) + amt > latestRevision(target).amount) {
    throw err(422, 'refund_exceeds_payment', 'refunds would exceed the payment amount');
  }
  // Money comes from the refunder's available funds; held funds do not count.
  if (user.balance - heldAmount(user.id) < amt) throw err(409, 'insufficient_funds', 'balance too low');

  const sender = state.users.get(target.fromUserId);
  user.balance -= amt;
  sender.balance += amt;
  const id = nextId('payment');
  const stamp = stampNow();
  const payment = {
    id,
    fromUserId: user.id,
    toUserId: target.fromUserId,
    amount: amt,
    note: target.note,
    visibility: target.visibility,
    requestId: null,
    settlementId: null,
    authorizationId: null,
    refundOf: target.id,
    createdAt: stamp.iso,
    seq: nextSeq(),
  };
  registerPayment(state, payment, stamp.ns);
  return { status: 201, body: paymentView(payment) };
}

// POST /correction-batches: a settlement operator corrects up to 32 payments
// atomically. Errors are judged in the specified order: batch shape, items in
// input order, settlement completeness, current affordability of the combined
// effect, then the historical boundaries.
function doCorrectionBatch(user, body) {
  if (!isPlainObject(body)) throw err(400, 'malformed_request', 'body must be an object');
  if (!state.settlementOperatorIds.has(user.id)) throw err(403, 'forbidden', 'not an operator');
  const { corrections } = body;
  if (!Array.isArray(corrections) || corrections.length < 1 || corrections.length > 32) {
    throw err(422, 'validation_failed', 'corrections must have 1..32 entries');
  }
  const seen = new Set();
  for (const c of corrections) {
    if (!isPlainObject(c)) throw err(422, 'validation_failed', 'invalid correction shape');
    if (typeof c.payment_id === 'string') {
      if (seen.has(c.payment_id)) throw err(422, 'validation_failed', 'payment_ids must be distinct');
      seen.add(c.payment_id);
    }
  }

  // Item errors, in input order; the first failing item wins.
  const nowNs = peekNs();
  const items = [];
  for (const c of corrections) {
    const { payment_id: paymentId, expected_revision: expectedRevision, amount, effective_at: effectiveAt, reason } = c;
    if (typeof paymentId !== 'string' || paymentId.length === 0) throw err(422, 'validation_failed', 'payment_id must be a string');
    if (!isIntegralNumber(expectedRevision) || expectedRevision < 1) {
      throw err(422, 'validation_failed', 'expected_revision must be a positive integer');
    }
    if (!isIntegralNumber(amount) || amount < 0 || amount > 1000000000) {
      throw err(422, 'validation_failed', 'amount must be an integer from 0 to 1000000000');
    }
    if (typeof reason !== 'string' || [...reason].length < 1 || [...reason].length > 200) {
      throw err(422, 'validation_failed', 'reason must be 1..200 characters');
    }
    const effNs = parseInstant(effectiveAt);
    if (effNs === null) throw err(422, 'validation_failed', 'effective_at must be an RFC 3339 instant with an offset');
    if (effNs > nowNs) throw err(422, 'validation_failed', 'effective_at cannot be in the future');
    const p = state.payments.get(paymentId);
    if (!p) throw err(404, 'not_found', 'no such payment');
    if (p.authorizationId || p.refundOf) {
      throw err(422, 'linked_payment_immutable', 'captures and refunds cannot be corrected');
    }
    const latest = latestRevision(p);
    if (expectedRevision !== latest.revision) throw err(409, 'stale_revision', 'the payment has a newer revision');
    if (amount < refundedTotal(p)) throw err(422, 'refund_exceeds_payment', 'cannot correct below the amount already refunded');
    items.push({ p, latest, amount, effNs, effectiveAt, reason });
  }

  // Settlement completeness: every member, or none; and one instant for all.
  const bySettlement = new Map();
  for (const it of items) {
    if (!it.p.settlementId) continue;
    if (!bySettlement.has(it.p.settlementId)) bySettlement.set(it.p.settlementId, []);
    bySettlement.get(it.p.settlementId).push(it);
  }
  const included = new Set(items.map((it) => it.p.id));
  for (const [sid, its] of bySettlement) {
    const settlement = state.settlements.get(sid);
    const members = settlement ? settlement.paymentIds : its.map((it) => it.p.id);
    for (const pid of members) {
      if (!included.has(pid)) throw err(422, 'incomplete_settlement', 'every member of a settlement must be corrected together');
    }
  }
  for (const its of bySettlement.values()) {
    for (const it of its) {
      if (it.effNs !== its[0].effNs) throw err(422, 'validation_failed', 'settlement members need identical effective instants');
    }
  }

  // Current affordability is judged on the COMBINED effect of all items.
  const change = new Map();
  for (const it of items) {
    const delta = it.amount - it.latest.amount;
    change.set(it.p.fromUserId, (change.get(it.p.fromUserId) || 0) - delta);
    change.set(it.p.toUserId, (change.get(it.p.toUserId) || 0) + delta);
  }
  for (const [uid, ch] of change) {
    if (state.users.get(uid).balance + ch - heldAmount(uid) < 0) {
      throw err(409, 'insufficient_funds', 'the batch is not affordable');
    }
  }

  // Historical boundaries under all the tentative revisions together.
  const overrides = new Map();
  for (const it of items) overrides.set(it.p, { amount: it.amount, effNs: it.effNs });
  if (wouldOverdraftWith(overrides)) throw err(409, 'historical_overdraft', 'the batch would overdraw a wallet in the past');

  // Commit: one recorded instant, later than every member's previous one.
  let recNs = tickNs();
  let maxPrev = 0n;
  for (const it of items) if (it.latest.recNs > maxPrev) maxPrev = it.latest.recNs;
  if (recNs <= maxPrev) recNs = maxPrev + CLOCK_RES;
  if (recNs > state.lastNs) state.lastNs = recNs;
  const recordedAt = nsToIso(recNs);
  const batchId = nextId('batch');
  state.batches.set(batchId, { id: batchId, recordedAt });
  const revisions = items.map((it) => {
    const rev = makeRevision(it.latest.revision + 1, it.amount, it.effectiveAt, it.effNs, recordedAt, recNs, it.reason, batchId);
    it.p.revisions.push(rev);
    const delta = it.amount - it.latest.amount;
    state.users.get(it.p.fromUserId).balance -= delta;
    state.users.get(it.p.toUserId).balance += delta;
    return revisionView(it.p, rev);
  });
  state.ledgerVersion += 1;
  return { status: 201, body: { correction_batch_id: batchId, recorded_at: recordedAt, revisions } };
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
  // One clock read: expires_at is exactly created_at + ttl.
  const created = stampNow();
  const expiresNs = created.ns + BigInt(state.authorizationTtlSeconds) * 1000000000n;
  const authorization = {
    id,
    fromUserId: user.id,
    toUserId,
    amount: amt,
    capturedAmount: 0,
    note: n,
    visibility: vis,
    status: 'open',
    expiresAt: nsToIso(expiresNs),
    paymentIds: [],
    createdAt: created.iso,
    closedAt: null,
    seq: nextSeq(),
  };
  registerAuthorization(state, authorization, { createdNs: created.ns, expiresNs, closedNs: null, baseCaptured: 0 });
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

  const stamp = stampNow();
  const newRemaining = authorization.amount - authorization.capturedAmount;
  if (final || newRemaining === 0) {
    authorization.status = 'captured';
    authorization.closedAt = stamp.iso;
    authorization.closedNs = stamp.ns;
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
    createdAt: stamp.iso,
    seq: nextSeq(),
  };
  registerPayment(state, payment, stamp.ns);
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
  const stamp = stampNow();
  authorization.status = 'voided';
  authorization.closedAt = stamp.iso;
  authorization.closedNs = stamp.ns;
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
  items.sort((a, b) => (b.createdNs !== a.createdNs ? (b.createdNs < a.createdNs ? -1 : 1) : b.seq - a.seq));
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
  sweepExpiredAuthorizations(peekNs());

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
    return json(res, 200, doMe(user, url.searchParams));
  }

  if (method === 'GET' && pathname === '/statement') {
    const user = authenticate(req);
    const result = doStatement(user, url.searchParams);
    return json(res, result.status, result.body);
  }

  const revisionsMatch = /^\/payments\/([^/]+)\/revisions$/.exec(pathname);
  if (method === 'GET' && revisionsMatch) {
    const user = authenticate(req);
    const result = doListRevisions(user, revisionsMatch[1]);
    return json(res, result.status, result.body);
  }

  const refundMatch = /^\/payments\/([^/]+)\/refunds$/.exec(pathname);
  if (method === 'POST' && refundMatch) {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doRefund(user, refundMatch[1], body));
    return json(res, result.status, result.body);
  }

  if (method === 'POST' && pathname === '/correction-batches') {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () => doCorrectionBatch(user, body));
    return json(res, result.status, result.body);
  }

  const correctionMatch = /^\/payments\/([^/]+)\/corrections$/.exec(pathname);
  if (method === 'POST' && correctionMatch) {
    authenticate(req);
    const body = await parseJsonBody(req);
    const user = authenticate(req);
    const result = withIdempotency(user, method, pathname, req, body, () =>
      doCorrection(user, correctionMatch[1], body)
    );
    return json(res, result.status, result.body);
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
  console.log(`pocketful stage-4 listening on 0.0.0.0:${PORT}`);
});

module.exports = { server, applyFixture };
