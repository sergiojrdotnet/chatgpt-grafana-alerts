# Deployment

No infrastructure has been provisioned. Supply a hostname, external OAuth
provider, and persistent storage before connecting a production ChatGPT plugin.

## Runtime

Use Node.js 26, one application process, and a persistent local filesystem for
SQLite. The Dockerfile can be built from the repository root:

```sh
docker build -f deploy/Dockerfile -t chatgpt-grafana-alerts .
```

Mount a writable volume at `/app/data` for the non-root `node` user. Pass runtime
environment variables explicitly. The production image does not contain `.env`,
development dependencies, tests, or plugin source. Expose it through an HTTPS
reverse proxy; restrict backend access to that proxy and set request-size and
rate limits there. `/healthz` is a process liveness endpoint, not a delivery or
database health guarantee.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `HOST` | `0.0.0.0` inside the container; loopback for a local reverse proxy |
| `PORT` | Internal HTTP port, default `3000` |
| `DATABASE_PATH` | Persistent SQLite path |
| `SOURCE_ID` | Stable identifier for this one Grafana source |
| `GRAFANA_WEBHOOK_SECRET` | Shared HMAC secret, at least 32 characters |
| `STORAGE_KEY` | Base64-encoded 32-byte encryption/cursor key; preserve with backups |
| `PUBLIC_URL` | Canonical HTTPS origin, without a path or trailing slash |
| `OAUTH_ISSUER` | Exact trusted authorization-server issuer |
| `OAUTH_JWKS_URL` | Trusted provider's HTTPS JWKS URL |
| `OAUTH_ALLOWED_SUBJECTS` | Comma-separated allowed OAuth subject IDs |

`DEV_MCP_TOKEN` must be absent in production. The server fails closed when the
required production settings are missing. All allowed users access the same
source's history. Separate tenants or independently authorized sources need
separate instances in this initial implementation.

## OAuth provider

The server is an OAuth resource server, not an authorization server. Configure
your chosen external identity provider for authorization-code + PKCE with S256
and the OpenAI client's supported registration mechanism. Publish the provider's
OAuth/OIDC discovery metadata. Register the exact redirect URI displayed by the
ChatGPT connection setup rather than guessing one.

Access tokens must carry the configured issuer, the exact audience
`<PUBLIC_URL>/mcp`, an allowlisted `sub`, `exp`, `iat`, and scope `alerts:read`.
Supported JWT algorithms are RS256, ES256, and EdDSA. The resource server exposes
protected-resource metadata at `/.well-known/oauth-protected-resource` and points
to it in its authentication challenge. Provider setup, resource parameter
handling, and login must be verified with ChatGPT before declaring integration
complete.

Delivery authorization uses the configured subject allowlist and never outlives
the token used to grant/refresh a subscription. Removing a subject from runtime
configuration and restarting stops its delivery. JWT validation is offline;
immediate provider-side token/grant revocation is not detected before token
expiry. Provider introspection or revocation synchronization is not implemented.

## Storage and operations

Back up SQLite using a consistent SQLite backup/snapshot procedure, including
WAL state when applicable. Preserve the matching storage key separately. Stop
the application before restoring. There is no automated backup, pruning, or
storage-key rotation command yet.

The worker retries transient failures and retains undelivered history, but does
not provision a second notification channel. Monitor its process, disk usage,
expired subscriptions, and failed deliveries through operational tooling. Keep
the existing Grafana notification route while validating the new integration.

This initial application has no deployment workflow. GitHub CI runs validation;
it does not publish images, deploy, change Grafana settings, or install a plugin.
