# Pocketful Stage 4 — Run instructions

No dependencies to install; the service uses only Node's standard library. The browser UI
(HTML, CSS and JS) is inlined into the served page, so the service needs no outbound network
at runtime.

## Build and run

```sh
docker build -t pocketful-stage-4 stage-4
docker run --rm -e PORT=8080 -p 8080:8080 pocketful-stage-4
```

The service listens on `0.0.0.0:$PORT` (default `8080`) and is healthy at
`GET /health` within a few seconds of start. Open `http://localhost:8080/` for the app.

## Local (no Docker)

```sh
cd stage-4
node src/server.js
```

## Tests

Author's own tests live in `stage-4/tests/`. Run them against a running instance:

```sh
cd stage-4
BASE_URL=http://localhost:8080 node tests/run.js      # Stage 1 behaviour (concurrency, idempotency, export/import)
BASE_URL=http://localhost:8080 node tests/stage2.js   # Stage 2: holds, captures, void, expiry, upgrade, negotiation
BASE_URL=http://localhost:8080 node tests/stage4.js   # Stage 4: refunds, batch corrections, snapshots in export/import, upgrade from stage-1..3, concurrency
BASE_URL=http://localhost:8080 node tests/stage3.js   # Stage 3: as_of/known_at views, statements and snapshots, corrections,
                                                      # historical holds, upgrade from real stage-1/stage-2 exports, concurrency
```

Browser behaviour (lost responses, out-of-order refresh, 375px layout, stale state) is covered
by `tests/ui_check.py` (Playwright; `pip install playwright && python -m playwright install chromium`):

```sh
BASE_URL=http://localhost:8080 python3 tests/ui_check.py
```
