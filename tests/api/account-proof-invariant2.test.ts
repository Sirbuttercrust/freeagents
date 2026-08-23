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
import * as nodeCrypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  didDocumentPointsAtGithubAccount,
  gistProofPayload,
  githubAccountUrl,
  parseGistStatement,
  signatureIsWellFormed,
  statementBindsBinding,
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

// Direction two, invariant 2: the proof is a public gist holding a signed
// statement. A third party verifies it with the gist, the agent DID, and
// standard ed25519 tooling, WITHOUT calling this service. The third party
// here is the test's own parser, its own canonical-bytes construction, and
// node:crypto; the platform side is the domain decision plus the same
// standard primitive. Agreement between the two is what the invariant pins.
describe('direction two of the GitHub proof, invariant 2', () => {
  const agentUrl = githubAccountUrl(HANDLE);
  // Real key material, generated at run time: nothing memorized in the repo.
  const agentKeys = nodeCrypto.generateKeyPairSync('ed25519');

  // The third party's canonical bytes: its own string construction of the
  // documented format, deliberately not the platform helper.
  const thirdPartyBytes = `freeagents-github-proof v1\n${AGENT_DID}\n${agentUrl}\n`;
  const signature = nodeCrypto
    .sign(null, Buffer.from(thirdPartyBytes, 'utf8'), agentKeys.privateKey)
    .toString('base64');

  // The statement as the third party chose to write it: CRLF line endings,
  // keys out of order and mixed case, a comment line, and a trailing blank.
  // The bytes the signature covers must not depend on any of that.
  const statement =
    [
      '# posted from a laptop, keys out of order on purpose',
      `signature: ${signature}`,
      `GITHUB: ${agentUrl}`,
      `did: ${AGENT_DID}`,
      'Version: 1',
      '',
    ].join('\r\n') + '\r\n';

  // The published gist, as the public GitHub API serves it: id, the author
  // login, and the file contents. A plain fixture, no service involved.
  const gist = {
    id: 'invariant2-gist',
    owner: HANDLE,
    files: { 'proof.txt': statement },
  };

  // The third party's own reader: split lines, take the keys it knows,
  // ignore the rest. Deliberately NOT the platform parser.
  function thirdPartyReadsStatement(content: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return fields;
  }

  function thirdPartyVerifies(content: string): boolean {
    const fields = thirdPartyReadsStatement(content);
    const did = fields['did'];
    const account = fields['github'];
    const sig = fields['signature'];
    if (fields['version'] !== '1') return false;
    if (did === undefined || account === undefined || sig === undefined) return false;
    // Rebuilt from the DID and account being checked, not from the file.
    const bytes = `freeagents-github-proof v1\n${did}\n${account}\n`;
    return nodeCrypto.verify(null, Buffer.from(bytes, 'utf8'), agentKeys.publicKey, Buffer.from(sig, 'base64'));
  }

  it('the platform decision (parse, bind-check, signature) holds for the gist', () => {
    const content = gist.files['proof.txt'];
    if (content === undefined) throw new Error('fixture is missing the statement file');
    const parsed = parseGistStatement(content);
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error('statement failed to parse');
    expect(statementBindsBinding(parsed, AGENT_DID, HANDLE)).toBe(true);
    const checksOut = nodeCrypto.verify(
      null,
      Buffer.from(gistProofPayload(AGENT_DID, agentUrl), 'utf8'),
      agentKeys.publicKey,
      Buffer.from(parsed.signature, 'base64'),
    );
    expect(checksOut).toBe(true);
  });

  it('a third party verifies the same gist with its own reader and primitives', () => {
    const content = gist.files['proof.txt'];
    if (content === undefined) throw new Error('fixture is missing the statement file');
    expect(thirdPartyVerifies(content)).toBe(true);
  });

  it('tampering any byte the signature covers breaks verification', () => {
    const tampered =
      [
        'signature: ' + signature,
        `GITHUB: ${agentUrl}`,
        `did: did:abt:zSomeOtherAgentKeyHashFixture`,
        'Version: 1',
      ].join('\n');
    expect(thirdPartyVerifies(tampered)).toBe(false);
    const parsed = parseGistStatement(tampered);
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error('statement failed to parse');
    expect(statementBindsBinding(parsed, AGENT_DID, HANDLE)).toBe(false);
  });

  it('the platform and the third party agree on every statement they meet', () => {
    const cases: Array<[string, string]> = [
      ['the valid statement', statement],
      ['the tampered statement', statement.replace(AGENT_DID, 'did:abt:zSomeOtherAgentKeyHashFixture')],
      ['a v2 statement', statement.replace('Version: 1', 'Version: 2')],
      ['a statement without the signature', 'version: 1\ndid: ' + AGENT_DID + '\ngithub: ' + agentUrl + '\n'],
      // Undecodable garbage in the signature field: a third party's standard
      // primitive rejects it without throwing, and the platform's decode gate
      // must reach the same conclusion (issue #45: a 409, not an outage).
      ['a malformed signature', statement.replace(/signature: .*/, 'signature: @@@@')],
      ['an empty file', ''],
    ];
    for (const [label, content] of cases) {
      const parsed = parseGistStatement(content);
      const platform =
        parsed !== null &&
        statementBindsBinding(parsed, AGENT_DID, HANDLE) &&
        signatureIsWellFormed(parsed.signature) &&
        nodeCrypto.verify(
          null,
          Buffer.from(gistProofPayload(AGENT_DID, agentUrl), 'utf8'),
          agentKeys.publicKey,
          Buffer.from(parsed.signature, 'base64'),
        );
      expect(thirdPartyVerifies(content), label).toBe(platform);
    }
  });
});
