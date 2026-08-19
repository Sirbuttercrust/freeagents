/**
 * Computes the evidence tier based on the input evidence
 * @param input - The evidence to evaluate
 * @returns The evidence tier: 'verified-hire' | 'verified-prior-work' | 'portfolio'
 */
export const evidenceTier = (input: any): 'verified-hire' | 'verified-prior-work' | 'portfolio' => {
  // Check for private repository work first - it should never be verified-hire
  if (input.type === 'hire' && input.merged === true && input.private === true) {
    // Private hires should not be verified-hire, return portfolio instead
    return 'portfolio';
  }
  
  // Check if it's a verified hire (job that ran through platform with merged pull request)
  if (input.type === 'hire' && input.merged === true) {
    return 'verified-hire';
  }
  
  // Check if it's verified prior work (signed commit with no brief on file)
  if (input.type === 'prior-work' && input.signed === true && input.brief === null) {
    return 'verified-prior-work';
  }
  
  // Check if it's portfolio (owner-submitted link or screenshot)
  if (input.type === 'portfolio' && (input.link || input.screenshot)) {
    return 'portfolio';
  }
  
  // Default case - should not happen with proper input validation
  throw new Error('Invalid evidence type for tier computation');
};