// In-memory OperatorRepository: real storage for dev and tests, and the selected
// mode when DATABASE_URL is unset (see storage.ts). A Map keyed by DID gives the
// same duplicate-key semantics the database gives through its primary key.
import type { Operator } from '../../domain/operator.js';
import {
  OperatorAlreadyExistsError,
  type OperatorRepository,
} from './types.js';

export class MemoryOperatorRepository implements OperatorRepository {
  private readonly rows = new Map<string, Operator>();

  async register(input: {
    readonly did: string;
    readonly githubLogin: string;
  }): Promise<Operator> {
    // Check-then-set is safe here: Node is single-threaded and this method awaits
    // nothing, so two concurrent registers of one DID cannot both pass the check.
    if (this.rows.has(input.did)) {
      throw new OperatorAlreadyExistsError(input.did);
    }
    const row: Operator = {
      did: input.did,
      githubLogin: input.githubLogin,
      createdAt: new Date(),
    };
    this.rows.set(input.did, row);
    return row;
  }

  async findByDid(did: string): Promise<Operator | null> {
    return this.rows.get(did) ?? null;
  }
}
