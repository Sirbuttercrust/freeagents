// R-19 (D4, ENT-1.2): what the operator page actually RENDERS, real script
// against the real API. Mirrors tests/web/browse.test.ts for style: jsdom
// loads the served page, lets its own script run, and the assertions read
// the DOM a visitor is left looking at.
//
// ANCHOR under test: an operator page is the sum of who they run, never a
// score for the operator. D4: one layout, no branching; sort and filter
// controls appear only above ten agents.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryOperatorRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const SOLO_OPERATOR_DID = 'did:abt:zRosterPageSoloOperator';
const MANY_OPERATOR_DID = 'did:abt:zRosterPageManyOperator';
const EMPTY_OPERATOR_DID = 'did:abt:zRosterPageEmptyOperator';

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:roster-page-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${operatorDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zProof',
    },
  };
}

function credentialDoc(id: string, subjectDid: string, mergeCommit: string, buyerDid: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-08-30T00:00:00.000Z',
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: buyerDid,
        additions: 4,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const operatorRepo = new MemoryOperatorRepository();
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const jobRepo = new MemoryJobRepository();

  await operatorRepo.register({ did: SOLO_OPERATOR_DID, githubLogin: 'roster-page-solo' });
  await operatorRepo.register({ did: MANY_OPERATOR_DID, githubLogin: 'roster-page-many' });
  await operatorRepo.register({ did: EMPTY_OPERATOR_DID, githubLogin: 'roster-page-empty' });

  const soloAgentDid = 'did:abt:zRosterPageSoloAgent';
  await agentRepo.create({
    did: soloAgentDid,
    operatorDid: SOLO_OPERATOR_DID,
    delegation: delegation(soloAgentDid, SOLO_OPERATOR_DID),
    name: 'Solo Agent',
    skills: ['typescript'],
    githubLogin: null,
  });
  await credentialRepo.save({
    completedJobId: 'roster-page-solo-job',
    subjectDid: soloAgentDid,
    document: credentialDoc('https://platform.example/v1/credentials/roster-page-solo-job', soloAgentDid, 'roster-page-solo-commit', 'did:example:buyer-solo'),
    repositoryPublic: true,
  });

  // Eleven agents under one operator: crosses D4's above-ten threshold.
  for (let i = 0; i < 11; i += 1) {
    const did = `did:abt:zRosterPageManyAgent${i}`;
    await agentRepo.create({
      did,
      operatorDid: MANY_OPERATOR_DID,
      delegation: delegation(did, MANY_OPERATOR_DID),
      name: `Many Agent ${i}`,
      skills: ['python'],
      githubLogin: null,
    });
  }

  const app = createApp(operatorRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
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

describe('the operator page roster (R-19)', () => {
  it('a single-agent operator sees the roster table with one row, no sort or filter controls', async () => {
    const page = await render(`/operators/${SOLO_OPERATOR_DID}`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(1);

      // D4: below ten agents, the table renders plain, no controls.
      expect(page.document.getElementById('roster-controls')?.hidden).toBe(true);
    } finally {
      page.close();
    }
  });

  it('each roster row carries the same three separately labelled tier counts a browse card does', async () => {
    const page = await render(`/operators/${SOLO_OPERATOR_DID}`);
    try {
      const row = page.document.querySelector('[data-agent-row]');
      const text = row?.textContent ?? '';
      expect(text).toContain('1 verified hire');
      expect(text).toContain('verified prior work');
      expect(text).toContain('portfolio');
    } finally {
      page.close();
    }
  });

  it('the aggregate is a summary line, three separate figures, never a combined score', async () => {
    const page = await render(`/operators/${SOLO_OPERATOR_DID}`);
    try {
      const summary = page.document.getElementById('roster-summary')?.textContent ?? '';
      expect(summary).toContain('1 verified hire');
      expect(summary).toContain('verified prior work');
      expect(summary).toContain('portfolio');
      // No blended word anywhere near the aggregate.
      expect(summary.toLowerCase()).not.toContain('score');
      expect(summary.toLowerCase()).not.toContain('reputation');
      expect(summary.toLowerCase()).not.toContain('rank');
    } finally {
      page.close();
    }
  });

  it('per-agent rows stay dominant: the roster table renders before the aggregate summary in the DOM', async () => {
    const page = await render(`/operators/${SOLO_OPERATOR_DID}`);
    try {
      const rosterHost = page.document.getElementById('roster-cards');
      const summary = page.document.getElementById('roster-summary');
      expect(rosterHost).toBeTruthy();
      expect(summary).toBeTruthy();
      const position = rosterHost?.compareDocumentPosition(summary as Node) ?? 0;
      // DOCUMENT_POSITION_FOLLOWING: summary comes after the roster.
      expect((position & 0x04) !== 0).toBe(true);
    } finally {
      page.close();
    }
  });

  it('an operator with zero agents renders an honest empty roster, no promotional framing (ENT-2.4)', async () => {
    const page = await render(`/operators/${EMPTY_OPERATOR_DID}`);
    try {
      expect(page.document.getElementById('roster-empty')?.hidden).toBe(false);
      expect(page.document.querySelectorAll('[data-agent-row]').length).toBe(0);
      const text = (page.document.body.textContent ?? '').toLowerCase();
      expect(text).not.toContain('coming soon');
      expect(text).not.toContain('new operator');

      const summary = page.document.getElementById('roster-summary')?.textContent ?? '';
      expect(summary).toContain('0 verified hires');
    } finally {
      page.close();
    }
  });

  it('an operator running eleven agents gets sort and filter controls (D4, above ten)', async () => {
    const page = await render(`/operators/${MANY_OPERATOR_DID}`);
    try {
      const rows = page.document.querySelectorAll('[data-agent-row]');
      expect(rows.length).toBe(11);
      expect(page.document.getElementById('roster-controls')?.hidden).toBe(false);
      const sortSelect = page.document.getElementById('roster-sort');
      expect(sortSelect).toBeTruthy();
    } finally {
      page.close();
    }
  });

  it('every roster row links to its agent profile', async () => {
    const page = await render(`/operators/${SOLO_OPERATOR_DID}`);
    try {
      const link = page.document.querySelector(`a[href="/agents/${encodeURIComponent('did:abt:zRosterPageSoloAgent')}"]`);
      expect(link).toBeTruthy();
    } finally {
      page.close();
    }
  });
});
