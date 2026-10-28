import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ownerApi } from './api/owner.js';
import { config } from './config.js';
import { pool } from './db.js';
import { getAdapter } from './channels/registry.js';
import { ingest } from './core/pipeline.js';
import { log, reportError } from './lib/log.js';
import type { Channel } from './types.js';

export function createApp() {
  const app = express();

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Meta webhook verification (GET with hub.challenge)
  app.get('/webhooks/:channel', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.meta.verifyToken) {
      res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    } else res.sendStatus(403);
  });

  // Raw body is required to verify the signature.
  app.post('/webhooks/:channel', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const channel = req.params.channel as Channel;
    let adapter;
    try {
      adapter = getAdapter(channel);
    } catch {
      return res.sendStatus(404);
    }
    const raw = req.body as Buffer;
    if (!adapter.verifySignature(raw, req.headers)) {
      log('warn', 'bad signature', { channel });
      return res.sendStatus(401);
    }
    res.sendStatus(200); // answer fast, process after

    let messages;
    try {
      messages = adapter.parse(JSON.parse(raw.toString('utf8')));
    } catch (e) {
      return void reportError('webhook parse', e);
    }
    for (const m of messages) ingest(m).catch((e) => reportError('ingest', e));
  });

  // Owner app: JSON API + the built React app (web/dist), with SPA fallback.
  app.use('/api', ownerApi());
  app.use('/api', (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'server_error' });
  });
  const web = path.resolve('web/dist');
  if (fs.existsSync(web)) {
    app.use(express.static(web, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|webhooks|health).*/, (_req, res) => res.sendFile(path.join(web, 'index.html')));
  }

  return app;
}

