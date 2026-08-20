import express, { type Express, type Request, type Response } from 'express';

import {
  OperatorAlreadyExistsError,
  type OperatorRepository,
} from '../adapters/storage/types.js';
import { createOperatorRepository } from '../adapters/storage/storage.js';
import { isValidOperatorDid } from '../domain/operator-did.js';
import type { Operator } from '../domain/operator.js';

// Route stubs for the hire loop (MISSION.md, "The hire loop"). Every handler
// here returns 501 until the domain and adapter layers are wired in: the
// point of this file is the shape of the surface, not its behaviour.
function notImplemented(_req: Request, res: Response): void {
  res.status(501).json({ error: 'not implemented' });
}

// The Operator record projection is the whole response. Exactly these three
// fields, nothing more: tests/api/operator-invariant2.test.ts asserts the
// key set, and a fourth field here would be a contract change.
function operatorProjection(row: Operator): Record<string, unknown> {
  return {
    did: row.did,
    githubLogin: row.githubLogin,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createApp(repo: OperatorRepository = createOperatorRepository()): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/operators', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { did?: unknown; githubLogin?: unknown };
    const did = body.did;
    const githubLogin = body.githubLogin;

    if (typeof did !== 'string' || typeof githubLogin !== 'string' || did.length === 0 || githubLogin.length === 0) {
      res.status(400).json({
        error: 'body must be { did, githubLogin }; both are non-empty strings',
      });
      return;
    }
    if (!isValidOperatorDid(did)) {
      res.status(400).json({
        error: 'did must look like did:abt:<suffix>, non-empty suffix, no whitespace',
      });
      return;
    }

    try {
      const row = await repo.register({ did, githubLogin });
      res.status(201).json(operatorProjection(row));
    } catch (err) {
      // A duplicate DID is a 409: the operator registered it already, and
      // the message tells them what to check.
      if (err instanceof OperatorAlreadyExistsError) {
        res.status(409).json({ error: `operator ${did} is already registered` });
        return;
      }
      // Anything else (a dead database, a disk error) is our problem, not the operator's:
      // 503 with the cause in the log, not the body, so a dead database fails closed.
      console.error('POST /operators: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.get('/operators/:did', async (req: Request, res: Response) => {
    try {
      const row = await repo.findByDid(String(req.params.did));
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(operatorProjection(row));
    } catch (err) {
      console.error('GET /operators/:did: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

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
