'use strict';
/*
 * Stage 2 API tests: holds/captures/void accounting, lazy expiry, idempotency
 * on the seven write paths, concurrency invariants, Stage 1 export upgrade
 * and content negotiation. Run against a live instance:
 *
 *   BASE_URL=http://localhost:8080 node tests/stage2.js
 */
const assert = require('assert');
const net = require('net');

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
    console.log(`FAIL - ${name}\n       ${String(e.message).split('\n').slice(0, 5).join('\n       ')}`);
  }
}

async function req(method, path, { token, body, rawBody, key, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  if (key !== undefined) h['Idempotency-Key'] = key;
  const res = await fetch(`${BASE_URL}${path}`, {
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

let kc = 0;
const K = () => `s2k_${Date.now()}_${++kc}_${Math.random().toString(36).slice(2)}`;
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
const inFuture = (s) => new Date(Date.now() + s * 1000).toISOString().replace('Z', '+00:00');

async function reset(fx) {
  const r = await req('POST', '/_test/reset', { body: fx });
  assert.strictEqual(r.status, 204, `reset: ${r.status} ${r.text}`);
}
async function login(h) {
  const r = await req('POST', '/auth/login', { body: { email: `${h}@example.com`, password: 'correct horse' } });
  assert.strictEqual(r.status, 200, `login ${h}: ${r.text}`);
  return r.json.token;
}
async function world(fx = FX()) {
  await reset(fx);
  const w = { fx, total: fx.users.reduce((s, u) => s + u.balance, 0) };
  for (const u of fx.users) w[u.handle] = await login(u.handle);
  return w;
}
const me = async (tok) => (await req('GET', '/me', { token: tok })).json;
async function checkInvariants(w) {
  let sum = 0;
  for (const u of w.fx.users) {
    const m = await me(w[u.handle]);
    assert.strictEqual(m.balance, m.total, 'balance == total');
    assert.ok(m.held >= 0 && m.available >= 0 && m.available <= m.total, `0<=available<=total ${JSON.stringify(m)}`);
    assert.strictEqual(m.available, m.total - m.held, 'available == total - held');
    sum += m.total;
  }
  assert.strictEqual(sum, w.total, `sum of totals ${sum} != ${w.total}`);
}
const err = (r, status, code) => {
  assert.strictEqual(r.status, status, `status ${r.status} ${r.text}`);
  assert.ok(r.json && r.json.error && r.json.error.code === code, `code ${r.text}`);
};
const auth = (token, to, amount, extra = {}) =>
  req('POST', '/authorizations', { token, key: K(), body: { to_handle: to, amount, ...extra } });
const capture = (token, id, body = {}, key = K()) =>
  req('POST', `/authorizations/${id}/capture`, { token, key, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await test('GET /me carries total/available/held; balance == total; no holds -> unchanged', async () => {
    const w = await world();
    const m = await me(w.ada);
    assert.deepStrictEqual([m.balance, m.total, m.available, m.held], [10000, 10000, 10000, 0]);
  });

  await test('seeded open hold reduces available, not total; expired/voided/captured hold nothing', async () => {
    const w = await world(
      FX({
        authorizations: [
          { id: 'a_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 2000, note: 'dep', visibility: 'public', status: 'open', expires_at: inFuture(7200) },
          { id: 'a_2', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1000, status: 'open', expires_at: inFuture(-7200) },
          { id: 'a_3', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1000, status: 'voided', expires_at: inFuture(7200) },
          { id: 'a_4', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 1000, status: 'captured', expires_at: inFuture(7200) },
        ],
      })
    );
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [10000, 2000, 8000]);
    const l = await req('GET', '/authorizations', { token: w.ada });
    assert.strictEqual(l.json.authorizations.find((a) => a.authorization_id === 'a_2').status, 'expired');
    assert.strictEqual(l.json.authorizations.find((a) => a.authorization_id === 'a_1').remaining_amount, 2000);
    const op = await req('GET', '/authorizations?status=open', { token: w.ada });
    assert.deepStrictEqual(op.json.authorizations.map((a) => a.authorization_id), ['a_1']);
  });

  await test('reset 422 when seeded unexpired open holds exceed balance, state unchanged', async () => {
    const w = await world();
    const bad = FX({
      authorizations: [
        { id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 400, status: 'open', expires_at: inFuture(7200) },
        { id: 'a_2', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 200, status: 'open', expires_at: inFuture(7200) },
      ],
    });
    err(await req('POST', '/_test/reset', { body: bad }), 422, 'validation_failed');
    assert.strictEqual((await me(w.ada)).total, 10000);
    // expired ones do not count toward the cap
    const ok = FX({
      authorizations: [{ id: 'a_1', from_user_id: 'u_cy', to_user_id: 'u_bob', amount: 9999, status: 'open', expires_at: inFuture(-7200) }],
    });
    assert.strictEqual((await req('POST', '/_test/reset', { body: ok })).status, 204);
  });

  await test('reset 422 for bad ttl / unknown user / bad status / bad expires_at', async () => {
    for (const bad of [
      FX({ authorization_ttl_seconds: 0 }),
      FX({ authorization_ttl_seconds: -5 }),
      FX({ authorization_ttl_seconds: 1.5 }),
      FX({ authorization_ttl_seconds: '60' }),
      FX({ authorizations: [{ id: 'a', from_user_id: 'u_zz', to_user_id: 'u_bob', amount: 5, status: 'open', expires_at: inFuture(7200) }] }),
      FX({ authorizations: [{ id: 'a', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 5, status: 'weird', expires_at: inFuture(7200) }] }),
      FX({ authorizations: [{ id: 'a', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 5, status: 'open', expires_at: 'nope' }] }),
    ]) {
      err(await req('POST', '/_test/reset', { body: bad }), 422, 'validation_failed');
    }
  });

  await test('create authorization: shape, hold reduces available, not in feed, validation', async () => {
    const w = await world();
    const r = await auth(w.ada, 'bob', 2000, { note: 'deposit', visibility: 'private' });
    assert.strictEqual(r.status, 201, r.text);
    const a = r.json;
    assert.deepStrictEqual(
      [a.status, a.amount, a.captured_amount, a.remaining_amount, a.payment_id, a.from_handle, a.to_handle, a.visibility, a.currency],
      ['open', 2000, 0, 2000, null, 'ada', 'bob', 'private', 'EUR']
    );
    assert.deepStrictEqual(a.payment_ids, []);
    assert.strictEqual(Date.parse(a.expires_at) - Date.parse(a.created_at), 600000);
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [10000, 2000, 8000]);
    assert.strictEqual((await me(w.bob)).total, 2500);
    const feed = await req('GET', '/activity', { token: w.ada });
    assert.strictEqual(JSON.stringify(feed.json).includes(a.authorization_id), false);
    err(await auth(w.ada, 'ada', 5), 422, 'self_payment');
    err(await auth(w.ada, 'nobody', 5), 404, 'not_found');
    for (const amount of [0, -1, 1.5, '5', 1000000001, null]) err(await auth(w.ada, 'bob', amount), 422, 'validation_failed');
    err(await auth(w.ada, 'bob', 5, { visibility: 'secret' }), 422, 'validation_failed');
    err(await auth(w.ada, 'bob', 5, { note: 'x'.repeat(201) }), 422, 'validation_failed');
    err(await auth(w.ada, 'bob', 8001), 409, 'insufficient_funds');
    assert.strictEqual((await auth(w.ada, 'bob', 8000)).status, 201);
    err(await auth(w.ada, 'bob', 1), 409, 'insufficient_funds');
    await checkInvariants(w);
  });

  await test('ttl from fixture drives expires_at', async () => {
    const w = await world(FX({ authorization_ttl_seconds: 90 }));
    const r = await auth(w.ada, 'bob', 100);
    assert.strictEqual(Date.parse(r.json.expires_at) - Date.parse(r.json.created_at), 90000);
  });

  await test('held funds cannot fund payments, request pay, settlements', async () => {
    const w = await world();
    await auth(w.ada, 'bob', 9000);
    err(await req('POST', '/payments', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 1001 } }), 409, 'insufficient_funds');
    assert.strictEqual((await req('POST', '/payments', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 1000 } })).status, 201);
    const rq = await req('POST', '/requests', { token: w.cy, key: K(), body: { payer_handle: 'ada', amount: 1 } });
    assert.strictEqual(rq.status, 201, rq.text);
    err(await req('POST', `/requests/${rq.json.request_id}/pay`, { token: w.ada, key: K(), body: {} }), 409, 'insufficient_funds');
    await checkInvariants(w);
  });

  await test('capture: default full capture, payment shape, feed, remainder released on partial final', async () => {
    const w = await world();
    const a = (await auth(w.ada, 'bob', 2000, { note: 'n1', visibility: 'public' })).json;
    err(await capture(w.ada, a.authorization_id), 403, 'forbidden');
    err(await capture(w.cy, a.authorization_id), 403, 'forbidden');
    err(await capture(w.bob, 'a_zzz'), 404, 'not_found');
    const c = await capture(w.bob, a.authorization_id, { amount: 1500 });
    assert.strictEqual(c.status, 201, c.text);
    assert.deepStrictEqual(
      [c.json.amount, c.json.authorization_id, c.json.request_id, c.json.note, c.json.visibility, c.json.from_handle, c.json.to_handle],
      [1500, a.authorization_id, null, 'n1', 'public', 'ada', 'bob']
    );
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [8500, 0, 8500]);
    assert.strictEqual((await me(w.bob)).total, 4000);
    const got = (await req('GET', '/authorizations', { token: w.bob })).json.authorizations[0];
    assert.deepStrictEqual([got.status, got.captured_amount, got.remaining_amount, got.payment_id], ['captured', 1500, 0, c.json.payment_id]);
    assert.deepStrictEqual(got.payment_ids, [c.json.payment_id]);
    const feed = (await req('GET', '/activity', { token: w.cy })).json;
    assert.ok(JSON.stringify(feed).includes(c.json.payment_id), 'public capture in feed');
    err(await capture(w.bob, a.authorization_id, { amount: 1 }), 409, 'authorization_not_open');
    await checkInvariants(w);
  });

  await test('capture on a payment created outside an authorization carries authorization_id null everywhere', async () => {
    const w = await world();
    const p = await req('POST', '/payments', { token: w.ada, key: K(), body: { to_handle: 'bob', amount: 10 } });
    assert.strictEqual(p.json.authorization_id, null);
    const feed = (await req('GET', '/activity', { token: w.ada })).json;
    assert.ok(JSON.stringify(feed).includes('"authorization_id":null'));
  });

  await test('extended capture: non-final keeps remainder held; full remainder closes; exceeds -> 422', async () => {
    const w = await world();
    const a = (await auth(w.ada, 'bob', 2000)).json;
    const id = a.authorization_id;
    const c1 = await capture(w.bob, id, { amount: 700, final: false });
    assert.strictEqual(c1.status, 201, c1.text);
    let m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [9300, 1300, 8000]);
    let cur = (await req('GET', '/authorizations?status=open', { token: w.bob })).json.authorizations[0];
    assert.deepStrictEqual([cur.status, cur.captured_amount, cur.remaining_amount, cur.payment_id], ['open', 700, 1300, c1.json.payment_id]);
    err(await capture(w.bob, id, { amount: 1301, final: false }), 422, 'capture_exceeds_authorization');
    const c2 = await capture(w.bob, id, { amount: 500, final: false });
    assert.strictEqual(c2.status, 201);
    const c3 = await capture(w.bob, id, { final: false }); // default = remainder (800) -> closes
    assert.strictEqual(c3.json.amount, 800);
    cur = (await req('GET', '/authorizations?status=captured', { token: w.bob })).json.authorizations[0];
    assert.deepStrictEqual([cur.status, cur.captured_amount, cur.remaining_amount], ['captured', 2000, 0]);
    assert.deepStrictEqual(cur.payment_ids, [c1.json.payment_id, c2.json.payment_id, c3.json.payment_id]);
    assert.strictEqual(cur.payment_id, c3.json.payment_id);
    m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [8000, 0, 8000]);
    err(await capture(w.bob, id, { amount: 1 }), 409, 'authorization_not_open');
    await checkInvariants(w);
  });

  await test('partial final capture after non-final releases only the remainder', async () => {
    const w = await world();
    const id = (await auth(w.ada, 'bob', 2000)).json.authorization_id;
    await capture(w.bob, id, { amount: 500, final: false });
    const c = await capture(w.bob, id, { amount: 100 }); // final default true
    assert.strictEqual(c.status, 201);
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [9400, 0, 9400]);
    await checkInvariants(w);
  });

  await test('capture validation: amount rules 422, final type 400, spends reserved money at available 0', async () => {
    const w = await world();
    const id = (await auth(w.ada, 'bob', 10000)).json.authorization_id; // available now 0
    assert.strictEqual((await me(w.ada)).available, 0);
    for (const amount of [0, -3, 1.5, '5', null]) err(await capture(w.bob, id, { amount }), 422, 'validation_failed');
    err(await capture(w.bob, id, { amount: 10001 }), 422, 'capture_exceeds_authorization');
    err(await capture(w.bob, id, { amount: 5, final: 'yes' }), 400, 'malformed_request');
    const c = await capture(w.bob, id, { amount: 4000, final: false });
    assert.strictEqual(c.status, 201, c.text);
    assert.strictEqual((await capture(w.bob, id, {})).status, 201);
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [0, 0, 0]);
    await checkInvariants(w);
  });

  await test('capture idempotency: replay 201 same payment, one money move; {} vs {amount} reuse -> 409', async () => {
    const w = await world();
    const id = (await auth(w.ada, 'bob', 2000)).json.authorization_id;
    const k = K();
    const c1 = await capture(w.bob, id, { amount: 1000, final: false }, k);
    const c2 = await capture(w.bob, id, { amount: 1000, final: false }, k);
    assert.strictEqual(c2.status, 200);
    assert.strictEqual(c2.json.payment_id, c1.json.payment_id);
    assert.strictEqual((await me(w.bob)).total, 3500);
    err(await capture(w.bob, id, { amount: 999, final: false }, k), 409, 'idempotency_key_reuse');
    const k2 = K();
    const full = await capture(w.bob, id, {}, k2);
    assert.strictEqual(full.status, 201);
    err(await capture(w.bob, id, { amount: 1000 }, k2), 409, 'idempotency_key_reuse');
    const replay = await capture(w.bob, id, {}, k2); // closed now, replay still returns original
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.json.payment_id, full.json.payment_id);
    assert.strictEqual((await me(w.bob)).total, 4500);
    // missing key
    const nk = await req('POST', `/authorizations/${id}/capture`, { token: w.bob, body: {} });
    assert.strictEqual(nk.status, 400);
    await checkInvariants(w);
  });

  await test('create idempotency: replay returns the same authorization, one hold; reuse w/ other body 409', async () => {
    const w = await world();
    const k = K();
    const body = { to_handle: 'bob', amount: 3000 };
    const a1 = await req('POST', '/authorizations', { token: w.ada, key: k, body });
    const a2 = await req('POST', '/authorizations', { token: w.ada, key: k, body });
    assert.strictEqual(a2.json.authorization_id, a1.json.authorization_id);
    assert.strictEqual((await me(w.ada)).held, 3000);
    err(await req('POST', '/authorizations', { token: w.ada, key: k, body: { ...body, amount: 3001 } }), 409, 'idempotency_key_reuse');
    // same key on another user / another path is independent
    const b = await req('POST', '/authorizations', { token: w.bob, key: k, body: { to_handle: 'ada', amount: 10 } });
    assert.strictEqual(b.status, 201);
    const p = await req('POST', '/payments', { token: w.ada, key: k, body: { to_handle: 'bob', amount: 5 } });
    assert.strictEqual(p.status, 201);
  });

  await test('void: payer only, idempotent state, releases remainder only, keeps captures', async () => {
    const w = await world();
    const id = (await auth(w.ada, 'bob', 2000)).json.authorization_id;
    err(await req('POST', `/authorizations/${id}/void`, { token: w.bob }), 403, 'forbidden');
    err(await req('POST', `/authorizations/${id}/void`, { token: w.cy }), 403, 'forbidden');
    err(await req('POST', '/authorizations/a_nope/void', { token: w.ada }), 404, 'not_found');
    const c = await capture(w.bob, id, { amount: 600, final: false });
    const v = await req('POST', `/authorizations/${id}/void`, { token: w.ada });
    assert.strictEqual(v.status, 200, v.text);
    assert.deepStrictEqual([v.json.status, v.json.captured_amount, v.json.remaining_amount], ['voided', 600, 0]);
    assert.deepStrictEqual(v.json.payment_ids, [c.json.payment_id]);
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [9400, 0, 9400]);
    const v2 = await req('POST', `/authorizations/${id}/void`, { token: w.ada });
    assert.strictEqual(v2.status, 200);
    assert.strictEqual(v2.json.status, 'voided');
    err(await capture(w.bob, id, { amount: 1 }), 409, 'authorization_not_open');
    const id2 = (await auth(w.ada, 'bob', 100)).json.authorization_id;
    await capture(w.bob, id2, {});
    err(await req('POST', `/authorizations/${id2}/void`, { token: w.ada }), 409, 'authorization_not_open');
    await checkInvariants(w);
  });

  await test('lazy expiry: clock-true on every read and write; remainder back in available; partial captures preserved', async () => {
    const w = await world(FX({ authorization_ttl_seconds: 1 }));
    const id = (await auth(w.ada, 'bob', 3000)).json.authorization_id;
    await capture(w.bob, id, { amount: 1000, final: false });
    assert.deepStrictEqual([(await me(w.ada)).held, (await me(w.ada)).available], [2000, 7000]);
    await sleep(1300);
    // the first thing to touch the clock is a WRITE (a payment that needs the released funds)
    const p = await req('POST', '/payments', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 9000 } });
    assert.strictEqual(p.status, 201, p.text);
    const l = (await req('GET', '/authorizations?status=expired', { token: w.ada })).json.authorizations;
    assert.deepStrictEqual([l.length, l[0].status, l[0].captured_amount, l[0].remaining_amount], [1, 'expired', 1000, 0]);
    assert.strictEqual((await req('GET', '/authorizations?status=open', { token: w.ada })).json.authorizations.length, 0);
    err(await capture(w.bob, id, { amount: 1 }), 409, 'authorization_expired');
    err(await req('POST', `/authorizations/${id}/void`, { token: w.ada }), 409, 'authorization_not_open');
    await checkInvariants(w);
  });

  await test('expiry seen by GET /me alone and by a capture attempt as the first touch', async () => {
    const w = await world(FX({ authorization_ttl_seconds: 1 }));
    await auth(w.ada, 'bob', 4000);
    assert.strictEqual((await me(w.ada)).available, 6000);
    await sleep(1300);
    assert.deepStrictEqual([(await me(w.ada)).held, (await me(w.ada)).available], [0, 10000]);
    const w2 = await world(FX({ authorization_ttl_seconds: 1 }));
    const id = (await auth(w2.ada, 'bob', 4000)).json.authorization_id;
    await sleep(1300);
    err(await capture(w2.bob, id, {}), 409, 'authorization_expired');
  });

  await test('GET /authorizations: party-only, direction, status, order, pagination, validation', async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await auth(w.ada, 'bob', 100 + i)).json.authorization_id);
    ids.push((await auth(w.bob, 'ada', 50)).json.authorization_id);
    const cyList = (await req('GET', '/authorizations', { token: w.cy })).json;
    assert.deepStrictEqual(cyList.authorizations, []);
    assert.strictEqual(cyList.has_more, false);
    const all = (await req('GET', '/authorizations', { token: w.ada })).json.authorizations.map((a) => a.authorization_id);
    assert.deepStrictEqual(all, [...ids].reverse());
    assert.strictEqual((await req('GET', '/authorizations?direction=outgoing', { token: w.ada })).json.authorizations.length, 5);
    assert.strictEqual((await req('GET', '/authorizations?direction=incoming', { token: w.ada })).json.authorizations.length, 1);
    const pg = (await req('GET', '/authorizations?limit=2&offset=1', { token: w.ada })).json;
    assert.deepStrictEqual(pg.authorizations.map((a) => a.authorization_id), [ids[4], ids[3]]);
    assert.strictEqual(pg.has_more, true);
    const last = (await req('GET', '/authorizations?limit=2&offset=4', { token: w.ada })).json;
    assert.strictEqual(last.has_more, false);
    for (const q of ['limit=0', 'limit=201', 'limit=x', 'offset=-1', 'direction=sideways', 'status=pending']) {
      err(await req('GET', `/authorizations?${q}`, { token: w.ada }), 422, 'validation_failed');
    }
    assert.strictEqual((await req('GET', '/authorizations')).status, 401);
  });

  await test('settlement net debits respect held funds', async () => {
    const w = await world();
    await auth(w.ada, 'cy', 9500);
    const s = await req('POST', '/settlements', {
      token: w.ada,
      key: K(),
      body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 600 }] },
    });
    // 'ada' is not a settlement operator unless fixture says so; either 403 or 409 is acceptable, never 201
    assert.notStrictEqual(s.status, 201);
    await checkInvariants(w);
  });

  await test('settlement with operator: debit beyond available -> 409, within available -> 201', async () => {
    const fx = FX({ settlement_operator_ids: ['u_ada'] });
    const w = await world(fx);
    await auth(w.ada, 'cy', 9500);
    const bad = await req('POST', '/settlements', {
      token: w.ada,
      key: K(),
      body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 600 }] },
    });
    assert.ok([409, 422].includes(bad.status), `${bad.status} ${bad.text}`);
    if (bad.status === 409) assert.strictEqual(bad.json.error.code, 'insufficient_funds');
    await checkInvariants(w);
  });

  await test('concurrent captures of one authorization never exceed the authorized amount', async () => {
    const w = await world();
    const id = (await auth(w.ada, 'bob', 1000)).json.authorization_id;
    const rs = await Promise.all(Array.from({ length: 30 }, () => capture(w.bob, id, { amount: 100, final: false })));
    const ok = rs.filter((r) => r.status === 201).length;
    assert.strictEqual(ok, 10, `${ok} captures succeeded`);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => [409, 422].includes(r.status)));
    assert.strictEqual((await me(w.bob)).total, 3500);
    await checkInvariants(w);
  });

  await test('concurrent capture vs void vs pay: invariants hold, closed hold never re-captured', async () => {
    for (let round = 0; round < 8; round++) {
      const w = await world();
      const id = (await auth(w.ada, 'bob', 6000)).json.authorization_id;
      const jobs = [];
      for (let i = 0; i < 6; i++) jobs.push(capture(w.bob, id, { amount: 2500, final: false }));
      jobs.push(req('POST', `/authorizations/${id}/void`, { token: w.ada }));
      for (let i = 0; i < 6; i++) jobs.push(req('POST', '/payments', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 1000 } }));
      const rs = await Promise.all(jobs);
      assert.ok(rs.every((r) => r.status < 500));
      const a = (await req('GET', '/authorizations', { token: w.ada })).json.authorizations[0];
      assert.ok(a.captured_amount <= 6000);
      assert.strictEqual(a.captured_amount % 2500, 0);
      assert.strictEqual(a.remaining_amount, 0, 'void or full capture closes it');
      await checkInvariants(w);
    }
  });

  await test('concurrent authorization creates cannot oversubscribe available', async () => {
    const w = await world();
    const rs = await Promise.all(Array.from({ length: 25 }, () => auth(w.ada, 'bob', 1500)));
    assert.strictEqual(rs.filter((r) => r.status === 201).length, 6);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409));
    const m = await me(w.ada);
    assert.deepStrictEqual([m.held, m.available], [9000, 1000]);
    await checkInvariants(w);
  });

  await test('same-key concurrent capture replays move money once', async () => {
    const w = await world();
    const id = (await auth(w.ada, 'bob', 2000)).json.authorization_id;
    const k = K();
    const rs = await Promise.all(Array.from({ length: 20 }, () => capture(w.bob, id, { amount: 700, final: false }, k)));
    assert.ok(rs.every((r) => r.status === 201 || r.status === 200), JSON.stringify(rs.map((r) => r.status)));
    assert.strictEqual(new Set(rs.filter((r) => r.status === 201 || r.status === 200).map((r) => r.json.payment_id)).size, 1);
    assert.strictEqual((await me(w.bob)).total, 3200);
    await checkInvariants(w);
  });

  await test('export/import round trip keeps holds, captures, ttl, idempotency records, tokens', async () => {
    const w = await world(FX({ authorization_ttl_seconds: 120 }));
    const id = (await auth(w.ada, 'bob', 2000)).json.authorization_id;
    const k = K();
    const c = await capture(w.bob, id, { amount: 500, final: false }, k);
    const exp = await req('GET', '/_test/export');
    assert.strictEqual(exp.status, 200);
    await req('POST', '/payments', { token: w.ada, key: K(), body: { to_handle: 'cy', amount: 100 } });
    const imp = await req('POST', '/_test/import', { rawBody: exp.text });
    assert.strictEqual(imp.status, 204, imp.text);
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [9500, 1500, 8000]);
    const replay = await capture(w.bob, id, { amount: 500, final: false }, k);
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.json.payment_id, c.json.payment_id);
    const a2 = (await auth(w.ada, 'bob', 10)).json;
    assert.strictEqual(Date.parse(a2.expires_at) - Date.parse(a2.created_at), 120000);
    await checkInvariants(w);
  });

  await test('import of a malformed authorizations section -> 422 and destination unchanged', async () => {
    const w = await world();
    await auth(w.ada, 'bob', 1000);
    const exp = JSON.parse((await req('GET', '/_test/export')).text);
    const mutations = [
      (e) => { e.authorizations = 'x'; },
      (e) => { e.authorizations[0].fromUserId = 'u_nope'; },
      (e) => { e.authorizations[0].status = 'weird'; },
      (e) => { e.authorizations[0].capturedAmount = 99999; },
      (e) => { e.authorizations[0].expiresAt = 'nope'; },
      (e) => { e.authorizations.push({ ...e.authorizations[0] }); },
      (e) => { e.authorizationTtlSeconds = -1; },
      (e) => { e.authorizations[0].paymentIds = ['p_missing']; },
    ];
    for (const mut of mutations) {
      const copy = JSON.parse(JSON.stringify(exp));
      mut(copy.state);
      const r = await req('POST', '/_test/import', { rawBody: JSON.stringify(copy) });
      assert.strictEqual(r.status, 422, `${r.status} ${r.text}`);
      assert.strictEqual((await me(w.ada)).held, 1000);
    }
  });

  await test('import mirrors reset: unexpired open holds beyond a wallet total -> 422, destination unchanged', async () => {
    const w = await world();
    await auth(w.ada, 'bob', 1000);
    const exp = JSON.parse((await req('GET', '/_test/export')).text);
    const bad = JSON.parse(JSON.stringify(exp));
    bad.state.users.find((u) => u.id === 'u_ada').balance = 10;
    err(await req('POST', '/_test/import', { rawBody: JSON.stringify(bad) }), 422, 'validation_failed');
    const bad2 = JSON.parse(JSON.stringify(exp));
    bad2.state.authorizations[0].amount = 99999999;
    err(await req('POST', '/_test/import', { rawBody: JSON.stringify(bad2) }), 422, 'validation_failed');
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [10000, 1000, 9000]);
  });

  await test('import still accepts valid exports: hold == total, expired/closed holds above total, partial captures', async () => {
    const w = await world();
    const full = (await auth(w.cy, 'bob', 500)).json; // hold equal to the whole wallet
    const part = (await auth(w.ada, 'bob', 2000)).json;
    await capture(w.bob, part.authorization_id, { amount: 500, final: false });
    const exp = JSON.parse((await req('GET', '/_test/export')).text);
    assert.strictEqual((await req('POST', '/_test/import', { rawBody: JSON.stringify(exp) })).status, 204);
    const ok = JSON.parse(JSON.stringify(exp));
    const a = ok.state.authorizations.find((x) => x.id === full.authorization_id);
    a.status = 'voided';
    a.amount = 99999999; // closed holds are not constrained
    assert.strictEqual((await req('POST', '/_test/import', { rawBody: JSON.stringify(ok) })).status, 204);
    const ex = JSON.parse(JSON.stringify(exp));
    const b = ex.state.authorizations.find((x) => x.id === full.authorization_id);
    b.amount = 99999999;
    b.expiresAt = inFuture(-7200); // expired by the clock: holds nothing
    assert.strictEqual((await req('POST', '/_test/import', { rawBody: JSON.stringify(ex) })).status, 204);
    const m = await me(w.cy);
    assert.deepStrictEqual([m.held, m.available], [0, 500]);
  });

  await test('expiry is judged when the capture mutates state: a slow body that completes after expires_at -> 409', async () => {
    const w = await world(FX({ authorization_ttl_seconds: 2 }));
    const a = (await auth(w.ada, 'bob', 100)).json;
    const body = JSON.stringify({ amount: 100 });
    const head = `POST /authorizations/${a.authorization_id}/capture HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.bob}\r\nIdempotency-Key: ${K()}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`;
    const u = new URL(BASE_URL);
    const sock = net.connect(Number(u.port || 80), u.hostname);
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));
    let resp = '';
    sock.on('data', (d) => { resp += d; });
    await sleep(1700);
    sock.write(head + body.slice(0, 3)); // headers arrive before expires_at
    await sleep(700); // ...now past it
    sock.write(body.slice(3));
    await sleep(300);
    sock.end();
    assert.ok(resp.startsWith('HTTP/1.1 409'), resp.split('\r\n')[0]);
    assert.ok(resp.includes('authorization_expired'), resp);
    assert.strictEqual((await me(w.bob)).total, 2500);
    await checkInvariants(w);
  });

  await test('Stage 1 export (no authorizations/ttl/counters) imports; lost-response retry replays after import', async () => {
    const w = await world();
    const k = K();
    const body = { to_handle: 'bob', amount: 700 };
    const p1 = await req('POST', '/payments', { token: w.ada, key: k, body });
    const exp = JSON.parse((await req('GET', '/_test/export')).text);
    delete exp.state.authorizations;
    delete exp.state.authorizationTtlSeconds;
    delete exp.state.counters.authorization;
    for (const p of exp.state.payments) delete p.authorizationId;
    const imp = await req('POST', '/_test/import', { rawBody: JSON.stringify(exp) });
    assert.strictEqual(imp.status, 204, imp.text);
    const replay = await req('POST', '/payments', { token: w.ada, key: k, body });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.json.payment_id, p1.json.payment_id);
    assert.strictEqual(replay.json.authorization_id, null);
    const m = await me(w.ada);
    assert.deepStrictEqual([m.total, m.held, m.available], [9300, 0, 9300]);
    const a = await auth(w.ada, 'bob', 100);
    assert.strictEqual(Date.parse(a.json.expires_at) - Date.parse(a.json.created_at), 600000);
  });

  await test('generated authorization ids never collide with seeded ids', async () => {
    const w = await world(
      FX({
        authorizations: [
          { id: 'a_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 10, status: 'captured', expires_at: inFuture(7200) },
          { id: 'a_2', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 10, status: 'voided', expires_at: inFuture(7200) },
          { id: 'a_7', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 10, status: 'voided', expires_at: inFuture(7200) },
        ],
      })
    );
    const ids = new Set(['a_1', 'a_2', 'a_7']);
    for (let i = 0; i < 12; i++) {
      const id = (await auth(w.ada, 'bob', 1)).json.authorization_id;
      assert.ok(!ids.has(id), `collision ${id}`);
      ids.add(id);
    }
  });

  await test('content negotiation: HTML for text/html, JSON otherwise; routes serve the app', async () => {
    const w = await world();
    for (const p of ['/', '/split', '/signup', '/login', '/requests', '/authorizations']) {
      const r = await req('GET', p, { headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } });
      assert.strictEqual(r.status, 200, p);
      assert.ok((r.headers.get('content-type') || '').startsWith('text/html'), p);
    }
    for (const p of ['/requests', '/authorizations']) {
      const j = await req('GET', p, { token: w.ada, headers: { Accept: 'application/json' } });
      assert.ok((j.headers.get('content-type') || '').includes('json'), p);
      const bare = await req('GET', p, { token: w.ada });
      assert.ok((bare.headers.get('content-type') || '').includes('json'), p);
      const anyAccept = await req('GET', p, { token: w.ada, headers: { Accept: '*/*' } });
      assert.ok((anyAccept.headers.get('content-type') || '').includes('json'), p);
      assert.strictEqual((await req('GET', p)).status, 401);
    }
  });

  await test('HTML shell has no external resource references', async () => {
    const r = await req('GET', '/', { headers: { Accept: 'text/html' } });
    assert.ok(!/(src|href)=["']https?:\/\//i.test(r.text), 'external src/href');
    assert.ok(!/url\(\s*["']?https?:/i.test(r.text), 'external css url()');
    assert.ok(!/@import/i.test(r.text), '@import');
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
