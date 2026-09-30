'use strict';
/*
 * Pocketful — Stage 2 single-page app.
 *
 * Vanilla JS, no build step, no external network calls (fonts/CSS/JS are all
 * served by this same service). Client-side hash routing keeps the app
 * working from a single HTML shell while still letting every required route
 * be reached directly by URL (the server returns this same shell for all of
 * them, and this router reads the real pathname on load).
 */

// ---------------------------------------------------------------------------
// Money: exact integer/string arithmetic, never floats.
// ---------------------------------------------------------------------------

function formatMoney(minor, minorUnits, currency) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (minorUnits === 0) {
    return `${sign}${abs} ${currency}`;
  }
  const text = String(abs).padStart(minorUnits + 1, '0');
  const whole = text.slice(0, text.length - minorUnits);
  const frac = text.slice(text.length - minorUnits);
  return `${sign}${whole}.${frac} ${currency}`;
}

// Parses a person-typed decimal string ("15", "15.00", "15.5") into minor
// units using only integer/string operations. Returns null (never throws)
// when the input is not a valid amount for the given minorUnits — callers
// must show their form's error element and send nothing.
function parseAmount(raw, minorUnits) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!m) return null;
  const whole = m[1];
  const frac = m[2] || '';
  if (frac.length > minorUnits) return null; // more places than the currency allows
  const paddedFrac = frac.padEnd(minorUnits, '0');
  const combined = `${whole}${paddedFrac}`;
  // Strip leading zeros but keep at least one digit, then parse as an
  // integer. combined is all digits by construction, so this is safe and
  // exact for any realistic amount (no float ever touches the value).
  const normalized = combined.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'pocketful_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || 'error');
    this.status = status;
    this.code = code;
  }
}

// A network-level failure (fetch rejected, aborted, timed out) where we
// genuinely do not know whether the server received/committed the request.
class UncertainError extends Error {}

async function apiFetch(path, { method = 'GET', body, key, headers, accept } = {}) {
  const h = { ...(headers || {}) };
  if (accept) h['Accept'] = accept;
  const token = getToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (key) h['Idempotency-Key'] = key;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Network error / abort: the caller cannot tell whether the request
    // was received, so this must never be treated as a rejection.
    throw new UncertainError(e && e.message ? e.message : 'network error');
  }
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    json = null;
  }
  if (!res.ok) {
    const code = json && json.error ? json.error.code : 'error';
    const message = json && json.error ? json.error.message : `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message);
  }
  return json;
}

function newIdempotencyKey() {
  return `key_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

function h(tag, attrs, children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children || []) {
    if (c === undefined || c === null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function humanTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (e) {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  me: null, // { user_id, display_name, handle, balance, total, available, held, currency, minor_units }
  route: '/',
  // Per-form idempotency identity: key is only regenerated when the form's
  // logical content changes, not on every click, so an unchanged resubmit
  // is a pure replay of the same request.
  forms: {
    pay: { signature: null, key: null },
    request: { signature: null, key: null },
    split: { signature: null, key: null },
    authorize: { signature: null, key: null },
  },
  // Monotonic sequence guarding the wallet/feed refresh against out-of-order
  // network responses: only the highest sequence number seen so far may
  // update the DOM.
  refreshSeq: 0,
};

function formSignature(obj) {
  return JSON.stringify(obj);
}

// Returns the same key for an unchanged signature, or mints (and stores) a
// fresh one when the signature changed since the last call.
function keyFor(formName, signature) {
  const f = state.forms[formName];
  if (f.signature === signature && f.key) return f.key;
  f.signature = signature;
  f.key = newIdempotencyKey();
  return f.key;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = ['/', '/requests', '/split', '/signup', '/login', '/authorizations'];

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

window.addEventListener('popstate', render);

// ---------------------------------------------------------------------------
// Root render
// ---------------------------------------------------------------------------

async function render() {
  const path = window.location.pathname;
  const app = document.getElementById('app');
  clear(app);

  const signedIn = !!getToken();
  if (!signedIn && path !== '/signup' && path !== '/login') {
    if (path !== '/login') return navigate('/login', { replace: true });
  }
  if (signedIn && state.me === null) {
    try {
      state.me = await apiFetch('/me', { accept: 'application/json' });
    } catch (e) {
      // Token no longer valid: treat as signed out.
      setToken(null);
      state.me = null;
      if (path !== '/signup' && path !== '/login') return navigate('/login', { replace: true });
    }
  }

  const container = h('div', { class: 'page' }, []);
  app.appendChild(buildNav(path, signedIn));
  const main = h('main', {}, []);
  app.appendChild(main);

  if (path === '/signup') return renderSignup(main);
  if (path === '/login') return renderLogin(main);
  if (path === '/requests') return renderRequests(main);
  if (path === '/split') return renderSplit(main);
  if (path === '/authorizations') return renderAuthorizations(main);
  return renderHome(main);
}

function buildNav(path, signedIn) {
  const links = ROUTES.filter((r) => r !== '/signup' && r !== '/login').map((r) => {
    const label = { '/': 'Home', '/requests': 'Requests', '/split': 'Split', '/authorizations': 'Authorizations' }[r];
    return h('a', { href: r, class: r === path ? 'active' : '', onclick: (e) => { e.preventDefault(); navigate(r); } }, [label]);
  });
  const nav = h('nav', { class: 'nav' }, [
    h('span', { class: 'nav-brand' }, ['Pocketful']),
  ]);
  if (signedIn) {
    nav.appendChild(h('div', { class: 'nav-links' }, links));
    const userBlock = h('div', { class: 'nav-user' }, [
      h('span', { 'data-testid': 'current-user' }, [state.me ? state.me.display_name : '']),
      h('span', { 'data-testid': 'current-handle' }, [state.me ? state.me.handle : '']),
      h('button', {
        class: 'btn secondary small',
        'data-testid': 'logout-button',
        onclick: () => {
          setToken(null);
          state.me = null;
          navigate('/login');
        },
      }, ['Log out']),
    ]);
    nav.appendChild(userBlock);
  }
  return nav;
}

// ---------------------------------------------------------------------------
// Signup / login
// ---------------------------------------------------------------------------

function renderSignup(main) {
  let error = null;
  const emailField = h('input', { type: 'email', 'data-testid': 'signup-email' });
  const passwordField = h('input', { type: 'password', 'data-testid': 'signup-password' });
  const nameField = h('input', { type: 'text', 'data-testid': 'signup-display-name' });
  const errorSlot = h('div', {});

  function renderError() {
    clear(errorSlot);
    if (error) errorSlot.appendChild(h('div', { class: 'msg error', 'data-testid': 'auth-error' }, [error]));
  }

  const form = h('div', { class: 'card' }, [
    h('h2', {}, ['Create your account']),
    h('div', { class: 'field' }, [h('label', {}, ['Email']), emailField]),
    h('div', { class: 'field' }, [h('label', {}, ['Password']), passwordField]),
    h('div', { class: 'field' }, [h('label', {}, ['Display name']), nameField]),
    errorSlot,
    h('button', {
      class: 'btn',
      'data-testid': 'signup-submit',
      onclick: async () => {
        error = null;
        renderError();
        try {
          const result = await apiFetch('/auth/signup', {
            method: 'POST',
            body: { email: emailField.value, password: passwordField.value, display_name: nameField.value },
          });
          setToken(result.token);
          state.me = null;
          navigate('/');
        } catch (e) {
          error = e instanceof UncertainError ? 'Something went wrong. Please try again.' : e.message;
          renderError();
        }
      },
    }, ['Sign up']),
  ]);
  main.appendChild(form);
}

function renderLogin(main) {
  let error = null;
  const emailField = h('input', { type: 'email', 'data-testid': 'login-email' });
  const passwordField = h('input', { type: 'password', 'data-testid': 'login-password' });
  const errorSlot = h('div', {});

  function renderError() {
    clear(errorSlot);
    if (error) errorSlot.appendChild(h('div', { class: 'msg error', 'data-testid': 'auth-error' }, [error]));
  }

  const form = h('div', { class: 'card' }, [
    h('h2', {}, ['Log in']),
    h('div', { class: 'field' }, [h('label', {}, ['Email']), emailField]),
    h('div', { class: 'field' }, [h('label', {}, ['Password']), passwordField]),
    errorSlot,
    h('button', {
      class: 'btn',
      'data-testid': 'login-submit',
      onclick: async () => {
        error = null;
        renderError();
        try {
          const result = await apiFetch('/auth/login', {
            method: 'POST',
            body: { email: emailField.value, password: passwordField.value },
          });
          setToken(result.token);
          state.me = null;
          navigate('/');
        } catch (e) {
          error = e instanceof UncertainError ? 'Something went wrong. Please try again.' : 'Invalid email or password.';
          renderError();
        }
      },
    }, ['Log in']),
  ]);
  main.appendChild(form);
}

// ---------------------------------------------------------------------------
// Home: balance, pay form, request form, activity feed
// ---------------------------------------------------------------------------

async function renderHome(main) {
  const money = (minor) => formatMoney(minor, state.me.minor_units, state.me.currency);

  const balanceHeadline = h('div', { class: 'balance-headline', 'data-testid': 'wallet-available', 'data-amount': String(state.me.available) }, [money(state.me.available)]);
  const balanceSub = h('div', { class: 'balance-sub' }, [
    h('span', {}, ['Total: ', h('strong', { 'data-testid': 'wallet-balance', 'data-amount': String(state.me.total) }, [money(state.me.total)])]),
  ]);
  if (state.me.held > 0) {
    balanceSub.appendChild(h('span', {}, ['Held: ', h('strong', { 'data-testid': 'wallet-held', 'data-amount': String(state.me.held) }, [money(state.me.held)])]));
  }
  const refreshBtn = h('button', { class: 'btn secondary small', 'data-testid': 'wallet-refresh' }, ['Refresh']);
  const balanceCard = h('div', { class: 'card balance-block' }, [
    h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;' }, [
      h('div', {}, [h('div', { class: 'loading-text' }, ['Available to spend']), balanceHeadline]),
      refreshBtn,
    ]),
    balanceSub,
  ]);

  // Pay form ---------------------------------------------------------------
  const payHandle = h('input', { type: 'text', 'data-testid': 'pay-handle' });
  const payAmount = h('input', { type: 'text', 'data-testid': 'pay-amount' });
  const payNote = h('input', { type: 'text', 'data-testid': 'pay-note' });
  const payVisibility = h('select', { 'data-testid': 'pay-visibility' }, [
    h('option', { value: 'public' }, ['Public']),
    h('option', { value: 'private' }, ['Private']),
  ]);
  const payMsgSlot = h('div', {});

  function renderPayMsg(kind, text) {
    clear(payMsgSlot);
    if (!kind) return;
    const testid = kind === 'error' ? 'pay-error' : 'pay-uncertain';
    payMsgSlot.appendChild(h('div', { class: `msg ${kind}`, 'data-testid': testid }, [text]));
  }

  async function submitPay() {
    const amt = parseAmount(payAmount.value, state.me.minor_units);
    if (amt === null) {
      renderPayMsg('error', 'Enter a valid amount.');
      return;
    }
    const signature = formSignature({ handle: payHandle.value, amount: amt, note: payNote.value, visibility: payVisibility.value });
    const key = keyFor('pay', signature);
    try {
      await apiFetch('/payments', {
        method: 'POST',
        key,
        body: { to_handle: payHandle.value, amount: amt, note: payNote.value, visibility: payVisibility.value },
      });
      renderPayMsg(null);
      await refreshWalletAndFeed();
    } catch (e) {
      if (e instanceof UncertainError) {
        renderPayMsg('uncertain', 'We could not confirm this payment. It is safe to try again.');
      } else {
        renderPayMsg('error', e.message);
        await refreshWalletAndFeed();
      }
    }
  }

  const payForm = h('div', { class: 'card' }, [
    h('h2', {}, ['Send money']),
    h('div', { class: 'field' }, [h('label', {}, ['To handle']), payHandle]),
    h('div', { class: 'field' }, [h('label', {}, ['Amount']), payAmount]),
    h('div', { class: 'field' }, [h('label', {}, ['Note (optional)']), payNote]),
    h('div', { class: 'field' }, [h('label', {}, ['Visibility']), payVisibility]),
    payMsgSlot,
    h('button', { class: 'btn', 'data-testid': 'pay-submit', onclick: submitPay }, ['Pay']),
  ]);

  // Request form ------------------------------------------------------------
  const reqHandle = h('input', { type: 'text', 'data-testid': 'request-handle' });
  const reqAmount = h('input', { type: 'text', 'data-testid': 'request-amount' });
  const reqNote = h('input', { type: 'text', 'data-testid': 'request-note' });
  const reqMsgSlot = h('div', {});

  function renderReqMsg(text) {
    clear(reqMsgSlot);
    if (text) reqMsgSlot.appendChild(h('div', { class: 'msg error', 'data-testid': 'request-error' }, [text]));
  }

  async function submitRequest() {
    const amt = parseAmount(reqAmount.value, state.me.minor_units);
    if (amt === null) {
      renderReqMsg('Enter a valid amount.');
      return;
    }
    const signature = formSignature({ handle: reqHandle.value, amount: amt, note: reqNote.value });
    const key = keyFor('request', signature);
    try {
      await apiFetch('/requests', { method: 'POST', key, body: { payer_handle: reqHandle.value, amount: amt, note: reqNote.value } });
      renderReqMsg(null);
      await refreshWalletAndFeed();
    } catch (e) {
      if (!(e instanceof UncertainError)) renderReqMsg(e.message);
    }
  }

  const requestForm = h('div', { class: 'card' }, [
    h('h2', {}, ['Request money']),
    h('div', { class: 'field' }, [h('label', {}, ['From handle']), reqHandle]),
    h('div', { class: 'field' }, [h('label', {}, ['Amount']), reqAmount]),
    h('div', { class: 'field' }, [h('label', {}, ['Note (optional)']), reqNote]),
    reqMsgSlot,
    h('button', { class: 'btn', 'data-testid': 'request-submit', onclick: submitRequest }, ['Request']),
  ]);

  const activitySlot = h('div', {});

  async function refreshWalletAndFeed() {
    const mySeq = ++state.refreshSeq;
    try {
      const [me, activity] = await Promise.all([
        apiFetch('/me', { accept: 'application/json' }),
        apiFetch('/activity', { accept: 'application/json' }),
      ]);
      // Out-of-order guard: only the latest-issued refresh may write to the DOM.
      if (mySeq !== state.refreshSeq) return;
      state.me = me;
      renderBalanceInPlace(balanceHeadline, balanceSub, money2(me));
      renderActivity(activitySlot, activity.payments || []);
    } catch (e) {
      // A failed background refresh is not user-actionable here; leave the
      // last known-good state on screen.
    }
  }

  function money2(me) {
    return (minor) => formatMoney(minor, me.minor_units, me.currency);
  }

  refreshBtn.addEventListener('click', refreshWalletAndFeed);

  main.appendChild(h('div', { class: 'two-col' }, [payForm, requestForm]));
  main.insertBefore(balanceCard, main.firstChild);
  main.appendChild(activitySlot);

  const activity = await apiFetch('/activity', { accept: 'application/json' });
  renderActivity(activitySlot, activity.payments || []);
}

function renderBalanceInPlace(headlineEl, subEl, money) {
  headlineEl.textContent = money(state.me.available);
  headlineEl.setAttribute('data-amount', String(state.me.available));
  clear(subEl);
  subEl.appendChild(h('span', {}, ['Total: ', h('strong', { 'data-testid': 'wallet-balance', 'data-amount': String(state.me.total) }, [money(state.me.total)])]));
  if (state.me.held > 0) {
    subEl.appendChild(h('span', {}, ['Held: ', h('strong', { 'data-testid': 'wallet-held', 'data-amount': String(state.me.held) }, [money(state.me.held)])]));
  }
}

function renderActivity(slot, payments) {
  clear(slot);
  const money = (minor) => formatMoney(minor, state.me.minor_units, state.me.currency);
  const card = h('div', { class: 'card' }, [h('h2', {}, ['Activity'])]);
  if (payments.length === 0) {
    card.appendChild(h('div', { class: 'empty-state', 'data-testid': 'empty-activity' }, ['No activity yet.']));
  } else {
    const sorted = [...payments].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const list = h('ul', { class: 'list', 'data-testid': 'activity-list' }, sorted.map((p) => h('li', {
      class: 'list-item',
      'data-testid': `activity-item-${p.payment_id}`,
      'data-visibility': p.visibility,
    }, [
      h('div', { class: 'list-item-main' }, [
        h('span', { class: 'list-item-parties', 'data-testid': `activity-parties-${p.payment_id}` }, [`${p.from_handle} \u2192 ${p.to_handle}`]),
        h('span', { class: 'list-item-meta' }, [humanTime(p.created_at), ' \u00b7 ', h('span', { class: 'visibility-tag' }, [p.visibility])]),
        h('span', { class: 'list-item-meta', 'data-testid': `activity-note-${p.payment_id}` }, [p.note || '']),
      ]),
      h('span', { class: 'list-item-amount', 'data-testid': `activity-amount-${p.payment_id}` }, [money(p.amount)]),
    ])));
    card.appendChild(list);
  }
  slot.appendChild(card);
}

// ---------------------------------------------------------------------------
// Requests screen
// ---------------------------------------------------------------------------

async function renderRequests(main) {
  const errorSlot = h('div', {});
  const incomingList = h('ul', { class: 'list', 'data-testid': 'incoming-list' }, []);
  const outgoingList = h('ul', { class: 'list', 'data-testid': 'outgoing-list' }, []);
  const emptySlot = h('div', {});

  function money(minor) {
    return formatMoney(minor, state.me.minor_units, state.me.currency);
  }

  function renderError(text) {
    clear(errorSlot);
    if (text) errorSlot.appendChild(h('div', { class: 'msg error', 'data-testid': 'request-error' }, [text]));
  }

  async function load() {
    clear(incomingList);
    clear(outgoingList);
    clear(emptySlot);
    let incoming = [];
    let outgoing = [];
    try {
      const [inc, out] = await Promise.all([
        apiFetch('/requests?direction=incoming', { accept: 'application/json' }),
        apiFetch('/requests?direction=outgoing', { accept: 'application/json' }),
      ]);
      incoming = inc.requests || [];
      outgoing = out.requests || [];
    } catch (e) {
      renderError(e.message);
      return;
    }
    if (incoming.length === 0 && outgoing.length === 0) {
      emptySlot.appendChild(h('div', { class: 'empty-state', 'data-testid': 'empty-requests' }, ['No requests yet.']));
    }
    for (const r of incoming) incomingList.appendChild(requestItem(r, 'incoming'));
    for (const r of outgoing) outgoingList.appendChild(requestItem(r, 'outgoing'));
  }

  function requestItem(r, direction) {
    const actions = [];
    if (r.status === 'pending' && direction === 'incoming') {
      actions.push(h('button', {
        class: 'btn small',
        'data-testid': `request-pay-${r.request_id}`,
        onclick: async () => {
          try {
            await apiFetch(`/requests/${r.request_id}/pay`, { method: 'POST', key: newIdempotencyKey(), body: {} });
            renderError(null);
            await load();
          } catch (e) {
            renderError(e.message);
            await load();
          }
        },
      }, ['Pay']));
      actions.push(h('button', {
        class: 'btn secondary small',
        'data-testid': `request-decline-${r.request_id}`,
        onclick: async () => {
          try {
            await apiFetch(`/requests/${r.request_id}/decline`, { method: 'POST' });
            renderError(null);
            await load();
          } catch (e) {
            renderError(e.message);
            await load();
          }
        },
      }, ['Decline']));
    }
    if (r.status === 'pending' && direction === 'outgoing') {
      actions.push(h('button', {
        class: 'btn secondary small',
        'data-testid': `request-cancel-${r.request_id}`,
        onclick: async () => {
          try {
            await apiFetch(`/requests/${r.request_id}/cancel`, { method: 'POST' });
            renderError(null);
            await load();
          } catch (e) {
            renderError(e.message);
            await load();
          }
        },
      }, ['Cancel']));
    }
    const who = direction === 'incoming' ? r.requester_handle : r.payer_handle;
    return h('li', { class: 'list-item', 'data-testid': `request-item-${r.request_id}`, 'data-status': r.status }, [
      h('div', { class: 'list-item-main' }, [
        h('span', { class: 'list-item-parties' }, [who]),
        h('span', { class: `status-pill ${r.status}` }, [r.status]),
        h('span', { class: 'list-item-meta' }, [r.note || '']),
      ]),
      h('span', { class: 'list-item-amount', 'data-testid': `request-amount-${r.request_id}` }, [money(r.amount)]),
      h('div', { class: 'list-item-actions' }, actions),
    ]);
  }

  main.appendChild(h('div', { class: 'card' }, [h('h2', {}, ['Incoming requests']), errorSlot, incomingList]));
  main.appendChild(h('div', { class: 'card' }, [h('h2', {}, ['Outgoing requests']), outgoingList]));
  main.appendChild(emptySlot);
  await load();
}

// ---------------------------------------------------------------------------
// Split screen
// ---------------------------------------------------------------------------

function equalSplit(amount, n) {
  const base = Math.floor(amount / n);
  const remainder = amount - base * n;
  const shares = [];
  for (let i = 0; i < n; i++) shares.push(base + (i < remainder ? 1 : 0));
  return shares;
}

function renderSplit(main) {
  const amountField = h('input', { type: 'text', 'data-testid': 'split-amount' });
  const handlesField = h('input', { type: 'text', 'data-testid': 'split-handles' });
  const noteField = h('input', { type: 'text', 'data-testid': 'split-note' });
  const previewSlot = h('div', {});
  const errorSlot = h('div', {});

  function money(minor) {
    return formatMoney(minor, state.me.minor_units, state.me.currency);
  }

  function renderError(text) {
    clear(errorSlot);
    if (text) errorSlot.appendChild(h('div', { class: 'msg error', 'data-testid': 'split-error' }, [text]));
  }

  function updatePreview() {
    clear(previewSlot);
    const amt = parseAmount(amountField.value, state.me.minor_units);
    const handles = handlesField.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (amt === null || handles.length === 0) return;
    const shares = equalSplit(amt, handles.length);
    const rows = handles.map((hd, i) => h('div', { class: 'split-share-row' }, [
      h('span', {}, [hd]),
      h('span', { 'data-testid': `split-share-${hd}` }, [money(shares[i])]),
    ]));
    previewSlot.appendChild(h('div', { class: 'split-shares', 'data-testid': 'split-preview' }, rows));
  }

  amountField.addEventListener('input', updatePreview);
  handlesField.addEventListener('input', updatePreview);

  async function submitSplit() {
    const amt = parseAmount(amountField.value, state.me.minor_units);
    const handles = handlesField.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (amt === null || handles.length === 0) {
      renderError('Enter a valid amount and at least one handle.');
      return;
    }
    const signature = formSignature({ amount: amt, handles, note: noteField.value });
    const key = keyFor('split', signature);
    try {
      await apiFetch('/splits', { method: 'POST', key, body: { amount: amt, participant_handles: handles, note: noteField.value } });
      renderError(null);
    } catch (e) {
      if (!(e instanceof UncertainError)) renderError(e.message);
    }
  }

  main.appendChild(h('div', { class: 'card' }, [
    h('h2', {}, ['Split a bill']),
    h('div', { class: 'field' }, [h('label', {}, ['Amount']), amountField]),
    h('div', { class: 'field' }, [h('label', {}, ['Handles (comma separated)']), handlesField]),
    h('div', { class: 'field' }, [h('label', {}, ['Note (optional)']), noteField]),
    previewSlot,
    errorSlot,
    h('button', { class: 'btn', 'data-testid': 'split-submit', onclick: submitSplit }, ['Split']),
  ]));
}

// ---------------------------------------------------------------------------
// Authorizations screen
// ---------------------------------------------------------------------------

async function renderAuthorizations(main) {
  function money(minor) {
    return formatMoney(minor, state.me.minor_units, state.me.currency);
  }

  const errorSlot = h('div', {});
  function renderError(text) {
    clear(errorSlot);
    if (text) errorSlot.appendChild(h('div', { class: 'msg error', 'data-testid': 'authorization-error' }, [text]));
  }

  // Authorize form -----------------------------------------------------------
  const authHandle = h('input', { type: 'text', 'data-testid': 'authorize-handle' });
  const authAmount = h('input', { type: 'text', 'data-testid': 'authorize-amount' });
  const authNote = h('input', { type: 'text', 'data-testid': 'authorize-note' });
  const authVisibility = h('select', { 'data-testid': 'authorize-visibility' }, [
    h('option', { value: 'public' }, ['Public']),
    h('option', { value: 'private' }, ['Private']),
  ]);
  const authErrorSlot = h('div', {});
  function renderAuthError(text) {
    clear(authErrorSlot);
    if (text) authErrorSlot.appendChild(h('div', { class: 'msg error', 'data-testid': 'authorize-error' }, [text]));
  }

  async function submitAuthorize() {
    const amt = parseAmount(authAmount.value, state.me.minor_units);
    if (amt === null) {
      renderAuthError('Enter a valid amount.');
      return;
    }
    const signature = formSignature({ handle: authHandle.value, amount: amt, note: authNote.value, visibility: authVisibility.value });
    const key = keyFor('authorize', signature);
    try {
      await apiFetch('/authorizations', {
        method: 'POST',
        key,
        body: { to_handle: authHandle.value, amount: amt, note: authNote.value, visibility: authVisibility.value },
      });
      renderAuthError(null);
      await load();
    } catch (e) {
      if (!(e instanceof UncertainError)) renderAuthError(e.message);
    }
  }

  const authorizeForm = h('div', { class: 'card' }, [
    h('h2', {}, ['Authorize a hold']),
    h('div', { class: 'field' }, [h('label', {}, ['To handle']), authHandle]),
    h('div', { class: 'field' }, [h('label', {}, ['Amount']), authAmount]),
    h('div', { class: 'field' }, [h('label', {}, ['Note (optional)']), authNote]),
    h('div', { class: 'field' }, [h('label', {}, ['Visibility']), authVisibility]),
    authErrorSlot,
    h('button', { class: 'btn', 'data-testid': 'authorize-submit', onclick: submitAuthorize }, ['Authorize']),
  ]);

  const listSlot = h('ul', { class: 'list', 'data-testid': 'authorization-list' }, []);
  const emptySlot = h('div', {});

  async function load() {
    clear(listSlot);
    clear(emptySlot);
    let items = [];
    try {
      const result = await apiFetch('/authorizations', { accept: 'application/json' });
      items = result.authorizations || [];
    } catch (e) {
      renderError(e.message);
      return;
    }
    if (items.length === 0) {
      emptySlot.appendChild(h('div', { class: 'empty-state', 'data-testid': 'empty-authorizations' }, ['No authorizations yet.']));
      return;
    }
    for (const a of items) listSlot.appendChild(authorizationItem(a));
  }

  function authorizationItem(a) {
    const isIncoming = a.to_handle === state.me.handle;
    const isOutgoing = a.from_handle === state.me.handle;
    const children = [
      h('div', { class: 'list-item-main' }, [
        h('span', { class: 'list-item-parties' }, [`${a.from_handle} \u2192 ${a.to_handle}`]),
        h('span', { class: `status-pill ${a.status}` }, [a.status]),
        h('span', { class: 'list-item-meta', 'data-testid': `authorization-expires-${a.authorization_id}` }, [a.expires_at]),
      ]),
      h('span', { class: 'list-item-amount', 'data-testid': `authorization-amount-${a.authorization_id}` }, [money(a.amount)]),
    ];
    if (a.status === 'captured') {
      children.push(h('span', { class: 'list-item-meta', 'data-testid': `authorization-captured-${a.authorization_id}` }, [money(a.captured_amount)]));
    }
    const actions = [];
    if (isIncoming && a.status === 'open') {
      const captureAmountField = h('input', {
        type: 'text',
        'data-testid': `authorization-capture-amount-${a.authorization_id}`,
        value: String((a.remaining_amount / Math.pow(10, state.me.minor_units)).toFixed(state.me.minor_units)),
      });
      actions.push(captureAmountField);
      actions.push(h('button', {
        class: 'btn small',
        'data-testid': `authorization-capture-${a.authorization_id}`,
        onclick: async () => {
          const amt = parseAmount(captureAmountField.value, state.me.minor_units);
          if (amt === null) {
            renderError('Enter a valid capture amount.');
            return;
          }
          try {
            await apiFetch(`/authorizations/${a.authorization_id}/capture`, {
              method: 'POST',
              key: newIdempotencyKey(),
              body: { amount: amt, final: amt >= a.remaining_amount },
            });
            renderError(null);
            await load();
          } catch (e) {
            renderError(e.message);
            await load();
          }
        },
      }, ['Capture']));
    }
    if (isOutgoing && a.status === 'open') {
      actions.push(h('button', {
        class: 'btn secondary small',
        'data-testid': `authorization-void-${a.authorization_id}`,
        onclick: async () => {
          try {
            await apiFetch(`/authorizations/${a.authorization_id}/void`, { method: 'POST' });
            renderError(null);
            await load();
          } catch (e) {
            renderError(e.message);
            await load();
          }
        },
      }, ['Void']));
    }
    return h('li', { class: 'list-item', 'data-testid': `authorization-item-${a.authorization_id}`, 'data-status': a.status }, [
      ...children,
      h('div', { class: 'list-item-actions' }, actions),
    ]);
  }

  main.appendChild(authorizeForm);
  main.appendChild(h('div', { class: 'card' }, [h('h2', {}, ['Authorizations']), errorSlot, listSlot, emptySlot]));
  await load();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

render();
