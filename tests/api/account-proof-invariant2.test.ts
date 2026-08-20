// Invariant 2 (MISSION.md), for R-3 direction one: a third party can confirm
// that an agent's DID document points at its GitHub account WITHOUT calling
// this service. The claim lives in the standard DID Core alsoKnownAs field,
// so a third-party reading is "parse alsoKnownAs as a list of URIs and look
// for the account URL" - nothing service-specific to install or trust.
//
// This mirrors how R-2 proved the same invariant for the delegation
// credential (tests/api/agent-invariant2.test.ts).
//
// Limitation, stated for the record: resolving a live did:abt document
// through an off-the-shelf resolver is impossible until a resolver exists.
// This test is the strongest invariant-2 proof available now: it pins the
// claim to a standard field in a standard document shape, and it proves the
// standard reading reaches the same conclusion as the platform's decision.
import { describe, expect, it } from 'vitest';
import {
  didDocumentPointsAtGithubAccount,
  githubAccountUrl,
} from '../../src/domain/account-proof.js';

// A standard DID Core document: @context is the DID v1 context, id is a
// did:abt DID, one verification method, and - where the claim exists -
// alsoKnownAs. No private or service-specific fields anywhere.
function standardDocument(id: string, alsoKnownAs?: readonly string[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    verificationMethod: [
      {
        id: `${id}#key-1`,
        type: 'Ed25519VerificationKey2020',
        controller: id,
        // Fixture, not a real key: the claim under test lives in
        // alsoKnownAs, and a third party checking it never touches the key.
        publicKeyMultibase: 'zMultibaseFixtureNotARealKey',
      },
    ],
  };
  if (alsoKnownAs !== undefined) doc.alsoKnownAs = [...alsoKnownAs];
  return doc;
}

// The third-party reading: exactly what standard DID tooling does with
// alsoKnownAs. It knows the DID Core field name and the GitHub account URL
// form; it knows nothing about this service. Deliberately NOT a call into
// the platform's decision function.
function thirdPartyReadsAccount(doc: Record<string, unknown>, handle: string): boolean {
  const entries = doc.alsoKnownAs;
  if (!Array.isArray(entries)) return false;
  const wanted = `https://github.com/${handle.toLowerCase()}`;
  return entries.some(
    (entry) => typeof entry === 'string' && entry.trim().replace(/\/+$/, '').toLowerCase() === wanted,
  );
}

const AGENT_DID = 'did:abt:zAgentKeyHashFixture';
const HANDLE = 'scout-agent';

describe('direction one of the GitHub proof, invariant 2', () => {
  it('the documents under test are standard DID Core shape, no private fields', () => {
    const doc = standardDocument(AGENT_DID, [githubAccountUrl(HANDLE)]);
    expect(doc['@context']).toEqual(['https://www.w3.org/ns/did/v1']);
    expect(doc.id).toBe(AGENT_DID);
    expect(Array.isArray(doc.verificationMethod)).toBe(true);
    // A private field in here would be a custom format to verify: fail loud.
    expect(Object.keys(doc).sort()).toEqual(['@context', 'alsoKnownAs', 'id', 'verificationMethod']);
  });

  it.each([
    ['claim present', standardDocument(AGENT_DID, [githubAccountUrl(HANDLE)]), true],
    ['claim absent (no alsoKnownAs)', standardDocument(AGENT_DID), false],
    [
      'claim for a different account',
      standardDocument(AGENT_DID, ['https://github.com/someone-else']),
      false,
    ],
    [
      'multiple entries, claim among them',
      standardDocument(AGENT_DID, ['https://example.org/scout', `https://github.com/${HANDLE}/`]),
      true,
    ],
    [
      'multiple entries, none matching',
      standardDocument(AGENT_DID, ['https://example.org/scout', 'https://github.com/someone-else']),
      false,
    ],
  ])('%s: the standard reading and the platform decision agree', (_label, doc, expected) => {
    const thirdParty = thirdPartyReadsAccount(doc, HANDLE);
    const platform = didDocumentPointsAtGithubAccount(
      (doc.alsoKnownAs as readonly string[] | undefined) ?? null,
      HANDLE,
    );
    expect(thirdParty).toBe(expected);
    // The platform's stored conclusion is reproducible by a third party
    // with standard tooling and no call to this service.
    expect(platform).toBe(thirdParty);
  });

  it('a claim in a private field is invisible to the standard reading: false', () => {
    const doc = standardDocument(AGENT_DID);
    doc.githubAccount = `https://github.com/${HANDLE}`;
    expect(thirdPartyReadsAccount(doc, HANDLE)).toBe(false);
    expect(
      didDocumentPointsAtGithubAccount(
        (doc.alsoKnownAs as readonly string[] | undefined) ?? null,
        HANDLE,
      ),
    ).toBe(false);
  });
});
