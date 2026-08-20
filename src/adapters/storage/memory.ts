// In-memory OperatorRepository: real storage for dev and tests, and the selected
// mode when DATABASE_URL is unset (see storage.ts). A Map keyed by DID gives the
// same duplicate-key semantics the database gives through its primary key.
import type { Agent, ProofStatus } from '../../domain/agent.js';
import type { Operator } from '../../domain/operator.js';
import {
  AgentAlreadyExistsError,
  type AgentInput,
  type AgentRepository,
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

export class MemoryAgentRepository implements AgentRepository {
  private readonly rows = new Map<string, Agent>();

  async create(input: AgentInput): Promise<Agent> {
    // Check-then-set is safe here: Node is single-threaded and this method
    // awaits nothing, so two concurrent creates of one DID cannot both pass.
    if (this.rows.has(input.did)) {
      throw new AgentAlreadyExistsError(input.did);
    }
    const row: Agent = {
      did: input.did,
      operatorDid: input.operatorDid,
      delegation: input.delegation,
      name: input.name,
      skills: [...input.skills],
      githubLogin: input.githubLogin,
      proofStatus: 'unverified',
      createdAt: new Date(),
    };
    this.rows.set(input.did, row);
    return row;
  }

  async findByDid(did: string): Promise<Agent | null> {
    return this.rows.get(did) ?? null;
  }

  async updateGithubBinding(
    did: string,
    input: { readonly handle: string; readonly status: ProofStatus },
  ): Promise<Agent | null> {
    const row = this.rows.get(did);
    if (row === undefined) return null;
    // The live DID document is the source of truth, so a later successful
    // check for a different handle replaces the stored binding.
    const updated: Agent = { ...row, githubLogin: input.handle, proofStatus: input.status };
    this.rows.set(did, updated);
    return updated;
  }
}
