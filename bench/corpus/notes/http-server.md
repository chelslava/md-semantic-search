# Local HTTP server

## Binding and security

The search daemon binds to `127.0.0.1` by default. Pass `--host 0.0.0.0`
only when you intend to expose it on the network, and put a reverse
proxy or firewall in front.

## Endpoints

- `POST /search` with a JSON body `{"query": "...", "k": 5}`.
- `GET /health` returns `{ok, chunks, model, dim, built}`.

## Request limits

Request bodies are capped at 64 KB. Malformed JSON gets a clear 400,
oversized bodies get 413.
