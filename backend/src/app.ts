import cors from 'cors';
import express from 'express';

import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', apiRouter);

  return app;
}
