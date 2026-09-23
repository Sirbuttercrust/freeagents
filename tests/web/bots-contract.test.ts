// bots.js is plain browser JS, so it cannot import the domain module it must
// agree with. This file is where the two copies meet: it runs bots.js in a
// bare vm context (no window, no canvas) and pins every fact the client holds
// a copy of to the server's own export.
//
//   the three fixed sets, in order     defaultAvatar indexes by position
//   the twelve colour values and names DESIGN.md 2.4 points here
//   defaultAvatar for many DIDs        a page with no spec draws the DID
//                                      default; it must be the server's
//   resolve()                          a malformed spec never reaches paint
//   stateForJob                        "working" is exactly inProgress
//   hash                               the identity banner hue, kept
//                                      byte for byte from the prototype
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  AVATAR_COLOURS,
  AVATAR_COLOUR_NAMES,
  AVATAR_FACES,
  AVATAR_SHAPES,
  defaultAvatar,
} from '../../src/domain/avatar-spec.js';
import { ALL_JOB_STATUSES, jobListBucketOf } from '../../src/domain/job-list.js';

const here = dirname(fileURLToPath(import.meta.url));
const botsPath = join(here, '../../src/web/public/js/bots.js');
const prototypeSwarm = join(here, '../../spec/wireframe/swarm.js');

interface Spec { shape: string; face: string; colour: string }
interface FABots {
  SHAPES: string[];
  FACES: string[];
  COLOURS: Record<string, string>;
  COLOUR_NAMES: Record<string, string>;
  COLOUR_KEYS: string[];
  defaultAvatar(did: string): Spec;
  resolve(spec: unknown, did: string): Spec;
  stateForJob(status: unknown): string;
  hash(s: string): number;
  mount(host: unknown, did: unknown, opts?: unknown): Spec | null;
}

// A context with nothing a browser would add. bots.js must load here without
// throwing: it is also what the web tests' jsdom sees, which has no canvas.
function load(file: string, name: string): unknown {
  const sandbox: Record<string, unknown> = { TextEncoder, Math, Uint8Array };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox[name];
}

const B = load(botsPath, 'FABots') as FABots;

// Deterministic DIDs: enough of them that every shape, face and colour is
// reached, so a slip in any index shows.
const DIDS = Array.from({ length: 600 }, (_, i) => `did:abt:z${(i * 7919).toString(36)}-agent-${i}`);

describe('bots.js agrees with src/domain/avatar-spec.ts', () => {
  it('loads in a bare context and defines window.FABots', () => {
    expect(B).toBeTruthy();
    expect(typeof B.mount).toBe('function');
  });

  it('holds the same three fixed sets, in the same order', () => {
    expect(B.SHAPES).toEqual([...AVATAR_SHAPES]);
    expect(B.FACES).toEqual([...AVATAR_FACES]);
    expect(B.COLOUR_KEYS).toEqual(Object.keys(AVATAR_COLOURS));
  });

  it('holds the same twelve colour values and names', () => {
    expect({ ...B.COLOURS }).toEqual({ ...AVATAR_COLOURS });
    expect({ ...B.COLOUR_NAMES }).toEqual({ ...AVATAR_COLOUR_NAMES });
  });

  it('derives the same default as the server for every DID, and reaches every value', () => {
    const seen = { shape: new Set<string>(), face: new Set<string>(), colour: new Set<string>() };
    for (const did of DIDS) {
      const client = B.defaultAvatar(did);
      expect({ ...client }, did).toEqual(defaultAvatar(did));
      seen.shape.add(client.shape);
      seen.face.add(client.face);
      seen.colour.add(client.colour);
    }
    // Positive control: a derivation stuck on one value would agree with a
    // server stuck the same way. It must reach the whole of every set.
    expect(seen.shape.size).toBe(AVATAR_SHAPES.length);
    expect(seen.face.size).toBe(AVATAR_FACES.length);
    expect(seen.colour.size).toBe(Object.keys(AVATAR_COLOURS).length);
  });

  it('agrees on DIDs outside plain ASCII, where a UTF-8 slip would show', () => {
    for (const did of ['did:abt:zé', 'did:abt:z\u{1F916}', 'did:web:example.com:用户']) {
      expect({ ...B.defaultAvatar(did) }, did).toEqual(defaultAvatar(did));
    }
  });

  it('resolve() keeps a well-formed spec and replaces anything else with the DID default', () => {
    const did = 'did:abt:zresolve-fixture';
    const good = { shape: 'cat', face: 'mouth', colour: 'c9' };
    expect({ ...B.resolve(good, did) }).toEqual(good);
    const bad: unknown[] = [
      null, undefined, 'cat', {}, { ...good, shape: 'dragon' }, { ...good, face: 'nose' },
      { ...good, colour: '#FF0000' }, { ...good, colour: 'c13' }, { ...good, colour: 'c0' },
    ];
    for (const spec of bad) expect({ ...B.resolve(spec, did) }, JSON.stringify(spec)).toEqual(defaultAvatar(did));
  });

  it('mount() with no host or no DID mounts nothing', () => {
    expect(B.mount(null, 'did:abt:x')).toBeNull();
    expect(B.mount({}, '')).toBeNull();
    expect(B.mount({}, undefined)).toBeNull();
  });
});

describe('the working state is exactly the inProgress bucket', () => {
  it('every status the domain declares maps to working iff jobListBucketOf says inProgress', () => {
    const working = ALL_JOB_STATUSES.filter((s) => B.stateForJob(s) === 'working');
    expect(working.length, 'no status works, so the mapping is not being exercised').toBeGreaterThan(0);
    for (const status of ALL_JOB_STATUSES) {
      const want = jobListBucketOf(status) === 'inProgress' ? 'working' : 'default';
      expect(B.stateForJob(status), status).toBe(want);
    }
  });

  it('anything that is not a known status rests', () => {
    for (const s of [undefined, null, '', 'CONFIRMED', 'working', 42]) expect(B.stateForJob(s)).toBe('default');
  });
});

describe('the identity banner hue did not move', () => {
  it('FABots.hash is the prototype swarm.js FNV-1a, value for value', () => {
    const core = load(prototypeSwarm, 'FACore') as { hash(s: string): number } | undefined;
    expect(core && typeof core.hash, 'the prototype no longer exposes FACore.hash').toBe('function');
    for (const did of DIDS) expect(B.hash(did), did).toBe(core!.hash(did));
  });
});
