// R-37 (spec/roadmap.md, ENT-2, ENT-4): freshness as a visible fact about
// the record, never a judgement of the agent (the card's anchor). Both
// dates are derived at read time from stored facts, mirroring
// agent-work-record.ts's own stance: never a stored denormalised column
// that could drift from what it summarises.
import { describe, expect, it } from 'vitest';
import { lastHireCompletedAt, recordLastChangedAt } from '../../src/domain/freshness.js';

describe('lastHireCompletedAt', () => {
  it('an agent with no completed hire has no last-hire date (ENT-2.4, honest null)', () => {
    expect(lastHireCompletedAt([])).toBeNull();
  });

  it('a single completed hire is its own last-hire date', () => {
    expect(lastHireCompletedAt([{ completedAt: new Date('2026-01-03T00:00:00.000Z') }])).toBe(
      '2026-01-03T00:00:00.000Z',
    );
  });

  it('the MOST RECENT completed hire wins, regardless of array order', () => {
    const hires = [
      { completedAt: new Date('2026-01-05T00:00:00.000Z') },
      { completedAt: new Date('2026-03-09T00:00:00.000Z') },
      { completedAt: new Date('2026-02-02T00:00:00.000Z') },
    ];
    expect(lastHireCompletedAt(hires)).toBe('2026-03-09T00:00:00.000Z');
  });

  it('accepts an ISO string just as well as a Date, since both drivers hand back different shapes', () => {
    expect(lastHireCompletedAt([{ completedAt: '2026-01-03T00:00:00.000Z' }])).toBe('2026-01-03T00:00:00.000Z');
  });

  it('an unparseable completedAt is skipped, not thrown, and does not win over a real date', () => {
    const hires = [{ completedAt: 'not-a-date' }, { completedAt: '2026-01-03T00:00:00.000Z' }];
    expect(lastHireCompletedAt(hires)).toBe('2026-01-03T00:00:00.000Z');
  });
});

describe('recordLastChangedAt', () => {
  it('a fresh agent with no hires and no rotations changed when it was created (never null)', () => {
    const agent = { createdAt: new Date('2026-01-01T00:00:00.000Z'), keyRotations: [] };
    expect(recordLastChangedAt(agent, [])).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a completed hire after creation moves the record-changed date forward', () => {
    const agent = { createdAt: new Date('2026-01-01T00:00:00.000Z'), keyRotations: [] };
    const hires = [{ completedAt: new Date('2026-06-01T00:00:00.000Z') }];
    expect(recordLastChangedAt(agent, hires)).toBe('2026-06-01T00:00:00.000Z');
  });

  it('a key rotation after the last hire moves the record-changed date forward again', () => {
    const agent = {
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      keyRotations: [{ rotatedAt: new Date('2026-08-01T00:00:00.000Z') }],
    };
    const hires = [{ completedAt: new Date('2026-06-01T00:00:00.000Z') }];
    expect(recordLastChangedAt(agent, hires)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('never regresses behind creation: a hire or rotation before createdAt does not move it earlier', () => {
    const agent = {
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      keyRotations: [{ rotatedAt: new Date('2026-01-01T00:00:00.000Z') }],
    };
    const hires = [{ completedAt: new Date('2026-02-01T00:00:00.000Z') }];
    expect(recordLastChangedAt(agent, hires)).toBe('2026-06-01T00:00:00.000Z');
  });
});
