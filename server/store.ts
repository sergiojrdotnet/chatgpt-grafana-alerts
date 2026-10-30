import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, digest, RpcError } from './domain.ts';
import type { AlertEvent, EventName, Filters, StoredEvent } from './domain.ts';

export type Subscription = {
  id: string; owner: string; name: EventName; filters: Filters; url: string;
  secret: string; previousSecret: string | null; rotateUntil: number;
  expiresAt: number; cursor: number; attempts: number; nextAttempt: number;
  revision: number;
  state: 'active' | 'failed' | 'gone' | 'unsubscribed'; lastError: string | null;
};

export class Store {
  db: DatabaseSync;
  private key: Buffer;
  constructor(path: string, key: Buffer) {
    this.key = key;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, filters TEXT NOT NULL,
        url TEXT NOT NULL, secret TEXT NOT NULL, previous_secret TEXT, rotate_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL, cursor INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active', last_error TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
    `);
  }

  close() { this.db.close(); }

  ingest(events: AlertEvent[]): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let inserted = 0;
      for (const event of events) {
        inserted += Number(this.db.prepare('INSERT OR IGNORE INTO events(id,body) VALUES (?,?)')
          .run(event.eventId, JSON.stringify(event)).changes);
      }
      this.db.exec('COMMIT');
      return inserted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  highWater(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()!.seq);
  }

  events(after = 0, limit = 100): StoredEvent[] {
    return this.db.prepare('SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit)
      .map(row => ({ ...JSON.parse(String(row.body)), seq: Number(row.seq) }));
  }

  event(id: string): StoredEvent | undefined {
    const row = this.db.prepare('SELECT seq,body FROM events WHERE id=?').get(id);
    return row ? { ...JSON.parse(String(row.body)), seq: Number(row.seq) } : undefined;
  }

  identity(owner: string, name: EventName, filters: Filters, url: string): string {
    return `sub_${digest({ owner, name, filters, url })}`;
  }

  cursor(scope: string, seq: number): string {
    const body = Buffer.from(canonical({ scope, seq })).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(`cursor:${body}`).digest('base64url')}`;
  }

  parseCursor(value: string, scope: string): number {
    const [body, signature, extra] = value.split('.');
    if (!body || !signature || extra) throw new RpcError(-32602, 'Invalid replay cursor');
    const expected = this.cursorSignature(body);
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new RpcError(-32602, 'Invalid replay cursor');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString()); }
    catch { throw new RpcError(-32602, 'Invalid replay cursor'); }
    if (decoded.scope !== scope || !Number.isSafeInteger(decoded.seq) || decoded.seq < 0 || decoded.seq > this.highWater()) {
      throw new RpcError(-32602, 'Replay cursor does not belong to this subscription');
    }
    return decoded.seq;
  }

  private cursorSignature(body: string) {
    return createHmac('sha256', this.key).update(`cursor:${body}`).digest();
  }

  subscription(id: string): Subscription | undefined {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
    return row ? {
      id: String(row.id), owner: String(row.owner), name: String(row.name) as EventName,
      filters: JSON.parse(String(row.filters)), url: String(row.url), secret: this.decrypt(String(row.secret)),
      previousSecret: row.previous_secret ? this.decrypt(String(row.previous_secret)) : null,
      rotateUntil: Number(row.rotate_until), expiresAt: Number(row.expires_at), cursor: Number(row.cursor),
      attempts: Number(row.attempts), nextAttempt: Number(row.next_attempt),
      revision: Number(row.revision),
      state: String(row.state) as Subscription['state'], lastError: row.last_error ? String(row.last_error) : null
    } : undefined;
  }

  saveSubscription(input: Omit<Subscription, 'previousSecret' | 'rotateUntil' | 'attempts' | 'nextAttempt' | 'state' | 'lastError' | 'revision'>, now: number) {
    const existing = this.subscription(input.id);
    const oldSecret = existing && existing.secret !== input.secret ? existing.secret : existing?.previousSecret;
    const rotateUntil = existing && existing.secret !== input.secret ? now + 60_000 : existing?.rotateUntil ?? 0;
    this.db.prepare(`INSERT INTO subscriptions(id,owner,name,filters,url,secret,previous_secret,rotate_until,expires_at,cursor)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      secret=excluded.secret,previous_secret=excluded.previous_secret,rotate_until=excluded.rotate_until,
      expires_at=excluded.expires_at,cursor=excluded.cursor,state='active',attempts=0,next_attempt=0,last_error=NULL,
      revision=subscriptions.revision+1`)
      .run(input.id, input.owner, input.name, canonical(input.filters), input.url, this.encrypt(input.secret),
        oldSecret ? this.encrypt(oldSecret) : null, rotateUntil, input.expiresAt, input.cursor);
  }

  subscriptions(owner?: string): Subscription[] {
    const rows = owner
      ? this.db.prepare('SELECT id FROM subscriptions WHERE owner=? ORDER BY id').all(owner)
      : this.db.prepare('SELECT id FROM subscriptions ORDER BY id').all();
    return rows.map(row => this.subscription(String(row.id))!);
  }

  advance(id: string, cursor: number) {
    this.db.prepare('UPDATE subscriptions SET cursor=?,attempts=0,next_attempt=0,last_error=NULL WHERE id=?').run(cursor, id);
  }

  failure(id: string, attempts: number, nextAttempt: number, state: Subscription['state'], error: string) {
    this.db.prepare('UPDATE subscriptions SET attempts=?,next_attempt=?,state=?,last_error=? WHERE id=?')
      .run(attempts, nextAttempt, state, error, id);
  }

  unsubscribe(id: string) {
    this.db.prepare("UPDATE subscriptions SET state='unsubscribed',expires_at=0 WHERE id=?").run(id);
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private decrypt(value: string): string {
    const data = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
}
