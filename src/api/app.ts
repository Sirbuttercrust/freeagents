import { randomBytes } from 'node:crypto';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { createCredentialResolver } from '../adapters/credentials/credentials.js';
import type { CredentialsAdapter } from '../adapters/credentials/types.js';
import { createGithubAdapter } from '../adapters/github/github.js';
import {
  GistNotFoundError,
  type Gist,
  type GithubAdapter,
  type PullRequestRef,
  type PullRequestSummary,
} from '../adapters/github/types.js';
import { createIdentityAdapter } from '../adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../adapters/identity/types.js';
import {
  AgentAlreadyExistsError,
  CredentialNotFoundError,
  JobAlreadyExistsError,
  OperatorAlreadyExistsError,
  type AgentRepository,
  type CompromiseRepository,
  type JobRepository,
  type OperatorRepository,
} from '../adapters/storage/types.js';
import {
  createAgentRepository,
  createCompromiseRepository,
  createJobRepository,
  createOperatorRepository,
} from '../adapters/storage/storage.js';
import { delegationConsistent, type Agent, type Delegation } from '../domain/agent.js';
import {
  didDocumentPointsAtGithubAccount,
  gistProofPayload,
  githubAccountUrl,
  parseGistStatement,
  parseGistUrl,
  signatureIsWellFormed,
  statementBindsBinding,
  type GistStatement,
  type GistUrlRef,
} from '../domain/account-proof.js';
import { isValidOperatorDid } from '../domain/operator-did.js';
import type { Operator } from '../domain/operator.js';
import {
  acceptCriterion,
  completeJob,
  confirmSpec,
  createJob,
  JobError,
  JobTransitionError,
  proposeCriteria,
  recordClosedUnmerged,
  recordStale,
  recordWithdrawn,
  requestChanges,
  submitPullRequest,
  validateJobTransition,
  type CompletedJob,
  type Job,
  type JobStatus,
} from '../domain/job.js';
import { rotationWellFormed, type KeyRotation } from '../domain/key-rotation.js';
import { buyerDiversity } from '../domain/buyer-diversity.js';
import {
  disputedBy,
  reportWellFormed,
  type CompromiseReport,
} from '../domain/compromise.js';
import { ACCESS_NOTICE, CAPABILITIES, type Capability } from '../domain/access.js';
import { renderAvatar } from './avatar.js';

// The hire-loop's last stub (R-12 reviews) stays honest about being unbuilt:
// it returns 501 until its issue lands. Merge (R-11) now has a real handler
// below; every route before it in the loop already did.
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

// The Capability projection is the whole response. Exactly these six fields,
// nothing more: tests/api/capabilities-invariant2.test.ts asserts the key
// set, and a seventh field here would be a contract change. R-23 states the
// limit before a user invests effort, so this is read by anyone, signed in
// or not.
function capabilityProjection(cap: Capability): Record<string, unknown> {
  return {
    id: cap.id,
    method: cap.method,
    path: cap.path,
    access: cap.access,
    identityField: cap.identityField,
    reason: cap.reason,
  };
}

// The Agent record projection is the whole response. Exactly these ten
// fields, nothing more: tests/api/agent-invariant2.test.ts asserts the key
// set, and an eleventh field here would be a contract change. avatar (R-21)
// and keyRotations (R-30) ride the base key set unconditionally - every agent
// has a DID and a (possibly empty) rotation history, so there is no state to
// wait on; conditional-spread style stays reserved for fields a row may lack
// (jobProjection's confirmation pair). They can never be client-supplied:
// nothing reads body.avatar or a rotation from any request body anywhere.
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
    avatar: renderAvatar(row.did),
    // R-30: the rotation history rides the base key set unconditionally,
    // the same way the avatar does (R-21): every agent has a history, an
    // empty one before the first rotation, so the key set never changes
    // shape with state. ENT-8.4's third party resolves the superseded key
    // from it, and the profile shows the rotation with dates (R-6).
    keyRotations: row.keyRotations.map((rotation) => ({
      fromKey: rotation.fromKey,
      toKey: rotation.toKey,
      rotatedAt: rotation.rotatedAt.toISOString(),
    })),
  };
}

// R-16: the compromise report projection. Never mixed into agentProjection
// or a credential document (ENT-8.3): the window is visible on its own
// routes instead of a field on either.
function compromiseReportProjection(report: CompromiseReport): Record<string, unknown> {
  return {
    key: report.key,
    since: report.since.toISOString(),
    reportedAt: report.reportedAt.toISOString(),
  };
}

// The Job draft projection is the whole response. Exactly these eight fields
// for a draft, nothing more: tests/api/job-invariant2.test.ts asserts the key
// set, and a ninth field here would be a contract change. brief rides the
// response beside briefHash so anyone holding both can recompute the hash with
// off-the-shelf tools, no call to this service (invariant 2). criteria joins
// only once the exchange has something in it (R-8); confirm (R-9) adds
// specHash and confirmedAt beside them, so a confirmed job projects the base
// eight plus criteria, specHash and confirmedAt - a draft still projects
// exactly the pinned eight keys. Submit (R-10) adds pullRequestUrl,
// submittedAt and deadline the same conditional way: they appear only on a
// submitted job and every state after it. Merge (R-11) adds mergeCommit and
// mergedAt the same way again: a completed job projects the submitted keyset
// plus exactly those two, both observed from GitHub rather than asserted
// (ENT-7.1). Outcomes (R-12, ENT-7.2) add nothing: a closed_unmerged or
// stale job projects the submitted keyset minus nothing and gains no merge
// facts, so an unhappy outcome can never read as a verified hire.
function jobProjection(row: Job): Record<string, unknown> {
  // Confirm (R-9) sets hash and timestamp together or neither - one domain
  // function writes both - so the pair rides one conditional, and the null
  // check on confirmedAt is what lets TypeScript see the toISOString call
  // cannot fire on a draft.
  const confirmation =
    row.confirmedSpecHash !== null && row.confirmedAt !== null
      ? { specHash: row.confirmedSpecHash, confirmedAt: row.confirmedAt.toISOString() }
      : {};
  // The same one-writer rule for submit (R-10): submitPullRequest writes all
  // three fields or none, so all three ride one conditional. deadline is
  // null on rows written before R-12, and stays null there - the projection
  // never invents one. A confirmed job keeps exactly the eleven pinned keys.
  const submission =
    row.pullRequestUrl !== null && row.submittedAt !== null
      ? {
          pullRequestUrl: row.pullRequestUrl,
          submittedAt: row.submittedAt.toISOString(),
          deadline: row.deadline === null ? null : row.deadline.toISOString(),
        }
      : {};
  // The same one-writer rule for merge (R-11): completeJob writes both
  // fields or neither, so both ride one conditional. A completed job keeps
  // exactly the submitted keyset plus these two.
  const completion =
    row.mergeCommit !== null && row.mergedAt !== null
      ? { mergeCommit: row.mergeCommit, mergedAt: row.mergedAt.toISOString() }
      : {};
  return {
    id: row.id,
    buyerDid: row.buyerDid,
    agentDid: row.agentDid,
    repository: row.repository,
    brief: row.brief,
    briefHash: row.briefHash,
    status: row.status,
    ...(row.criteria.length > 0 ? { criteria: row.criteria } : {}),
    ...confirmation,
    ...submission,
    ...completion,
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
  github: GithubAdapter = createGithubAdapter(),
  jobRepo: JobRepository = createJobRepository(),
  credentials: CredentialsAdapter = createCredentialResolver(),
  compromiseRepo: CompromiseRepository = createCompromiseRepository(),
): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // R-23: the identity boundary, stated before a user invests effort. No
  // storage, no adapter, synchronous, so no forwarded() wrapper and no 503
  // path applies here.
  app.get('/capabilities', (_req: Request, res: Response) => {
    res.status(200).json({
      notice: ACCESS_NOTICE,
      capabilities: CAPABILITIES.map(capabilityProjection),
    });
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

  // R-3 + R-4 (ENT-5): does the agent's GitHub account hold? Direction one
  // is the DID document's standard alsoKnownAs entry; direction two is a
  // public gist whose statement the agent's key signed. Without gist the
  // route records direction one as pending (R-3); with it, the binding is
  // marked verified only when BOTH directions hold (ENT-5.1).
  app.post('/agents/:agentDid/account-proof', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { handle?: unknown; gist?: unknown };
    const handle = body.handle;

    if (typeof handle !== 'string' || handle.length === 0 || /\s/.test(handle)) {
      res.status(400).json({
        error: 'body must be { handle, gist? }; handle is a non-empty string with no whitespace',
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

    // A malformed gist URL is a client error, and the URL owner must be the
    // claimed handle: the operator is pointing at someone else's gist, which
    // no signature could fix anyway.
    let gistRef: GistUrlRef | null = null;
    if (body.gist !== undefined) {
      if (typeof body.gist !== 'string' || (gistRef = parseGistUrl(body.gist)) === null) {
        res.status(400).json({
          error: 'gist, when present, must be a URL like https://gist.github.com/<owner>/<id>',
        });
        return;
      }
      if (gistRef.owner.toLowerCase() !== handle.toLowerCase()) {
        res.status(409).json({
          error: `direction two (signed gist): the gist URL owner ${gistRef.owner} does not match the claimed handle ${handle}`,
        });
        return;
      }
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
      // operator can act on it in their wallet tooling. The prefix appears
      // only when both directions were requested, to say which one failed.
      const prefix = gistRef === null ? '' : 'direction one (DID document): ';
      res.status(409).json({
        error: `${prefix}the DID document for ${did} does not point at the GitHub account: add ${githubAccountUrl(handle)} to its alsoKnownAs field`,
      });
      return;
    }

    if (gistRef === null) {
      // R-3: direction one alone records pending, never verified (ENT-5.1).
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
      return;
    }

    // R-4, direction two. Fetching the gist is a public, unauthenticated
    // read. A deleted gist (GistNotFoundError) is not a failure at all: it
    // is the check's answer, handled below. Any other failure is a
    // platform-side unavailability, not an operator error, so it is a 503
    // and records nothing.
    let gist: Gist;
    try {
      gist = await github.getPublicGist({ id: gistRef.id });
    } catch (err) {
      if (err instanceof GistNotFoundError) {
        // R-5 (ENT-5.3): the gist no longer exists. That is not an outage; it
        // is the check resolving to "the proof no longer stands". A verified
        // binding drops to unverified (the handle is kept: the claim was
        // made, it no longer holds). Anything weaker than verified has
        // nothing to lose, and a missing gist is operator-fixable, so it is
        // a 409.
        if (row.proofStatus === 'verified') {
          let updated: Agent | null;
          try {
            updated = await agentRepo.updateGithubBinding(did, {
              handle,
              status: 'unverified',
            });
          } catch (storageErr) {
            console.error('POST /agents/:agentDid/account-proof: storage failed', storageErr);
            res.status(503).json({ error: 'storage unavailable' });
            return;
          }
          if (updated === null) {
            res.status(404).json({ error: `agent ${did} is not registered` });
            return;
          }
          res.status(200).json(agentProjection(updated));
          return;
        }
        res.status(409).json({
          error: 'direction two (signed gist): the gist no longer resolves: recreate it at the published URL',
        });
        return;
      }
      console.error('POST /agents/:agentDid/account-proof: github unavailable', err);
      res.status(503).json({ error: 'github unavailable' });
      return;
    }

    // The gist must be authored by the claimed account itself, not merely
    // linked from it: a forked or quoted gist would otherwise pass.
    if (gist.owner === null || gist.owner.toLowerCase() !== handle.toLowerCase()) {
      res.status(409).json({
        error: `direction two (signed gist): the gist author ${gist.owner ?? 'unknown'} does not match the claimed handle ${handle}`,
      });
      return;
    }

    // The statement may sit in any file of the gist; the first well-formed
    // one decides. A gist with no well-formed statement, or one that binds a
    // different DID or account, is a conflict: the operator can fix the gist.
    let statement: GistStatement | null = null;
    for (const content of Object.values(gist.files)) {
      statement = parseGistStatement(content);
      if (statement !== null) break;
    }
    if (statement === null || !statementBindsBinding(statement, did, handle)) {
      res.status(409).json({
        error: 'direction two (signed gist): the gist does not hold a well-formed statement binding this agent DID to this account',
      });
      return;
    }

    // A signature the verifier cannot even decode - bad base64, wrong length
    // for ed25519 - is garbage in the gist, intrinsic to the input: reject it
    // here, where every other malformed-input path in this route lands,
    // instead of letting a real verify primitive turn it into what reads as
    // a platform outage.
    if (!signatureIsWellFormed(statement.signature)) {
      res.status(409).json({
        error:
          'direction two (signed gist): the signature field is not a well-formed ed25519 signature (base64, 64 bytes)',
      });
      return;
    }

    // The signature covers the canonical bytes built from the DID and the
    // account URL, not the statement text as written: a third party
    // reconstructs the same bytes from the gist alone (invariant 2).
    let checksOut: boolean;
    try {
      checksOut = await identity.verify({
        payload: gistProofPayload(did, githubAccountUrl(handle)),
        signature: statement.signature,
        signerDid: did,
      });
    } catch (err) {
      console.error('POST /agents/:agentDid/account-proof: identity verification failed', err);
      res.status(503).json({ error: 'identity verification unavailable' });
      return;
    }
    if (!checksOut) {
      res.status(409).json({
        error: 'direction two (signed gist): the signature does not check out against the agent key',
      });
      return;
    }

    try {
      const updated = await agentRepo.updateGithubBinding(did, { handle, status: 'verified' });
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

  // R-30 (ENT-8.4): the operator supersedes an agent's key. The route owns
  // only what the domain does not know about: the body's shape (checked
  // with R-29's rotationWellFormed, not restated), the agent's existence,
  // and the error mapping. fromKey === toKey is the no-op R-29's shape rule
  // defers to this route; it is rejected inline because a one-line equality
  // is the HTTP surface's call, not a domain rule (the validator's scope
  // finding on rotationIsIdentity). The record is public identifiers only,
  // so nothing here touches the identity adapter.
  app.post('/agents/:agentDid/key-rotation', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { fromKey?: unknown; toKey?: unknown };

    // rotationWellFormed is total by contract, so the untyped body halves
    // may be passed straight in; the cast is the call site's honesty mark.
    if (
      !rotationWellFormed({
        fromKey: body.fromKey,
        toKey: body.toKey,
        rotatedAt: new Date(),
      } as KeyRotation)
    ) {
      res.status(400).json({
        error:
          'body must be { fromKey, toKey }; both are non-empty strings in DID fragment form, did:abt:<suffix>#<fragment>',
      });
      return;
    }

    if ((body.fromKey as string) === (body.toKey as string)) {
      res.status(400).json({
        error: 'a rotation supersedes a key with a different one: fromKey and toKey are the same key',
      });
      return;
    }

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('POST /agents/:agentDid/key-rotation: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    try {
      const updated = await agentRepo.recordKeyRotation(did, {
        fromKey: body.fromKey as string,
        toKey: body.toKey as string,
      });
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('POST /agents/:agentDid/key-rotation: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-16 (ENT-8.4): an operator reports one of the agent's keys compromised.
  // A side record beside the agent, never a field on it, and never written
  // into a signed credential (ENT-8.3 forbids a judgement inside the
  // signature envelope). The route owns the body's shape (checked with
  // reportWellFormed, not restated) and the one semantic check reportWellFormed
  // does not make: since must not be in the future.
  app.post('/agents/:agentDid/compromise-report', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { key?: unknown; since?: unknown };
    const since = new Date(String(body.since));

    // Checked ahead of reportWellFormed: that validator's own since <=
    // reportedAt rule would otherwise catch a future since first (it is
    // handed reportedAt: new Date() below), and report it with the generic
    // shape message instead of this more useful one. An unparseable since
    // has NaN for getTime(), and NaN > anything is false, so this falls
    // through to reportWellFormed's shape check without a separate guard.
    if (since.getTime() > Date.now()) {
      res.status(400).json({ error: 'since must not be in the future' });
      return;
    }

    // reportWellFormed is total by contract, so the untyped body halves may
    // be passed straight in; the cast is the call site's honesty mark.
    if (
      !reportWellFormed({
        key: body.key,
        since,
        reportedAt: new Date(),
      } as CompromiseReport)
    ) {
      res.status(400).json({
        error:
          'body must be { key, since }; key is a non-empty string in DID fragment form, did:abt:<suffix>#<fragment>, and since is an ISO-8601 instant at or before now',
      });
      return;
    }

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('POST /agents/:agentDid/compromise-report: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    try {
      const report = await compromiseRepo.record(did, { key: body.key as string, since });
      res.status(201).json(compromiseReportProjection(report));
    } catch (err) {
      console.error('POST /agents/:agentDid/compromise-report: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-16: "the window is visible". Every report an operator has filed for
  // this agent, nothing hidden, nothing summarised away.
  app.get('/agents/:agentDid/compromise-reports', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('GET /agents/:agentDid/compromise-reports: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    try {
      const reports = await compromiseRepo.listByAgentDid(did);
      res.status(200).json({ agentDid: did, reports: reports.map(compromiseReportProjection) });
    } catch (err) {
      console.error('GET /agents/:agentDid/compromise-reports: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-33: the agent's hire record. Distinct buyers ride beside total hires and
  // every row carries its self-hire label, so no reading of this response can
  // present five self-hires as five independent buyers (MISSION invariant 5).
  // Its own route rather than a field on agentProjection, the same way the
  // compromise window is (see compromiseReportProjection): agentProjection is
  // a pinned ten-key row projection with no storage aggregation in it.
  app.get('/agents/:agentDid/hires', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('GET /agents/:agentDid/hires: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    // findCompletedByAgent is optional on JobRepository (a hand-rolled stand-in
    // from an unrelated route's tests may omit it); a driver that cannot
    // answer this read fails the same way a driver that throws does.
    if (typeof jobRepo.findCompletedByAgent !== 'function') {
      console.error('GET /agents/:agentDid/hires: storage does not support findCompletedByAgent');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const hires = await jobRepo.findCompletedByAgent(row.did);
      const { counts, entries } = buyerDiversity(hires, row.operatorDid);
      res.status(200).json({ agentDid: did, counts, entries });
    } catch (err) {
      console.error('GET /agents/:agentDid/hires: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.get('/agents/:agentDid/card', notImplemented);
  app.get('/agents/:agentDid/credentials', notImplemented);

  // R-15 (ENT-8): resolve an issued credential by its stable id. The
  // credential is a linked-data document, so it is served as
  // application/ld+json, verbatim from storage, so the proof still verifies
  // off-platform (invariant 2). No authentication: resolvable is part of
  // the contract (spec/work-history-extension-v1.md, credentials.endpoint).
  // Issuance is R-13's wiring; this route serves what it is handed.
  app.get('/v1/credentials/:credentialId', async (req: Request, res: Response) => {
    const credentialId = String(req.params.credentialId);
    try {
      const document = await credentials.getCredential(credentialId);
      res.status(200).set('Content-Type', 'application/ld+json').send(JSON.stringify(document));
    } catch (err) {
      if (err instanceof CredentialNotFoundError) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      console.error('GET /v1/credentials/:credentialId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-16 (ENT-8.4): "marks work signed inside the window as disputed". This
  // reads the credential; it never rewrites it. The marker lives here, on a
  // route beside the document, and never inside it: ENT-8.3 forbids a
  // judgement inside the signature envelope, and invariant 2 requires the
  // bytes that verified to be the bytes served at
  // GET /v1/credentials/:credentialId, unchanged by a report ever being filed.
  app.get('/v1/credentials/:credentialId/status', async (req: Request, res: Response) => {
    const credentialId = String(req.params.credentialId);
    let document;
    try {
      document = await credentials.getCredential(credentialId);
    } catch (err) {
      if (err instanceof CredentialNotFoundError) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      console.error('GET /v1/credentials/:credentialId/status: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    const subject = document.credentialSubject.id;
    const signedBy = document.credentialSubject.hire.signedBy;
    const signedAt = document.credentialSubject.hire.mergedAt;

    let reports: readonly CompromiseReport[];
    try {
      reports = await compromiseRepo.listByAgentDid(subject);
    } catch (err) {
      console.error('GET /v1/credentials/:credentialId/status: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    const windows = disputedBy(reports, signedBy, new Date(signedAt));
    res.status(200).json({
      credentialId,
      subject,
      signedBy,
      signedAt,
      disputed: windows.length > 0,
      windows: windows.map(compromiseReportProjection),
    });
  });

  // R-28 (ENT-4): open a draft job from the buyer's brief. The route owns
  // only what the domain does not know about: body shape, DID and repository
  // syntax, and agent existence (a driver asymmetry — Prisma rejects an
  // unknown agentDid through its foreign key while memory accepts it — so
  // the check lives here to keep both drivers answering identically).
  // Everything about the brief itself, including its emptiness and the hash,
  // is delegated to createJob rather than restated.
  app.post('/jobs', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const buyerDid = body.buyerDid;
    const agentDid = body.agentDid;
    const repository = body.repository;
    const brief = body.brief;

    if (
      typeof buyerDid !== 'string' || buyerDid.length === 0 ||
      typeof agentDid !== 'string' || agentDid.length === 0 ||
      typeof repository !== 'string' || repository.length === 0 ||
      typeof brief !== 'string' || brief.length === 0
    ) {
      res.status(400).json({
        error: 'body must be { buyerDid, agentDid, repository, brief }; all are non-empty strings',
      });
      return;
    }
    if (!isValidOperatorDid(buyerDid) || !isValidOperatorDid(agentDid)) {
      res.status(400).json({
        error: 'buyerDid and agentDid must look like did:abt:<suffix>, non-empty suffix, no whitespace',
      });
      return;
    }
    // owner/name on GitHub (ENT-4), syntactic only: this issue makes no
    // GitHub calls, so a repo that does not exist surfaces when the PR
    // route lands, not here.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) {
      res.status(400).json({
        error: 'repository must be an owner/name pair like buyer/target-repo',
      });
      return;
    }

    let agentRow: Agent | null;
    try {
      agentRow = await agentRepo.findByDid(agentDid);
    } catch (err) {
      console.error('POST /jobs: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (agentRow === null) {
      res.status(404).json({
        error: `agent ${agentDid} is not registered; delegate an agent on this DID before opening a job for it`,
      });
      return;
    }

    const id = 'j-' + randomBytes(8).toString('hex');
    // The domain owns the brief rule (createJob rejects a brief that is
    // empty or whitespace-only): the route maps the thrown JobError to 400
    // and passes its message through, so there is one wording of the rule,
    // not two.
    let job: Job;
    try {
      job = createJob({ id, buyerDid, agentDid, repository, brief }, new Date());
    } catch (err) {
      if (err instanceof JobError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    try {
      const row = await jobRepo.create(job);
      res.status(201).json(jobProjection(row));
    } catch (err) {
      // A duplicate id needs 64 bits of collision to fire and the id was
      // drawn this request, so this branch is unreachable in practice; it is
      // kept so the mapping is deterministic should entropy ever shrink.
      if (err instanceof JobAlreadyExistsError) {
        res.status(409).json({ error: `job ${id} already exists` });
        return;
      }
      console.error('POST /jobs: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const row = await jobRepo.findById(String(req.params.jobId));
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(jobProjection(row));
    } catch (err) {
      console.error('GET /jobs/:jobId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // Express 4 does not route a rejected promise from an async handler to
  // its error layer: a rethrow like runExchange's would vanish into an
  // unhandled rejection and take the whole process down. Forwarding the
  // rejection here keeps the handler's own mapping untouched (JobError is
  // still mapped to 400 inside runExchange) while anything unexpected
  // reaches the terminal handler below as a 500 instead of a crash.
  function forwarded(fn: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  }

  // R-8's shared skeleton for the criteria exchange: load the job, let the
  // domain apply its rule, persist through repo.update. The error mapping
  // mirrors POST /jobs — a bad body or a domain rule is the caller's to fix
  // (400), an unknown id is 404, a state conflict is 409, and storage trouble
  // is 503 with the cause in the log, not the body.
  async function runExchange(label: string, jobId: string, res: Response, apply: (job: Job) => Job): Promise<void> {
    let current: Job | null;
    try {
      current = await jobRepo.findById(jobId);
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (current === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    let updated: Job;
    try {
      updated = apply(current);
    } catch (err) {
      if (err instanceof JobError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof JobTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }

    try {
      const row = await jobRepo.update(updated);
      if (row === null) {
        // The row vanished between the read and the write; the id the caller
        // named does not resolve either way.
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(jobProjection(row));
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  }

  // The agent proposes acceptance criteria, or re-proposes after pushback
  // (ENT-6, D2): draft -> proposed on the first call, list replaced in place
  // while proposed. Emptiness, trimming and the proposer enum are the
  // domain's rules; only the body shape is checked here.
  app.post(
    '/jobs/:jobId/criteria',
    forwarded(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { criteria?: unknown };
      const input = body.criteria;
      // The element guard is a conjunction of five conditions: typeof
      // object, non-null, non-array, string text, string proposedBy. Each
      // conjunct has its own input in tests/api/job-criteria.test.ts - with
      // any one deleted, its input either falls through to a later check or
      // crashes, so a test per conjunct is what makes the guard
      // non-deletable.
      const wellFormed =
        Array.isArray(input) &&
        input.every(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            !Array.isArray(c) &&
            typeof (c as Record<string, unknown>).text === 'string' &&
            typeof (c as Record<string, unknown>).proposedBy === 'string',
        );
      if (!wellFormed) {
        res.status(400).json({
          error:
            'body must be { criteria: [{ text, proposedBy }] }; text and proposedBy are strings, proposedBy is "agent" or "buyer"',
        });
        return;
      }
      await runExchange('POST /jobs/:jobId/criteria', String(req.params.jobId), res, (job) =>
        proposeCriteria(
          job,
          input as ReadonlyArray<{ readonly text: string; readonly proposedBy: string }>,
        ),
      );
    }),
  );

  // The buyer pushes back: every acceptance resets, the job stays in
  // proposed, no new row. No body is required.
  app.post(
    '/jobs/:jobId/request-changes',
    forwarded(async (req: Request, res: Response) => {
      await runExchange('POST /jobs/:jobId/request-changes', String(req.params.jobId), res, requestChanges);
    }),
  );

  // Either party records joint agreement on one criterion (ENT-6.2: one
  // shared flag, "both parties agreed"). Index comes from the path; NaN,
  // fractions and out-of-range values reach the domain and come back as 400.
  app.post(
    '/jobs/:jobId/criteria/:index/accept',
    forwarded(async (req: Request, res: Response) => {
      await runExchange('POST /jobs/:jobId/criteria/:index/accept', String(req.params.jobId), res, (job) =>
        acceptCriterion(job, Number(req.params.index)),
      );
    }),
  );

  // Confirm (R-9, ENT-4.2): the domain computes specHash from the stored
  // criteria - no request body reaches it, so the wire cannot disagree with
  // what was agreed. Body-less like request-changes.
  app.post(
    '/jobs/:jobId/confirm',
    forwarded(async (req: Request, res: Response) => {
      await runExchange('POST /jobs/:jobId/confirm', String(req.params.jobId), res, (job) =>
        confirmSpec(job, new Date()),
      );
    }),
  );

  // The buyer withdraws an open job (R-31, D3 2026-08-22): recorded
  // withdrawn, terminal, a timing fact. Body-less like request-changes;
  // every rule lives in recordWithdrawn, the route only names the label.
  app.post(
    '/jobs/:jobId/withdraw',
    forwarded(async (req: Request, res: Response) => {
      await runExchange('POST /jobs/:jobId/withdraw', String(req.params.jobId), res, recordWithdrawn);
    }),
  );

  // R-10 (ENT-4.3, ENT-4.5): fork the buyer's repository and open the pull
  // request carrying the job id. The route owns only what the domain cannot
  // know: splitting the stored owner/name pair, formatting the public
  // artifacts (branch, title, body), and sequencing - the adapter fires
  // BEFORE anything persists, because a pull request is an external side
  // effect no storage rollback can undo.
  app.post(
    '/jobs/:jobId/pull-request',
    forwarded(async (req: Request, res: Response) => {
      const jobId = String(req.params.jobId);

      let current: Job | null;
      try {
        current = await jobRepo.findById(jobId);
      } catch (err) {
        console.error('POST /jobs/:jobId/pull-request: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (current === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      // Opening a PR is a public external side effect, so the state machine
      // is consulted before it can fire at all: a draft or proposed job gets
      // its 409 without one adapter call. validateJobTransition is pure and
      // submitPullRequest re-checks, so this duplicates no rule - it only
      // keeps the side effect on the right side of the gate. Only
      // JobTransitionError can escape the validator; anything else is a fault
      // nobody mapped, so it rethrows to the terminal handler as a 500.
      try {
        validateJobTransition(current.status, 'submitted');
      } catch (err) {
        if (!(err instanceof JobTransitionError)) {
          throw err;
        }
        res.status(409).json({ error: err.message });
        return;
      }

      // repository was regex-checked to exactly one slash at POST /jobs time,
      // so slicing around the single separator always yields both parts -
      // no array destructuring, whose undefined members strict mode would
      // otherwise demand a guard for.
      const slashAt = current.repository.indexOf('/');
      const sourceOwner = current.repository.slice(0, slashAt);
      const sourceRepo = current.repository.slice(slashAt + 1);
      // The title carries the job id where triage sees it first (ENT-4.5),
      // and the body carries the same hashes the API projects, so anyone
      // holding the public PR alone can tie it to job and agreed spec
      // without calling this service (invariant 2) - plus the factual line
      // about write access, because invariant 1 is part of the claim.
      const title = `FreeAgents job ${jobId}`;
      const body = [
        `Job: ${jobId}`,
        `Repository: ${current.repository}`,
        `Brief hash: ${current.briefHash}`,
        `Spec hash: ${String(current.confirmedSpecHash)}`,
        '',
        'This pull request was opened by FreeAgents against a fork it controls; the platform holds no write access to the source repository.',
      ].join('\n');

      // Any failure here is platform-side unavailability, not caller error:
      // 503 with the cause logged, nothing recorded - mirroring the
      // account-proof github leg, so both github-facing routes answer alike.
      let ref: PullRequestRef;
      try {
        ref = await github.forkAndOpenPullRequest({
          sourceOwner,
          sourceRepo,
          branch: `freeagents/${jobId}`,
          title,
          body,
        });
      } catch (err) {
        console.error('POST /jobs/:jobId/pull-request: github unavailable', err);
        res.status(503).json({ error: 'github unavailable' });
        return;
      }
      const pullRequestUrl = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;

      // The domain applies its rule and the shared skeleton persists it:
      // JobError->400, transition->409, vanished row->404, dead storage->503,
      // exactly like every sibling route after confirm.
      await runExchange('POST /jobs/:jobId/pull-request', jobId, res, (job) =>
        submitPullRequest(job, pullRequestUrl, new Date()),
      );
    }),
  );

  // R-11 (ENT-7.1): the merge is observed from GitHub's API, never asserted
  // by either party. The route never trusts a client-supplied state - it
  // always asks github directly. A non-merged answer records the outcome it
  // reports, never hides it (R-12, ENT-7.2): closed-unmerged becomes
  // closed_unmerged, and an open PR past its deadline becomes stale. Stale
  // is not terminal - a merge observed after the stale marker still
  // completes the job (D3 2026-08-22).
  app.post(
    '/jobs/:jobId/merge',
    forwarded(async (req: Request, res: Response) => {
      const jobId = String(req.params.jobId);

      let current: Job | null;
      try {
        current = await jobRepo.findById(jobId);
      } catch (err) {
        console.error('POST /jobs/:jobId/merge: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (current === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      // Captured as a const so the outcome recorder below, an async closure,
      // sees the narrowed non-null row.
      const job = current;

      // A known status other than submitted or stale is a conflict before
      // github is ever asked. stale falls through on purpose (D3 2026-08-22):
      // a merge after the stale marker still completes, so its PR is still
      // observed. A corrupted (non-enum) status is not in this list either,
      // so it falls through to completeJob's own validator below - the same
      // contract the pull-request route uses for its corrupted-status leg.
      const nonObservationStatuses: readonly JobStatus[] = [
        'draft',
        'proposed',
        'confirmed',
        'completed',
        'closed_unmerged',
      ];
      if (nonObservationStatuses.includes(current.status)) {
        res.status(409).json({ error: new JobTransitionError(current.status, 'merge').message });
        return;
      }

      // A submitted job always carries a URL in the shape submitPullRequest
      // itself wrote (R-10); anything else is a corrupted row, not a caller
      // error, so it reaches the terminal handler as a 500 like the
      // pull-request route's own corrupted-state leg.
      const match =
        current.pullRequestUrl === null
          ? null
          : /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(current.pullRequestUrl);
      if (match === null) {
        throw new Error(`job ${jobId} is submitted but pullRequestUrl is missing or malformed`);
      }
      const [, owner, repo, prNumber] = match;
      if (owner === undefined || repo === undefined || prNumber === undefined) {
        throw new Error(`job ${jobId} is submitted but pullRequestUrl is missing or malformed`);
      }
      const ref: PullRequestRef = { owner, repo, number: Number(prNumber) };

      // This is the ENT-7.1 observation itself: the state that decides
      // whether the job completes comes from github, never from the caller.
      let summary: PullRequestSummary;
      try {
        summary = await github.getPullRequest(ref);
      } catch (err) {
        console.error('POST /jobs/:jobId/merge: github unavailable', err);
        res.status(503).json({ error: 'github unavailable' });
        return;
      }

      // R-12 (ENT-7.2): record the observed outcome, with the same storage
      // legs as the merged answer below - transition conflict 409, vanished
      // row 404, dead storage 503 with the cause in the log.
      const recordOutcome = async (record: (job: Job) => Job): Promise<void> => {
        let next: Job;
        try {
          next = record(job);
        } catch (err) {
          // Covers a row whose status moved between the read and here, or a
          // terminal row that reached this point (withdrawn is not in the
          // guard above): the outcome is refused, and the row is left as
          // found.
          if (err instanceof JobTransitionError) {
            res.status(409).json({ error: err.message });
            return;
          }
          throw err;
        }
        try {
          const row = await jobRepo.update(next);
          if (row === null) {
            // The row vanished between the read and the write.
            res.status(404).json({ error: 'not found' });
            return;
          }
          res.status(200).json(jobProjection(row));
        } catch (err) {
          console.error('POST /jobs/:jobId/merge: storage failed', err);
          res.status(503).json({ error: 'storage unavailable' });
        }
      };

      if (summary.state === 'open') {
        if (job.status === 'stale') {
          // Recording stale twice is not a no-op: the outcome is already on
          // record, so a second open observation is a conflict, not a
          // rewrite.
          res.status(409).json({ error: 'the job is already recorded stale and the pull request is still open' });
          return;
        }
        // Lazy detection: this route is the only observation point this
        // codebase has, so the deadline is checked here rather than by a
        // scheduler. Pre-R-12 rows carry no deadline and keep the 409.
        if (job.deadline !== null && Date.now() >= job.deadline.getTime()) {
          await recordOutcome(recordStale);
        } else {
          res.status(409).json({ error: 'pull request is open; it has not merged yet' });
        }
        return;
      }
      if (summary.state === 'closed') {
        await recordOutcome(recordClosedUnmerged);
        return;
      }

      // A merged state with no merge commit sha is an inconsistent github
      // response, not a caller error: ENT-7 requires the merge commit, so
      // this is our problem to surface as a 500, not a 409 or 400.
      if (summary.mergeCommitSha === null) {
        throw new Error(`github reported job ${jobId}'s pull request merged with no merge commit sha`);
      }

      let outcome: { readonly job: Job; readonly completedJob: Omit<CompletedJob, 'id'> };
      try {
        outcome = completeJob(current, {
          mergeCommit: summary.mergeCommitSha,
          // The merge instant is github's fact, not this service's clock
          // (ENT-7.1); only a github response with no timestamp at all falls
          // back to observing it now.
          completedAt: summary.mergedAt ?? new Date(),
        });
      } catch (err) {
        // Covers a job that completed between the read above and here.
        if (err instanceof JobTransitionError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }

      try {
        const row = await jobRepo.complete(outcome.job, outcome.completedJob);
        if (row === null) {
          // The row vanished between the read and the write.
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.status(200).json(jobProjection(row));
      } catch (err) {
        console.error('POST /jobs/:jobId/merge: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  app.post('/jobs/:jobId/reviews', notImplemented);

  // Terminal error layer: a fault that reached here was not mapped by a
  // route's own catch, so it is our problem, not the caller's. Same terms as
  // every storage failure - cause in the log, not the body, so nothing the
  // process said internally leaks out.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('unhandled request failure', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
