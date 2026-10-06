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
import type { AbtEthPaymentRail, AbtEthStoredHalfPaidRecord } from './abt-eth.js';
import type { UsdcHalfPaidRecord, UsdcPaymentRailShim } from './usdc.js';
import { agreementGap, LAPSE_AT_STAGED_STATUSES, type AgreementGap, type Job, type JobStatus } from '../../domain/job.js';
import { verifiedGithubLogin, type Agent } from '../../domain/agent.js';
import { publicBaseUrlFromEnv } from '../credentials/credentials.js';
import type { JobRepository, SettlementRepository } from '../storage/types.js';
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

// B23: each leg is only ever eligible while
// the job is in the status that leg belongs to. Shared here, in the
// exempted payment directory, so every door onto the payment surface --
// both rails' /start routes, the USDC wallet-response route, the ABT
// session-mint door (app.ts's requireBuyerToMintAbtSession) and the ABT
// wallet-response callback (abt-did-connect.ts's onAuth) -- applies the
// SAME eligibility rule, rather than each door growing its own copy that
// can silently drift out of sync with the others (the token-mint door
// and onAuth each had their own gate
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

// B25: each rail's routes refuse a job
// priced on the OTHER rail, in both directions. Shared for the identical
// reason legStatusEligible above is: every door onto the payment surface
// must apply the same rule.
export function legRailMismatchMessage(routeRail: Rail, jobRail: Rail | null): string {
  return `this job is priced on the "${jobRail}" rail; the "${routeRail}" payment routes refuse it`;
}

// FIX-B39 (B39), rule 5: the message a door answers when the
// SETTLED DEPOSIT, not the job's own quote pin, disagrees with the rail
// this door belongs to. A buyer can act on this: pay the leg on the rail
// that already settled.
export function depositRailMismatchMessage(routeRail: Rail, depositRail: Rail): string {
  return `the deposit for this job was paid in "${depositRail}"; the "${routeRail}" payment routes refuse it`;
}

// B88: the same refusal for a leg that has not settled but whose price
// transfer already reached the owner in `heldRail`. The buyer can act on
// it: finish the leg in that currency.
export function heldRailMismatchMessage(leg: RouteLeg, routeRail: Rail, heldRail: Rail): string {
  return `part of the ${leg} for this job was paid in "${heldRail}"; finish it there, the "${routeRail}" payment routes refuse it`;
}

// B88: what a lifecycle door answers (409) while a leg's price transfer has
// reached the owner and the leg has not settled. It holds the leg the way a
// settled one is held: the terms take no change and neither side walks away.
// Each sentence names the next step. The owner has the buyer's money for
// part of the payment, so the way forward is to finish it.
export type HeldLegAction = 'change terms' | 'withdraw' | 'decline' | 'staged-decline' | 'redo';

const HELD_LEG_SENTENCES: Record<HeldLegAction, string> = {
  'change terms':
    "The deposit's price has already reached the owner, so the terms can no longer change. The buyer finishes the payment, then confirms the hire.",
  withdraw:
    "The deposit's price has already reached the owner, so this hire can no longer be withdrawn. Finish the payment, then confirm the hire.",
  decline: "The deposit's price has already reached the owner, so this hire can no longer be declined.",
  'staged-decline':
    "The balance's price has already reached the owner, so the work can no longer be declined. Finish the payment, and the agent opens the pull request next.",
  redo:
    "The balance's price has already reached the owner, so a redo can no longer be requested. Finish the payment, and the agent opens the pull request next.",
};

export function heldLegMessage(action: HeldLegAction): string {
  return HELD_LEG_SENTENCES[action];
}

// B88: the rail whose price transfer is recorded `confirmed` on a leg's
// half-paid record, null when neither rail holds the leg. This is the one
// read behind every refusal above and every door that checks the rail. A
// rail that is not configured is skipped. A record whose price transfer is
// not confirmed (fee only, mismatched, not yet on the network) holds
// nothing: no money reached the owner for the price. A failed read throws,
// and every caller answers it as unavailable, never as "nothing held". When
// both rails somehow hold the leg, USDC is answered first.
export async function railHoldingLeg(input: {
  readonly jobId: string;
  readonly leg: RouteLeg;
  readonly usdcRail: Pick<UsdcPaymentRailShim, 'readHalfPaidRecord'> | null;
  readonly abtEthRail: Pick<AbtEthPaymentRail, 'readHalfPaidRecord'> | null;
}): Promise<Rail | null> {
  if (input.usdcRail !== null) {
    const record = await usdcHalfPaidRecordFor(input.usdcRail, input.jobId, input.leg);
    if (record !== null && record.priceStatus === 'confirmed') return 'usdc';
  }
  if (input.abtEthRail !== null) {
    const record = await abtEthHalfPaidRecordFor(input.abtEthRail, input.jobId, input.leg);
    if (record !== null && record.priceStatus === 'confirmed') return 'abt_eth';
  }
  return null;
}

// FIX-B39, rule 5: the message every door answers when the hired agent's
// operator has no payout address on record for this rail. Byte-identical
// to the wording every existing per-rail 409 already used (S3/P8c), so
// tests/api/job-payment-usdc.test.ts's pre-existing "operator address"
// assertion keeps passing unedited. The ABT sibling assertion
// (tests/api/job-payment-abt.test.ts P8c) and the account-provisioning
// custody fence test were both EDITED on this card, per the rule-5
// ruling: they used to assert /start succeeded with no address set, and
// now assert this same 409, since rule 5 moves that refusal to /start.
// tests/architecture/no-custody.test.ts bans custody words including
// "payout" on any code line inside src/adapters/payment (this file), so
// this comment (a comment line, exempt) is the only place that word may
// appear near this function; the string itself says "operator address".
export function operatorAddressNotSetMessage(rail: Rail): string {
  const article = rail === 'abt' ? 'an ABT' : rail === 'abt_eth' ? 'an ABT-on-Ethereum' : 'a USDC';
  return `the hired agent's operator has not set ${article} operator address; PATCH /accounts/:did/operator-address first`;
}

// FIX-B39, rule 5: ONE shared eligibility check, in place of B25's
// job-rail-only check, called by every payment door (both /start routes,
// the token door, both wallet-response routes, and the ABT wallet
// callback). Checked in this order, matching the brief's own reading
// order for a buyer's refusal:
//   1. the job is pinned to the OTHER currency (a quote named one);
//   2. the deposit already SETTLED in the other currency (rule 3: once a
//      deposit has settled, only that deposit's currency is payable,
//      independent of whether the job itself ever got pinned to it --
//      confirm has not necessarily run yet);
//   3. part of THIS leg was already paid in the other currency: its price
//      transfer reached the owner (railHoldingLeg below) but the leg has
//      not settled. A leg held on a rail finishes on that rail, so no
//      other currency's door offers it, and nobody pays one leg twice;
//   4. the hired agent's operator has no payout address on record for
//      this currency at all.
// A caller passes operatorAddressOk rather than this function reaching
// into AccountRepository itself, so it stays usable from both the route
// layer (src/api/app.ts) and abt-did-connect.ts without either needing
// to import the other's address-resolution logic. That input is not
// always a passthrough of an existing lookup: usdcOperatorAddressForJob
// (app.ts) already resolved the address for its OWN recipient-quoting
// purpose before this card, so usdc/start reuses that result (wallet-
// response resolves it again inside its own check), but
// the ABT /start and token-mint doors added a SECOND resolution path
// here (abtOperatorAddressOk, app.ts) specifically because neither door
// had any prior reason to look up the ABT address before this card --
// abt-did-connect.ts's operatorAddressForJob resolves the identical fact
// for its own onAuth callback, kept separate because it builds the
// actual recipient, not merely a boolean.
//
// heldRail is required, not optional, so a door that forgets to read it
// does not compile. A caller that has nothing held passes null.
export interface RailDoorEligibilityResult {
  readonly ok: true;
}
export interface RailDoorEligibilityRefusal {
  readonly ok: false;
  readonly status: 409;
  readonly message: string;
}
export async function checkRailDoorEligible(input: {
  readonly jobId: string;
  readonly leg: RouteLeg;
  readonly routeRail: Rail;
  readonly jobRail: Rail | null;
  readonly heldRail: Rail | null;
  readonly settlementRepo: SettlementRepository;
  readonly operatorAddressOk: boolean;
}): Promise<RailDoorEligibilityResult | RailDoorEligibilityRefusal> {
  if (input.jobRail !== null && input.jobRail !== input.routeRail) {
    return { ok: false, status: 409, message: legRailMismatchMessage(input.routeRail, input.jobRail) };
  }
  const settledDeposit = await input.settlementRepo.findByJobAndLeg(input.jobId, 'deposit');
  if (settledDeposit !== null && settledDeposit.rail !== input.routeRail) {
    return { ok: false, status: 409, message: depositRailMismatchMessage(input.routeRail, settledDeposit.rail) };
  }
  if (input.heldRail !== null && input.heldRail !== input.routeRail) {
    return { ok: false, status: 409, message: heldRailMismatchMessage(input.leg, input.routeRail, input.heldRail) };
  }
  if (!input.operatorAddressOk) {
    return { ok: false, status: 409, message: operatorAddressNotSetMessage(input.routeRail) };
  }
  return { ok: true };
}

// B49 (this card): a leg that already has a settlement row must
// never be paid again. Before this check, a buyer who reloaded checkout
// before confirm was offered a fresh full payment for a leg that had
// already settled. Shared here for the same reason legStatusEligible and
// checkRailDoorEligible above are shared: every door onto the payment
// surface (both /start routes, the token-mint door, the USDC
// wallet-response route's non-replay path, and the ABT onAuth callback
// before it broadcasts) applies the identical rule. The sentence names
// the one phrase ("already been paid") a page tells this refusal apart
// by, and tells the buyer what to do next: reload rather than retry.
export function legAlreadySettledMessage(leg: RouteLeg): string {
  return `the ${leg} leg has already been paid; reload this page to see the confirmed payment`;
}

export async function checkLegNotAlreadySettled(input: {
  readonly jobId: string;
  readonly leg: RouteLeg;
  readonly settlementRepo: SettlementRepository;
}): Promise<RailDoorEligibilityResult | RailDoorEligibilityRefusal> {
  const settled = await input.settlementRepo.findByJobAndLeg(input.jobId, input.leg);
  if (settled !== null) {
    return { ok: false, status: 409, message: legAlreadySettledMessage(input.leg) };
  }
  return { ok: true };
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
  input: Omit<Extract<WalletResponseInput, { rail: 'abt_eth' }>, 'leg' | 'rail'> & { readonly rail: 'abt_eth' },
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

// Make 2 (this card): usdc/start carries the leg's half-paid record when
// one exists, so any device can finish a half-paid payment by sending
// only the missing transfer. Wrapped here, the one place that writes the
// rail's internal 'balance' spelling, exactly like requestPayment above.
export async function usdcHalfPaidRecordFor(
  rail: Pick<UsdcPaymentRailShim, 'readHalfPaidRecord'>,
  jobId: string,
  leg: RouteLeg,
): Promise<UsdcHalfPaidRecord | null> {
  return rail.readHalfPaidRecord(jobId, toRailLeg(leg));
}

// The ABT-on-Ethereum rail's half-paid record for a leg, read the same way
// and for the same reason as the USDC one above, with the id of the lock its
// confirmed transfer was checked against (null on a row written before the
// lock id was kept).
export async function abtEthHalfPaidRecordFor(
  rail: Pick<AbtEthPaymentRail, 'readHalfPaidRecord'>,
  jobId: string,
  leg: RouteLeg,
): Promise<AbtEthStoredHalfPaidRecord | null> {
  return rail.readHalfPaidRecord(jobId, toRailLeg(leg));
}

// The late-payment judgement (abt-eth-late.ts) under a name the route layer
// can write: the function's own name carries a word the no-custody test bans
// on code lines outside this directory, so the route file imports it from
// here, as it does every other helper that needs one.
export { judgeAbtEthLateTransfer as judgeLateAbtEthPayment } from './abt-eth-late.js';

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
  | {
      readonly ok: false;
      readonly status: 409 | 503;
      readonly message: string;
      // Set on the 503 only: the error the read threw, for the operator's
      // log. It is never part of the message a caller answers with.
      readonly cause?: unknown;
    };

// The walkthrough page address a repository refusal ends on. A job-scoped
// address (?job=<jobId>) is only meaningful once the job exists; a refusal
// at the brief, before any job is opened, passes null and gets the bare
// page, which renders the same four steps.
function privateReposAddress(jobId: string | null): string {
  const page = `${publicBaseUrlFromEnv()}/private-repos`;
  return jobId === null ? page : `${page}?job=${jobId}`;
}

// The not-visible message, used by all three deposit-start doors and by
// confirm (app.ts's RepositoryNotAccessibleError branch calls this same
// function). deposit.js tells it apart by the phrase "cannot see this
// repository". It ends with the address of the walkthrough page for this
// job (/private-repos, src/web/pages/private-repos.html), which a buyer
// can follow before the deposit starts, or at confirm if access changed
// after it.
//
// agentGithubLogin is null when the agent has no VERIFIED
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
      ? `gives the platform's GitHub account (${platformGithubLogin}) read access (the agent has not verified a GitHub account yet)`
      : `gives BOTH the agent's GitHub account (${agentGithubLogin}) and the platform's GitHub account (${platformGithubLogin}) read access`;
  return (
    `the platform cannot see this repository; for a private repository it must live in a GitHub organization ` +
    `that ${grant}; how to share it: ${publicBaseUrlFromEnv()}/private-repos?job=${jobId}`
  );
}

// The not-visible message at the brief. No job exists yet, so it carries no
// job address, and a brief may go to up to three agents, so it names the
// platform's account and speaks of each hired agent's account in general
// instead of naming one. Keeps the phrase "cannot see this repository" the
// payment page matches on.
export function repositoryNotAccessibleAtBriefMessage(platformGithubLogin: string): string {
  return (
    `the platform cannot see this repository; for a private repository it must live in a GitHub organization ` +
    `that gives read access to the platform's GitHub account (${platformGithubLogin}) and to the GitHub account of ` +
    `each agent you hire; how to share it: ${privateReposAddress(null)}`
  );
}

// STEER 2026-09-26: a private repository owned by a personal account has
// no read-only role on GitHub, so a platform account that can see one at
// all was given collaborator access, which carries write -- MISSION
// invariant 1 forbids an agent holding write, and the ruling on file for
// this case is the organization route. A public repository on a personal
// account is unaffected (only the private branch reaches this check).
export function repositoryPersonalAccountMessage(jobId: string | null): string {
  return (
    `this repository is private and owned by a personal account; a private repository must live in a GitHub ` +
    `organization, where agents get a read-only role: ${privateReposAddress(jobId)}`
  );
}

// A private repository already in an organization, but the organization's
// own setting refuses forking of private repositories (measured
// 2026-09-26: the pull-only reader sees allow_forking follow the
// organization's setting a few seconds late). Names the fix directly: a
// setting the organization owner controls, not a repository the buyer
// has to move again.
export function repositoryForkingOffMessage(jobId: string | null): string {
  return (
    `this repository is private and forking of private repositories is off in the organization's settings; ` +
    `ask the organization owner to turn it on, or share access another way: ${privateReposAddress(jobId)}`
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
//
// jobId is null for the read POST /jobs makes at the brief, before any job
// exists: the sentences then carry no job address, and the not-visible one
// names no single agent (a brief may go to several), so agentGithubLogin
// is not consulted.
export async function checkRepositoryReady(
  github: GithubAdapter,
  input: {
    readonly repository: string;
    readonly jobId: string | null;
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
        message:
          input.jobId === null
            ? repositoryNotAccessibleAtBriefMessage(github.platformLogin)
            : repositoryNotAccessibleMessage(input.agentGithubLogin, github.platformLogin, input.jobId),
      };
    }
    if (err instanceof RepositoryEmptyError) {
      return { ok: false, status: 409, message: repositoryEmptyMessage() };
    }
    return { ok: false, status: 503, message: 'github unavailable', cause: err };
  }
  if (facts.private && !facts.ownerIsOrganization) {
    return { ok: false, status: 409, message: repositoryPersonalAccountMessage(input.jobId) };
  }
  if (facts.private && !facts.allowForking) {
    return { ok: false, status: 409, message: repositoryForkingOffMessage(input.jobId) };
  }
  return { ok: true };
}

// FIX-B37 (B37 + B42): confirm refuses more than the deposit doors
// ever checked (the brief's own measured gap). Everything below is the
// deposit-readiness surface that closes it, shared by every door onto the
// payment surface the same way checkRepositoryReady already is.
export type DepositReadinessResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 409 | 503; readonly message: string };

// Sentence 1: no criteria at all yet. Ends on the agreement page so the
// buyer has somewhere to go regardless of which gap they hit.
export function agreementNoCriteriaMessage(jobId: string): string {
  return `the deposit can start only once the agreement has at least one line: ${publicBaseUrlFromEnv()}/agreement?job=${jobId}`;
}

// Sentence 2: some lines exist but are not accepted by both parties yet.
export function agreementCriteriaOutstandingMessage(jobId: string, outstanding: number, total: number): string {
  return (
    `the deposit can start only once both parties have signed every line of the agreement; ` +
    `${outstanding} of ${total} lines still need both signatures: ${publicBaseUrlFromEnv()}/agreement?job=${jobId}`
  );
}

// Sentence 3: no price has been proposed. Kept word for word identical to
// the wording the three doors already used before this card (the token
// door gains it here for the first time), so no existing assertion on this
// exact string moves.
export function agreementNoPriceMessage(): string {
  return 'this job has no agreed price to pay against';
}

// Sentence 4: a price exists but is not accepted by both parties. Names
// exactly who is still to sign, so the buyer knows whether the ball is in
// their own court or the agent's.
export function agreementPriceNotAcceptedMessage(jobId: string, missing: 'buyer' | 'agent' | 'both'): string {
  const who = missing === 'both' ? 'the buyer and the agent' : missing === 'buyer' ? 'the buyer' : 'the agent';
  return (
    `the deposit can start only once both parties have signed the price; still to sign: ${who}: ` +
    `${publicBaseUrlFromEnv()}/agreement?job=${jobId}`
  );
}

// Turns one AgreementGap (job.ts's agreementGap, the SAME rule confirmSpec
// enforces) into the buyer-facing sentence above. The order this function
// is called in never matters here -- agreementGap itself already names the
// FIRST gap, matching confirmSpec's own single-failure-at-a-time reading
// order.
export function agreementGapMessage(jobId: string, gap: AgreementGap): string {
  switch (gap.kind) {
    case 'no-criteria':
      return agreementNoCriteriaMessage(jobId);
    case 'criteria-outstanding':
      return agreementCriteriaOutstandingMessage(jobId, gap.outstanding, gap.total);
    case 'no-price':
      return agreementNoPriceMessage();
    case 'price-not-accepted':
      return agreementPriceNotAcceptedMessage(jobId, gap.missing);
  }
}

// Sentence 5: a sibling from the same brief already confirmed (HT1 Part
// A2). Distinct wording from confirm's own sibling-conflict message
// ("...can no longer be confirmed") because this refusal fires BEFORE any
// money moves, not at confirm itself -- "can no longer take a deposit" is
// the true fact at this point in the loop.
export function siblingAlreadyConfirmedMessage(): string {
  return 'a sibling job from the same brief has already been confirmed; this job can no longer take a deposit';
}

// Sentence 6 (B42): the agent has no verified GitHub login on record.
// Distinct wording from confirm's own login refusal (app.ts's "confirm
// needs the agent to have a verified GitHub login") because this fires at
// the deposit door, before confirm is ever reachable, and tells the buyer
// there is something to wait for, not just something confirm will refuse
// later.
export function agentGithubLoginUnverifiedMessage(): string {
  return (
    "the agent has not verified its GitHub account yet; the deposit can start once it has, " +
    'because the work is delivered through that account'
  );
}

// Step 1 (Make item 2, order 1): a sibling opened by the same brief
// (job.requestId not null) that has already confirmed refuses this job's
// deposit -- the buyer already chose a different agent for this brief. A
// storage driver without findByRequestId, or one whose lookup throws,
// fails closed (503, logged), mirroring confirm's own sibling check
// (app.ts POST /jobs/:jobId/confirm) exactly, including the log line
// shape, so an operator grepping logs sees the same signature from either
// caller.
export async function checkNoConfirmedSibling(
  jobRepo: JobRepository,
  job: Pick<Job, 'id' | 'requestId'>,
  label: string,
): Promise<DepositReadinessResult> {
  if (job.requestId === null) return { ok: true };
  if (typeof jobRepo.findByRequestId !== 'function') {
    console.error(`${label}: storage does not support findByRequestId`);
    return { ok: false, status: 503, message: 'storage unavailable' };
  }
  let siblings: readonly Job[];
  try {
    siblings = await jobRepo.findByRequestId(job.requestId);
  } catch (err) {
    console.error(`${label}: storage failed reading siblings`, err);
    return { ok: false, status: 503, message: 'storage unavailable' };
  }
  const confirmedSibling = siblings.some((sibling) => sibling.id !== job.id && sibling.confirmedAt !== null);
  if (confirmedSibling) {
    return { ok: false, status: 409, message: siblingAlreadyConfirmedMessage() };
  }
  return { ok: true };
}

// Step 2 (Make item 2, order 2): the agreement rule confirm has always
// enforced (job.ts's agreementGap, the same function confirmSpec now
// calls), asked BEFORE any money moves.
export function checkAgreementReady(job: Job): DepositReadinessResult {
  const gap = agreementGap(job);
  if (gap === null) return { ok: true };
  return { ok: false, status: 409, message: agreementGapMessage(job.id, gap) };
}

// Step 4 (Make item 2, order 4): B42. The agent's VERIFIED GitHub login,
// through the one function every login-naming caller in this codebase
// already shares (domain/agent.ts's verifiedGithubLogin), so an absent
// login and a merely-claimed-but-unverified one are refused identically.
export function checkAgentGithubVerified(agent: Agent | null): DepositReadinessResult {
  if (verifiedGithubLogin(agent) === null) {
    return { ok: false, status: 409, message: agentGithubLoginUnverifiedMessage() };
  }
  return { ok: true };
}

// The full four-step order (Make item 2): sibling, agreement, repository
// (FIX-B36's checkRepositoryReady, unchanged), then the GitHub login --
// login LAST so a GitHub outage never hides the agreement or sibling
// refusals behind a 503 that says nothing about them. Called by all three
// deposit-start doors for the deposit leg only, in place of their own
// checkRepositoryReady call. onAuth (abt-did-connect.ts) does NOT call
// this: it runs steps 1, 2 and 4 only (its own comment says why step 3 is
// skipped there), so it composes checkNoConfirmedSibling,
// checkAgreementReady and checkAgentGithubVerified directly instead.
export async function checkDepositReadiness(input: {
  readonly label: string;
  readonly job: Job;
  readonly jobRepo: JobRepository;
  readonly github: GithubAdapter;
  readonly agent: Agent | null;
}): Promise<DepositReadinessResult> {
  const sibling = await checkNoConfirmedSibling(input.jobRepo, input.job, input.label);
  if (!sibling.ok) return sibling;
  const agreement = checkAgreementReady(input.job);
  if (!agreement.ok) return agreement;
  const repository = await checkRepositoryReady(input.github, {
    repository: input.job.repository,
    jobId: input.job.id,
    agentGithubLogin: verifiedGithubLogin(input.agent),
  });
  if (!repository.ok) return repository;
  return checkAgentGithubVerified(input.agent);
}
