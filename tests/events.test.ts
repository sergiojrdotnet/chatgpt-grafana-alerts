import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, verifyGrafana } from '../server/domain.ts';
import { Store } from '../server/store.ts';
import { AlertService } from '../server/service.ts';
import { callbackUrl, isPublicAddress } from '../server/callback.ts';
import { notification, principal, secret, setup, source, subscription } from './helpers.ts';

test('Grafana signature binds exact body and timestamp, rejecting stale and tampered notifications', () => {
  const body = Buffer.from(JSON.stringify(notification()));
  const now = Date.now();
  const timestamp = Math.floor(now / 1000).toString();
  const key = 'a'.repeat(32);
  const signature = createHmac('sha256', key).update(`${timestamp}:`).update(body).digest('hex');
  assert.equal(verifyGrafana(body, signature, timestamp, key, now), true);
  assert.equal(verifyGrafana(Buffer.from('{}'), signature, timestamp, key, now), false);
  assert.equal(verifyGrafana(body, signature, timestamp, key, now + 301_000), false);
  assert.equal(verifyGrafana(body, 'zz', timestamp, key, now), false);
});

test('Grouped alerts normalize independently and exact retries deduplicate across key ordering', () => {
  const { store } = setup();
  const payload = notification();
  payload.alerts.push(notification('resolved', 'alert-b').alerts[0]!);
  const events = normalize(source, payload);
  assert.deepEqual(events.map(e => e.name), ['grafana.alert.firing', 'grafana.alert.resolved']);
  assert.equal(store.ingest(events), 2);
  assert.equal(store.ingest(events), 0);
  assert.equal(normalize(source, { ...notification(), alerts: notification().alerts.map(alert => ({ ...alert, labels: { severity: 'critical' } })) })[0]!.eventId, events[0]!.eventId);
  store.close();
});

test('Reject truncated Grafana batches and invalid statuses without partially storing events', () => {
  assert.throws(() => normalize(source, { ...notification(), truncatedAlerts: 1 }), /truncated/);
  assert.throws(() => normalize(source, notification('unknown')));
});

test('Subscriptions verify callbacks and apply source, event, and label filters', async () => {
  const { store, service, payloads } = setup();
  await service.subscribe(principal, subscription({ severity: 'critical' }));
  const other = notification('firing', 'noncritical', { severity: 'warning' });
  store.ingest([...normalize(source, notification()), ...normalize(source, other), ...normalize(source, notification('resolved'))]);
  await service.deliver(() => true);
  const events = payloads.filter(item => item.eventId);
  assert.equal(events.length, 1);
  assert.equal((events[0]!.data as { fingerprint: string }).fingerprint, 'alert-a');
  assert.equal(store.subscriptions()[0]!.cursor, 3);
  await assert.rejects(service.subscribe(principal, { ...subscription(), arguments: { source: 'other' } }), /not authorized/);
  store.close();
});

test('Failed callback verification never activates a subscription', async () => {
  const { store, service } = setup(async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
  await assert.rejects(service.subscribe(principal, subscription()), /verification failed/);
  assert.equal(store.subscriptions().length, 0);
  store.close();
});

test('Refresh is idempotent, respects requested TTL and rotates signing secrets', async () => {
  const { store, service } = setup();
  const now = Date.now();
  const first = await service.subscribe(principal, { ...subscription(), ttlMs: 20_000 }, now);
  const replacement = `whsec_${randomBytes(32).toString('base64')}`;
  const second = await service.subscribe(principal, { ...subscription(), delivery: { ...subscription().delivery, secret: replacement }, cursor: first.cursor, ttlMs: 10_000 }, now);
  assert.equal(first.id, second.id);
  assert.equal(store.subscriptions().length, 1);
  assert.equal(Date.parse(second.refreshBefore), now + 10_000);
  assert.equal(store.subscription(first.id)!.previousSecret, secret);
  store.close();
});

test('Subscription lifetime never outlives authorization; null TTL receives a finite grant', async () => {
  const { store, service } = setup();
  const now = Date.now();
  const result = await service.subscribe({ ...principal, expiresAt: now + 5000 }, { ...subscription(), ttlMs: null }, now);
  assert.equal(Date.parse(result.refreshBefore), now + 5000);
  await service.deliver(() => true, now + 6000);
  store.close();
});

test('Replay cursors cannot be tampered with or borrowed by a different principal', async () => {
  const { store, service } = setup();
  const sub = await service.subscribe(principal, subscription());
  await assert.rejects(service.subscribe({ ...principal, id: 'bob' }, { ...subscription(), cursor: sub.cursor }), /does not belong/);
  await assert.rejects(service.subscribe(principal, { ...subscription(), cursor: `${sub.cursor}x` }), /Invalid replay cursor/);
  store.close();
});

test('Transient delivery failure retries the same event before advancing the cursor', async () => {
  let status = 503;
  const delivered: string[] = [];
  const { store, service } = setup(async (_sub, input) => {
    const payload = input as { challenge?: string; eventId?: string };
    if (payload.challenge) return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    delivered.push(payload.eventId!);
    return { status, body: '' };
  });
  const sub = await service.subscribe(principal, subscription());
  store.ingest(normalize(source, notification()));
  const now = Date.now();
  await service.deliver(() => true, now);
  assert.equal(store.subscription(sub.id)!.cursor, 0);
  assert.equal(store.subscription(sub.id)!.attempts, 1);
  status = 204;
  await service.deliver(() => true, now + 3000);
  assert.equal(store.subscription(sub.id)!.cursor, 1);
  assert.equal(delivered[0], delivered[1]);
  store.close();
});

for (const status of [410, 413, 401, 302]) {
  test(`HTTP ${status} stops retries and keeps the failed event available`, async () => {
    const { store, service } = setup(async (_sub, input) => {
      const payload = input as { challenge?: string };
      return payload.challenge ? { status: 200, body: JSON.stringify(payload) } : { status, body: '' };
    });
    const sub = await service.subscribe(principal, subscription());
    store.ingest(normalize(source, notification()));
    await service.deliver(() => true);
    assert.equal(store.subscription(sub.id)!.state, status === 410 ? 'gone' : 'failed');
    assert.equal(store.subscription(sub.id)!.cursor, 0);
    assert.equal(store.highWater(), 1);
    store.close();
  });
}

test('Retries stop after eight failures and remain visible in status', async () => {
  const { store, service } = setup(async (_sub, input) => {
    const payload = input as { challenge?: string };
    return payload.challenge ? { status: 200, body: JSON.stringify(payload) } : { status: 500, body: '' };
  });
  const sub = await service.subscribe(principal, subscription());
  store.ingest(normalize(source, notification()));
  for (let attempt = 0; attempt < 9; attempt++) await service.deliver(() => true, Date.now() + attempt * 300_001);
  assert.equal(store.subscription(sub.id)!.state, 'failed');
  assert.equal(store.subscription(sub.id)!.attempts, 8);
  store.close();
});

test('Unsubscribe is owner-scoped and idempotent; revoked owners receive no events', async () => {
  const { store, service, payloads } = setup();
  const sub = await service.subscribe(principal, subscription());
  service.unsubscribe({ ...principal, id: 'bob' }, subscription());
  assert.equal(store.subscription(sub.id)!.state, 'active');
  store.ingest(normalize(source, notification()));
  await service.deliver(() => false);
  assert.equal(payloads.filter(item => item.eventId).length, 0);
  assert.equal(store.subscription(sub.id)!.state, 'gone');
  service.unsubscribe(principal, subscription());
  service.unsubscribe(principal, subscription());
  assert.equal(store.subscription(sub.id)!.state, 'unsubscribed');
  store.close();
});

test('SQLite restart preserves subscriptions, encrypted secrets, backlog, and replay progress', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grafana-alerts-'));
  const path = join(directory, 'alerts.sqlite');
  const key = randomBytes(32);
  const post = async (_sub: unknown, input: unknown) => ({ status: 200, body: JSON.stringify(input) });
  let store = new Store(path, key);
  let service = new AlertService(store, source, post);
  const sub = await service.subscribe(principal, subscription());
  store.ingest(normalize(source, notification()));
  store.close();
  assert.equal(readFileSync(path).includes(secret), false);
  store = new Store(path, key);
  service = new AlertService(store, source, post);
  await service.deliver(() => true);
  assert.equal(store.subscription(sub.id)!.cursor, 1);
  const refreshed = await service.subscribe(principal, { ...subscription(), cursor: sub.cursor });
  assert.equal(store.parseCursor(refreshed.cursor, sub.id), 0);
  await service.deliver(() => true);
  assert.equal(store.subscription(sub.id)!.cursor, 1);
  store.close();
  rmSync(directory, { recursive: true });
});

test('Callback validation excludes private, mapped, reserved, and credential-bearing destinations', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '192.0.2.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@example.com', 'https://example.com/#fragment']) assert.throws(() => callbackUrl(url));
});
