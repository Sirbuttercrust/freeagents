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
//   - amounts come from the job (depositUsd/remainderUsd against the
//     job's own priceUsd), never from extraParams;
//   - the paying party must be the buyer on the job the session was
//     bound to at /start time (a session created for one job can never
//     confirm a payment for another);
//   - the settlement row is written ONLY from onAuth, once confirm()
//     answered confirmed: true; the /start route never writes one.
import { WalletAuthenticator, WalletHandlers } from '@arcblock/did-connect-js';
import { fromSecretKey } from '@ocap/wallet';
import type { Express, Request, Response } from 'express';
import { didSuffix } from '../../domain/agent.js';
import { depositUsd, remainderUsd } from '../../domain/payment.js';
import type { JobRepository } from '../storage/types.js';
import type { SettlementRepository } from '../storage/types.js';
import type { AbtPaymentRail } from './abt.js';
import { confirmPayment, processWalletResponse, requestPayment, type RouteLeg } from './route-support.js';
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
  readonly settlementRepo: SettlementRepository;
  readonly platformSk: string;
  readonly chainHost: string;
  readonly baseUrl: string;
  readonly txEncoder: AbtTxEncoder;
  readonly sessionStorage?: DidConnectSessionStorage;
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

// Attaches the DID Connect handlers ONCE at app construction (brief scope
// item 3: "attached once at app construction"), and returns the
// generateSession function the /start route calls after its own buyer
// gate has already passed.
export function attachAbtPaymentHandlers(options: AttachAbtPaymentHandlersOptions): AbtPaymentHandlers {
  const platformWallet = fromSecretKey(options.platformSk);
  const sessionStorage = options.sessionStorage ?? createDidConnectSessionStorage();

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
    claims: {
      // The rail's business, returned VERBATIM (brief scope item 3): this
      // file never builds a second claim shape. The built-in
      // WalletAuthenticator.prepareTx() (a different function, on the
      // library's own authenticator) encodes what this returns via
      // txEncoder; nothing here touches encoding.
      prepareTx: async ({
        extraParams,
      }: {
        readonly extraParams: Record<string, unknown>;
      }): Promise<unknown> => {
        const jobId = String(extraParams.jobId ?? '');
        const leg = legFromExtraParams(extraParams);
        const operatorAddress = String(extraParams.operatorAddress ?? '');
        if (jobId === '' || leg === null || operatorAddress === '') {
          throw new Error('payment session is missing jobId, leg or operatorAddress');
        }
        // RULE: the amount comes from the JOB, never from the request
        // (brief, "the whole security of this section"). extraParams
        // never carries an amount at all; there is nothing here for a
        // caller-supplied figure to override.
        const amountUsd = await legAmountUsd(options.jobRepo, jobId, leg);
        if (amountUsd === null) {
          throw new Error('this job has no agreed price to pay against');
        }
        const quote = await options.rail.quote({ priceUsd: amountUsd });
        const request = await requestPayment(options.rail, {
          jobId,
          leg,
          operatorAddress,
          amountToken: quote.amountToken,
          feeToken: quote.feeToken,
        });
        if (request.rail !== 'abt') {
          throw new Error('expected the abt payment request shape');
        }
        return request.claim;
      },
    },
    onAuth: async ({
      userDid,
      extraParams,
      claims,
    }: {
      readonly userDid: string;
      readonly extraParams: Record<string, unknown>;
      readonly claims: ReadonlyArray<{ readonly type: string; readonly finalTx?: string }>;
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
      // RULE: the paying party must be the buyer on that job. userDid is
      // the bare address form WalletAuthenticator.verify() derives
      // (toAddress(iss)); job.buyerDid may carry the did:abt: prefix, so
      // the comparison goes through the same didSuffix reconciliation
      // every other DID comparison in this codebase already uses.
      if (didSuffix(userDid) !== didSuffix(job.buyerDid)) {
        return { confirmed: false, error: "this payment session is bound to a different buyer's job" };
      }
      const prepareTxClaim = claims.find((claim) => claim.type === 'prepareTx');
      const finalTx = prepareTxClaim?.finalTx;
      if (typeof finalTx !== 'string' || finalTx.length === 0) {
        return { confirmed: false, error: 'the wallet did not return a signed transaction' };
      }
      // S2: the amount comes from the job's agreed price, never from
      // extraParams or the claim (same rule prepareTx above already
      // enforces): onWalletResponse needs it to compute the expected
      // operator/fee amounts confirm() binds the chain's own outputs
      // against.
      const amountUsd = await legAmountUsd(options.jobRepo, jobId, leg);
      if (amountUsd === null) {
        return { confirmed: false, error: 'this job has no agreed price to pay against' };
      }
      const ref = await processWalletResponse(options.rail, leg, { rail: 'abt', jobId, finalTx, amountUsd });
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
      }
      return { confirmed: confirmation.confirmed };
    },
    onDecline: () => ({ confirmed: false, declined: true }),
    onComplete: () => {},
  });

  return { generateSession: attached.generateSession };
}
