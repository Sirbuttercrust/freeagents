// R-3, direction one (ENT-5): the agent's DID document carries an
// alsoKnownAs entry pointing at the agent's GitHub account. This is the
// behaviour test for the pure decision logic: it fails while
// src/domain/account-proof.ts does not exist and passes once it does.
import * as nodeCrypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  didDocumentPointsAtGithubAccount,
  gistProofPayload,
  githubAccountUrl,
  parseGistStatement,
  parseGistUrl,
  signatureIsWellFormed,
  statementBindsBinding,
  type GistStatement,
} from '../../src/domain/account-proof.js';

describe('githubAccountUrl', () => {
  it('builds the account URL from the handle', () => {
    expect(githubAccountUrl('scout-agent')).toBe('https://github.com/scout-agent');
  });
});

describe('signatureIsWellFormed', () => {
  // A real ed25519 signature, derived at run time from a real keypair over
  // the canonical payload: no memorized vectors anywhere in this block.
  const keys = nodeCrypto.generateKeyPairSync('ed25519');
  const genuineSignature = nodeCrypto
    .sign(
      null,
      Buffer.from(gistProofPayload('did:abt:zSigCheck', githubAccountUrl('scout-agent')), 'utf8'),
      keys.privateKey,
    )
    .toString('base64');

  it('accepts a genuine signature derived at run time', () => {
    expect(signatureIsWellFormed(genuineSignature)).toBe(true);
    // The documented shape, checked against the value just produced rather
    // than assumed: 88 characters with the canonical '==' padding.
    expect(genuineSignature.length).toBe(88);
    expect(genuineSignature.endsWith('==')).toBe(true);
  });

  it('accepts every signature the same primitive produces, across payloads', () => {
    // Property, not a single vector: whatever this machine signs must count
    // as well-formed, or correct operators would be locked out.
    for (const payload of ['a', 'b'.repeat(1000), gistProofPayload('did:abt:zX', githubAccountUrl('y'))]) {
      const signature = nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), keys.privateKey).toString('base64');
      expect(signatureIsWellFormed(signature), payload.slice(0, 10)).toBe(true);
    }
  });

  it('accepts the same signature unpadded', () => {
    expect(signatureIsWellFormed(genuineSignature.slice(0, -2))).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(signatureIsWellFormed('')).toBe(false);
  });

  it('rejects a non-string, never a throw', () => {
    const notAString = 42 as unknown as string;
    expect(signatureIsWellFormed(notAString)).toBe(false);
  });

  it('rejects a character outside base64, wherever it sits', () => {
    expect(signatureIsWellFormed('!!!!')).toBe(false);
    expect(signatureIsWellFormed(`${genuineSignature.slice(0, 40)}!${genuineSignature.slice(41)}`)).toBe(false);
    expect(signatureIsWellFormed('not a signature')).toBe(false);
  });

  it('rejects padding that is not at the end', () => {
    expect(signatureIsWellFormed(`${genuineSignature.slice(0, 40)}=${genuineSignature.slice(41)}`)).toBe(false);
  });

  it('rejects more than two padding characters', () => {
    expect(signatureIsWellFormed(`${genuineSignature.slice(0, -3)}===`)).toBe(false);
  });

  it('rejects a base64 body of an impossible length', () => {
    // 85 alphabet characters decode as 63 bytes and are not a legal padded
    // length; either way it is not an ed25519 signature.
    expect(signatureIsWellFormed('A'.repeat(85))).toBe(false);
  });

  it('rejects a decodable string that is not 64 bytes', () => {
    expect(signatureIsWellFormed('c2lnbmF0dXJl')).toBe(false); // decodes to 6 bytes
    expect(signatureIsWellFormed('A'.repeat(44))).toBe(false); // 33 bytes
    expect(signatureIsWellFormed('A'.repeat(88))).toBe(false); // 66 bytes
  });

  it('rejects a genuine signature truncated below 64 bytes', () => {
    expect(signatureIsWellFormed(genuineSignature.slice(0, 84))).toBe(false);
  });
});

describe('didDocumentPointsAtGithubAccount', () => {
  it('an exact match is true', () => {
    expect(
      didDocumentPointsAtGithubAccount(['https://github.com/scout-agent'], 'scout-agent'),
    ).toBe(true);
  });

  it('upper-case handle in the URL matches, case-insensitively', () => {
    expect(
      didDocumentPointsAtGithubAccount(['https://github.com/Scout-Agent'], 'scout-agent'),
    ).toBe(true);
  });

  it('one trailing slash is tolerated', () => {
    expect(
      didDocumentPointsAtGithubAccount(['https://github.com/scout-agent/'], 'scout-agent'),
    ).toBe(true);
  });

  it('surrounding whitespace on an entry is trimmed', () => {
    expect(
      didDocumentPointsAtGithubAccount(['  https://github.com/scout-agent  '], 'scout-agent'),
    ).toBe(true);
  });

  it('a wrong account among several entries is false', () => {
    expect(
      didDocumentPointsAtGithubAccount(
        ['https://example.com', 'https://github.com/other-account', 'mailto:scout@example.com'],
        'scout-agent',
      ),
    ).toBe(false);
  });

  it('the claimed account is true when it appears among unrelated entries', () => {
    expect(
      didDocumentPointsAtGithubAccount(
        ['https://example.com', 'https://github.com/scout-agent/'],
        'scout-agent',
      ),
    ).toBe(true);
  });

  it('null is false', () => {
    expect(didDocumentPointsAtGithubAccount(null, 'scout-agent')).toBe(false);
  });

  it('an empty array is false', () => {
    expect(didDocumentPointsAtGithubAccount([], 'scout-agent')).toBe(false);
  });

  it('an empty or whitespace handle is false', () => {
    expect(didDocumentPointsAtGithubAccount(['https://github.com/scout-agent'], '')).toBe(false);
    expect(didDocumentPointsAtGithubAccount(['https://github.com/scout-agent'], '   ')).toBe(false);
  });

  it('a non-null, non-array alsoKnownAs is false, never a throw', () => {
    // A half-built document can carry any value in the field: the guard must
    // turn it into "no" instead of letting .some throw on a non-array.
    const malformed = 'https://github.com/scout-agent' as unknown as readonly string[];
    expect(didDocumentPointsAtGithubAccount(malformed, 'scout-agent')).toBe(false);
  });

  it('a non-string handle is false, never a throw', () => {
    const handle = 42 as unknown as string;
    expect(
      didDocumentPointsAtGithubAccount(['https://github.com/scout-agent'], handle),
    ).toBe(false);
  });

  it('a non-string entry among the entries is skipped, never a throw', () => {
    // The non-string comes first, so .some reaches it before any match: a
    // deleted guard would call .trim() on it and throw instead of skipping.
    const entries = [42, 'https://github.com/scout-agent'] as unknown as readonly string[];
    expect(didDocumentPointsAtGithubAccount(entries, 'scout-agent')).toBe(true);
  });
});

describe('parseGistUrl', () => {
  it('parses the canonical form', () => {
    expect(parseGistUrl('https://gist.github.com/scout-agent/1a2b3c')).toEqual({
      owner: 'scout-agent',
      id: '1a2b3c',
    });
  });

  it('tolerates the http scheme', () => {
    expect(parseGistUrl('http://gist.github.com/scout-agent/1a2b3c')).toEqual({
      owner: 'scout-agent',
      id: '1a2b3c',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(parseGistUrl('https://gist.github.com/scout-agent/1a2b3c/')).toEqual({
      owner: 'scout-agent',
      id: '1a2b3c',
    });
  });

  it('rejects a different host', () => {
    expect(parseGistUrl('https://gist.example.com/scout-agent/1a2b3c')).toBeNull();
    expect(parseGistUrl('https://gistgithub.com/scout-agent/1a2b3c')).toBeNull();
  });

  it('rejects a subdomain of the right host', () => {
    expect(parseGistUrl('https://evil.gist.github.com/scout-agent/1a2b3c')).toBeNull();
  });

  it('rejects a missing id', () => {
    expect(parseGistUrl('https://gist.github.com/scout-agent')).toBeNull();
  });

  it('rejects an extra segment', () => {
    expect(parseGistUrl('https://gist.github.com/scout-agent/1a2b3c/extra')).toBeNull();
  });

  it('rejects a query string, a hash, and a non-default port', () => {
    expect(parseGistUrl('https://gist.github.com/scout-agent/1a2b3c?x=1')).toBeNull();
    expect(parseGistUrl('https://gist.github.com/scout-agent/1a2b3c#raw')).toBeNull();
    expect(parseGistUrl('https://gist.github.com:8443/scout-agent/1a2b3c')).toBeNull();
  });

  it('tolerates the scheme default port, which names the same endpoint', () => {
    // The URL parser normalizes :443 on https to the default port, so this is
    // the same resource, not a redirect to another host.
    expect(parseGistUrl('https://gist.github.com:443/scout-agent/1a2b3c')).toEqual({
      owner: 'scout-agent',
      id: '1a2b3c',
    });
  });

  it('rejects a non-gist scheme and unparseable input, never a throw', () => {
    expect(parseGistUrl('ftp://gist.github.com/scout-agent/1a2b3c')).toBeNull();
    expect(parseGistUrl('not a url at all')).toBeNull();
    expect(parseGistUrl('')).toBeNull();
    expect(parseGistUrl(42 as unknown as string)).toBeNull();
  });
});

describe('gistProofPayload', () => {
  it('is the canonical v1 bytes: marker, DID, account URL, LF endings, trailing LF', () => {
    // Property, not a memorized constant: the value is asserted line by line
    // against its own definition.
    const did = 'did:abt:zAgentKeyHash';
    const payload = gistProofPayload(did, githubAccountUrl('scout-agent'));
    expect(payload.split('\n')).toEqual([
      'freeagents-github-proof v1',
      did,
      'https://github.com/scout-agent',
      '',
    ]);
    // The trailing split element is empty exactly because of the trailing LF.
    expect(payload.endsWith('\n')).toBe(true);
    expect(payload).not.toContain('\r');
  });

  it('is deterministic in the input and sensitive to each field', () => {
    const a = gistProofPayload('did:abt:zOne', 'https://github.com/scout-agent');
    expect(gistProofPayload('did:abt:zOne', 'https://github.com/scout-agent')).toBe(a);
    expect(gistProofPayload('did:abt:zOther', 'https://github.com/scout-agent')).not.toBe(a);
    expect(gistProofPayload('did:abt:zOne', 'https://github.com/someone-else')).not.toBe(a);
  });
});

describe('parseGistStatement', () => {
  const base = [
    'FreeAgents GitHub proof',
    'version: 1',
    'did: did:abt:zAgentKeyHash',
    'github: https://github.com/scout-agent',
    'signature: c2lnbmF0dXJl',
  ].join('\n');

  it('parses the v1 statement, tolerating the human-readable header line', () => {
    expect(parseGistStatement(base)).toEqual({
      did: 'did:abt:zAgentKeyHash',
      github: 'https://github.com/scout-agent',
      signature: 'c2lnbmF0dXJl',
    });
  });

  it('tolerates CRLF line endings and surrounding whitespace', () => {
    const crlf = base
      .split('\n')
      .join('\r\n')
      .replace('version: 1', '  VERSION :   1  ')
      .replace('signature: c2lnbmF0dXJl', 'Signature: c2lnbmF0dXJl');
    expect(parseGistStatement(crlf)).toEqual({
      did: 'did:abt:zAgentKeyHash',
      github: 'https://github.com/scout-agent',
      signature: 'c2lnbmF0dXJl',
    });
  });

  it('tolerates extra lines', () => {
    const extra = `${base}\n\nsigned by the agent key, see the DID document\n`;
    expect(parseGistStatement(extra)?.signature).toBe('c2lnbmF0dXJl');
  });

  it('splits on the first colon only: a DID value keeps its colons', () => {
    expect(parseGistStatement(base)?.did).toBe('did:abt:zAgentKeyHash');
  });

  it.each([
    ['missing did', base.split('\n').filter((l) => !l.startsWith('did:')).join('\n')],
    ['missing github', base.split('\n').filter((l) => !l.startsWith('github:')).join('\n')],
    ['missing signature', base.split('\n').filter((l) => !l.startsWith('signature:')).join('\n')],
    ['missing version', base.split('\n').filter((l) => !l.startsWith('version:')).join('\n')],
    ['non-1 version', base.replace('version: 1', 'version: 2')],
    ['empty did value', base.replace('did: did:abt:zAgentKeyHash', 'did:')],
  ])('%s is null', (_label, content) => {
    expect(parseGistStatement(content)).toBeNull();
  });

  it('is null on empty and non-string input, never a throw', () => {
    expect(parseGistStatement('')).toBeNull();
    expect(parseGistStatement(42 as unknown as string)).toBeNull();
  });
});

describe('statementBindsBinding', () => {
  const statement: GistStatement = {
    did: 'did:abt:zAgentKeyHash',
    github: 'https://github.com/scout-agent',
    signature: 'c2lnbmF0dXJl',
  };

  it('binds the exact DID and account', () => {
    expect(statementBindsBinding(statement, 'did:abt:zAgentKeyHash', 'scout-agent')).toBe(true);
  });

  it('tolerates case and trailing slash on the account, like direction one', () => {
    expect(
      statementBindsBinding(
        { ...statement, github: 'https://github.com/Scout-Agent/' },
        'did:abt:zAgentKeyHash',
        'scout-agent',
      ),
    ).toBe(true);
  });

  it('rejects a different DID, exactly', () => {
    expect(
      statementBindsBinding({ ...statement, did: 'did:abt:zOtherKeyHash' }, 'did:abt:zAgentKeyHash', 'scout-agent'),
    ).toBe(false);
  });

  it('rejects a different account', () => {
    expect(
      statementBindsBinding(
        { ...statement, github: 'https://github.com/someone-else' },
        'did:abt:zAgentKeyHash',
        'scout-agent',
      ),
    ).toBe(false);
  });

  it('is false for a null or half-built statement, never a throw', () => {
    expect(statementBindsBinding(null, 'did:abt:zAgentKeyHash', 'scout-agent')).toBe(false);
    expect(statementBindsBinding({ did: 42, github: 'x', signature: 'y' } as unknown as GistStatement, 'd', 'h')).toBe(false);
  });
});
