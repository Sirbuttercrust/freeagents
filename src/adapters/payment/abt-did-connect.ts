// P10: the ABT payment surface's DID Connect wiring (brief scope item 3).
// This file owns the seam P2/P4's own header comments named as
// "explicitly out of scope" for those cards and "the NEXT card's job":
// WalletAuthenticator + WalletHandlers.attach(), the txEncoder, and the
// route that calls onWalletResponse with what the wallet posted back.
//
// The working reference (qr-server.mjs, in the operator's payment
// wallet-test rig) is the only place this protocol sequence has been
// proved against a real mobile wallet; this file follows it exactly:
//   1. claims.prepareTx returns the rail's PrepareTxClaim VERBATIM. The
//      built-in WalletAuthenticator.prepareTx() (not this file's own
//      function of the same name) then base58/CBOR-encodes it via
//      txEncoder before it ever reaches the wallet -- this file never
//      re-encodes anything itself.
//   2. onAuth reads the echoed-back claim's `finalTx` (base58, exactly
//      what the wallet returns) and calls the rail's onWalletResponse,
//      then confirm, writing the settlement row only on confirmed: true.
//
// Three rules enforced here (brief, "the whole security of this
// section"):
//   - amounts come from the lock the platform computed from the job
//     (depositUsd/remainderUsd against the job's own priceUsd, converted
//     once at the ABT/USD rate when the session started and written on
//     the session row), never from extraParams;
//   - the payment must have been started by the buyer on the job the
//     session was bound to at /start time: each door proves its caller
//     is that job's buyer and hands the proven DID to onStart, which
//     writes it on the session row, and onAuth checks that row, not the
//     wallet's DID (whatever wallet the buyer pays from signs the buyer's
//     own transaction; a session created for one job can never confirm a
//     payment for another);
//   - the settlement row is written ONLY from onAuth, once confirm()
//     answered confirmed: true; the /start route never writes one.
//
// The rate is read once per payment, in onStart below, and locked on the
// session row (FIX-B70a). The claim is built from the lock, and the
// wallet's answer is checked against the same amounts, so a price that
// moves, or a feed that goes down, after the buyer opens the payment
// cannot change what the buyer approved.
import { WalletAuthenticator, WalletHandlers } from '@arcblock/did-connect-js';
import { fromSecretKey } from '@ocap/wallet';
import type { Express, Request, Response } from 'express';
import { didSuffix } from '../../domain/agent.js';
import { depositUsd, remainderUsd } from '../../domain/payment.js';
import type { AccountRepository, AgentRepository, JobRepository } from '../storage/types.js';
import type { SettlementRepository } from '../storage/types.js';
import type { AbtPaymentRail } from './abt.js';
import {
  checkAgentGithubVerified,
  checkAgreementReady,
  checkLegNotAlreadySettled,
  checkNoConfirmedSibling,
  confirmPayment,
  legStatusConflictMessage,
  legStatusEligible,
  processWalletResponse,
  requestPayment,
  type RouteLeg,
  checkRailDoorEligible,
} from './route-support.js';
import {
  ABT_QUOTE_LOCK_LIFETIME_MS,
  LOCK_EXPIRED_MESSAGE,
  NO_LOCK_MESSAGE,
  PRICE_CHANGED_MESSAGE,
} from './quote-lock.js';
import { createDidConnectSessionStorage } from './session-storage.js';
import type { DidConnectSessionStorage } from './session-storage-types.js';

// Matches @arcblock/did-connect-js's own TxEncoder shape (wallet.d.ts):
// encodes a partial or final transaction to the bytes the wire carries.
// The production default wraps @ocap/client/encode's real network-backed
// encoder; tests inject a pure local one (no network in the test suite,
// FACTORY_RULES.md).
export type AbtTxEncoder = (params: {
  readonly type: string;
  readonly data: unknown;
  readonly wallet: unknown;
  readonly chainHost: string;
}) => Promise<Buffer>;

export interface AttachAbtPaymentHandlersOptions {
  readonly app: Express;
  readonly rail: AbtPaymentRail;
  readonly jobRepo: JobRepository;
  // S3, Ruling 2: the fix goes in this adapter, not the /start route,
  // because /start is not the only door -- did-connect-js's own
  // /api/did/pay/token mount reaches prepareTx and onAuth directly. Both
  // resolve the recipient from the hired agent's operator, never from
  // extraParams.operatorAddress, which no longer exists as an input at
  // all (Ruling 6).
  readonly agentRepo: AgentRepository;
  // P8c: the account repository, so operatorAddressForJob can resolve the
  // hired agent's operator's STORED ABT address instead of deriving one
  // from the operator's own DID suffix (Anchor: that derivation is the
  // exact silent binding this card exists to stop).
  readonly accountRepo: AccountRepository;
  readonly settlementRepo: SettlementRepository;
  readonly platformSk: string;
  readonly chainHost: string;
  readonly baseUrl: string;
  readonly txEncoder: AbtTxEncoder;
  readonly sessionStorage?: DidConnectSessionStorage;
  // STEER (B19, 2026-09-25): "when the platform observes
  // a deposit or a balance leg settle... it writes a `deposit paid` or
  // `balance paid` system row into the hire thread." Called AFTER the
  // settlement row above is written, with the identical facts (never a
  // wallet address or a transaction hash -- the callback receives only
  // jobId, leg, rail and amountUsd, on purpose: it cannot leak what it is
  // never given). Optional so the many existing tests constructing this
  // adapter without message/notification wiring are untouched.
  readonly onSettlementRecorded?: (input: {
    readonly jobId: string;
    readonly leg: 'deposit' | 'remainder';
    readonly rail: 'abt' | 'usdc';
    readonly amountUsd: string;
  }) => void | Promise<void>;
}

export interface AbtPaymentHandlers {
  readonly generateSession: (req: Request, res: Response) => Promise<void>;
}

function legOf(raw: unknown): RouteLeg | null {
  return raw === 'deposit' || raw === 'remainder' ? raw : null;
}

// The route-safe leg name from extraParams. WalletHandlers persists
// whatever generateSession saw in req.params/req.body/req.query into the
// session's extraParams (protocol.js's own mechanism, no code of this
// file's own); the /start route mounts at a path carrying :leg, so this
// is always present by the time prepareTx or onAuth reads it.
function legFromExtraParams(extraParams: Record<string, unknown>): RouteLeg | null {
  return legOf(extraParams.leg);
}

async function legAmountUsd(jobRepo: JobRepository, jobId: string, leg: RouteLeg): Promise<string | null> {
  const job = await jobRepo.findById(jobId);
  if (job === null || job.priceUsd === null) return null;
  return leg === 'deposit' ? depositUsd(job.priceUsd, job.depositPercent) : remainderUsd(job.priceUsd, job.depositPercent);
}

// P8c, Ruling 1 (this card): the ABT recipient is the address on record
// for the hired agent's operator Account (operatorAddressAbt), the same
// stored-column treatment S3 already gave the USDC rail. Before this
// card, the ABT address was DERIVED from the operator's own DID suffix
// (an ArcBlock DID address IS a chain account address, verified by
// execution against @arcblock/did: toAddress('did:abt:...') equals the
// suffix); that derivation silently paid whoever held the key behind the
// Account's own DID, which is exactly the binding this card breaks so an
// account the platform provisions rather than a wallet proving
// possession can never be handed money nobody controls. 'no-job',
// 'no-agent' and 'no-account' name the job/agent-not-found cases prepareTx
// and onAuth already answered with their own generic error before this
// card; 'not-set' is P8c's own new failure, a real registered operator
// who has never set an ABT payout address, and gets the fail-closed
// message naming the PATCH route (Ruling 5's own USDC stance, mirrored
// here rather than special-cased).
type AbtOperatorAddressResult =
  | { readonly ok: true; readonly operatorAddress: string }
  | { readonly ok: false; readonly reason: 'no-job' | 'no-agent' | 'no-account' | 'not-set' };

async function operatorAddressForJob(
  jobRepo: JobRepository,
  agentRepo: AgentRepository,
  accountRepo: AccountRepository,
  jobId: string,
): Promise<AbtOperatorAddressResult> {
  const job = await jobRepo.findById(jobId);
  if (job === null) return { ok: false, reason: 'no-job' };
  const agent = await agentRepo.findByDid(job.agentDid);
  if (agent === null) return { ok: false, reason: 'no-agent' };
  const account = await accountRepo.findByDid(agent.operatorDid);
  if (account === null) return { ok: false, reason: 'no-account' };
  if (account.operatorAddressAbt === null) return { ok: false, reason: 'not-set' };
  return { ok: true, operatorAddress: account.operatorAddressAbt };
}

// The message a caller sees when operatorAddressForJob answers not ok.
// 'not-set' names the rail and the PATCH route (P8c's own new refusal,
// mirroring the USDC rail's identical "PATCH /accounts/:did/operator-
// address first" wording); the other three reasons keep the pre-P8c
// generic message, since they are the same "job or hired agent could not
// be found" case prepareTx and onAuth always answered.
function operatorAddressErrorMessage(reason: 'no-job' | 'no-agent' | 'no-account' | 'not-set'): string {
  return reason === 'not-set'
    ? "the hired agent's operator has not set an ABT operator address; PATCH /accounts/:did/operator-address first"
    : 'this job or its hired agent could not be found';
}

// The lock's lifetime and its three refusal sentences are shared with the
// ABT-on-Ethereum rail and live in quote-lock.ts.
const NO_STARTER_MESSAGE =
  'This payment session has no signed-in or signed buyer on record. Start the payment again from the job page while signed in as the buyer.';
const NOT_THE_BUYER_MESSAGE = "this payment session is bound to a different buyer's job";

// The key on the session row that records who started the session: the
// party a door proved (a live sign-in or a verified signature) before it
// minted the session. Only onStart writes it, from provenStarters below;
// a wallet never writes the row, and extraParams (built from the request's
// body, query and params) never carries it.
const SESSION_STARTER_KEY = 'startedBy';

// The proven starter of one request, held for that request only. A door
// calls setProvenStarter after its buyer gate answered, and onStart (which
// did-connect-js runs inside generateSession with the same request object)
// reads it. Keyed by the request object, so it is never a query, body or
// header value and disappears with the request.
const provenStarters = new WeakMap<object, string>();

export function setProvenStarter(req: Request, did: string): void {
  provenStarters.set(req, did);
}

// The ABT price a payment session locked when it started, as written on
// the session row under `abtQuote` (dates are ISO strings: the row is
// JSON). Only the platform writes this key, from onStart below;
// extraParams is caller-controlled and never carries a lock.
interface AbtQuoteLock {
  readonly jobId: string;
  readonly leg: RouteLeg;
  readonly amountUsd: string;
  readonly usdPerAbt: string;
  readonly rateUpdatedAt: string | null;
  readonly amountToken: string;
  readonly feeToken: string;
  readonly lockedAt: string;
  readonly expiresAt: string;
}

function readAbtQuoteLock(value: unknown): AbtQuoteLock | null {
  if (typeof value !== 'object' || value === null) return null;
  const lock = value as Record<string, unknown>;
  const text = (key: string): string | null => (typeof lock[key] === 'string' ? (lock[key] as string) : null);
  const leg = legOf(lock.leg);
  const jobId = text('jobId');
  const amountUsd = text('amountUsd');
  const usdPerAbt = text('usdPerAbt');
  const amountToken = text('amountToken');
  const feeToken = text('feeToken');
  const lockedAt = text('lockedAt');
  const expiresAt = text('expiresAt');
  const rateUpdatedAt = lock.rateUpdatedAt === null ? null : text('rateUpdatedAt');
  if (
    leg === null || jobId === null || amountUsd === null || usdPerAbt === null || amountToken === null ||
    feeToken === null || lockedAt === null || expiresAt === null || (lock.rateUpdatedAt !== null && rateUpdatedAt === null)
  ) {
    return null;
  }
  return { jobId, leg, amountUsd, usdPerAbt, rateUpdatedAt, amountToken, feeToken, lockedAt, expiresAt };
}

type AbtQuoteLockCheck =
  | { readonly ok: true; readonly lock: AbtQuoteLock }
  | { readonly ok: false; readonly message: string };

interface LockedQuoteForCheckout {
  readonly amountToken: string;
  readonly feeToken: string;
  readonly usdPerAbt: string;
  readonly rateUpdatedAt: string | null;
  readonly expiresAt: string;
}

// Attaches the DID Connect handlers ONCE at app construction (brief scope
// item 3: "attached once at app construction"), and returns the
// generateSession function the /start route calls after its own buyer
// gate has already passed.
export function attachAbtPaymentHandlers(options: AttachAbtPaymentHandlersOptions): AbtPaymentHandlers {
  const platformWallet = fromSecretKey(options.platformSk);
  const sessionStorage = options.sessionStorage ?? createDidConnectSessionStorage();

  // The one check both the claim (prepareTx) and the wallet's answer
  // (onAuth) make, so they refuse the same way. It reads the lock from
  // the session row by the session's own token, never from extraParams,
  // and refuses when there is no lock, when it names another job or leg
  // than the session, when it has expired, or when the job's amount for
  // this leg is no longer the amount the lock was computed from.
  async function checkAbtQuoteLock(token: string, jobId: string, leg: RouteLeg): Promise<AbtQuoteLockCheck> {
    const row = await sessionStorage.read(token);
    const lock = readAbtQuoteLock(row?.abtQuote);
    if (lock === null || lock.jobId !== jobId || lock.leg !== leg) {
      return { ok: false, message: NO_LOCK_MESSAGE };
    }
    if (!(Date.now() < Date.parse(lock.expiresAt))) {
      return { ok: false, message: LOCK_EXPIRED_MESSAGE };
    }
    const amountUsd = await legAmountUsd(options.jobRepo, jobId, leg);
    if (amountUsd === null) {
      return { ok: false, message: 'this job has no agreed price to pay against' };
    }
    if (amountUsd !== lock.amountUsd) {
      return { ok: false, message: PRICE_CHANGED_MESSAGE };
    }
    return { ok: true, lock };
  }

  // Who started this session, read from the session row by the session's
  // own token. Null when the row carries no starter (or none that is a
  // non-empty string): a wallet cannot write the row, so a null here means
  // no door proved a party when the session was minted.
  async function readSessionStarter(token: string): Promise<string | null> {
    const row = await sessionStorage.read(token);
    const starter = row?.[SESSION_STARTER_KEY];
    return typeof starter === 'string' && starter !== '' ? starter : null;
  }

  const authenticator = new WalletAuthenticator({
    wallet: platformWallet,
    baseUrl: options.baseUrl,
    txEncoder: options.txEncoder,
    appInfo: {
      name: 'FreeAgents',
      description: 'Pay for a hire on FreeAgents',
      icon: `${options.baseUrl}/icon.png`,
      link: options.baseUrl,
    },
    chainInfo: { host: options.chainHost, id: 'abt', type: 'arcblock' },
  });

  const handlers = new WalletHandlers({ authenticator, tokenStorage: sessionStorage as never });

  const attached = handlers.attach({
    app: options.app,
    action: 'pay',
    // Runs on both doors (the /start route and did-connect-js's own
    // /api/did/pay/token mount). Records who started the session on the
    // session row, then quotes the leg's amount once and writes the lock
    // there through updateSession, the platform's own write; the returned
    // object reaches the start response as `extra`. The quote never
    // throws: a throw here would answer the buyer 200 with an error body.
    // On any failure (no job, no agreed price, no rate) it writes no lock
    // and answers `{ abtQuote: null }`, and the claim then refuses for want
    // of a lock.
    onStart: async ({
      extraParams,
      updateSession,
      req,
    }: {
      readonly extraParams: Record<string, unknown>;
      readonly updateSession: (key: string, value: unknown) => Promise<unknown>;
      readonly req: Request;
    }): Promise<{ readonly abtQuote: LockedQuoteForCheckout | null }> => {
      // Who started this session, as the door proved it for this one
      // request (setProvenStarter). Written before the quote and outside
      // its try, so a quote that fails never drops it. A start that no
      // door proved gets no key, and onAuth then refuses it.
      const starter = provenStarters.get(req);
      if (starter !== undefined) {
        await updateSession(SESSION_STARTER_KEY, starter);
      }
      try {
        const jobId = String(extraParams.jobId ?? '');
        const leg = legFromExtraParams(extraParams);
        if (jobId === '' || leg === null) return { abtQuote: null };
        const amountUsd = await legAmountUsd(options.jobRepo, jobId, leg);
        if (amountUsd === null) return { abtQuote: null };
        const quote = await options.rail.quote({ priceUsd: amountUsd });
        const lockedAt = new Date();
        const expiresAt = new Date(lockedAt.getTime() + ABT_QUOTE_LOCK_LIFETIME_MS);
        const rateUpdatedAt = quote.rateUpdatedAt === null ? null : quote.rateUpdatedAt.toISOString();
        const lock: AbtQuoteLock = {
          jobId,
          leg,
          amountUsd,
          usdPerAbt: quote.usdPerToken,
          rateUpdatedAt,
          amountToken: quote.amountToken,
          feeToken: quote.feeToken,
          lockedAt: lockedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };
        await updateSession('abtQuote', lock);
        return {
          abtQuote: {
            amountToken: lock.amountToken,
            feeToken: lock.feeToken,
            usdPerAbt: lock.usdPerAbt,
            rateUpdatedAt,
            expiresAt: lock.expiresAt,
          },
        };
      } catch {
        return { abtQuote: null };
      }
    },
    claims: {
      // The rail's business, returned VERBATIM (brief scope item 3): this
      // file never builds a second claim shape. The built-in
      // WalletAuthenticator.prepareTx() (a different function, on the
      // library's own authenticator) encodes what this returns via
      // txEncoder; nothing here touches encoding.
      prepareTx: async ({
        extraParams,
        context,
      }: {
        readonly extraParams: Record<string, unknown>;
        readonly context: { readonly token: string };
      }): Promise<unknown> => {
        const jobId = String(extraParams.jobId ?? '');
        const leg = legFromExtraParams(extraParams);
        if (jobId === '' || leg === null) {
          throw new Error('payment session is missing jobId or leg');
        }
        // RULE (S3, P8c): the recipient is resolved from the hired
        // agent's operator, never from the request. extraParams.
        // operatorAddress is no longer read at all: a buyer naming their
        // own address here (either through /start or directly through
        // did-connect-js's own /api/did/pay/token mount) has nothing to
        // name any more.
        const operatorAddressResult = await operatorAddressForJob(options.jobRepo, options.agentRepo, options.accountRepo, jobId);
        if (!operatorAddressResult.ok) {
          throw new Error(operatorAddressErrorMessage(operatorAddressResult.reason));
        }
        // RULE: the amounts come from the lock the platform wrote on this
        // session when it started, computed from the job (brief, "the
        // whole security of this section"). extraParams never carries an
        // amount or a rate; nothing here quotes, so the claim is built
        // from exactly the amounts the checkout showed.
        const locked = await checkAbtQuoteLock(context.token, jobId, leg);
        if (!locked.ok) {
          throw new Error(locked.message);
        }
        const request = await requestPayment(options.rail, {
          jobId,
          leg,
          operatorAddress: operatorAddressResult.operatorAddress,
          amountToken: locked.lock.amountToken,
          feeToken: locked.lock.feeToken,
        });
        if (request.rail !== 'abt') {
          throw new Error('expected the abt payment request shape');
        }
        return request.claim;
      },
    },
    onAuth: async ({
      extraParams,
      claims,
      req,
    }: {
      readonly extraParams: Record<string, unknown>;
      readonly claims: ReadonlyArray<{ readonly type: string; readonly finalTx?: string }>;
      readonly req: { readonly context: { readonly token: string } };
    }): Promise<{ readonly confirmed: boolean; readonly error?: string }> => {
      const jobId = String(extraParams.jobId ?? '');
      const leg = legFromExtraParams(extraParams);
      if (jobId === '' || leg === null) {
        return { confirmed: false, error: 'payment session is missing jobId or leg' };
      }
      const job = await options.jobRepo.findById(jobId);
      if (job === null) {
        return { confirmed: false, error: 'job not found' };
      }
      // B23 (bug ledger, C1 rehearsal s7, Proof round 1 D2): a session can
      // be minted while the job is eligible and completed later, after the
      // buyer has walked away or the job has otherwise moved past the leg
      // it was minted for -- the exact gap /start, the token-mint door and
      // the USDC wallet-response route all already close. This is the ABT
      // rail's own wallet-response leg, so it needs the identical guard:
      // a hash observed after the job left the eligible window is refused
      // the same way a fresh start call would be, never treated as a
      // late-but-honoured payment.
      if (!legStatusEligible(leg, job.status)) {
        return { confirmed: false, error: legStatusConflictMessage(leg, job.status) };
      }
      // FIX-B39 (B39), rule 5: ONE shared check, in place of
      // B25's job-rail-only check, in this order: the job's pinned
      // currency, the settled deposit's currency, then the operator
      // address for this rail. operatorAddressOk here makes its OWN
      // call to operatorAddressForJob (a second, separate call from the
      // one a few lines below that resolves the actual recipient
      // address): the two calls answer different questions (a boolean
      // eligibility check here, the address value itself there), so one
      // result cannot stand in for the other.
      const eligibility = await checkRailDoorEligible({
        jobId,
        routeRail: 'abt',
        jobRail: job.rail,
        settlementRepo: options.settlementRepo,
        operatorAddressOk: (await operatorAddressForJob(options.jobRepo, options.agentRepo, options.accountRepo, jobId)).ok,
      });
      if (!eligibility.ok) {
        return { confirmed: false, error: eligibility.message };
      }
      // B49 (this card): a leg that already settled must never be
      // paid again. Refused before anything is broadcast or recorded.
      const alreadySettled = await checkLegNotAlreadySettled({
        jobId,
        leg,
        settlementRepo: options.settlementRepo,
      });
      if (!alreadySettled.ok) {
        return { confirmed: false, error: alreadySettled.message };
      }
      // FIX-B37 (Make item 3, B37 + B42): re-checks the deposit-readiness
      // surface right before settling, for the deposit leg only -- the
      // whole reason this card exists: a session minted while the job was
      // ready can still be COMPLETED after the agreement changed (the
      // owner re-proposed the price, resetting both acceptances) or after
      // the agent's GitHub verification lapsed, and /start read the
      // agreement moments before this callback runs, not at the instant it
      // runs. Steps 1 (sibling), 2 (agreement) and 4 (GitHub login) only:
      // step 3, the repository, is skipped here on purpose -- /start read
      // it moments earlier, and onAuth holds no GitHub adapter to re-read
      // it with. Runs before processWalletResponse, which broadcasts:
      // nothing is broadcast and no settlement row is written on a
      // refusal here.
      if (leg === 'deposit') {
        const sibling = await checkNoConfirmedSibling(options.jobRepo, job, 'onAuth');
        if (!sibling.ok) {
          return { confirmed: false, error: sibling.message };
        }
        const agreement = checkAgreementReady(job);
        if (!agreement.ok) {
          return { confirmed: false, error: agreement.message };
        }
        const hiredAgent = await options.agentRepo.findByDid(job.agentDid);
        const login = checkAgentGithubVerified(hiredAgent);
        if (!login.ok) {
          return { confirmed: false, error: login.message };
        }
      }
      // RULE (S3, P8c): the expected operator address is resolved from
      // the hired agent's operator, the identical derivation prepareTx
      // above already used to build the claim the wallet was asked to
      // sign, never read from extraParams and never decoded back out of
      // the finalTx being confirmed. A wallet cannot move the address
      // confirm() checks against by redirecting the output it returns,
      // because that address never travels through the request at all.
      const operatorAddressResult = await operatorAddressForJob(options.jobRepo, options.agentRepo, options.accountRepo, jobId);
      if (!operatorAddressResult.ok) {
        return { confirmed: false, error: operatorAddressErrorMessage(operatorAddressResult.reason) };
      }
      // RULE: the payment must have been started by the buyer on that
      // job. The party check reads who STARTED the session (the proven
      // party a door wrote on the session row in onStart), never who the
      // answering wallet is: userDid is whatever wallet the buyer scanned
      // with, and a person signed in to the site has a buyer DID the
      // platform derived, which their own wallet never matches. Refused
      // here, before anything is broadcast or recorded, when the row
      // carries no starter or names someone other than the job's buyer.
      // job.buyerDid may carry the did:abt: prefix, so the comparison goes
      // through the same didSuffix reconciliation every other DID
      // comparison in this codebase already uses.
      const starter = await readSessionStarter(req.context.token);
      if (starter === null) {
        return { confirmed: false, error: NO_STARTER_MESSAGE };
      }
      if (didSuffix(starter) !== didSuffix(job.buyerDid)) {
        return { confirmed: false, error: NOT_THE_BUYER_MESSAGE };
      }
      const prepareTxClaim = claims.find((claim) => claim.type === 'prepareTx');
      const finalTx = prepareTxClaim?.finalTx;
      if (typeof finalTx !== 'string' || finalTx.length === 0) {
        return { confirmed: false, error: 'the wallet did not return a signed transaction' };
      }
      // RULE: the amounts come from the lock on this session, the same
      // lock prepareTx above built the claim from, read by the session's
      // own token (req.context.token) and never from extraParams or the
      // claim. The same check refuses, before anything is broadcast, a
      // missing lock, one that names another job or leg, an expired one,
      // and a job whose agreed amount changed since the session started.
      // onWalletResponse then computes what confirm() checks the chain
      // against from these exact amounts and reads no rate.
      const locked = await checkAbtQuoteLock(req.context.token, jobId, leg);
      if (!locked.ok) {
        return { confirmed: false, error: locked.message };
      }
      const { amountUsd, amountToken, feeToken } = locked.lock;
      const ref = await processWalletResponse(options.rail, leg, {
        rail: 'abt',
        jobId,
        finalTx,
        amountToken,
        feeToken,
        operatorAddress: operatorAddressResult.operatorAddress,
      });
      const confirmation = await confirmPayment(options.rail, ref);
      // RULE: the gate is never written from the start route; only the
      // observation path (here) writes a settlement, and only when
      // confirm() answered confirmed: true.
      if (confirmation.confirmed && ref.rail === 'abt') {
        await options.settlementRepo.record({
          jobId,
          leg,
          rail: 'abt',
          hash: ref.hash,
          secondaryHash: null,
          operatorAddress: ref.operatorAddress,
          feeAddress: ref.feeAddress,
          amountUsd,
          observedAt: new Date(),
        });
        await options.onSettlementRecorded?.({ jobId, leg, rail: 'abt', amountUsd });
      }
      return { confirmed: confirmation.confirmed };
    },
    onDecline: () => ({ confirmed: false, declined: true }),
    onComplete: () => {},
  });

  return { generateSession: attached.generateSession };
}
