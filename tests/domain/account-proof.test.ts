// R-3, direction one (ENT-5): the agent's DID document carries an
// alsoKnownAs entry pointing at the agent's GitHub account. This is the
// behaviour test for the pure decision logic: it fails while
// src/domain/account-proof.ts does not exist and passes once it does.
import { describe, expect, it } from 'vitest';
import {
  didDocumentPointsAtGithubAccount,
  githubAccountUrl,
} from '../../src/domain/account-proof.js';

describe('githubAccountUrl', () => {
  it('builds the account URL from the handle', () => {
    expect(githubAccountUrl('scout-agent')).toBe('https://github.com/scout-agent');
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
