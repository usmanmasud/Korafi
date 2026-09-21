import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { initDb, closeDb, dbKind, query } from './db.js';
import { atMode } from './at.js';
import { api } from './routes/api.js';
import { webhooks } from './routes/webhooks.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, business: config.businessName, database: dbKind(), africasTalking: atMode() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/at', express.urlencoded({ extended: false, limit: '100kb' }), express.json({ limit: '100kb' }), webhooks);
  app.use('/api', express.json({ limit: '50kb' }), api);
  app.use(express.static(PUBLIC, { extensions: ['html'] }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, '404.html')));
  return app;
}

async function main() {
  await initDb();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`\n  KORAFI — ${config.businessName}`);
    console.log(`  Landing    ${config.publicUrl}/`);
    console.log(`  Dashboard  ${config.publicUrl}/dashboard/`);
    console.log(`  Database   ${dbKind()}   Africa's Talking: ${atMode()}`);
    if (config.dashboardPassword === 'korafi-demo' || config.sessionSecret === 'korafi-dev-secret') {
      console.log('  ! Using default DASHBOARD_PASSWORD / SESSION_SECRET — set your own before deploying.');
    }
    console.log(`  Webhooks   POST ${config.publicUrl}/at/{ussd,sms,sms/delivery,voice}\n`);
  });
  const stop = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
