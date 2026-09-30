'use strict';
/*
 * Author's own Stage 1 tests: concurrency bursts, idempotency replay/reuse
 * matrix, conservation, and export/import round trips including replay
 * after import. Run against a live instance:
 *
 *   BASE_URL=http://localhost:8080 node tests/run.js
 */
const assert = require('assert');

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
    failures.push({ name, error: e });
    console.log(`FAIL - ${name}`);
    console.log(`       ${e.message}`);
  }
}

async function req(method, path, { token, body, key, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (key !== undefined) h['Idempotency-Key'] = key;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  return { status: res.status, json };
}

function newKey() {
  return `k_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function fixture(overrides = {}) {
  return {
    currency: 'EUR',
    minor_units: 2,
    users: [
      { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada', handle: 'ada', balance: 10000 },
      { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob', handle: 'bob', balance: 2500 },
      { id: 'u_cy', email: 'cy@example.com', password: 'correct horse', display_name: 'Cy', handle: 'cy', balance: 500 },
    ],
    payments: [],
    requests: [],
    ...overrides,
  };
}

async function resetTo(fx) {
  const r = await req('POST', '/_test/reset', { body: fx });
  assert.strictEqual(r.status, 204, `reset failed: ${JSON.stringify(r.json)}`);
}

async function login(email, password) {
  const r = await req('POST', '/auth/login', { body: { email, password } });
  assert.strictEqual(r.status, 200, `login failed: ${JSON.stringify(r.json)}`);
  return r.json.token;
}

async function meBalance(token) {
  const r = await req('GET', '/me', { token });
  return r.json.balance;
}

async function conservationHolds(fx, tokens) {
  const seeded = fx.users.reduce((s, u) => s + u.balance, 0);
  let total = 0;
  for (const t of tokens) total += await meBalance(t);
  assert.strictEqual(total, seeded, 'sum of balances must equal seeded total');
}

async function main() {
  // ---- concurrency: one wallet drained by many concurrent payers -----------
  await test('exactly one of N concurrent identical-amount payments succeeds', async () => {
    await resetTo(fixture({ users: [
      { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada', handle: 'ada', balance: 1000 },
      { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob', handle: 'bob', balance: 0 },
    ] }));
    const token = await login('ada@example.com', 'correct horse');
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        req('POST', '/payments', { token, key: newKey(), body: { to_handle: 'bob', amount: 1000 } })
      )
    );
    const statuses = results.map((r) => r.status);
    const oks = statuses.filter((s) => s === 201).length;
    const insufficient = statuses.filter((s) => s === 409).length;
    assert.strictEqual(oks, 1, `expected exactly one 201, got statuses: ${statuses}`);
    assert.strictEqual(insufficient, N - 1, `expected the rest 409`);
    assert.strictEqual(await meBalance(token), 0);
  });

  // ---- concurrency: concurrent identical idempotent requests ---------------
  await test('concurrent identical-key payments: one 201, rest 200, one effect', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const key = newKey();
    const N = 15;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 300 } })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    assert.strictEqual(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses}`);
    assert.strictEqual(statuses.filter((s) => s === 200).length, N - 1, `statuses: ${statuses}`);
    const bodies = results.map((r) => JSON.stringify(r.json));
    assert.strictEqual(new Set(bodies).size, 1, 'all replay bodies must be identical');
    assert.strictEqual(await meBalance(token), 10000 - 300);
  });

  // ---- concurrency: settlement burst preserves conservation -----------------
  await test('concurrent settlement + payment bursts preserve conservation', async () => {
    const fx = fixture();
    fx.settlement_operator_ids = ['u_ada'];
    await resetTo(fx);
    const adaToken = await login('ada@example.com', 'correct horse');
    const bobToken = await login('bob@example.com', 'correct horse');
    const cyToken = await login('cy@example.com', 'correct horse');
    const ops = [];
    for (let i = 0; i < 10; i++) {
      ops.push(req('POST', '/payments', { token: adaToken, key: newKey(), body: { to_handle: 'bob', amount: 10 } }));
      ops.push(req('POST', '/payments', { token: bobToken, key: newKey(), body: { to_handle: 'cy', amount: 5 } }));
      ops.push(req('POST', '/settlements', { token: adaToken, key: newKey(), body: { transfers: [
        { from_handle: 'cy', to_handle: 'ada', amount: 1 },
      ] } }));
    }
    const results = await Promise.all(ops);
    for (const r of results) assert.ok(r.status < 500, `no 5xx allowed, got ${r.status}`);
    await conservationHolds(fx, [adaToken, bobToken, cyToken]);
  });

  // ---- idempotency reuse matrix ---------------------------------------------
  await test('same key + different body => 409 idempotency_key_reuse', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const key = newKey();
    const r1 = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 100 } });
    assert.strictEqual(r1.status, 201);
    const r2 = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 200 } });
    assert.strictEqual(r2.status, 409);
    assert.strictEqual(r2.json.error.code, 'idempotency_key_reuse');
  });

  await test('same key on a different path is not a replay', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const key = 'shared-key';
    const r1 = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 10 } });
    assert.strictEqual(r1.status, 201);
    const r2 = await req('POST', '/requests', { token, key, body: { payer_handle: 'bob', amount: 10 } });
    assert.strictEqual(r2.status, 201);
  });

  await test('key reused after a 4xx failure is a first use', async () => {
    await resetTo(fixture());
    const token = await login('cy@example.com', 'correct horse');
    const key = newKey();
    const before = await meBalance(token);
    const r1 = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: before + 1000 } });
    assert.strictEqual(r1.status, 409);
    const r2 = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 10 } });
    assert.strictEqual(r2.status, 201, 'key must be reusable after a failed 4xx attempt');
  });

  await test('replay of a paid request pay call returns 200, never request_not_pending', async () => {
    await resetTo(fixture());
    const adaToken = await login('ada@example.com', 'correct horse');
    const bobToken = await login('bob@example.com', 'correct horse');
    const rq = await req('POST', '/requests', { token: bobToken, key: newKey(), body: { payer_handle: 'ada', amount: 100 } });
    const key = newKey();
    const r1 = await req('POST', `/requests/${rq.json.request_id}/pay`, { token: adaToken, key, body: {} });
    assert.strictEqual(r1.status, 201);
    const r2 = await req('POST', `/requests/${rq.json.request_id}/pay`, { token: adaToken, key, body: {} });
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual(r2.json, r1.json);
  });

  // ---- conservation across a mixed workload ---------------------------------
  await test('conservation holds after payments, requests, splits, settlements', async () => {
    const fx = fixture();
    fx.settlement_operator_ids = ['u_ada'];
    await resetTo(fx);
    const adaToken = await login('ada@example.com', 'correct horse');
    const bobToken = await login('bob@example.com', 'correct horse');
    const cyToken = await login('cy@example.com', 'correct horse');
    await req('POST', '/payments', { token: adaToken, key: newKey(), body: { to_handle: 'bob', amount: 500 } });
    const split = await req('POST', '/splits', { token: bobToken, key: newKey(), body: { amount: 900, participant_handles: ['bob', 'ada', 'cy'] } });
    for (const r of split.json.requests) {
      const payerToken = r.payer_handle === 'ada' ? adaToken : cyToken;
      await req('POST', `/requests/${r.request_id}/pay`, { token: payerToken, key: newKey(), body: {} });
    }
    await req('POST', '/settlements', { token: adaToken, key: newKey(), body: { transfers: [
      { from_handle: 'bob', to_handle: 'cy', amount: 50 },
    ] } });
    await conservationHolds(fx, [adaToken, bobToken, cyToken]);
  });

  // ---- export/import round trip, including replay after import -------------
  await test('export/import round trip preserves balances, tokens, and idempotency replay', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const key = newKey();
    const payResp = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 250 } });
    assert.strictEqual(payResp.status, 201);

    const exp = await req('GET', '/_test/export');
    assert.strictEqual(exp.status, 200);
    assert.strictEqual(exp.json.track, 'pocketful');
    assert.strictEqual(exp.json.format_version, 1);

    // Wipe state with an unrelated reset, then restore via import.
    await resetTo(fixture({ users: [{ id: 'u_z', email: 'z@example.com', password: 'correct horse', display_name: 'Z', handle: 'z', balance: 0 }] }));
    const imp = await req('POST', '/_test/import', { body: exp.json });
    assert.strictEqual(imp.status, 204);

    // The old token must still work, balance restored.
    const me = await req('GET', '/me', { token });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.balance, 10000 - 250);

    // Replaying the same idempotency key after import must return the original
    // response and move no additional money.
    const replay = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 250 } });
    assert.strictEqual(replay.status, 200);
    assert.deepStrictEqual(replay.json, payResp.json);
    const meAfter = await req('GET', '/me', { token });
    assert.strictEqual(meAfter.json.balance, 10000 - 250, 'replay after import must not move money again');
  });

  await test('a rejected reset fixture (negative balance) leaves prior state untouched', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const before = await meBalance(token);
    const bad = fixture({ users: [
      { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada', handle: 'ada', balance: -1 },
    ] });
    const r = await req('POST', '/_test/reset', { body: bad });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'validation_failed');
    assert.strictEqual(await meBalance(token), before, 'rejected fixture must not change prior state');
  });

  await test('settlement affordability checked on net balances, all-or-nothing', async () => {
    const fx = fixture();
    fx.settlement_operator_ids = ['u_ada'];
    await resetTo(fx);
    const adaToken = await login('ada@example.com', 'correct horse');
    // ada has 10000; net transfer sends 10000 out but receives 10000 back from bob in the
    // same batch, so it is affordable net even though the individual leg alone is exactly
    // her balance.
    const r = await req('POST', '/settlements', { token: adaToken, key: newKey(), body: { transfers: [
      { from_handle: 'ada', to_handle: 'bob', amount: 10000 },
      { from_handle: 'bob', to_handle: 'ada', amount: 10000 },
    ] } });
    assert.strictEqual(r.status, 201, `expected net-affordable settlement to succeed: ${JSON.stringify(r.json)}`);
    assert.strictEqual(await meBalance(adaToken), 10000);
  });

  // ---- S1-FIX-1 regressions -------------------------------------------------

  await test('MAJOR-1: same key on /payments then /requests then /splits does not corrupt the /payments replay', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const key = 'cross-path-key';
    const payResp = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 111 } });
    assert.strictEqual(payResp.status, 201);
    const reqResp = await req('POST', '/requests', { token, key, body: { payer_handle: 'bob', amount: 222 } });
    assert.strictEqual(reqResp.status, 201);
    const splitResp = await req('POST', '/splits', { token, key, body: { amount: 300, participant_handles: ['ada', 'bob'] } });
    assert.strictEqual(splitResp.status, 201);
    // Replaying the ORIGINAL body on the ORIGINAL path must still return the
    // original response and move no more money, even though the same key
    // string was reused on two other paths in between.
    const replay = await req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 111 } });
    assert.strictEqual(replay.status, 200);
    assert.deepStrictEqual(replay.json, payResp.json);
    assert.strictEqual(await meBalance(token), 10000 - 111);
  });

  await test('MAJOR-2: generated ids never collide with high-numbered seeded ids', async () => {
    await resetTo({
      currency: 'EUR', minor_units: 2,
      users: [
        { id: 'u_9', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada', handle: 'ada', balance: 10000 },
        { id: 'u_3', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob', handle: 'bob', balance: 2500 },
      ],
      payments: [{ id: 'p_2', from_user_id: 'u_9', to_user_id: 'u_3', amount: 500, note: 'seeded', visibility: 'public' }],
      requests: [{ id: 'rq_2', requester_id: 'u_3', payer_id: 'u_9', amount: 1200, note: 'seeded', status: 'pending' }],
    });
    const adaToken = await login('ada@example.com', 'correct horse');
    // A freshly generated payment/request id must never equal a seeded one.
    const pay = await req('POST', '/payments', { token: adaToken, key: newKey(), body: { to_handle: 'bob', amount: 1 } });
    assert.strictEqual(pay.status, 201);
    assert.notStrictEqual(pay.json.payment_id, 'p_2');
    const rq = await req('POST', '/requests', { token: adaToken, key: newKey(), body: { payer_handle: 'bob', amount: 1 } });
    assert.strictEqual(rq.status, 201);
    assert.notStrictEqual(rq.json.request_id, 'rq_2');
    // The seeded request must still be intact and payable for its original amount.
    const paySeeded = await req('POST', '/requests/rq_2/pay', { token: adaToken, key: newKey(), body: {} });
    assert.strictEqual(paySeeded.status, 201);
    assert.strictEqual(paySeeded.json.amount, 1200);
  });

  await test('MAJOR-3: a straggling request authenticated before reset must not corrupt post-reset state', async () => {
    // Simulate the race directly against the model contract: a token valid
    // before reset must be rejected (401) after reset, never silently
    // mutate the new state. We approximate the raw-socket repro by resetting
    // mid-flight is exercised by the reviewer's script; here we assert the
    // observable contract: old tokens are gone and conservation holds.
    await resetTo(fixture());
    const oldToken = await login('ada@example.com', 'correct horse');
    await resetTo(fixture({ users: [
      { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada', handle: 'ada', balance: 100 },
      { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob', handle: 'bob', balance: 100 },
    ] }));
    const me = await req('GET', '/me', { token: oldToken });
    assert.strictEqual(me.status, 401, 'a pre-reset token must not be honoured after reset');
    const newToken = await login('ada@example.com', 'correct horse');
    assert.strictEqual(await meBalance(newToken), 100);
  });

  await test('MAJOR-4: import rejects a negative balance and leaves state untouched', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const before = await meBalance(token);
    const exp = await req('GET', '/_test/export');
    const bad = JSON.parse(JSON.stringify(exp.json));
    bad.state.users[0].balance = -50;
    const imp = await req('POST', '/_test/import', { body: bad });
    assert.strictEqual(imp.status, 422);
    assert.strictEqual(imp.json.error.code, 'validation_failed');
    assert.strictEqual(await meBalance(token), before, 'rejected import must not change destination state');
  });

  await test('MAJOR-4: import rejects a dangling user reference in a payment', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const before = await meBalance(token);
    const exp = await req('GET', '/_test/export');
    const bad = JSON.parse(JSON.stringify(exp.json));
    bad.state.payments.push({
      id: 'p_ghost', fromUserId: 'u_does_not_exist', toUserId: 'u_bob',
      amount: 10, note: '', visibility: 'public', requestId: null, settlementId: null,
      createdAt: new Date().toISOString(), seq: 999999,
    });
    const imp = await req('POST', '/_test/import', { body: bad });
    assert.strictEqual(imp.status, 422);
    assert.strictEqual(await meBalance(token), before);
  });

  await test('MAJOR-4: import rejects a duplicate handle and a missing password hash', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const exp = await req('GET', '/_test/export');

    const dup = JSON.parse(JSON.stringify(exp.json));
    dup.state.users.push({ ...dup.state.users[0], id: 'u_dup' }); // same handle/email as ada
    const impDup = await req('POST', '/_test/import', { body: dup });
    assert.strictEqual(impDup.status, 422);

    const noHash = JSON.parse(JSON.stringify(exp.json));
    delete noHash.state.users[0].passwordHash;
    const impNoHash = await req('POST', '/_test/import', { body: noHash });
    assert.strictEqual(impNoHash.status, 422);

    // Prior (pre-import-attempt) state must still be intact.
    assert.strictEqual(await meBalance(token), 10000);
  });

  await test('MINOR-1: Authorization header must be exactly "Bearer <token>"', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const raw = await req('GET', '/me', { headers: { Authorization: token } });
    assert.strictEqual(raw.status, 401);
    const basic = await req('GET', '/me', { headers: { Authorization: `Basic ${token}` } });
    assert.strictEqual(basic.status, 401);
    const good = await req('GET', '/me', { token });
    assert.strictEqual(good.status, 200);
  });

  await test('concurrency non-regression: 30 concurrent identical keys -> one 201, rest 200', async () => {
    await resetTo(fixture());
    const token = await login('ada@example.com', 'correct horse');
    const key = newKey();
    const N = 30;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        req('POST', '/payments', { token, key, body: { to_handle: 'bob', amount: 77 } })
      )
    );
    const statuses = results.map((r) => r.status);
    assert.strictEqual(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses}`);
    assert.strictEqual(statuses.filter((s) => s === 200).length, N - 1, `statuses: ${statuses}`);
    const bodies = results.map((r) => JSON.stringify(r.json));
    assert.strictEqual(new Set(bodies).size, 1);
    assert.strictEqual(await meBalance(token), 10000 - 77);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('fatal error running tests', e);
  process.exit(1);
});
