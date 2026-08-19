import express, { type Express, type Request, type Response } from 'express';

// Route stubs for the hire loop (MISSION.md, "The hire loop"). Every handler
// here returns 501 until the domain and adapter layers are wired in: the
// point of this file is the shape of the surface, not its behaviour.
function notImplemented(_req: Request, res: Response): void {
  res.status(501).json({ error: 'not implemented' });
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/operators', notImplemented);
  app.post('/agents', notImplemented);
  app.get('/agents/:agentDid/card', notImplemented);
  app.get('/agents/:agentDid/credentials', notImplemented);

  app.post('/jobs', notImplemented);
  app.post('/jobs/:jobId/confirm', notImplemented);
  app.post('/jobs/:jobId/pull-request', notImplemented);
  app.post('/jobs/:jobId/merge', notImplemented);
  app.post('/jobs/:jobId/reviews', notImplemented);

  return app;
}
