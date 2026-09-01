// R-22 (ENT-10, issue 29): the agent profile's read surface for reviews.
// Same style as tests/web/agent-cold-start.test.ts and tests/web/browse.
// test.ts: jsdom loads the served page, lets its own script run, and the
// assertions read the DOM a visitor is left looking at.
//
// The card's scope line: "clearly separated from the three evidence
// tiers, labelled as buyer opinion rather than platform verification."
// This file proves both halves: a review renders in its own section, after
// the three tier sections, and that section's own copy says "opinion", not
// "verified".
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
  MemoryReviewRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

const OPERATOR_DID = 'did:abt:zAgentReviewsOperator';
const AGENT_WITH_REVIEW_DID = 'did:abt:zAgentReviewsWithReview';
const AGENT_NO_REVIEW_DID = 'did:abt:zAgentReviewsNoReview';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:agent-reviews-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zProof',
    },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const reviewRepo = new MemoryReviewRepository();

  await agentRepo.create({
    did: AGENT_WITH_REVIEW_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_WITH_REVIEW_DID),
    name: 'Reviewed Agent',
    skills: ['typescript'],
    githubLogin: null,
  });
  await agentRepo.create({
    did: AGENT_NO_REVIEW_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_NO_REVIEW_DID),
    name: 'Unreviewed Agent',
    skills: ['python'],
    githubLogin: null,
  });

  await reviewRepo.save({
    jobId: 'agent-reviews-job-1',
    authorDid: 'did:example:agent-reviews-buyer',
    agentDid: AGENT_WITH_REVIEW_DID,
    text: 'Shipped exactly what we agreed and answered every question.',
    createdAt: new Date('2026-08-30T00:00:00Z'),
  });

  const app = createApp(
    new MemoryAccountRepository(),
    agentRepo,
    undefined,
    undefined,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reviewRepo,
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Rendered {
  document: Document;
  close: () => void;
}

async function render(path: string): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  expect(response.status, `unexpected status for ${path}`).toBe(200);
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return { document: dom.window.document, close: () => dom.window.close() };
}

// Node.DOCUMENT_POSITION_FOLLOWING per the DOM spec, used the same way
// tests/web/agent-cold-start.test.ts does: jsdom's global scope here
// carries no ambient `Node`.
const DOCUMENT_POSITION_FOLLOWING = 0x04;

describe('the agent profile renders reviews, separated from the evidence tiers (R-22, ENT-10)', () => {
  it('a review renders its text, attributed to the buyer, tied to its job', async () => {
    const page = await render(`/agents/${AGENT_WITH_REVIEW_DID}`);
    try {
      const text = page.document.body.textContent ?? '';
      expect(text).toContain('Shipped exactly what we agreed and answered every question.');
    } finally {
      page.close();
    }
  });

  it('carries no star rating, score, or numeric review value anywhere on the page (ENT-10.2)', async () => {
    const page = await render(`/agents/${AGENT_WITH_REVIEW_DID}`);
    try {
      const text = (page.document.body.textContent ?? '').toLowerCase();
      expect(text).not.toMatch(/\b[1-5](\.\d)?\s*(star|\/\s*5|out of 5)/);
      expect(page.document.querySelectorAll('[class*="star" i], [data-rating], [data-score]').length).toBe(0);
    } finally {
      page.close();
    }
  });

  it('the reviews section renders after the three evidence-tier sections, not blended into them', async () => {
    const page = await render(`/agents/${AGENT_WITH_REVIEW_DID}`);
    try {
      const tierHeadings = ['tier-hire-heading', 'tier-prior-heading', 'tier-claim-heading'].map((id) =>
        page.document.getElementById(id),
      );
      for (const heading of tierHeadings) expect(heading).not.toBeNull();

      const reviewsHeading = page.document.getElementById('reviews-heading');
      expect(reviewsHeading).not.toBeNull();

      // Every tier heading precedes the reviews heading in document order.
      for (const heading of tierHeadings) {
        const position = heading!.compareDocumentPosition(reviewsHeading!);
        expect(Boolean(position & DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      }
    } finally {
      page.close();
    }
  });

  it('labels reviews as buyer opinion, never as platform verification', async () => {
    const page = await render(`/agents/${AGENT_WITH_REVIEW_DID}`);
    try {
      const reviewsSection = page.document.getElementById('reviews-heading')?.parentElement;
      const text = (reviewsSection?.textContent ?? page.document.body.textContent ?? '').toLowerCase();
      expect(text).toContain('opinion');
    } finally {
      page.close();
    }
  });

  it('an agent with no reviews shows an honest empty state, not an absence', async () => {
    const page = await render(`/agents/${AGENT_NO_REVIEW_DID}`);
    try {
      const reviewsHeading = page.document.getElementById('reviews-heading');
      expect(reviewsHeading).not.toBeNull();
      const empty = page.document.getElementById('reviews-empty');
      expect(empty?.hidden).toBe(false);
    } finally {
      page.close();
    }
  });
});
