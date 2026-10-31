import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = process.env.MCP_URL;
if (!endpoint) throw new Error('Set MCP_URL to the deployed, verified HTTPS MCP endpoint before packaging');
const url = new URL(endpoint);
if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/mcp') {
  throw new Error('MCP_URL must be a credential-free HTTPS URL ending in /mcp without a query or fragment');
}
const output = resolve(root, 'dist/plugin');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'plugin'), output, { recursive: true });
await writeFile(resolve(output, 'mcp.json'), JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    'grafana-alerts': {
      type: 'streamable-http', url: endpoint
    }
  }
}, null, 2) + '\n');
const manifest = JSON.parse(await readFile(resolve(output, 'plugin.json'), 'utf8'));
const archive = resolve(root, `dist/chatgpt-grafana-alerts-${manifest.version}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', output, '.']);
console.log(archive);
