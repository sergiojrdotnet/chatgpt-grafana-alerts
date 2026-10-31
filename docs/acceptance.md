# Deployment acceptance

The local suite is necessary but does not establish live ChatGPT compatibility.
Complete these checks at the selected deployment before enabling real routing:

1. Verify HTTPS, OAuth discovery, account linking, required token claims, and
   rejection of an unallowlisted subject.
2. Confirm ChatGPT discovers the tools and both event definitions through the
   supported MCP binding. Test Streamable HTTP initialization and MCP 2.0
   discovery separately. Record actual requests if contract differences
   appear; resolve them against current canonical documentation.
3. Subscribe to a filtered firing event in a supported Work cloud chat. Verify
   callback challenge, subscription storage, and expiration.
4. Use Grafana's contact-point test with HMAC and timestamp signing. Confirm the
   server stores it, delivers a signed event, and ChatGPT follows the requested
   behavior. A callback acknowledgement alone does not complete this check.
5. Send firing/resolved grouped alerts and a nonmatching alert. Confirm correct
   filtering and correlation. Repeat an identical notification to check dedup.
6. Restart the server while an alert is queued. Confirm storage and subscription
   survive, and replay keeps the same event ID.
7. Simulate callback timeouts and failures, then recovery. Verify retry limits,
   failed/gone status, and explicit renewal recovery.
8. Leave the endpoint unavailable beyond subscription expiration. Measure the
   host's actual renewal behavior and replay. Do not assume automatic recovery.
9. Stop monitoring in ChatGPT and verify unsubscribe stops delivery. Check expired
   and revoked-source access behavior separately.
10. Exercise real DNS/TLS callbacks, address rebinding rejection, redirects,
    signature rotation, and duplicate deliveries against a controlled receiver.

Outstanding product decisions include hosting, OAuth provider, data retention,
backup ownership, alert volume limits, public distribution, and whether future
versions should integrate live Grafana queries or multiple source permissions.
