# chatgpt-grafana-alerts

This repository contains a self-hosted Grafana webhook receiver, an MCP Events
server, and the ChatGPT plugin source that connects to it.

- Keep source, documentation, identifiers, and commit subjects in English.
- Keep this repository reusable. Deployment-specific hostnames, account details,
  network names, and installation evidence belong outside the repository.
- Prefer descriptive names and structure over comments explaining the code.
- Use Conventional Commit subjects.
- Image pipelines only validate, build, and publish images. Installation and
  updates are manual VPS operations; never add CI-driven SSH or automatic rollout.
- Run `npm run check` after behavior changes. Add tests for authentication,
  webhook verification, delivery, replay, and subscription lifecycle changes.
- Preserve the distinction between webhook receipt and completed agent work.
- Follow the supported ChatGPT MCP Events subset documented in `docs/protocol.md`.
  The upstream events protocol is a draft; recheck canonical sources before
  changing its contract.
- Never disable callback address validation, DNS pinning, signature checking,
  or source/principal authorization to make an integration work.
- Keep plugin source under `plugin/`. Generate deployable MCP configuration only
  from the actual server endpoint; do not publish placeholder connections.
- Do not deploy infrastructure, change Grafana notification routing, or publish
  an account plugin as part of an ordinary code change unless requested.
