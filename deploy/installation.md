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

## Remaining acceptance

The upstream has not yet been added to the Aluno Expert MCP Portal. Portal event
discovery, subscription forwarding, signed callback delivery to ChatGPT, renewal,
and long-outage recovery still need end-to-end validation. At the final check,
there were zero active user subscriptions and only the two synthetic test events.

Grafana's existing file-provisioned contact points and notification routing were
not changed. Offsite backup is not configured; the seven rotating snapshots are
local to the VPS and require the separately preserved storage key for recovery.
