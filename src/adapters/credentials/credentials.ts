import { NotImplementedError } from '../not-implemented.js';
import type { CredentialsAdapter, VerifiableCredential, WorkHistoryClaim } from './types.js';

const CAPABILITY = 'credentials';

// Real implementation is @arcblock/vc behind this factory.
export function createCredentialsAdapter(): CredentialsAdapter {
  return {
    issueWorkHistoryCredential(_subjectDid: string, _claim: WorkHistoryClaim): Promise<VerifiableCredential> {
      throw new NotImplementedError(CAPABILITY, 'issueWorkHistoryCredential');
    },
    verifyCredential(_credential: VerifiableCredential): Promise<boolean> {
      throw new NotImplementedError(CAPABILITY, 'verifyCredential');
    },
    getCredential(_credentialId: string): Promise<VerifiableCredential> {
      throw new NotImplementedError(CAPABILITY, 'getCredential');
    },
  };
}
