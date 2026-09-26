// FIX-B39 (bugs.md B39), rule 5: ONE shared function every payment door
// calls in place of B25's job-rail-only check. This file drives the real
// HTTP routes (both /start doors, the token door, the USDC
// wallet-response route, and the ABT wallet callback) to prove each door
// actually calls the shared check for the two NEW causes it adds: the
// deposit already settled in the other currency, and the owner has no
// payout address for this currency (on an OPEN quote, checked before any
// rail is pinned). Uses the shared open-rail harness
// (tests/helpers/open-rail-fixtures.ts) and driveAbtPayment
// (tests/helpers/abt-fixtures.ts) rather than repeating either the app
// wiring or the DID Connect wallet protocol steps here. Both rails must
// be wired for every case in this file: the token door and the ABT
// wallet callback only mount at all when abtPaymentRail is configured,
// and a real /start must reach checkRailDoorEligible rather than an
// earlier "rail not configured" 503.
import { afterEach, describe, expect, it } from 'vitest';
import { fromRandom } from '@ocap/wallet';
import { getSigned, postSigned, driveAbtPayment, continueAbtWalletProtocol } from '../helpers/abt-fixtures.js';
import { signingIdentityFromWallet } from '../helpers/sign-request.js';
import {
  recordDeposit,
  startOpenRailAppWithRails,
  walkToOpenQuoteAccepted,
  type OpenRailApp,
} from '../helpers/open-rail-fixtures.js';

const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';

let active: OpenRailApp | null = null;
afterEach(() => {
  active?.server.close();
  active = null;
});

describe('rule 5: the deposit that settled in the other currency refuses every door, before confirm', () => {
  it('usdc deposit/start refuses naming the deposit currency, once an abt deposit has settled', async () => {
    active = await startOpenRailAppWithRails({ abt: 'z1Operator', evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    await recordDeposit(active, jobId, 'abt');
    const res = await postSigned(active.baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, active.buyer);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('abt');
  });

  it('abt deposit/start refuses naming the deposit currency, once a usdc deposit has settled', async () => {
    active = await startOpenRailAppWithRails({ abt: 'z1Operator', evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    await recordDeposit(active, jobId, 'usdc');
    const res = await postSigned(active.baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, active.buyer);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('usdc');
  });

  it('the token-mint door refuses naming the deposit currency, once a usdc deposit has settled', async () => {
    active = await startOpenRailAppWithRails({ abt: 'z1Operator', evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    await recordDeposit(active, jobId, 'usdc');
    const res = await getSigned(active.baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, active.buyer);
    expect(res.status).toBe(409);
  });

  it('usdc wallet-response refuses and records no settlement, once an abt deposit has settled', async () => {
    active = await startOpenRailAppWithRails({ abt: 'z1Operator', evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    await recordDeposit(active, jobId, 'abt');
    const res = await postSigned(
      active.baseUrl,
      `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
      { priceTxHash: '0xafter-abt-price', feeTx: { signed: true, hash: '0xafter-abt-fee' } },
      active.buyer,
    );
    expect(res.status).toBe(409);
    // Only the earlier abt settlement is on record; this call recorded
    // nothing new for the usdc rail check to have overwritten.
    expect((await active.settlementRepo.findByJobAndLeg(jobId, 'deposit'))?.rail).toBe('abt');
  });

  it('the ABT wallet callback refuses and records no settlement, once a usdc deposit has settled', async () => {
    // onAuth's own buyer check compares the wallet that completes the DID
    // Connect steps against job.buyerDid, so this job's buyer must be
    // backed by a real wallet identity, matching every other
    // wallet-driven test in tests/api/job-payment-abt.test.ts. The
    // session mints while the deposit is still open (rail null), then
    // the fact changes mid-session, so onAuth's OWN check is what
    // refuses, not /start.
    const buyerWallet = fromRandom();
    const walletBuyer = await signingIdentityFromWallet(buyerWallet);
    active = await startOpenRailAppWithRails({ abt: 'z1Operator', evm: USDC_OPERATOR_ADDRESS });
    await active.operatorRepo.register({ did: walletBuyer.did, githubLogin: `wallet-buyer-rail-door-${Math.random()}` });
    const jobId = await walkToOpenQuoteAccepted({ ...active, buyer: walletBuyer });
    const startRes = await postSigned(active.baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, walletBuyer);
    expect(startRes.status).toBe(200);
    await recordDeposit(active, jobId, 'usdc');
    // driveAbtPayment cannot be reused for the WHOLE round trip here: the
    // session was already minted above (proving /start itself is not
    // what refuses), so this continues from that already-minted session
    // via continueAbtWalletProtocol rather than driveAbtPayment's own
    // start-plus-continue shape.
    const startBody = (await startRes.json()) as { readonly token: string; readonly url: string };
    const encodedCallbackUrl = new URL(startBody.url).searchParams.get('url');
    if (encodedCallbackUrl === null) throw new Error('expected a wallet callback url');
    const result = await continueAbtWalletProtocol(active.baseUrl, startBody.token, decodeURIComponent(encodedCallbackUrl), buyerWallet);
    expect(result.confirmed).toBe(false);
    expect(result.error).toContain('usdc');
    expect((await active.settlementRepo.findByJobAndLeg(jobId, 'deposit'))?.rail).toBe('usdc');
  });
});

describe('rule 5: no payout address for THIS currency refuses an open quote, before any rail is pinned', () => {
  it('abt deposit/start refuses naming the missing operator address when only the usdc address is set', async () => {
    active = await startOpenRailAppWithRails({ evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    const res = await postSigned(active.baseUrl, `/jobs/${jobId}/payments/deposit/abt/start`, {}, active.buyer);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('operator address');
  });

  it('the token-mint door refuses naming the missing operator address when only the usdc address is set', async () => {
    active = await startOpenRailAppWithRails({ evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    const res = await getSigned(active.baseUrl, `/api/did/pay/token?jobId=${jobId}&leg=deposit`, active.buyer);
    expect(res.status).toBe(409);
  });

  it('usdc deposit/start refuses naming the missing operator address when only the abt address is set (the mirror)', async () => {
    active = await startOpenRailAppWithRails({ abt: 'z1Operator' });
    const jobId = await walkToOpenQuoteAccepted(active);
    const res = await postSigned(active.baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, active.buyer);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('operator address');
  });
});

describe('rule 5: an open quote starts on EITHER door when an address is on record', () => {
  it('usdc deposit/start answers 200 on an open (no-rail) quote', async () => {
    active = await startOpenRailAppWithRails({ evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    const res = await postSigned(active.baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, active.buyer);
    expect(res.status).toBe(200);
  });

  it('abt deposit/start answers 200 on an open (no-rail) quote, and a full wallet round trip through it settles the deposit', async () => {
    const buyerWallet = fromRandom();
    const walletBuyer = await signingIdentityFromWallet(buyerWallet);
    active = await startOpenRailAppWithRails({ abt: 'z1Operator' });
    await active.operatorRepo.register({ did: walletBuyer.did, githubLogin: `wallet-buyer-either-door-${Math.random()}` });
    const jobId = await walkToOpenQuoteAccepted({ ...active, buyer: walletBuyer });
    const result = await driveAbtPayment(active.baseUrl, walletBuyer, buyerWallet, { jobId, leg: 'deposit' });
    expect(result.confirmed).toBe(true);
    expect((await active.settlementRepo.findByJobAndLeg(jobId, 'deposit'))?.rail).toBe('abt');
  });
});

describe('rule 5: after confirm, the ABT remainder start refuses once the deposit settled the OTHER currency', () => {
  it('a usdc deposit settled on an open quote refuses the abt remainder start after confirm', async () => {
    active = await startOpenRailAppWithRails({ abt: 'z1Operator', evm: USDC_OPERATOR_ADDRESS });
    const jobId = await walkToOpenQuoteAccepted(active);
    await recordDeposit(active, jobId, 'usdc');
    const confirmed = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirmed.status).toBe(200);
    const remainderStart = await postSigned(active.baseUrl, `/jobs/${jobId}/payments/remainder/abt/start`, {}, active.buyer);
    expect(remainderStart.status).toBe(409);
    expect((await remainderStart.json() as { error: string }).error).toContain('usdc');
  });
});
