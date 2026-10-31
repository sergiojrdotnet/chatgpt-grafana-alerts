import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function snapshot(source: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `alerts-${new Date().toISOString().replaceAll(':', '-')}.sqlite`;
  const temporary = join(directory, `${name}.tmp`);
  const destination = join(directory, name);
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, temporary); }
  finally { db.close(); }
  const check = new DatabaseSync(temporary, { readOnly: true });
  try {
    if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Backup integrity check failed');
  } finally { check.close(); }
  await rename(temporary, destination);
  const files = (await readdir(directory)).filter(name => /^alerts-.*\.sqlite$/.test(name)).sort().reverse();
  for (const file of files.slice(7)) await rm(join(directory, file));
  return destination;
}

async function run() {
  process.umask(0o077);
  const source = process.env.DATABASE_PATH ?? '/app/data/alerts.sqlite';
  const directory = process.env.BACKUP_PATH ?? '/app/backups';
  for (;;) {
    let delay = 300_000;
    try {
      await stat(source);
      const path = await snapshot(source, directory);
      await writeFile('/tmp/last-backup', Date.now().toString(), { mode: 0o600 });
      console.log(JSON.stringify({ event: 'backup.completed', path, timestamp: new Date().toISOString() }));
      delay = 6 * 60 * 60_000;
    } catch (error) {
      console.error(JSON.stringify({ event: 'backup.failed', message: error instanceof Error ? error.message : 'Unknown error' }));
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) void run();
