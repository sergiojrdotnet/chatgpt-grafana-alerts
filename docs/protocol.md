# Protocol contract

The endpoint implements the modern MCP `2026-07-28` HTTP request/response binding,
Streamable HTTP initialization for `2025-11-25`, `2025-06-18`, and `2025-03-26`,
and the webhook subset of ChatGPT's draft MCP Events integration. It uses a small
explicit HTTP adapter rather than a full MCP SDK. It does not implement SSE
streams, polling, resources, prompts, or arbitrary MCP extensions.

## MCP 2.0 binding

Each authenticated request to `POST /mcp` carries JSON-RPC 2.0 with an ID, a
method, and `params`. Modern clients supply these mirrored headers:

- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method`, matching `method`
- `Mcp-Name` for `tools/call`, matching the tool name

`params._meta` includes `io.modelcontextprotocol/protocolVersion`,
`io.modelcontextprotocol/clientInfo` with name/version, and
`io.modelcontextprotocol/clientCapabilities`. Responses include
`resultType: complete`. Unsupported versions and header/body mismatches are
rejected. The endpoint rejects supplied origins other than its configured
public origin.

`server/discover` and `tools/list` include the required `ttlMs` and `cacheScope`
fields from the [MCP result schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts).
They use `ttlMs: 0` and `cacheScope: private`, so clients may fetch fresh catalogs
and must not reuse them across authorization contexts.

## Streamable HTTP binding

Clients send an authenticated `initialize` request with `protocolVersion`,
`capabilities`, and `clientInfo`. The server returns the matching supported
version, or its latest Streamable HTTP version if the offered version is unknown,
along with server identity and tools/events capabilities. These requests do not
require MCP 2.0 mirrored headers or metadata.

Subsequent requests carry the negotiated `MCP-Protocol-Version`. In accordance
with the transport's compatibility fallback, an absent version header is treated
as `2025-03-26`. Unsupported supplied versions are rejected. Modern version,
method, or protocol metadata markers always select the stricter MCP 2.0
validation instead of falling back to Streamable HTTP.

The adapter is stateless and issues no transport session ID. Each request and
notification requires authentication. Notifications receive an empty HTTP `202`;
request responses are JSON objects without MCP 2.0's `resultType` or catalog
cache fields. `GET /mcp` returns `405` because the endpoint offers no SSE stream.
Both bindings use the same authorization, tools, event filters, callback
verification, and durable subscription storage. A desktop client's ability to
initialize and read tools does not establish host support for Events tasks.

## Methods

| Method | Behavior |
| --- | --- |
| `initialize` | Negotiate Streamable HTTP version, identity, tools, and events |
| `notifications/*` | Acknowledge authenticated Streamable HTTP notifications |
| `server/discover` | Advertise version, identity, tools, and events |
| `ping` | Respond without side effects |
| `events/list` | Advertise firing/resolved events and their schemas |
| `events/subscribe` | Verify a signed callback challenge and persist a subscription |
| `events/unsubscribe` | Stop the authenticated principal's matching subscription |
| `tools/list` | Advertise retained-history and subscription-status tools |
| `tools/call` | Execute an advertised read tool |

Subscription arguments are `{ source, labels? }`. Labels use exact equality;
omitting them matches all labels for the source. Subscription identity is
derived from the principal, callback URL, event name, and canonical arguments.
Refresh updates that identity instead of creating a duplicate.

Callback verification and event delivery use Standard Webhooks signing. The
sender verifies HTTPS destinations, rejects nonpublic IP ranges, validates all
DNS results, pins the connection to a validated address, preserves TLS hostname
verification, and never follows redirects. Each delivery rechecks DNS. The
worker signs once per attempt with a fresh timestamp and the same event ID.
Secret rotation overlaps old and new signatures for one minute.

Cursors are authenticated, opaque positions scoped to the subscription. They
cannot be transferred between principals, event filters, or callbacks. Events
are delivered serially within a subscription, and its cursor never advances
past an unacknowledged matching event. Filtered events can advance progress.
Revision checks prevent an in-flight request from overwriting a newer refresh.
Replays can redeliver previously acknowledged events so the host can deduplicate.
`maxAgeMs` is explicitly unsupported; no retained history is automatically pruned.

HTTP `2xx` acknowledges receipt. Network errors, `408`, `429`, and `5xx` receive
exponential backoff, capped at five minutes, for at most eight attempts. Other
statuses stop automatic retry. `410` marks the subscription gone. A `413` leaves
the event retained but blocks delivery. Status reports never claim agent task
completion.

The [OpenAI integration guide](https://developers.openai.com/plugins/build/mcp-events)
and the [upstream draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)
currently differ on some error allocations. Callback verification errors follow
the OpenAI guide's `-32015` for this initial adapter; verify the host's current
behavior before relying on cross-client compatibility.
