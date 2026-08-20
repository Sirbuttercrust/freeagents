// Storage capability: persisting operator records the operator supplied
// (R-1). Named for the capability, not the backend, so a second driver
// (prisma) sits beside it without touching callers. Adapters may import
// domain; never the reverse (CLAUDE.md).
import type { Operator } from '../../domain/operator.js';

// Thrown by register when the DID already exists, so the API layer can map
// it to 409 without inspecting error messages.
export class OperatorAlreadyExistsError extends Error {
  constructor(did: string) {
    super(`operator ${did} already exists`);
    this.name = 'OperatorAlreadyExistsError';
  }
}

export interface OperatorRepository {
  // Throws OperatorAlreadyExistsError when the DID is already registered.
  register(input: { readonly did: string; readonly githubLogin: string }): Promise<Operator>;
  findByDid(did: string): Promise<Operator | null>;
}
