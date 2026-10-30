import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { AlertService } from './service.ts';
import { postCallback } from './callback.ts';
import { createApp } from './http.ts';

process.umask(0o077);
const config = loadConfig();
const store = new Store(config.DATABASE_PATH, config.storageKey);
const service = new AlertService(store, config.SOURCE_ID, postCallback);
const { server, authorized } = createApp(config, service);
let running: Promise<void> | undefined;
const timer = setInterval(() => {
  if (running) return;
  running = service.deliver(authorized).catch(error => console.error('Delivery worker failed', error instanceof Error ? error.message : 'Unknown error'))
    .finally(() => { running = undefined; });
}, 1000);
server.listen(config.PORT, config.HOST, () => console.log(`chatgpt-grafana-alerts listening on ${config.HOST}:${config.PORT}`));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await running;
  store.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
