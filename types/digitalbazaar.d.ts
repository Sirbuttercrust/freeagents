// Ambient declarations for @digitalbazaar packages that ship no types.
// These packages use BSD-3-Clause license and are the standard W3C VC
// verification stack that proves invariant 2 (third-party verification).

declare module '@digitalbazaar/ed25519-verification-key-2020' {
  export class Ed25519VerificationKey2020 {
    id: string;
    controller: string;
    publicKeyMultibase?: string;
    static generate(options: { seed: Uint8Array; controller: string }): Promise<Ed25519VerificationKey2020>;
    static fromFingerprint(options: { fingerprint: string }): Promise<Ed25519VerificationKey2020>;
    export(options: { publicKey: boolean }): {
      id: string;
      type: string;
      controller: string;
      publicKeyMultibase: string;
    };
  }
}

declare module '@digitalbazaar/ed25519-signature-2020' {
  import type { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
  export class Ed25519Signature2020 {
    constructor(options?: { key?: Ed25519VerificationKey2020 });
  }
}

declare module '@digitalbazaar/vc' {
  export function issue(options: {
    credential: unknown;
    suite: unknown;
    documentLoader: (url: string) => Promise<{ document: unknown }>;
  }): Promise<Record<string, unknown>>;

  export function verifyCredential(options: {
    credential: unknown;
    suite: unknown;
    documentLoader: (url: string) => Promise<{ document: unknown }>;
  }): Promise<{ verified: boolean }>;
}

declare module '@digitalbazaar/security-document-loader' {
  export function securityLoader(): {
    addStatic(url: string, document: Record<string, unknown>): void;
    build(): (url: string) => Promise<{ document: unknown }>;
  };
}
