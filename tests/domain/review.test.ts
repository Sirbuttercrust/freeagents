import { describe, expect, it } from 'vitest';
import { isValidRating } from '../../src/domain/review.js';

describe('isValidRating', () => {
  it('accepts whole numbers from 1 to 5', () => {
    expect(isValidRating(1)).toBe(true);
    expect(isValidRating(5)).toBe(true);
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(isValidRating(0)).toBe(false);
    expect(isValidRating(6)).toBe(false);
    expect(isValidRating(3.5)).toBe(false);
  });
});
