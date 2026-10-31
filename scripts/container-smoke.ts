import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'grafana-alerts-container-'));
const project = `alerts-smoke-${randomBytes(4).toString('hex')}`;
const image = process.env.CONTAINER_IMAGE ?? 'chatgpt-grafana-alerts:validation';
const secret = randomBytes(32).toString('base64');
const configPath = join(directory, 'compose.json');
const envPath = join(directory, 'server.env');
const docker = (...args: string[]) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (...args: string[]) => docker('compose', '-p', project, '-f', configPath, ...args);
try {
  await writeFile(envPath, [
    'AUTH_MODE=cloudflare', 'PUBLIC_URL=https://alerts.example.com', 'SOURCE_ID=smoke',
    'CF_ACCESS_TEAM_DOMAIN=team.cloudflareaccess.com', `CF_ACCESS_AUD=${'a'.repeat(64)}`,
    'CF_ACCESS_ALLOWED_EMAILS=alice@example.com', `GRAFANA_WEBHOOK_SECRET=${secret}`,
    `STORAGE_KEY=${randomBytes(32).toString('base64')}`
  ].join('\n'), { mode: 0o600 });
  const rendered = execFileSync('docker', ['compose', '-p', project, '-f', 'deploy/compose.yaml', 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, IMAGE_DIGEST: image, SERVER_ENV_FILE: envPath, GRAFANA_NETWORK: project }
  });
  const config = JSON.parse(rendered);
  config.services['grafana-alerts'].ports = [{ target: 3000, host_ip: '127.0.0.1', protocol: 'tcp' }];
  config.networks.observability = { name: project, driver: 'bridge' };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  console.log(compose('up', '-d', '--wait', '--wait-timeout', '90'));
  const address = compose('port', 'grafana-alerts', '3000');
  assert.ok(address.startsWith('127.0.0.1:'));
  const origin = `http://${address}`;
  const ready = await fetch(`${origin}/readyz`);
  assert.equal(ready.status, 200);
  const notification = JSON.stringify({ receiver: 'smoke', status: 'firing', orgId: 1, groupKey: 'smoke', alerts: [{
    status: 'firing', fingerprint: 'smoke-alert', labels: { alertname: 'Container validation' }, annotations: {},
    startsAt: new Date().toISOString(), endsAt: '0001-01-01T00:00:00Z'
  }] });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await fetch(`${origin}/webhooks/grafana/smoke`, { method: 'POST', body: notification, headers: {
    'Content-Type': 'application/json', 'X-Grafana-Alerting-Timestamp': timestamp,
    'X-Grafana-Alerting-Signature': createHmac('sha256', secret).update(`${timestamp}:${notification}`).digest('hex')
  } });
  assert.equal(response.status, 202);
  assert.equal((await response.json() as { accepted: number }).accepted, 1);
  const dbCount = () => Number(compose('exec', '-T', 'grafana-alerts', 'node', '-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/alerts.sqlite',{readOnly:true});console.log(d.prepare('SELECT COUNT(*) AS n FROM events').get().n);d.close()"));
  assert.equal(dbCount(), 1);
  assert.equal((await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'forged' }, body: '{}' })).status, 401);
  assert.equal(compose('exec', '-T', 'grafana-alerts', 'id', '-u'), '1000');
  compose('restart', 'grafana-alerts');
  compose('up', '-d', '--wait', '--wait-timeout', '90');
  assert.equal(dbCount(), 1);
  const backup = compose('exec', '-T', 'backup', 'node', '--input-type=module', '-e', "import {snapshot} from './server/backup.ts';console.log(await snapshot('/app/data/alerts.sqlite','/app/backups'))");
  const restoredCount = compose('exec', '-T', 'backup', 'node', '-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('SELECT COUNT(*) AS n FROM events').get().n);d.close()", backup);
  assert.equal(Number(restoredCount), 1);
  console.log('Container validation passed: readiness, signed intake, Access rejection, non-root execution, restart persistence, and live backup.');
} catch (error) {
  try { console.error(compose('logs', '--tail', '40')); } catch {}
  throw error;
} finally {
  try { compose('down', '-v', '--remove-orphans'); } finally { await rm(directory, { recursive: true, force: true }); }
}
