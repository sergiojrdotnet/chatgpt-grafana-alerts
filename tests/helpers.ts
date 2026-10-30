import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.ts';
import { AlertService } from '../server/service.ts';
import type { CallbackPost } from '../server/callback.ts';

export const source = 'production';
export const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
export const principal = { id: 'alice', expiresAt: Date.now() + 86_400_000 };
export const subscription = (labels = {}) => ({
  name: 'grafana.alert.firing', arguments: { source, labels },
  delivery: { mode: 'webhook', url: 'https://callbacks.example.com/events', secret }
});
export function notification(status = 'firing', fingerprint = 'alert-a', labels = { severity: 'critical' }) {
  return {
    receiver: 'chatgpt', status, orgId: 1, groupKey: 'group', truncatedAlerts: 0,
    alerts: [{ status, fingerprint, labels, annotations: { summary: 'Latency is high' },
      startsAt: '2026-10-30T12:00:00Z', endsAt: status === 'resolved' ? '2026-10-30T12:05:00Z' : '0001-01-01T00:00:00Z',
      generatorURL: 'https://grafana.example.com/alerting/rule/view' }]
  };
}
export function setup(post?: CallbackPost) {
  const store = new Store(':memory:', randomBytes(32));
  const payloads: Record<string, unknown>[] = [];
  const send: CallbackPost = post ?? (async (_sub, payload) => {
    const data = payload as Record<string, unknown>;
    payloads.push(data);
    return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
  });
  return { store, payloads, service: new AlertService(store, source, send) };
}
