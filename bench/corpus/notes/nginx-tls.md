---
title: Nginx TLS termination
aliases: [reverse proxy tls, certbot setup]
tags: [nginx, tls, certs]
type: reference
status: current
---

# Nginx TLS termination

## Server blocks

One `server` block per hostname, each with its own certificate pair.
The default catch-all server must return `444` so a scan by bare IP
never reaches a real upstream.

## Certificates

### Issuing with ACME

`certbot --nginx` edits the server block in place and installs the
renewal timer. For wildcard names the DNS-01 challenge is required —
the HTTP-01 challenge cannot prove control of a whole zone.

### Renewal

The systemd timer runs `certbot renew` twice a day; only certificates
within 30 days of expiry are renewed. After a renewal, `reload nginx`
is automatic via the deploy hook — if the hook is removed, new certs
sit on disk unused until the next manual reload.

### OCSP stapling

`ssl_stapling on` lets nginx fetch the certificate status once per
response window instead of making every client talk to the CA. Verify
with `openssl s_client -status`; an empty OCSP response means the
responder is unreachable from this host, not that the certificate is
invalid.

## Hardening

### Header set

TLS termination is the last place to set HSTS: `Strict-Transport-Security`
with `max-age=31536000` after the rollout is proven, never on day one —
the header cannot be taken back for the max-age period.

### Cipher policy

Pin the Mozilla intermediate profile: TLS 1.2+ only, no CBC, no RSA
key exchange. Re-audit the policy yearly; `testssl.sh` catches drift
between the documented and the actual ciphers.

## Upstream connections

Keep `proxy_http_version 1.1` and an empty `Connection` header so
upstream keep-alive works; without it every proxied request opens a
new TCP connection and the upstream TIME_WAIT queue explodes.
