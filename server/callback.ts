import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';
import type { Subscription } from './store.ts';

export type CallbackResponse = { status: number; body: string };
export type CallbackPost = (subscription: Pick<Subscription, 'id' | 'url' | 'secret' | 'previousSecret' | 'rotateUntil'>, payload: unknown) => Promise<CallbackResponse>;

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}

export function callbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Callback must be a credential-free HTTPS URL without a fragment');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new Error('Callback address must be public');
  return url;
}

export const postCallback: CallbackPost = async (subscription, payload) => {
  const url = callbackUrl(subscription.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Callback DNS lookup timed out')), 5000);
      timer.unref();
    })
  ]);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Callback DNS must resolve only to public addresses');
  const address = addresses[0]!;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 256 * 1024) return { status: 413, body: '' };
  const id = payload && typeof payload === 'object' && 'eventId' in payload ? String(payload.eventId) : `verify_${randomUUID()}`;
  const signedAt = new Date();
  const signatures = [new Webhook(subscription.secret).sign(id, signedAt, body)];
  if (subscription.previousSecret && subscription.rotateUntil > Date.now()) {
    signatures.push(new Webhook(subscription.previousSecret).sign(id, signedAt, body));
  }
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      agent: false,
      family: address.family,
      lookup: (_hostname, _options, done) => done(null, address.address, address.family),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'webhook-id': id,
        'webhook-timestamp': Math.floor(signedAt.getTime() / 1000).toString(),
        'webhook-signature': signatures.join(' '),
        'X-MCP-Subscription-Id': subscription.id
      }
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024) response.destroy(new Error('Callback response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString() }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Callback request timed out')), 10_000);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
};
