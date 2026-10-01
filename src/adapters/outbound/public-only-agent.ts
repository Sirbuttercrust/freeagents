// FIX-SW4a (SW4-01 and SW4-08): the send-time half of the outbound
// rule. src/domain/outbound-destination.ts refuses an internal address
// typed into a URL; it cannot see a public NAME that resolves to an internal
// address, or whose DNS answer changes after the name was stored. This
// https.Agent closes that: its `lookup` resolves the host itself, with
// `all: true` so it sees every address the name answers, and refuses the
// whole connection when ANY of them is in the domain's refused ranges, before
// a socket is opened. The error names the host and carries no partial answer.
//
// Node calls an agent's lookup only for a host NAME, never for an IP
// literal, so a caller sending to a stored URL must still run
// isOutboundDestinationAllowed on it first (the webhook and push senders do).
//
// The resolver and the address rule are injectable for tests only;
// production uses dns.lookup and the domain's isRefusedAddress.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { Agent } from 'node:https';
import { isRefusedAddress as domainRefusesAddress } from '../../domain/outbound-destination.js';

export type OutboundResolver = (hostname: string, options: LookupOptions) => Promise<readonly LookupAddress[]>;

export interface PublicOnlyAgentOptions {
  readonly resolve?: OutboundResolver;
  readonly isRefusedAddress?: (address: string) => boolean;
}

const systemResolver: OutboundResolver = (hostname, options) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

type LookupCallback = (error: Error | null, addressOrList?: string | LookupAddress[], family?: number) => void;

export function createPublicOnlyAgent(options: PublicOnlyAgentOptions = {}): Agent {
  const resolve = options.resolve ?? systemResolver;
  const refuses = options.isRefusedAddress ?? domainRefusesAddress;

  function lookup(hostname: string, lookupOptions: LookupOptions, callback: LookupCallback): void {
    resolve(hostname, lookupOptions).then(
      (answers) => {
        if (answers.length === 0 || answers.some((answer) => refuses(answer.address))) {
          const refusal = new Error(`refusing to connect to ${hostname}: it resolves to an internal address`);
          (refusal as NodeJS.ErrnoException).code = 'EREFUSEDINTERNAL';
          callback(refusal);
          return;
        }
        if (lookupOptions.all === true) {
          callback(null, answers.map((answer) => ({ address: answer.address, family: answer.family })));
          return;
        }
        const first = answers[0] as LookupAddress;
        callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  return new Agent({ lookup: lookup as unknown as NonNullable<ConstructorParameters<typeof Agent>[0]>['lookup'] });
}
