import { config } from './config.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS customers (
    phone TEXT PRIMARY KEY,
    language TEXT NOT NULL DEFAULT 'ha',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS incidents (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    area TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'possible',
    source TEXT NOT NULL DEFAULT 'auto',
    confidence TEXT NOT NULL DEFAULT 'LOW',
    report_count INTEGER NOT NULL DEFAULT 0,
    customer_count INTEGER NOT NULL DEFAULT 0,
    first_report_at TIMESTAMPTZ,
    last_report_at TIMESTAMPTZ,
    broadcast_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    category TEXT NOT NULL,
    area TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'ussd',
    status TEXT NOT NULL DEFAULT 'open',
    incident_id INTEGER,
    recording_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS tickets_phone_idx ON tickets (phone)`,
  `CREATE INDEX IF NOT EXISTS tickets_cluster_idx ON tickets (category, area, created_at)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'out',
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    provider_id TEXT,
    detail TEXT,
    incident_id INTEGER,
    ticket_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS messages_provider_idx ON messages (provider_id)`,
  `CREATE TABLE IF NOT EXISTS rewards (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

let impl;

export async function initDb(url = config.databaseUrl) {
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    impl = { query: async (t, p) => (await pool.query(t, p)).rows, close: () => pool.end(), kind: 'postgres' };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const mem = process.env.KORAFI_DATA_DIR === 'memory';
    const dir = mem ? undefined : process.env.KORAFI_DATA_DIR || './data/pg';
    const db = new PGlite(dir);
    await db.waitReady;
    impl = { query: async (t, p) => (await db.query(t, p)).rows, close: () => db.close(), kind: mem ? 'memory' : 'embedded' };
  }
  for (const stmt of SCHEMA) await impl.query(stmt);
  return impl;
}

export const query = (t, p) => impl.query(t, p);
export const dbKind = () => impl?.kind;
export const closeDb = () => impl?.close();

/** Serialises critical sections (report creation / incident detection) within one instance. */
let chain = Promise.resolve();
export function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}
