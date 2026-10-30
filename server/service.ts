import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { callbackUrl } from './callback.ts';
import type { CallbackPost } from './callback.ts';
import { eventName, filtersSchema, matches, RpcError } from './domain.ts';
import { Store } from './store.ts';

export type Principal = { id: string; expiresAt: number };
const secretSchema = z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/).refine(value => {
  const bytes = Buffer.from(value.slice(6), 'base64');
  return bytes.length >= 24 && bytes.length <= 64 && bytes.toString('base64') === value.slice(6);
}, 'Signing secret must contain 24–64 base64-encoded bytes');
const deliverySchema = z.object({ mode: z.literal('webhook'), url: z.string().max(4000), secret: secretSchema });
const subscribeSchema = z.object({
  name: eventName, arguments: filtersSchema, delivery: deliverySchema,
  cursor: z.string().max(2000).nullable().optional(),
  ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  maxAgeMs: z.number().int().nonnegative().optional()
});

export class AlertService {
  store: Store;
  source: string;
  private post: CallbackPost;
  constructor(store: Store, source: string, post: CallbackPost) {
    this.store = store;
    this.source = source;
    this.post = post;
  }

  private filters(input: unknown) {
    const filters = filtersSchema.parse(input);
    if (filters.source !== this.source) throw new RpcError(-32024, 'Source is not authorized');
    return filters;
  }

  async subscribe(principal: Principal, input: unknown, now = Date.now()) {
    const params = subscribeSchema.parse(input);
    const filters = this.filters(params.arguments);
    try { callbackUrl(params.delivery.url); }
    catch { throw new RpcError(-32602, 'Invalid callback URL'); }
    if (params.maxAgeMs !== undefined) throw new RpcError(-32026, 'maxAgeMs is not supported; use the retained replay cursor');
    const id = this.store.identity(principal.id, params.name, filters, params.delivery.url);
    const scope = id;
    const existing = this.store.subscription(id);
    const high = this.store.highWater();
    const requestedCursor = params.cursor ? this.store.parseCursor(params.cursor, scope) : undefined;
    const cursor = existing && existing.state !== 'unsubscribed'
      ? Math.min(existing.cursor, requestedCursor ?? existing.cursor)
      : requestedCursor ?? high;
    const expiresAt = Math.min(now + Math.min(params.ttlMs ?? 3_600_000, 3_600_000), principal.expiresAt);
    if (expiresAt <= now) throw new RpcError(-32024, 'Authorization expired');
    const challenge = randomBytes(32).toString('base64url');
    try {
      const result = await this.post({ id, url: params.delivery.url, secret: params.delivery.secret, previousSecret: null, rotateUntil: 0 }, { type: 'verification', challenge });
      const returned = Buffer.from(String(JSON.parse(result.body).challenge));
      const expected = Buffer.from(challenge);
      if (result.status < 200 || result.status >= 300 || returned.length !== expected.length || !timingSafeEqual(returned, expected)) throw new Error('Challenge failed');
    } catch { throw new RpcError(-32015, 'Callback verification failed', { reason: 'challenge_failed' }); }
    this.store.saveSubscription({ id, owner: principal.id, name: params.name, filters, url: params.delivery.url, secret: params.delivery.secret, expiresAt, cursor }, now);
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: this.store.cursor(scope, cursor), truncated: false };
  }

  unsubscribe(principal: Principal, input: unknown) {
    const params = z.object({ name: eventName, arguments: filtersSchema, delivery: deliverySchema.omit({ secret: true }) }).parse(input);
    const filters = this.filters(params.arguments);
    this.store.unsubscribe(this.store.identity(principal.id, params.name, filters, params.delivery.url));
    return {};
  }

  tools(principal: Principal, name: string, input: unknown): unknown {
    if (name === 'list_alerts') {
      const args = z.object({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict().parse(input);
      const events = this.store.events(args.after, args.limit);
      return { events, nextAfter: events.at(-1)?.seq ?? args.after };
    }
    if (name === 'get_alert') {
      const args = z.object({ eventId: z.string().min(1) }).strict().parse(input);
      const event = this.store.event(args.eventId);
      if (!event) throw new RpcError(-32023, 'Alert event not found');
      return event;
    }
    if (name === 'subscription_status') {
      z.object({}).strict().parse(input);
      return { subscriptions: this.store.subscriptions(principal.id).map(sub => ({
        id: sub.id, name: sub.name, filters: sub.filters, state: sub.state,
        expired: sub.expiresAt <= Date.now(), refreshBefore: new Date(sub.expiresAt).toISOString(),
        lastAcknowledgedSequence: sub.cursor, attempts: sub.attempts, lastError: sub.lastError
      })) };
    }
    throw new RpcError(-32602, 'Unknown tool');
  }

  async deliver(authorized: (owner: string) => boolean, now = Date.now()) {
    for (const snapshot of this.store.subscriptions()) {
      if (snapshot.state !== 'active' || snapshot.expiresAt <= now || snapshot.nextAttempt > now) continue;
      if (!authorized(snapshot.owner)) {
        this.store.failure(snapshot.id, snapshot.attempts, 0, 'gone', 'Authorization revoked');
        continue;
      }
      const events = this.store.events(snapshot.cursor, 100);
      for (const event of events) {
        const sub = this.store.subscription(snapshot.id)!;
        if (sub.state !== 'active' || sub.revision !== snapshot.revision || sub.expiresAt <= Date.now() || !authorized(sub.owner)) break;
        if (event.seq <= sub.cursor) continue;
        if (!matches(event, sub.name, sub.filters)) {
          this.store.advance(sub.id, event.seq);
          continue;
        }
        let status = 0;
        try {
          const { seq, ...payload } = event;
          status = (await this.post(sub, { ...payload, cursor: this.store.cursor(sub.id, seq) })).status;
        } catch { status = 0; }
        const current = this.store.subscription(sub.id)!;
        if (current.state !== 'active' || current.revision !== sub.revision) break;
        if (status >= 200 && status < 300) {
          this.store.advance(sub.id, event.seq);
          continue;
        }
        const attempts = sub.attempts + 1;
        const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
        const state = status === 410 ? 'gone' : !retryable || attempts >= 8 ? 'failed' : 'active';
        this.store.failure(sub.id, attempts, now + Math.min(300_000, 1000 * 2 ** attempts), state, status ? `HTTP ${status}` : 'Callback unavailable');
        break;
      }
    }
  }
}
