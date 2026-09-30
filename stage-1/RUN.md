# Pocketful Stage 1 — Run instructions

No dependencies to install; the service uses only Node's standard library.

## Build and run

```sh
docker build -t pocketful-stage-1 stage-1
docker run --rm -e PORT=8080 -p 8080:8080 pocketful-stage-1
```

The service listens on `0.0.0.0:$PORT` (default `8080`) and is healthy at
`GET /health` within a few seconds of start.

## Local (no Docker)

```sh
cd stage-1
node src/server.js
```

## Tests

Author's own tests (concurrency, idempotency, export/import, conservation) live in
`stage-1/tests/`. Run them against a running instance:

```sh
cd stage-1
BASE_URL=http://localhost:8080 node tests/run.js
```
