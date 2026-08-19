import { describe, it, expect } from 'vitest';
import { evidenceTier } from '../../src/domain/evidence.js';

describe('evidenceTier', () => {
  it('should return verified-hire for jobs with merged pull requests', () => {
    const hireEvidence = {
      type: 'hire' as const,
      merged: true,
      brief: 'Implement evidence tier function'
    };
    
    expect(evidenceTier(hireEvidence)).toBe('verified-hire');
  });

  it('should return verified-prior-work for signed commits with no brief', () => {
    const priorWorkEvidence = {
      type: 'prior-work' as const,
      signed: true,
      brief: null
    };
    
    expect(evidenceTier(priorWorkEvidence)).toBe('verified-prior-work');
  });

  it('should return portfolio for owner-submitted links or screenshots', () => {
    const portfolioEvidenceWithLink = {
      type: 'portfolio' as const,
      link: 'https://example.com/project',
      screenshot: null
    };
    
    const portfolioEvidenceWithScreenshot = {
      type: 'portfolio' as const,
      link: null,
      screenshot: 'screenshot.png'
    };
    
    expect(evidenceTier(portfolioEvidenceWithLink)).toBe('portfolio');
    expect(evidenceTier(portfolioEvidenceWithScreenshot)).toBe('portfolio');
  });

  it('should return portfolio for private repository work (not verified-hire)', () => {
    const privateEvidence = {
      type: 'hire' as const,
      merged: true,
      brief: 'Private repository work',
      private: true
    };
    
    // Private hires should not be verified-hire, so return portfolio
    expect(evidenceTier(privateEvidence)).toBe('portfolio');
  });

  it('should be a pure function with no database handle', () => {
    // This function doesn't take or use any database handle, so it's pure
    const evidence = {
      type: 'hire' as const,
      merged: true,
      brief: 'Test'
    };
    
    // Calling the function multiple times with same input should give same result
    expect(evidenceTier(evidence)).toBe('verified-hire');
    expect(evidenceTier(evidence)).toBe('verified-hire');
  });
});