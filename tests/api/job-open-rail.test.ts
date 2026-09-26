// FIX-B39 (bugs.md B39): rules 2, 3 and 6 together, on the lightweight
// open-rail harness (no real payment rails needed: this file settles a
// deposit by writing straight to settlementRepo, the same shortcut
// tests/api/job-confirm-staging.test.ts and others already take).
//
// Rule 6 (payableRails): GET /jobs/:jobId carries payableRails while the
// job is 'proposed' and priced. Rule 2: the pinned currency if a quote
// pinned it, otherwise every currency the hired agent's owner has a
// payout address for. Rule 3 (the settled deposit fixes the currency):
// once a deposit settles, only that currency, both in payableRails and
// at confirm, which backfills job.rail from it BEFORE confirmSpec runs
// so specHash still recomputes off node:crypto alone, and never clears
// either party's price acceptance.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { postSigned } from '../helpers/abt-fixtures.js';
import {
  openDraft,
  proposeOneCriterionPrice,
  recordDeposit,
  startOpenRailApp,
  walkToOpenQuoteAccepted,
  type OpenRailApp,
} from '../helpers/open-rail-fixtures.js';

let active: OpenRailApp | null = null;
afterEach(() => {
  active?.server.close();
  active = null;
});

async function payableRailsOf(baseUrl: string, jobId: string): Promise<Record<string, unknown>> {
  const read = await fetch(`${baseUrl}/jobs/${jobId}`);
  return (await read.json()) as Record<string, unknown>;
}

describe('payableRails: both addresses on record, open quote', () => {
  it('answers ["abt","usdc"] for an open (no-rail) quote, on GET /jobs/:jobId only', async () => {
    active = await startOpenRailApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    const jobId = await openDraft(active);
    const proposed = await proposeOneCriterionPrice(active, jobId);
    expect(proposed.status).toBe(200);
    // Rule 6: payableRails rides ONLY GET /jobs/:jobId, the same
    // conditional stance githubAccessNeeded already takes on that one
    // route, never the criteria route's own mutation response.
    expect((await proposed.json() as Record<string, unknown>).payableRails).toBeUndefined();
    expect((await payableRailsOf(active.baseUrl, jobId)).payableRails).toEqual(['abt', 'usdc']);
  });
});

describe('payableRails: a pinned quote reports only the pinned currency, even with both addresses set', () => {
  it('answers ["usdc"] for a quote naming usdc', async () => {
    active = await startOpenRailApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    const jobId = await openDraft(active);
    await proposeOneCriterionPrice(active, jobId, { rail: 'usdc' });
    expect((await payableRailsOf(active.baseUrl, jobId)).payableRails).toEqual(['usdc']);
  });
});

describe('payableRails: filtered by which payout address the owner actually has', () => {
  it('answers ["abt"] when only operatorAddressAbt is set', async () => {
    active = await startOpenRailApp({ abt: 'z1OperatorAbt' });
    const jobId = await openDraft(active);
    await proposeOneCriterionPrice(active, jobId);
    expect((await payableRailsOf(active.baseUrl, jobId)).payableRails).toEqual(['abt']);
  });

  it('answers ["usdc"] when only operatorAddressEvm is set', async () => {
    active = await startOpenRailApp({ evm: '0xOperatorEvm00000000000000000000000000' });
    const jobId = await openDraft(active);
    await proposeOneCriterionPrice(active, jobId);
    expect((await payableRailsOf(active.baseUrl, jobId)).payableRails).toEqual(['usdc']);
  });

  it('answers [] when neither address is set', async () => {
    active = await startOpenRailApp({});
    const jobId = await openDraft(active);
    await proposeOneCriterionPrice(active, jobId);
    expect((await payableRailsOf(active.baseUrl, jobId)).payableRails).toEqual([]);
  });
});

describe('payableRails: once a deposit has settled, only that deposit\'s currency, even before confirm runs', () => {
  it('an open quote reports only the settled deposit\'s rail while still proposed', async () => {
    active = await startOpenRailApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    const jobId = await openDraft(active);
    await proposeOneCriterionPrice(active, jobId);
    // Settle the deposit directly on the repo: this test is about the
    // projection, not the settlement mechanics.
    await recordDeposit(active, jobId, 'usdc', { operatorAddress: '0xOperatorEvm00000000000000000000000000' });
    const body = await payableRailsOf(active.baseUrl, jobId);
    expect(body.status).toBe('proposed');
    expect(body.payableRails).toEqual(['usdc']);
  });
});

describe('payableRails: omitted before a price exists, per the same conditional stance githubAccessNeeded takes', () => {
  it('a draft with no price carries no payableRails key', async () => {
    active = await startOpenRailApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    const jobId = await openDraft(active);
    expect((await payableRailsOf(active.baseUrl, jobId)).payableRails).toBeUndefined();
  });
});

describe('confirm on an open quote: no deposit settled answers 402, never confirmSpec\'s false 409', () => {
  it('answers 402 naming depositUsd, not 409 "no price has been proposed"', async () => {
    active = await startOpenRailApp();
    const jobId = await walkToOpenQuoteAccepted(active);
    const confirmed = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirmed.status).toBe(402);
    const body = (await confirmed.json()) as { error: string; depositUsd: string };
    expect(body.error).toContain('deposit has not settled');
    expect(body.depositUsd).toBe('125.00');
  });
});

describe('confirm on an open quote: the settled deposit backfills job.rail before confirmSpec runs', () => {
  it('confirms with the confirmed job\'s rail equal to the settled deposit\'s rail, and specHash recomputes off node:crypto alone', async () => {
    active = await startOpenRailApp();
    const jobId = await walkToOpenQuoteAccepted(active);
    await recordDeposit(active, jobId, 'abt');
    const confirmed = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirmed.status).toBe(200);
    const body = (await confirmed.json()) as Record<string, unknown>;
    expect(body.status).toBe('confirmed');
    const price = body.price as { priceUsd: string; rail: string; depositPercent: number; redoAllowance: number; deliveryWindowDays: number | null };
    expect(price.rail).toBe('abt');

    // Invariant 2: recomputable from the confirmed response alone.
    const criteria = body.criteria as Array<{ text: string }>;
    const joined = [
      ...criteria.map((c) => c.text),
      `price:${price.priceUsd}`,
      `rail:${price.rail}`,
      `deposit:${price.depositPercent}`,
      `redo:${price.redoAllowance}`,
      `window:${price.deliveryWindowDays}`,
    ].join('\n');
    const recomputed = 'sha256:' + createHash('sha256').update(joined).digest('hex');
    expect(recomputed).toBe(body.specHash);
  });

  it('never clears either party\'s price acceptance: confirm succeeds straight through (both acceptances were already true)', async () => {
    // If backfilling job.rail cleared acceptance, confirmSpec's own
    // criteria-acceptance-independent price gate would still pass (price
    // acceptance is checked separately), but confirm would then fail on
    // priceAcceptedByBuyer/Agent being false. Confirm succeeding at all
    // here is the proof.
    active = await startOpenRailApp();
    const jobId = await walkToOpenQuoteAccepted(active);
    await recordDeposit(active, jobId, 'usdc');
    const confirmed = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirmed.status).toBe(200);
  });
});

describe('confirm on an open quote: the settlement gate says settled but no record exists', () => {
  it('answers 409 naming the missing settlement record, never guesses a currency', async () => {
    // The gate and the repository are the SAME MemorySettlementGate here
    // (imported directly, never PrismaSettlementGate), so it can be
    // marked settled with settlementRepo left deliberately empty -- the
    // exact split the real Prisma-backed pairing (gate reading the
    // repository) could never produce on its own, but which the brief's
    // own rule 3 requires confirm to refuse rather than guess through.
    const { MemorySettlementGate } = await import('../../src/adapters/payment/gate.js');
    const gate = new MemorySettlementGate();
    active = await startOpenRailApp({}, gate);
    const jobId = await walkToOpenQuoteAccepted(active);
    gate.markDepositSettled(jobId);
    const confirmed = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirmed.status).toBe(409);
    const body = (await confirmed.json()) as { error: string };
    expect(body.error).toContain('settlement record');
  });
});

describe('confirm on a PINNED quote keeps its existing order and answers exactly (untouched)', () => {
  it('a job pinned to usdc with an abt deposit settled by mistake still confirms with rail usdc (the pin wins; a settlement gate is a separate concern)', async () => {
    // This test documents the pinned-quote path is UNCHANGED by this
    // card: confirm never overwrites an already-pinned rail from a
    // settlement row. The scenario itself (deposit settled on the wrong
    // rail for a pinned job) is exactly what the payment doors refuse
    // before it can happen; this only proves confirm's own backfill is
    // conditional on job.rail being null.
    active = await startOpenRailApp();
    const jobId = await openDraft(active);
    await postSigned(active.baseUrl, `/jobs/${jobId}/criteria`, {
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent' },
        { text: 'Checkout e2e test passes', proposedBy: 'agent' },
      ],
      priceUsd: '500.00',
      rail: 'usdc',
    }, active.agent);
    await postSigned(active.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, active.buyer);
    await postSigned(active.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, active.agent);
    await postSigned(active.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, active.buyer);
    await postSigned(active.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, active.agent);
    await postSigned(active.baseUrl, `/jobs/${jobId}/price/accept`, {}, active.buyer);
    await postSigned(active.baseUrl, `/jobs/${jobId}/price/accept`, {}, active.agent);
    await recordDeposit(active, jobId, 'abt');
    const confirmed = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirmed.status).toBe(200);
    const body = (await confirmed.json()) as Record<string, unknown>;
    const price = body.price as { rail: string };
    expect(price.rail).toBe('usdc');
  });
});
