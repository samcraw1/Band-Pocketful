'use strict';
/*
 * Stage 3 tests: payment instants, GET /me as of an instant, statements and
 * their snapshots, payment corrections (effective vs recorded time),
 * historical holds, historical overdraft, upgrade from real Stage 1 / Stage 2
 * exports, and concurrency. Run against a live instance:
 *
 *   BASE_URL=http://localhost:8080 node tests/stage3.js
 *
 * The upgrade tests start the repository's own stage-1/ and stage-2/ services
 * on free ports to take genuine exports from them (skipped if the folders are
 * not next to stage-3/).
 */
const assert = require('assert');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`FAIL - ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

async function http(base, method, p, { token, body, rawBody, key, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  if (key !== undefined) h['Idempotency-Key'] = key;
  const res = await fetch(`${base}${p}`, {
    method,
    headers: h,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}
const req = (m, p, o) => http(BASE_URL, m, p, o);

let kc = 0;
const K = () => `s3k_${Date.now()}_${++kc}_${Math.random().toString(36).slice(2)}`;
const U = (handle, balance) => ({
  id: `u_${handle}`,
  email: `${handle}@example.com`,
  password: 'correct horse',
  display_name: handle[0].toUpperCase() + handle.slice(1),
  handle,
  balance,
});
const FX = (o = {}) => ({
  currency: 'EUR',
  minor_units: 2,
  users: [U('ada', 10000), U('bob', 2500), U('cy', 500)],
  payments: [],
  requests: [],
  ...o,
});
const T1 = '2026-01-01T10:00:00+00:00';
const T2 = '2026-01-01T11:00:00+00:00';
const T3 = '2026-01-01T12:00:00+00:00';
const T0 = '2026-01-01T09:00:00+00:00';
const SP = (id, from, to, amount, created_at, extra = {}) => ({
  id, from_user_id: `u_${from}`, to_user_id: `u_${to}`, amount, note: id, visibility: 'public', ...(created_at ? { created_at } : {}), ...extra,
});
const inFuture = (s) => new Date(Date.now() + s * 1000).toISOString().replace('Z', '+00:00');

async function reset(fx) {
  const r = await req('POST', '/_test/reset', { body: fx });
  assert.strictEqual(r.status, 204, `reset: ${r.status} ${r.text}`);
}
async function login(h, base = BASE_URL) {
  const r = await http(base, 'POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' } });
  assert.strictEqual(r.status, 200, `login ${h}: ${r.text}`);
  return r.json.token;
}
async function world(fx = FX()) {
  await reset(fx);
  const w = { fx, total: fx.users.reduce((s, u) => s + u.balance, 0) };
  for (const u of fx.users) w[u.handle] = await login(u.handle);
  return w;
}
const me = async (tok, q = '') => (await req('GET', `/me${q}`, { token: tok })).json;
const stmt = async (tok, q = '') => {
  const r = await req('GET', `/statement${q}`, { token: tok });
  assert.strictEqual(r.status, 200, r.text);
  return r.json;
};
const err = (r, status, code) => {
  assert.strictEqual(r.status, status, `status ${r.status} ${r.text}`);
  assert.ok(r.json && r.json.error && r.json.error.code === code, `code ${r.text}`);
};
const pay = (tok, to, amount, extra = {}, key = K()) => req('POST', '/payments', { token: tok, key, body: { to_handle: to, amount, ...extra } });
const correct = (tok, id, body, key = K()) => req('POST', `/payments/${id}/corrections`, { token: tok, key, body });
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (w) => {
  const out = {};
  for (const u of w.fx.users) out[u.handle] = (await me(w[u.handle])).balance;
  return out;
};
async function sumAt(w, q) {
  let s = 0;
  for (const u of w.fx.users) {
    const m = await req('GET', `/me${q}`, { token: w[u.handle] });
    assert.strictEqual(m.status, 200, m.text);
    assert.strictEqual(m.json.balance, m.json.total);
    assert.strictEqual(m.json.available, m.json.total - m.json.held);
    s += m.json.balance;
  }
  return s;
}

// A small world with a known history (instants in the past):
//   T1  ada -> bob 1000        T2  bob -> ada 300   and   ada -> cy 200 (tie, ids pb < pc)
const HISTORY = () =>
  FX({
    payments: [
      SP('pa', 'ada', 'bob', 1000, T1),
      SP('pb', 'bob', 'ada', 300, T2),
      SP('pc', 'ada', 'cy', 200, T2),
    ],
  });
// ada ends 10000, so opens at 10000 + 1000 - 300 + 200 = 10900; bob 2500 - 1000 + 300 = 1800; cy 500 - 200 = 300

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
async function startService(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, 'src', 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { base, stop: () => child.kill() };
    } catch (e) {
      /* not up yet */
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`service in ${dir} did not start`);
}

async function main() {
  // ---------------------------------------------------------------- timestamps
  await test('payments carry an RFC 3339 instant, strictly increasing; generated ids sort in creation order', async () => {
    const w = await world();
    const seen = [];
    for (let i = 0; i < 25; i++) seen.push((await pay(w.ada, 'bob', 1)).json);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].created_at > seen[i - 1].created_at, `${seen[i - 1].created_at} !< ${seen[i].created_at}`);
      assert.ok(seen[i].payment_id > seen[i - 1].payment_id, 'ids sort in creation order');
    }
    assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/.test(seen[0].created_at), seen[0].created_at);
    const feed = (await req('GET', '/activity', { token: w.ada })).json.payments;
    assert.strictEqual(feed[0].payment_id, seen[seen.length - 1].payment_id);
  });

  await test('seeded created_at: balance unchanged, future -> 422 with no state change, omitted -> reset time before API payments', async () => {
    const w = await world(HISTORY());
    assert.deepStrictEqual(await bal(w), { ada: 10000, bob: 2500, cy: 500 });
    const seededFeed = (await req('GET', '/activity', { token: w.ada })).json.payments;
    assert.strictEqual(seededFeed.find((p) => p.payment_id === 'pa').created_at, T1);
    const bad = FX({ payments: [SP('pf', 'ada', 'bob', 5, inFuture(3600))] });
    err(await req('POST', '/_test/reset', { body: bad }), 422, 'validation_failed');
    assert.strictEqual((await me(w.ada)).balance, 10000, 'rejected reset changed nothing');
    err(await req('POST', '/_test/reset', { body: FX({ payments: [SP('pf', 'ada', 'bob', 5, '2026-01-01T10:00:00')] }) }), 422, 'validation_failed');
    const w2 = await world(FX({ payments: [SP('pn', 'ada', 'bob', 100)] }));
    const p = (await pay(w2.ada, 'bob', 1)).json;
    const seeded = (await req('GET', '/activity', { token: w2.ada })).json.payments.find((x) => x.payment_id === 'pn');
    assert.ok(seeded.created_at < p.created_at, 'reset-time payments precede API payments');
  });

  // ------------------------------------------------------------- GET /me as_of
  await test('GET /me without temporal parameters is the Stage 2 response (no as_of/known_at keys)', async () => {
    const w = await world(HISTORY());
    const m = await me(w.ada);
    assert.deepStrictEqual(Object.keys(m).sort(), ['available', 'balance', 'currency', 'display_name', 'handle', 'held', 'minor_units', 'total', 'user_id']);
  });

  await test('as_of: opening before everything, inclusive at an instant, current after; echoed exactly', async () => {
    const w = await world(HISTORY());
    const at = async (v) => (await req('GET', `/me?as_of=${enc(v)}`, { token: w.ada })).json;
    assert.strictEqual((await at(T0)).balance, 10900, 'before the earliest payment = opening');
    assert.strictEqual((await at(T1)).balance, 9900, 'a payment at exactly as_of counts');
    assert.strictEqual((await at('2026-01-01T09:59:59.999999999+00:00')).balance, 10900, 'one nanosecond earlier does not');
    assert.strictEqual((await at('2026-01-01T10:00:00.000000001+00:00')).balance, 9900);
    assert.strictEqual((await at('2026-01-01T12:00:00+02:00')).balance, 9900, 'offsets are honoured (== 10:00Z)');
    assert.strictEqual((await at('2026-01-01T10:30:00Z')).balance, 9900);
    assert.strictEqual((await at(T2)).balance, 10000, 'both T2 payments counted (tie)');
    assert.strictEqual((await at('2099-01-01T00:00:00+00:00')).balance, 10000, 'future = current');
    const echoed = await at('2026-01-01T12:00:00+02:00');
    assert.strictEqual(echoed.as_of, '2026-01-01T12:00:00+02:00');
    assert.strictEqual(echoed.total, echoed.balance);
    assert.strictEqual(echoed.available, echoed.total - echoed.held);
    const rawPlus = (await req('GET', `/me?as_of=${T2}`, { token: w.ada })).json; // unencoded '+'
    assert.strictEqual(rawPlus.balance, 10000);
    assert.strictEqual(rawPlus.as_of, T2);
    for (const u of ['bob', 'cy']) {
      const r = (await req('GET', `/me?as_of=${enc(T0)}`, { token: w[u] })).json;
      assert.strictEqual(r.balance, u === 'bob' ? 1800 : 700 - 400, `${u} opening`);
    }
  });

  await test('as_of / known_at / from / to reject naive, bare dates, empty and garbage with 422', async () => {
    const w = await world(HISTORY());
    for (const bad of ['', '2026-01-01', '2026-01-01T10:00:00', '2026-01-01 10:00:00+00:00', 'yesterday', '2026-13-01T10:00:00Z', '2026-02-30T10:00:00Z', '2026-01-01T25:00:00Z', '2026-01-01T10:00:00+0000', '2026-01-01T10:00Z']) {
      for (const [path, param] of [['/me', 'as_of'], ['/me', 'known_at'], ['/statement', 'from'], ['/statement', 'to'], ['/statement', 'known_at']]) {
        err(await req('GET', `${path}?${param}=${enc(bad)}`, { token: w.ada }), 422, 'validation_failed');
      }
    }
    assert.strictEqual((await req('GET', '/me?as_of=' + enc(T1))).status, 401);
  });

  // ------------------------------------------------------------------ statement
  await test('statement: oldest first, ties by id, balance_after walks forward, closing arithmetic, own payments only', async () => {
    const w = await world(HISTORY());
    const s = await stmt(w.ada);
    assert.strictEqual(s.opening_balance, 10900);
    assert.deepStrictEqual(s.entries.map((e) => [e.payment.payment_id, e.delta, e.balance_after]), [['pa', -1000, 9900], ['pb', 300, 10200], ['pc', -200, 10000]]);
    assert.strictEqual(s.closing_balance, 10000);
    assert.strictEqual(s.closing_balance, (await me(w.ada)).balance);
    assert.strictEqual(s.opening_balance + s.entries.reduce((a, e) => a + e.delta, 0), s.closing_balance);
    assert.strictEqual(s.has_more, false);
    assert.ok(typeof s.snapshot === 'string' && s.snapshot.length >= 16 && s.snapshot.length <= 64);
    const e = s.entries[0];
    assert.deepStrictEqual([e.revision, e.effective_at, e.recorded_at, e.payment.amount, e.payment.created_at], [1, T1, T1, 1000, T1]);
    const cy = await stmt(w.cy);
    assert.deepStrictEqual(cy.entries.map((x) => x.payment.payment_id), ['pc'], 'public payments between others are absent');
    const prv = await world(FX({ payments: [SP('px', 'ada', 'bob', 5, T1, { visibility: 'private' })] }));
    assert.strictEqual((await stmt(prv.bob)).entries.length, 1, 'private payments appear for their parties');
    assert.strictEqual((await stmt(prv.cy)).entries.length, 0);
  });

  await test('statement window is half-open [from, to): from inclusive, to exclusive; opening/closing are the balances before them', async () => {
    const w = await world(HISTORY());
    const s = await stmt(w.ada, `?from=${enc(T2)}&to=${enc(T3)}`);
    assert.strictEqual(s.opening_balance, 9900, 'balance immediately before from');
    assert.deepStrictEqual(s.entries.map((e) => e.payment.payment_id), ['pb', 'pc']);
    assert.strictEqual(s.closing_balance, 10000);
    const s2 = await stmt(w.ada, `?from=${enc(T1)}&to=${enc(T2)}`);
    assert.deepStrictEqual(s2.entries.map((e) => e.payment.payment_id), ['pa'], 'a payment at exactly `to` is excluded');
    assert.strictEqual(s2.opening_balance, 10900);
    assert.strictEqual(s2.closing_balance, 9900, 'closing is the balance immediately before `to`');
    const s3 = await stmt(w.ada, `?from=${enc(T3)}`);
    assert.deepStrictEqual([s3.entries.length, s3.opening_balance, s3.closing_balance], [0, 10000, 10000]);
    const s4 = await stmt(w.ada, `?to=${enc(T1)}`);
    assert.deepStrictEqual([s4.entries.length, s4.opening_balance, s4.closing_balance], [0, 10900, 10900]);
    const empty = await stmt(w.ada, `?from=${enc(T3)}&to=${enc(T1)}`);
    assert.deepStrictEqual([empty.entries.length, empty.opening_balance === empty.closing_balance], [0, true], 'an inverted window is empty');
  });

  await test('statement pagination never changes balance_after, opening or closing; has_more exact; offsets beyond the end', async () => {
    const w = await world(FX({ users: [U('ada', 100000), U('bob', 0), U('cy', 0)] }));
    for (let i = 0; i < 23; i++) await pay(w.ada, 'bob', 10 + i);
    const full = await stmt(w.ada, '?limit=200');
    assert.strictEqual(full.entries.length, 23);
    const seen = [];
    for (let off = 0; off < 30; off += 5) {
      const pg = await stmt(w.ada, `?limit=5&offset=${off}`);
      assert.strictEqual(pg.opening_balance, full.opening_balance);
      assert.strictEqual(pg.closing_balance, full.closing_balance);
      assert.strictEqual(pg.has_more, off + 5 < 23, `has_more at offset ${off}`);
      seen.push(...pg.entries);
    }
    assert.deepStrictEqual(seen.map((e) => [e.payment.payment_id, e.balance_after]), full.entries.map((e) => [e.payment.payment_id, e.balance_after]));
    const beyond = await stmt(w.ada, '?limit=5&offset=1000');
    assert.deepStrictEqual([beyond.entries.length, beyond.has_more, beyond.closing_balance], [0, false, full.closing_balance]);
    for (const q of ['limit=0', 'limit=201', 'limit=x', 'offset=-1', 'offset=1.5']) err(await req('GET', `/statement?${q}`, { token: w.ada }), 422, 'validation_failed');
    assert.strictEqual((await req('GET', '/statement?foo=bar&limit=3', { token: w.ada })).status, 200, 'unknown parameters are ignored');
    assert.strictEqual((await req('GET', '/statement')).status, 401);
  });

  await test('snapshots: frozen across payments and corrections, only limit/offset allowed, 404 for unknown/foreign/reset', async () => {
    const w = await world(HISTORY());
    const first = await stmt(w.ada, '?limit=2');
    const before = await req('GET', `/statement?snapshot=${first.snapshot}&limit=200`, { token: w.ada });
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.json.entries.length, 3);
    await pay(w.ada, 'bob', 7);
    const c = await correct(w.ada, 'pa', { expected_revision: 1, amount: 900, effective_at: T1, reason: 'oops' });
    assert.strictEqual(c.status, 201, c.text);
    const after = await req('GET', `/statement?snapshot=${first.snapshot}&limit=200`, { token: w.ada });
    assert.deepStrictEqual(after.json, before.json, 'a snapshot never changes');
    assert.strictEqual(after.json.snapshot, first.snapshot);
    const page2 = await req('GET', `/statement?snapshot=${first.snapshot}&limit=2&offset=2`, { token: w.ada });
    assert.deepStrictEqual([page2.json.entries.length, page2.json.has_more], [1, false]);
    const fresh = await stmt(w.ada);
    assert.strictEqual(fresh.entries.length, 4, 'a new read sees the new payment');
    assert.notStrictEqual(fresh.snapshot, first.snapshot);
    for (const extra of [`from=${enc(T1)}`, `to=${enc(T2)}`, `known_at=${enc(T2)}`, 'from=']) {
      err(await req('GET', `/statement?snapshot=${first.snapshot}&${extra}`, { token: w.ada }), 422, 'validation_failed');
    }
    err(await req('GET', `/statement?snapshot=${first.snapshot}&limit=0`, { token: w.ada }), 422, 'validation_failed');
    err(await req('GET', `/statement?snapshot=${first.snapshot}`, { token: w.bob }), 404, 'not_found');
    err(await req('GET', '/statement?snapshot=nope', { token: w.ada }), 404, 'not_found');
    assert.strictEqual((await req('GET', `/statement?snapshot=${first.snapshot}`)).status, 401);
    await reset(HISTORY());
    const w2 = { ada: await login('ada') };
    err(await req('GET', `/statement?snapshot=${first.snapshot}`, { token: w2.ada }), 404, 'not_found');
  });

  // ---------------------------------------------------------------- corrections
  await test('correction: 201 shape, balances move between the same two wallets, feed unchanged, receipts untouched', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000, { note: 'rent' })).json;
    const k = K();
    const c = await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'corrected amount' }, k);
    assert.strictEqual(c.status, 201, c.text);
    assert.deepStrictEqual(Object.keys(c.json).sort(), ['amount', 'effective_at', 'payment_id', 'reason', 'recorded_at', 'revision']);
    assert.deepStrictEqual([c.json.payment_id, c.json.revision, c.json.amount, c.json.effective_at, c.json.reason], [p.payment_id, 2, 400, p.created_at, 'corrected amount']);
    assert.ok(c.json.recorded_at > p.created_at);
    assert.deepStrictEqual(await bal(w), { ada: 9600, bob: 2900, cy: 500 }, 'a decrease returns 600 from the receiver');
    const c2 = await correct(w.ada, p.payment_id, { expected_revision: 2, amount: 1500, effective_at: p.created_at, reason: 'bigger' });
    assert.strictEqual(c2.status, 201, c2.text);
    assert.deepStrictEqual(await bal(w), { ada: 8500, bob: 4000, cy: 500 }, 'an increase debits the sender');
    const feed = (await req('GET', '/activity', { token: w.ada })).json.payments;
    assert.strictEqual(feed.length, 1, 'corrections are not feed items');
    assert.deepStrictEqual([feed[0].amount, feed[0].created_at], [1000, p.created_at]);
    const same = await req('POST', '/payments', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 1 } });
    assert.strictEqual(same.status, 201);
    const s = await stmt(w.ada);
    assert.deepStrictEqual([s.entries[0].payment.amount, s.entries[0].revision, s.entries[0].delta], [1500, 3, -1500], 'statement shows the selected amount');
    const rev = (await req('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).json.revisions;
    assert.deepStrictEqual(rev.map((r) => [r.revision, r.amount, r.reason]), [[1, 1000, ''], [2, 400, 'corrected amount'], [3, 1500, 'bigger']]);
    assert.deepStrictEqual(Object.keys(rev[0]).sort(), ['amount', 'effective_at', 'payment_id', 'reason', 'recorded_at', 'revision']);
    assert.ok(rev[0].recorded_at < rev[1].recorded_at && rev[1].recorded_at < rev[2].recorded_at, 'recorded times strictly increase');
    assert.strictEqual((await req('GET', '/activity', { token: w.ada })).json.payments.find((x) => x.payment_id === p.payment_id).amount, 1000);
  });

  await test('correction: zero reverses the payment; same amount allowed; moving effective_at earlier/later reorders the statement', async () => {
    const w = await world(HISTORY());
    assert.strictEqual((await correct(w.ada, 'pa', { expected_revision: 1, amount: 0, effective_at: T1, reason: 'reverse' })).status, 201);
    assert.deepStrictEqual(await bal(w), { ada: 11000, bob: 1500, cy: 500 }, 'reversal returns the whole amount');
    const s = await stmt(w.ada);
    assert.deepStrictEqual(s.entries.map((e) => [e.payment.payment_id, e.delta]), [['pa', 0], ['pb', 300], ['pc', -200]], 'zero-amount revisions still appear');
    // move pc to before pa
    const c = await correct(w.ada, 'pc', { expected_revision: 1, amount: 200, effective_at: T0, reason: 'earlier' });
    assert.strictEqual(c.status, 201, c.text);
    const s2 = await stmt(w.ada);
    assert.deepStrictEqual(s2.entries.map((e) => e.payment.payment_id), ['pc', 'pa', 'pb'], 'ordered by selected effective_at');
    assert.deepStrictEqual(s2.entries.map((e) => e.balance_after), [10700, 10700, 11000]);
    const win = await stmt(w.ada, `?from=${enc(T1)}&to=${enc(T3)}`);
    assert.deepStrictEqual(win.entries.map((e) => e.payment.payment_id), ['pa', 'pb'], 'a correction moved pc out of the window');
    assert.strictEqual(win.opening_balance, 10700);
  });

  await test('correction errors: 401/404/403, validation matrix, stale revision, replay, key reuse, linked payments', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000)).json;
    const id = p.payment_id;
    const ok = { expected_revision: 1, amount: 900, effective_at: p.created_at, reason: 'r' };
    assert.strictEqual((await req('POST', `/payments/${id}/corrections`, { key: K(), body: ok })).status, 401);
    err(await correct(w.ada, 'p_nope', ok), 404, 'not_found');
    err(await correct(w.bob, id, ok), 403, 'forbidden');
    err(await correct(w.cy, id, ok), 403, 'forbidden');
    assert.strictEqual((await req('POST', `/payments/${id}/corrections`, { token: w.ada, body: ok })).status, 400, 'key required');
    for (const [name, patch] of Object.entries({
      missing_expected: { expected_revision: undefined }, missing_amount: { amount: undefined }, missing_effective: { effective_at: undefined }, missing_reason: { reason: undefined },
      rev_zero: { expected_revision: 0 }, rev_neg: { expected_revision: -1 }, rev_frac: { expected_revision: 1.5 }, rev_str: { expected_revision: '1' }, rev_bool: { expected_revision: true },
      amt_neg: { amount: -1 }, amt_big: { amount: 1000000001 }, amt_frac: { amount: 1.5 }, amt_str: { amount: '5' }, amt_null: { amount: null },
      reason_empty: { reason: '' }, reason_long: { reason: 'x'.repeat(201) }, reason_num: { reason: 5 }, reason_null: { reason: null },
      eff_naive: { effective_at: '2026-01-01T10:00:00' }, eff_date: { effective_at: '2026-01-01' }, eff_empty: { effective_at: '' }, eff_num: { effective_at: 5 },
      eff_future: { effective_at: inFuture(3600) },
    })) {
      const body = { ...ok, ...patch };
      for (const kk of Object.keys(body)) if (body[kk] === undefined) delete body[kk];
      const r = await correct(w.ada, id, body);
      assert.ok(r.status === 422 && r.json.error.code === 'validation_failed', `${name}: ${r.status} ${r.text}`);
    }
    err(await correct(w.ada, id, { ...ok, amount: 1000000000 }), 409, 'insufficient_funds'); // the boundary amount is valid input
    const k = K();
    const c1 = await correct(w.ada, id, ok, k);
    assert.strictEqual(c1.status, 201, c1.text);
    err(await correct(w.ada, id, ok), 409, 'stale_revision');
    const c2 = await correct(w.ada, id, { ...ok, expected_revision: 2, amount: 800 });
    assert.strictEqual(c2.status, 201);
    const replay = await correct(w.ada, id, ok, k);
    assert.strictEqual(replay.status, 200, 'replay is 200 even after newer revisions');
    assert.deepStrictEqual(replay.json, c1.json, 'and returns the original revision');
    err(await correct(w.ada, id, { ...ok, amount: 5 }, k), 409, 'idempotency_key_reuse');
    assert.strictEqual((await req('GET', `/payments/${id}/revisions`, { token: w.ada })).json.revisions.length, 3);
    // key reuse after a failed (4xx) attempt is a first use
    const k2 = K();
    err(await correct(w.ada, id, { ...ok, expected_revision: 9 }, k2), 409, 'stale_revision');
    assert.strictEqual((await correct(w.ada, id, { ...ok, expected_revision: 3, amount: 700 }, k2)).status, 201);
  });

  await test('correction: unaffordable debit -> insufficient_funds, state untouched; sender/receiver and holds count', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000)).json;
    const before = await bal(w);
    // increase beyond what ada has
    err(await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 1000 + 9001, effective_at: p.created_at, reason: 'too much' }), 409, 'insufficient_funds');
    assert.deepStrictEqual(await bal(w), before);
    assert.strictEqual((await req('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).json.revisions.length, 1);
    // a hold shrinks what the sender can add
    await req('POST', '/authorizations', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 8000 } });
    err(await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 1000 + 1001, effective_at: p.created_at, reason: 'x' }), 409, 'insufficient_funds');
    assert.strictEqual((await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 1000 + 1000, effective_at: p.created_at, reason: 'x' })).status, 201);
    // decrease the receiver cannot return
    const w2 = await world(FX({ users: [U('ada', 10000), U('bob', 0), U('cy', 0)] }));
    const q = (await pay(w2.ada, 'bob', 500)).json;
    await pay(w2.bob, 'cy', 500);
    err(await correct(w2.ada, q.payment_id, { expected_revision: 1, amount: 100, effective_at: q.created_at, reason: 'take back' }), 409, 'insufficient_funds');
  });

  await test('historical_overdraft: a past boundary would go negative (tie-safe), insufficient_funds takes precedence, nothing changes', async () => {
    const fx = FX({
      users: [U('ada', 10000), U('bob', 700), U('cy', 500)],
      payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'bob', 'cy', 1000, T2)],
    });
    const w = await world(fx);
    // bob: opening 700 -> 1700 at T1 -> 700 at T2. Moving the incoming payment to T3 leaves T2 at -300.
    const stmtBefore = await stmt(w.bob);
    const r = await correct(w.ada, 'pa', { expected_revision: 1, amount: 1000, effective_at: T3, reason: 'late' });
    err(r, 409, 'historical_overdraft');
    assert.strictEqual((await req('GET', '/payments/pa/revisions', { token: w.ada })).json.revisions.length, 1);
    assert.deepStrictEqual((await stmt(w.bob)).entries.map((e) => e.balance_after), stmtBefore.entries.map((e) => e.balance_after));
    assert.deepStrictEqual(await bal(w), { ada: 10000, bob: 700, cy: 500 });
    // the same instant for both movements is fine (their effects are combined)
    const w2 = await world(FX({
      users: [U('ada', 10000), U('bob', 0), U('cy', 500)],
      payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'bob', 'cy', 1000, T1)],
    }));
    assert.strictEqual((await correct(w2.ada, 'pa', { expected_revision: 1, amount: 1000, effective_at: T1, reason: 'noop' })).status, 201);
    // lowering the incoming amount first makes bob's T1 boundary negative
    err(await correct(w2.ada, 'pa', { expected_revision: 2, amount: 400, effective_at: T1, reason: 'less' }), 409, 'insufficient_funds');
    // a decrease the receiver can afford now but not historically
    const w3 = await world(FX({
      users: [U('ada', 10000), U('bob', 1000), U('cy', 500)],
      payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'bob', 'cy', 1000, T2)],
    }));
    // bob: opening 1000, 2000 at T1, 1000 at T2. Reduce pa to 500: T2 = 500, fine.
    assert.strictEqual((await correct(w3.ada, 'pa', { expected_revision: 1, amount: 500, effective_at: T1, reason: 'ok' })).status, 201);
    // Now reduce further to 0 while bob currently has 500: current ok (500>=500), T2 = 0 ok.
    assert.strictEqual((await correct(w3.ada, 'pa', { expected_revision: 2, amount: 0, effective_at: T1, reason: 'zero' })).status, 201);
  });

  await test('historical_overdraft counts holds: available (total - held) negative at a hold event boundary', async () => {
    const fx = FX({
      users: [U('ada', 10000), U('bob', 2500), U('cy', 1500)],
      payments: [SP('pa', 'ada', 'bob', 1000, T3), SP('pb', 'bob', 'cy', 1000, T1)],
      authorizations: [{ id: 'a_h', from_user_id: 'u_bob', to_user_id: 'u_cy', amount: 1500, status: 'open', created_at: T2, expires_at: inFuture(7200) }],
    });
    const w = await world(fx);
    // bob: opening 2500, 1500 at T1, hold 1500 at T2 (available 0), 2500 at T3.
    const m = await me(w.bob);
    assert.deepStrictEqual([m.total, m.held, m.available], [2500, 1500, 1000]);
    err(await correct(w.bob, 'pb', { expected_revision: 1, amount: 1200, effective_at: T1, reason: 'more' }), 409, 'historical_overdraft');
    assert.strictEqual((await correct(w.bob, 'pb', { expected_revision: 1, amount: 1000, effective_at: T1, reason: 'same' })).status, 201);
    const at = async (t) => (await req('GET', `/me?as_of=${enc(t)}`, { token: w.bob })).json;
    assert.deepStrictEqual([(await at(T0)).total, (await at(T1)).total, (await at(T1)).held, (await at(T2)).held, (await at(T2)).available], [2500, 1500, 0, 1500, 0]);
  });

  await test('known_at: the latest revision recorded at or before it; payments not yet recorded contribute nothing', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000)).json;
    await sleep(5);
    const c1 = (await correct(w.ada, p.payment_id, { expected_revision: 1, amount: 400, effective_at: p.created_at, reason: 'a' })).json;
    await sleep(5);
    const c2 = (await correct(w.ada, p.payment_id, { expected_revision: 2, amount: 700, effective_at: p.created_at, reason: 'b' })).json;
    const known = async (k, extra = '') => (await req('GET', `/me?known_at=${enc(k)}${extra}`, { token: w.ada })).json;
    assert.strictEqual((await known('2020-01-01T00:00:00+00:00')).balance, 10000, 'nothing was recorded yet: the opening balance');
    assert.strictEqual((await known(p.created_at)).balance, 9000, 'only revision 1 was known');
    assert.strictEqual((await known(c1.recorded_at)).balance, 9600, 'recorded_at itself counts');
    assert.strictEqual((await known(c2.recorded_at)).balance, 9300);
    assert.strictEqual((await known('2099-01-01T00:00:00+00:00')).balance, 9300, 'future known_at = everything known');
    assert.strictEqual((await known(c1.recorded_at)).known_at, c1.recorded_at, 'echoed exactly');
    const s = await stmt(w.ada, `?known_at=${enc(c1.recorded_at)}`);
    assert.deepStrictEqual([s.entries[0].revision, s.entries[0].payment.amount, s.closing_balance], [2, 400, 9600]);
    const none = await stmt(w.ada, `?known_at=${enc('2020-01-01T00:00:00+00:00')}`);
    assert.deepStrictEqual([none.entries.length, none.opening_balance, none.closing_balance], [0, 10000, 10000]);
    // effective time and recorded time are independent: backdate a correction
    const back = await correct(w.ada, p.payment_id, { expected_revision: 3, amount: 100, effective_at: '2026-01-01T00:00:00+00:00', reason: 'backdated' });
    assert.strictEqual(back.status, 201, back.text);
    const asOf = async (t, k) => (await req('GET', `/me?as_of=${enc(t)}&known_at=${enc(k)}`, { token: w.ada })).json.balance;
    assert.strictEqual(await asOf('2026-06-01T00:00:00+00:00', '2099-01-01T00:00:00+00:00'), 9900, 'known now: effective back in January');
    assert.strictEqual(await asOf('2026-06-01T00:00:00+00:00', c2.recorded_at), 10000, 'known then: the payment had not happened by June');
    assert.strictEqual(await asOf(p.created_at, c2.recorded_at), 9300);
  });

  await test('the sum of balances equals the seeded total in every (as_of, known_at) view', async () => {
    const w = await world(HISTORY());
    const rec = [];
    await sleep(3);
    rec.push((await correct(w.ada, 'pa', { expected_revision: 1, amount: 800, effective_at: T0, reason: '1' })).json.recorded_at);
    await sleep(3);
    rec.push((await correct(w.bob, 'pb', { expected_revision: 1, amount: 100, effective_at: T3, reason: '2' })).json.recorded_at);
    const p = (await pay(w.cy, 'ada', 50)).json;
    const instants = [T0, T1, T2, T3, p.created_at, '2026-01-01T09:59:59.999999+00:00', '2099-01-01T00:00:00+00:00', ...rec];
    const knowns = [...rec, T1, '2020-01-01T00:00:00+00:00', '2099-01-01T00:00:00+00:00', p.created_at];
    for (const t of instants) {
      assert.strictEqual(await sumAt(w, `?as_of=${enc(t)}`), w.total, `as_of ${t}`);
      for (const k of knowns) assert.strictEqual(await sumAt(w, `?as_of=${enc(t)}&known_at=${enc(k)}`), w.total, `as_of ${t} known_at ${k}`);
    }
    for (const u of w.fx.users) {
      const s = await stmt(w[u.handle], '?limit=200');
      assert.strictEqual(s.opening_balance + s.entries.reduce((a, e) => a + e.delta, 0), s.closing_balance);
    }
  });

  await test('revisions endpoint: parties only (a third party gets 404 even for a public payment), 401, 404', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 10, { visibility: 'public' })).json;
    assert.strictEqual((await req('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).status, 200);
    assert.strictEqual((await req('GET', `/payments/${p.payment_id}/revisions`, { token: w.bob })).status, 200);
    err(await req('GET', `/payments/${p.payment_id}/revisions`, { token: w.cy }), 404, 'not_found');
    err(await req('GET', '/payments/p_nope/revisions', { token: w.ada }), 404, 'not_found');
    assert.strictEqual((await req('GET', `/payments/${p.payment_id}/revisions`)).status, 401);
  });

  await test('settlement members and captures are linked payments: correction -> 422 linked_payment_immutable; settlement times shared', async () => {
    const w = await world(FX({ settlement_operator_ids: ['u_ada'] }));
    const st = await req('POST', '/settlements', { token: w.ada, key: K(), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }] } });
    assert.strictEqual(st.status, 201, st.text);
    const [m1, m2] = st.json.payments;
    assert.strictEqual(m1.created_at, st.json.committed_at);
    assert.strictEqual(m2.created_at, st.json.committed_at);
    err(await correct(w.ada, m1.payment_id, { expected_revision: 1, amount: 1, effective_at: m1.created_at, reason: 'x' }), 422, 'linked_payment_immutable');
    const rv = (await req('GET', `/payments/${m1.payment_id}/revisions`, { token: w.ada })).json.revisions;
    assert.deepStrictEqual([rv.length, rv[0].effective_at, rv[0].recorded_at], [1, st.json.committed_at, st.json.committed_at]);
    const a = (await req('POST', '/authorizations', { token: w.ada, key: K(), body: { to_handle: 'bob', amount: 300 } })).json;
    const cap = await req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: K(), body: { amount: 100, final: false } });
    assert.strictEqual(cap.status, 201, cap.text);
    err(await correct(w.ada, cap.json.payment_id, { expected_revision: 1, amount: 1, effective_at: cap.json.created_at, reason: 'x' }), 422, 'linked_payment_immutable');
    const s = await stmt(w.ada);
    assert.strictEqual(s.entries.filter((e) => e.payment.payment_id === cap.json.payment_id).length, 1, 'a capture appears exactly once');
    assert.strictEqual(s.entries.find((e) => e.payment.payment_id === cap.json.payment_id).payment.authorization_id, a.authorization_id);
    assert.strictEqual(s.entries.length, 2, 'holds, releases and expiry are not payments');
  });

  // ------------------------------------------------------------ historical holds
  await test('historical holds: created, non-final capture, final capture, void and expiry, with closed_at; known_at gates events', async () => {
    const w = await world(FX({ authorization_ttl_seconds: 3 }));
    const t0 = (await pay(w.cy, 'bob', 1)).json.created_at;
    const a = (await req('POST', '/authorizations', { token: w.ada, key: K(), body: { to_handle: 'bob', amount: 2000 } })).json;
    assert.strictEqual(a.closed_at, null);
    await sleep(5);
    const c1 = (await req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: K(), body: { amount: 500, final: false } })).json;
    await sleep(5);
    const c2 = (await req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: K(), body: { amount: 300 } })).json; // final: releases 1200
    const closed = (await req('GET', '/authorizations', { token: w.ada })).json.authorizations[0];
    assert.strictEqual(closed.closed_at, c2.created_at, 'a final capture closes at the capture instant');
    const view = async (t, k) => (await req('GET', `/me?as_of=${enc(t)}${k ? `&known_at=${enc(k)}` : ''}`, { token: w.ada })).json;
    assert.strictEqual((await view(t0)).held, 0, 'before creation');
    assert.deepStrictEqual([(await view(a.created_at)).held, (await view(a.created_at)).available], [2000, 8000], 'a hold starts at creation');
    const afterC1 = await view(c1.created_at);
    assert.deepStrictEqual([afterC1.total, afterC1.held, afterC1.available], [9500, 1500, 8000], 'a non-final capture reduces the hold at capture time');
    const afterC2 = await view(c2.created_at);
    assert.deepStrictEqual([afterC2.total, afterC2.held, afterC2.available], [9200, 0, 9200], 'the final capture releases the remainder at its time');
    // known_at before the final capture was recorded: the hold is still open (its deadline is ttl later)
    const known = await view(c2.created_at, c1.created_at);
    assert.deepStrictEqual([known.total, known.held], [9500, 1500], 'events after known_at are unknown');
    // void
    const b = (await req('POST', '/authorizations', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 1000 } })).json;
    await sleep(5);
    const v = (await req('POST', `/authorizations/${b.authorization_id}/void`, { token: w.ada })).json;
    assert.ok(v.closed_at > b.created_at);
    assert.strictEqual((await view(b.created_at)).held, 1000);
    assert.strictEqual((await view(v.closed_at)).held, 0, 'released at the void instant (inclusive)');
    assert.strictEqual((await view(v.closed_at, b.created_at)).held, 1000, 'the void was not yet known');
    // expiry: closed_at == expires_at, also for queries beyond now
    const e = (await req('POST', '/authorizations', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 700 } })).json;
    assert.strictEqual((await view(e.created_at)).held, 700);
    assert.strictEqual((await view(e.expires_at)).held, 0, 'expiry takes effect at expires_at');
    assert.strictEqual((await view('2099-01-01T00:00:00+00:00')).held, 0, 'beyond now an open hold expires at its deadline');
    assert.strictEqual((await req('GET', '/me', { token: w.ada })).json.held, 700);
    await sleep(3200);
    const ex = (await req('GET', '/authorizations?status=expired', { token: w.ada })).json.authorizations.find((x) => x.authorization_id === e.authorization_id);
    assert.strictEqual(ex.closed_at, ex.expires_at);
    assert.strictEqual((await req('GET', '/me', { token: w.ada })).json.held, 0);
    assert.strictEqual((await view(e.expires_at)).held, 0);
    assert.strictEqual(await sumAt(w, `?as_of=${enc(c1.created_at)}`), w.total);
  });

  await test('seeded holds: open ones are created at reset (or created_at); closed ones are never held', async () => {
    const w = await world(FX({
      authorizations: [
        { id: 'a_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2000, status: 'open', expires_at: inFuture(7200) },
        { id: 'a_2', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1000, status: 'open', created_at: T1, expires_at: inFuture(7200) },
        { id: 'a_3', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 900, status: 'voided', expires_at: inFuture(7200) },
        { id: 'a_4', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 800, status: 'open', expires_at: inFuture(-7200) },
      ],
    }));
    const at = async (t) => (await req('GET', `/me?as_of=${enc(t)}`, { token: w.ada })).json;
    assert.strictEqual((await at(T0)).held, 0);
    assert.strictEqual((await at(T1)).held, 1000, 'a_2 holds from its created_at');
    assert.strictEqual((await at(inFuture(60))).held, 3000, 'a_1 holds from reset time');
    assert.strictEqual((await req('GET', '/me', { token: w.ada })).json.held, 3000);
    const list = (await req('GET', '/authorizations?limit=200', { token: w.ada })).json.authorizations;
    assert.strictEqual(list.find((a) => a.authorization_id === 'a_1').closed_at, null);
    assert.ok(list.find((a) => a.authorization_id === 'a_4').closed_at, 'expired by the clock: closed at its deadline');
    err(await req('POST', '/_test/reset', { body: FX({ authorizations: [{ id: 'a_x', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 5, status: 'open', created_at: inFuture(3600), expires_at: inFuture(7200) }] }) }), 422, 'validation_failed');
  });

  // --------------------------------------------------------- export/import
  await test('stage-3 export/import round trip: revisions, statements, snapshots cleared, corrections keep replaying', async () => {
    const w = await world(HISTORY());
    const k = K();
    const body = { expected_revision: 1, amount: 900, effective_at: T1, reason: 'imp' };
    const c = (await correct(w.ada, 'pa', body, k)).json;
    const before = [await stmt(w.ada), await stmt(w.bob), await me(w.ada, `?as_of=${enc(T1)}`), (await req('GET', '/payments/pa/revisions', { token: w.ada })).json];
    const exp = await req('GET', '/_test/export');
    await pay(w.ada, 'bob', 1);
    await req('POST', '/_test/reset', { body: FX() });
    assert.strictEqual((await req('POST', '/_test/import', { rawBody: exp.text })).status, 204);
    const after = [await stmt(w.ada), await stmt(w.bob), await me(w.ada, `?as_of=${enc(T1)}`), (await req('GET', '/payments/pa/revisions', { token: w.ada })).json];
    for (const s of [0, 1]) {
      delete before[s].snapshot;
      delete after[s].snapshot;
    }
    assert.deepStrictEqual(after, before);
    const replay = await correct(w.ada, 'pa', body, k);
    assert.strictEqual(replay.status, 200);
    assert.deepStrictEqual(replay.json, c);
    const next = await correct(w.ada, 'pa', { expected_revision: 2, amount: 950, effective_at: T1, reason: 'after import' });
    assert.strictEqual(next.status, 201, next.text);
    assert.ok(next.json.recorded_at > c.recorded_at);
    const p = (await pay(w.ada, 'bob', 3)).json;
    assert.ok(p.created_at > next.json.recorded_at, 'the clock continues after the imported history');
    const snap = (await stmt(w.ada)).snapshot;
    const exp2 = await req('GET', '/_test/export');
    assert.ok(!exp2.text.includes(snap), 'snapshots are not exported');
    assert.strictEqual((await req('POST', '/_test/import', { rawBody: exp2.text })).status, 204);
    err(await req('GET', `/statement?snapshot=${snap}`, { token: w.ada }), 404, 'not_found');
  });

  await test('import validation: inconsistent revisions are 422 and never change the destination', async () => {
    const w = await world(HISTORY());
    await correct(w.ada, 'pa', { expected_revision: 1, amount: 900, effective_at: T1, reason: 'x' });
    const base = JSON.parse((await req('GET', '/_test/export')).text);
    const pa = (e) => e.state.payments.find((p) => p.id === 'pa');
    const muts = [
      (e) => { pa(e).revisions = []; },
      (e) => { pa(e).revisions = 'x'; },
      (e) => { pa(e).revisions[1].revision = 5; },
      (e) => { pa(e).revisions[1].amount = -1; },
      (e) => { pa(e).revisions[1].amount = 1.5; },
      (e) => { pa(e).revisions[1].recordedAt = 'nope'; },
      (e) => { pa(e).revisions[1].effectiveAt = '2026-01-01'; },
      (e) => { pa(e).revisions[1].recordedAt = pa(e).revisions[0].recordedAt; },
      (e) => { pa(e).revisions[1].reason = 5; },
      (e) => { pa(e).revisions[0].amount = 1; },
      (e) => { pa(e).revisions[0].recordedAt = '2026-02-01T00:00:00+00:00'; },
      (e) => { pa(e).createdAt = 'yesterday'; },
      (e) => { e.state.authorizations = [{ id: 'a', fromUserId: 'u_ada', toUserId: 'u_bob', amount: 5, capturedAmount: 0, note: '', visibility: 'public', status: 'open', expiresAt: inFuture(100), createdAt: 'x', paymentIds: [] }]; },
    ];
    const meBefore = await me(w.ada);
    for (const mut of muts) {
      const c = JSON.parse(JSON.stringify(base));
      mut(c);
      const r = await req('POST', '/_test/import', { rawBody: JSON.stringify(c) });
      assert.strictEqual(r.status, 422, `${mut.toString()} -> ${r.status} ${r.text}`);
    }
    assert.deepStrictEqual(await me(w.ada), meBefore);
  });

  await test('upgrade: real Stage 1 and Stage 2 exports import; openings derived; history, statements and corrections work; old receipts replay', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const dirs = { s1: path.join(root, 'stage-1'), s2: path.join(root, 'stage-2') };
    if (!fs.existsSync(path.join(dirs.s1, 'src', 'server.js')) || !fs.existsSync(path.join(dirs.s2, 'src', 'server.js'))) {
      console.log('       (skipped: stage-1/ or stage-2/ not found next to stage-3/)');
      return;
    }
    for (const [label, dir] of Object.entries(dirs)) {
      const svc = await startService(dir);
      try {
        const fx = FX({ users: [U('ada', 10000), U('bob', 2500), U('cy', 500)], settlement_operator_ids: ['u_ada'] });
        assert.strictEqual((await http(svc.base, 'POST', '/_test/reset', { body: fx })).status, 204);
        const tok = {};
        for (const h of ['ada', 'bob', 'cy']) tok[h] = await login(h, svc.base);
        const k1 = K();
        const p1 = (await http(svc.base, 'POST', '/payments', { token: tok.ada, key: k1, body: { to_handle: 'bob', amount: 700, note: 'old' } })).json;
        const rq = (await http(svc.base, 'POST', '/requests', { token: tok.cy, key: K(), body: { payer_handle: 'bob', amount: 200 } })).json;
        await http(svc.base, 'POST', '/settlements', { token: tok.ada, key: K(), body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 100 }] } });
        let holdExists = false;
        if (label === 's2') {
          const a = await http(svc.base, 'POST', '/authorizations', { token: tok.ada, key: K(), body: { to_handle: 'cy', amount: 1500 } });
          assert.strictEqual(a.status, 201, a.text);
          const cap = await http(svc.base, 'POST', `/authorizations/${a.json.authorization_id}/capture`, { token: tok.cy, key: K(), body: { amount: 400, final: false } });
          assert.strictEqual(cap.status, 201, cap.text);
          holdExists = true;
        }
        const balances = {};
        for (const h of ['ada', 'bob', 'cy']) balances[h] = (await http(svc.base, 'GET', '/me', { token: tok[h] })).json.balance;
        const exp = await http(svc.base, 'GET', '/_test/export');
        assert.strictEqual(exp.status, 200);
        await reset(FX({ users: [U('zed', 1)] }));
        const imp = await req('POST', '/_test/import', { rawBody: exp.text });
        assert.strictEqual(imp.status, 204, `${label}: ${imp.text}`);
        // same tokens, same balances, same held funds
        for (const h of ['ada', 'bob', 'cy']) assert.strictEqual((await me(tok[h])).balance, balances[h], `${label} ${h}`);
        if (holdExists) assert.strictEqual((await me(tok.ada)).held, 1100, `${label} hold survived`);
        // history: opening balance before everything; statement closes
        for (const h of ['ada', 'bob', 'cy']) {
          const s = await stmt(tok[h], '?limit=200');
          assert.strictEqual(s.closing_balance, balances[h]);
          assert.strictEqual(s.opening_balance + s.entries.reduce((a, e) => a + e.delta, 0), s.closing_balance);
          assert.strictEqual((await me(tok[h], `?as_of=${enc('2000-01-01T00:00:00+00:00')}`)).balance, s.opening_balance);
        }
        assert.strictEqual((await stmt(tok.ada)).opening_balance, 10000, `${label}: ada opened at the seeded balance`);
        const sAda = await stmt(tok.ada);
        const ids = sAda.entries.map((e) => e.payment.payment_id);
        assert.ok(ids.includes(p1.payment_id));
        assert.deepStrictEqual((await req('GET', `/payments/${p1.payment_id}/revisions`, { token: tok.ada })).json.revisions.map((r) => [r.revision, r.amount, r.reason]), [[1, 700, '']]);
        // the old receipt still replays byte-for-byte, and the imported pending request is payable
        const replay = await req('POST', '/payments', { token: tok.ada, key: k1, body: { to_handle: 'bob', amount: 700, note: 'old' } });
        assert.strictEqual(replay.status, 200);
        assert.deepStrictEqual(replay.json, p1);
        const paid = await req('POST', `/requests/${rq.request_id}/pay`, { token: tok.bob, key: K(), body: {} });
        assert.strictEqual(paid.status, 201, `${label}: ${paid.text}`);
        // corrections work on imported payments (not on settlement members or captures)
        const fix = await correct(tok.ada, p1.payment_id, { expected_revision: 1, amount: 500, effective_at: p1.created_at, reason: 'upgrade' });
        assert.strictEqual(fix.status, 201, `${label}: ${fix.text}`);
        assert.strictEqual((await me(tok.ada)).balance, balances.ada + 200);
        const settlementMember = sAda.entries.find((e) => e.payment.settlement_id);
        err(await correct(tok.ada, settlementMember.payment.payment_id, { expected_revision: 1, amount: 1, effective_at: settlementMember.payment.created_at, reason: 'x' }), 422, 'linked_payment_immutable');
        if (holdExists) {
          const capture = (await stmt(tok.cy)).entries.find((e) => e.payment.authorization_id);
          err(await correct(tok.ada, capture.payment.payment_id, { expected_revision: 1, amount: 1, effective_at: capture.payment.created_at, reason: 'x' }), 422, 'linked_payment_immutable');
          const hist = (await req('GET', `/me?as_of=${enc(capture.payment.created_at)}`, { token: tok.ada })).json;
          assert.strictEqual(hist.held, 1100, `${label}: imported hold history at the capture instant`);
          const first = (await req('GET', '/authorizations', { token: tok.ada })).json.authorizations[0];
          assert.strictEqual(first.closed_at, null);
        }
        let total = 0;
        for (const h of ['ada', 'bob', 'cy']) total += (await me(tok[h], `?as_of=${enc('2099-01-01T00:00:00+00:00')}`)).balance;
        assert.strictEqual(total, 13000, `${label}: money is conserved`);
      } finally {
        svc.stop();
      }
    }
  });

  // ----------------------------------------------------------------- concurrency
  await test('concurrent corrections with one expected_revision: exactly one wins, the rest are stale; money conserved', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world();
      const p = (await pay(w.ada, 'bob', 1000)).json;
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => correct(w.ada, p.payment_id, { expected_revision: 1, amount: 100 + i, effective_at: p.created_at, reason: `c${i}` })));
      assert.strictEqual(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join(','));
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.json.error.code === 'stale_revision'));
      const revs = (await req('GET', `/payments/${p.payment_id}/revisions`, { token: w.ada })).json.revisions;
      assert.strictEqual(revs.length, 2);
      const b = await bal(w);
      assert.strictEqual(b.ada + b.bob + b.cy, w.total);
      assert.strictEqual(b.bob, 2500 + revs[1].amount);
    }
  });

  await test('concurrent same-key corrections apply once', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000)).json;
    const k = K();
    const body = { expected_revision: 1, amount: 250, effective_at: p.created_at, reason: 'once' };
    const rs = await Promise.all(Array.from({ length: 20 }, () => correct(w.ada, p.payment_id, body, k)));
    assert.ok(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => r.status).join(','));
    assert.strictEqual(rs.filter((r) => r.status === 201).length, 1);
    assert.strictEqual(new Set(rs.map((r) => JSON.stringify(r.json))).size, 1);
    assert.strictEqual((await me(w.bob)).balance, 2750);
  });

  await test('statements, snapshots and corrections under concurrent payments: no 5xx, snapshots stay frozen, totals conserved', async () => {
    const w = await world(FX({ users: [U('ada', 1000000), U('bob', 1000000), U('cy', 1000000)] }));
    const seed = [];
    for (let i = 0; i < 60; i++) seed.push((await pay(i % 2 ? w.bob : w.ada, i % 2 ? 'ada' : 'bob', 10 + i)).json);
    const snap = await stmt(w.ada, '?limit=200');
    const frozen = await req('GET', `/statement?snapshot=${snap.snapshot}&limit=200`, { token: w.ada });
    const jobs = [];
    for (let i = 0; i < 50; i++) {
      jobs.push(pay(w.ada, 'cy', 5));
      jobs.push(req('GET', '/statement?limit=50', { token: w.ada }));
      jobs.push(req('GET', `/me?as_of=${enc(seed[i % 60].created_at)}`, { token: w.bob }));
      if (i < 30) jobs.push(correct(i % 2 ? w.bob : w.ada, seed[i].payment_id, { expected_revision: 1, amount: 5 + i, effective_at: seed[i].created_at, reason: 'c' }));
    }
    const rs = await Promise.all(jobs);
    assert.ok(rs.every((r) => r.status < 500), rs.filter((r) => r.status >= 500).map((r) => r.text).join('|'));
    const again = await req('GET', `/statement?snapshot=${snap.snapshot}&limit=200`, { token: w.ada });
    assert.deepStrictEqual(again.json, frozen.json);
    const b = await bal(w);
    assert.strictEqual(b.ada + b.bob + b.cy, 3000000);
    for (const h of ['ada', 'bob', 'cy']) {
      const s = await stmt(w[h], '?limit=200');
      assert.strictEqual(s.closing_balance, (await me(w[h])).balance);
      assert.strictEqual(s.opening_balance + s.entries.reduce((a, e) => a + e.delta, 0), s.closing_balance);
    }
  });

  await test('a few thousand payments: statement and as_of reads stay fast under 50 concurrent requests', async () => {
    const w = await world(FX({ users: [U('ada', 100000000), U('bob', 100000000), U('cy', 100000000)] }));
    for (let batch = 0; batch < 20; batch++) await Promise.all(Array.from({ length: 150 }, (_, i) => pay(i % 2 ? w.bob : w.ada, i % 2 ? 'ada' : 'cy', 1 + i)));
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? req('GET', '/statement?limit=100&offset=500', { token: w.ada }) : req('GET', `/me?as_of=${enc(new Date(Date.now() - i * 1000).toISOString())}`, { token: w.ada }))));
    const ms = Date.now() - t0;
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','));
    assert.ok(ms < 5000, `50 concurrent reads took ${ms}ms`);
    const s = await stmt(w.ada, '?limit=200');
    assert.ok(s.entries.length === 200 && s.has_more);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`- ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('tests crashed', e);
  process.exit(2);
});
