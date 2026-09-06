import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildConfigReport } from '../../src/adapters/config/report.js';

// Invariant 10 (MISSION.md), P9 scope item 4: blocklet.yml, .env.example and
// the configuration report must agree on which FREEAGENTS_* (plus
// DATABASE_URL) variables exist. A variable added to one and missing from
// another is the drift this test exists to catch.
//
// Same line-scanner approach as blocklet-packaging.test.ts, and for the
// same reason: no YAML dependency exists in this package and none is being
// added for packaging alone (see that file's own top-of-file note before
// changing this scanner). blocklet.yml's flat top-level shape (every key
// starts at column 0, `name:` lines under `environments:` indented by two
// spaces) is load bearing here exactly as it is there.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const manifestPath = join(repoRoot, 'blocklet.yml');
const envExamplePath = join(repoRoot, '.env.example');

function topLevelBlock(source: string, key: string): string {
  const lines = source.split('\n');
  const startPattern = new RegExp(`^${key}:[ \\t]*$`);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start === -1) return '';
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^[A-Za-z]/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function manifestEnvVarNames(manifest: string): Set<string> {
  const block = topLevelBlock(manifest, 'environments');
  return new Set([...block.matchAll(/name:[ \t]*([A-Z0-9_]+)/g)].map((m) => m[1] as string));
}

// .env.example lines are `NAME=value` or `NAME=`; comments and blanks are
// skipped. This deliberately does not care about the value, only the name,
// since the file's whole purpose is generic placeholders.
function envExampleVarNames(envExample: string): Set<string> {
  const names = new Set<string>();
  for (const line of envExample.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

describe('blocklet.yml and .env.example stay in agreement', () => {
  const manifest = readFileSync(manifestPath, 'utf8');
  const envExample = readFileSync(envExamplePath, 'utf8');
  const manifestVars = manifestEnvVarNames(manifest);
  const envExampleVars = envExampleVarNames(envExample);

  // PORT is not part of this agreement: blocklet.yml binds the listen port
  // through BLOCKLET_PORT in the interfaces: block (runtime.ts, invariant 9),
  // never through environments:. PORT only matters when running outside
  // Blocklet Server (README's `npm run dev`), so .env.example documents it
  // and blocklet.yml correctly does not.
  const PORT_EXEMPT = new Set(['PORT']);

  it('declares in blocklet.yml every variable listed in .env.example', () => {
    const undeclared = [...envExampleVars].filter((name) => !manifestVars.has(name) && !PORT_EXEMPT.has(name)).sort();
    expect(undeclared, '.env.example lists a variable blocklet.yml does not declare').toEqual([]);
  });

  it('lists in .env.example every variable declared in blocklet.yml', () => {
    const unlisted = [...manifestVars].filter((name) => !envExampleVars.has(name)).sort();
    expect(unlisted, 'blocklet.yml declares a variable .env.example does not list').toEqual([]);
  });
});

describe('the configuration report only checks variables the manifest declares', () => {
  it('every variable named in a capability report is declared in blocklet.yml', () => {
    const manifest = readFileSync(manifestPath, 'utf8');
    const manifestVars = manifestEnvVarNames(manifest);

    // Force every capability to report as missing, so `missing` names every
    // variable the report module checks for that capability.
    const report = buildConfigReport({});
    const checkedVars = report.capabilities.flatMap((cap) => cap.missing);
    const undeclared = checkedVars.filter((name) => !manifestVars.has(name));
    expect(undeclared, 'the configuration report checks a variable blocklet.yml does not declare').toEqual([]);
  });
});
