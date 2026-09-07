// P10: the ABT payment surface's DID Connect wallet-protocol test harness,
// shared by every test that needs to drive a real ABT payment end to end
// over HTTP (no unit test substitutes for this: every guard in the payment
// surface is a route guard). Extracted from tests/api/job-payment-abt.test.ts
// (P8d, Proof review round 1, D2) so tests/api/account-provisioning.test.ts
// can prove the custody fence at the payment boundary with the SAME harness,
// rather than a second copy that could quietly diverge.
//
// The working reference (qr-server.mjs, in the operator's payment
// wallet-test rig) is the only place this protocol sequence has been
// proved against a real mobile wallet; this file follows it exactly:
//   1. claims.prepareTx returns the rail's PrepareTxClaim VERBATIM. The
//      built-in WalletAuthenticator.prepareTx() (not this file's own
//      function of the same name) then base58/CBOR-encodes it via
//      txEncoder before it ever reaches the wallet -- this file never
//      re-encodes anything itself.
//   2. onAuth reads the echoed-back claim's `finalTx` (base58, exactly
//      what the wallet returns) and calls the rail's onWalletResponse,
//      then confirm, writing the settlement row only on confirmed: true.
import { createServer } from 'node:net';
import { fromRandom, type WalletObject } from '@ocap/wallet';
import { decode as jwtDecode, sign as jwtSign } from '@arcblock/jwt';
import { encodeTx as clientEncodeTx } from '@ocap/client/encode';
import { decodeTx as cborDecodeTx, encodeTx as cborEncodeTx } from '@ocap/message/cbor';
import { fromBase58, fromBase64, toBase58 } from '@ocap/util';
import type { AbtChainClient } from '../../src/adapters/payment/abt.js';
import type { AbtTxEncoder } from '../../src/adapters/payment/abt-did-connect.js';
import { signRequest, type SigningIdentity } from './sign-request.js';

export function abtEnv(
  baseUrl: string,
  platformWallet: WalletObject,
  token: string,
  feeAddress: string,
): Record<string, string> {
  return {
    FREEAGENTS_ABT_CHAIN_HOST: 'https://beta.abtnetwork.io/api',
    FREEAGENTS_ABT_PLATFORM_SK: platformWallet.secretKey,
    FREEAGENTS_ABT_TOKEN: token,
    FREEAGENTS_ABT_FEE_ADDRESS: feeAddress,
    // The DID Connect wallet callback URL is built from this (WalletAuthenticator's
    // own baseUrl), which is why it must resolve to the SAME server this
    // test's own fetch calls land on (review round 1, D1): a mismatch here
    // is exactly the defect that round found.
    FREEAGENTS_PUBLIC_BASE_URL: baseUrl,
  };
}

export async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

// Reserves a real ephemeral port on 127.0.0.1 and releases it immediately,
// so the app's own FREEAGENTS_PUBLIC_BASE_URL (baked in before createApp
// is called, since WalletAuthenticator reads it at construction) can name
// the exact address the app will bind to a moment later. There is a small
// window between this close() and the real listen() below where another
// process could claim the same port; acceptable for a test.
export async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('expected a port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

// A pure, no-network encoder (FACTORY_RULES.md: no network in the test
// suite): @ocap/client/encode's own encodeTx is already a pure function,
// this only pins a fixed chainId/feeConfig so no fetchContext call is
// ever reachable from this test.
export const pureTxEncoder: AbtTxEncoder = async ({ type, data, wallet, chainHost }) => {
  void chainHost;
  const { buffer } = clientEncodeTx({ type, tx: data as never, wallet: wallet as never, chainId: 'test-chain', feeConfig: [] });
  return buffer;
};

export function fakeAbtChainClient(confirmed = true): { client: AbtChainClient; sentTx: () => string | undefined; hash: string } {
  let sent: string | undefined;
  const hash = 'broadcast-hash-1';
  const client: AbtChainClient = {
    decodeTx: async (bytes) => cborDecodeTx(bytes),
    sendTx: async (input) => {
      sent = input.tx;
      return { hash };
    },
    // S2: getTx must answer THE CHAIN's own record of what this
    // transaction actually paid, read from the exact bytes that were
    // broadcast (sent), never invented -- confirm() binds against
    // outputs, so a fake that echoed back an empty list would make every
    // route-level test here fail confirm() for the wrong reason (no
    // outputs to bind against) rather than proving the real path.
    getTx: async () => {
      if (!confirmed || sent === undefined) {
        return { code: 'FAILED', outputs: [] };
      }
      const decoded = cborDecodeTx(fromBase64(sent)) as { itx: { outputs: readonly { owner: string; tokens: readonly { address: string; value: string }[] }[] } };
      return { code: 'OK', outputs: decoded.itx.outputs };
    },
    getAccountState: async () => ({ state: null }),
  };
  return { client, sentTx: () => sent, hash };
}

// Signs the JWT a real DID Wallet would produce for one DID Connect
// response step: iss/iat/nbf/exp/version come from JWT.sign itself; this
// only supplies the protocol fields (challenge, requestedClaims) the
// server's authenticator.verify() actually reads.
export async function walletResponseJwt(
  wallet: WalletObject,
  challenge: string,
  requestedClaims: readonly Record<string, unknown>[],
): Promise<string> {
  return jwtSign(
    wallet.address,
    wallet.secretKey,
    { action: 'responseAuth', challenge, requestedClaims },
    true,
    '1.1.0',
  );
}

// The wallet's own step: decode the partial tx it was asked to sign,
// add its own input and signature, re-encode. cborDecodeTx flattens the
// itx envelope (type/inputs/outputs at the top level, matching what
// abt.ts's own onWalletResponse decodes); cborEncodeTx's own input shape
// is the nested type/value envelope, exactly mirroring
// tests/adapters/payment/never-input-owner.test.ts's identical helper.
// `outputsOverride`, when supplied, replaces the outputs the partial tx
// itself named before signing -- simulating a MALICIOUS wallet that
// redirects a payment (review round 2, D1's own reproduction shape).
export async function walletSignsPartialTx(partialTxBase58: string, buyer: WalletObject, outputsOverride?: unknown): Promise<string> {
  const decoded = cborDecodeTx(fromBase58(partialTxBase58)) as Record<string, unknown>;
  const itx = decoded.itx as { readonly typeUrl: string; readonly outputs: unknown };
  const signed = {
    ...decoded,
    itx: {
      typeUrl: itx.typeUrl,
      inputs: [{ owner: buyer.address }],
      outputs: outputsOverride ?? itx.outputs,
    },
    signatures: [{ signer: buyer.address }],
  };
  const bytes = cborEncodeTx(signed as never);
  return toBase58(bytes);
}

export interface DidConnectClaimResponse {
  readonly appPk: string;
  readonly authInfo: string;
}

export function decodeClaimBody(response: DidConnectClaimResponse): {
  readonly challenge: string;
  readonly requestedClaims: readonly Record<string, unknown>[];
} {
  const body = jwtDecode(response.authInfo) as unknown as { challenge: string; requestedClaims: Record<string, unknown>[] };
  return { challenge: body.challenge, requestedClaims: body.requestedClaims };
}

export async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

export async function getSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri);
  return fetch(targetUri, {
    headers: {
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
  });
}

// Calls the buyer's own /start route (review round 1, D1: never a
// hard-coded /api/did/pay/token call) and decodes the wallet callback URL
// it hands back, exactly as a real DID Wallet would: the response's `url`
// field is the abtwallet.io deep link, and the callback address the
// wallet actually fetches is the `url` query parameter nested inside it
// (WalletAuthenticator.uri()'s own shape). `starter` may sign the request
// with either an RFC 9421 signature (SigningIdentity) or a live session
// header, matching /start's own "session or signature" gate (P8a).
export async function startAbtSession(
  baseUrl: string,
  starter: SigningIdentity | { readonly sessionHeader: Record<string, string> },
  params: { readonly jobId: string; readonly leg: 'deposit' | 'remainder' },
): Promise<{ readonly sessionToken: string; readonly authCallbackUrl: string }> {
  const path = `/jobs/${params.jobId}/payments/${params.leg}/abt/start`;
  const res =
    'sessionHeader' in starter
      ? await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...starter.sessionHeader },
          body: JSON.stringify({}),
        })
      : await postSigned(baseUrl, path, {}, starter);
  if (res.status !== 200) {
    throw new Error(`abt /start failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { readonly token: string; readonly url: string };
  const deepLink = new URL(body.url);
  // WalletAuthenticator.uri() (node_modules/@arcblock/did-connect-js/dist/
  // authenticator/wallet.js) builds this deep link by calling
  // encodeURIComponent on the callback URL itself, then passing the
  // whole payload object (including that already-encoded string) through
  // querystring.stringify, which encodes it a second time. URLSearchParams
  // decodes one layer (the qs.stringify layer); the encodeURIComponent
  // layer WalletAuthenticator itself added is still there afterward, so
  // this needs one more decode to get the real callback URL a wallet
  // would actually fetch.
  const encodedCallbackUrl = deepLink.searchParams.get('url');
  if (encodedCallbackUrl === null) {
    throw new Error('expected a wallet callback url inside the abt start response');
  }
  const authCallbackUrl = decodeURIComponent(encodedCallbackUrl);
  return { sessionToken: body.token, authCallbackUrl };
}

// Drives the full DID Connect wallet protocol for one payment leg,
// against the real HTTP routes, exactly the sequence a mobile wallet
// follows: start a session through the buyer's own route (never a
// hard-coded path), fetch the first claim (authPrincipal), answer it,
// receive the second claim (prepareTx), sign it, submit, read the final
// confirmed/error result. `starter` is whoever mints the session (either
// an RFC 9421 signing identity or a live session header; must be the
// job's buyer, or /start itself refuses); `wallet` is whoever completes
// the DID Connect steps, which may be a different DID, to prove onAuth's
// own buyerDid check.
export async function driveAbtPayment(
  baseUrl: string,
  starter: SigningIdentity | { readonly sessionHeader: Record<string, string> },
  wallet: WalletObject,
  params: { readonly jobId: string; readonly leg: 'deposit' | 'remainder' },
  outputsOverride?: unknown,
): Promise<{ readonly confirmed: boolean; readonly error?: string }> {
  const { sessionToken, authCallbackUrl } = await startAbtSession(baseUrl, starter, params);
  const authPath = new URL(authCallbackUrl).pathname;

  const step0Res = await fetch(authCallbackUrl);
  const step0Body = (await step0Res.json()) as DidConnectClaimResponse;
  const step0 = decodeClaimBody(step0Body);

  const step0SubmitRes = await fetch(`${baseUrl}${authPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _t_: sessionToken,
      userPk: wallet.publicKey,
      userInfo: await walletResponseJwt(wallet, step0.challenge, [{ type: 'authPrincipal' }]),
    }),
  });
  const step1Body = (await step0SubmitRes.json()) as DidConnectClaimResponse;
  const step1 = decodeClaimBody(step1Body);
  const prepareTxClaim = step1.requestedClaims.find((c) => c.type === 'prepareTx') as
    | { readonly partialTx: string }
    | undefined;
  if (prepareTxClaim === undefined) {
    throw new Error('expected a prepareTx claim at step 1');
  }

  const finalTx = await walletSignsPartialTx(prepareTxClaim.partialTx, wallet, outputsOverride);

  const step1SubmitRes = await fetch(`${baseUrl}${authPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _t_: sessionToken,
      userPk: wallet.publicKey,
      userInfo: await walletResponseJwt(wallet, step1.challenge, [{ type: 'prepareTx', finalTx }]),
    }),
  });
  const finalBody = (await step1SubmitRes.json()) as { appPk: string; authInfo: string };
  // ensureSignedJson (did-connect-js's own wrapper) lifts 'error' to the
  // TOP level of the signed payload and strips it from response, so the
  // error string is a sibling of response, not nested inside it.
  const decoded = jwtDecode(finalBody.authInfo) as unknown as Record<string, unknown>;
  const response = decoded.response as { confirmed: boolean };
  const error = decoded.errorMessage as string | undefined;
  return error === undefined || error === '' ? { confirmed: response.confirmed } : { confirmed: response.confirmed, error };
}

export { fromRandom, type WalletObject };
