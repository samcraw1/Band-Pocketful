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

// Minor units -> the plain decimal string a person would type ("20.00"),
// using integer/string arithmetic only.
function minorToDecimal(minor, minorUnits) {
  if (minorUnits === 0) return String(minor);
  const text = String(minor).padStart(minorUnits + 1, '0');
  return `${text.slice(0, text.length - minorUnits)}.${text.slice(text.length - minorUnits)}`;
}

// Retry identity for one-click actions (request pay, capture): the same
// action with the same body keeps one key until the outcome is confirmed
// (success or a definite refusal), so a lost response is retried as a replay.
const pendingKeys = new Map();
function pendingKey(id) {
  if (!pendingKeys.has(id)) pendingKeys.set(id, newIdempotencyKey());
  return pendingKeys.get(id);
}
function settleKey(id) {
  pendingKeys.delete(id);
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

// A labelled form field: the label is programmatically associated with its
// control so screen readers and click-to-focus work.
let fieldSeq = 0;
function field(label, control) {
  fieldSeq += 1;
  const id = `f${fieldSeq}`;
  control.setAttribute('id', id);
  return h('div', { class: 'field' }, [h('label', { for: id }, [label]), control]);
}

// Status message. The icon is drawn by CSS (::before) so state is not conveyed
// by colour alone while the element's text stays exactly the message.
function message(kind, text, testid) {
  return h('div', {
    class: `msg ${kind}`,
    role: kind === 'error' || kind === 'uncertain' ? 'alert' : 'status',
    'data-testid': testid,
  }, [text]);
}

const UNCERTAIN_TEXT = 'We could not confirm that this went through. Nothing has been lost: try again and it will only be applied once.';

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

let renderSeq = 0;
async function render() {
  const path = window.location.pathname;
  const app = document.getElementById('app');

  const mySeq = ++renderSeq;
  let signedIn = !!getToken();
  if (!signedIn && path !== '/signup' && path !== '/login') {
    return navigate('/login', { replace: true });
  }
  if (signedIn) {
    // Re-read the wallet on every screen change so balances, available and
    // held funds are never stale after a write made on another screen (or by
    // another client).
    try {
      const me = await apiFetch('/me', { accept: 'application/json' });
      if (mySeq !== renderSeq) return;
      state.me = me;
    } catch (e) {
      if (mySeq !== renderSeq) return;
      if (e instanceof ApiError && e.status === 401) {
        // Token no longer valid: treat as signed out.
        setToken(null);
        state.me = null;
        signedIn = false;
        if (path !== '/signup' && path !== '/login') return navigate('/login', { replace: true });
      } else if (state.me === null) {
        // Network trouble with nothing cached: say so rather than signing out.
        app.appendChild(h('main', {}, [h('div', { class: 'card' }, [
          message('uncertain', 'Pocketful could not reach the server. Check your connection and try again.', 'load-error'),
          h('button', { class: 'btn', onclick: () => render() }, ['Try again']),
        ])]));
        return;
      }
    }
  }
  clear(app);

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
    if (error) errorSlot.appendChild(message('error', error, 'auth-error'));
  }

  const form = h('div', { class: 'card' }, [
    h('h2', {}, ['Create your account']),
    field('Email', emailField),
    field('Password', passwordField),
    field('Display name', nameField),
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
    if (error) errorSlot.appendChild(message('error', error, 'auth-error'));
  }

  const form = h('div', { class: 'card' }, [
    h('h2', {}, ['Log in']),
    field('Email', emailField),
    field('Password', passwordField),
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
// Shared screen helpers
// ---------------------------------------------------------------------------

function moneyOf(minor) {
  return formatMoney(minor, state.me.minor_units, state.me.currency);
}

function loadingBlock(text) {
  return h('div', { class: 'loading-text', role: 'status' }, [text || 'Loading…']);
}

// Runs an async click handler with a re-entrancy guard: while one submission
// is in flight, further clicks on the same button are ignored (the button is
// also visibly disabled), then it is re-enabled whatever the outcome.
function guarded(button, fn) {
  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.setAttribute('disabled', 'disabled');
    button.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } finally {
      busy = false;
      button.removeAttribute('disabled');
      button.removeAttribute('aria-busy');
    }
  });
  return button;
}

// A message slot: show(kind, text, testid) replaces the current message;
// show(null) empties it.
function messageSlot() {
  const el = h('div', { class: 'msg-slot' }, []);
  el.show = (kind, text, testid) => {
    clear(el);
    if (kind) el.appendChild(message(kind, text, testid));
  };
  return el;
}

function directionTag(p) {
  const sent = p.from_user_id === state.me.user_id;
  return h('span', { class: `direction-tag ${sent ? 'sent' : 'received'}` }, [sent ? 'Sent' : 'Received']);
}

// The authorize form is shown on both / and /authorizations; `onDone` lets the
// host screen refresh whatever it displays after a successful hold.
function buildAuthorizeForm(onDone) {
  const handle = h('input', { type: 'text', autocomplete: 'off', 'data-testid': 'authorize-handle' });
  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'data-testid': 'authorize-amount' });
  const note = h('input', { type: 'text', autocomplete: 'off', 'data-testid': 'authorize-note' });
  const visibility = h('select', { 'data-testid': 'authorize-visibility' }, [
    h('option', { value: 'public' }, ['Public']),
    h('option', { value: 'private' }, ['Private']),
  ]);
  const slot = messageSlot();
  const submit = h('button', { class: 'btn', 'data-testid': 'authorize-submit' }, ['Place hold']);
  guarded(submit, async () => {
    const amt = parseAmount(amount.value, state.me.minor_units);
    if (amt === null) {
      slot.show('error', 'Enter a valid amount, for example 15.00.', 'authorize-error');
      return;
    }
    const body = { to_handle: handle.value.trim(), amount: amt, note: note.value, visibility: visibility.value };
    const key = keyFor('authorize', formSignature(body));
    try {
      await apiFetch('/authorizations', { method: 'POST', key, body });
      slot.show('success', `Hold placed: ${moneyOf(amt)} is reserved for ${body.to_handle}.`, 'authorize-success');
    } catch (e) {
      if (e instanceof UncertainError) slot.show('uncertain', UNCERTAIN_TEXT, 'authorize-uncertain');
      else slot.show('error', e.message, 'authorize-error');
      return;
    }
    await onDone();
  });
  return h('section', { class: 'card', 'aria-labelledby': 'authorize-title' }, [
    h('h2', { id: 'authorize-title' }, ['Hold money for someone']),
    h('p', { class: 'hint' }, ['A hold reserves funds without sending them. The recipient can collect it later, or it is released when it expires.']),
    field('To handle', handle),
    field('Amount', amount),
    field('Note (optional)', note),
    field('Visibility', visibility),
    slot,
    submit,
  ]);
}

// ---------------------------------------------------------------------------
// Home: balance, pay form, request form, activity feed
// ---------------------------------------------------------------------------

async function renderHome(main) {
  const headline = h('div', { class: 'balance-headline', 'data-testid': 'wallet-available' }, []);
  const sub = h('div', { class: 'balance-sub' }, []);
  const refreshBtn = h('button', { class: 'btn secondary small', 'data-testid': 'wallet-refresh' }, ['Refresh']);

  function paintBalance() {
    const me = state.me;
    headline.textContent = moneyOf(me.available);
    headline.setAttribute('data-amount', String(me.available));
    clear(sub);
    sub.appendChild(h('span', {}, ['Total ', h('strong', { 'data-testid': 'wallet-balance', 'data-amount': String(me.total) }, [moneyOf(me.total)])]));
    if (me.held > 0) {
      sub.appendChild(h('span', { class: 'held' }, ['On hold ', h('strong', { 'data-testid': 'wallet-held', 'data-amount': String(me.held) }, [moneyOf(me.held)])]));
    }
  }
  paintBalance();

  const balanceCard = h('section', { class: 'card balance-block', 'aria-label': 'Wallet' }, [
    h('div', { class: 'balance-row' }, [
      h('div', {}, [h('div', { class: 'balance-label' }, ['Available to spend']), headline]),
      refreshBtn,
    ]),
    sub,
  ]);

  const activitySlot = h('div', {}, [h('section', { class: 'card' }, [h('h2', {}, ['Activity']), loadingBlock('Loading activity…')])]);

  // Latest refresh wins: every refresh takes a sequence number and only the
  // highest one issued so far may write to the page, so a slow earlier
  // response can never overwrite a later one.
  async function refreshWalletAndFeed() {
    const mySeq = ++state.refreshSeq;
    try {
      const [me, activity] = await Promise.all([
        apiFetch('/me', { accept: 'application/json' }),
        apiFetch('/activity', { accept: 'application/json' }),
      ]);
      if (mySeq !== state.refreshSeq) return;
      state.me = me;
      paintBalance();
      renderActivity(activitySlot, activity.payments || []);
    } catch (e) {
      if (mySeq !== state.refreshSeq) return;
      // Keep the last known-good numbers on screen and say the refresh failed.
      if (!activitySlot.querySelector('[data-testid="activity-list"], [data-testid="empty-activity"]')) {
        clear(activitySlot);
        activitySlot.appendChild(h('section', { class: 'card' }, [h('h2', {}, ['Activity']), message('error', 'Activity could not be loaded.', 'activity-error')]));
      }
    }
  }
  // Deliberately NOT guarded: a second click while an earlier refresh is in
  // flight must issue a new read that supersedes it.
  refreshBtn.addEventListener('click', refreshWalletAndFeed);

  // Pay form ---------------------------------------------------------------
  const payHandle = h('input', { type: 'text', autocomplete: 'off', 'data-testid': 'pay-handle' });
  const payAmount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'data-testid': 'pay-amount' });
  const payNote = h('input', { type: 'text', autocomplete: 'off', 'data-testid': 'pay-note' });
  const payVisibility = h('select', { 'data-testid': 'pay-visibility' }, [
    h('option', { value: 'public' }, ['Public']),
    h('option', { value: 'private' }, ['Private']),
  ]);
  const payMsg = messageSlot();
  const paySubmit = h('button', { class: 'btn', 'data-testid': 'pay-submit' }, ['Pay']);
  guarded(paySubmit, async () => {
    const amt = parseAmount(payAmount.value, state.me.minor_units);
    if (amt === null) {
      payMsg.show('error', 'Enter a valid amount, for example 15.00.', 'pay-error');
      return;
    }
    const body = { to_handle: payHandle.value.trim(), amount: amt, note: payNote.value, visibility: payVisibility.value };
    // Same content -> same key (an unchanged resubmit is a replay); any change
    // to a field mints a new key.
    const key = keyFor('pay', formSignature(body));
    try {
      await apiFetch('/payments', { method: 'POST', key, body });
      payMsg.show('success', `Sent ${moneyOf(amt)} to ${body.to_handle}.`, 'pay-success');
    } catch (e) {
      if (e instanceof UncertainError) {
        // Unknown outcome: not a refusal. The form stays as it is so Pay
        // retries with the same key and body.
        payMsg.show('uncertain', UNCERTAIN_TEXT, 'pay-uncertain');
        return;
      }
      payMsg.show('error', e.message, 'pay-error');
    }
    await refreshWalletAndFeed();
  });

  const payForm = h('section', { class: 'card', 'aria-labelledby': 'pay-title' }, [
    h('h2', { id: 'pay-title' }, ['Send money']),
    field('To handle', payHandle),
    field('Amount', payAmount),
    field('Note (optional)', payNote),
    field('Visibility', payVisibility),
    payMsg,
    paySubmit,
  ]);

  // Request form ------------------------------------------------------------
  const reqHandle = h('input', { type: 'text', autocomplete: 'off', 'data-testid': 'request-handle' });
  const reqAmount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'data-testid': 'request-amount' });
  const reqNote = h('input', { type: 'text', autocomplete: 'off', 'data-testid': 'request-note' });
  const reqMsg = messageSlot();
  const reqSubmit = h('button', { class: 'btn', 'data-testid': 'request-submit' }, ['Request']);
  guarded(reqSubmit, async () => {
    const amt = parseAmount(reqAmount.value, state.me.minor_units);
    if (amt === null) {
      reqMsg.show('error', 'Enter a valid amount, for example 15.00.', 'request-error');
      return;
    }
    const body = { payer_handle: reqHandle.value.trim(), amount: amt, note: reqNote.value };
    const key = keyFor('request', formSignature(body));
    try {
      await apiFetch('/requests', { method: 'POST', key, body });
      reqMsg.show('success', `Requested ${moneyOf(amt)} from ${body.payer_handle}.`, 'request-success');
    } catch (e) {
      if (e instanceof UncertainError) reqMsg.show('uncertain', UNCERTAIN_TEXT, 'request-uncertain');
      else reqMsg.show('error', e.message, 'request-error');
    }
  });

  const requestForm = h('section', { class: 'card', 'aria-labelledby': 'request-title' }, [
    h('h2', { id: 'request-title' }, ['Request money']),
    field('From handle', reqHandle),
    field('Amount', reqAmount),
    field('Note (optional)', reqNote),
    reqMsg,
    reqSubmit,
  ]);

  main.appendChild(balanceCard);
  main.appendChild(h('div', { class: 'two-col' }, [payForm, requestForm]));
  main.appendChild(buildAuthorizeForm(refreshWalletAndFeed));
  main.appendChild(activitySlot);

  // The initial load goes through the same sequence-guarded read as every
  // refresh, so a slow first response can never overwrite a later refresh.
  await refreshWalletAndFeed();
}

function renderActivity(slot, payments) {
  clear(slot);
  const card = h('section', { class: 'card' }, [h('h2', {}, ['Activity'])]);
  if (payments.length === 0) {
    card.appendChild(h('div', { class: 'empty-state', 'data-testid': 'empty-activity' }, ['No activity yet. Payments you send or receive will show up here.']));
  } else {
    const sorted = [...payments].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const list = h('ul', { class: 'list', 'data-testid': 'activity-list' }, sorted.map((p) => h('li', {
      class: 'list-item',
      'data-testid': `activity-item-${p.payment_id}`,
      'data-visibility': p.visibility,
    }, [
      h('div', { class: 'list-item-main' }, [
        h('span', { class: 'list-item-parties' }, [
          directionTag(p),
          h('span', { 'data-testid': `activity-parties-${p.payment_id}` }, [`${p.from_handle} → ${p.to_handle}`]),
        ]),
        h('span', { class: 'list-item-meta' }, [humanTime(p.created_at), ' · ', h('span', { class: 'visibility-tag' }, [p.visibility === 'private' ? '\u{1F512} private' : 'public'])]),
        h('span', { class: 'list-item-note', 'data-testid': `activity-note-${p.payment_id}` }, [p.note || '']),
      ]),
      h('span', { class: 'list-item-amount', 'data-testid': `activity-amount-${p.payment_id}` }, [moneyOf(p.amount)]),
    ])));
    card.appendChild(list);
  }
  slot.appendChild(card);
}

// ---------------------------------------------------------------------------
// Requests screen
// ---------------------------------------------------------------------------

async function renderRequests(main) {
  const msg = messageSlot();
  const incomingList = h('ul', { class: 'list', 'data-testid': 'incoming-list' }, []);
  const outgoingList = h('ul', { class: 'list', 'data-testid': 'outgoing-list' }, []);
  const emptySlot = h('div', {});
  const loadingSlot = loadingBlock('Loading requests…');

  let loadSeq = 0; // latest read wins: a slower earlier list read is discarded
  async function load() {
    const mySeq = ++loadSeq;
    let incoming = [];
    let outgoing = [];
    try {
      const [inc, out] = await Promise.all([
        apiFetch('/requests?direction=incoming', { accept: 'application/json' }),
        apiFetch('/requests?direction=outgoing', { accept: 'application/json' }),
      ]);
      if (mySeq !== loadSeq) return;
      incoming = inc.requests || [];
      outgoing = out.requests || [];
    } catch (e) {
      if (mySeq !== loadSeq) return;
      loadingSlot.remove();
      msg.show('error', 'Requests could not be loaded. ' + (e.message || ''), 'request-error');
      return;
    }
    loadingSlot.remove();
    clear(incomingList);
    clear(outgoingList);
    clear(emptySlot);
    if (incoming.length === 0 && outgoing.length === 0) {
      emptySlot.appendChild(h('div', { class: 'empty-state', 'data-testid': 'empty-requests' }, ['No requests yet. Requests you send or receive will show up here.']));
    }
    for (const r of incoming) incomingList.appendChild(requestItem(r, 'incoming'));
    for (const r of outgoing) outgoingList.appendChild(requestItem(r, 'outgoing'));
  }

  // One-click action with a definite outcome handling: success and refusals
  // re-read the list (so stale buttons disappear); a lost response is shown as
  // unknown, keeps its retry key, and also re-reads the list.
  function act(button, path, withKey, okText) {
    guarded(button, async () => {
      const keyId = `req:${path}`;
      try {
        await apiFetch(path, { method: 'POST', ...(withKey ? { key: pendingKey(keyId), body: {} } : {}) });
        settleKey(keyId);
        msg.show('success', okText);
      } catch (e) {
        if (e instanceof UncertainError) {
          msg.show('uncertain', UNCERTAIN_TEXT, 'request-uncertain');
          return;
        }
        settleKey(keyId);
        msg.show('error', e.message, 'request-error');
      }
      await load();
    });
    return button;
  }

  function requestItem(r, direction) {
    const actions = [];
    if (r.status === 'pending' && direction === 'incoming') {
      actions.push(act(h('button', { class: 'btn small', 'data-testid': `request-pay-${r.request_id}` }, ['Pay']), `/requests/${r.request_id}/pay`, true, `Paid ${moneyOf(r.amount)} to ${r.requester_handle}.`));
      actions.push(act(h('button', { class: 'btn secondary small', 'data-testid': `request-decline-${r.request_id}` }, ['Decline']), `/requests/${r.request_id}/decline`, false, 'Request declined.'));
    }
    if (r.status === 'pending' && direction === 'outgoing') {
      actions.push(act(h('button', { class: 'btn secondary small', 'data-testid': `request-cancel-${r.request_id}` }, ['Cancel']), `/requests/${r.request_id}/cancel`, false, 'Request cancelled.'));
    }
    const who = direction === 'incoming' ? `${r.requester_handle} asked you` : `You asked ${r.payer_handle}`;
    return h('li', { class: 'list-item', 'data-testid': `request-item-${r.request_id}`, 'data-status': r.status }, [
      h('div', { class: 'list-item-main' }, [
        h('span', { class: 'list-item-parties' }, [who, h('span', { class: `status-pill ${r.status}` }, [r.status])]),
        h('span', { class: 'list-item-meta' }, [humanTime(r.created_at)]),
        h('span', { class: 'list-item-note' }, [r.note || '']),
      ]),
      h('span', { class: 'list-item-amount', 'data-testid': `request-amount-${r.request_id}` }, [moneyOf(r.amount)]),
      h('div', { class: 'list-item-actions' }, actions),
    ]);
  }

  main.appendChild(h('section', { class: 'card' }, [h('h2', {}, ['Requests to you']), msg, loadingSlot, incomingList]));
  main.appendChild(h('section', { class: 'card' }, [h('h2', {}, ['Requests you sent']), outgoingList]));
  main.appendChild(emptySlot);
  await load();
}

// ---------------------------------------------------------------------------
// Split screen
// ---------------------------------------------------------------------------

// Stage 1 section 9: whole minor units, sum exactly to the amount, larger
// shares to the first participants in the order given.
function equalSplit(amount, n) {
  const base = Math.floor(amount / n);
  const remainder = amount - base * n;
  const shares = [];
  for (let i = 0; i < n; i++) shares.push(base + (i < remainder ? 1 : 0));
  return shares;
}

function renderSplit(main) {
  const amountField = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'data-testid': 'split-amount' });
  const handlesField = h('input', { type: 'text', autocomplete: 'off', placeholder: 'ada, bob, cy', 'data-testid': 'split-handles' });
  const noteField = h('input', { type: 'text', autocomplete: 'off', 'data-testid': 'split-note' });
  const previewSlot = h('div', {});
  const msg = messageSlot();

  const parseHandles = () => handlesField.value.split(',').map((s) => s.trim()).filter(Boolean);

  function updatePreview() {
    clear(previewSlot);
    const amt = parseAmount(amountField.value, state.me.minor_units);
    const handles = parseHandles();
    if (amt === null || handles.length === 0) return;
    const shares = equalSplit(amt, handles.length);
    const rows = handles.map((hd, i) => h('div', { class: 'split-share-row' }, [
      h('span', {}, [hd]),
      h('span', { 'data-testid': `split-share-${hd}` }, [moneyOf(shares[i])]),
    ]));
    previewSlot.appendChild(h('div', { class: 'split-shares', 'data-testid': 'split-preview' }, [h('div', { class: 'split-shares-title' }, ['Each person’s share']), ...rows]));
  }
  amountField.addEventListener('input', updatePreview);
  handlesField.addEventListener('input', updatePreview);

  const submit = h('button', { class: 'btn', 'data-testid': 'split-submit' }, ['Split']);
  guarded(submit, async () => {
    const amt = parseAmount(amountField.value, state.me.minor_units);
    const handles = parseHandles();
    if (amt === null || handles.length === 0) {
      msg.show('error', 'Enter a valid amount and at least one handle.', 'split-error');
      return;
    }
    const body = { amount: amt, participant_handles: handles, note: noteField.value };
    const key = keyFor('split', formSignature(body));
    try {
      const res = await apiFetch('/splits', { method: 'POST', key, body });
      const n = (res.requests || []).length;
      msg.show('success', `Split created: ${n} request${n === 1 ? '' : 's'} sent.`, 'split-success');
    } catch (e) {
      if (e instanceof UncertainError) msg.show('uncertain', UNCERTAIN_TEXT, 'split-uncertain');
      else msg.show('error', e.message, 'split-error');
    }
  });

  main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'split-title' }, [
    h('h2', { id: 'split-title' }, ['Split a bill']),
    h('p', { class: 'hint' }, ['You paid; everyone else gets a request for their share. Include yourself to see your own share.']),
    field('Total amount', amountField),
    field('Handles (comma separated)', handlesField),
    field('Note (optional)', noteField),
    previewSlot,
    msg,
    submit,
  ]));
}

// ---------------------------------------------------------------------------
// Authorizations screen
// ---------------------------------------------------------------------------

async function renderAuthorizations(main) {
  const msg = messageSlot();
  const listSlot = h('ul', { class: 'list', 'data-testid': 'authorization-list' }, []);
  const emptySlot = h('div', {});
  const loadingSlot = loadingBlock('Loading authorizations…');

  let loadSeq = 0; // latest read wins: a slower earlier list read is discarded
  async function load() {
    const mySeq = ++loadSeq;
    let items = [];
    try {
      const result = await apiFetch('/authorizations', { accept: 'application/json' });
      if (mySeq !== loadSeq) return;
      items = result.authorizations || [];
    } catch (e) {
      if (mySeq !== loadSeq) return;
      loadingSlot.remove();
      msg.show('error', 'Authorizations could not be loaded. ' + (e.message || ''), 'authorization-error');
      return;
    }
    loadingSlot.remove();
    clear(listSlot);
    clear(emptySlot);
    if (items.length === 0) {
      emptySlot.appendChild(h('div', { class: 'empty-state', 'data-testid': 'empty-authorizations' }, ['No holds yet. Holds you place or receive will show up here.']));
      return;
    }
    for (const a of items) listSlot.appendChild(authorizationItem(a));
  }

  function authorizationItem(a) {
    const id = a.authorization_id;
    const isIncoming = a.to_handle === state.me.handle;
    const isOutgoing = a.from_handle === state.me.handle;
    const main = [
      h('span', { class: 'list-item-parties' }, [
        `${a.from_handle} → ${a.to_handle}`,
        h('span', { class: `status-pill ${a.status}` }, [a.status]),
      ]),
      h('span', { class: 'list-item-meta' }, [
        a.status === 'open' ? 'Expires ' : 'Expiry ',
        humanTime(a.expires_at),
        ' · ',
        h('span', { 'data-testid': `authorization-expires-${id}` }, [a.expires_at]),
      ]),
    ];
    if (a.captured_amount > 0 && a.status !== 'captured') {
      main.push(h('span', { class: 'list-item-meta' }, [`Collected ${moneyOf(a.captured_amount)} so far`]));
    }
    if (a.note) main.push(h('span', { class: 'list-item-note' }, [a.note]));
    const amountBlock = [h('span', { class: 'list-item-amount', 'data-testid': `authorization-amount-${id}` }, [moneyOf(a.amount)])];
    if (a.status === 'captured') {
      amountBlock.push(h('span', { class: 'list-item-meta' }, ['Collected ', h('span', { 'data-testid': `authorization-captured-${id}` }, [moneyOf(a.captured_amount)])]));
    }

    const actions = [];
    if (isIncoming && a.status === 'open') {
      const amountInput = h('input', {
        type: 'text',
        inputmode: 'decimal',
        autocomplete: 'off',
        'aria-label': `Amount to collect from ${a.from_handle}`,
        'data-testid': `authorization-capture-amount-${id}`,
        value: minorToDecimal(a.remaining_amount, state.me.minor_units),
      });
      const keepOpen = h('input', { type: 'checkbox', id: `keep-${id}` });
      const captureBtn = h('button', { class: 'btn small', 'data-testid': `authorization-capture-${id}` }, ['Collect']);
      guarded(captureBtn, async () => {
        const amt = parseAmount(amountInput.value, state.me.minor_units);
        if (amt === null) {
          msg.show('error', 'Enter a valid amount to collect.', 'authorization-error');
          return;
        }
        // Default (spec): a capture is final and releases the rest. Ticking
        // "keep the rest on hold" sends final:false for further captures.
        const body = { amount: amt, final: !keepOpen.checked };
        const keyId = `cap:${id}:${JSON.stringify(body)}`;
        try {
          await apiFetch(`/authorizations/${id}/capture`, { method: 'POST', key: pendingKey(keyId), body });
          settleKey(keyId);
          msg.show('success', `Collected ${moneyOf(amt)} from ${a.from_handle}.`);
        } catch (e) {
          if (e instanceof UncertainError) {
            msg.show('uncertain', UNCERTAIN_TEXT, 'authorization-uncertain');
            return;
          }
          settleKey(keyId);
          msg.show('error', e.message, 'authorization-error');
        }
        await load();
      });
      actions.push(h('div', { class: 'capture-row' }, [
        amountInput,
        captureBtn,
        h('label', { class: 'keep-open', for: `keep-${id}` }, [keepOpen, ' Keep the rest on hold']),
      ]));
    }
    if (isOutgoing && a.status === 'open') {
      const voidBtn = h('button', { class: 'btn secondary small', 'data-testid': `authorization-void-${id}` }, ['Release hold']);
      guarded(voidBtn, async () => {
        try {
          await apiFetch(`/authorizations/${id}/void`, { method: 'POST' });
          msg.show('success', 'Hold released.');
        } catch (e) {
          if (e instanceof UncertainError) msg.show('uncertain', UNCERTAIN_TEXT, 'authorization-uncertain');
          else msg.show('error', e.message, 'authorization-error');
        }
        await load();
      });
      actions.push(voidBtn);
    }
    return h('li', { class: 'list-item', 'data-testid': `authorization-item-${id}`, 'data-status': a.status }, [
      h('div', { class: 'list-item-main' }, main),
      h('div', { class: 'list-item-amount-block' }, amountBlock),
      h('div', { class: 'list-item-actions' }, actions),
    ]);
  }

  main.appendChild(buildAuthorizeForm(load));
  main.appendChild(h('section', { class: 'card' }, [h('h2', {}, ['Holds']), msg, loadingSlot, listSlot, emptySlot]));
  await load();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

render();
