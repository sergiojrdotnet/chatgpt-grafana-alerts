import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticator } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';

test('OAuth checks signature, issuer, audience, scope, expiration, and subject allowlist', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const config = loadConfig({
    GRAFANA_WEBHOOK_SECRET: 'a'.repeat(32), STORAGE_KEY: Buffer.alloc(32).toString('base64'),
    PUBLIC_URL: 'https://alerts.example.com', OAUTH_ISSUER: 'https://identity.example.com',
    OAUTH_JWKS_URL: 'https://identity.example.com/keys', OAUTH_ALLOWED_SUBJECTS: 'alice'
  });
  const auth = authenticator(config, createLocalJWKSet({ keys: [jwk] }));
  const now = Math.floor(Date.now() / 1000);
  async function token(overrides: Record<string, unknown> = {}) {
    return new SignJWT({
      scope: 'alerts:read', iss: 'https://identity.example.com', aud: 'https://alerts.example.com/mcp',
      sub: 'alice', iat: now, exp: now + 300, ...overrides
    }).setProtectedHeader({ alg: 'ES256' }).sign(privateKey);
  }
  assert.equal((await auth.authenticate(`Bearer ${await token()}`))!.id, 'alice');
  assert.equal(await auth.authenticate(`Bearer ${await token({ scope: 'other:read' })}`), undefined);
  for (const invalid of [{ aud: 'wrong-audience' }, { iss: 'https://wrong.example.com' }, { sub: 'bob' }, { exp: now - 1 }]) {
    assert.equal(await auth.authenticate(`Bearer ${await token(invalid)}`), undefined);
  }
  const otherKeys = await generateKeyPair('ES256');
  const badSignature = await new SignJWT({ scope: 'alerts:read', iss: config.OAUTH_ISSUER, aud: `${config.PUBLIC_URL}/mcp`, sub: 'alice', iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: 'ES256' }).sign(otherKeys.privateKey);
  assert.equal(await auth.authenticate(`Bearer ${badSignature}`), undefined);
  assert.equal(await auth.authenticate('Bearer invalid'), undefined);
  config.subjects.delete('alice');
  assert.equal(await auth.authenticate(`Bearer ${await token()}`), undefined);
  assert.equal(auth.authorized('alice'), false);
});
