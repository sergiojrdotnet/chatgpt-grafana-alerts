import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../server/config.ts';
import { createApp } from '../server/http.ts';
import { protocolVersion } from '../server/domain.ts';
import { notification, setup } from './helpers.ts';

const env = { DEV_MCP_TOKEN: 'token'.repeat(10), GRAFANA_WEBHOOK_SECRET: 'secret'.repeat(8), STORAGE_KEY: Buffer.alloc(32).toString('base64'), SOURCE_ID: 'production' };

test('Production configuration refuses development tokens and requires explicit OAuth binding', () => {
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }), /development|non-production/);
  assert.throws(() => loadConfig({ ...env, HOST: '0.0.0.0' }), /127.0.0.1/);
  assert.throws(() => loadConfig({ ...env, DEV_MCP_TOKEN: undefined }), /HTTPS/);
  assert.doesNotThrow(() => loadConfig({ ...env, PUBLIC_URL: '', OAUTH_ISSUER: '', OAUTH_JWKS_URL: '' }));
});

test('Streamable HTTP clients initialize, acknowledge readiness, and discover tools and events', async t => {
  const { store, service } = setup();
  const { server } = createApp(loadConfig(env), service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${env.DEV_MCP_TOKEN}` };
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'desktop', version: '1' }
  } };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Authorization: '' }, body: JSON.stringify(initialize) })).status, 401);
  for (const requested of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...initialize, params: { ...initialize.params, protocolVersion: requested } }) });
    assert.equal(response.status, 200);
    const { result } = await response.json() as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string }; resultType?: string } };
    assert.equal(result.protocolVersion, requested);
    assert.deepEqual(result.capabilities, { tools: {}, events: {} });
    assert.equal(result.serverInfo.name, 'chatgpt-grafana-alerts');
    assert.equal(result.resultType, undefined);
    const negotiatedHeaders = { ...headers, 'MCP-Protocol-Version': requested };
    const ready = await fetch(endpoint, { method: 'POST', headers: negotiatedHeaders, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(ready.status, 202);
    assert.equal(await ready.text(), '');
    const catalog = await fetch(endpoint, { method: 'POST', headers: negotiatedHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const listed = await catalog.json() as { result: { tools: { name: string }[] } };
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['list_alerts', 'get_alert', 'subscription_status']);
    const events = await fetch(endpoint, { method: 'POST', headers: negotiatedHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'events/list' }) });
    assert.equal(events.status, 200);
    const definitions = await events.json() as { result: { events: { name: string }[] } };
    assert.deepEqual(definitions.result.events.map(event => event.name), ['grafana.alert.firing', 'grafana.alert.resolved']);
    const status = await fetch(endpoint, { method: 'POST', headers: negotiatedHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'subscription_status', arguments: {} } }) });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { result: { isError?: boolean } }).result.isError, undefined);
  }
  const unsupported = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': 'invalid' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) });
  assert.equal(unsupported.status, 400);
  const missingId = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }) });
  assert.equal(missingId.status, 400);
  const anonymousNotification = await fetch(endpoint, { method: 'POST', headers: { ...headers, Authorization: '' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(anonymousNotification.status, 401);
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const fallback = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...initialize, params: { ...initialize.params, protocolVersion: 'unknown' } }) });
  assert.equal((await fallback.json() as { result: { protocolVersion: string } }).result.protocolVersion, '2025-11-25');
});

test('HTTP webhook intake, MCP discovery, authentication, and request metadata validation', async t => {
  const { store, service } = setup();
  let workerReady = true;
  const { server } = createApp(loadConfig(env), service, () => workerReady);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  workerReady = false;
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  workerReady = true;
  const payload = JSON.stringify(notification());
  const signedAt = Math.floor(Date.now() / 1000).toString();
  const headers = {
    'Content-Type': 'application/json', 'x-grafana-alerting-timestamp': signedAt,
    'x-grafana-alerting-signature': createHmac('sha256', env.GRAFANA_WEBHOOK_SECRET).update(`${signedAt}:${payload}`).digest('hex')
  };
  assert.equal((await fetch(`${base}/webhooks/grafana/production`, { method: 'POST', body: payload, headers })).status, 202);
  const duplicate = await fetch(`${base}/webhooks/grafana/production`, { method: 'POST', body: payload, headers });
  assert.equal((await duplicate.json() as { accepted: number }).accepted, 0);
  assert.equal((await fetch(`${base}/webhooks/grafana/production`, { method: 'POST', body: '{}', headers })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  const rpcHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${env.DEV_MCP_TOKEN}`, 'MCP-Protocol-Version': protocolVersion, 'Mcp-Method': 'server/discover' };
  const body = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {}
  } } };
  const discovery = await fetch(`${base}/mcp`, { method: 'POST', headers: rpcHeaders, body: JSON.stringify(body) });
  assert.equal(discovery.status, 200);
  const discovered = await discovery.json() as { result: { capabilities: unknown; ttlMs: number; cacheScope: string } };
  assert.deepEqual(discovered.result.capabilities, { tools: {}, events: {} });
  assert.ok(Number.isFinite(discovered.result.ttlMs) && discovered.result.ttlMs >= 0, 'MCP discovery requires a nonnegative numeric ttlMs');
  assert.equal(discovered.result.cacheScope, 'private');
  const catalog = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...rpcHeaders, 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ ...body, method: 'tools/list' }) });
  assert.equal(catalog.status, 200);
  const { result } = await catalog.json() as { result: { resultType: string; ttlMs: number; cacheScope: string; tools: { name: string }[] } };
  assert.equal(result.resultType, 'complete');
  assert.ok(Number.isFinite(result.ttlMs) && result.ttlMs >= 0, 'MCP tool catalogs require a nonnegative numeric ttlMs');
  assert.equal(result.cacheScope, 'private');
  assert.deepEqual(result.tools.map(tool => tool.name), ['list_alerts', 'get_alert', 'subscription_status']);
  const mismatch = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...rpcHeaders, 'Mcp-Method': 'tools/list' }, body: JSON.stringify(body) });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json() as { error: { code: number } }).error.code, -32020);
  const origin = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...rpcHeaders, Origin: 'https://untrusted.example' }, body: JSON.stringify(body) });
  assert.equal(origin.status, 403);
});
