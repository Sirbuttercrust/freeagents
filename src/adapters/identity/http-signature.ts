// HTTP Message Signature (RFC 9421) verification for DID-authenticated
// requests. R-34, seeded by hand 2026-08-23 (Phase-0 rule: auth is on the
// irreversible list, so a human writes this stub and its failing test; the
// factory implements verify() against @arcblock/did).
//
// Contract:
//   verify(req, keyResolver) -> { did } | null
//   - reads Signature-Input / Signature headers (RFC 9421 field names)
//   - covers @method, @target-uri, content-digest when present
//   - resolves the signing key through keyResolver(did) and verifies the
//     ed25519 signature WITHOUT calling any vendor package from src/api/
//
// NOT IMPLEMENTED YET on purpose: the failing test names exactly what must
// exist before this file may pass.
export interface SigningKeyResolver {
  (did: string): Promise<{ publicKeyPem: string } | null>;
}

export async function verify(
  _headers: Record<string, string | string[] | undefined>,
  _keyResolver: SigningKeyResolver,
): Promise<{ did: string } | null> {
  throw new Error('NOT IMPLEMENTED: see tests/api/did-signature.test.ts');
}
