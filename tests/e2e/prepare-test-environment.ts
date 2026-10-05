import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.OPENHUB_DB_PATH;

if (!dbPath) {
  throw new Error('OPENHUB_DB_PATH is required for the OpenHub E2E test environment');
}

const absoluteDbPath = path.resolve(dbPath);
fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });

for (const suffix of ['', '-shm', '-wal']) {
  const file = `${absoluteDbPath}${suffix}`;
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

const authDir = path.join(process.cwd(), 'playwright', '.auth');
fs.rmSync(authDir, { recursive: true, force: true });
