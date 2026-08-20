import express, { type Express, type Request, type Response } from 'express';

import { createIdentityAdapter } from '../adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../adapters/identity/types.js';
import {
  AgentAlreadyExistsError,
  OperatorAlreadyExistsError,
  type AgentRepository,
  type OperatorRepository,
} from '../adapters/storage/types.js';
import { createAgentRepository, createOperatorRepository } from '../adapters/storage/storage.js';
import { delegationConsistent, type Agent, type Delegation } from '../domain/agent.js';
import { didDocumentPointsAtGithubAccount, githubAccountUrl } from '../domain/account-proof.js';
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

function agentProjection(row: Agent): Record<string, unknown> {
  return {
    did: row.did,
    operatorDid: row.operatorDid,
    delegation: row.delegation,
    name: row.name,
    skills: [...row.skills],
    githubLogin: row.githubLogin,
    proofStatus: row.proofStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

// The body carries the W3C Verifiable Credential exactly as produced.
// This only checks that the fields the service relies on are present and
// well-typed; the object then passes through untouched, because the bytes
// that verify are the bytes we store (ENT-3.1).
function delegationShape(value: unknown): Delegation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const vc = value as Record<string, unknown>;
  if (!Array.isArray(vc['@context'])) return null;
  if (typeof vc.id !== 'string' || vc.id.length === 0) return null;
  if (!Array.isArray(vc.type)) return null;
  if (typeof vc.issuer !== 'string' || vc.issuer.length === 0) return null;
  if (typeof vc.issuanceDate !== 'string' || vc.issuanceDate.length === 0) return null;
  const subject = vc.credentialSubject;
  const proof = vc.proof;
  if (typeof subject !== 'object' || subject === null) return null;
  if (typeof proof !== 'object' || proof === null) return null;
  const s = subject as Record<string, unknown>;
  const p = proof as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id.length === 0) return null;
  if (typeof p.type !== 'string' || p.type !== 'Ed25519Signature2020') return null;
  if (typeof p.proofValue !== 'string' || p.proofValue.length === 0) return null;
  return value as Delegation;
}

export function createApp(
  repo: OperatorRepository = createOperatorRepository(),
  agentRepo: AgentRepository = createAgentRepository(),
  identity: IdentityAdapter = createIdentityAdapter(),
): Express {
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

  app.post('/agents', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const did = body.did;
    const operator = body.operator;
    const name = body.name;
    const skills = body.skills;
    const githubLogin = body.githubLogin;

    if (
      typeof did !== 'string' || did.length === 0 ||
      typeof operator !== 'string' || operator.length === 0 ||
      typeof name !== 'string' || name.length === 0 ||
      !Array.isArray(skills) || skills.length === 0 ||
      skills.some((s) => typeof s !== 'string' || s.length === 0) ||
      (githubLogin !== undefined && (typeof githubLogin !== 'string' || githubLogin.length === 0))
    ) {
      res.status(400).json({
        error: 'body must be { did, operator, delegation, name, skills, githubLogin? }; did, operator, name non-empty strings, skills non-empty list of strings',
      });
      return;
    }
    // The registry speaks full DIDs (did:abt:...) in both fields; the
    // credential may carry either form, and that is reconciled below.
    if (!isValidOperatorDid(did) || !isValidOperatorDid(operator)) {
      res.status(400).json({
        error: 'did and operator must look like did:abt:<suffix>, non-empty suffix, no whitespace',
      });
      return;
    }
    const proof = delegationShape(body.delegation);
    if (proof === null) {
      res.status(400).json({
        error: 'delegation must be a W3C Verifiable Credential: object with @context, id, type, issuer (string), credentialSubject { id }, proof { type: Ed25519Signature2020, proofValue }, issuanceDate',
      });
      return;
    }

    let operatorRow: Operator | null;
    try {
      operatorRow = await repo.findByDid(operator);
    } catch (err) {
      console.error('POST /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (operatorRow === null) {
      res.status(404).json({
        error: `operator ${operator} is not registered; register it before delegating from it`,
      });
      return;
    }

    if (!delegationConsistent({ did, operatorDid: operator, delegation: proof })) {
      res.status(400).json({
        error: 'delegation does not bind this operator to this agent DID: type must include AgentDelegation, issuer must be the operator, credentialSubject must be the agent DID',
      });
      return;
    }

    // ownerDid is the credential's own subject, verbatim, because the
    // verifier compares it by equality with credentialSubject.id.
    const verified = await identity.verifyDelegation(proof, proof.credentialSubject.id, operator);
    if (!verified) {
      res.status(400).json({
        error: 'delegation proof failed verification: the signature does not check out against the operator key',
      });
      return;
    }

    try {
      const row = await agentRepo.create({
        did,
        operatorDid: operator,
        delegation: proof,
        name,
        skills,
        githubLogin: githubLogin ?? null,
      });
      res.status(201).json(agentProjection(row));
    } catch (err) {
      if (err instanceof AgentAlreadyExistsError) {
        res.status(409).json({ error: `agent ${did} is already delegated` });
        return;
      }
      console.error('POST /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.get('/agents/:agentDid', async (req: Request, res: Response) => {
    try {
      const row = await agentRepo.findByDid(String(req.params.agentDid));
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(agentProjection(row));
    } catch (err) {
      console.error('GET /agents/:agentDid: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-3, direction one (ENT-5): does the agent's DID document point at the
  // claimed GitHub account? The operator authors the alsoKnownAs entry off
  // platform in their wallet tooling; this route resolves the document and
  // records that the direction holds, as pending (ENT-5.1: verified needs
  // both directions, which lands in R-4).
  app.post('/agents/:agentDid/account-proof', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { handle?: unknown };
    const handle = body.handle;

    if (typeof handle !== 'string' || handle.length === 0 || /\s/.test(handle)) {
      res.status(400).json({
        error: 'body must be { handle }; a non-empty string with no whitespace',
      });
      return;
    }

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('POST /agents/:agentDid/account-proof: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    // A NotImplementedError until a resolver is wired, or any other
    // resolution failure, is a 503: the operator cannot fix a missing
    // backend, and failing open would record an unverified claim as held.
    let doc: DidDocument;
    try {
      doc = await identity.resolveDid(did);
    } catch (err) {
      console.error('POST /agents/:agentDid/account-proof: identity resolution failed', err);
      res.status(503).json({ error: 'identity resolution unavailable' });
      return;
    }

    if (!didDocumentPointsAtGithubAccount(doc.alsoKnownAs, handle)) {
      // The message names the DID and the exact URL to author, so the
      // operator can act on it in their wallet tooling.
      res.status(409).json({
        error: `the DID document for ${did} does not point at the GitHub account: add ${githubAccountUrl(handle)} to its alsoKnownAs field`,
      });
      return;
    }

    try {
      const updated = await agentRepo.updateGithubBinding(did, { handle, status: 'pending' });
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('POST /agents/:agentDid/account-proof: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.get('/agents/:agentDid/card', notImplemented);
  app.get('/agents/:agentDid/credentials', notImplemented);

  app.post('/jobs', notImplemented);
  app.post('/jobs/:jobId/confirm', notImplemented);
  app.post('/jobs/:jobId/pull-request', notImplemented);
  app.post('/jobs/:jobId/merge', notImplemented);
  app.post('/jobs/:jobId/reviews', notImplemented);

  return app;
}
