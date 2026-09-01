import { createHash, randomBytes } from 'node:crypto';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { createCredentialsAdapter } from '../adapters/credentials/credentials.js';
import type {
  CredentialsAdapter,
  VerifiableCredential,
  WorkHistoryClaim,
} from '../adapters/credentials/types.js';
import { createGithubAdapter } from '../adapters/github/github.js';
import {
  GistNotFoundError,
  type Gist,
  type GithubAdapter,
  type PullRequestRef,
  type PullRequestSummary,
} from '../adapters/github/types.js';
import { createDidAbtSigningKeyResolver } from '../adapters/identity/did-abt-resolver.js';
import { verify as verifySignature } from '../adapters/identity/http-signature.js';
import { createIdentityAdapter } from '../adapters/identity/identity.js';
import type { DidDocument, IdentityAdapter } from '../adapters/identity/types.js';
import { createRateLimiter, type RateLimiter } from '../adapters/identity/verify-rate-limit.js';
import {
  AgentAlreadyExistsError,
  CredentialNotFoundError,
  JobAlreadyExistsError,
  AccountAlreadyExistsError,
  ReviewAlreadyExistsError,
  type AgentRepository,
  type CompromiseRepository,
  type CredentialRepository,
  type JobRepository,
  type AccountRepository,
  type ReviewRepository,
} from '../adapters/storage/types.js';
import {
  createAgentRepository,
  createCompromiseRepository,
  createCredentialRepository,
  createJobRepository,
  createAccountRepository,
  createReviewRepository,
} from '../adapters/storage/storage.js';
import { delegationConsistent, type Agent, type Delegation } from '../domain/agent.js';
import { agentWorkRecord, type CredentialEvidence } from '../domain/agent-work-record.js';
import { lastHireCompletedAt, recordLastChangedAt } from '../domain/freshness.js';
import {
  filterBySkill,
  resolveBrowseSort,
  sortBrowseCards,
  toBrowseCard,
  type BrowseCard,
} from '../domain/browse.js';
import { operatorAggregate } from '../domain/operator-roster.js';
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
import type { Account } from '../domain/account.js';
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
  type Party,
} from '../domain/job.js';
import { rotationWellFormed, type KeyRotation } from '../domain/key-rotation.js';
import { buyerDiversity } from '../domain/buyer-diversity.js';
import {
  disputedBy,
  reportWellFormed,
  type CompromiseReport,
} from '../domain/compromise.js';
import {
  assertReviewEligible,
  buildReview,
  JobNotReviewableError,
  reviewTextWellFormed,
  ReviewAgentMismatchError,
  ReviewerNotBuyerError,
  type Review,
} from '../domain/review.js';
import { ACCESS_NOTICE, CAPABILITIES, type Capability } from '../domain/access.js';
import { SIGN_IN_METHODS, type SignInMethod } from '../domain/sign-in-methods.js';
import { type SessionAdapter, type SignInMethod as SessionSignInMethod } from '../adapters/identity/session.js';
import { sessionAdapterFromEnv } from '../adapters/identity/session-github-passkey.js';
import { createWebSurface, type WebSurface } from '../web/static.js';
import { renderAvatar } from './avatar.js';

// The hire-loop's last stub (R-12 reviews) stays honest about being unbuilt:
// it returns 501 until its issue lands. Merge (R-11) now has a real handler
// below; every route before it in the loop already did.
function notImplemented(_req: Request, res: Response): void {
  res.status(501).json({ error: 'not implemented' });
}

// The Account record projection is the whole response. Exactly these four
// fields, nothing more: tests/api/account-invariant2.test.ts asserts the
// key set, and a fifth field here would be a contract change.
// passkeySubject rides the base set unconditionally (null when the
// account never bound one), the same "every row has the field, not every
// row has a value" stance agentProjection takes on avatar and
// keyRotations: an account's shape does not change with which proof it
// used.
function accountProjection(row: Account): Record<string, unknown> {
  return {
    did: row.did,
    githubLogin: row.githubLogin,
    passkeySubject: row.passkeySubject,
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

// The SignInMethod projection is the whole response. Exactly these five
// fields, nothing more: tests/api/sign-in-methods.test.ts asserts the key
// set, and a sixth field here would be a contract change. Issue 84 states
// which methods exist before a user invests effort, so this is read by
// anyone, signed in or not.
function signInMethodProjection(method: SignInMethod): Record<string, unknown> {
  return {
    id: method.id,
    label: method.label,
    required: method.required,
    walletBased: method.walletBased,
    reason: method.reason,
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

// R-22 (ENT-10): the review projection. Exactly these five fields, nothing
// more, and no numeric field anywhere (ENT-10.2): text, attributed to the
// buyer DID, tied to the job it came from. Never mixed into agentProjection,
// a browse card, or a credential document, for the same separation
// compromiseReportProjection keeps.
function reviewProjection(review: Review): Record<string, unknown> {
  return {
    jobId: review.jobId,
    authorDid: review.authorDid,
    agentDid: review.agentDid,
    text: review.text,
    createdAt: review.createdAt.toISOString(),
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

// R-34: express.json's verify hook is the only point that sees the exact
// wire bytes before parsing re-serialises them, so it is the only place the
// content-digest check (the didSignature middleware below) can bind to. It fires only when
// express.json actually parses a JSON body -- a body-less request leaves
// rawBody undefined, treated as an empty buffer at the point of use.
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// R-34: the DID a verified request signature named, set by didSignature
// before next(). Undefined on every route that does not mount it, and on a
// mounted route when no signature headers were present at all (signing stays
// optional -- see ASSUMPTIONS SIGNATURE_OPTIONAL).
interface SignedRequest extends Request {
  signerDid?: string;
}

function signerDidOf(req: Request): string | null {
  return (req as SignedRequest).signerDid ?? null;
}

// R-39 completion: the subject AND method a live session named, set by
// requireSessionOrSignature before next(). Undefined on every route that
// does not mount it, and on a mounted route when no session was presented
// at all. The method matters because resolving a session to an Account
// joins through a DIFFERENT unique column depending on which proof
// produced it: a github-oauth session's subject is the GitHub login
// (Account.githubLogin), a passkey session's subject is the passkey
// subject (Account.passkeySubject). Joining through the wrong column
// would either miss a real account or, worse, resolve to the wrong one.
interface SessionedRequest extends Request {
  sessionSubject?: string;
  sessionMethod?: SessionSignInMethod;
}

// R-39 completion (issue 83's KNOWN GAP, t_d1b82a77, closed): the acting
// party the server computed, never a caller claim. Exactly one of two
// proofs resolves it, the same "one rule, one code path, both proofs"
// stance the brief names:
//   - a verified R-34 signature names the signer's own DID directly
//     (signerDidOf) -- the signer proved possession of a registered
//     agent or operator key, so that DID IS the acting party, with
//     nothing left to compare it against.
//   - a live session resolves through the account lookup the schema's
//     unique githubLogin / passkeySubject constraint makes safe: two
//     accounts can never claim the same login or subject, so this join
//     can never resolve to two different accounts for one session.
// Returns null when neither proof resolves to a party: requireSessionOrSignature
// already refused a caller with no proof at all, so null here means "a
// session exists but no account has claimed its identity yet" -- the
// caller is who they say they are, they simply have not registered.
async function resolveActingParty(req: Request, repo: AccountRepository): Promise<string | null> {
  const signerDid = signerDidOf(req);
  if (signerDid !== null) return signerDid;

  const sessioned = req as SessionedRequest;
  if (sessioned.sessionSubject === undefined || sessioned.sessionMethod === undefined) {
    return null;
  }
  const account =
    sessioned.sessionMethod === 'passkey'
      ? await repo.findByPasskeySubject(sessioned.sessionSubject)
      : await repo.findByGithubLogin(sessioned.sessionSubject);
  return account?.did ?? null;
}

export function createApp(
  repo: AccountRepository = createAccountRepository(),
  agentRepo: AgentRepository = createAgentRepository(),
  identity: IdentityAdapter = createIdentityAdapter(),
  github: GithubAdapter = createGithubAdapter(),
  jobRepo: JobRepository = createJobRepository(),
  credentials: CredentialsAdapter | undefined = undefined,
  compromiseRepo: CompromiseRepository = createCompromiseRepository(),
  credentialRepo: CredentialRepository = createCredentialRepository(),
  // #30 addendum: public does not mean scrapeable-to-death. A session
  // never raises this limit -- it gates the anonymous verify routes only,
  // by caller IP, independent of whatever identity mechanism R-39 adds.
  // 60 requests/minute is a generous default for a human or a legitimate
  // integration; a scraper hits it fast. Injectable so tests can pin a
  // small limit instead of hammering a live app hundreds of times.
  verifyRateLimiter: RateLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 }),
  web: WebSurface = createWebSurface(),
  reviewRepo: ReviewRepository = createReviewRepository(),
  // R-39 follow-up (issue 83): the session adapter hire and list routes
  // accept a bearer token against. Defaults to the env-derived adapter
  // (sessionAdapterFromEnv), matching every other capability's env-default
  // stance in this file. Injectable so tests can mint a live token against
  // a fake GitHub backend instead of exercising real OAuth.
  session: SessionAdapter = sessionAdapterFromEnv(),
): Express {
  // One repository behind both halves of the capability when the caller
  // supplies neither. createCredentialRepository() hands the memory driver a
  // fresh Map per call, so defaulting the adapter with its own separate call
  // would let this route store a credential the resolve route cannot find.
  // Prisma would never notice; the dev driver would, and a default that is
  // only wrong in dev is the kind that ships.
  const credentialsAdapter = credentials ?? createCredentialsAdapter(undefined, credentialRepo);
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  // R-34: either an agent or an operator DID may sign (the issue's wording
  // is "a registered agent or operator DID"). A storage failure inside this
  // lookup throws, which createDidAbtSigningKeyResolver's own try/catch
  // turns into null -- an unverifiable signature, not a 500.
  const signingKeys = createDidAbtSigningKeyResolver(
    async (did) => (await agentRepo.findByDid(did)) !== null || (await repo.findByDid(did)) !== null,
  );

  // R-34: adds a second, optional, verifiable identity path alongside the
  // hire-loop routes that carry it. Shared by didSignature (optional: an
  // unsigned request passes through untouched) and requireSessionOrSignature
  // (mandatory: the route below refuses outright when this returns 'absent'
  // and no session covers the gap either). A present-but-invalid signature
  // is worse than none in both callers, so both map 'invalid' to the same
  // 401 rather than falling through to "as if unsigned".
  async function verifySignedRequest(req: Request): Promise<'absent' | 'invalid' | { readonly did: string }> {
    // Only a fully unsigned request is absent: absent both headers, this is
    // unchanged behaviour for every caller that exists today. Exactly one
    // present falls through to verifySignature below, which already treats
    // a half-signed request as invalid input (its own first check is
    // `if (!sigInputValue || !sigValue) return null`) -- restating that
    // check here would just be the same 401 twice.
    if (req.headers['signature-input'] === undefined && req.headers['signature'] === undefined) {
      return 'absent';
    }

    const targetUri = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
    const result = await verifySignature(
      { method: req.method, targetUri, headers: req.headers },
      signingKeys,
      { requiredComponents: ['@method', '@target-uri', 'content-digest'] },
    );
    if (result === null) return 'invalid';

    // The adapter verifies the signature bytes; it never sees the body, so
    // the digest match is this function's half -- what binds the body
    // actually received to the signature that named it as covered.
    const raw = (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);
    const want = `sha-256=:${createHash('sha256').update(raw).digest('base64')}:`;
    const got = req.headers['content-digest'];
    if (typeof got !== 'string' || got.trim() !== want) return 'invalid';

    return { did: result.did };
  }

  // R-34: a second, optional, verifiable identity path alongside the four
  // ENT-6.2 party-exchange routes that carry it (criteria, request-changes,
  // accept, confirm) -- it never replaces a check that exists today on those
  // routes, because none does (no session, cookie or bearer token gates
  // them; only the caller-identity match inside each handler). POST /jobs,
  // POST /accounts and POST /agents no longer use this middleware: they are
  // gated by requireSessionOrSignature below instead (R-39 follow-up, issue
  // 83). Unsigned traffic on the four exchange routes is untouched; a
  // request that is signed wrong is refused rather than let through,
  // because a present-but-invalid signature is worse than none. Wrapped
  // like forwarded() below, for the same Express-4 reason: a rejected
  // promise here would otherwise vanish into an unhandled rejection.
  const didSignature = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const outcome = await verifySignedRequest(req);
      if (outcome === 'absent') {
        next();
        return;
      }
      if (outcome === 'invalid') {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
      (req as SignedRequest).signerDid = outcome.did;
      next();
    })().catch(next);
  };

  // R-39 follow-up (issue 83): the bearer token an Authorization header
  // carries, or null for anything else (absent, wrong scheme, malformed).
  // Total, never throws, so the gate below treats a malformed header the
  // same as an absent one rather than crashing on it.
  function bearerTokenOf(req: Request): string | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1] ?? null;
  }

  // R-39 follow-up (issue 83): hire and list routes (the identified set in
  // src/domain/access.ts -- POST /agents, POST /jobs) require EITHER a live
  // session OR a verified R-34 signature naming a party. Neither is a
  // fallback dressed up as the other: both are first-class, checked
  // independently, and either alone is sufficient (anchor: "A session is
  // required exactly where an account is required"). POST /accounts does
  // NOT use this gate: registering an operator is how an account is
  // created, not an action an account performs, so it cannot itself demand
  // one -- see D1/bootstrap-deadlock below on the route itself. A
  // present-but-invalid signature is refused outright, the same stance
  // didSignature takes, rather than silently falling back to a session
  // check that might also fail -- two wrongs reading as one 401 would hide
  // which credential was actually rejected. Only when no signature was
  // presented at all does the session check run; only when that also comes
  // up empty (absent, expired, or revoked -- getSession resolves all three
  // to null indistinguishably) does the route refuse, naming both ways a
  // caller can satisfy it.
  const requireSessionOrSignature = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const sigOutcome = await verifySignedRequest(req);
      if (sigOutcome === 'invalid') {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
      if (sigOutcome !== 'absent') {
        (req as SignedRequest).signerDid = sigOutcome.did;
        next();
        return;
      }

      const token = bearerTokenOf(req);
      if (token !== null) {
        const liveSession = await session.getSession(token);
        if (liveSession !== null) {
          (req as SessionedRequest).sessionSubject = liveSession.subject;
          (req as SessionedRequest).sessionMethod = liveSession.method;
          next();
          return;
        }
      }

      res.status(401).json({
        error:
          'this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34)',
      });
    })().catch(next);
  };

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // The public web surface, mounted BEFORE every API route. Order is the
  // mechanism: three page paths are also API paths, and the page handler
  // hands the request straight on unless the caller explicitly asked for
  // text/html. An API client's behaviour is unchanged by a single byte;
  // see src/web/static.ts for why the split is by Accept and nothing else.
  web.mountPages(app);

  // R-23: the identity boundary, stated before a user invests effort. No
  // storage, no adapter, synchronous, so no forwarded() wrapper and no 503
  // path applies here.
  app.get('/capabilities', (_req: Request, res: Response) => {
    res.status(200).json({
      notice: ACCESS_NOTICE,
      capabilities: CAPABILITIES.map(capabilityProjection),
    });
  });

  // Issue 84: the sign-in methods a user may choose, stated before a user
  // invests effort. This route authenticates nobody: no session, no OAuth,
  // no passkey, no middleware. No storage, no adapter, synchronous, so no
  // forwarded() wrapper and no 503 path applies here, the same as
  // GET /capabilities above.
  app.get('/sign-in-methods', (_req: Request, res: Response) => {
    res.status(200).json({
      methods: SIGN_IN_METHODS.map(signInMethodProjection),
    });
  });

  // R-39 follow-up (issue 83, D1/bootstrap-deadlock): registering an
  // operator is account CREATION, not an action an existing account
  // performs. The issue's own anchor names hire and list, and access.ts's
  // own doc comment says 'identified' means "body must name the acting
  // party", not "must authenticate" -- registration is how a party comes
  // to exist, so it cannot be conditioned on a credential that itself
  // presupposes one. Gating this route was proved (t_8b63ee9e) to deadlock
  // every fresh deployment: no route mints a session before an operator
  // exists, and the signing-key resolver only accepts an already-registered
  // DID, so a self-signed request from a brand-new operator would ALSO be
  // refused. The identityField in access.ts ('did') is still the acting
  // party's own claim, checked below the same way it always was; only the
  // session-or-signature gate in front of it is gone.
  app.post('/accounts', async (req: Request, res: Response) => {
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
      res.status(201).json(accountProjection(row));
    } catch (err) {
      // A duplicate DID is a 409: the operator registered it already, and
      // the message tells them what to check.
      if (err instanceof AccountAlreadyExistsError) {
        res.status(409).json({ error: `operator ${did} is already registered` });
        return;
      }
      // Anything else (a dead database, a disk error) is our problem, not the operator's:
      // 503 with the cause in the log, not the body, so a dead database fails closed.
      console.error('POST /accounts: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.get('/accounts/:did', async (req: Request, res: Response) => {
    try {
      const row = await repo.findByDid(String(req.params.did));
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(accountProjection(row));
    } catch (err) {
      console.error('GET /accounts/:did: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-19 (D4, ENT-1.2): the operator roster. ANCHOR: an operator page is the
  // sum of who they run, never a score for the operator. Widens the same
  // browse-card assembly R-20 built (toBrowseCard, agentWorkRecord), so a
  // roster row and a browse card can never drift for the same agent; the
  // aggregate is derived structurally from those same rows
  // (operatorAggregate, src/domain/operator-roster.ts), three separate
  // tier totals, never a caller-supplied number and never a blended score.
  //
  // Sort and filter (D4, above ten agents only, enforced client-side in
  // operator.js): ?sort and ?skill are read the same way GET /agents reads
  // them, reusing resolveBrowseSort and filterBySkill rather than a second
  // rule for the same two query parameters (Proof, run 76, defect
  // inert-control-affordance: the controls must drive this route, the
  // exact mechanism browse's controls already drive).
  app.get('/accounts/:did/agents', async (req: Request, res: Response) => {
    const operatorDid = String(req.params.did);
    const sort = resolveBrowseSort(req.query.sort);
    const skillFilter = typeof req.query.skill === 'string' ? req.query.skill : null;

    let operatorRow: Account | null;
    try {
      operatorRow = await repo.findByDid(operatorDid);
    } catch (err) {
      console.error('GET /accounts/:did/agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (operatorRow === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    if (typeof agentRepo.listAll !== 'function') {
      console.error('GET /accounts/:did/agents: storage does not support listAll');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const rows = await agentRepo.listAll();
      const ownAgents = rows.filter((row) => row.operatorDid === operatorDid);
      const unsorted: BrowseCard[] = await Promise.all(
        ownAgents.map(async (row) => {
          const stored = await credentialRepo.listBySubjectDid(row.did);
          const evidence: CredentialEvidence[] = stored.map((entry) => ({
            credentialId: entry.document.id,
            repository: entry.document.credentialSubject.hire.repository,
            pullRequest: entry.document.credentialSubject.hire.pullRequest,
            mergedAt: entry.document.credentialSubject.hire.mergedAt,
            mergeCommit: entry.document.credentialSubject.hire.mergeCommit,
            buyerDid: entry.document.credentialSubject.hire.buyer,
            repositoryPublic: entry.repositoryPublic,
          }));
          const record = agentWorkRecord(evidence);
          return toBrowseCard(row, record);
        }),
      );
      // The aggregate is always over the FULL roster (item 1 of the R-19
      // card: no field derived from a wider or narrower population than
      // its own tier), so it is computed before filtering narrows the rows
      // that get rendered. A skill filter narrows what a visitor sees, not
      // what the operator is accountable for in the summary line.
      const aggregate = operatorAggregate(unsorted);
      const filtered = filterBySkill(unsorted, skillFilter);
      const cards = sortBrowseCards(filtered, sort);

      res.status(200).json({
        operatorDid,
        agents: cards,
        agentCount: unsorted.length,
        aggregate,
      });
    } catch (err) {
      console.error('GET /accounts/:did/agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-39 completion (t_d1b82a77, F1, closed): `operator` is DERIVED from
  // the proof the caller presented, never trusted from the body -- the
  // same pattern POST /jobs applies to buyerDid. A body-supplied operator
  // is optional and, when present, is checked against the derived party
  // and refused on mismatch; it is never itself the value the delegation
  // binds to, so naming a different account in the body can only be
  // refused, never honoured.
  app.post('/agents', requireSessionOrSignature, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const did = body.did;
    const claimedOperator = body.operator;
    const name = body.name;
    const skills = body.skills;
    const githubLogin = body.githubLogin;

    if (
      typeof did !== 'string' || did.length === 0 ||
      (claimedOperator !== undefined && typeof claimedOperator !== 'string') ||
      typeof name !== 'string' || name.length === 0 ||
      !Array.isArray(skills) || skills.length === 0 ||
      skills.some((s) => typeof s !== 'string' || s.length === 0) ||
      (githubLogin !== undefined && (typeof githubLogin !== 'string' || githubLogin.length === 0))
    ) {
      res.status(400).json({
        error: 'body must be { did, delegation, name, skills, operator?, githubLogin? }; did, name non-empty strings, skills non-empty list of strings, operator (if present) a string',
      });
      return;
    }
    // The registry speaks full DIDs (did:abt:...) in both fields; the
    // credential may carry either form, and that is reconciled below.
    if (!isValidOperatorDid(did)) {
      res.status(400).json({
        error: 'did must look like did:abt:<suffix>, non-empty suffix, no whitespace',
      });
      return;
    }
    // R-39 completion: the acting party, derived server-side from whichever
    // proof requireSessionOrSignature accepted. One code path, both proofs
    // (the same call resolveActingParty makes for POST /jobs).
    let operator: string | null;
    try {
      operator = await resolveActingParty(req, repo);
    } catch (err) {
      console.error('POST /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (operator === null) {
      res.status(403).json({
        error: 'no registered account resolves from your session or signature; register an account before listing an agent',
      });
      return;
    }
    if (typeof claimedOperator === 'string' && claimedOperator.length > 0 && claimedOperator !== operator) {
      res.status(403).json({ error: 'operator does not match the authenticated party' });
      return;
    }
    const proof = delegationShape(body.delegation);
    if (proof === null) {
      res.status(400).json({
        error: 'delegation must be a W3C Verifiable Credential: object with @context, id, type, issuer (string), credentialSubject { id }, proof { type: Ed25519Signature2020, proofValue }, issuanceDate',
      });
      return;
    }

    let operatorRow: Account | null;
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

  // R-20 (D1, ENT-2.2): the browse listing. GET /agents/:agentDid above
  // reads one agent's own record; this reads every listed agent as browse
  // cards, sorted and filtered per D1/Q1. Widens the same read agent-work-
  // record.ts already assembles, rather than a parallel endpoint. The card's
  // buyerCount is derived by toBrowseCard itself from the verified-hire tier
  // alone (src/domain/browse.ts), so this route no longer reads job history
  // at all: a job-repository read here is exactly how the tier-blind
  // buyerCount defect shipped (Proof, t_698205aa, summary-contradicts-tier).
  app.get('/agents', async (req: Request, res: Response) => {
    if (typeof agentRepo.listAll !== 'function') {
      console.error('GET /agents: storage does not support listAll');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    const sort = resolveBrowseSort(req.query.sort);
    const skillFilter = typeof req.query.skill === 'string' ? req.query.skill : null;

    try {
      const rows = await agentRepo.listAll();
      const cards: BrowseCard[] = await Promise.all(
        rows.map(async (row) => {
          const stored = await credentialRepo.listBySubjectDid(row.did);
          const evidence: CredentialEvidence[] = stored.map((entry) => ({
            credentialId: entry.document.id,
            repository: entry.document.credentialSubject.hire.repository,
            pullRequest: entry.document.credentialSubject.hire.pullRequest,
            mergedAt: entry.document.credentialSubject.hire.mergedAt,
            mergeCommit: entry.document.credentialSubject.hire.mergeCommit,
            buyerDid: entry.document.credentialSubject.hire.buyer,
            repositoryPublic: entry.repositoryPublic,
          }));
          const record = agentWorkRecord(evidence);
          return toBrowseCard(row, record);
        }),
      );

      const filtered = filterBySkill(cards, skillFilter);
      const sorted = sortBrowseCards(filtered, sort);
      res.status(200).json({ sort, agents: sorted });
    } catch (err) {
      console.error('GET /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // #30 addendum: the two verification routes (VERIFICATION_CAPABILITY_IDS
  // in src/domain/access.ts), and only those, carry the anonymous rate
  // limit. Everything else that is public (capabilities, operator browse)
  // is left alone -- the brief names verify routes specifically, not every
  // public GET.
  app.get('/agents/:agentDid', verifyRateLimiter.middleware, async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    try {
      const row = await agentRepo.findByDid(did);
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      // R-17 (ENT-8, ENT-2.4): every credential this platform issued to
      // this agent, paired with the one fact evidenceTier needs beyond
      // what a merge already proves. Read at response time, never stored
      // as a tier column, so a private repository can never be relisted
      // into a verified tier just by not re-checking it.
      const stored = await credentialRepo.listBySubjectDid(did);
      const evidence: CredentialEvidence[] = stored.map((entry) => ({
        credentialId: entry.document.id,
        repository: entry.document.credentialSubject.hire.repository,
        pullRequest: entry.document.credentialSubject.hire.pullRequest,
        mergedAt: entry.document.credentialSubject.hire.mergedAt,
        mergeCommit: entry.document.credentialSubject.hire.mergeCommit,
        buyerDid: entry.document.credentialSubject.hire.buyer,
        repositoryPublic: entry.repositoryPublic,
      }));

      // R-37: freshness as a visible fact (ENT-2, ENT-4), never a
      // denormalised column. findCompletedByAgent is optional on
      // JobRepository (the same stance the /hires route already takes),
      // so a driver that cannot answer this read fails the same way an
      // actual outage does, rather than rendering a false "no hires".
      if (typeof jobRepo.findCompletedByAgent !== 'function') {
        console.error('GET /agents/:agentDid: storage does not support findCompletedByAgent');
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      const completedHires = await jobRepo.findCompletedByAgent(did);
      const record = agentWorkRecord(evidence);
      // D1 (Proof, task t_c55991ed): lastHireCompletedAt must sit beside the
      // SAME population verifiedHires renders, or a private-repo agent's
      // page states both "no verified hires" and a date for the hire that
      // didn't verify. record.verifiedHires is the one array the "Verified
      // hire" section itself renders from (agent-work-record.ts), so
      // reading mergedAt off it, rather than off the tier-blind
      // completedHires, keeps the summary and the tier answering the same
      // question. recordLastChangedAt stays tier-agnostic on purpose: "did
      // anything in this record change" is a claim about the whole record,
      // not about the verified-hire tier, so it still reads completedHires.
      const freshness = {
        lastHireCompletedAt: lastHireCompletedAt(record.verifiedHires.map((hire) => ({ completedAt: hire.mergedAt }))),
        recordLastChangedAt: recordLastChangedAt(row, completedHires),
      };

      res.status(200).json({ ...agentProjection(row), ...record, ...freshness });
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

  // R-22 (ENT-10, issue 29): reviews are public to read, restricted to
  // write. Every review filed for this agent, no aggregate, no rating, the
  // same "the window is visible" stance compromise-reports takes above.
  app.get('/agents/:agentDid/reviews', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('GET /agents/:agentDid/reviews: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    try {
      const reviews = await reviewRepo.listByAgentDid(did);
      res.status(200).json({ agentDid: did, reviews: reviews.map(reviewProjection) });
    } catch (err) {
      console.error('GET /agents/:agentDid/reviews: storage failed', err);
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
  app.get('/v1/credentials/:credentialId', verifyRateLimiter.middleware, async (req: Request, res: Response) => {
    const credentialId = String(req.params.credentialId);
    try {
      const document = await credentialsAdapter.getCredential(credentialId);
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
      document = await credentialsAdapter.getCredential(credentialId);
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
  //
  // R-39 completion (t_d1b82a77, F1, closed): buyerDid is DERIVED from the
  // proof the caller presented, never trusted from the body. requireSessionOrSignature
  // already guarantees a session or a verified signature exists; here that
  // proof is resolved to an actual account DID (resolveActingParty), and a
  // proof that resolves to nobody (a live session with no matching
  // registered account) is refused, the same way an absent proof would be.
  // A body-supplied buyerDid is optional and, when present, is checked
  // against the derived party and refused on mismatch -- it is NEVER
  // itself the value written to the job, so smuggling a different DID into
  // the body can only be refused, never honoured.
  app.post('/jobs', requireSessionOrSignature, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const claimedBuyerDid = body.buyerDid;
    const agentDid = body.agentDid;
    const repository = body.repository;
    const brief = body.brief;

    if (
      (claimedBuyerDid !== undefined && typeof claimedBuyerDid !== 'string') ||
      typeof agentDid !== 'string' || agentDid.length === 0 ||
      typeof repository !== 'string' || repository.length === 0 ||
      typeof brief !== 'string' || brief.length === 0
    ) {
      res.status(400).json({
        error: 'body must be { agentDid, repository, brief, buyerDid? }; agentDid, repository, brief non-empty strings, buyerDid (if present) a string',
      });
      return;
    }
    if (!isValidOperatorDid(agentDid)) {
      res.status(400).json({
        error: 'agentDid must look like did:abt:<suffix>, non-empty suffix, no whitespace',
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

    // R-39 completion: the acting party, derived server-side from whichever
    // proof requireSessionOrSignature accepted. One code path, both proofs.
    let buyerDid: string | null;
    try {
      buyerDid = await resolveActingParty(req, repo);
    } catch (err) {
      console.error('POST /jobs: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (buyerDid === null) {
      res.status(403).json({
        error: 'no registered account resolves from your session or signature; register an account before hiring',
      });
      return;
    }
    if (typeof claimedBuyerDid === 'string' && claimedBuyerDid.length > 0 && claimedBuyerDid !== buyerDid) {
      res.status(403).json({ error: 'buyerDid does not match the authenticated party' });
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
    let row: Job | null;
    try {
      row = await jobRepo.findById(String(req.params.jobId));
    } catch (err) {
      console.error('GET /jobs/:jobId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Only a completed job can carry one, so an unmerged row never pays for
    // the lookup.
    if (row.mergeCommit === null) {
      res.status(200).json(jobProjection(row));
      return;
    }
    let credential: VerifiableCredential | null;
    try {
      // The lookup key is the job id: credentialLookupKey takes the last
      // path segment, and a bare id is its own key - the same key the merge
      // route saved under.
      credential = await credentialRepo.findByDocumentId(row.id);
    } catch (err) {
      console.error('GET /jobs/:jobId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    // Absent, never null, when nothing was stored: absence says "there is no
    // credential", where a null would read as "issued, and empty".
    res
      .status(200)
      .json(credential === null ? jobProjection(row) : { ...jobProjection(row), credential });
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
  //
  // Split into a load half and an apply-and-persist half so the caller-
  // identity gate below (runPartyExchange) can insert itself between the
  // two without a second jobRepo.findById call: the exchange routes' own
  // storage-fault tests pin the exact call sequence a route makes, and a
  // second read would be an observable, untested behaviour change for no
  // reason.
  async function loadForExchange(label: string, jobId: string, res: Response): Promise<Job | null> {
    let current: Job | null;
    try {
      current = await jobRepo.findById(jobId);
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return null;
    }
    if (current === null) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    return current;
  }

  async function applyAndPersist(
    label: string,
    res: Response,
    current: Job,
    apply: (job: Job) => Job,
  ): Promise<void> {
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

  // R-34 party binding, for the routes outside the ENT-6.2 exchange
  // (withdraw, pull-request, merge): a verified signature must name a
  // party to the job it is acting on, or it is decoration. Unsigned
  // callers (signerDid === null) are unaffected -- this only fires when a
  // signature was actually presented and verified. None of those routes
  // are wired to didSignature yet, so signerDid stays null for them today;
  // the parameter is what a future signed route lands on without a second
  // rule to write.
  async function runExchange(
    label: string,
    jobId: string,
    res: Response,
    apply: (job: Job) => Job,
    signerDid: string | null = null,
  ): Promise<void> {
    const current = await loadForExchange(label, jobId, res);
    if (current === null) return;
    if (signerDid !== null && signerDid !== current.buyerDid && signerDid !== current.agentDid) {
      res.status(403).json({ error: 'signature does not name a party to this job' });
      return;
    }
    await applyAndPersist(label, res, current, apply);
  }

  // ENT-6.2's caller-identity gate. The brief's defect #2: runExchange never
  // learned who was calling, so a buyer alone could accept every criterion
  // and confirm on the agent's behalf. R-34 closed the identity question for
  // good: a party to a job proves it is that party by possession of the
  // party's key, not by naming it. A header naming a party used to answer
  // that same question by assertion, as an interim seam while R-34 had not
  // yet landed on these routes; it has, so the header is gone. A verified
  // signerDid is the only source of identity here now.
  function partyForDid(job: Job, did: string): Party | null {
    if (did === job.buyerDid) return 'buyer';
    if (did === job.agentDid) return 'agent';
    return null;
  }

  // The party-aware sibling of runExchange, for the four routes ENT-6.2
  // binds: propose, request-changes, accept and confirm. No verified
  // signature at all is refused before the domain ever sees the request
  // (401: sign the request per R-34). A verified signature naming neither
  // party is refused too (403): proving you hold a key does not make you a
  // party to this particular job.
  async function runPartyExchange(
    label: string,
    jobId: string,
    req: Request,
    res: Response,
    apply: (job: Job, party: Party) => Job,
  ): Promise<void> {
    const current = await loadForExchange(label, jobId, res);
    if (current === null) return;

    const signerDid = signerDidOf(req);
    if (signerDid === null) {
      res.status(401).json({
        error: 'this route requires a verified request signature (R-34); sign the request naming this job\'s buyer or agent DID',
      });
      return;
    }
    const signedParty = partyForDid(current, signerDid);
    if (signedParty === null) {
      res.status(403).json({ error: 'signature does not name a party to this job' });
      return;
    }
    await applyAndPersist(label, res, current, (job) => apply(job, signedParty));
  }

  // The agent proposes acceptance criteria, or re-proposes after pushback
  // (ENT-6, D2): draft -> proposed on the first call, the list revised in
  // place while proposed. Emptiness, trimming and the proposer enum are the
  // domain's rules; only the body shape is checked here.
  app.post(
    '/jobs/:jobId/criteria',
    didSignature,
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
      await runPartyExchange('POST /jobs/:jobId/criteria', String(req.params.jobId), req, res, (job) =>
        proposeCriteria(
          job,
          input as ReadonlyArray<{ readonly text: string; readonly proposedBy: string }>,
        ),
      );
    }),
  );

  // The other side pushes back: the job stays in proposed, no new row.
  // requestChanges no longer resets acceptances itself (that would undo the
  // per-criterion reset proposeCriteria's diff now performs); it only
  // confirms the job is still open for negotiation. No body is required.
  app.post(
    '/jobs/:jobId/request-changes',
    didSignature,
    forwarded(async (req: Request, res: Response) => {
      await runPartyExchange(
        'POST /jobs/:jobId/request-changes',
        String(req.params.jobId),
        req,
        res,
        requestChanges,
      );
    }),
  );

  // Either party records ITS OWN agreement on one criterion (ENT-6.2: two
  // independent flags, not one shared one). Index comes from the path; NaN,
  // fractions and out-of-range values reach the domain and come back as 400.
  // Which party accepted comes from the caller-identity gate, never from the
  // request body: a buyer could otherwise accept on the agent's behalf by
  // simply claiming to be it.
  app.post(
    '/jobs/:jobId/criteria/:index/accept',
    didSignature,
    forwarded(async (req: Request, res: Response) => {
      await runPartyExchange(
        'POST /jobs/:jobId/criteria/:index/accept',
        String(req.params.jobId),
        req,
        res,
        (job, party) => acceptCriterion(job, Number(req.params.index), party),
      );
    }),
  );

  // Confirm (R-9, ENT-4.2): the domain computes specHash from the stored
  // criteria - no request body reaches it, so the wire cannot disagree with
  // what was agreed. Body-less like request-changes. The caller-identity
  // gate still applies (ENT-6.2): confirm is itself an exchange action, and
  // the gate this whole issue exists to close is that a single party could
  // call this route and lock in an agreement the other side never made.
  app.post(
    '/jobs/:jobId/confirm',
    didSignature,
    forwarded(async (req: Request, res: Response) => {
      await runPartyExchange('POST /jobs/:jobId/confirm', String(req.params.jobId), req, res, (job) =>
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
      const pullRequestUrl = current.pullRequestUrl;
      const match =
        pullRequestUrl === null
          ? null
          : /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(pullRequestUrl);
      if (match === null || pullRequestUrl === null) {
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
      const mergeCommitSha = summary.mergeCommitSha;

      let outcome: { readonly job: Job; readonly completedJob: Omit<CompletedJob, 'id'> };
      try {
        outcome = completeJob(current, {
          mergeCommit: mergeCommitSha,
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

      // ENT-8: the credential names the key that signed the merge, so the
      // agent's verification method is resolved before anything is written.
      // Same mapping as POST /agents/:agentDid/account-proof: a resolver we
      // cannot reach is a platform failure, not a caller error, and the job
      // stays submitted and fully retryable.
      let signedBy: string;
      try {
        const doc = await identity.resolveDid(job.agentDid);
        const method = doc.verificationMethod[0];
        if (method === undefined) {
          throw new Error(`the DID document for ${job.agentDid} carries no verification method`);
        }
        signedBy = method;
      } catch (err) {
        console.error('POST /jobs/:jobId/merge: identity resolution failed', err);
        res.status(503).json({ error: 'identity resolution unavailable' });
        return;
      }

      // Issuance BEFORE persistence, deliberately: a failed signing leaves
      // the job submitted and retryable, rather than completing a hire this
      // platform cannot attest to.
      const claim: WorkHistoryClaim = {
        jobId: job.id,
        repository: job.repository,
        pullRequestUrl,
        mergeCommitSha,
        // GitHub's instant, the same one stamped on the row (ENT-7.1).
        mergedAt: outcome.completedJob.completedAt.toISOString(),
        diffAdditions: summary.additions,
        diffDeletions: summary.deletions,
        diffFiles: summary.filesChanged,
        briefHash: job.briefHash,
        specHash: job.confirmedSpecHash,
        buyerDid: job.buyerDid,
        signedBy,
      };
      let credential: VerifiableCredential;
      try {
        credential = await credentialsAdapter.issueWorkHistoryCredential(job.agentDid, claim);
      } catch (err) {
        console.error('POST /jobs/:jobId/merge: credential issuance failed', err);
        res.status(503).json({ error: 'credential issuance unavailable' });
        return;
      }

      let row: Job | null;
      try {
        row = await jobRepo.complete(outcome.job, outcome.completedJob);
      } catch (err) {
        console.error('POST /jobs/:jobId/merge: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (row === null) {
        // The row vanished between the read and the write.
        res.status(404).json({ error: 'not found' });
        return;
      }

      // Two writes to one driver with no transaction spanning them. The
      // residual is named rather than hidden: a crash between them leaves a
      // completed job with no credential, and the retry meets the 409 the
      // completed status already returns. Nothing is lost - the credential
      // is re-derivable from the stored job row, github's report and the
      // platform key - but it is not re-derived automatically.
      try {
        await credentialRepo.save({
          completedJobId: row.id,
          subjectDid: row.agentDid,
          document: credential,
          // R-17 (invariant 4, proof gate finding): the one fact
          // evidenceTier needs beyond the merge itself, read off github's own
          // report on the same PR object the merge commit came from. Before
          // this line no writer ever passed the field, so every real hire
          // defaulted to the fail-closed false and could never reach
          // verified-hire, no matter how public the repository actually was.
          repositoryPublic: summary.repositoryPublic,
        });
      } catch (err) {
        console.error('POST /jobs/:jobId/merge: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }

      res.status(200).json({ ...jobProjection(row), credential });
    }),
  );

  // R-22 (ENT-10, issue 29): the review write. Replaces the 501 stub. Every
  // refusal rule the card names lives here or in the domain functions it
  // calls, never restated twice:
  //   1. Eligibility is proven, not claimed (assertReviewEligible reads the
  //      job record: completed status, exact buyer, exact agent).
  //   2. Never blended with evidence (R-17's tier machinery never imports
  //      this route or src/domain/review.ts; see the structural no-blend
  //      test in tests/domain/agent-work-record.test.ts's sibling for
  //      reviews).
  //   3. No numeric field anywhere (buildReview's return type has nowhere
  //      to put one).
  //   4. One review per completed hire (ReviewRepository.save's unique
  //      constraint, mapped to 409 below).
  //   5. Caller identity comes from a verified R-34 signature, never a
  //      body field: signerDidOf(req) is the only source of authorDid.
  app.post(
    '/jobs/:jobId/reviews',
    didSignature,
    forwarded(async (req: Request, res: Response) => {
      const jobId = String(req.params.jobId);
      const body = (req.body ?? {}) as { agentDid?: unknown; text?: unknown };
      const agentDid = body.agentDid;

      if (typeof agentDid !== 'string' || agentDid.length === 0 || !reviewTextWellFormed(body.text)) {
        res.status(400).json({
          error: 'body must be { agentDid, text }; agentDid a non-empty string, text a non-empty string',
        });
        return;
      }
      const text = body.text as string;

      // Rule 5: identity comes from the verified signature, never a body
      // field. No signature at all is refused before the job is even
      // loaded, the same way runPartyExchange refuses an unsigned exchange
      // call.
      const signerDid = signerDidOf(req);
      if (signerDid === null) {
        res.status(401).json({
          error: 'this route requires a verified request signature (R-34); sign the request as the buyer on this job',
        });
        return;
      }

      let job: Job | null;
      try {
        job = await jobRepo.findById(jobId);
      } catch (err) {
        console.error('POST /jobs/:jobId/reviews: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (job === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      // Rule 1: the check reads the job record; it never trusts the
      // request. claimedIdentity.buyerDid is the PROVEN signerDid, not a
      // body field, and claimedIdentity.agentDid is what the caller named,
      // checked against the job's own agentDid rather than reconciled to
      // it.
      try {
        assertReviewEligible(job, { buyerDid: signerDid, agentDid });
      } catch (err) {
        if (err instanceof JobNotReviewableError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof ReviewerNotBuyerError) {
          res.status(403).json({ error: err.message });
          return;
        }
        if (err instanceof ReviewAgentMismatchError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }

      const review = buildReview(job, { authorDid: signerDid, text }, new Date());
      try {
        await reviewRepo.save(review);
      } catch (err) {
        if (err instanceof ReviewAlreadyExistsError) {
          res.status(409).json({ error: err.message });
          return;
        }
        console.error('POST /jobs/:jobId/reviews: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      res.status(201).json(reviewProjection(review));
    }),
  );

  // Unmatched paths, after every API route has had its chance. A browser
  // gets the 404 page; every other caller gets the same JSON body the API
  // uses for a missing record, because answering a JSON client with a web
  // page would be a worse lie than the 404 itself.
  web.mountFallback(app);

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
