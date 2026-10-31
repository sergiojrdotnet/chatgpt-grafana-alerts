# Installation evidence

This records the initial manual installation, not complete ChatGPT alert-delivery
acceptance. Recheck runtime state before future changes.

| Item | Observed value |
| --- | --- |
| Target | Hostinger VPS `srv1807870`, Tailscale SSH alias `aluno-expert-prod` |
| Installed at | 2026-10-31 01:16:21 UTC |
| Version | `v0.2.0` |
| Source revision | `8e849d1b97d38e5a179d323381e71625f90709a8` |
| Image | `ghcr.io/sergiojrdotnet/chatgpt-grafana-alerts@sha256:69192f3f7c159ff57501fb9bc0fe676cfdcaf4b43f8b599d041914aec32a20f2` |
| Compose checkout | `/srv/chatgpt-grafana-alerts`, detached at the release tag |
| Runtime configuration | `/etc/chatgpt-grafana-alerts/server.env`, root-only mode `0600` |
| Release state | `/etc/chatgpt-grafana-alerts/release.json` |
| Host binding | `127.0.0.1:8002` |
| Docker network and alias | `aluno-expert-net`, `grafana-alerts` |
| Authentication | Cloudflare Access, existing `Allow Sergio` policy |
| Origin MCP URL | `https://grafana-alerts-mcp.aluno.expert/mcp` |

The [image pipeline](https://github.com/sergiojrdotnet/chatgpt-grafana-alerts/actions/runs/41154326281)
passed TypeScript checking, all 24 local tests, and the isolated production-image
smoke test before publishing. Installation was executed manually through
Tailscale SSH using the tagged release helper. CI did not connect to the VPS.

## Verified at the destination

- Grafana's existing container reached the new service through Docker DNS.
- A signed local notification stored two clearly labelled synthetic events,
  one firing and one resolved. Both survived a manual application restart.
- An online production snapshot contained both events. Both the application
  and backup containers reported healthy through the final check at
  2026-10-31 01:25:55 UTC.
- The service rejected a forged Access assertion with HTTP `401`.
- Unauthenticated public MCP requests received Cloudflare's OAuth `401` challenge.
- With a real Access assertion, `server/discover`, `events/list`, `tools/list`,
  `list_alerts`, and `subscription_status` succeeded through the protected origin.
- An authenticated public webhook request returned `404`; only MCP and discovery
  paths are routed through the tunnel. The local signed webhook path remains usable.
- The existing Aluno Expert container IDs remained unchanged. They were not
  recreated by this installation. These installation checks are not a complete
  platform telemetry observation or a throughput/capacity test.

Cloudflare Browser Integrity Check rejected the validation client's default
Python user agent. The same client passed after using its truthful application
identifier, `chatgpt-grafana-alerts/0.2.0 (installation validation)`. No Browser
Integrity Check setting, WAF rule, or Access policy was relaxed.

## Aluno Expert MCP Portal

On 2026-10-31 UTC, the protected origin was registered as the `grafana-alerts`
upstream in the existing `aluno-expert` Portal at `https://mcp.aluno.expert`.
Its mapping requires per-user OAuth (`on_behalf: true`) and enables discovered
tools by default. The Access application includes the Portal destination and
allows its `https://mcp.aluno.expert/servers-callback` OAuth redirect. The existing
Grafana and ERPNext mappings and the Portal's optional Code Mode were preserved.

Initial administrator OAuth completed, but capability synchronization rejected
the server's `tools/list` response because required MCP cache metadata was absent.
The `v0.2.1` patch adds `ttlMs` and `cacheScope` to both `tools/list` and
`server/discover`. An HTTP regression test reproduced the missing-field failure
before the fix. TypeScript checking and all 24 tests passed afterward, and the
image pipeline also passed its isolated production-container validation.

The patch was installed manually at 2026-10-31 09:21:03 UTC from revision
`580547334dbdcd082fe6f7ba0fe8d25724bd4be6`, using image
`ghcr.io/sergiojrdotnet/chatgpt-grafana-alerts@sha256:7313aed4a64425e69db3f063d693983732128ae3fa6e14a6c178326ded935d95`.
A fresh online snapshot preceded the update. Both containers reported healthy,
readiness reported version `0.2.1`, and the two retained synthetic events survived.
Existing Aluno Expert container IDs were unchanged.

At 2026-10-31 09:21:13 UTC, Cloudflare capability synchronization succeeded:
`ready`, with `list_alerts`, `get_alert`, and `subscription_status`. Portal
readback preserved per-user OAuth for this upstream, optional Code Mode, and the
existing Grafana and ERPNext mappings, which remained ready with 65 and 13 tools.

After the user completed Portal server selection on 2026-10-31 UTC, the connected
ChatGPT catalog exposed Grafana Alerts alongside Grafana and ERPNext. All three
upstream tools succeeded through that connection: `list_alerts` returned the two
synthetic installation events, `get_alert` retrieved the matching synthetic
firing event, and `subscription_status` returned an empty subscription list.
These checks establish authenticated upstream tool access through the Portal.

Cloudflare's [Portal documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
describes tool/prompt synchronization and modern MCP support. It does not
establish forwarding of this server's draft Events methods. Portal event
discovery and subscription forwarding remain unverified; a configuration entry
or successful tool discovery alone is not event-delivery acceptance. A direct
Portal probe using a CLI Access session received HTTP `401` (`invalid_token`),
so it did not reach an authenticated Events compatibility test.

## Remaining acceptance

Portal event discovery, subscription forwarding, signed callback delivery to
ChatGPT, renewal, and long-outage recovery still need end-to-end validation. The
connected user's subscription list was empty at the tool-access check, and the
history read returned only the two synthetic installation events.

Grafana's existing file-provisioned contact points and notification routing were
not changed. Offsite backup is not configured; the seven rotating snapshots are
local to the VPS and require the separately preserved storage key for recovery.
