# Pocketful Stage 2 — Run instructions

No dependencies to install; the service uses only Node's standard library. The browser UI
(HTML, CSS and JS) is inlined into the served page, so the service needs no outbound network
at runtime.

## Build and run

```sh
docker build -t pocketful-stage-2 stage-2
docker run --rm -e PORT=8080 -p 8080:8080 pocketful-stage-2
```

The service listens on `0.0.0.0:$PORT` (default `8080`) and is healthy at
`GET /health` within a few seconds of start. Open `http://localhost:8080/` for the app.

## Local (no Docker)

```sh
cd stage-2
node src/server.js
```

## Tests

Author's own tests live in `stage-2/tests/`. Run them against a running instance:

```sh
cd stage-2
BASE_URL=http://localhost:8080 node tests/run.js      # Stage 1 behaviour (concurrency, idempotency, export/import)
BASE_URL=http://localhost:8080 node tests/stage2.js   # Stage 2: holds, captures, void, expiry, upgrade, negotiation
```

Browser behaviour (lost responses, out-of-order refresh, 375px layout, stale state) is covered
by `tests/ui_check.py` (Playwright; `pip install playwright && python -m playwright install chromium`):

```sh
BASE_URL=http://localhost:8080 python3 tests/ui_check.py
```
