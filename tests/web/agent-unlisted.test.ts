// FIX-SW12g (SW3-02): an agent its owner has stopped listing refuses new
// hires at POST /jobs (FIX-B43a), and its public page is the one place a
// person learns that before writing a brief. So the page reads the
// record's own `listed`: an explicit false hides the Hire button (with no
// href on it) and shows one sentence in its place. A listed agent renders
// exactly as before. Driven end to end against the real app, the same
// shape tests/web/agent-cold-start.test.ts renders the page in.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentPageReady, settled } from '../helpers/page-settled.js';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

const OPERATOR_DID = 'did:abt:zSw12gOperator';
const LISTED_DID = 'did:abt:zSw12gListedAgent';
const UNLISTED_DID = 'did:abt:zSw12gUnlistedAgent';
const SENTENCE = 'This agent is not taking new hires right now.';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:sw12g-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-09-29T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-09-29T00:00:00.000Z', verificationMethod: `${OPERATOR_DID}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zProof' },
  };
}

// Text a person can see: the body with every hidden subtree, template,
// script and style removed, whitespace collapsed.
function visibleText(document: Document): string {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll('[hidden], template, script, style').forEach((el) => el.remove());
  return (body.textContent ?? '').replace(/\s+/g, ' ');
}

function shown(el: Element | null): boolean {
  return el !== null && el.closest('[hidden]') === null;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  for (const [did, name] of [[LISTED_DID, 'sw12g-listed'], [UNLISTED_DID, 'sw12g-unlisted']] as const) {
    await agentRepo.create({ did, operatorDid: OPERATOR_DID, delegation: delegation(did), name, skills: ['triage'], githubLogin: null });
  }
  await agentRepo.setListed(UNLISTED_DID, false);
  const app = createApp(undefined, agentRepo, undefined, undefined, new MemoryJobRepository(), undefined, undefined, new MemoryCredentialRepository());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function render(did: string): Promise<{ document: Document; close: () => void }> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const path = `/agents/${encodeURIComponent(did)}`;
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  expect(response.status).toBe(200);
  const dom = new JSDOM(await response.text(), {
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
  await settled(dom.window.document, agentPageReady, 'the agent page');
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { document: dom.window.document, close: () => dom.window.close() };
}

describe('an unlisted agent\'s page says it is not taking hires, and offers no Hire button (SW3-02)', () => {
  it('the record the page reads carries listed: false for the unlisted agent and true for the other', async () => {
    const unlisted = (await (await fetch(`${baseUrl}/agents/${encodeURIComponent(UNLISTED_DID)}`)).json()) as { listed: unknown };
    const listed = (await (await fetch(`${baseUrl}/agents/${encodeURIComponent(LISTED_DID)}`)).json()) as { listed: unknown };
    expect({ unlisted: unlisted.listed, listed: listed.listed }).toEqual({ unlisted: false, listed: true });
  });

  it('listed: false hides #hire-cta with no href and shows the whole sentence in its place', async () => {
    const page = await render(UNLISTED_DID);
    try {
      const cta = page.document.getElementById('hire-cta');
      expect(cta, '#hire-cta still ships in the markup').not.toBeNull();
      expect(shown(cta), 'the Hire button is hidden').toBe(false);
      expect(cta?.hasAttribute('href'), 'a hidden button carries no destination').toBe(false);
      const note = page.document.getElementById('not-hiring');
      expect(shown(note), '#not-hiring is shown').toBe(true);
      expect(note?.textContent?.trim()).toBe(SENTENCE);
      expect(note?.closest('.pacts'), 'the sentence sits where the button was').not.toBeNull();
      expect(visibleText(page.document)).toContain(SENTENCE);
    } finally {
      page.close();
    }
  });

  it('listed: true shows #hire-cta with its /hire?agent= href and no sentence', async () => {
    const page = await render(LISTED_DID);
    try {
      const cta = page.document.getElementById('hire-cta');
      expect(shown(cta)).toBe(true);
      expect(cta?.getAttribute('href')).toBe(`/hire?agent=${encodeURIComponent(LISTED_DID)}`);
      expect(shown(page.document.getElementById('not-hiring'))).toBe(false);
      expect(visibleText(page.document)).not.toContain(SENTENCE);
    } finally {
      page.close();
    }
  });
});
