import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../server/domain.ts';
import { principal, setup, source, subscription, notification } from './helpers.ts';

test('A refresh during in-flight delivery prevents the old worker from advancing replay progress', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const { store, service } = setup(async (_sub, input) => {
    const payload = input as { challenge?: string };
    if (payload.challenge) return { status: 200, body: JSON.stringify(payload) };
    entered();
    await blocked;
    return { status: 204, body: '' };
  });
  const first = await service.subscribe(principal, subscription());
  store.ingest(normalize(source, notification()));
  const delivery = service.deliver(() => true);
  await enteredPromise;
  await service.subscribe(principal, { ...subscription(), cursor: first.cursor });
  release();
  await delivery;
  assert.equal(store.subscription(first.id)!.cursor, 0);
  await service.deliver(() => true);
  assert.equal(store.subscription(first.id)!.cursor, 1);
  store.close();
});
