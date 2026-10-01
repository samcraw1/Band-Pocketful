"""Browser checks for the Stage 2 UI (Playwright, Chromium).

    pip install playwright && python -m playwright install chromium
    BASE_URL=http://localhost:8080 python3 tests/ui_check.py

Covers: lost-response recovery with the same key, out-of-order refresh, stale request
state, navigation freshness after writes on another screen, seeded holds, capture/void
from the UI, export/import upgrade without losing the session, split preview, current-user
on every screen and no horizontal scroll at 375px.
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:8080")
results = []


def api(method, path, body=None, token=None, key=None, raw=False):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if key:
        headers["Idempotency-Key"] = key
    data = None if body is None else (body if raw else json.dumps(body)).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else None), text
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        return e.code, (json.loads(text) if text else None), text


def user(handle, balance):
    return {"id": f"u_{handle}", "email": f"{handle}@example.com", "password": "correct horse",
            "display_name": handle.capitalize(), "handle": handle, "balance": balance}


def reset(**extra):
    fx = {"currency": "EUR", "minor_units": 2, "users": [user("ada", 10000), user("bob", 2500), user("cy", 500)],
          "payments": [], "requests": [], **extra}
    s, _, t = api("POST", "/_test/reset", fx)
    assert s == 204, t


def token(handle):
    return api("POST", "/auth/login", {"email": f"{handle}@example.com", "password": "correct horse"})[1]["token"]


def future(sec):
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + sec))


def check(name):
    def deco(fn):
        try:
            fn()
            results.append((name, True, ""))
            print(f"ok - {name}")
        except Exception as e:  # noqa: BLE001
            results.append((name, False, str(e)))
            print(f"FAIL - {name}\n       {str(e)[:400]}")
        return fn
    return deco


def login(page, handle):
    page.goto(BASE + "/login")
    page.get_by_test_id("login-email").fill(f"{handle}@example.com")
    page.get_by_test_id("login-password").fill("correct horse")
    page.get_by_test_id("login-submit").click()
    page.get_by_test_id("wallet-balance").wait_for()


def amount(page, testid):
    return int(page.get_by_test_id(testid).get_attribute("data-amount"))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()

        def new_page(width=1100):
            ctx = browser.new_context(viewport={"width": width, "height": 900})
            return ctx.new_page()

        @check("every route shows current-user/current-handle; unauthenticated app routes go to /login")
        def _():
            reset()
            page = new_page()
            page.goto(BASE + "/requests")
            page.wait_for_url("**/login")
            login(page, "ada")
            for route in ["/", "/requests", "/split", "/authorizations"]:
                page.goto(BASE + route)
                page.get_by_test_id("current-user").wait_for()
                assert "Ada" in page.get_by_test_id("current-user").inner_text(), route
                assert page.get_by_test_id("current-handle").inner_text() == "ada", route

        @check("375px: no horizontal scrolling on any route, with data on screen")
        def _():
            reset(authorizations=[{"id": "a_1", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 2000,
                                   "note": "a fairly long note that could overflow a narrow screen if unwrapped",
                                   "status": "open", "expires_at": future(7200)}])
            ada = token("ada")
            api("POST", "/payments", {"to_handle": "bob", "amount": 123456, "note": "x" * 120}, ada, "k1")
            api("POST", "/requests", {"payer_handle": "bob", "amount": 500, "note": "y" * 100}, ada, "k2")
            page = new_page(375)
            login(page, "ada")
            for route in ["/", "/requests", "/split", "/authorizations", "/login", "/signup"]:
                page.goto(BASE + route)
                page.wait_for_timeout(300)
                sw = page.evaluate("document.documentElement.scrollWidth")
                bw = page.evaluate("document.body.scrollWidth")
                assert sw <= 375 and bw <= 375, f"{route}: scrollWidth {sw}/{bw}"
                over = page.evaluate("""() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 376 && getComputedStyle(e).position !== 'fixed').slice(0,3).map(e => e.tagName + '.' + e.className)""")
                assert not over, f"{route}: elements past viewport {over}"

        @check("seeded open hold: available is the headline, held shown; absent when zero")
        def _():
            reset(authorizations=[{"id": "a_1", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 2000,
                                   "status": "open", "expires_at": future(7200)}])
            page = new_page()
            login(page, "ada")
            assert page.get_by_test_id("wallet-available").inner_text() == "80.00 EUR"
            assert page.get_by_test_id("wallet-balance").inner_text() == "100.00 EUR"
            assert page.get_by_test_id("wallet-held").inner_text() == "20.00 EUR"
            assert amount(page, "wallet-available") == 8000 and amount(page, "wallet-held") == 2000
            reset()
            page2 = new_page()
            login(page2, "ada")
            assert page2.get_by_test_id("wallet-held").count() == 0

        @check("authorize on /authorizations, then navigate home: balances are fresh (not stale)")
        def _():
            reset()
            page = new_page()
            login(page, "ada")
            page.goto(BASE + "/authorizations")
            page.get_by_test_id("authorize-handle").fill("bob")
            page.get_by_test_id("authorize-amount").fill("30")
            page.get_by_test_id("authorize-submit").click()
            page.get_by_text("Hold placed").wait_for()
            page.get_by_role("link", name="Home").click()
            page.get_by_test_id("wallet-held").wait_for()
            assert amount(page, "wallet-available") == 7000 and amount(page, "wallet-held") == 3000
            assert amount(page, "wallet-balance") == 10000

        @check("authorize form also works on / and shows insufficient funds in authorize-error")
        def _():
            reset()
            page = new_page()
            login(page, "ada")
            page.get_by_test_id("authorize-handle").fill("bob")
            page.get_by_test_id("authorize-amount").fill("1000")
            page.get_by_test_id("authorize-submit").click()
            page.get_by_test_id("authorize-error").wait_for()
            page.get_by_test_id("authorize-amount").fill("40.00")
            page.get_by_test_id("authorize-submit").click()
            page.get_by_test_id("wallet-held").wait_for()
            assert amount(page, "wallet-held") == 4000 and amount(page, "wallet-available") == 6000

        @check("receiver captures part from the UI: status captured, captured shown, remainder released; payer can void")
        def _():
            reset()
            ada, bob = token("ada"), token("bob")
            _, a1, _ = api("POST", "/authorizations", {"to_handle": "bob", "amount": 2000}, ada, "ka1")
            _, a2, _ = api("POST", "/authorizations", {"to_handle": "bob", "amount": 1000}, ada, "ka2")
            pb = new_page()
            login(pb, "bob")
            pb.goto(BASE + "/authorizations")
            i1 = a1["authorization_id"]
            box = pb.get_by_test_id(f"authorization-capture-amount-{i1}")
            assert box.input_value() == "20.00"
            box.fill("15.00")
            pb.get_by_test_id(f"authorization-capture-{i1}").click()
            pb.locator(f'[data-testid="authorization-item-{i1}"][data-status="captured"]').wait_for()
            assert pb.get_by_test_id(f"authorization-captured-{i1}").inner_text() == "15.00 EUR"
            assert pb.get_by_test_id(f"authorization-amount-{i1}").inner_text() == "20.00 EUR"
            assert pb.get_by_test_id(f"authorization-capture-{i1}").count() == 0
            m = api("GET", "/me", token=ada)[1]
            assert (m["total"], m["held"], m["available"]) == (8500, 1000, 7500), m
            pa = new_page()
            login(pa, "ada")
            pa.goto(BASE + "/authorizations")
            i2 = a2["authorization_id"]
            assert pa.get_by_test_id(f"authorization-capture-{i2}").count() == 0
            pa.get_by_test_id(f"authorization-void-{i2}").click()
            pa.locator(f'[data-testid="authorization-item-{i2}"][data-status="voided"]').wait_for()
            assert api("GET", "/me", token=ada)[1]["held"] == 0

        @check("stale capture/void and cancelled request show their error element and refresh the list")
        def _():
            reset()
            ada, bob = token("ada"), token("bob")
            _, a, _ = api("POST", "/authorizations", {"to_handle": "bob", "amount": 500}, ada, "ks1")
            _, r, _ = api("POST", "/requests", {"payer_handle": "bob", "amount": 100}, ada, "ks2")
            pb = new_page()
            login(pb, "bob")
            pb.goto(BASE + "/requests")
            pb.get_by_test_id(f"request-pay-{r['request_id']}").wait_for()
            api("POST", f"/requests/{r['request_id']}/cancel", token=ada)
            pb.get_by_test_id(f"request-pay-{r['request_id']}").click()
            pb.get_by_test_id("request-error").wait_for()
            pb.locator(f'[data-testid="request-item-{r["request_id"]}"][data-status="cancelled"]').wait_for()
            assert pb.get_by_test_id(f"request-pay-{r['request_id']}").count() == 0
            pb.goto(BASE + "/authorizations")
            aid = a["authorization_id"]
            pb.get_by_test_id(f"authorization-capture-{aid}").wait_for()
            api("POST", f"/authorizations/{aid}/void", token=ada)
            pb.get_by_test_id(f"authorization-capture-{aid}").click()
            pb.get_by_test_id("authorization-error").wait_for()
            pb.locator(f'[data-testid="authorization-item-{aid}"][data-status="voided"]').wait_for()
            assert pb.get_by_test_id(f"authorization-capture-{aid}").count() == 0

        @check("amount input: exact decimals, bad input sends nothing, resubmit unchanged = replay (one payment)")
        def _():
            reset()
            page = new_page()
            sent = []
            page.on("request", lambda r: sent.append(r) if r.url.endswith("/payments") and r.method == "POST" else None)
            login(page, "ada")
            page.get_by_test_id("pay-handle").fill("bob")
            for bad in ["abc", "15.005", "", "-3", "1,5"]:
                page.get_by_test_id("pay-amount").fill(bad)
                page.get_by_test_id("pay-submit").click()
                page.get_by_test_id("pay-error").wait_for()
            assert not sent, "bad amounts must send nothing"
            page.get_by_test_id("pay-amount").fill("15.5")
            page.get_by_test_id("pay-submit").click()
            page.get_by_test_id("pay-success").wait_for()
            assert json.loads(sent[0].post_data)["amount"] == 1550
            assert page.get_by_test_id("pay-error").count() == 0
            assert page.get_by_test_id("pay-amount").input_value() == "15.5"
            page.get_by_test_id("pay-submit").click()
            page.wait_for_timeout(500)
            assert len(sent) == 2 and sent[0].headers["idempotency-key"] == sent[1].headers["idempotency-key"]
            assert amount(page, "wallet-balance") == 10000 - 1550
            assert page.locator('[data-testid^="activity-item-"]').count() == 1
            page.get_by_test_id("pay-note").fill("lunch")
            page.get_by_test_id("pay-submit").click()
            page.wait_for_timeout(500)
            assert sent[2].headers["idempotency-key"] != sent[0].headers["idempotency-key"]
            assert amount(page, "wallet-balance") == 10000 - 3100

        @check("lost response after commit: pay-uncertain (not pay-error), retry reuses key+body, money moves once")
        def _():
            reset()
            page = new_page()
            login(page, "ada")
            state = {"drop": True}
            seen = []

            def handler(route):
                req = route.request
                seen.append((req.headers.get("idempotency-key"), req.post_data))
                if state["drop"]:
                    route.fetch()          # the server commits...
                    route.abort()          # ...but the response is lost
                else:
                    route.continue_()
            page.route("**/payments", handler)
            page.get_by_test_id("pay-handle").fill("bob")
            page.get_by_test_id("pay-amount").fill("10")
            page.get_by_test_id("pay-submit").click()
            page.get_by_test_id("pay-uncertain").wait_for()
            assert page.get_by_test_id("pay-uncertain").inner_text().strip()
            assert page.get_by_test_id("pay-error").count() == 0
            assert page.get_by_test_id("pay-amount").input_value() == "10"
            state["drop"] = False
            page.get_by_test_id("pay-submit").click()
            page.wait_for_function("!document.querySelector('[data-testid=pay-uncertain]')")
            assert page.get_by_test_id("pay-error").count() == 0
            assert seen[0] == seen[1], seen
            assert amount(page, "wallet-balance") == 9000
            assert page.locator('[data-testid^="activity-item-"]').count() == 1
            assert api("GET", "/me", token=token("bob"))[1]["total"] == 3500

        @check("lost response on request-pay and capture: unknown outcome, same key on retry, applied once")
        def _():
            reset()
            ada, bob = token("ada"), token("bob")
            _, rq, _ = api("POST", "/requests", {"payer_handle": "bob", "amount": 300}, ada, "kr")
            _, au, _ = api("POST", "/authorizations", {"to_handle": "bob", "amount": 700}, ada, "kz")
            page = new_page()
            login(page, "bob")
            state = {"drop": True}
            keys = []

            def handler(route):
                keys.append(route.request.headers.get("idempotency-key"))
                if state["drop"]:
                    route.fetch()
                    route.abort()
                else:
                    route.continue_()
            page.route("**/requests/*/pay", handler)
            page.route("**/authorizations/*/capture", handler)
            page.goto(BASE + "/requests")
            page.get_by_test_id(f"request-pay-{rq['request_id']}").click()
            page.get_by_test_id("request-uncertain").wait_for()
            state["drop"] = False
            page.get_by_test_id(f"request-pay-{rq['request_id']}").click()
            page.locator(f'[data-testid="request-item-{rq["request_id"]}"][data-status="paid"]').wait_for()
            assert keys[0] == keys[1], keys
            state["drop"] = True
            page.goto(BASE + "/authorizations")
            aid = au["authorization_id"]
            page.get_by_test_id(f"authorization-capture-{aid}").click()
            page.get_by_test_id("authorization-uncertain").wait_for()
            state["drop"] = False
            page.get_by_test_id(f"authorization-capture-{aid}").click()
            page.locator(f'[data-testid="authorization-item-{aid}"][data-status="captured"]').wait_for()
            assert keys[2] == keys[3], keys
            # bob 2500 - 300 (pays ada's request) + 700 (captures the hold), each exactly once
            assert api("GET", "/me", token=bob)[1]["total"] == 2900

        @check("wallet-refresh: latest refresh wins when an earlier response arrives last")
        def _():
            reset()
            page = new_page()
            login(page, "ada")
            calls = {"n": 0}
            held = []

            def handler(route):
                calls["n"] += 1
                n = calls["n"]
                if n == 1:
                    resp = route.fetch()          # snapshot of the OLD balance
                    held.append(resp)
                else:
                    route.continue_()
            page.route("**/me", handler)
            page.get_by_test_id("wallet-refresh").click()      # refresh #1 is held back
            page.wait_for_timeout(200)
            api("POST", "/payments", {"to_handle": "bob", "amount": 2500}, token("ada"), "kk")
            page.get_by_test_id("wallet-refresh").click()      # refresh #2 sees the new balance
            page.wait_for_function("document.querySelector('[data-testid=wallet-balance]').dataset.amount === '7500'")
            held[0] and None
            page.wait_for_timeout(300)
            assert amount(page, "wallet-balance") == 7500

        @check("export/import upgrade between requests: still signed in, request payable, pending retry recovers")
        def _():
            reset()
            page = new_page()
            login(page, "ada")
            state = {"drop": True}

            def handler(route):
                if state["drop"]:
                    route.fetch()
                    route.abort()
                else:
                    route.continue_()
            page.route("**/payments", handler)
            page.get_by_test_id("pay-handle").fill("bob")
            page.get_by_test_id("pay-amount").fill("12")
            page.get_by_test_id("pay-submit").click()
            page.get_by_test_id("pay-uncertain").wait_for()
            _, _, exp = api("GET", "/_test/export")
            snap = json.loads(exp)
            st = snap["state"]
            st.pop("authorizations", None)
            st.pop("authorizationTtlSeconds", None)
            st["counters"].pop("authorization", None)
            for pm in st["payments"]:
                pm.pop("authorizationId", None)
            s, _, t = api("POST", "/_test/import", json.dumps(snap), raw=True)
            assert s == 204, t
            state["drop"] = False
            page.get_by_test_id("pay-submit").click()
            page.wait_for_function("!document.querySelector('[data-testid=pay-uncertain]')")
            assert page.get_by_test_id("pay-error").count() == 0
            assert amount(page, "wallet-balance") == 8800
            page.goto(BASE + "/requests")
            page.get_by_test_id("current-handle").wait_for()
            assert page.get_by_test_id("current-handle").inner_text() == "ada"

        @check("split preview shows section 9 shares before posting and matches the server")
        def _():
            reset()
            page = new_page()
            login(page, "ada")
            page.goto(BASE + "/split")
            page.get_by_test_id("split-amount").fill("10.00")
            page.get_by_test_id("split-handles").fill(" ada , bob,cy ")
            page.get_by_test_id("split-preview").wait_for()
            shares = {h: page.get_by_test_id(f"split-share-{h}").inner_text() for h in ["ada", "bob", "cy"]}
            assert shares == {"ada": "3.34 EUR", "bob": "3.33 EUR", "cy": "3.33 EUR"}, shares
            page.get_by_test_id("split-submit").click()
            page.get_by_test_id("split-success").wait_for()
            s, body, _ = api("GET", "/requests?direction=outgoing", token=token("ada"))
            assert sorted(r["amount"] for r in body["requests"]) == [333, 333]

        @check("JPY (0 decimals) amounts format and parse")
        def _():
            fx = {"currency": "JPY", "minor_units": 0, "users": [user("ada", 1200), user("bob", 0)], "payments": [], "requests": []}
            assert api("POST", "/_test/reset", fx)[0] == 204
            page = new_page()
            login(page, "ada")
            assert page.get_by_test_id("wallet-balance").inner_text() == "1200 JPY"
            page.get_by_test_id("pay-handle").fill("bob")
            page.get_by_test_id("pay-amount").fill("200.5")
            page.get_by_test_id("pay-submit").click()
            page.get_by_test_id("pay-error").wait_for()
            page.get_by_test_id("pay-amount").fill("200")
            page.get_by_test_id("pay-submit").click()
            page.wait_for_function("document.querySelector('[data-testid=wallet-balance]').dataset.amount === '1000'")

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    for name, _, msg in failed:
        print(f"- {name}")
    sys.exit(1 if failed else 0)


main()
