# Installation and manual updates

GitHub Actions only validates, builds, and publishes the Docker image. A version
tag matching `package.json` triggers `.github/workflows/release.yml`; the pipeline
does not SSH into a server, deploy containers, modify Grafana, or configure
Cloudflare. Installing or updating is an explicit operation inside the VPS.

## VPS topology

Run one Compose project named `chatgpt-grafana-alerts`, independent of the other
projects on the server. `compose.yaml` attaches the application to the existing
`aluno-expert-net` network with alias `grafana-alerts`. Grafana can send signed
webhooks to `http://grafana-alerts:3000/webhooks/grafana/aluno-expert` when
`SOURCE_ID=aluno-expert`. That URL stays inside the Docker network. Grafana's
`localhost` points to its own container and must not be used for this destination.

The application publishes only `127.0.0.1:8002`. The host's `cloudflared` can reach
it there. Only the MCP endpoint and required discovery paths should be routed
through a Cloudflare Access-protected hostname; webhook and health paths remain
local. No new public VPS listening port is needed.

The application runs as a non-root user, with a read-only root filesystem,
dropped capabilities, no privilege escalation, bounded logs, a 256 MiB memory
limit, and a 0.5 CPU limit. The backup service has no network, reads the data
volume read-only, and has separate 128 MiB / 0.25 CPU limits. These are initial
operating bounds, not a capacity guarantee.

## Authentication

Choose one production mode. `DEV_MCP_TOKEN` must be absent in production.

### Cloudflare Access

Use `production.env.example` as the configuration shape. Managed OAuth issues
opaque client tokens. Cloudflare resolves those tokens and sends an identity
JWT to the origin in `Cf-Access-Jwt-Assertion`. The server validates its RS256
signature, exact issuer, application audience, expiry, subject, application type,
and allowed email. A bearer token alone never authenticates in this mode.

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `cloudflare` |
| `PUBLIC_URL` | Canonical HTTPS origin, without a path or trailing slash |
| `CF_ACCESS_TEAM_DOMAIN` | Actual organization domain ending in `.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Exact audience of this MCP server's Access application |
| `CF_ACCESS_ALLOWED_EMAILS` | Comma-separated allowed human email addresses |

Use an Access MCP application with Managed OAuth and the intended Access policy.
Do not reuse another application's audience. Preserve per-user authorization
when adding the server to a Portal. An admin credential shared by the Portal
would otherwise make all upstream subscriptions belong to that admin identity.
Validate event forwarding through the Portal independently of tool discovery.

### External OAuth

With `AUTH_MODE=oauth`, configure `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, and
`OAUTH_ALLOWED_SUBJECTS`. The external provider must support authorization-code
with PKCE S256 and the OpenAI client's registration mechanism. Tokens require
the configured issuer, audience `<PUBLIC_URL>/mcp`, allowed `sub`, `exp`, `iat`,
and scope `alerts:read`. Supported algorithms are RS256, ES256, and EdDSA.

## Initial bootstrap

1. Create `/etc/chatgpt-grafana-alerts` with root-only access and a `server.env`
   file with mode `0600`. Set the chosen authentication mode, `SOURCE_ID`,
   `GRAFANA_WEBHOOK_SECRET`, and `STORAGE_KEY` as well as its auth settings.
   Generate separate random values for the webhook secret and the base64-encoded
   32-byte storage key. Preserve this file securely outside the Git checkout.
2. Clone the public repository into `/srv/chatgpt-grafana-alerts`. This is a
   source checkout for versioned Compose configuration and manual operations;
   the VPS does not build the application image.
3. Check out the desired release tag, resolve the published image's digest, and
   verify its source revision label against that tag.
4. Run the manual release helper inside the VPS:

```sh
cd /srv/chatgpt-grafana-alerts
git fetch origin --tags
git checkout --detach vX.Y.Z
bash deploy/release.sh vX.Y.Z ghcr.io/sergiojrdotnet/chatgpt-grafana-alerts@sha256:ACTUAL_DIGEST
```

Replace the illustrative version and digest with the real published release.
The helper requires a clean tagged checkout and immutable digest, verifies the
image's source revision label, pulls images, and waits for both services to be
healthy. It records the deployed tag, revision, digest, and time under
`/etc/chatgpt-grafana-alerts/release.json`. Nothing in CI calls this helper.

The helper attempts to restore the prior image if startup fails, or stops the
initial project while preserving volumes. Image rollback does not restore
database schema or environment configuration. Review compatibility and use the
matching release's Compose file and a verified backup when rollback requires it.

## Persistence, readiness, and backup

SQLite data and backup snapshots use separate named volumes. Preserve the
matching `STORAGE_KEY`; startup refuses a database created with another key.
`/healthz` is process liveness. `/readyz` checks a database query and delivery
worker progress; Docker health checks use readiness. Both report the image's
application version. Docker's restart policy handles process exit and host
reboots; an unhealthy status alone does not restart a container.

The backup service uses SQLite's online backup API, checks snapshot integrity,
and retains seven snapshots taken six hours apart. It retries failures after
five minutes. Its health check requires a successful backup within seven hours.
Restore a selected snapshot to a fresh data volume while the application is
stopped, using the matching storage key. Validate its integrity, history, and
subscriptions before starting production. The automated suite exercises this
restore path. Local snapshots do not protect against VPS loss; offsite backup
and storage-key rotation remain unconfigured.

JWT validation is offline. Delivery never outlives the assertion/token used to
grant a subscription. Removing an allowed subject or email from runtime
configuration and recreating the service stops its delivery, but provider-side
revocation may not be detected until token expiration.

Grafana alert routing remains separate. Its file-provisioned contact points
must change through the owning repository and release process after this server
passes installation checks. Do not replace existing notifications during setup.
