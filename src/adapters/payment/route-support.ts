// P10: the payment-safe route helpers (brief, "the two banned substrings").
// tests/architecture/no-custody.test.ts bans /transfer|payout|balance|
// custody|refund|charge|escrow/i on any non-comment line in any src file
// OUTSIDE src/adapters/payment. The route layer (src/api/app.ts) needs to
// name the remainder leg and read the USDC two-transfer tuple without
// ever writing either banned word itself. remainderSettled() in gate.ts
// is the established precedent: a wrapper that lives INSIDE this exempted
// directory so the route layer never has to write the word. This file is
// the same answer for the payment surface routes.
import type {
  Confirmation,
  CreateRequestInput,
  PaymentRail,
  PaymentRef,
  PaymentRequest,
  Rail,
  UsdcTransferIntent,
  WalletResponseInput,
} from './types.js';
import { LAPSE_AT_STAGED_STATUSES, type JobStatus } from '../../domain/job.js';
import { publicBaseUrlFromEnv } from '../credentials/credentials.js';
import {
  RepositoryEmptyError,
  RepositoryNotAccessibleError,
  type GithubAdapter,
  type RepositoryFacts,
} from '../github/types.js';

// The route-safe leg name. 'remainder', never 'balance': see the header
// comment above and src/domain/payment.ts's identically-named
// remainderUsd for the same reason.
export type RouteLeg = 'deposit' | 'remainder';

function toRailLeg(leg: RouteLeg): CreateRequestInput['leg'] {
  return leg === 'remainder' ? 'balance' : 'deposit';
}

function toRouteLeg(leg: CreateRequestInput['leg']): RouteLeg {
  return leg === 'balance' ? 'remainder' : 'deposit';
}

// B23 (bug ledger, C1 rehearsal s7): each leg is only ever eligible while
// the job is in the status that leg belongs to. Shared here, in the
// exempted payment directory, so every door onto the payment surface --
// both rails' /start routes, the USDC wallet-response route, the ABT
// session-mint door (app.ts's requireBuyerToMintAbtSession) and the ABT
// wallet-response callback (abt-did-connect.ts's onAuth) -- applies the
// SAME eligibility rule, rather than each door growing its own copy that
// can silently drift out of sync with the others (Proof round 1, D1 and
// D2 on this card: the token-mint door and onAuth each had their own gate
// missing entirely, because the check lived only in app.ts where those
// two doors could not reach it). The deposit leg settles before confirm
// (confirm's own gate reads it), so it is eligible only at 'proposed';
// the remainder leg settles while the work sits staged and unpaid, the
// exact fact LAPSE_AT_STAGED_STATUSES already names, so it shares that
// set.
const DEPOSIT_ELIGIBLE_STATUSES: ReadonlySet<JobStatus> = new Set(['proposed']);
export function legStatusEligible(leg: RouteLeg, status: JobStatus): boolean {
  return leg === 'deposit' ? DEPOSIT_ELIGIBLE_STATUSES.has(status) : LAPSE_AT_STAGED_STATUSES.has(status);
}
export function legStatusConflictMessage(leg: RouteLeg, status: JobStatus): string {
  const eligible = leg === 'deposit' ? '"proposed"' : '"staged" or "redo_requested"';
  return `the ${leg} leg is not payable while this job is in status "${status}"; it is only payable while the job is ${eligible}`;
}

// B25 (bug ledger, C1 rehearsal s8): each rail's routes refuse a job
// priced on the OTHER rail, in both directions. Shared for the identical
// reason legStatusEligible above is: every door onto the payment surface
// must apply the same rule.
export function legRailMismatchMessage(routeRail: Rail, jobRail: Rail | null): string {
  return `this job is priced on the "${jobRail}" rail; the "${routeRail}" payment routes refuse it`;
}

// Wraps rail.createRequest so the route layer supplies 'deposit' |
// 'remainder' and never writes the literal 'balance' itself.
export async function requestPayment(
  rail: PaymentRail,
  input: {
    readonly jobId: string;
    readonly leg: RouteLeg;
    readonly operatorAddress: string;
    readonly amountToken: string;
    readonly feeToken: string;
  },
): Promise<PaymentRequest> {
  return rail.createRequest({ ...input, leg: toRailLeg(input.leg) });
}

// Wraps rail.onWalletResponse for the same reason: the caller supplies a
// route-safe leg, this file is the only place that ever writes the rail's
// internal 'balance' spelling.
export async function processWalletResponse(
  rail: PaymentRail,
  leg: RouteLeg,
  input: Omit<Extract<WalletResponseInput, { rail: 'abt' }>, 'leg' | 'rail'> & { readonly rail: 'abt' },
): Promise<PaymentRef>;
export async function processWalletResponse(
  rail: PaymentRail,
  leg: RouteLeg,
  input: Omit<Extract<WalletResponseInput, { rail: 'usdc' }>, 'leg' | 'rail'> & { readonly rail: 'usdc' },
): Promise<PaymentRef>;
export async function processWalletResponse(
  rail: PaymentRail,
  leg: RouteLeg,
  input: Omit<WalletResponseInput, 'leg'>,
): Promise<PaymentRef> {
  return rail.onWalletResponse({ ...input, leg: toRailLeg(leg) } as WalletResponseInput);
}

// The route-safe leg a ref or request actually carries, read once, here,
// so a route file never has to compare against the literal 'balance'.
export function routeLegOf(value: { readonly leg: CreateRequestInput['leg'] }): RouteLeg {
  return toRouteLeg(value.leg);
}

// USDC only: the two transfer intents as a route-safe accessor, so a
// route file never writes `.transfers` or names a variable `transfers`
// (the brief's own named trap).
export function usdcTransferIntents(
  request: Extract<PaymentRequest, { rail: 'usdc' }>,
): readonly [UsdcTransferIntent, UsdcTransferIntent] {
  return request.transfers;
}

// confirm() is payment-safe already (Confirmation carries no banned
// vocabulary), so this is a plain passthrough kept here for symmetry: the
// route layer calls one small set of functions from this file for every
// rail interaction, rather than mixing direct rail calls with wrapped
// ones.
export async function confirmPayment(rail: PaymentRail, ref: PaymentRef): Promise<Confirmation> {
  return rail.confirm(ref);
}

// FIX-B36 (Make item 2): the deposit goes buyer to owner and never comes
// back (MISSION invariant 12; deposit.js:215), so the platform reads the
// job's repository BEFORE a deposit leg starts, on all three doors, and
// refuses (409, nothing started) a repository that is not ready. Shared
// here, in the exempted payment directory, the same reason
// legStatusEligible above is shared: every door onto the payment surface
// must apply the same rule, never each growing its own copy.
export type RepositoryReadinessResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 409 | 503; readonly message: string };

// The exact phrase deposit.js tells this case apart by (brief, Make item
// 2): kept byte-identical to confirm's own RepositoryNotAccessibleError
// message (app.ts:5278) plus the page address, since the private-repos
// walkthrough page (card t_1aa4b834, waiting on this PR) is the fix a
// buyer follows before paying, not after.
//
// Proof r3: agentGithubLogin is null when the agent has no VERIFIED
// GitHub login yet (domain/agent.ts's verifiedGithubLogin -- an absent
// login and an unverified one are both null here). Naming an unverified
// login, or worse the agent's own DID as a fallback, asked the buyer to
// grant read to an account nobody had proved belonged to the agent, or
// to an identifier that is not a GitHub account at all -- a grant no
// buyer could ever make (the impossible-remedy-message defect line).
// When null, the message says the agent has not verified one yet and
// names only the platform account, still ending on the same page
// address so the buyer has somewhere to go regardless.
export function repositoryNotAccessibleMessage(
  agentGithubLogin: string | null,
  platformGithubLogin: string,
  jobId: string,
): string {
  const grant =
    agentGithubLogin === null
      ? `the agent has not verified a GitHub account yet, so for now it gives the platform's GitHub account (${platformGithubLogin}) read access`
      : `it gives BOTH the agent's GitHub account (${agentGithubLogin}) and the platform's GitHub account (${platformGithubLogin}) read access`;
  return (
    `the platform cannot see this repository; for a private repository it must live in a GitHub organization ` +
    `that ${grant}; how to share it: ${publicBaseUrlFromEnv()}/private-repos?job=${jobId}`
  );
}

// STEER 2026-09-26: a private repository owned by a personal account has
// no read-only role on GitHub, so a platform account that can see one at
// all was given collaborator access, which carries write -- MISSION
// invariant 1 forbids an agent holding write, and the ruling on file for
// this case is the organization route. A public repository on a personal
// account is unaffected (only the private branch reaches this check).
export function repositoryPersonalAccountMessage(jobId: string): string {
  return (
    `this repository is private and owned by a personal account; a private repository must live in a GitHub ` +
    `organization, where agents get a read-only role: ${publicBaseUrlFromEnv()}/private-repos?job=${jobId}`
  );
}

// A private repository already in an organization, but the organization's
// own setting refuses forking of private repositories (measured
// 2026-09-26: the pull-only reader sees allow_forking follow the
// organization's setting a few seconds late). Names the fix directly: a
// setting the organization owner controls, not a repository the buyer
// has to move again.
export function repositoryForkingOffMessage(jobId: string): string {
  return (
    `this repository is private and forking of private repositories is off in the organization's settings; ` +
    `ask the organization owner to turn it on, or share access another way: ${publicBaseUrlFromEnv()}/private-repos?job=${jobId}`
  );
}

// GitHub cannot open a pull request into a repository with no commits
// (RepositoryEmptyError, measured 2026-09-26 against a real public empty
// repository: 409 "Git Repository is empty."). No page address: the fix
// has nothing to do with sharing access.
export function repositoryEmptyMessage(): string {
  return 'this repository has no commits yet; it needs one starting commit before work can land in it';
}

// Reads the job's repository through the shared adapter and maps every
// outcome the three deposit-start doors and confirm both care about.
// agentGithubLogin is the caller's own resolved value: the agent's
// VERIFIED GitHub login (domain/agent.ts's verifiedGithubLogin) when it
// has one, or null when it does not -- an absent login and an unverified
// one are both null, matching confirm's own grantPush guard and
// githubAccessNeededFor (app.ts), which likewise name only a verified
// login. The deposit leg is eligible while the job is still 'proposed',
// before confirm's own verified-GitHub gate runs, so the agent may not
// have completed GitHub proof yet at this point in the loop -- null is
// the ordinary case here, not an error. A 5xx or network failure from
// the adapter is any error that is neither typed error above, mapped to
// 503 "github unavailable", the same wording confirm's own catch-all
// already uses.
export async function checkRepositoryReady(
  github: GithubAdapter,
  input: {
    readonly repository: string;
    readonly jobId: string;
    readonly agentGithubLogin: string | null;
  },
): Promise<RepositoryReadinessResult> {
  const slashAt = input.repository.indexOf('/');
  const owner = input.repository.slice(0, slashAt);
  const repo = input.repository.slice(slashAt + 1);
  let facts: RepositoryFacts;
  try {
    facts = await github.readRepository({ owner, repo });
  } catch (err) {
    if (err instanceof RepositoryNotAccessibleError) {
      return {
        ok: false,
        status: 409,
        message: repositoryNotAccessibleMessage(input.agentGithubLogin, github.platformLogin, input.jobId),
      };
    }
    if (err instanceof RepositoryEmptyError) {
      return { ok: false, status: 409, message: repositoryEmptyMessage() };
    }
    return { ok: false, status: 503, message: 'github unavailable' };
  }
  if (facts.private && !facts.ownerIsOrganization) {
    return { ok: false, status: 409, message: repositoryPersonalAccountMessage(input.jobId) };
  }
  if (facts.private && !facts.allowForking) {
    return { ok: false, status: 409, message: repositoryForkingOffMessage(input.jobId) };
  }
  return { ok: true };
}
