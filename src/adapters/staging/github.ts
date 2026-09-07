// B14b: the real StagingObserver. Built entirely on the GitHub REST API
// through the existing github adapter's client -- no clone, no checkout,
// no process spawn. The anchor this card exists to enforce: "the
// platform reports what git plainly says about the staged commit and
// never executes a line of the agent's code" (the operator, 2026-09-07:
// "I thought we were just an intermediary between the two parties").
//
// Read the docs before wiring: the compare endpoint
// (docs.github.com/en/rest/commits/commits#compare-two-commits) returns
// the changed files (path, status, additions, deletions, patch) and the
// commits between base and head, each carrying GitHub's own signature
// verification block
// (docs.github.com/en/rest/commits/commits#list-commits, the
// "Signature verification object" section, which the compare endpoint's
// commits array reuses verbatim). This file's own compareCommits caller
// is src/adapters/github/github.ts; that file owns the actual fetch.
//
// tests/architecture/no-execution.test.ts is the mechanical fence: it
// fails the build if this file (or anything else under
// src/adapters/staging/ or src/domain/attestation.ts) imports
// node:child_process, node:worker_threads, node:vm, or a package whose
// name matches /docker|sandbox|firecracker|isolated-vm/.
import { createHash } from 'node:crypto';

import type { GithubAdapter } from '../github/types.js';
import type { StagingObservation } from '../../domain/attestation.js';
import {
  addedLinesIntroduceSkipMarker,
  computeLineShareByCategory,
  isTestFilePath,
} from '../../domain/diff-classification.js';
import type { StagingObserveInput, StagingObserver } from './types.js';

// diffHash = sha256 over the sorted list of (path, patch) pairs, so a
// stranger holding the same compare response can recompute this exact
// hash without calling this service. Sorted by PATH (not by patch text,
// not by the order the compare response happened to list files in):
// path is the one field every file carries that is stable, unique within
// one comparison, and not itself part of the content being hashed --
// sorting by patch text would make two files with identical content but
// different names collide in sort position, and sorting is what removes
// GitHub's own response-ordering freedom from the hash input.
function computeDiffHash(files: readonly { readonly path: string; readonly patch: string | null }[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const canonical = JSON.stringify(sorted.map((file) => [file.path, file.patch]));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

// Wires the production default: an interface with only a fake is not a
// feature (the inert-declared-control class, B14). github is the same
// adapter instance createApp already threads through every other
// staging-lifecycle route, so this observer makes no second connection
// and honours the same token/owner configuration.
export function createGithubStagingObserver(github: GithubAdapter): StagingObserver {
  return {
    async observe(input: StagingObserveInput): Promise<StagingObservation> {
      // Invariant 1: reads only against the staging repository -- owner
      // and repo here are the STAGING repo the job's confirm route
      // created, never the buyer's own repository. compareCommits is a
      // single-repository comparison by construction (see its own type
      // comment), so there is no cross-repo call this method could make
      // even by mistake.
      const comparison = await github.compareCommits({
        owner: input.owner,
        repo: input.repo,
        base: input.baseCommit,
        head: input.stagedCommit,
      });

      const filesChanged = comparison.files.length;
      const linesAdded = comparison.files.reduce((sum, file) => sum + file.additions, 0);
      const linesRemoved = comparison.files.reduce((sum, file) => sum + file.deletions, 0);
      const changedPaths = comparison.files.map((file) => file.path);

      const lineShareByCategory = computeLineShareByCategory(
        comparison.files.map((file) => ({ path: file.path, linesChanged: file.additions + file.deletions })),
      );

      // Static facts about the diff text, never a test run: a removed
      // file whose path matches the test pattern, and an added file
      // (or added lines of an existing file) introducing a skip marker.
      const testsDeleted = comparison.files
        .filter((file) => file.status === 'removed' && isTestFilePath(file.path))
        .map((file) => file.path);
      const testsSkipAdded = comparison.files
        .filter((file) => isTestFilePath(file.path) && addedLinesIntroduceSkipMarker(file.patch))
        .map((file) => file.path);

      const criteriaPaths = new Set(input.criteriaPaths);
      const outOfCriteriaPathCount = changedPaths.filter((path) => !criteriaPaths.has(path)).length;

      // A signer matches the agent DID only when BOTH GitHub's own
      // cryptographic verification passed AND the commit's GitHub author
      // is the agent's verified login -- a verified-but-someone-else's
      // signature is not the agent's signature, and an unverified commit
      // from the right login is not a verified signer either.
      const commitSigners = comparison.commits.map((commit) => ({
        matchesAgentDid: commit.verified && commit.authorLogin === input.verifiedAgentGithubLogin,
      }));

      return {
        diffHash: computeDiffHash(comparison.files),
        filesChanged,
        linesAdded,
        linesRemoved,
        changedPaths,
        lineShareByCategory,
        testsDeleted,
        testsSkipAdded,
        outOfCriteriaPathCount,
        commitSigners,
      };
    },
  };
}
