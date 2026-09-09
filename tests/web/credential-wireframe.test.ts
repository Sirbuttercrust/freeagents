// W6 C1: the raw-record disclosure gains the wireframe's two controls,
// "Download JSON" and "Check the signature" (spec/wireframe/credential.html
// :223-226). Driven end to end against the real app and the real script, the
// same discipline tests/web/job-wireframe.test.ts already holds to for the
// job page: a control that only satisfies the conformance instrument's text
// match, with no real href wired to it, is the
// conformance-satisfied-by-dead-markup class (W1 round 2).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:zW6CredAgent';
const BUYER_DID = 'did:example:w6-buyer';
const JOB_ID = 'w6-cred-job';

function credentialDoc(jobId: string): VerifiableCredential {
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
        repository: 'buyer/w6-repo',
        pullRequest: 'https://github.com/buyer/w6-repo/pull/1',
        mergedAt: '2026-08-20T00:00:00.000Z',
        mergeCommit: 'w6cafefeed',
        signedBy: `${AGENT_DID}#key-1`,
        buyer: BUYER_DID,
        additions: 10,
        deletions: 2,
        filesChanged: 1,
        specHash: 'sha256:spec',
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw6-proof' },
  };
}

let credentialRepo: MemoryCredentialRepository;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  credentialRepo = new MemoryCredentialRepository();
  await credentialRepo.save({
    completedJobId: JOB_ID,
    subjectDid: AGENT_DID,
    document: credentialDoc(JOB_ID),
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

describe('the raw-record disclosure carries real hrefs once a receipt loads (W6 C1)', () => {
  it('wires "Download JSON" to the same destination as the primary download control', async () => {
    const page = await render(`/v1/credentials/${JOB_ID}`);
    try {
      const primary = page.document.getElementById('download-link');
      const raw = page.document.getElementById('raw-download-link');
      expect(raw).not.toBeNull();
      expect(raw!.getAttribute('href')).toBe(primary!.getAttribute('href'));
      expect(raw!.hasAttribute('download')).toBe(true);
    } finally {
      page.close();
    }
  });

  it('wires "Check the signature" to the same /verify?credential= address as the primary verify control', async () => {
    const page = await render(`/v1/credentials/${JOB_ID}`);
    try {
      const primary = page.document.getElementById('verify-link');
      const raw = page.document.getElementById('raw-verify-link');
      expect(raw).not.toBeNull();
      expect(raw!.getAttribute('href')).toBe(primary!.getAttribute('href'));
      expect(raw!.getAttribute('href')).toContain('/verify?credential=');
    } finally {
      page.close();
    }
  });
});
