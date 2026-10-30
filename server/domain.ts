import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const protocolVersion = '2026-07-28';
export const eventName = z.enum(['grafana.alert.firing', 'grafana.alert.resolved']);
const textMap = z.record(z.string().max(200), z.string().max(8000));
const timestamp = z.iso.datetime({ offset: true });
export const grafanaNotification = z.object({
  receiver: z.string().max(500),
  status: z.enum(['firing', 'resolved']),
  orgId: z.number().int().nonnegative(),
  groupKey: z.string().max(2000),
  truncatedAlerts: z.number().int().nonnegative().optional(),
  alerts: z.array(z.object({
    status: z.enum(['firing', 'resolved']),
    fingerprint: z.string().min(1).max(200),
    labels: textMap,
    annotations: textMap,
    startsAt: timestamp,
    endsAt: timestamp,
    generatorURL: z.string().max(4000).optional(),
    dashboardURL: z.string().max(4000).optional(),
    panelURL: z.string().max(4000).optional(),
    silenceURL: z.string().max(4000).optional()
  })).min(1).max(500)
});
export const filtersSchema = z.object({
  source: z.string().min(1).max(100),
  labels: z.record(z.string().max(200), z.string().max(8000)).default({})
}).strict();
export type Filters = z.infer<typeof filtersSchema>;
export type EventName = z.infer<typeof eventName>;
export type AlertData = {
  source: string;
  orgId: number;
  fingerprint: string;
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  dashboardURL?: string;
  panelURL?: string;
  silenceURL?: string;
};
export type AlertEvent = { eventId: string; name: EventName; timestamp: string; data: AlertData };
export type StoredEvent = AlertEvent & { seq: number };

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function normalize(source: string, input: unknown): AlertEvent[] {
  const notification = grafanaNotification.parse(input);
  if (notification.truncatedAlerts) throw new RpcError(-32602, 'Grafana truncated the notification; configure Max Alerts to 0', undefined, 422);
  return notification.alerts.map(alert => {
    const data: AlertData = { source, orgId: notification.orgId, ...alert };
    const event: AlertEvent = {
      eventId: `evt_${digest(data)}`,
      name: `grafana.alert.${alert.status}`,
      timestamp: alert.status === 'resolved' ? alert.endsAt : alert.startsAt,
      data
    };
    if (Buffer.byteLength(JSON.stringify(event)) > 240 * 1024) throw new RpcError(-32602, 'Alert exceeds the event payload limit', undefined, 422);
    return event;
  });
}

export function matches(event: AlertEvent, name: EventName, filters: Filters): boolean {
  return event.name === name && event.data.source === filters.source
    && Object.entries(filters.labels).every(([key, value]) => event.data.labels[key] === value);
}

export function verifyGrafana(body: Buffer, signature: string, signedAt: string, secret: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(signedAt) || Math.abs(now / 1000 - Number(signedAt)) > 300) return false;
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(`${signedAt}:`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export class RpcError extends Error {
  code: number;
  data: unknown;
  status: number;
  constructor(code: number, message: string, data?: unknown, status = 200) {
    super(message);
    this.code = code;
    this.data = data;
    this.status = status;
  }
}
