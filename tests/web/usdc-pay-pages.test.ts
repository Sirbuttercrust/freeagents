// USDC-WEBb: the deposit and balance pages pay in USDC through the wallet
// engine, driven end to end against the real app (the discipline
// tests/web/deposit.test.ts and tests/web/usdc-wallet.test.ts hold to).
// The pages come from the app's own static mount into jsdom, both rails
// run for real on fake chains, and the fake wallet announces itself
// through EIP-6963 in the page's own window. Its receipts are the
// transfers the page asked it to sign, so a confirmed payment proves the
// page asked for exactly what the server checks. Every sentence asserted
// below is the engine's or the server's, read out of the live region.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { USDC_FEE_RATE_PERCENT, ABT_FEE_RATE_PERCENT, calculateFee, depositUsd, remainderUsd } from '../../src/domain/payment.js';
import {
  UNPAID_AGENT_DID, USDC_FEE_ADDRESS, USDC_OPERATOR_ADDRESS,
  announceWallets, buildPageHarness, buildPageWallet, renderPage, shown, text, waitFor,
  type PageHarness, type RenderedPage,
} from '../helpers/usdc-page-fixtures.js';

const PRICE = '1200.00';
const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const money = (s: string): string => `$${parseFloat(s).toFixed(2)}`;
const usdc = (s: string): string => String(Math.round(parseFloat(s) * 1_000_000));

let h: PageHarness;
let seq = 0;
beforeAll(async () => { h = await buildPageHarness(); });
afterAll(async () => { await h.close(); });

async function depositJob(overrides: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const id = `usdc-pages-deposit-${seq}`;
  await h.addJob({ id, ...overrides });
  return id;
}
async function stagedJob(rail: 'abt' | 'usdc'): Promise<string> {
  seq += 1;
  const id = `usdc-pages-staged-${seq}`;
  await h.addJob({ id, status: 'staged', rail, stagedAt: RECENT, stagedCommit: `commit-${id}`, confirmedAt: RECENT, confirmedSpecHash: `sha256:${id}` });
  return id;
}
const openDeposit = (id: string): Promise<RenderedPage> =>
  renderPage(h, `/deposit?job=${id}`, (d) => !d.getElementById('deposit-body')!.hidden && (d.getElementById('pay-btn')!.textContent ?? '') !== '');
const openStaged = (id: string): Promise<RenderedPage> =>
  renderPage(h, `/staged?job=${id}`, (d) => (d.getElementById('pay-btn')!.textContent ?? '').startsWith('Pay the balance'));

function choose(page: RenderedPage, rail: 'abt' | 'usdc'): void {
  const radio = page.document.getElementById(`rail-${rail}`) as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}
function press(page: RenderedPage, id: string): void {
  (page.document.getElementById(id) as HTMLButtonElement).click();
}
const status = (page: RenderedPage): string => text(page.document, 'usdc-status');
const count = (page: RenderedPage, request: string): number => page.requests.filter((r) => r === request).length;
// The four USDC presses; at most one shows, the one next step.
const presses = (page: RenderedPage): string[] =>
  ['usdc-retry', 'usdc-resend', 'usdc-check', 'usdc-reload'].filter((id) => shown(page.document, id));

describe('Make 1: the chooser offers only what payableRails allows', () => {
  it('both: both options, ABT chosen', async () => {
    const page = await openDeposit(await depositJob());
    try {
      expect(shown(page.document, 'railopt-abt')).toBe(true);
      expect(shown(page.document, 'railopt-usdc')).toBe(true);
      expect((page.document.getElementById('rail-abt') as HTMLInputElement).checked).toBe(true);
      expect(shown(page.document, 'pay-btn')).toBe(true);
      expect(shown(page.document, 'no-rails')).toBe(false);
    } finally { await page.close(); }
  });
  it('one: that option alone, chosen, and the total is in that currency', async () => {
    const page = await openDeposit(await depositJob({ rail: 'usdc' }));
    try {
      expect(shown(page.document, 'railopt-abt')).toBe(false);
      expect(shown(page.document, 'railopt-usdc')).toBe(true);
      expect((page.document.getElementById('rail-usdc') as HTMLInputElement).checked).toBe(true);
      const deposit = depositUsd(PRICE, 25);
      const total = (parseFloat(deposit) + parseFloat(calculateFee(deposit, USDC_FEE_RATE_PERCENT))).toFixed(2);
      expect(text(page.document, 'total-amount')).toBe(`$${total}`);
      expect(shown(page.document, 'usdc-gas-note')).toBe(true);
    } finally { await page.close(); }
  });
  it('none: no pay control and no total, one sentence and the way into the conversation', async () => {
    const id = await depositJob({ agentDid: UNPAID_AGENT_DID });
    const page = await renderPage(h, `/deposit?job=${id}`, (d) => !d.getElementById('no-rails')!.hidden);
    try {
      expect(shown(page.document, 'pay-btn')).toBe(false);
      expect(shown(page.document, 'rails')).toBe(false);
      expect(shown(page.document, 'total-pane')).toBe(false);
      expect(text(page.document, 'no-rails')).toContain('has not set up payment yet');
      expect(page.document.getElementById('no-rails-link')!.getAttribute('href')).toBe(`/messages?job=${id}`);
    } finally { await page.close(); }
  });
});

describe('Make 2 and 3: a deposit paid in USDC from the page', () => {
  it('says the ETH line before the press, asks twice with the two amounts, pays, writes the row, and confirms exactly once', async () => {
    const id = await depositJob();
    const page = await openDeposit(id);
    try {
      expect(shown(page.document, 'usdc-gas-note')).toBe(false);
      choose(page, 'usdc');
      expect(shown(page.document, 'usdc-gas-note')).toBe(true);
      expect(text(page.document, 'usdc-gas-note')).toBe('You need a little Arbitrum ETH for gas.');
      const wallet = buildPageWallet(h.chain);
      announceWallets(page.window, [{ uuid: 'w-one', name: 'One Wallet', wallet }]);
      press(page, 'pay-btn');
      const deposit = depositUsd(PRICE, 25), fee = calculateFee(deposit, USDC_FEE_RATE_PERCENT);
      expect(text(page.document, 'scan-approvals-line')).toBe(`Two approvals, ${money(deposit)} then ${money(fee)}. Both are part of this one payment.`);
      expect(shown(page.document, 'scan-abt')).toBe(false);
      // The Pay control cannot be pressed twice while the payment runs.
      expect((page.document.getElementById('pay-btn') as HTMLButtonElement).disabled).toBe(true);
      press(page, 'pay-btn');
      await waitFor(() => count(page, `POST /jobs/${id}/confirm`) === 1, 'confirm was never called');
      await new Promise((r) => setTimeout(r, 300));
      expect(count(page, `POST /jobs/${id}/payments/deposit/usdc/start`)).toBe(1);
      expect(count(page, `POST /jobs/${id}/confirm`)).toBe(1);
      expect(wallet.sends.map((s) => [s.recipient, s.amountBaseUnits])).toEqual([[USDC_OPERATOR_ADDRESS, usdc(deposit)], [USDC_FEE_ADDRESS, usdc(fee)]]);
      expect(status(page)).toBe('This payment is confirmed.');
      expect((await h.settlementRepo.findByJobAndLeg(id, 'deposit'))?.rail).toBe('usdc');
      expect((await h.jobRepo.findById(id))?.status).toBe('confirmed');
    } finally { await page.close(); }
  });

  it('paid, but confirm answers 402: only the waiting sentence stays, with the confirm press to try again', async () => {
    const id = await depositJob();
    const page = await openDeposit(id);
    try {
      choose(page, 'usdc');
      announceWallets(page.window, [{ uuid: 'w-402', name: 'Wallet', wallet: buildPageWallet(h.chain) }]);
      // Confirm alone answers 402 on this page, the only way to reach the
      // state: with a real settlement row the real confirm answers 200.
      const realFetch = page.window.fetch;
      Object.defineProperty(page.window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => String(input).endsWith('/confirm')
          ? Promise.resolve(new Response(JSON.stringify({ error: 'deposit not settled' }), { status: 402, headers: { 'content-type': 'application/json' } }))
          : realFetch(input, init),
      });
      press(page, 'pay-btn');
      await waitFor(() => shown(page.document, 'confirm-waiting'), 'the waiting sentence never showed');
      expect(status(page)).toBe('');
      expect(text(page.document, 'confirm-waiting')).toBe('The chain has not confirmed your payment yet. Wait a moment and press this again to check.');
      expect(shown(page.document, 'approved-btn')).toBe(true);
      expect(presses(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it('two wallets announced: the buyer picks one and only that one is asked; an icon that is not a data:image URI is never drawn', async () => {
    const id = await depositJob();
    const page = await openDeposit(id);
    try {
      choose(page, 'usdc');
      const first = buildPageWallet(h.chain), second = buildPageWallet(h.chain);
      const dataIcon = 'data:image/svg+xml;base64,PHN2Zy8+';
      announceWallets(page.window, [
        { uuid: 'w-a', name: 'Wallet A', icon: 'https://wallet-a.example/icon.png', wallet: first },
        { uuid: 'w-b', name: 'Wallet B', icon: dataIcon, wallet: second },
      ]);
      press(page, 'pay-btn');
      await waitFor(() => shown(page.document, 'usdc-pick'), 'the wallet choice never showed');
      const choices = Array.from(page.document.querySelectorAll('#usdc-wallets button'));
      expect(choices.map((b) => (b.textContent ?? '').trim())).toEqual(['Wallet A', 'Wallet B']);
      const imgs = Array.from(page.document.querySelectorAll('#usdc-wallets img'));
      expect(imgs.map((i) => i.getAttribute('src'))).toEqual([dataIcon]);
      expect(choices[0]!.querySelector('img')).toBeNull();
      (choices[1] as HTMLButtonElement).click();
      await waitFor(() => status(page) === 'This payment is confirmed.', 'the picked wallet never paid');
      expect(first.calls).toEqual([]);
      expect(second.sends).toHaveLength(2);
    } finally { await page.close(); }
  });
});

describe('every outcome shows its own sentence in the live region, with its one next step', () => {
  it('the live region is polite and a status', async () => {
    const page = await openDeposit(await depositJob());
    try {
      const region = page.document.getElementById('usdc-status')!;
      expect(region.getAttribute('role')).toBe('status');
      expect(region.getAttribute('aria-live')).toBe('polite');
    } finally { await page.close(); }
  });
  it('no wallet: the engine sentence, and Try again', async () => {
    const page = await openDeposit(await depositJob());
    try {
      choose(page, 'usdc');
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('No wallet was found. Install a wallet extension, or open this page inside your wallet app.');
      expect(presses(page)).toEqual(['usdc-retry']);
    } finally { await page.close(); }
  });
  it('cancelled: the engine sentence, nothing sent, and Try again runs it again', async () => {
    const page = await openDeposit(await depositJob());
    try {
      choose(page, 'usdc');
      const wallet = buildPageWallet(h.chain, { refuseAccounts: true });
      announceWallets(page.window, [{ uuid: 'w-c', name: 'Refuser', wallet }]);
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('You closed the wallet before approving.');
      expect(wallet.sends).toHaveLength(0);
      expect(presses(page)).toEqual(['usdc-retry']);
      press(page, 'usdc-retry');
      await waitFor(() => wallet.calls.filter((c) => c === 'eth_requestAccounts').length === 2, 'Try again did nothing');
    } finally { await page.close(); }
  });
  it('transfer_failed: the engine sentence, and Send it again sends only the fee', async () => {
    const id = await depositJob();
    const page = await openDeposit(id);
    try {
      choose(page, 'usdc');
      const wallet = buildPageWallet(h.chain, { failFirstFee: true });
      announceWallets(page.window, [{ uuid: 'w-f', name: 'Flaky', wallet }]);
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('The fee transfer failed on the network. You can send it again.');
      expect(presses(page)).toEqual(['usdc-resend']);
      expect(wallet.sends).toHaveLength(2);
      press(page, 'usdc-resend');
      await waitFor(() => count(page, `POST /jobs/${id}/confirm`) === 1, 'the resend never paid');
      expect(wallet.sends).toHaveLength(3);
      expect(wallet.sends[2]!.recipient).toBe(USDC_FEE_ADDRESS);
      expect((await h.settlementRepo.findByJobAndLeg(id, 'deposit'))).not.toBeNull();
    } finally { await page.close(); }
  });
  it('waiting_network: the engine sentence, Check again reads once on the press and never on a timer', async () => {
    const id = await depositJob();
    const page = await openDeposit(id);
    try {
      choose(page, 'usdc');
      const wallet = buildPageWallet(h.chain, { serverLags: true });
      announceWallets(page.window, [{ uuid: 'w-l', name: 'Slow chain', wallet }]);
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('The network has not confirmed this payment yet. Check again shortly.');
      expect(presses(page)).toEqual(['usdc-check']);
      const responses = (): number => count(page, `POST /jobs/${id}/payments/deposit/usdc/wallet-response`);
      expect(responses()).toBe(1);
      await new Promise((r) => setTimeout(r, 1200));
      expect(responses()).toBe(1);
      wallet.release();
      press(page, 'usdc-check');
      await waitFor(() => count(page, `POST /jobs/${id}/confirm`) === 1, 'the check never paid');
      expect(responses()).toBe(2);
      expect(count(page, `POST /jobs/${id}/payments/deposit/usdc/start`)).toBe(1);
      expect(wallet.sends).toHaveLength(2);
    } finally { await page.close(); }
  });
  it('already_paid on the USDC deposit: the server sentence, Reload, and the confirm press beside it', async () => {
    const id = await depositJob({ rail: 'usdc' });
    await h.settle(id, 'deposit', 'usdc');
    const page = await openDeposit(id);
    try {
      announceWallets(page.window, [{ uuid: 'w-p', name: 'Paid', wallet: buildPageWallet(h.chain) }]);
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('The deposit leg has already been paid; reload this page to see the confirmed payment');
      expect(presses(page)).toEqual(['usdc-reload']);
      expect(shown(page.document, 'approved-btn')).toBe(true);
      expect(text(page.document, 'scanh')).toBe('Already paid');
      expect(text(page.document, 'scan-approvals-line')).toBe('');
      expect(count(page, `POST /jobs/${id}/confirm`)).toBe(0);
      press(page, 'approved-btn');
      await waitFor(() => count(page, `POST /jobs/${id}/confirm`) === 1, 'the press never confirmed');
      await new Promise((r) => setTimeout(r, 300));
      expect((await h.jobRepo.findById(id))?.status).toBe('confirmed');
    } finally { await page.close(); }
  });
});

describe('Make 5 (B54): an already-paid leg on the ABT door reads as already paid, never as no agreed price', () => {
  it('on the deposit page', async () => {
    const id = await depositJob({ rail: 'abt' });
    await h.settle(id, 'deposit', 'abt');
    const page = await openDeposit(id);
    try {
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('The deposit leg has already been paid; reload this page to see the confirmed payment');
      expect(page.document.body.textContent).not.toContain('no agreed price');
      expect(shown(page.document, 'pay-error')).toBe(false);
      expect(presses(page)).toEqual(['usdc-reload']);
      expect(shown(page.document, 'approved-btn')).toBe(true);
      expect(text(page.document, 'scanh')).toBe('Already paid');
      expect(page.document.getElementById('usdc-reload')!.getAttribute('href')).toBe(`/deposit?job=${id}`);
    } finally { await page.close(); }
  });
  it('on the balance page', async () => {
    const id = await stagedJob('abt');
    await h.settle(id, 'remainder', 'abt');
    const page = await openStaged(id);
    try {
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('The remainder leg has already been paid; reload this page to see the confirmed payment');
      expect(page.document.body.textContent).not.toContain('no agreed price');
      expect(shown(page.document, 'pay-error')).toBe(false);
      expect(presses(page)).toEqual(['usdc-reload']);
      expect(shown(page.document, 'check-pr-btn')).toBe(true);
    } finally { await page.close(); }
  });
});

describe('Make 4: the balance page pays in the job\u2019s own currency', () => {
  it('an ABT job at 3 percent, from payment.ts, and its gas line stays hidden', async () => {
    const page = await openStaged(await stagedJob('abt'));
    try {
      const remainder = remainderUsd(PRICE, 25), fee = calculateFee(remainder, ABT_FEE_RATE_PERCENT);
      const total = (parseFloat(remainder) + parseFloat(fee)).toFixed(2);
      expect(text(page.document, 'pay-btn')).toBe(`Pay the balance, $${total}`);
      expect(page.document.querySelector('#choices .para')?.textContent).toContain(`plus the ${ABT_FEE_RATE_PERCENT} percent fee`);
      expect(shown(page.document, 'usdc-gas-note')).toBe(false);
    } finally { await page.close(); }
  });
  it('a USDC job at 6 percent, from payment.ts: the choices row, the Pay label, and the sheet', async () => {
    const id = await stagedJob('usdc');
    const page = await openStaged(id);
    try {
      const remainder = remainderUsd(PRICE, 25), fee = calculateFee(remainder, USDC_FEE_RATE_PERCENT);
      const total = (parseFloat(remainder) + parseFloat(fee)).toFixed(2);
      expect(text(page.document, 'pay-btn')).toBe(`Pay the balance, $${total}`);
      expect(page.document.querySelector('#choices .para')?.textContent).toContain(`plus the ${USDC_FEE_RATE_PERCENT} percent fee`);
      expect(shown(page.document, 'usdc-gas-note')).toBe(true);
      press(page, 'pay-btn');
      expect(text(page.document, 'scan-fee-label')).toBe(`FreeAgents fee, ${USDC_FEE_RATE_PERCENT} percent`);
      expect(text(page.document, 'scan-fee')).toBe(money(fee));
      expect(text(page.document, 'scan-total')).toBe(`$${total}`);
      expect(text(page.document, 'scan-approvals-line')).toBe(`Two approvals, ${money(remainder)} then ${money(fee)}. Both are part of this one payment.`);
      expect(shown(page.document, 'scan-abt')).toBe(false);
    } finally { await page.close(); }
  });
  it('a USDC balance paid through the page: the row written, then the post-payment state ABT shows', async () => {
    const id = await stagedJob('usdc');
    const page = await openStaged(id);
    try {
      const wallet = buildPageWallet(h.chain);
      announceWallets(page.window, [{ uuid: 'w-s', name: 'Balance wallet', wallet }]);
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('This payment is confirmed.');
      const remainder = remainderUsd(PRICE, 25), fee = calculateFee(remainder, USDC_FEE_RATE_PERCENT);
      expect(wallet.sends.map((s) => [s.recipient, s.amountBaseUnits])).toEqual([[USDC_OPERATOR_ADDRESS, usdc(remainder)], [USDC_FEE_ADDRESS, usdc(fee)]]);
      expect((await h.settlementRepo.findByJobAndLeg(id, 'remainder'))?.rail).toBe('usdc');
      expect(shown(page.document, 'scan-status')).toBe(true);
      expect(text(page.document, 'scan-status')).toBe('The pull request opens once the operator submits the work.');
      expect(shown(page.document, 'check-pr-btn')).toBe(true);
      expect(presses(page)).toEqual([]);
      expect(count(page, `POST /jobs/${id}/payments/remainder/abt/start`)).toBe(0);
    } finally { await page.close(); }
  });
  it('already_paid on the USDC balance: the server sentence and Reload', async () => {
    const id = await stagedJob('usdc');
    await h.settle(id, 'remainder', 'usdc');
    const page = await openStaged(id);
    try {
      announceWallets(page.window, [{ uuid: 'w-sp', name: 'Paid', wallet: buildPageWallet(h.chain) }]);
      press(page, 'pay-btn');
      await waitFor(() => status(page) !== '' || shown(page.document, 'pay-error'), 'no sentence');
      expect(status(page)).toBe('The remainder leg has already been paid; reload this page to see the confirmed payment');
      expect(presses(page)).toEqual(['usdc-reload']);
      expect(shown(page.document, 'scan-approvals-line')).toBe(false);
    } finally { await page.close(); }
  });
});
