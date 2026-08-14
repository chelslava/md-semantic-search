# API tokens

## Rotating an API token

When an API token leaks or expires, rotate it before the old one is revoked.

1. Generate a new token in the admin panel.
2. Update every service that references the old token.
3. Verify the new token works with a single request.
4. Revoke the old token only after all services use the new one.

## Token storage

Never commit tokens to the repository. Store them in a secrets manager or a
local env file that is git-ignored. Grant each token the minimal scope its
service actually needs.

## Expiry policy

Set an explicit expiry on every token. A token without an expiry is a
credential you have forgotten about.
