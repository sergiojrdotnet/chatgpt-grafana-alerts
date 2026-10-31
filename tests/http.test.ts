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
  assert.deepEqual((await discovery.json() as { result: { capabilities: unknown } }).result.capabilities, { tools: {}, events: {} });
  const mismatch = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...rpcHeaders, 'Mcp-Method': 'tools/list' }, body: JSON.stringify(body) });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json() as { error: { code: number } }).error.code, -32020);
  const origin = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...rpcHeaders, Origin: 'https://untrusted.example' }, body: JSON.stringify(body) });
  assert.equal(origin.status, 403);
});
