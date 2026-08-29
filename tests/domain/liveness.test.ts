import { describe, expect, it } from 'vitest';
import {
  DORMANT_AFTER_DAYS,
  lastObservedAt,
  livenessStatus,
  profileLiveness,
  QUIET_AFTER_DAYS,
} from '../../src/domain/liveness.js';
import type { LivenessStatus, ObservedActivity } from '../../src/domain/liveness.js';

const STATUSES: readonly LivenessStatus[] = ['active', 'quiet', 'dormant'];

const NOW = new Date('2026-08-28T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function observed(overrides: Partial<ObservedActivity> = {}): ObservedActivity {
  return { lastCompletedHireAt: null, lastHireActivityAt: null, lastSignedRequestAt: null, ...overrides };
}

describe('livenessStatus', () => {
  // Thresholds (rule 2), driven off the exported constants.
  it('a completed hire today is active', () => {
    expect(livenessStatus(observed({ lastCompletedHireAt: NOW }), NOW)).toBe('active');
  });

  it('activity at exactly QUIET_AFTER_DAYS days is active (boundary; strictly greater than)', () => {
    const activity = observed({ lastHireActivityAt: daysAgo(QUIET_AFTER_DAYS) });
    expect(livenessStatus(activity, NOW)).toBe('active');
  });

  it('activity at QUIET_AFTER_DAYS + 1 days is quiet', () => {
    const activity = observed({ lastHireActivityAt: daysAgo(QUIET_AFTER_DAYS + 1) });
    expect(livenessStatus(activity, NOW)).toBe('quiet');
  });

  it('activity at exactly DORMANT_AFTER_DAYS days is quiet (boundary; strictly greater than)', () => {
    const activity = observed({ lastHireActivityAt: daysAgo(DORMANT_AFTER_DAYS) });
    expect(livenessStatus(activity, NOW)).toBe('quiet');
  });

  it('activity at DORMANT_AFTER_DAYS + 1 days is dormant', () => {
    const activity = observed({ lastHireActivityAt: daysAgo(DORMANT_AFTER_DAYS + 1) });
    expect(livenessStatus(activity, NOW)).toBe('dormant');
  });

  // Latest-wins (rule 1).
  it('a 200-day-old completed hire plus 2-day-old hire activity is active: the latest observed event wins', () => {
    const activity = observed({
      lastCompletedHireAt: daysAgo(200),
      lastHireActivityAt: daysAgo(2),
    });
    expect(livenessStatus(activity, NOW)).toBe('active');
  });

  it('lastSignedRequestAt alone, 5 days old, is active: a DID-signed interaction is an observed event in its own right', () => {
    const activity = observed({ lastSignedRequestAt: daysAgo(5) });
    expect(livenessStatus(activity, NOW)).toBe('active');
  });

  it('lastObservedAt returns the maximum of three populated instants', () => {
    const activity = observed({
      lastCompletedHireAt: daysAgo(200),
      lastHireActivityAt: daysAgo(2),
      lastSignedRequestAt: daysAgo(50),
    });
    expect(lastObservedAt(activity)).toEqual(daysAgo(2));
  });

  it('accepts ISO strings alongside Date, and ignores a garbage string rather than throwing', () => {
    const activity = observed({
      lastCompletedHireAt: daysAgo(2).toISOString(),
      lastHireActivityAt: 'not-a-date',
    });
    expect(lastObservedAt(activity)).toEqual(daysAgo(2));
    expect(livenessStatus(activity, NOW)).toBe('active');
  });

  // Empty and skewed (rules 3, 4, 9).
  it('no observed events at all is dormant, and profileLiveness(...).observedAt is null (ASSUMPTIONS LIVENESS_NO_OBSERVED_EVENTS)', () => {
    const activity = observed();
    expect(livenessStatus(activity, NOW)).toBe('dormant');
    expect(profileLiveness(activity, null, NOW).observedAt).toBeNull();
  });

  it('a future-dated observation is active, and does not throw', () => {
    const activity = observed({ lastHireActivityAt: new Date(NOW.getTime() + 10 * 86_400_000) });
    expect(() => livenessStatus(activity, NOW)).not.toThrow();
    expect(livenessStatus(activity, NOW)).toBe('active');
  });

  it('pins the threshold values themselves at 30 and 90 days, not just their relative boundaries', () => {
    expect(QUIET_AFTER_DAYS).toBe(30);
    expect(DORMANT_AFTER_DAYS).toBe(90);
  });

  it('an invalid Date (NaN) observed instant is ignored, not treated as a valid observed event', () => {
    const activity = observed({ lastHireActivityAt: new Date(NaN) });
    expect(lastObservedAt(activity)).toBeNull();
    expect(livenessStatus(activity, NOW)).toBe('dormant');
  });

  it('an unparseable `now` yields active, and does not throw, regardless of how old the activity is', () => {
    const activity = observed({ lastHireActivityAt: daysAgo(200) });
    expect(() => livenessStatus(activity, new Date(NaN))).not.toThrow();
    expect(livenessStatus(activity, new Date(NaN))).toBe('active');
  });

  it('is total: every input yields one of the closed set of statuses, and nothing throws', () => {
    const table: ObservedActivity[] = [
      observed(),
      observed({ lastCompletedHireAt: 'garbage' }),
      observed({ lastHireActivityAt: new Date(NaN) }),
      observed({ lastCompletedHireAt: NOW }),
      observed({ lastHireActivityAt: NOW }),
      observed({ lastSignedRequestAt: NOW }),
    ];
    for (const activity of table) {
      let result: LivenessStatus | undefined;
      expect(() => {
        result = livenessStatus(activity, NOW);
      }).not.toThrow();
      expect(STATUSES).toContain(result);
    }
  });
});

describe('profileLiveness - the self-reported tier (invariant 5)', () => {
  it('a verified check-in today on an agent whose last observed event is 200 days old never promotes status or observedAt', () => {
    const activity = observed({ lastCompletedHireAt: daysAgo(200) });
    const result = profileLiveness(activity, { checkedInAt: NOW, signatureVerified: true }, NOW);
    expect(result.status).toBe('dormant');
    expect(result.observedAt).toBe(daysAgo(200).toISOString());
    expect(result.selfReported).toEqual({ checkedInAt: NOW.toISOString(), tier: 'self-reported' });
  });

  it('an unverified check-in yields selfReported: null and leaves status unchanged', () => {
    const activity = observed({ lastCompletedHireAt: daysAgo(200) });
    const result = profileLiveness(activity, { checkedInAt: NOW, signatureVerified: false }, NOW);
    expect(result.selfReported).toBeNull();
    expect(result.status).toBe('dormant');
  });

  it('no check-in (null) yields selfReported: null', () => {
    const activity = observed({ lastCompletedHireAt: daysAgo(1) });
    const result = profileLiveness(activity, null, NOW);
    expect(result.selfReported).toBeNull();
  });

  it('a verified check-in with checkedInAt: null yields selfReported: null, not a fabricated epoch date', () => {
    const activity = observed({ lastCompletedHireAt: daysAgo(1) });
    const result = profileLiveness(activity, { checkedInAt: null, signatureVerified: true }, NOW);
    expect(result.selfReported).toBeNull();
  });

  it('a verified check-in with an unparseable checkedInAt yields selfReported: null', () => {
    const activity = observed({ lastCompletedHireAt: daysAgo(1) });
    const result = profileLiveness(activity, { checkedInAt: 'not-a-date', signatureVerified: true }, NOW);
    expect(result.selfReported).toBeNull();
  });

  it('ProfileLiveness carries exactly three keys: no score, no count, no delisted field', () => {
    const result = profileLiveness(observed(), null, NOW);
    expect(Object.keys(result).sort()).toEqual(['observedAt', 'selfReported', 'status']);
  });
});
