import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticator } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';

test('Cloudflare assertions require the configured issuer, application audience, signature, identity, and expiry', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const config = loadConfig({
    AUTH_MODE: 'cloudflare', PUBLIC_URL: 'https://alerts.example.com', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'a'.repeat(64), CF_ACCESS_ALLOWED_EMAILS: 'alice@example.com',
    GRAFANA_WEBHOOK_SECRET: 'b'.repeat(32), STORAGE_KEY: Buffer.alloc(32).toString('base64')
  });
  const keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  const auth = authenticator(config, keys);
  const now = Math.floor(Date.now() / 1000);
  const token = (overrides: Record<string, unknown> = {}) => new SignJWT({
    iss: 'https://team.cloudflareaccess.com', aud: ['a'.repeat(64)], sub: 'subject-id',
    email: 'alice@example.com', type: 'app', iat: now, exp: now + 300, ...overrides
  }).setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
  const valid = await token();
  const principal = await auth.authenticate('Bearer oauth:opaque-token', valid);
  assert.ok(principal);
  assert.equal(auth.authorized(principal.id), true);
  assert.equal(await auth.authenticate(`Bearer ${valid}`), undefined);
  for (const override of [
    { iss: 'https://other.cloudflareaccess.com' }, { aud: ['c'.repeat(64)] }, { exp: now - 1 },
    { email: 'bob@example.com' }, { type: 'service' }, { sub: '' }, { email: undefined }
  ]) assert.equal(await auth.authenticate(undefined, await token(override)), undefined);
  const other = await generateKeyPair('RS256');
  const forged = await new SignJWT({ iss: 'https://team.cloudflareaccess.com', aud: ['a'.repeat(64)], sub: 'subject-id', email: 'alice@example.com', type: 'app', iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: 'RS256' }).sign(other.privateKey);
  assert.equal(await auth.authenticate(undefined, forged), undefined);
  config.accessEmails.clear();
  assert.equal(auth.authorized(principal.id), false);
  assert.equal(await auth.authenticate(undefined, valid), undefined);
});

test('Cloudflare configuration rejects mixed auth modes and missing allowlists', () => {
  const config = { AUTH_MODE: 'cloudflare', PUBLIC_URL: 'https://alerts.example.com', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'a'.repeat(64), CF_ACCESS_ALLOWED_EMAILS: 'alice@example.com', GRAFANA_WEBHOOK_SECRET: 'b'.repeat(32), STORAGE_KEY: Buffer.alloc(32).toString('base64') };
  assert.throws(() => loadConfig({ ...config, CF_ACCESS_ALLOWED_EMAILS: '' }), /allowed emails/);
  assert.throws(() => loadConfig({ ...config, OAUTH_ISSUER: 'https://identity.example.com' }), /mix/);
  assert.throws(() => loadConfig({ ...config, DEV_MCP_TOKEN: 'dev'.repeat(20) }), /one authentication/);
});
