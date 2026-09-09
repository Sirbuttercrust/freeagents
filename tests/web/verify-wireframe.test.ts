// W6 V1/V2: the verify page's action row (Open the pull request on GitHub,
// See the receipt, See the agent) and its "Download JSON" control
// (spec/wireframe/verify.html:108-112, :199-201). Driven end to end
// against the real app and the real script. Each control ships hidden
// with no href in the markup and gets both only on verify.js's success
// path, and only when the receipt itself carries the field the control
// needs -- a receipt with no pullRequest must never show a pull-request
// button pointing at nothing (the brief's own words).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:zW6VerifyAgent';
const BUYER_DID = 'did:example:w6-verify-buyer';
const FULL_JOB_ID = 'w6-verify-job-full';
const NO_PR_JOB_ID = 'w6-verify-job-no-pr';

function fullCredentialDoc(jobId: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${jobId}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/w6-verify-repo',
        pullRequest: 'https://github.com/buyer/w6-verify-repo/pull/7',
        mergedAt: '2026-08-20T00:00:00.000Z',
        mergeCommit: 'w6verifycommit',
        signedBy: `${AGENT_DID}#key-1`,
        buyer: BUYER_DID,
        additions: 5,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw6-verify-proof' },
  };
}

// A receipt with no pullRequest field at all: V1's own inertness case.
function noPrCredentialDoc(jobId: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${jobId}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/w6-verify-repo',
        pullRequest: '',
        mergeCommit: '',
        mergedAt: '2026-08-20T00:00:00.000Z',
        signedBy: `${AGENT_DID}#key-1`,
        buyer: BUYER_DID,
        additions: 0,
        deletions: 0,
        filesChanged: 0,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw6-verify-no-pr-proof' },
  };
}

let credentialRepo: MemoryCredentialRepository;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  credentialRepo = new MemoryCredentialRepository();
  await credentialRepo.save({
    completedJobId: FULL_JOB_ID,
    subjectDid: AGENT_DID,
    document: fullCredentialDoc(FULL_JOB_ID),
    repositoryPublic: true,
  });
  await credentialRepo.save({
    completedJobId: NO_PR_JOB_ID,
    subjectDid: AGENT_DID,
    document: noPrCredentialDoc(NO_PR_JOB_ID),
    repositoryPublic: true,
  });

  server = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, credentialRepo).listen(
    0,
    '127.0.0.1',
  );
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

  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);

  return { document: dom.window.document, close: () => dom.window.close() };
}

describe('the verify action row (W6 V1) is present with real hrefs on a loaded receipt', () => {
  it('the pull request button opens GitHub, the receipt button opens the receipt, the agent button opens the profile', async () => {
    const page = await render(`/verify?credential=${FULL_JOB_ID}`);
    try {
      const pr = page.document.getElementById('pr-link');
      const receipt = page.document.getElementById('receipt-link');
      const agent = page.document.getElementById('verify-agent-link');

      expect(pr?.hidden).toBe(false);
      expect(pr?.getAttribute('href')).toBe('https://github.com/buyer/w6-verify-repo/pull/7');
      expect(pr?.getAttribute('rel')).toBe('noreferrer');

      expect(receipt?.hidden).toBe(false);
      expect(receipt?.getAttribute('href')).toContain(`/v1/credentials/${FULL_JOB_ID}`);

      expect(agent?.hidden).toBe(false);
      expect(agent?.getAttribute('href')).toBe(`/agents/${encodeURIComponent(AGENT_DID)}`);
    } finally {
      page.close();
    }
  });

  it('wires "Download JSON" in the signature-check panel to the receipt address, with the download attribute', async () => {
    const page = await render(`/verify?credential=${FULL_JOB_ID}`);
    try {
      const dl = page.document.getElementById('sig-download-link');
      expect(dl?.hidden).toBe(false);
      expect(dl?.hasAttribute('download')).toBe(true);
      expect(dl?.getAttribute('href')).toContain(`/v1/credentials/${FULL_JOB_ID}`);
    } finally {
      page.close();
    }
  });
});

describe('the verify action row omits a control whose own field the receipt does not carry (W6 V1)', () => {
  it('a receipt with no pullRequest gets no pull-request button, never one pointing at nothing', async () => {
    const page = await render(`/verify?credential=${NO_PR_JOB_ID}`);
    try {
      const pr = page.document.getElementById('pr-link');
      expect(pr?.hidden).toBe(true);
      expect(pr?.getAttribute('href')).toBe(null);

      // The other two controls still ship: this receipt does carry an id
      // and an agent.
      const receipt = page.document.getElementById('receipt-link');
      const agent = page.document.getElementById('verify-agent-link');
      expect(receipt?.hidden).toBe(false);
      expect(agent?.hidden).toBe(false);
    } finally {
      page.close();
    }
  });
});
