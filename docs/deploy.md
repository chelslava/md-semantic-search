# Deployment guide (issue #126)

Headless deployment of `mdss serve` via Docker, with authentication, health
checks and a reverse-proxy TLS pattern.

## Quick start

```bash
git clone https://github.com/chelslava/md-semantic-search && cd md-semantic-search
mkdir notes && cp -r /path/to/your/markdown/* notes/
echo "$(openssl rand -hex 32)" > mdss_key.txt   # API key, never committed
docker compose up -d
```

First start downloads the embedding model (~280 MB) into the `model-cache`
volume and builds the index from `/notes`. Check readiness:

```bash
curl http://127.0.0.1:8747/health
curl http://127.0.0.1:8747/search \
  -H "Authorization: Bearer $(cat mdss_key.txt)" \
  -H 'content-type: application/json' \
  -d '{"query":"failover runbook","k":5}'
```

## Resource footprint

| Component | Expectation |
|---|---|
| Embedding model resident | ~300–400 MB RSS (e5-base q8) after warm-up |
| Index (10k chunks) | tens of MB RAM |
| Startup | +model download (~280 MB) and full index build on FIRST boot only |

## Security posture

- Container runs as **non-root** user `mdss`; filesystem may be mounted
  read-only except `/cache`.
- Notes are mounted **read-only** (`./notes:/notes:ro`) — mdss never mutates
  sources.
- The daemon requires `MDSS_API_KEY_FILE` when binding non-loopback; inside
  compose it binds `0.0.0.0` but the port is published on host loopback only.
- Rate limiting / concurrency caps from the serve hardening apply
  (`MDSS_RATE_LIMIT`, `MDSS_MAX_CONCURRENCY`).
- Model weights come from the Hugging Face hub at first run; pin an exact
  model with `--model <alias>` for reproducibility.

## Reverse-proxy TLS

```nginx
server {
  listen 443 ssl;
  server_name search.example.com;
  ssl_certificate     /etc/letsencrypt/live/search.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/search.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8747;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

Caddy equivalent:

```caddyfile
search.example.com {
  reverse_proxy 127.0.0.1:8747
}
```

## MCP over stdio in Docker

For agents that speak stdio, run the container interactively against the same
image (no port publishing needed):

```bash
docker run -i --rm -v model-cache:/cache -v "$PWD/notes:/notes:ro" \
  ghcr.io/chelslava/md-semantic-search:latest mcp --db /notes
```
