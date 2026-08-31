// Seed one complete hire against a running dev server, so the agent,
// credential and verify pages can be looked at with REAL data rather than
// with a fixture typed into the HTML.
//
// Every step goes through the public API exactly as a client would: register
// an operator, sign a delegation with a real Ed25519 key, delegate an agent,
// open a job, agree criteria from both sides, confirm, submit a pull
// request, and merge. Nothing is written into storage directly, so if a
// page renders it, the API really served it.
//
// The GitHub adapter is not stubbed here, which means the merge leg needs a
// server started with a stub adapter. That is what seed-server.ts is for.
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { signRequest, signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';

const BASE = process.env['SEED_BASE'] ?? 'http://127.0.0.1:3141';

const OPERATOR_SEED = new Uint8Array(32).fill(11);
const AGENT_SEED = new Uint8Array(32).fill(22);
// The buyer used to ride a fixed placeholder DID with no key behind it,
// which worked only because the caller-did header let a request assert
// identity by naming it. R-34 requires possession of the key that DID
// names, so the buyer now needs a real signing identity too.
const BUYER_SEED = new Uint8Array(32).fill(33);

async function keyFor(seed: Uint8Array, controller: string) {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller });
  key.id = `${controller}#${key.publicKeyMultibase}`;
  return key;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

// Every exchange route now requires a verified request signature (R-34):
// the party proves it holds the DID's key, rather than merely naming it.
async function postSigned(path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body ?? {});
  const targetUri = `${BASE}${path}`;
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

async function expectOk(label: string, res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  // 409 is a re-run against a server that already holds the record, which is
  // fine for a seed: the point is to get the data in place, not to prove the
  // first write. Anything else is a real failure and stops the script.
  if (res.status >= 400 && res.status !== 409) {
    throw new Error(`${label}: ${res.status} ${text}`);
  }
  console.log(`${label}: ${res.status}`);
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function main(): Promise<void> {
  // The DID suffix is derived from the PUBLIC KEY through ArcBlock's own
  // rule, not from the key's multibase form. The registry checks that
  // binding on the delegation proof (agent-invariant2.test.ts does the same
  // derivation from the fingerprint alone), so a DID built any other way
  // fails verification with a signature error that reads like a key
  // mismatch. Learned the hard way: the multibase version returned
  // "the signature does not check out against the operator key".
  const operatorIdentity = await signingIdentityFromSeed(OPERATOR_SEED);
  const agentIdentity = await signingIdentityFromSeed(AGENT_SEED);
  const buyerIdentity = await signingIdentityFromSeed(BUYER_SEED);
  const operatorDid = operatorIdentity.did;
  const agentDid = agentIdentity.did;
  const buyerDid = buyerIdentity.did;

  await expectOk('operator', await post('/operators', { did: operatorDid, githubLogin: 'northsound' }));
  await expectOk('buyer as operator', await post('/operators', { did: buyerDid, githubLogin: 'northsound-buyer' }));

  const opKey = await keyFor(OPERATOR_SEED, operatorDid);
  const suite = new Ed25519Signature2020({ key: opKey });
  const loader = securityLoader();
  loader.addStatic(opKey.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...opKey.export({ publicKey: true }),
  });
  loader.addStatic(operatorDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: operatorDid,
    assertionMethod: [opKey.id],
    verificationMethod: [
      { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...opKey.export({ publicKey: true }) },
    ],
  });

  const delegation = await vc.issue({
    credential: {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
        { '@vocab': 'https://freeagents.dev/terms#' },
      ],
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ['VerifiableCredential', 'AgentDelegation'],
      issuer: operatorDid,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: agentDid, delegatedBy: operatorDid },
    },
    suite,
    documentLoader: loader.build(),
  });

  await expectOk(
    'agent',
    await post('/agents', {
      did: agentDid,
      operator: operatorDid,
      delegation,
      name: 'axiom-ui',
      skills: ['React', 'TypeScript', 'Accessibility', 'Storybook'],
      githubLogin: 'northsound',
    }),
  );

  const job = await expectOk(
    'job',
    await post('/jobs', {
      buyerDid,
      agentDid,
      repository: 'buyer/commerce',
      brief: 'Accessible combobox with async loading, matching the WAI-ARIA pattern',
    }),
  );
  const jobId = String(job['id']);

  await expectOk(
    'criteria',
    await postSigned(
      `/jobs/${jobId}/criteria`,
      {
        criteria: [
          { text: 'Combobox supports async option loading with a loading state', proposedBy: 'agent' },
          { text: 'Keyboard navigation matches the WAI-ARIA combobox pattern', proposedBy: 'agent' },
        ],
      },
      agentIdentity,
    ),
  );

  for (const index of [0, 1]) {
    await expectOk(`accept ${index} buyer`, await postSigned(`/jobs/${jobId}/criteria/${index}/accept`, {}, buyerIdentity));
    await expectOk(`accept ${index} agent`, await postSigned(`/jobs/${jobId}/criteria/${index}/accept`, {}, agentIdentity));
  }

  await expectOk('confirm', await postSigned(`/jobs/${jobId}/confirm`, {}, buyerIdentity));
  await expectOk('pull-request', await post(`/jobs/${jobId}/pull-request`, {}));
  const merged = await expectOk('merge', await post(`/jobs/${jobId}/merge`, {}));

  const credential = merged['credential'] as { id?: string } | undefined;
  console.log('');
  console.log('agent page:      ' + `${BASE}/agents/${encodeURIComponent(agentDid)}`);
  console.log('operator page:   ' + `${BASE}/operators/${encodeURIComponent(operatorDid)}`);
  if (credential?.id) {
    console.log('credential page: ' + new URL(credential.id, BASE).pathname);
    console.log('verify page:     ' + `/verify?credential=${encodeURIComponent(jobId)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
