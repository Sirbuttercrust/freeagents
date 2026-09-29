import { createHash } from 'node:crypto';

// FIX-B58: the work-history extension block (spec/work-history-extension-v1.md).
// The owner pastes it into the agent's own A2A card. FreeAgents does not serve
// a whole card: a card needs the address where the agent answers A2A calls,
// which only the agent has (MAP.md, B58 ruling).

export const WORK_HISTORY_EXTENSION_URI = 'https://freeagents.dev/ext/work-history/v1';
export const WORK_HISTORY_EXTENSION_DESCRIPTION = 'Verifiable identity and completed-work history';

export interface WorkHistoryAgent {
  readonly did: string;
  readonly operatorDid: string;
  readonly delegation: unknown;
  readonly githubLogin: string | null;
  readonly proofStatus: 'unverified' | 'verified';
}

// The two facts of a completed-hire credential the block summarises. The
// caller passes only completed hires (credentialEvidenceOf in the API layer),
// so a deemed-completion document never reaches this function.
export interface WorkHistoryCredential {
  readonly credentialId: string;
  readonly mergedAt: string;
}

export interface WorkHistoryExtensionBlock {
  readonly uri: string;
  readonly description: string;
  readonly required: false;
  readonly params: {
    readonly subject: string;
    readonly operator: string;
    readonly delegation: unknown;
    readonly accounts: readonly { readonly platform: 'github'; readonly handle: string; readonly proofStatus: 'unverified' | 'verified' }[];
    readonly credentials: {
      readonly endpoint: string;
      readonly count: number;
      readonly since: string | null;
      readonly digest: string;
    };
    readonly attestedBy: string;
  };
}

// sha256- plus lowercase hex of the credential ids, sorted and joined with a
// line feed (the empty string when there are none), so a client sees a
// changed set without downloading it.
export function credentialSetDigest(credentialIds: readonly string[]): string {
  const joined = [...credentialIds].sort().join('\n');
  return `sha256-${createHash('sha256').update(joined).digest('hex')}`;
}

// Timestamps are ISO 8601 UTC strings, so the lexicographic minimum is the
// earliest instant.
function earliest(timestamps: readonly string[]): string | null {
  let first: string | null = null;
  for (const t of timestamps) {
    if (first === null || t < first) first = t;
  }
  return first;
}

export function buildWorkHistoryExtension(input: {
  readonly agent: WorkHistoryAgent;
  readonly credentials: readonly WorkHistoryCredential[];
  readonly publicBaseUrl: string;
  readonly attestedBy: string;
}): WorkHistoryExtensionBlock {
  const { agent, credentials } = input;
  return {
    uri: WORK_HISTORY_EXTENSION_URI,
    description: WORK_HISTORY_EXTENSION_DESCRIPTION,
    required: false,
    params: {
      subject: agent.did,
      operator: agent.operatorDid,
      // Verbatim: a stranger verifies the delegation from the block alone.
      delegation: agent.delegation,
      accounts:
        agent.githubLogin === null
          ? []
          : [{ platform: 'github', handle: agent.githubLogin, proofStatus: agent.proofStatus }],
      credentials: {
        endpoint: `${input.publicBaseUrl}/agents/${encodeURIComponent(agent.did)}/credentials`,
        count: credentials.length,
        since: earliest(credentials.map((c) => c.mergedAt)),
        digest: credentialSetDigest(credentials.map((c) => c.credentialId)),
      },
      attestedBy: input.attestedBy,
    },
  };
}
