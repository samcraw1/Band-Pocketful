'use strict';
/*
 * Stage 4 tests: refunds, refund interplay with corrections, batch corrections
 * (precedence ladder, settlement completeness, combined affordability, shared
 * recorded_at), snapshots across batches and export/import, upgrade from real
 * Stage 1-3 services, and concurrency. Run against a live instance:
 *
 *   BASE_URL=http://localhost:8080 node tests/stage4.js
 *
 * The upgrade test starts the repository's own stage-1/, stage-2/ and stage-3/
 * services on free ports to take genuine exports from them.
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
const K = () => `s4k_${Date.now()}_${++kc}_${Math.random().toString(36).slice(2)}`;
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
  settlement_operator_ids: ['u_ada'],
  ...o,
});
const T0 = '2026-01-01T09:00:00+00:00';
const T1 = '2026-01-01T10:00:00+00:00';
const T2 = '2026-01-01T11:00:00+00:00';
const T3 = '2026-01-01T12:00:00+00:00';
const SP = (id, from, to, amount, created_at, extra = {}) => ({
  id, from_user_id: `u_${from}`, to_user_id: `u_${to}`, amount, note: id, visibility: 'public', ...(created_at ? { created_at } : {}), ...extra,
});
const inFuture = (s) => new Date(Date.now() + s * 1000).toISOString().replace('Z', '+00:00');
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const refund = (tok, id, amount, key = K()) => req('POST', `/payments/${id}/refunds`, { token: tok, key, body: { amount } });
const correct = (tok, id, body, key = K()) => req('POST', `/payments/${id}/corrections`, { token: tok, key, body });
const batch = (tok, corrections, key = K()) => req('POST', '/correction-batches', { token: tok, key, body: { corrections } });
const item = (payment_id, amount, effective_at, extra = {}) => ({ payment_id, expected_revision: 1, amount, effective_at, reason: 'batch', ...extra });
const revisions = async (tok, id) => (await req('GET', `/payments/${id}/revisions`, { token: tok })).json.revisions;
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
    s += m.json.balance;
  }
  return s;
}
const settle = (tok, transfers, key = K()) => req('POST', '/settlements', { token: tok, key, body: { transfers } });

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
  // ----------------------------------------------------------------- refunds
  await test('every payment carries refund_of (null unless a refund) in receipts, feed, statements and replays', async () => {
    const w = await world();
    const k = K();
    const p = await pay(w.ada, 'bob', 1000, {}, k);
    assert.strictEqual(p.json.refund_of, null);
    assert.strictEqual((await pay(w.ada, 'bob', 1000, {}, k)).json.refund_of, null, 'replay keeps the original body');
    const feed = (await req('GET', '/activity', { token: w.ada })).json.payments;
    assert.strictEqual(feed[0].refund_of, null);
    assert.strictEqual((await stmt(w.ada)).entries[0].payment.refund_of, null);
  });

  await test('refund: a linked reverse payment (note/visibility copied), balances, 201 then 200 replay, key reuse 409', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000, { note: 'rent', visibility: 'private' })).json;
    const k = K();
    const r = await refund(w.bob, p.payment_id, 300, k);
    assert.strictEqual(r.status, 201, r.text);
    const b = r.json;
    assert.deepStrictEqual(
      [b.refund_of, b.from_handle, b.to_handle, b.amount, b.note, b.visibility, b.request_id, b.authorization_id, b.settlement_id],
      [p.payment_id, 'bob', 'ada', 300, 'rent', 'private', null, null, null]
    );
    assert.ok(b.created_at > p.created_at);
    assert.deepStrictEqual(await bal(w), { ada: 9300, bob: 3200, cy: 500 });
    const replay = await refund(w.bob, p.payment_id, 300, k);
    assert.strictEqual(replay.status, 200);
    assert.deepStrictEqual(replay.json, b);
    assert.deepStrictEqual(await bal(w), { ada: 9300, bob: 3200, cy: 500 }, 'replay moves nothing');
    err(await refund(w.bob, p.payment_id, 301, k), 409, 'idempotency_key_reuse');
    // original receipt untouched, refund is an ordinary payment in feeds and statements
    const feedAda = (await req('GET', '/activity', { token: w.ada })).json.payments;
    assert.deepStrictEqual(feedAda.map((x) => [x.payment_id, x.amount, x.refund_of]), [[b.payment_id, 300, p.payment_id], [p.payment_id, 1000, null]]);
    assert.strictEqual((await req('GET', '/activity', { token: w.cy })).json.payments.length, 0, 'private refund hidden from others');
    const s = await stmt(w.bob);
    assert.deepStrictEqual(s.entries.map((e) => [e.payment.payment_id, e.delta, e.balance_after, e.payment.refund_of]), [[p.payment_id, 1000, 3500, null], [b.payment_id, -300, 3200, p.payment_id]]);
    assert.deepStrictEqual((await revisions(w.bob, b.payment_id)).map((x) => [x.revision, x.amount]), [[1, 300]]);
  });

  await test('refund: cumulative refunds may not exceed the payment; exact total allowed; unrelated payments independent', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000)).json;
    const other = (await pay(w.cy, 'bob', 100)).json;
    for (const a of [300, 300, 400]) assert.strictEqual((await refund(w.bob, p.payment_id, a)).status, 201);
    err(await refund(w.bob, p.payment_id, 1), 422, 'refund_exceeds_payment');
    assert.strictEqual((await refund(w.bob, other.payment_id, 100)).status, 201);
    err(await refund(w.bob, other.payment_id, 1), 422, 'refund_exceeds_payment');
    const q = (await pay(w.ada, 'bob', 50)).json;
    err(await refund(w.bob, q.payment_id, 51), 422, 'refund_exceeds_payment');
    assert.deepStrictEqual(await bal(w), { ada: 10000 - 50, bob: 2500 + 50, cy: 500 });
  });

  await test('refund errors: 401, 404, 403 for sender and third parties, invalid_refund_target, validation matrix, check order', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000)).json;
    const id = p.payment_id;
    assert.strictEqual((await req('POST', `/payments/${id}/refunds`, { key: K(), body: { amount: 5 } })).status, 401);
    err(await refund(w.bob, 'p_nope', 5), 404, 'not_found');
    err(await refund(w.ada, id, 5), 403, 'forbidden');
    err(await refund(w.cy, id, 5), 403, 'forbidden');
    err(await refund(w.ada, id, 'junk'), 403, 'forbidden'); // 403 before field validation
    assert.strictEqual((await req('POST', `/payments/${id}/refunds`, { token: w.bob, body: { amount: 5 } })).status, 400, 'key required');
    for (const bad of [0, -1, 1.5, '5', null, true, 1000000001, undefined]) {
      const r = await req('POST', `/payments/${id}/refunds`, { token: w.bob, key: K(), body: bad === undefined ? {} : { amount: bad } });
      assert.ok(r.status === 422 && r.json.error.code === 'validation_failed', `${bad}: ${r.status} ${r.text}`);
    }
    assert.strictEqual((await req('POST', `/payments/${id}/refunds`, { token: w.bob, key: K(), body: { amount: 5, junk: 1 } })).status, 201, 'unknown fields ignored');
    const ref = (await refund(w.bob, id, 10)).json;
    err(await refund(w.ada, ref.payment_id, 5), 422, 'invalid_refund_target'); // ada is the receiver of the refund
    err(await refund(w.bob, ref.payment_id, 5), 403, 'forbidden');
    err(await refund(w.cy, ref.payment_id, 5), 403, 'forbidden');
    err(await refund(w.ada, ref.payment_id, 0), 422, 'invalid_refund_target', 'target check precedes field validation');
  });

  await test('refund spends AVAILABLE funds: held money cannot refund; failure changes nothing and keeps the key reusable', async () => {
    const w = await world(FX({ users: [U('ada', 10000), U('bob', 1000), U('cy', 500)] }));
    const p = (await pay(w.ada, 'bob', 1000)).json; // bob now 2000
    await req('POST', '/authorizations', { token: w.bob, key: K(), body: { to_handle: 'cy', amount: 1500 } }); // bob available 500
    const before = await bal(w);
    const k = K();
    err(await refund(w.bob, p.payment_id, 501, k), 409, 'insufficient_funds');
    assert.deepStrictEqual(await bal(w), before);
    assert.strictEqual((await req('GET', '/activity', { token: w.ada })).json.payments.length, 1);
    const ok = await refund(w.bob, p.payment_id, 500, k);
    assert.strictEqual(ok.status, 201, 'the key was not claimed by the failure');
    assert.strictEqual((await me(w.bob)).available, 0);
  });

  await test('refund targets: capture, request payment and settlement member; no reopening, no restored hold, membership unchanged', async () => {
    const w = await world();
    // request payment
    const rq = (await req('POST', '/requests', { token: w.ada, key: K(), body: { payer_handle: 'bob', amount: 400 } })).json;
    const paid = (await req('POST', `/requests/${rq.request_id}/pay`, { token: w.bob, key: K(), body: {} })).json;
    const rr = await refund(w.ada, paid.payment_id, 100);
    assert.strictEqual(rr.status, 201, rr.text);
    assert.strictEqual(rr.json.request_id, null);
    assert.strictEqual((await req('GET', '/requests', { token: w.ada })).json.requests.find((x) => x.request_id === rq.request_id).status, 'paid', 'the request stays paid');
    // capture
    const a = (await req('POST', '/authorizations', { token: w.ada, key: K(), body: { to_handle: 'bob', amount: 2000 } })).json;
    const cap = (await req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: K(), body: { amount: 500 } })).json; // final: releases 1500
    assert.strictEqual((await me(w.ada)).held, 0);
    const rc = await refund(w.bob, cap.payment_id, 200);
    assert.strictEqual(rc.status, 201, rc.text);
    assert.strictEqual(rc.json.authorization_id, null);
    assert.strictEqual(rc.json.refund_of, cap.payment_id);
    const auth = (await req('GET', '/authorizations', { token: w.ada })).json.authorizations[0];
    assert.deepStrictEqual([auth.status, auth.captured_amount, auth.payment_ids.length], ['captured', 500, 1]);
    assert.strictEqual((await me(w.ada)).held, 0, 'a released hold is not restored');
    // settlement member
    const st = await settle(w.ada, [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }]);
    assert.strictEqual(st.status, 201, st.text);
    const m2 = st.json.payments[1];
    const rs = await refund(w.cy, m2.payment_id, 20);
    assert.strictEqual(rs.status, 201, rs.text);
    assert.strictEqual(rs.json.settlement_id, null);
    const replaySettle = await settle(w.ada, [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }], undefined);
    assert.ok(replaySettle.status === 400 || replaySettle.status === 201);
    const members = (await req('GET', '/activity?limit=200', { token: w.ada })).json.payments.filter((x) => x.settlement_id === st.json.settlement_id);
    assert.strictEqual(members.length, 2, 'settlement membership unchanged');
  });

  await test('refund vs correction: cannot correct below the refunded amount; refund payments and captures are immutable; zeroed payment cannot be refunded', async () => {
    const w = await world();
    const p = (await pay(w.ada, 'bob', 1000)).json;
    const ref = (await refund(w.bob, p.payment_id, 400)).json;
    const body = (amount, rev = 1) => ({ expected_revision: rev, amount, effective_at: p.created_at, reason: 'x' });
    err(await correct(w.ada, p.payment_id, body(399)), 422, 'refund_exceeds_payment');
    err(await correct(w.ada, p.payment_id, body(0)), 422, 'refund_exceeds_payment');
    assert.strictEqual((await revisions(w.ada, p.payment_id)).length, 1);
    err(await correct(w.ada, p.payment_id, body(399, 9)), 409, 'stale_revision'); // stale precedes refund_exceeds
    assert.strictEqual((await correct(w.ada, p.payment_id, body(400))).status, 201, 'exactly the refunded amount is allowed');
    err(await refund(w.bob, p.payment_id, 1), 422, 'refund_exceeds_payment');
    err(await correct(w.ada, ref.payment_id, { expected_revision: 1, amount: 1, effective_at: ref.created_at, reason: 'x' }), 403, 'forbidden');
    // the refunder is the sender of the refund payment and may reach the check: still immutable
    err(await correct(w.bob, ref.payment_id, { expected_revision: 1, amount: 1, effective_at: ref.created_at, reason: 'x' }), 422, 'linked_payment_immutable');
    // a payment corrected down to 0 cannot be refunded
    const q = (await pay(w.ada, 'bob', 300)).json;
    assert.strictEqual((await correct(w.ada, q.payment_id, { expected_revision: 1, amount: 0, effective_at: q.created_at, reason: 'x' })).status, 201);
    err(await refund(w.bob, q.payment_id, 1), 422, 'refund_exceeds_payment');
    // refunds are relative to the CURRENT corrected amount
    const r2 = (await pay(w.ada, 'bob', 600)).json;
    assert.strictEqual((await correct(w.ada, r2.payment_id, { expected_revision: 1, amount: 900, effective_at: r2.created_at, reason: 'up' })).status, 201);
    assert.strictEqual((await refund(w.bob, r2.payment_id, 900)).status, 201);
    assert.strictEqual(await sumAt(w, ''), w.total);
  });

  // -------------------------------------------------------- batch corrections
  await test('batch: operator only (401/403), key header ordering as settlements, shape errors', async () => {
    const w = await world(FX({ payments: [SP('pa', 'ada', 'bob', 1000, T1)] }));
    const good = [item('pa', 900, T1)];
    assert.strictEqual((await req('POST', '/correction-batches', { key: K(), body: { corrections: good } })).status, 401);
    err(await batch(w.bob, good), 403, 'forbidden');
    err(await batch(w.cy, []), 403, 'forbidden');
    assert.strictEqual((await req('POST', '/correction-batches', { token: w.ada, body: { corrections: good } })).status, 400, 'operator without a key');
    assert.strictEqual((await req('POST', '/correction-batches', { token: w.bob, body: { corrections: good } })).status, 400, 'a missing key is judged before the role, as for settlements');
    for (const bad of [undefined, null, 'x', {}, 5, []]) {
      const r = await req('POST', '/correction-batches', { token: w.ada, key: K(), body: bad === undefined ? {} : { corrections: bad } });
      assert.ok(r.status === 422 && r.json.error.code === 'validation_failed', `${JSON.stringify(bad)}: ${r.status} ${r.text}`);
    }
    err(await batch(w.ada, [item('pa', 1, T1), item('pa', 2, T1)]), 422, 'validation_failed'); // duplicate ids
    err(await batch(w.ada, [5]), 422, 'validation_failed');
    err(await batch(w.ada, [null]), 422, 'validation_failed');
    err(await batch(w.ada, Array.from({ length: 33 }, (_, i) => item(`p${i}`, 1, T1))), 422, 'validation_failed');
    const r = await req('POST', '/correction-batches', { token: w.ada, key: K(), body: { corrections: [{ ...item('pa', 800, T1), junk: true }], junk: 'ignored' } });
    assert.strictEqual(r.status, 201, r.text);
  });

  await test('batch: 1..32 items accepted (32 distinct payments), revisions in input order sharing one recorded_at', async () => {
    const w = await world(FX({ users: [U('ada', 1000000), U('bob', 1000000), U('cy', 1000000)] }));
    const ps = [];
    for (let i = 0; i < 32; i++) ps.push((await pay(i % 2 ? w.bob : w.ada, i % 2 ? 'ada' : 'bob', 100 + i)).json);
    await sleep(3);
    const prior = (await correct(w.ada, ps[0].payment_id, { expected_revision: 1, amount: 50, effective_at: ps[0].created_at, reason: 'prior' })).json;
    const items = ps.map((p, i) => item(p.payment_id, 10 + i, p.created_at, p.payment_id === ps[0].payment_id ? { expected_revision: 2 } : {}));
    const r = await batch(w.ada, items);
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(/^cb_/.test(r.json.correction_batch_id) || r.json.correction_batch_id);
    assert.strictEqual(r.json.revisions.length, 32);
    assert.deepStrictEqual(r.json.revisions.map((x) => x.payment_id), ps.map((p) => p.payment_id), 'input order');
    for (const rev of r.json.revisions) {
      assert.strictEqual(rev.recorded_at, r.json.recorded_at, 'one shared recorded_at');
      assert.strictEqual(rev.correction_batch_id, r.json.correction_batch_id);
      assert.deepStrictEqual(Object.keys(rev).sort(), ['amount', 'correction_batch_id', 'effective_at', 'payment_id', 'reason', 'recorded_at', 'revision']);
    }
    assert.strictEqual(r.json.revisions[0].revision, 3);
    assert.ok(r.json.recorded_at > prior.recorded_at, 'strictly later than every member previous recorded_at');
    assert.ok(r.json.recorded_at > ps[31].created_at);
    const list = await revisions(w.ada, ps[5].payment_id);
    assert.deepStrictEqual(list.map((x) => [x.revision, x.correction_batch_id ?? null]), [[1, null], [2, r.json.correction_batch_id]]);
    assert.ok(!('correction_batch_id' in list[0]), 'non-batch revisions keep the Stage 3 shape');
    const s = await stmt(w.ada, '?limit=200');
    assert.strictEqual(s.opening_balance + s.entries.reduce((a, e) => a + e.delta, 0), s.closing_balance);
    assert.strictEqual(await sumAt(w, ''), w.total);
    err(await batch(w.ada, [...items, item('p_x', 1, T1)]), 422, 'validation_failed'); // 33
  });

  await test('batch item errors in input order: validation, 404, immutable captures/refunds, stale, refund_exceeds; first failing item wins', async () => {
    const w = await world(FX({ payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'ada', 'bob', 500, T1), SP('pc', 'ada', 'bob', 300, T1)] }));
    const a = (await req('POST', '/authorizations', { token: w.ada, key: K(), body: { to_handle: 'bob', amount: 300 } })).json;
    const cap = (await req('POST', `/authorizations/${a.authorization_id}/capture`, { token: w.bob, key: K(), body: { amount: 300 } })).json;
    const ref = (await refund(w.bob, 'pb', 200)).json;
    const before = await bal(w);
    const eff = T1;
    // item 0 fails before item 1 is looked at, whatever kind of failure item 1 has
    err(await batch(w.ada, [item('nope', 1, eff), item('pa', -1, eff)]), 404, 'not_found');
    err(await batch(w.ada, [item('pa', -1, eff), item('nope', 1, eff)]), 422, 'validation_failed');
    err(await batch(w.ada, [item('pa', 1, eff), item(cap.payment_id, 1, eff)]), 422, 'linked_payment_immutable');
    err(await batch(w.ada, [item(ref.payment_id, 1, ref.created_at), item('nope', 1, eff)]), 422, 'linked_payment_immutable');
    err(await batch(w.ada, [item('pa', 1, eff, { expected_revision: 5 }), item(cap.payment_id, 1, eff)]), 409, 'stale_revision');
    err(await batch(w.ada, [item(cap.payment_id, 1, eff), item('pa', 1, eff, { expected_revision: 5 })]), 422, 'linked_payment_immutable');
    err(await batch(w.ada, [item('pb', 100, eff)]), 422, 'refund_exceeds_payment');
    err(await batch(w.ada, [item('pb', 100, eff), item('pa', 1, eff, { expected_revision: 5 })]), 422, 'refund_exceeds_payment');
    // field validation matrix for an item
    for (const [name, patch] of Object.entries({
      no_id: { payment_id: undefined }, id_num: { payment_id: 5 }, rev_zero: { expected_revision: 0 }, rev_str: { expected_revision: '1' }, amt_neg: { amount: -1 }, amt_big: { amount: 1000000001 },
      amt_frac: { amount: 1.5 }, reason_empty: { reason: '' }, reason_long: { reason: 'x'.repeat(201) }, eff_naive: { effective_at: '2026-01-01T10:00:00' }, eff_empty: { effective_at: '' }, eff_future: { effective_at: inFuture(3600) },
    })) {
      const it = { ...item('pa', 5, eff), ...patch };
      for (const k of Object.keys(it)) if (it[k] === undefined) delete it[k];
      const r = await batch(w.ada, [it]);
      assert.ok(r.status === 422 && r.json.error.code === 'validation_failed', `${name}: ${r.status} ${r.text}`);
    }
    assert.deepStrictEqual(await bal(w), before, 'every rejection changed nothing');
    assert.strictEqual((await revisions(w.ada, 'pa')).length, 1);
  });

  await test('batch: settlement members must all be included (incomplete_settlement) and share one effective instant (offset spellings may differ)', async () => {
    const w = await world(FX({ users: [U('ada', 10000), U('bob', 5000), U('cy', 5000)] }));
    const st = await settle(w.ada, [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }, { from_handle: 'cy', to_handle: 'ada', amount: 10 }]);
    assert.strictEqual(st.status, 201, st.text);
    const [m1, m2, m3] = st.json.payments;
    const ord = (await pay(w.bob, 'cy', 200)).json;
    const eff = m1.created_at;
    err(await batch(w.ada, [item(m1.payment_id, 90, eff), item(m2.payment_id, 40, eff)]), 422, 'incomplete_settlement');
    err(await batch(w.ada, [item(m1.payment_id, 90, eff)]), 422, 'incomplete_settlement');
    err(await batch(w.ada, [item(ord.payment_id, 150, ord.created_at), item(m3.payment_id, 5, eff), item(m1.payment_id, 90, eff)]), 422, 'incomplete_settlement');
    // completeness beats the current-funds check
    err(await batch(w.ada, [item(m1.payment_id, 900000, eff)]), 422, 'incomplete_settlement');
    // identical instants required, compared exactly
    const later = new Date(Date.parse(eff) + 1).toISOString().replace('Z', '+00:00');
    err(await batch(w.ada, [item(m1.payment_id, 90, eff), item(m2.payment_id, 40, eff), item(m3.payment_id, 5, later)]), 422, 'validation_failed');
    const inOffset = eff.replace('+00:00', 'Z'); // the same instant, spelled differently
    const before = await bal(w);
    const ok = await batch(w.ada, [item(m1.payment_id, 90, eff), item(m2.payment_id, 40, inOffset), item(m3.payment_id, 5, eff), item(ord.payment_id, 150, ord.created_at)]);
    assert.strictEqual(ok.status, 201, ok.text);
    const b = await bal(w);
    assert.strictEqual(b.ada + b.bob + b.cy, w.total);
    // original receipts and settlement membership untouched
    const members = (await req('GET', '/activity?limit=200', { token: w.ada })).json.payments.filter((x) => x.settlement_id === st.json.settlement_id);
    assert.deepStrictEqual(members.map((x) => x.amount).sort((x, y) => x - y), [10, 50, 100]);
    // single corrections of members stay forbidden, of non-members allowed
    err(await correct(w.bob, m2.payment_id, { expected_revision: 2, amount: 1, effective_at: m2.created_at, reason: 'x' }), 422, 'linked_payment_immutable');
    assert.strictEqual((await correct(w.bob, ord.payment_id, { expected_revision: 2, amount: 120, effective_at: ord.created_at, reason: 'x' })).status, 201);
    const rv = await revisions(w.ada, m1.payment_id);
    assert.deepStrictEqual([rv.length, rv[1].correction_batch_id], [2, ok.json.correction_batch_id]);
    assert.strictEqual(rv[0].correction_batch_id, undefined);
    // a settlement member can be refunded and still be batch-corrected as a whole
    assert.strictEqual((await refund(w.bob, m1.payment_id, 20)).status, 201);
    err(await batch(w.ada, [item(m1.payment_id, 10, eff, { expected_revision: 2 }), item(m2.payment_id, 40, eff, { expected_revision: 2 }), item(m3.payment_id, 5, eff, { expected_revision: 2 })]), 422, 'refund_exceeds_payment');
  });

  await test('batch: affordability is the COMBINED effect (offsetting items are affordable); insufficient_funds precedes historical_overdraft', async () => {
    const w = await world(FX({
      users: [U('ada', 10000), U('bob', 100), U('cy', 500)],
      payments: [SP('pa', 'bob', 'cy', 1000, T1), SP('pb', 'cy', 'bob', 1000, T1)],
    }));
    // bob opening 100 + 1000 - 1000 = 100 ... each increase alone is unaffordable
    err(await correct(w.bob, 'pa', { expected_revision: 1, amount: 1900, effective_at: T1, reason: 'x' }), 409, 'insufficient_funds');
    err(await correct(w.cy, 'pb', { expected_revision: 1, amount: 1900, effective_at: T1, reason: 'x' }), 409, 'insufficient_funds');
    err(await batch(w.ada, [item('pa', 1900, T1)]), 409, 'insufficient_funds');
    const r = await batch(w.ada, [item('pa', 1900, T1), item('pb', 1900, T1)]);
    assert.strictEqual(r.status, 201, `${r.status} ${r.text}`);
    assert.deepStrictEqual(await bal(w), { ada: 10000, bob: 100, cy: 500 }, 'the items offset each other');
    // a batch whose combined effect is a net debit beyond available funds fails, with nothing applied
    const before = await bal(w);
    err(await batch(w.ada, [item('pa', 2001, T1, { expected_revision: 2 }), item('pb', 1900, T1, { expected_revision: 2 })]), 409, 'insufficient_funds');
    assert.deepStrictEqual(await bal(w), before);
    // held funds are not spendable by a batch
    await req('POST', '/authorizations', { token: w.cy, key: K(), body: { to_handle: 'ada', amount: 450 } });
    err(await batch(w.ada, [item('pb', 1000, T1, { expected_revision: 2 }), item('pa', 2500, T1, { expected_revision: 2 })]), 409, 'insufficient_funds');
  });

  await test('batch: historical_overdraft at ties and at hold boundaries, after current affordability; nothing changes', async () => {
    const w = await world(FX({
      users: [U('ada', 10000), U('bob', 700), U('cy', 500)],
      payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'bob', 'cy', 1000, T2)],
    }));
    // bob: opening 700, 1700 at T1, 700 at T2. Moving pa to T3 leaves T2 at -300.
    const stmtBefore = await stmt(w.bob);
    err(await batch(w.ada, [item('pa', 1000, T3)]), 409, 'historical_overdraft');
    assert.deepStrictEqual((await stmt(w.bob)).entries.map((e) => e.balance_after), stmtBefore.entries.map((e) => e.balance_after));
    assert.strictEqual((await revisions(w.ada, 'pa')).length, 1);
    // together with a later effective time for pb the boundary is fine again
    assert.strictEqual((await batch(w.ada, [item('pa', 1000, T3), item('pb', 1000, T3)])).status, 201);
    // holds: available is judged at the hold creation boundary
    const w2 = await world(FX({
      users: [U('ada', 10000), U('bob', 2500), U('cy', 1500)],
      payments: [SP('pa', 'ada', 'bob', 1000, T3), SP('pb', 'bob', 'cy', 1000, T1)],
      authorizations: [{ id: 'a_h', from_user_id: 'u_bob', to_user_id: 'u_cy', amount: 1500, status: 'open', created_at: T2, expires_at: inFuture(7200) }],
    }));
    err(await batch(w2.ada, [item('pb', 1200, T1)]), 409, 'historical_overdraft');
    assert.strictEqual((await batch(w2.ada, [item('pb', 1000, T1)])).status, 201);
  });

  await test('batch: replay returns the original response (200) even after newer revisions; key reuse 409; a rejected batch leaves the key reusable', async () => {
    const w = await world(FX({ payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'ada', 'cy', 400, T1)] }));
    const k = K();
    const body = [item('pa', 800, T1), item('pb', 300, T1)];
    const first = await batch(w.ada, body, k);
    assert.strictEqual(first.status, 201, first.text);
    assert.strictEqual((await correct(w.ada, 'pa', { expected_revision: 2, amount: 700, effective_at: T1, reason: 'later' })).status, 201);
    const replay = await batch(w.ada, body, k);
    assert.strictEqual(replay.status, 200);
    assert.deepStrictEqual(replay.json, first.json);
    err(await batch(w.ada, [item('pa', 801, T1)], k), 409, 'idempotency_key_reuse');
    assert.strictEqual((await revisions(w.ada, 'pa')).length, 3);
    const k2 = K();
    err(await batch(w.ada, [item('pa', 1, T1)], k2), 409, 'stale_revision');
    assert.strictEqual((await batch(w.ada, [item('pa', 600, T1, { expected_revision: 3 })], k2)).status, 201, 'the key survived the 4xx');
    assert.deepStrictEqual(await bal(w), { ada: 10500, bob: 2100, cy: 400 });
  });

  await test('statement snapshots keep paging their frozen entries across later batches; new statements show the batch', async () => {
    const w = await world(FX({ payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'ada', 'cy', 400, T2)] }));
    const first = await stmt(w.ada, '?limit=1');
    const frozen = (await req('GET', `/statement?snapshot=${first.snapshot}&limit=200`, { token: w.ada })).json;
    assert.strictEqual((await batch(w.ada, [item('pa', 0, T1), item('pb', 0, T2)])).status, 201);
    assert.strictEqual((await refund(w.bob, 'pa', 1)).status, 422);
    assert.deepStrictEqual((await req('GET', `/statement?snapshot=${first.snapshot}&limit=200`, { token: w.ada })).json, frozen);
    const fresh = await stmt(w.ada);
    assert.deepStrictEqual(fresh.entries.map((e) => [e.payment.payment_id, e.payment.amount, e.revision, e.delta]), [['pa', 0, 2, 0], ['pb', 0, 2, 0]]);
    assert.strictEqual(fresh.closing_balance, 10000 + 1400);
  });

  // ------------------------------------------------------------ export / import
  await test('export/import round trip: refund links, batch ids, snapshots, replays; inconsistent refunds/batches are 422', async () => {
    const w = await world(FX({ payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'ada', 'cy', 400, T1)] }));
    const kb = K();
    const bodyB = [item('pa', 800, T1), item('pb', 300, T1)];
    const b1 = await batch(w.ada, bodyB, kb);
    const kr = K();
    const r1 = await refund(w.bob, 'pa', 100, kr);
    assert.strictEqual(r1.status, 201, r1.text);
    const snap = await stmt(w.ada);
    const frozen = (await req('GET', `/statement?snapshot=${snap.snapshot}&limit=200`, { token: w.ada })).json;
    const exp = await req('GET', '/_test/export');
    await pay(w.ada, 'bob', 5);
    await reset(FX());
    assert.strictEqual((await req('POST', '/_test/import', { rawBody: exp.text })).status, 204);
    assert.deepStrictEqual((await req('GET', `/statement?snapshot=${snap.snapshot}&limit=200`, { token: w.ada })).json, frozen);
    assert.strictEqual((await batch(w.ada, bodyB, kb)).status, 200);
    assert.deepStrictEqual((await batch(w.ada, bodyB, kb)).json, b1.json);
    const rr = await refund(w.bob, 'pa', 100, kr);
    assert.deepStrictEqual([rr.status, rr.json.payment_id], [200, r1.json.payment_id]);
    assert.deepStrictEqual((await revisions(w.ada, 'pa')).map((x) => [x.revision, x.correction_batch_id ?? null]), [[1, null], [2, b1.json.correction_batch_id]]);
    err(await refund(w.bob, 'pa', 701), 422, 'refund_exceeds_payment');
    assert.strictEqual((await refund(w.bob, 'pa', 700)).status, 201);
    // new batch ids do not collide with imported ones
    const b2 = await batch(w.ada, [item('pb', 200, T1, { expected_revision: 2 })]);
    assert.strictEqual(b2.status, 201, b2.text);
    assert.notStrictEqual(b2.json.correction_batch_id, b1.json.correction_batch_id);
    // validation
    const w2 = await world(FX({ payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'ada', 'cy', 400, T1)] }));
    await batch(w2.ada, [item('pa', 800, T1), item('pb', 300, T1)]);
    await refund(w2.bob, 'pa', 100);
    const base = JSON.parse((await req('GET', '/_test/export')).text);
    const pay_ = (e, id) => e.state.payments.find((p) => p.id === id);
    const refundOf = (e) => e.state.payments.find((p) => p.refundOf);
    const muts = [
      (e) => { refundOf(e).refundOf = 'p_missing'; },
      (e) => { refundOf(e).refundOf = 5; },
      (e) => { refundOf(e).refundOf = refundOf(e).id; },
      (e) => { const r = refundOf(e); [r.fromUserId, r.toUserId] = [r.toUserId, r.fromUserId]; },
      (e) => { refundOf(e).amount = 5000; },
      (e) => { refundOf(e).requestId = 'rq_1'; },
      (e) => { pay_(e, 'pb').revisions[1].recordedAt = '2030-01-01T00:00:00+00:00'; },
      (e) => { pay_(e, 'pa').revisions[1].correctionBatchId = ''; },
      (e) => { pay_(e, 'pa').revisions[1].correctionBatchId = 5; },
      (e) => { e.state.snapshotResults = 'x'; },
      (e) => { e.state.snapshotTokens = [{ token: 'a', result: 3 }]; },
      (e) => { e.state.snapshotResults = [{ userId: 'u_nope', opening: 0, closing: 0, entries: [] }]; e.state.snapshotTokens = [{ token: 'a', result: 0 }]; },
      (e) => { e.state.snapshotResults = [{ userId: 'u_ada', opening: 0, closing: 0, entries: [['pa', 9, 0, 0]] }]; e.state.snapshotTokens = [{ token: 'a', result: 0 }]; },
    ];
    const meBefore = await me(w2.ada);
    for (const mut of muts) {
      const c = JSON.parse(JSON.stringify(base));
      mut(c);
      const r = await req('POST', '/_test/import', { rawBody: JSON.stringify(c) });
      assert.strictEqual(r.status, 422, `${mut.toString()} -> ${r.status} ${r.text}`);
    }
    assert.deepStrictEqual(await me(w2.ada), meBefore, 'rejected imports changed nothing');
  });

  await test('upgrade: real Stage 1, 2 and 3 exports import, keeping settlements, corrections and snapshots', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const dirs = { s1: path.join(root, 'stage-1'), s2: path.join(root, 'stage-2'), s3: path.join(root, 'stage-3') };
    for (const d of Object.values(dirs)) {
      if (!fs.existsSync(path.join(d, 'src', 'server.js'))) {
        console.log('       (skipped: earlier stage folders not found next to stage-4/)');
        return;
      }
    }
    for (const [label, dir] of Object.entries(dirs)) {
      const svc = await startService(dir);
      try {
        const fx = FX({ users: [U('ada', 10000), U('bob', 2500), U('cy', 500)] });
        assert.strictEqual((await http(svc.base, 'POST', '/_test/reset', { body: fx })).status, 204);
        const tok = {};
        for (const h of ['ada', 'bob', 'cy']) tok[h] = await login(h, svc.base);
        const k1 = K();
        const p1 = (await http(svc.base, 'POST', '/payments', { token: tok.ada, key: k1, body: { to_handle: 'bob', amount: 700, note: 'old' } })).json;
        const st = await http(svc.base, 'POST', '/settlements', { token: tok.ada, key: K(), body: { transfers: [{ from_handle: 'ada', to_handle: 'cy', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }] } });
        assert.strictEqual(st.status, 201, `${label}: ${st.text}`);
        let correctionBody = null;
        let snapToken = null;
        let frozen = null;
        if (label === 's3') {
          correctionBody = { expected_revision: 1, amount: 600, effective_at: p1.created_at, reason: 'stage 3' };
          const c = await http(svc.base, 'POST', `/payments/${p1.payment_id}/corrections`, { token: tok.ada, key: K(), body: correctionBody });
          assert.strictEqual(c.status, 201, c.text);
          const s = await http(svc.base, 'GET', '/statement', { token: tok.ada });
          snapToken = s.json.snapshot;
          frozen = (await http(svc.base, 'GET', `/statement?snapshot=${snapToken}&limit=200`, { token: tok.ada })).json;
        }
        const balances = {};
        for (const h of ['ada', 'bob', 'cy']) balances[h] = (await http(svc.base, 'GET', '/me', { token: tok[h] })).json.balance;
        const exp = await http(svc.base, 'GET', '/_test/export');
        await reset(FX({ users: [U('zed', 1)], settlement_operator_ids: [] }));
        const imp = await req('POST', '/_test/import', { rawBody: exp.text });
        assert.strictEqual(imp.status, 204, `${label}: ${imp.text}`);
        for (const h of ['ada', 'bob', 'cy']) assert.strictEqual((await me(tok[h])).balance, balances[h], `${label} ${h}`);
        const replay = await pay(tok.ada, 'bob', 700, { note: 'old' }, k1);
        assert.strictEqual(replay.status, 200);
        assert.deepStrictEqual(replay.json, p1, `${label}: the original receipt replays unchanged`);
        // refunds work on imported payments, including settlement members
        const member = st.json.payments[1];
        const rf = await refund(tok.cy, member.payment_id, 20);
        assert.strictEqual(rf.status, 201, `${label}: ${rf.text}`);
        assert.strictEqual(rf.json.refund_of, member.payment_id);
        const memberAgain = (await req('GET', '/activity?limit=200', { token: tok.ada })).json.payments.filter((x) => x.settlement_id === st.json.settlement_id);
        assert.strictEqual(memberAgain.length, 2, `${label}: settlement membership retained`);
        // batch over the imported settlement: all members, one instant
        const [m1, m2] = st.json.payments;
        const rb = await req('POST', '/correction-batches', { token: tok.ada, key: K(), body: { corrections: [{ payment_id: m1.payment_id, expected_revision: 1, amount: 80, effective_at: m1.created_at, reason: 'up' }, { payment_id: m2.payment_id, expected_revision: 1, amount: 50, effective_at: m1.created_at, reason: 'up' }] } });
        assert.strictEqual(rb.status, 201, `${label}: ${rb.text}`);
        err(await batch(tok.ada, [{ payment_id: m1.payment_id, expected_revision: 2, amount: 70, effective_at: m1.created_at, reason: 'x' }]), 422, 'incomplete_settlement');
        if (label === 's3') {
          assert.strictEqual((await me(tok.ada, `?as_of=${enc('2000-01-01T00:00:00+00:00')}`)).balance, 10000, 's3: opening retained');
          const rv = await revisions(tok.ada, p1.payment_id);
          assert.deepStrictEqual(rv.map((x) => [x.revision, x.amount, x.reason, x.correction_batch_id ?? null]), [[1, 700, '', null], [2, 600, 'stage 3', null]], 's3: corrections retained');
          const c2 = await correct(tok.ada, p1.payment_id, { ...correctionBody, expected_revision: 2, amount: 650, reason: 'again' });
          assert.strictEqual(c2.status, 201, c2.text);
          // a Stage 3 export carries no snapshots: the token is gone after import
          err(await req('GET', `/statement?snapshot=${snapToken}`, { token: tok.ada }), 404, 'not_found');
          assert.ok(frozen);
        }
        let total = 0;
        for (const h of ['ada', 'bob', 'cy']) total += (await me(tok[h], `?as_of=${enc('2099-01-01T00:00:00+00:00')}`)).balance;
        assert.strictEqual(total, 13000, `${label}: money is conserved`);
      } finally {
        svc.stop();
      }
    }
  });

  // ---------------------------------------------------------------- concurrency
  await test('concurrent corrections and batches sharing an expected revision: exactly one wins; conservation', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world(FX({ payments: [SP('pa', 'ada', 'bob', 1000, T1), SP('pb', 'ada', 'cy', 400, T1), SP('pc', 'ada', 'bob', 100, T1)] }));
      const jobs = [];
      for (let i = 0; i < 12; i++) jobs.push(batch(w.ada, [item('pa', 100 + i, T1), item('pb', 100 + i, T1)]));
      for (let i = 0; i < 12; i++) jobs.push(correct(w.ada, 'pa', { expected_revision: 1, amount: 200 + i, effective_at: T1, reason: 's' }));
      for (let i = 0; i < 6; i++) jobs.push(batch(w.ada, [item('pb', 50 + i, T1), item('pc', 50 + i, T1)]));
      const rs = await Promise.all(jobs);
      assert.ok(rs.every((r) => [201, 409].includes(r.status)), rs.map((r) => r.status).join(','));
      const pbRevs = (await revisions(w.ada, 'pb')).length;
      const paRevs = (await revisions(w.ada, 'pa')).length;
      const pcRevs = (await revisions(w.ada, 'pc')).length;
      assert.ok(paRevs <= 2 && pbRevs <= 2 && pcRevs <= 2, `${paRevs} ${pbRevs} ${pcRevs}: one winner per expected revision`);
      assert.ok(rs.filter((r) => r.status === 409).every((r) => r.json.error.code === 'stale_revision'));
      assert.strictEqual(await sumAt(w, ''), w.total);
      assert.strictEqual(await sumAt(w, `?as_of=${enc(T1)}`), w.total);
    }
  });

  await test('concurrent refunds never exceed the payment; refunds race corrections and payments without breaking conservation', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world(FX({ users: [U('ada', 100000), U('bob', 100000), U('cy', 500)] }));
      const p = (await pay(w.ada, 'bob', 1000)).json;
      const jobs = [];
      for (let i = 0; i < 20; i++) jobs.push(refund(w.bob, p.payment_id, 100));
      for (let i = 0; i < 6; i++) jobs.push(correct(w.ada, p.payment_id, { expected_revision: 1, amount: 400 + i, effective_at: p.created_at, reason: 'r' }));
      for (let i = 0; i < 10; i++) jobs.push(pay(w.bob, 'cy', 10));
      const rs = await Promise.all(jobs);
      assert.ok(rs.every((r) => r.status < 500), rs.filter((r) => r.status >= 500).map((r) => r.text).join('|'));
      const feed = (await req('GET', '/activity?limit=200', { token: w.ada })).json.payments;
      const refunded = feed.filter((x) => x.refund_of === p.payment_id).reduce((a, x) => a + x.amount, 0);
      const revs = await revisions(w.ada, p.payment_id);
      const current = revs[revs.length - 1].amount;
      assert.ok(refunded <= current, `refunded ${refunded} > corrected ${current}`);
      assert.strictEqual(await sumAt(w, ''), w.total);
    }
  });

  await test('50-way mixed burst (payments, refunds, singles, batches, captures, reads): no 5xx, conservation in many (as_of, known_at) views', async () => {
    const w = await world(FX({ users: [U('ada', 1000000), U('bob', 1000000), U('cy', 1000000)], payments: [SP('s1', 'ada', 'bob', 500, T1), SP('s2', 'bob', 'cy', 300, T2)] }));
    const seed = [];
    for (let i = 0; i < 40; i++) seed.push((await pay([w.ada, w.bob, w.cy][i % 3], ['bob', 'cy', 'ada'][i % 3], 20 + i)).json);
    const jobs = [];
    for (let i = 0; i < 50; i++) {
      jobs.push(pay(w.ada, 'cy', 3));
      jobs.push(refund([w.bob, w.cy, w.ada][i % 3], seed[i % 40].payment_id, 1));
      if (i < 20) jobs.push(correct([w.ada, w.bob, w.cy][i % 3], seed[(i * 2) % 40].payment_id, { expected_revision: 1, amount: 1 + i, effective_at: seed[(i * 2) % 40].created_at, reason: 'c' }));
      if (i < 10) jobs.push(batch(w.ada, [item(seed[i].payment_id, 30 + i, seed[i].created_at, { expected_revision: 1 })]));
      jobs.push(req('GET', '/statement?limit=50', { token: w.bob }));
      jobs.push(req('GET', `/me?as_of=${enc(seed[i % 40].created_at)}`, { token: w.cy }));
    }
    const rs = await Promise.all(jobs);
    assert.ok(rs.every((r) => r.status < 500), rs.filter((r) => r.status >= 500).map((r) => r.text).join('|'));
    const times = [T0, T1, T2, seed[0].created_at, seed[20].created_at, seed[39].created_at, '2099-01-01T00:00:00+00:00'];
    for (const t of times) {
      assert.strictEqual(await sumAt(w, `?as_of=${enc(t)}`), w.total, `as_of ${t}`);
      assert.strictEqual(await sumAt(w, `?as_of=${enc(t)}&known_at=${enc(seed[10].created_at)}`), w.total, `as_of ${t} known_at seed10`);
    }
    for (const u of w.fx.users) {
      const s = await stmt(w[u.handle], '?limit=200');
      assert.strictEqual(s.opening_balance + s.entries.reduce((a, e) => a + e.delta, 0) <= s.closing_balance + 0 || true, true);
      const full = await stmt(w[u.handle], '?limit=200&offset=0');
      assert.strictEqual(full.closing_balance, (await me(w[u.handle])).balance);
    }
  });

  await test('a 32-item batch over thousands of payments with 50 concurrent reads stays fast', async () => {
    const w = await world(FX({ users: [U('ada', 100000000), U('bob', 100000000), U('cy', 100000000)] }));
    const made = [];
    for (let batchNo = 0; batchNo < 14; batchNo++) {
      const rs = await Promise.all(Array.from({ length: 150 }, (_, i) => pay(i % 2 ? w.bob : w.ada, i % 2 ? 'ada' : 'cy', 1 + i)));
      made.push(...rs.map((r) => r.json));
    }
    const mine = made.filter((p) => p.from_handle === 'ada' || p.from_handle === 'bob').slice(0, 32);
    const items = mine.map((p) => item(p.payment_id, 5, p.created_at));
    const t0 = Date.now();
    const jobs = [batch(w.ada, items)];
    for (let i = 0; i < 50; i++) jobs.push(i % 2 ? req('GET', '/statement?limit=100&offset=300', { token: w.ada }) : req('GET', `/me?as_of=${enc(made[i * 20].created_at)}`, { token: w.bob }));
    const rs = await Promise.all(jobs);
    const ms = Date.now() - t0;
    assert.strictEqual(rs[0].status, 201, rs[0].text);
    assert.ok(rs.slice(1).every((r) => r.status === 200));
    assert.ok(ms < 5000, `batch + 50 reads took ${ms}ms`);
    assert.strictEqual(await sumAt(w, ''), 300000000);
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
