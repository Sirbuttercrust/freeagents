import { createHash, randomBytes, randomUUID } from 'node:crypto';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { createCredentialsAdapter } from '../adapters/credentials/credentials.js';
import { publicBaseUrlFromEnv } from '../adapters/credentials/credentials.js';
import {
  isCompletedHireCredential,
  type CredentialsAdapter,
  type DeemedCompletionClaim,
  type IssuedCredentialDocument,
  type VerifiableCredential,
  type WorkHistoryClaim,
} from '../adapters/credentials/types.js';
import { createGithubAdapter } from '../adapters/github/github.js';
import {
  GistNotFoundError,
  RepositoryNotAccessibleError,
  StagingComparisonTruncatedError,
  type Gist,
  type GithubAdapter,
  type GrantPushResult,
  type PullRequestRef,
  type PullRequestSummary,
} from '../adapters/github/types.js';
import { createDidAbtSigningKeyResolver, createKnownKeyStore } from '../adapters/identity/did-abt-resolver.js';
import {
  REQUEST_SIGNATURE_COMPONENTS,
  describeSigningProfile,
  verifyWithReason as verifySignature,
} from '../adapters/identity/http-signature.js';
import { CandidateKeyRejectedError, createIdentityAdapter, DidNotResolvableError, AgentKeyDerivationMismatchError } from '../adapters/identity/identity.js';
import { PlatformSeedUnavailableError } from '../adapters/identity/identity.js';
import type { IdentityAdapter, DidKeyPair, SignedPayload } from '../adapters/identity/types.js';
import { type RateLimiter } from '../adapters/identity/verify-rate-limit.js';
import { InvalidTrustProxyError, trustProxySettingFromEnv, TRUST_PROXY_ENV_VAR } from '../adapters/config/trust-proxy.js';
import { createClassRateLimiters, createClassRateLimitMiddleware, type ClassLimits } from './rate-limit-middleware.js';
import { JSON_BODY_LIMIT, bodyParserErrorHandler, brokenAddressErrorHandler } from './request-errors.js';
import { createStreamCaps, holdUntilClosed, refusalSentence, STREAM_RETRY_AFTER_SECONDS } from './stream-caps.js';
import { createSignatureSpendStorage } from '../adapters/identity/signature-spend-storage.js';
import type { SignatureSpendStorage } from '../adapters/identity/signature-spend-storage-types.js';
import { type StagingObserver } from '../adapters/staging/types.js';
import { createGithubStagingObserver } from '../adapters/staging/github.js';
import {
  AgentAlreadyExistsError,
  AttestationAlreadyStoredError,
  CredentialAlreadyIssuedError,
  CredentialNotFoundError,
  JobAlreadyExistsError,
  AccountAlreadyExistsError,
  ReviewAlreadyExistsError,
  type AgentRepository,
  type UpdateListingInput,
  type AttestationRepository,
  type StoredAttestation,
  type CompromiseRepository,
  type CredentialRepository,
  type JobRepository,
  type AccountRepository,
  type ReviewRepository,
  type ObservedKeyRepository,
} from '../adapters/storage/types.js';
import {
  createAgentRepository,
  createAttestationRepository,
  createCompromiseRepository,
  createCredentialRepository,
  createJobRepository,
  createAccountRepository,
  createReviewRepository,
  createObservedKeyRepository,
} from '../adapters/storage/storage.js';
import { delegationConsistent, isAgentOperator, agentMayNegotiate, descriptionWellFormed, didSuffix, type Agent, type Delegation } from '../domain/agent.js';
import { agentWorkRecord, type CredentialEvidence } from '../domain/agent-work-record.js';
import { buildAttestation, AttestationError } from '../domain/attestation.js';
import { buildWorkHistoryExtension } from '../domain/work-history-extension.js';
import { chainIdentifiersMatch } from '../domain/chain-identifiers.js';
import { lastHireCompletedAt, recordLastChangedAt } from '../domain/freshness.js';
import { isHttpsUrl } from '../domain/notification.js';
import { isOutboundDestinationAllowed } from '../domain/outbound-destination.js';
import {
  filterBySkill,
  resolveBrowseSort,
  sortBrowseCards,
  toBrowseCard,
  type BrowseCard,
} from '../domain/browse.js';
import { operatorAggregate } from '../domain/operator-roster.js';
import {
  buildGistStatement,
  gistProofPayload,
  githubAccountUrl,
  parseGistStatement,
  parseGistUrl,
  signatureIsWellFormed,
  statementBindsBinding,
  type GistStatement,
  type GistUrlRef,
} from '../domain/account-proof.js';
import { isValidOperatorDid } from '../domain/operator-did.js';
import { isValidOperatorAddressEvm } from '../domain/operator-address-evm.js';
import { isValidOperatorAddressAbt } from '../domain/operator-address-abt.js';
import {
  isValidAvatarColourKey,
  isValidAvatarFace,
  isValidAvatarShape,
  resolveAvatar,
  AVATAR_FACES,
  AVATAR_SHAPES,
  type AvatarFace,
  type AvatarShape,
} from '../domain/avatar-spec.js';
import { jobListBucketOf, jobListDateOf } from '../domain/job-list.js';
import { waitingOnOf } from '../domain/incoming.js';
import { lastMessageOf, lastActivityAtOf, threadUnreadCount } from '../domain/thread-list.js';
import type { Account } from '../domain/account.js';
import {
  acceptCriterion,
  acceptPrice,
  applyLapses,
  assertPriceAboveFloor,
  attachStagingRepository,
  completeJob,
  confirmSpec,
  createJob,
  DepositSettledError,
  followRepositoryMove,
  JobError,
  JobPriceError,
  JobTransitionError,
  LAPSE_AT_STAGED_STATUSES,
  proposeCriteria,
  pullRequestTemplate,
  recordCitedClose,
  recordClosedUnmerged,
  recordStale,
  recordStagedDeclined,
  decline,
  deemWindowHasPassed,
  mergedInsideWindow,
  recordWithdrawn,
  refuseRedo,
  requestChanges,
  requestRedo,
  RedoAllowanceExhaustedError,
  stageWork,
  isTerminal,
  submitPullRequest,
  validateJobTransition,
  type CompletedJob,
  type Job,
  type JobStatus,
  type Party,
  type PriceProposal,
  type Rail,
} from '../domain/job.js';
import { depositUsd, remainderUsd } from '../domain/payment.js';
import { createSettlementGate, remainderSettled, type SettlementGate } from '../adapters/payment/gate.js';
import type { AbtPaymentRail } from '../adapters/payment/abt.js';
import type { AbtEthPaymentRail } from '../adapters/payment/abt-eth.js';
import {
  abtEthHalfPaidRefusal,
  checkAbtEthQuoteLock,
  createAbtEthQuoteLockStorage,
  lockAbtEthQuote,
  STARTED_AT_EARLIER_PRICE_MESSAGE,
  type AbtEthQuoteLockStorage,
} from '../adapters/payment/abt-eth-quote-lock.js';
import { createAbtEthShortPaymentStorage, type AbtEthShortPayment, type AbtEthShortPaymentStorage } from '../adapters/payment/abt-eth-short-payment.js';
import { normalizeUsdcTxHash, type UsdcPaymentRailShim } from '../adapters/payment/usdc.js';
import { createAbtEthPaymentRailOrNull, createAbtPaymentRailOrNull, createUsdcPaymentRailOrNull } from '../adapters/payment/rail-factory.js';
import { attachAbtPaymentHandlers, setProvenStarter, type AbtTxEncoder } from '../adapters/payment/abt-did-connect.js';
import { createTxEncoder as createAbtTxEncoder } from '@ocap/client/encode';
import {
  abtEthHalfPaidRecordFor,
  checkDepositReadiness,
  checkLegNotAlreadySettled,
  checkRailDoorEligible,
  checkRepositoryReady,
  confirmPayment,
  heldLegMessage,
  judgeLateAbtEthPayment,
  legHold,
  legStatusConflictMessage,
  legStatusEligible,
  operatorAddressNotSetMessage,
  processWalletResponse,
  railHeldByShortPayment,
  repositoryNotAccessibleMessage,
  requestPayment,
  SHORT_AWAITING_OWNER_MESSAGE,
  storedShortAnswer,
  usdcHalfPaidRecordFor,
  type HeldLegAction,
  type RouteLeg,
} from '../adapters/payment/route-support.js';
import { RateUnavailableError, type PaymentRef, type PaymentRequest } from '../adapters/payment/types.js';
import { createSettlementRepository } from '../adapters/storage/storage.js';
import type { ObservedSettlementRecord, SettlementRepository } from '../adapters/storage/types.js';
import { rotationWellFormed, type KeyRotation } from '../domain/key-rotation.js';
import { buyerDiversity, type HireFacts } from '../domain/buyer-diversity.js';
import {
  buyerConductRecord,
  buyerConductThresholdFailure,
  operatorConductRecord,
  type BuyerConduct,
  type BuyerConductThresholdFailure,
  type BuyerJobFacts,
  type OperatorConduct,
  type OperatorJobFacts,
} from '../domain/buyer-conduct.js';
import {
  disputedBy,
  reportWellFormed,
  type CompromiseReport,
} from '../domain/compromise.js';
import {
  assertReviewEligible,
  buildReview,
  JobNotReviewableError,
  reviewTextWellFormed,
  ReviewAgentMismatchError,
  ReviewerNotBuyerError,
  type Review,
} from '../domain/review.js';
import { ACCESS_NOTICE, CAPABILITIES, type Capability } from '../domain/access.js';
import { SIGN_IN_METHODS, type SignInMethod } from '../domain/sign-in-methods.js';
import { type SessionAdapter, type SignInMethod as SessionSignInMethod, type OAuthStart } from '../adapters/identity/session.js';
import { sessionAdapterFromEnv } from '../adapters/identity/session-github-passkey.js';
import { createWebSurface, prefersHtml, type WebSurface } from '../web/static.js';
import {
  authorKindFor,
  createMessage,
  createSystemMessage,
  editMessage,
  isSingleEmoji,
  MessageEditWindowExpiredError,
  MessageError,
  messageBodyWellFormed,
  MESSAGE_BODY_MAX_LENGTH,
  partyMayAccessThread,
  reactToMessage,
  removeReaction,
  threadIsWritable,
  ThreadReadOnlyError,
  advanceReadState,
  type Message,
  type MessageAttachmentRef,
  type ThreadReadState,
} from '../domain/message.js';
import {
  createNotification,
  unreadCountOf,
  type Notification,
  type NotificationEventType,
} from '../domain/notification.js';
import {
  assertAttachmentAllowed,
  AttachmentError,
  isImageKind,
  contentTypeFor,
  unsentUploadCapReached,
  unsentUploadExpired,
  UNSENT_UPLOAD_TTL_MS,
  type Attachment,
} from '../domain/attachment.js';
import {
  createMessageRepository,
  createThreadReadStateRepository,
  createNotificationRepository,
  createAttachmentRepository,
  createPushSubscriptionRepository,
} from '../adapters/storage/storage.js';
import type {
  MessageRepository,
  ThreadReadStateRepository,
  NotificationRepository,
  AttachmentRepository,
  PushSubscriptionRepository,
} from '../adapters/storage/types.js';
import {
  attachmentsDirFromEnv,
  randomFileId,
  readAttachmentFile,
  removeAttachmentFile,
  writeAttachmentFile,
} from '../adapters/attachments/storage.js';
import { reencodeImage, ImageReencodeError } from '../adapters/attachments/image.js';
import { createWebhookSender, type WebhookSender } from '../adapters/webhook/webhook.js';
import { createPushSender, type PushSender } from '../adapters/push/push.js';
import { createOperatorAddressCheck, type OperatorAddressCheck, type OperatorAddressNetwork } from '../adapters/payment/operator-address-check.js';

// chainIdentifiersMatch moved to
// src/domain/chain-identifiers.ts (STG2T) so the staging adapter's
// commit-signer check can share it instead of comparing logins with a
// bare ===.

// Account answers come in two shapes, by who is asking (B61c: the name a
// passkey was made under must not be public).
//
// accountProjection is the public shape: did, githubLogin, createdAt,
// operatorAddressEvm, operatorAddressAbt, operatorAddressAbtEth, and no
// passkeySubject key at all (absent, not null). GET /accounts/:did needs no sign-in, so anyone who
// knows a DID reads this shape, and POST /accounts (also unauthenticated)
// answers it too. tests/api/account-invariant2.test.ts and
// tests/api/account-public-shape.test.ts assert the key set, and any added
// field here is a contract change.
//
// ownAccountProjection is the public shape plus passkeySubject (null when
// the account never bound one). It serves only the two answers that go to
// the account itself, both behind requireSessionOrSignature and the acting
// party's own DID: GET /accounts/me and the 200 of
// PATCH /accounts/:did/operator-address. The settings page reads it from
// GET /accounts/me to show which sign-in method the account uses.
// operatorAddressEvm (USDC on Arbitrum), operatorAddressAbt (ABT on ArcBlock)
// and operatorAddressAbtEth (ABT on Ethereum) ride both shapes the same way
// (S3, P8c): each is null until the operator sets it through
// PATCH /accounts/:did/operator-address, and no one is ever filled from
// another.
//
// FIX-B62b: githubLogin in both shapes is the proved column, so a row
// registered before logins needed proof shows githubLogin: null. Its
// unprovedGithubLogin is in neither shape, for anyone, the account itself
// included: showing it would present a typed name as the account's
// GitHub, the claim that card removed. tests/api/account-unproved-login.test.ts
// asserts the key set and that the text appears nowhere in an answer.
function accountProjection(row: Account): Record<string, unknown> {
  return {
    did: row.did,
    githubLogin: row.githubLogin,
    createdAt: row.createdAt.toISOString(),
    operatorAddressEvm: row.operatorAddressEvm,
    operatorAddressAbt: row.operatorAddressAbt,
    operatorAddressAbtEth: row.operatorAddressAbtEth,
  };
}

function ownAccountProjection(row: Account): Record<string, unknown> {
  return { ...accountProjection(row), passkeySubject: row.passkeySubject };
}

// The Capability projection is the whole response. Exactly these six fields,
// nothing more: tests/api/capabilities-invariant2.test.ts asserts the key
// set, and a seventh field here would be a contract change. R-23 states the
// limit before a user invests effort, so this is read by anyone, signed in
// or not.
function capabilityProjection(cap: Capability): Record<string, unknown> {
  return {
    id: cap.id,
    method: cap.method,
    path: cap.path,
    access: cap.access,
    identityField: cap.identityField,
    reason: cap.reason,
  };
}

// The SignInMethod projection is the whole response. Exactly these five
// fields, nothing more: tests/api/sign-in-methods.test.ts asserts the key
// set, and a sixth field here would be a contract change. Issue 84 states
// which methods exist before a user invests effort, so this is read by
// anyone, signed in or not.
function signInMethodProjection(method: SignInMethod): Record<string, unknown> {
  return {
    id: method.id,
    label: method.label,
    required: method.required,
    walletBased: method.walletBased,
    reason: method.reason,
  };
}

// The Agent record projection is the whole response: tests/api/
// agent-invariant2.test.ts asserts the key set, and a new field here is a
// contract change. avatarSpec and keyRotations (R-30) ride the base key set
// unconditionally - every agent has a resolved avatar and a (possibly empty)
// rotation history, so there is no state to wait on; conditional-spread
// style stays reserved for fields a row may lack (jobProjection's
// confirmation pair). Neither is read from a request body here: the avatar
// override is written only by PUT /agents/:agentDid/avatar, from fixed sets.
function agentProjection(row: Agent): Record<string, unknown> {
  return {
    did: row.did,
    operatorDid: row.operatorDid,
    delegation: row.delegation,
    name: row.name,
    // ENT-2: one line describing the agent. Null when the operator never
    // set one, the same "every agent has the field, not every agent has a
    // value" stance floorPriceUsd and every other optional field below
    // already take.
    description: row.description,
    skills: [...row.skills],
    githubLogin: row.githubLogin,
    proofStatus: row.proofStatus,
    createdAt: row.createdAt.toISOString(),
    // ENT-2.3 as amended (AV1): the operator's stored override if present,
    // else the DID-derived default. AV2 removed the legacy server-rendered
    // SVG `avatar` field that rode beside it, once no page read it.
    avatarSpec: resolveAvatar(row.avatarSpec, row.did),
    // R-30: the rotation history rides the base key set unconditionally,
    // the same way the avatar does: every agent has a history, an
    // empty one before the first rotation, so the key set never changes
    // shape with state. ENT-8.4's third party resolves the superseded key
    // from it, and the profile shows the rotation with dates (R-6).
    keyRotations: row.keyRotations.map((rotation) => ({
      fromKey: rotation.fromKey,
      toKey: rotation.toKey,
      rotatedAt: rotation.rotatedAt.toISOString(),
    })),
    // P1, scope item 5: the optional floor rides the base key set
    // unconditionally, the same "every agent has the field, not every
    // agent has a value" stance avatar and keyRotations already take --
    // null when the agent never set one, which places no floor on a
    // proposal at all.
    floorPriceUsd: row.floorPriceUsd,
    // P7: the operator's own listing filters ride the base key set
    // unconditionally, the same stance floorPriceUsd already takes: null
    // when the operator never set one, which places no filter on a hire
    // at all. A buyer reads an agent's terms here before wasting a hire
    // attempt on them.
    minBuyerMerges: row.minBuyerMerges,
    maxWalkedAfterConfirm: row.maxWalkedAfterConfirm,
    // HT1 (ruling, 2026-09-25): off by default, rides the base key set
    // unconditionally like every other opt-in flag above. Set only by
    // PUT /agents/:agentDid/negotiation, gated to the agent's own operator.
    negotiatesOnOwnersBehalf: row.negotiatesOnOwnersBehalf,
    // HT1 Part B (STEER item 4, 2026-09-25): null when the operator never
    // set one, rides the base key set unconditionally like every other
    // opt-in field above. Set only by PUT /agents/:agentDid/webhook,
    // gated to the agent's own operator.
    notifyWebhookUrl: row.notifyWebhookUrl,
    // FIX-B43a (ruling, 2026-09-27): the agent's own listing state, rides
    // the base key set unconditionally like every other field above.
    // Set only by PUT /agents/:agentDid/listing, gated to the agent's
    // own operator. True by default; false means the agent left browse
    // and refuses new hires, while its finished work stays public.
    listed: row.listed,
  };
}

// R-16: the compromise report projection. Never mixed into agentProjection
// or a credential document (ENT-8.3): the window is visible on its own
// routes instead of a field on either.
function compromiseReportProjection(report: CompromiseReport): Record<string, unknown> {
  return {
    key: report.key,
    since: report.since.toISOString(),
    reportedAt: report.reportedAt.toISOString(),
  };
}

// P6: agentWorkRecord's tiers (verified-hire, verified-prior-work,
// portfolio) are built ONLY from a completed merge (ENT-8), so a stored
// deemed-completion credential must never reach this pipeline -- a job
// nobody merged is not a hire, however the platform reports it stopped.
// Every reader of listBySubjectDid narrows through this one function
// (isCompletedHireCredential, src/adapters/credentials/types.ts), so a
// non-hire document quietly widening into a browse card or a profile's
// verified-hire count fails here, structurally, once, rather than at
// each of the three call sites this pipeline has.
function credentialEvidenceOf(
  stored: readonly { readonly document: IssuedCredentialDocument; readonly repositoryPublic: boolean }[],
): CredentialEvidence[] {
  return stored
    .filter((entry): entry is { document: VerifiableCredential; repositoryPublic: boolean } =>
      isCompletedHireCredential(entry.document),
    )
    .map((entry) => ({
      credentialId: entry.document.id,
      repository: entry.document.credentialSubject.hire.repository,
      pullRequest: entry.document.credentialSubject.hire.pullRequest,
      mergedAt: entry.document.credentialSubject.hire.mergedAt,
      mergeCommit: entry.document.credentialSubject.hire.mergeCommit,
      buyerDid: entry.document.credentialSubject.hire.buyer,
      repositoryPublic: entry.repositoryPublic,
      additions: entry.document.credentialSubject.hire.additions,
      deletions: entry.document.credentialSubject.hire.deletions,
      filesChanged: entry.document.credentialSubject.hire.filesChanged,
    }));
}

// R-22 (ENT-10): the review projection. Exactly these five fields, nothing
// more, and no numeric field anywhere (ENT-10.2): text, attributed to the
// buyer DID, tied to the job it came from. Never mixed into agentProjection,
// a browse card, or a credential document, for the same separation
// compromiseReportProjection keeps.
function reviewProjection(review: Review): Record<string, unknown> {
  return {
    jobId: review.jobId,
    authorDid: review.authorDid,
    agentDid: review.agentDid,
    text: review.text,
    createdAt: review.createdAt.toISOString(),
  };
}

// The Job draft projection is the whole response. Exactly these eight fields
// for a draft, nothing more: tests/api/job-invariant2.test.ts asserts the key
// set, and a ninth field here would be a contract change. brief rides the
// response beside briefHash so anyone holding both can recompute the hash with
// off-the-shelf tools, no call to this service (invariant 2). criteria joins
// only once the exchange has something in it (R-8); confirm (R-9) adds
// specHash and confirmedAt beside them, so a confirmed job projects the base
// eight plus criteria, specHash and confirmedAt - a draft still projects
// exactly the pinned eight keys. Submit (R-10) adds pullRequestUrl,
// submittedAt and deadline the same conditional way: they appear only on a
// submitted job and every state after it. Merge (R-11) adds mergeCommit and
// mergedAt the same way again: a completed job projects the submitted keyset
// plus exactly those two, both observed from GitHub rather than asserted
// (ENT-7.1). Outcomes (R-12, ENT-7.2) add nothing: a closed_unmerged or
// stale job projects the submitted keyset minus nothing and gains no merge
// facts, so an unhappy outcome can never read as a verified hire.
function jobProjection(row: Job): Record<string, unknown> {
  // Confirm (R-9) sets hash and timestamp together or neither - one domain
  // function writes both - so the pair rides one conditional, and the null
  // check on confirmedAt is what lets TypeScript see the toISOString call
  // cannot fire on a draft.
  const confirmation =
    row.confirmedSpecHash !== null && row.confirmedAt !== null
      ? { specHash: row.confirmedSpecHash, confirmedAt: row.confirmedAt.toISOString() }
      : {};
  // P1: the price line joins the projection once the agent has proposed one
  // (row.priceUsd !== null), the same conditional stance `criteria` takes
  // once the exchange has something in it. depositPercent, redoAllowance
  // and deliveryWindowDays ride beside the price rather than the base
  // eight, because they describe the same agreement line the price does --
  // there is nothing to show before a price exists to attach them to.
  const price =
    row.priceUsd !== null
      ? {
          price: {
            priceUsd: row.priceUsd,
            rail: row.rail,
            depositPercent: row.depositPercent,
            redoAllowance: row.redoAllowance,
            deliveryWindowDays: row.deliveryWindowDays,
            acceptedByBuyer: row.priceAcceptedByBuyer,
            acceptedByAgent: row.priceAcceptedByAgent,
          },
        }
      : {};
  // The same one-writer rule for submit (R-10): submitPullRequest writes all
  // three fields or none, so all three ride one conditional. deadline is
  // null on rows written before R-12, and stays null there - the projection
  // never invents one. A confirmed job keeps exactly the eleven pinned keys.
  const submission =
    row.pullRequestUrl !== null && row.submittedAt !== null
      ? {
          pullRequestUrl: row.pullRequestUrl,
          submittedAt: row.submittedAt.toISOString(),
          deadline: row.deadline === null ? null : row.deadline.toISOString(),
        }
      : {};
  // The same one-writer rule for merge (R-11): completeJob writes both
  // fields or neither, so both ride one conditional. A completed job keeps
  // exactly the submitted keyset plus these two.
  const completion =
    row.mergeCommit !== null && row.mergedAt !== null
      ? { mergeCommit: row.mergeCommit, mergedAt: row.mergedAt.toISOString() }
      : {};
  // P4: the same one-writer rule for stage (stageWork writes both fields
  // together or neither), riding between confirmation and submission --
  // staged sits between confirmed and submitted in the transition table,
  // and its two fields join the projection the same conditional way.
  const staging =
    row.stagedCommit !== null && row.stagedAt !== null
      ? { stagedCommit: row.stagedCommit, stagedAt: row.stagedAt.toISOString() }
      : {};
  // STG2: the pull-request template rides alongside the staging facts --
  // once a commit is staged, the agent needs the title and body to open
  // the real PR from its own fork, and there is nothing to template
  // before a commit exists to attest.
  const prTemplate =
    row.stagedCommit !== null && row.stagedAt !== null ? { pullRequestTemplate: pullRequestTemplate(row) } : {};
  // P6: the redo record joins the projection only once a redo has ever
  // been requested (redoRequestedAt !== null survives both an operator
  // refusal and an eventual acceptance, so this rides beside staging
  // rather than being cleared by either). refusedAt and the extension
  // are both included unconditionally inside this object once it exists,
  // because a caller reading the redo record needs the refusal fact and
  // the earned extension in the same place, not scattered.
  const redo =
    row.redoRequestedAt !== null
      ? {
          redo: {
            requestedCriterionIndex: row.redoRequestedCriterionIndex,
            requestedAt: row.redoRequestedAt.toISOString(),
            refusedAt: row.redoRefusedAt === null ? null : row.redoRefusedAt.toISOString(),
            usedCount: row.redoUsedCount,
            stagedLapseExtensionDays: row.stagedLapseExtensionDays,
          },
        }
      : {};
  // P6: the cited close (design record row 4). Joins the projection only
  // on a cited_closed job -- the four fields are one group with one
  // writer (recordCitedClose). moneyReturned rides beside the fact
  // itself so the API response states plainly that no money returns,
  // before any screen (P8) ever renders it (invariant 12: no refund
  // vocabulary is added anywhere else in this domain, and none is
  // spelled out in this identifier either).
  const citedClose =
    row.citedCloseAt !== null &&
    row.citedCloseCriterionIndex !== null &&
    row.citedCloseReasonText !== null &&
    row.citedCloseAuthorDid !== null
      ? {
          citedClose: {
            criterionIndex: row.citedCloseCriterionIndex,
            reasonText: row.citedCloseReasonText,
            authorDid: row.citedCloseAuthorDid,
            at: row.citedCloseAt.toISOString(),
            moneyReturned: false,
          },
        }
      : {};
  // B14a: attachStagingRepository writes stagingRepo and baseCommit
  // together or neither (see that function's own header comment), so the
  // pair rides one conditional here the same way every other one-writer
  // pair in this projection does. Once confirm has created the platform's
  // staging repository and invited (or added) the agent's login as a
  // collaborator, the agent has to be told which repository that is --
  // the anchor's whole point is that the staged commit lives somewhere
  // the platform named, and the wire is where that name has to surface.
  const stagingRepoFacts =
    row.stagingRepo !== null && row.baseCommit !== null
      ? { stagingRepo: row.stagingRepo, baseCommit: row.baseCommit }
      : {};
  return {
    id: row.id,
    buyerDid: row.buyerDid,
    agentDid: row.agentDid,
    repository: row.repository,
    brief: row.brief,
    briefHash: row.briefHash,
    status: row.status,
    ...(row.criteria.length > 0 ? { criteria: row.criteria } : {}),
    ...price,
    ...confirmation,
    ...stagingRepoFacts,
    ...staging,
    ...prTemplate,
    ...redo,
    ...submission,
    ...completion,
    ...citedClose,
    createdAt: row.createdAt.toISOString(),
  };
}

// FIX-B39 (B39), rule 2: the job's payable currencies. The pinned
// one if a quote pinned it; otherwise every currency the hired agent's
// owner has a payout address for. Rule 3 (settlement fixes the
// currency): once a deposit has settled, only that deposit's currency,
// independent of whether the job's own quote ever named one and
// independent of whether confirm has run yet. B88: a deposit that has not
// settled but whose price transfer already reached the owner is held on the
// rail it was paid in (heldRail, read by the caller), so only that currency
// is offered, whatever the quote pinned or the owner has addresses for. The
// hold is a deposit half paid, which the buyer finishes, or one stored short
// on the ABT-on-Ethereum rail, which waits on the owner; either way no other
// currency is offered and nobody pays the deposit twice.
async function payableRailsFor(
  job: Job,
  jobAgent: Agent | null,
  accountRepo: AccountRepository,
  settlementRepo: SettlementRepository,
  heldRail: Rail | null,
): Promise<readonly Rail[]> {
  const settledDeposit = await settlementRepo.findByJobAndLeg(job.id, 'deposit');
  if (settledDeposit !== null) return [settledDeposit.rail];
  if (heldRail !== null) return [heldRail];
  if (job.rail !== null) return [job.rail];
  if (jobAgent === null) return [];
  const account = await accountRepo.findByDid(jobAgent.operatorDid);
  if (account === null) return [];
  const rails: Rail[] = [];
  if (account.operatorAddressAbt !== null) rails.push('abt');
  if (account.operatorAddressEvm !== null) rails.push('usdc');
  if (account.operatorAddressAbtEth !== null) rails.push('abt_eth');
  return rails;
}

// ORG1 (done-means item 2): the one key naming the GitHub read access a
// private-repo hire needs and the accounts that need it. Computed here,
// not inline at each call site, so both the buyer's own POST /jobs
// response and the operator's live read (GET /jobs/:jobId) name it the
// same way. Present only:
// - once the agent has a VERIFIED GitHub login (the same gate confirm's
//   own grantPush guard reads, B14a) -- an unverified or absent login
//   names nothing, because there is no account yet to point the buyer
//   at; and
// - before a staging repository exists (row.stagingRepo === null): once
//   confirm has succeeded, the platform already proved it CAN read the
//   buyer's repository (that is what readRepository's own success
//   means), so the access question this field answers is already
//   settled, and every merge/outcome row carrying the field forever
//   would grow the fixed projection every downstream test pins against
//   for no fact still in question.
// ORG1: confirm's own read of the buyer's
// repository and the pull-request route's read of the PR both run on
// the platform's single token, never the agent's, so a buyer who grants
// read ONLY to the agent's account is still stuck at 409 forever. Both
// accounts need read; this carries both under the same key so downstream
// readers keep pinning one projection shape rather than two.
// Never asserts whether the named repository actually IS private; that
// fact used to surface only when confirm's own RepositoryNotAccessibleError
// check ran. FIX-B36: it now surfaces first at the three deposit-start
// doors (checkRepositoryReady, route-support.ts), before a deposit is
// ever paid, and confirm's own check remains as a second read in case
// the repository's visibility changed in between.
function githubAccessNeededFor(
  agent: Agent | null,
  row: Pick<Job, 'stagingRepo'>,
  platformGithubLogin: string,
): { readonly githubAccessNeeded: { readonly agentGithubLogin: string; readonly platformGithubLogin: string } } | Record<string, never> {
  if (row.stagingRepo !== null) return {};
  if (agent === null || agent.githubLogin === null || agent.proofStatus !== 'verified') {
    return {};
  }
  return { githubAccessNeeded: { agentGithubLogin: agent.githubLogin, platformGithubLogin } };
}

// The body carries the W3C Verifiable Credential exactly as produced.
// This only checks that the fields the service relies on are present and
// well-typed; the object then passes through untouched, because the bytes
// that verify are the bytes we store (ENT-3.1).
function delegationShape(value: unknown): Delegation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const vc = value as Record<string, unknown>;
  if (!Array.isArray(vc['@context'])) return null;
  if (typeof vc.id !== 'string' || vc.id.length === 0) return null;
  if (!Array.isArray(vc.type)) return null;
  if (typeof vc.issuer !== 'string' || vc.issuer.length === 0) return null;
  if (typeof vc.issuanceDate !== 'string' || vc.issuanceDate.length === 0) return null;
  const subject = vc.credentialSubject;
  const proof = vc.proof;
  if (typeof subject !== 'object' || subject === null) return null;
  if (typeof proof !== 'object' || proof === null) return null;
  const s = subject as Record<string, unknown>;
  const p = proof as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id.length === 0) return null;
  if (typeof p.type !== 'string' || p.type !== 'Ed25519Signature2020') return null;
  if (typeof p.proofValue !== 'string' || p.proofValue.length === 0) return null;
  return value as Delegation;
}

// R-34: express.json's verify hook is the only point that sees the exact
// wire bytes before parsing re-serialises them, so it is the only place the
// content-digest check (the didSignature middleware below) can bind to. It fires only when
// express.json actually parses a JSON body -- a body-less request leaves
// rawBody undefined, treated as an empty buffer at the point of use.
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// R-34: the DID a verified request signature named, set by didSignature
// before next(). Undefined on every route that does not mount it, and on a
// mounted route when no signature headers were present at all (signing stays
// optional -- see ASSUMPTIONS SIGNATURE_OPTIONAL).
interface SignedRequest extends Request {
  signerDid?: string;
}

// SW1-08: what verifySignedRequest answers. 'absent' is an unsigned request,
// 'unknown-key' a signature naming a key this service has never heard of, and
// { refused } a signature that failed a check, carrying the one sentence that
// names which.
type SignedRequestOutcome = 'absent' | 'unknown-key' | { readonly refused: string } | { readonly did: string };

function signerDidOf(req: Request): string | null {
  return (req as SignedRequest).signerDid ?? null;
}

// R-39 completion: the subject AND method a live session named, set by
// requireSessionOrSignature before next(). Undefined on every route that
// does not mount it, and on a mounted route when no session was presented
// at all. The method matters because resolving a session to an Account
// joins through a DIFFERENT unique column depending on which proof
// produced it: a github-oauth session's subject is the GitHub login
// (Account.githubLogin), a passkey session's subject is the passkey name
// the server made when the passkey was created (Account.passkeySubject).
// Joining through the wrong column
// would either miss a real account or, worse, resolve to the wrong one.
interface SessionedRequest extends Request {
  sessionSubject?: string;
  sessionMethod?: SessionSignInMethod;
}

// P8d: provisions an account for a session that resolves to no existing
// one, in exactly one place both sign-in paths route through
// (resolveActingParty itself, below). GitHub sessions set githubLogin
// from the subject and leave passkeySubject null; passkey sessions set
// passkeySubject and leave githubLogin null. createOperatorDid derives
// the DID deterministically from the subject (identity.ts), so a second
// call for the identical subject always names the identical DID and
// register() throws AccountAlreadyExistsError instead of minting a
// second row -- the race two concurrent first requests create is closed
// by catching that error and re-reading the winner's row, never a 500.
// The custody fence lives entirely in what this function does NOT do: it
// never calls an operator-address setter, so a
// provisioned account's payout addresses stay exactly what register()
// itself defaults them to (null on all three rails, in both storage drivers).
//
// FIX-B62b: a GitHub sign-in resolves only to a row holding the login in
// the proved githubLogin column. A row registered before logins needed
// proof holds that login as unprovedGithubLogin instead, and is never
// found by a login lookup, so the person signing in gets the account
// their own DID names, not the row that merely holds their name as typed
// text. The one exception is on the taken-DID path below: the DID this
// function derives from the login is the DID the platform itself derived
// when a GitHub sign-in first made that account, so a row with exactly
// that DID and that login as unproved text is the account this very
// sign-in made earlier (the migration demoted it with every other row).
// The GitHub OAuth session that got us here is the proof, and
// promoteUnprovedGithubLogin re-proves that one row. A row with any
// other DID is never promoted, whatever login text it holds.
async function provisionAccountForSession(
  repo: AccountRepository,
  identity: IdentityAdapter,
  subject: string,
  method: SessionSignInMethod,
): Promise<string> {
  const { did } = await identity.createOperatorDid(subject);
  try {
    await repo.register(
      method === 'passkey' ? { did, passkeySubject: subject } : { did, githubLogin: subject },
    );
  } catch (err) {
    if (!(err instanceof AccountAlreadyExistsError)) throw err;
    // Someone else (a concurrent request for this same subject, or an
    // earlier call this process already made) won the race, or the DID
    // already has a row. Fall through to the re-read below rather than
    // treating this as a failure, after the one re-proof a GitHub
    // sign-in may do for the row its own DID names.
    if (method === 'github-oauth') {
      const promoted = await repo.promoteUnprovedGithubLogin(did, subject);
      if (promoted !== null) return promoted.did;
    }
  }
  const winner =
    method === 'passkey' ? await repo.findByPasskeySubject(subject) : await repo.findByGithubLogin(subject);
  if (winner === null) {
    // register() either succeeded (the row exists) or lost the race to a
    // genuine duplicate (the row still exists, under whoever won). Either
    // way a row must exist now; its absence means storage betrayed its
    // own contract, which the caller's catch block maps to 503 like any
    // other unexpected storage fault.
    throw new Error('provisionAccountForSession: expected an account to exist immediately after register or a lost race');
  }
  return winner.did;
}

// R-39 completion: the acting
// party the server computed, never a caller claim. Exactly one of two
// proofs resolves it, the same "one rule, one code path, both proofs"
// stance the brief names:
//   - a verified R-34 signature names the signer's own DID directly
//     (signerDidOf) -- the signer proved possession of a registered
//     agent or operator key, so that DID IS the acting party, with
//     nothing left to compare it against.
//   - a live session resolves through the account lookup the schema's
//     unique githubLogin / passkeySubject constraint makes safe: two
//     accounts can never claim the same login or subject, so this join
//     can never resolve to two different accounts for one session.
//     FIX-B62b: a GitHub session matches the proved githubLogin column
//     only. A row that holds the login as unprovedGithubLogin (typed
//     before logins needed proof) is not found here, so that session
//     lands in provisioning and gets the account its own derived DID
//     names; the one row provisioning re-proves is described there. A
//     passkey session's subject is proven by the stored passkey (the
//     adapter mints it only after a registration it saved or an
//     authentication checked against the saved key), never by a name a
//     caller sent. P8d:
//     when the lookup finds no account, one is provisioned right here
//     (the anchor: a person who has never used this product signs in
//     and can immediately hire, no second registration step). A
//     signature never provisions: possessing a signing key already
//     proves a party, with nothing left for provisioning to add.
// Returns null only when neither proof is present at all (no session and
// no signature); requireSessionOrSignature already refused that caller
// before this function is ever reached. A live session always resolves
// to a real account DID now, provisioned on the spot if it did not
// already exist.
async function resolveActingParty(
  req: Request,
  repo: AccountRepository,
  identity: IdentityAdapter,
): Promise<string | null> {
  const signerDid = signerDidOf(req);
  if (signerDid !== null) return signerDid;

  const sessioned = req as SessionedRequest;
  if (sessioned.sessionSubject === undefined || sessioned.sessionMethod === undefined) {
    return null;
  }
  const account =
    sessioned.sessionMethod === 'passkey'
      ? await repo.findByPasskeySubject(sessioned.sessionSubject)
      : await repo.findByGithubLogin(sessioned.sessionSubject);
  if (account !== null) return account.did;
  return provisionAccountForSession(repo, identity, sessioned.sessionSubject, sessioned.sessionMethod);
}

// P7: resolves a buyer DID's own conduct record. Null when the DID
// resolves to no registered Account: a distinct answer from a record of
// zeroes, modelling "no verified GitHub account" honestly rather than as
// clean counts. jobRepo.findByBuyerDid is optional on JobRepository (the
// same stance findCompletedByAgent already takes); a driver that omits it
// throws here, and the two call sites below map that the same way an
// actual storage outage is mapped (503), never a silent pass.
//
// SW1-09: `live` is the route's list clock (liveLapsesForList in createApp).
// When given, the stored rows pass through it before they are counted, so
// a lapse nobody has opened yet counts the way a single-job read would
// count it. Without it the stored rows are counted as they are.
type JobListClock = (jobs: readonly Job[]) => Promise<Job[]>;

async function buyerConductForDid(
  buyerDid: string,
  accountRepo: AccountRepository,
  jobRepo: JobRepository,
  live?: JobListClock,
): Promise<BuyerConduct | null> {
  const account = await accountRepo.findByDid(buyerDid);
  if (account === null) return null;
  if (typeof jobRepo.findByBuyerDid !== 'function') {
    throw new Error('storage does not support findByBuyerDid');
  }
  const stored = await jobRepo.findByBuyerDid(buyerDid);
  const jobs = live === undefined ? stored : await live(stored);
  const facts: BuyerJobFacts[] = jobs.map((job) => ({
    status: job.status,
    confirmedAt: job.confirmedAt,
    redoRequestedAt: job.redoRequestedAt,
  }));
  return buyerConductRecord(facts);
}

// P7: the same lookup, keyed by the buyer's verified GitHub login instead
// of their DID (the read surface, scope item 6). One account may hold
// several DIDs over time (the brief's own wording); this schema records
// one live DID per Account row, so the record aggregates every job whose
// buyer DID matches that account's current DID. Null when no Account
// claims the login at all.
async function buyerConductForLogin(
  githubLogin: string,
  accountRepo: AccountRepository,
  jobRepo: JobRepository,
  live?: JobListClock,
): Promise<BuyerConduct | null> {
  const account = await accountRepo.findByGithubLogin(githubLogin);
  if (account === null) return null;
  return buyerConductForDid(account.did, accountRepo, jobRepo, live);
}

// P8r scope item 2/3: the operator half of the same account, over the
// agents this account operates rather than the jobs it hired. A
// different population from buyerConductForDid, read through its own
// pair of optional storage methods. Null when the operator DID resolves
// to no registered Account, the same "no record exists" stance the buyer
// side takes - distinct from a record of zeroes.
//
// The roster comes from agentRepo.listAll() filtered by an EXACT
// operatorDid comparison, the same comparison GET /accounts/:did/agents
// already uses (not isAgentOperator's didSuffix match): one account's
// roster must mean the same thing on every route.
async function operatorConductForDid(
  operatorDid: string,
  accountRepo: AccountRepository,
  agentRepo: AgentRepository,
  jobRepo: JobRepository,
  live?: JobListClock,
): Promise<OperatorConduct | null> {
  const account = await accountRepo.findByDid(operatorDid);
  if (account === null) return null;
  if (typeof agentRepo.listAll !== 'function') {
    throw new Error('storage does not support listAll');
  }
  if (typeof jobRepo.findByAgentDid !== 'function') {
    throw new Error('storage does not support findByAgentDid');
  }
  const findByAgentDid = jobRepo.findByAgentDid.bind(jobRepo);
  const agentRows = await agentRepo.listAll();
  const ownAgents = agentRows.filter((row) => row.operatorDid === account.did);
  const perAgentJobs = await Promise.all(ownAgents.map((row) => findByAgentDid(row.did)));
  const storedJobs = perAgentJobs.flat();
  const allJobs = live === undefined ? storedJobs : await live(storedJobs);
  const facts: OperatorJobFacts[] = allJobs.map((job) => ({
    status: job.status,
    redoRefusedAt: job.redoRefusedAt,
  }));
  return operatorConductRecord(facts);
}

// P8r: the same lookup, keyed by GitHub login, mirroring
// buyerConductForLogin's own shape.
async function operatorConductForLogin(
  githubLogin: string,
  accountRepo: AccountRepository,
  agentRepo: AgentRepository,
  jobRepo: JobRepository,
  live?: JobListClock,
): Promise<OperatorConduct | null> {
  const account = await accountRepo.findByGithubLogin(githubLogin);
  if (account === null) return null;
  return operatorConductForDid(account.did, accountRepo, agentRepo, jobRepo, live);
}

// P7: the buyer is entitled to know why they were refused, because the
// counts are theirs. States which threshold and the buyer's own count
// (or, for an unkeyed buyer, that no verified GitHub account resolves).
function buyerConductFailureMessage(failure: BuyerConductThresholdFailure): string {
  if (failure.kind === 'not-keyed') {
    return `hiring this agent requires a verified GitHub account meeting ${failure.threshold} (${failure.required}); no verified GitHub account resolves for this buyer`;
  }
  if (failure.kind === 'below-minimum') {
    return `this agent requires ${failure.threshold} of at least ${failure.required}; your account has ${failure.actual}`;
  }
  return `this agent requires ${failure.threshold} of at most ${failure.required}; your account has ${failure.actual}`;
}

// P7: the self-hire label's GitHub comparison is only
// as good as the logins actually reaching isSelfHire. Resolves each
// distinct buyer DID in `hires` to its own verified GitHub login (one
// lookup per distinct buyer, not per hire) and attaches it to the row,
// so buyerDiversity's login comparison compares real accounts rather
// than the undefined isSelfHire silently treats as never-a-match.
// A buyer DID with no registered Account resolves to a null login,
// exactly like an unkeyed buyer elsewhere in this file: absent is never
// invented as a match.
async function withBuyerGithubLogins(
  hires: readonly CompletedJob[],
  accountRepo: AccountRepository,
): Promise<HireFacts[]> {
  const loginByBuyerDid = new Map<string, string | null>();
  for (const hire of hires) {
    if (loginByBuyerDid.has(hire.buyerDid)) continue;
    const account = await accountRepo.findByDid(hire.buyerDid);
    loginByBuyerDid.set(hire.buyerDid, account?.githubLogin ?? null);
  }
  return hires.map((hire) => ({
    ...hire,
    buyerGithubLogin: loginByBuyerDid.get(hire.buyerDid) ?? null,
  }));
}

// FIX-SW4f (SW4-05): the quota's refusal and the sweep's pace. The
// caps and the TTL live with the counting rule in src/domain/attachment.ts.
// Sending a file frees a place and takes seconds, so a minute is a fair wait.
const UNSENT_UPLOAD_RETRY_AFTER_SECONDS = 60;
// Running the sweep on every upload would repeat its read for no gain.
const UNSENT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// A large backlog is cleared over several uploads, not in one request.
const UNSENT_SWEEP_BATCH = 100;

function unsentUploadSentence(cap: 'job' | 'account'): string {
  return cap === 'job'
    ? 'Too many files were uploaded to this conversation without being sent. Send one of them, or try again later.'
    : 'Too many files were uploaded by this account without being sent. Send one of them, or try again later.';
}

// SW4-06 and B76: the cookie that ties a GitHub sign-in, and a one-click
// GitHub proof, to the browser that began it (see GET /auth/github/start,
// POST /agents/:agentDid/github-proof/start and GET /auth/github/callback
// below).
const OAUTH_STATE_COOKIE = 'fa_oauth_state';
const OAUTH_STATE_COOKIE_PATH = '/auth/github/callback';

// Sets the binding cookie on a start's answer: fa_oauth_state holding the
// state the start returns. Both starts call this one function, so the two
// flows cannot drift apart on an attribute. The attributes are explained at
// GET /auth/github/start.
function setOAuthStateCookie(res: Response, start: OAuthStart): void {
  const redirectUri = new URL(start.redirectUrl).searchParams.get('redirect_uri');
  res.cookie(OAUTH_STATE_COOKIE, start.state, {
    httpOnly: true,
    sameSite: 'lax',
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: 10 * 60 * 1000,
    secure: redirectUri !== null && redirectUri.startsWith('https://'),
  });
}

// One cookie's value from a Cookie request header, or null when it is
// absent. Nothing else in this app reads a cookie, so this is not a parser.
function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const pair = part.trim();
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return null;
}

export function createApp(
  repo: AccountRepository = createAccountRepository(),
  agentRepo: AgentRepository = createAgentRepository(),
  identity?: IdentityAdapter,
  github: GithubAdapter = createGithubAdapter(),
  jobRepo: JobRepository = createJobRepository(),
  credentials: CredentialsAdapter | undefined = undefined,
  compromiseRepo: CompromiseRepository = createCompromiseRepository(),
  credentialRepo: CredentialRepository = createCredentialRepository(),
  // #30 addendum: public does not mean scrapeable-to-death. A session
  // never raises any of these limits -- they gate by caller IP, independent
  // of whatever identity mechanism R-39 adds.
  // FIX-S7 (security sweep S7+S11): this parameter used to construct a
  // single RateLimiter that gated only the 4 anonymous verify routes. It
  // now takes the injection seam for the WHOLE class-limiter system
  // (src/api/rate-limit-middleware.ts): a bare RateLimiter here is still
  // treated as the `verify` class override (so the four existing test
  // files that construct one keep passing unchanged), or a ClassLimits
  // object can override any subset of the four classes' limits by number,
  // for a test that needs a generous override rather than a raised
  // default. Undefined means every class reads its own env-derived
  // default (CLASS_DEFAULTS in rate-limit-middleware.ts).
  rateLimits: RateLimiter | ClassLimits | undefined = undefined,
  web: WebSurface = createWebSurface(),
  reviewRepo: ReviewRepository = createReviewRepository(),
  // R-39 follow-up (issue 83): the session adapter hire and list routes
  // accept a bearer token against. Defaults to the env-derived adapter
  // (sessionAdapterFromEnv), matching every other capability's env-default
  // stance in this file. Injectable so tests can mint a live token against
  // a fake GitHub backend instead of exercising real OAuth.
  session: SessionAdapter = sessionAdapterFromEnv(),
  // The durable half of the R-34 signing-key
  // resolver's binding check, so identity resolution survives a process
  // restart. Defaults to the env-derived repository, matching every other
  // storage capability's stance in this file. Injectable so a test can
  // share one durable store across two separate createApp calls, the way
  // it shares any other repository, to prove a restart does not lose the
  // observation.
  observedKeyRepo: ObservedKeyRepository = createObservedKeyRepository(),
  // P4: the payment settlement gate (design record, 2026-09-01). Defaults
  // to the fail-closed UnwiredSettlementGate (see
  // src/adapters/payment/gate.ts's header comment for the wiring seam a
  // later card lands on): an unwired build refuses to confirm a job and
  // refuses to open a pull request, which is loud and correct.
  settlementGate: SettlementGate = createSettlementGate(),
  // P5: the staging observer port (design record, 2026-09-01). B14b
  // wires the production default to the real GitHub-backed observer
  // (src/adapters/staging/github.ts, built on the same `github` adapter
  // instance this function already threads through every other
  // staging-lifecycle route) -- an interface with only a fake behind it
  // is not a feature (the inert-declared-control class, B14). Tests
  // that need a fixed, predictable observation still inject
  // createMemoryStagingObserver explicitly; the memory driver is not
  // gone, only no longer the default a caller gets by omission.
  stagingObserver: StagingObserver = createGithubStagingObserver(github),
  // P5: the durable attestation record. Defaults to the env-derived
  // repository, matching every other storage capability's stance in this
  // file.
  attestationRepo: AttestationRepository = createAttestationRepository(),
  // P10: the ABT payment rail (brief scope item 5). createAbtPaymentRailOrNull
  // never throws (unlike createAbtPaymentRail itself): env vars are read
  // once per createApp() call and answered null when the rail is
  // unconfigured, matching every other env-derived default in this file.
  // A default that threw eagerly would break the 100+ existing tests that
  // construct createApp with no payment env set at all.
  abtPaymentRail: AbtPaymentRail | null = createAbtPaymentRailOrNull(),
  // P10: the USDC payment rail (brief scope item 5), the identical
  // null-safe stance as abtPaymentRail above.
  usdcPaymentRail: UsdcPaymentRailShim | null = createUsdcPaymentRailOrNull(),
  // P10: the observed settlement record (brief scope item 1). Defaults to
  // the env-derived repository, matching every other storage capability's
  // stance in this file. Injectable so a test can share one durable store
  // across two separate createApp calls and the settlement gate built from
  // it, the way every other storage capability in this codebase proves a
  // restart does not lose the observation.
  settlementRepo: SettlementRepository = createSettlementRepository(),
  // P10: encodes an ABT transaction to the bytes DID Connect's protocol
  // carries (brief, "the working reference... the txEncoder"). Defaults
  // to @ocap/client/encode's real network-backed encoder; tests inject a
  // pure local one (no network in the test suite, FACTORY_RULES.md).
  // Constructing the real default here never throws and never touches the
  // network itself (createTxEncoder() only builds the closure; the fetch
  // happens lazily inside it, on first actual use), so this is always
  // safe to default even when no ABT env var is set.
  abtTxEncoder: AbtTxEncoder = createAbtTxEncoder() as AbtTxEncoder,
  // S5 (this card): the one-shot signature-spend store. Defaults to the
  // env-derived storage, matching every other storage capability's stance
  // in this file. Injectable so a test can share one durable store across
  // two separate createApp calls, the way every other storage capability
  // in this codebase proves a restart does not lose the observation.
  signatureSpendStorage: SignatureSpendStorage = createSignatureSpendStorage(),
  // HT1 Part B: the hire thread's message store, read receipts, per-account
  // notifications, message attachments and browser Push subscriptions.
  // Same injectable-default stance as every other storage capability above.
  messageRepo: MessageRepository = createMessageRepository(),
  threadReadStateRepo: ThreadReadStateRepository = createThreadReadStateRepository(),
  notificationRepo: NotificationRepository = createNotificationRepository(),
  attachmentRepo: AttachmentRepository = createAttachmentRepository(),
  pushSubscriptionRepo: PushSubscriptionRepository = createPushSubscriptionRepository(),
  // HT1 Part B (STEER item 4): fire-and-forget senders. Both default to
  // their env-derived construction (an unconfigured deployment gets a
  // sender that announces itself once and then no-ops, matching every
  // other capability's stance in this file); tests inject a fake to
  // observe what would have been sent, with no network in the suite.
  webhookSender: WebhookSender = createWebhookSender(),
  pushSender: PushSender = createPushSender(),
  // The checksum read and the contract-code lookup behind
  // PATCH /accounts/:did/operator-address. Injectable so no test reaches a
  // network: the default asks the public node named by an environment
  // variable, which no test environment sets, and a test that wants an answer
  // hands in its own.
  operatorAddressCheck: OperatorAddressCheck = createOperatorAddressCheck(),
  // ABT on Ethereum: the third payment rail, with the same null-safe stance
  // as the two above. Injectable so a test hands in a rail built on a fake
  // chain client and a fake price feed; the default answers null on a
  // deployment with no ABT-on-Ethereum variables, and the two routes then
  // answer 503.
  abtEthPaymentRail: AbtEthPaymentRail | null = createAbtEthPaymentRailOrNull(),
  // The price each ABT-on-Ethereum checkout locked. Left undefined by every
  // caller that has no rail, and built only when a rail is configured, so a
  // deployment or a test without the rail never gets the in-memory-storage
  // warning from a default it did not ask for. Injectable so a test can read
  // the rows the start wrote.
  abtEthQuoteLockStorage: AbtEthQuoteLockStorage | undefined = undefined,
  // The payments the network recorded after their price hold that were worth
  // less than the agreed price. Built only when the rail is configured, for
  // the same reason as the lock storage above, and injectable so a test can
  // read the rows a short report wrote.
  abtEthShortPaymentStorage: AbtEthShortPaymentStorage | undefined = undefined,
): Express {
  const abtEthLocks: AbtEthQuoteLockStorage | null =
    abtEthPaymentRail === null ? null : (abtEthQuoteLockStorage ?? createAbtEthQuoteLockStorage());
  const abtEthShorts: AbtEthShortPaymentStorage | null =
    abtEthPaymentRail === null ? null : (abtEthShortPaymentStorage ?? createAbtEthShortPaymentStorage());
  // What holds a leg, for every door below: the rail, and whether the leg
  // waits on the owner (a payment that reached them worth less than the
  // agreed price, recorded short and not settled) or is half paid and the
  // buyer finishes it. One read of the short store, the settlement row and
  // both rails' half-paid records. A failed read throws; every caller
  // answers it as unavailable, never as "nothing held".
  function heldLegOf(jobId: string, leg: RouteLeg) {
    return legHold({
      jobId,
      leg,
      usdcRail: usdcPaymentRail,
      abtEthRail: abtEthPaymentRail,
      abtEthShorts,
      settlementRepo,
    });
  }
  // B88: one read of what holds a leg whose price transfer already reached
  // the owner, for the doors below. Answers { rail, awaitingOwner } (rail
  // null when nothing holds the leg), or answers 503 itself and returns null
  // when a read fails, so the route stops: a failed read is never taken for
  // "nothing held".
  async function readHeldRail(
    label: string,
    res: Response,
    jobId: string,
    leg: RouteLeg,
  ): Promise<{ readonly rail: Rail | null; readonly awaitingOwner: boolean } | null> {
    try {
      const held = await heldLegOf(jobId, leg);
      return { rail: held === null ? null : held.rail, awaitingOwner: held !== null && held.awaitingOwner };
    } catch (err) {
      console.error(`${label}: held-leg read failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return null;
    }
  }
  // B88: the lifecycle doors' refusal. A leg whose price transfer already
  // reached the owner holds the way a settled leg does: 409 with the
  // sentence for the action refused (the short-payment wording when the leg
  // waits on the owner), nothing written. Answers the response and returns
  // true when the route must stop (409 held, or 503 when the read failed).
  async function refuseWhenLegHeld(
    label: string,
    res: Response,
    jobId: string,
    leg: RouteLeg,
    action: HeldLegAction,
  ): Promise<boolean> {
    const held = await readHeldRail(label, res, jobId, leg);
    if (held === null) return true;
    if (held.rail === null) return false;
    res.status(409).json({ error: heldLegMessage(action, held.awaitingOwner) });
    return true;
  }
  // One repository behind both halves of the capability when the caller
  // supplies neither. createCredentialRepository() hands the memory driver a
  // fresh Map per call, so defaulting the adapter with its own separate call
  // would let this route store a credential the resolve route cannot find.
  // Prisma would never notice; the dev driver would, and a default that is
  // only wrong in dev is the kind that ships.
  const credentialsAdapter = credentials ?? createCredentialsAdapter(undefined, credentialRepo);
  const app = express();

  // S11 (security sweep 2026-09-06): the caller's real address, behind a
  // proxy. Must be set before any route or rate-limit bucket reads
  // req.ip/req.protocol, because both change meaning once this is set
  // (Express's own req.ip and req.protocol docs). Whoever fixes S7 must
  // fix S11 first: mounting a limiter more widely with no proxy trust
  // configured would turn one shared bucket into a platform-wide denial
  // of service for every caller behind the same proxy.
  try {
    app.set('trust proxy', trustProxySettingFromEnv());
  } catch {
    const raw = process.env[TRUST_PROXY_ENV_VAR] ?? '';
    throw new InvalidTrustProxyError(raw);
  }

  // S7 (security sweep 2026-09-06): every route class gets a bucket,
  // mounted in ONE place, here, after trust proxy and above the body parser
  // and web.mountPages(app) below -- so a page shell and every API route both
  // pass through it, and nothing registered after this point can be
  // reached without first being classified (rate-limit-classes.ts's
  // classifyRoute, and its own router-walk enforcement test). S11 above
  // (trust proxy) runs first, per the sweep's own rule: "whoever fixes S7
  // must fix S11 first". B80: it sits above express.json because it reads
  // only the method, the path, the Accept header and the caller's address,
  // never the body, so every request spends its bucket before its body is
  // read, a body the parser refuses included, and a caller over the limit is
  // answered 429 without the platform reading up to 15 MB from it.
  const classRateLimiters = createClassRateLimiters(rateLimits);
  app.use(createClassRateLimitMiddleware(classRateLimiters));

  app.use(
    express.json({
      // HT1 Part B (attachments STEER): an attachment travels as a
      // base64-encoded JSON field, never multipart (no new body-parsing
      // dependency for this one route). Base64 costs roughly 4/3 of the
      // original bytes, so the 10 MB attachment cap (MAX_ATTACHMENT_BYTES,
      // src/domain/attachment.ts) needs a body limit comfortably above
      // 13.3 MB; 15 MB leaves headroom for the JSON envelope around it.
      // Every other route's body is orders of magnitude smaller than this,
      // so raising the one global limit (rather than a second per-route
      // parser, which cannot re-read a stream express.json() already
      // consumed) costs nothing elsewhere. JSON_BODY_LIMIT is also the
      // number the "larger than 15 MB" sentence in request-errors.ts quotes.
      limit: JSON_BODY_LIMIT,
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.from(buf);
      },
    }),
  );
  // B69: what the parser refuses is the caller's mistake. Directly after the
  // parser so that only the parser's own errors (and the limiter's) can
  // reach it.
  app.use(bodyParserErrorHandler);

  // R-3 + R-4 completion (B5, launch blocker): the record of which DIDs'
  // key material this process has itself independently checked (via the
  // R-34 signing-key resolver's binding check below), so the default
  // identity adapter's resolveDid and verify have real key material to
  // derive from without ever calling out (invariant 2). Shared by both:
  // an agent proves its key by signing one request (e.g. the criteria
  // exchange), and the merge route can later name that same key on the
  // credential (ENT-8) with no new network call, only local recall. A
  // site-listed agent never signs a request, so the merge names its key by
  // re-deriving it from the platform seed instead (agentKeyForCredential).
  const knownKeys = createKnownKeyStore();
  const identityAdapter = identity ?? createIdentityAdapter(knownKeys, observedKeyRepo);

  // R-34: either an agent or an operator DID may sign (the issue's wording
  // is "a registered agent or operator DID"). A storage failure inside this
  // lookup throws, which createDidAbtSigningKeyResolver's own try/catch
  // turns into null -- an unverifiable signature, not a 500.
  const signingKeys = createDidAbtSigningKeyResolver(
    async (did) => (await agentRepo.findByDid(did)) !== null || (await repo.findByDid(did)) !== null,
    knownKeys,
    observedKeyRepo,
  );

  // R-34: adds a second, optional, verifiable identity path alongside the
  // hire-loop routes that carry it. Shared by didSignature (optional: an
  // unsigned request passes through untouched) and requireSessionOrSignature
  // (mandatory: the route below refuses outright when this returns 'absent'
  // and no session covers the gap either). A present-but-invalid signature
  // is worse than none in both callers, so both answer a refused signature
  // and an unknown key with their own distinct 401 rather than falling
  // through to "as if unsigned".
  //
  // B29: 'unknown-key' and a refused signature
  // are kept as two separate outcomes all the way out to the route layer, not
  // folded back into one here. A caller who signed correctly with a key this
  // service has simply never registered was being told their cryptography was
  // wrong; the real fact is narrower, and callers of this function need to be
  // able to tell the two apart to answer each with its own message.
  //
  // SW1-08: a refused signature carries the sentence for the check that
  // failed ({ refused }), from verifyWithReason in the adapter or, for the one
  // check the adapter never sees, the content-digest against the body
  // received. The three writers answer 401 { error: 'invalid signature: <the
  // sentence>' } through signatureRefusal below. 'unknown-key' keeps its own
  // answer.
  async function verifySignedRequest(req: Request): Promise<SignedRequestOutcome> {
    // Only a fully unsigned request is absent: absent both headers, this is
    // unchanged behaviour for every caller that exists today. Exactly one
    // present falls through to verifySignature below, which already refuses
    // a half-signed request with its own sentence (its first check answers
    // "send both the Signature-Input and Signature headers") -- restating
    // that check here would just be the same 401 twice.
    if (req.headers['signature-input'] === undefined && req.headers['signature'] === undefined) {
      return 'absent';
    }

    const targetUri = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
    const result = await verifySignature(
      { method: req.method, targetUri, headers: req.headers },
      signingKeys,
      { requiredComponents: REQUEST_SIGNATURE_COMPONENTS, spendStorage: signatureSpendStorage },
    );
    if (result.kind === 'unknown-key') return 'unknown-key';
    if (result.kind === 'invalid') return { refused: result.reason };

    // The adapter verifies the signature bytes; it never sees the body, so
    // the digest match is this function's half -- what binds the body
    // actually received to the signature that named it as covered.
    const raw = (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);
    const want = `sha-256=:${createHash('sha256').update(raw).digest('base64')}:`;
    const got = req.headers['content-digest'];
    if (typeof got !== 'string' || got.trim() !== want) {
      return { refused: 'content-digest does not match the request body' };
    }

    return { did: result.did };
  }

  // SW1-08: the one body all three writers answer for a refused signature,
  // so the prefix a client tests for ('invalid signature') is written once.
  const signatureRefusal = (reason: string): { error: string } => ({ error: `invalid signature: ${reason}` });

  // R-34: a second, optional, verifiable identity path alongside the four
  // ENT-6.2 party-exchange routes that carry it (criteria, request-changes,
  // accept, confirm) -- it never replaces a check that exists today on those
  // routes, because none does (no session, cookie or bearer token gates
  // them; only the caller-identity match inside each handler). POST /jobs,
  // POST /accounts and POST /agents no longer use this middleware: they are
  // gated by requireSessionOrSignature below instead (R-39 follow-up, issue
  // 83). Unsigned traffic on the four exchange routes is untouched; a
  // request that is signed wrong is refused rather than let through,
  // because a present-but-invalid signature is worse than none. Wrapped
  // like forwarded() below, for the same Express-4 reason: a rejected
  // promise here would otherwise vanish into an unhandled rejection.
  const didSignature = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const outcome = await verifySignedRequest(req);
      if (outcome === 'absent') {
        next();
        return;
      }
      if (outcome === 'unknown-key') {
        res.status(401).json({ error: 'unknown key' });
        return;
      }
      if ('refused' in outcome) {
        res.status(401).json(signatureRefusal(outcome.refused));
        return;
      }
      (req as SignedRequest).signerDid = outcome.did;
      next();
    })().catch(next);
  };

  // R-39 follow-up (issue 83): the bearer token an Authorization header
  // carries, or null for anything else (absent, wrong scheme, malformed).
  // Total, never throws, so the gate below treats a malformed header the
  // same as an absent one rather than crashing on it.
  function bearerTokenOf(req: Request): string | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1] ?? null;
  }

  // P8a (invariant 8): populates a session subject/method on the job
  // lifecycle routes that mount didSignature instead of
  // requireSessionOrSignature. Unlike requireSessionOrSignature, this
  // middleware never itself refuses a request: an absent, expired or
  // unresolvable bearer token leaves the request exactly as didSignature
  // alone already left it, so a caller with neither proof still meets
  // the route's own 401 (resolveActingParty answering null below), not a
  // second, earlier one here. Mounted immediately after didSignature, so
  // a present-but-invalid signature -- didSignature's own 401, answered
  // before this ever runs -- is never followed by a session lookup that
  // could paper over it (the same "a present-but-invalid signature is
  // refused outright" stance requireSessionOrSignature already documents
  // above).
  const populateSessionSubject = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const token = bearerTokenOf(req);
      if (token !== null) {
        const liveSession = await session.getSession(token);
        if (liveSession !== null) {
          (req as SessionedRequest).sessionSubject = liveSession.subject;
          (req as SessionedRequest).sessionMethod = liveSession.method;
        }
      }
      next();
    })().catch(next);
  };

  // R-39 follow-up (issue 83): hire and list routes (the identified set in
  // src/domain/access.ts -- POST /agents, POST /jobs) require EITHER a live
  // session OR a verified R-34 signature naming a party. Neither is a
  // fallback dressed up as the other: both are first-class, checked
  // independently, and either alone is sufficient (anchor: "A session is
  // required exactly where an account is required"). POST /accounts does
  // NOT use this gate: registering an operator is how an account is
  // created, not an action an account performs, so it cannot itself demand
  // one -- see D1/bootstrap-deadlock below on the route itself. A
  // present-but-invalid signature is refused outright, the same stance
  // didSignature takes, rather than silently falling back to a session
  // check that might also fail -- two wrongs reading as one 401 would hide
  // which credential was actually rejected. Only when no signature was
  // presented at all does the session check run; only when that also comes
  // up empty (absent, expired, or revoked -- getSession resolves all three
  // to null indistinguishably) does the route refuse, naming both ways a
  // caller can satisfy it.
  // S3+S4 (security sweep): the authentication core requireSessionOrSignature
  // wraps as Express middleware, factored out so a route that must check its
  // body's shape BEFORE authentication (key-rotation, compromise-report --
  // an unauthenticated caller must not learn anything about the request
  // from a shape error) can run the identical check manually, in the
  // handler, at the point in its own ordering that belongs to it, instead
  // of via a middleware that would always run first. One rule, one
  // function, two call sites: this and requireSessionOrSignature below
  // never diverge on what counts as authenticated.
  type AuthOutcome = 'ok' | { readonly refused: string } | 'unknown-key' | 'no-proof';
  async function authenticateRequest(req: Request): Promise<AuthOutcome> {
    const sigOutcome = await verifySignedRequest(req);
    if (sigOutcome === 'unknown-key') return 'unknown-key';
    if (typeof sigOutcome === 'object' && 'refused' in sigOutcome) return sigOutcome;
    if (sigOutcome !== 'absent') {
      (req as SignedRequest).signerDid = sigOutcome.did;
      return 'ok';
    }

    const token = bearerTokenOf(req);
    if (token !== null) {
      const liveSession = await session.getSession(token);
      if (liveSession !== null) {
        (req as SessionedRequest).sessionSubject = liveSession.subject;
        (req as SessionedRequest).sessionMethod = liveSession.method;
        return 'ok';
      }
    }

    return 'no-proof';
  }

  const requireSessionOrSignature = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const outcome = await authenticateRequest(req);
      if (outcome === 'unknown-key') {
        res.status(401).json({ error: 'unknown key' });
        return;
      }
      if (typeof outcome === 'object') {
        res.status(401).json(signatureRefusal(outcome.refused));
        return;
      }
      if (outcome === 'no-proof') {
        res.status(401).json({
          error:
            'this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34)',
        });
        return;
      }
      next();
    })().catch(next);
  };

  // S3+S4 (security sweep): the shared gate for a write route on an agent's
  // OWN record (key-rotation, compromise-report): the caller must
  // authenticate (401 with no proof at all, the same wording
  // requireSessionOrSignature uses) and must resolve to the agent's own
  // operator (isAgentOperator, by suffix). Ordering is deliberate and
  // matches the brief: the route checks its body's shape before ever
  // calling this, so 400 always precedes 401; this function then checks
  // authentication before resolving an account (403) and before looking up
  // the agent at all (404), so an unauthenticated caller cannot learn
  // whether the named DID is registered from the status code alone. Once
  // authenticated and once the agent is found, the operator match is the
  // last gate, and its refusal never names the real operator. Returns the
  // agent row on success so the caller need not look it up twice.
  async function requireCallerIsAgentOperator(
    label: string,
    req: Request,
    res: Response,
    did: string,
  ): Promise<Agent | null> {
    const outcome = await authenticateRequest(req);
    if (outcome === 'unknown-key') {
      res.status(401).json({ error: 'unknown key' });
      return null;
    }
    if (typeof outcome === 'object') {
      res.status(401).json(signatureRefusal(outcome.refused));
      return null;
    }
    if (outcome === 'no-proof') {
      res.status(401).json({
        error:
          'this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34)',
      });
      return null;
    }

    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return null;
    }
    if (actingParty === null) {
      res.status(403).json({
        error: 'no registered account resolves from your session or signature; register an account before acting on this agent',
      });
      return null;
    }

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return null;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return null;
    }
    // The 403 never names the real operator: it says only that the caller
    // is not it, so a stranger cannot use the refusal to learn who does
    // hold the seat.
    if (!isAgentOperator(actingParty, row.operatorDid)) {
      res.status(403).json({ error: `the authenticated party is not the operator of agent ${did}` });
      return null;
    }
    return row;
  }

  // FIX-B47b, Make 1: the shared gist-check the account-proof route (path
  // two) and a later proof-branch caller both run, moved into one closure
  // so neither implements the check twice. Returns an outcome; the CALLER
  // decides what to write (decision 5): path two keeps its R-5 downgrade
  // on a missing gist. `label` names the calling route in every
  // console.error this closure logs.
  type GistCheckOutcome =
    // `owner` is the gist author exactly as GitHub spells it. The check
    // compares it to the claimed handle without case, so a caller that
    // needs to STORE the login stores this spelling, the one a GitHub
    // session's subject carries.
    | { readonly kind: 'verified'; readonly owner: string }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'github-unavailable' }
    | { readonly kind: 'author-mismatch'; readonly author: string | null }
    | { readonly kind: 'no-statement' }
    | { readonly kind: 'malformed-signature' }
    | { readonly kind: 'candidate-key-rejected' }
    | { readonly kind: 'no-key-on-record' }
    | { readonly kind: 'identity-unavailable' }
    | { readonly kind: 'signature-invalid' };

  async function checkSignedGist(label: string, did: string, handle: string, gistId: string): Promise<GistCheckOutcome> {
    // R-4, direction two. Fetching the gist is a public, unauthenticated
    // read. A deleted gist (GistNotFoundError) is not a failure at all: it
    // is the check's answer, handled by the caller. Any other failure is a
    // platform-side unavailability, not an operator error.
    let gist: Gist;
    try {
      gist = await github.getPublicGist({ id: gistId });
    } catch (err) {
      if (err instanceof GistNotFoundError) {
        // R-5 (ENT-5.3): the gist no longer exists. That is not an outage;
        // it is the check resolving to "the proof no longer stands". What
        // that means for an existing binding is the CALLER's decision
        // (decision 5), never this closure's.
        return { kind: 'not-found' };
      }
      console.error(`${label}: github unavailable`, err);
      return { kind: 'github-unavailable' };
    }

    // The gist must be authored by the claimed account itself, not merely
    // linked from it: a forked or quoted gist would otherwise pass.
    if (gist.owner === null || gist.owner.toLowerCase() !== handle.toLowerCase()) {
      return { kind: 'author-mismatch', author: gist.owner };
    }

    // The statement may sit in any file of the gist; the first well-formed
    // one decides. A gist with no well-formed statement, or one that binds a
    // different DID or account, is a conflict: the operator can fix the gist.
    let statement: GistStatement | null = null;
    for (const content of Object.values(gist.files)) {
      statement = parseGistStatement(content);
      if (statement !== null) break;
    }
    if (statement === null || !statementBindsBinding(statement, did, handle)) {
      return { kind: 'no-statement' };
    }

    // A signature the verifier cannot even decode - bad base64, wrong length
    // for ed25519 - is garbage in the gist, intrinsic to the input: reject it
    // here, before letting a real verify primitive turn it into what reads as
    // a platform outage.
    if (!signatureIsWellFormed(statement.signature)) {
      return { kind: 'malformed-signature' };
    }

    // The signature covers the canonical bytes built from the DID and the
    // account URL, not the statement text as written: a third party
    // reconstructs the same bytes from the gist alone (invariant 2).
    //
    // PRF1 (B31): the statement's optional `key` line is passed
    // through as a candidate. identityAdapter.verify only trusts it after
    // checking it derives this agent's own DID (the same binding check
    // buildDidAbtLoader already applies), so this is never a bypass, only
    // a second source for a key the platform would otherwise need a prior
    // agent-signed request to have already observed.
    let checksOut: boolean;
    try {
      checksOut = await identityAdapter.verify({
        payload: gistProofPayload(did, githubAccountUrl(handle)),
        signature: statement.signature,
        signerDid: did,
        ...(statement.key !== undefined ? { candidateKeyMultibase: statement.key } : {}),
      });
    } catch (err) {
      // PRF1: an unresolvable DID
      // has two different remedies, both the operator's to fix, and they
      // differ. CandidateKeyRejectedError means a `key` line was present but
      // named a key that does not derive this agent's own DID. DidNotResolvableError
      // (per identity.ts's own contract, now only ever thrown when NO
      // candidate was offered at all) is the original B31 gap: the platform
      // genuinely has no key for this DID yet. Every other thrown error (the
      // identity subsystem itself failing) is a real platform fault.
      if (err instanceof CandidateKeyRejectedError) {
        console.error(`${label}: candidate key rejected`, err);
        return { kind: 'candidate-key-rejected' };
      }
      if (err instanceof DidNotResolvableError) {
        console.error(`${label}: identity verification failed`, err);
        return { kind: 'no-key-on-record' };
      }
      console.error(`${label}: identity verification failed`, err);
      return { kind: 'identity-unavailable' };
    }
    if (!checksOut) {
      return { kind: 'signature-invalid' };
    }
    return { kind: 'verified', owner: gist.owner };
  }

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // The public web surface, mounted BEFORE every API route. Order is the
  // mechanism: three page paths are also API paths, and the page handler
  // hands the request straight on unless the caller explicitly asked for
  // text/html. An API client's behaviour is unchanged by a single byte;
  // see src/web/static.ts for why the split is by Accept and nothing else.
  web.mountPages(app);

  // R-23: the identity boundary, stated before a user invests effort. No
  // storage, no adapter, synchronous, so no forwarded() wrapper and no 503
  // path applies here.
  app.get('/capabilities', (_req: Request, res: Response) => {
    res.status(200).json({
      notice: ACCESS_NOTICE,
      capabilities: CAPABILITIES.map(capabilityProjection),
      // SW1-08: how a request is signed, built from the constants the
      // verifier enforces, so an agent learns the profile before it sends one.
      signing: describeSigningProfile(),
    });
  });

  // Issue 84: the sign-in methods a user may choose, stated before a user
  // invests effort. This route authenticates nobody: no session, no OAuth,
  // no passkey, no middleware. No storage, no adapter, synchronous, so no
  // forwarded() wrapper and no 503 path applies here, the same as
  // GET /capabilities above.
  app.get('/sign-in-methods', (_req: Request, res: Response) => {
    res.status(200).json({
      methods: SIGN_IN_METHODS.map(signInMethodProjection),
    });
  });

  // ISS1 (B30): the one place a third party learns which DID is
  // FreeAgents' own issuer -- published outside any credential, so a
  // credential cannot forge it. Public, unauthenticated, cacheable: the
  // identity changes only when the deployment's signing key changes, so a
  // caller (or an intermediate cache) may hold this response for a while
  // without missing anything. The data comes from the SAME
  // credentialsAdapter every issuance route already shares, never a
  // second key.
  app.get('/.well-known/freeagents-issuer.json', async (_req: Request, res: Response) => {
    try {
      const description = await credentialsAdapter.describeIssuer();
      res
        .status(200)
        .set('Cache-Control', 'public, max-age=3600')
        .json(description);
    } catch (err) {
      console.error('GET /.well-known/freeagents-issuer.json: failed to describe the issuer', err);
      res.status(503).json({ error: 'issuer identity unavailable' });
    }
  });

  // P8b: wires the existing SessionAdapter to HTTP. The adapter itself
  // (src/adapters/identity/session-github-passkey.ts) already mints the
  // state, exchanges the callback, and issues the Session; this route is
  // the mount point, not a second implementation.
  //
  // SW4-06: the start also binds the sign-in to the browser that began it.
  // It sets one cookie, fa_oauth_state, holding the state it returns, and
  // the callback below completes a sign-in only when that cookie comes back
  // equal to the state in the query. Without it a callback link begun in
  // one browser would sign whoever opened it into the account that finished
  // GitHub's step. The cookie authorizes nothing (the session stays a
  // bearer token) and only the callback route reads it. B76: the one-click
  // proof's start (POST /agents/:agentDid/github-proof/start) sets the same
  // cookie through the same function, setOAuthStateCookie.
  //   - HttpOnly: no page script needs it.
  //   - SameSite=Lax, not Strict: the return from GitHub is a cross-site
  //     top-level GET, which a Strict cookie is withheld from and a Lax one
  //     is sent with.
  //   - Path=/auth/github/callback: sent nowhere else.
  //   - Max-Age=600: the state's own ten minute life
  //     (DEFAULT_OAUTH_STATE_TTL_MS in the session adapter).
  //   - Secure exactly when the redirect_uri inside the answer's own
  //     redirectUrl is https. That is read from the URL the browser is about
  //     to follow, so it holds behind a proxy that ends TLS whatever
  //     FREEAGENTS_TRUST_PROXY says, and plain-http local development keeps
  //     working.
  app.get('/auth/github/start', (_req: Request, res: Response, next: NextFunction) => {
    void session.beginGitHubOAuth().then((start) => {
      setOAuthStateCookie(res, start);
      res.status(200).json(start);
    }, next);
  });

  // P8b: the callback is one of the two unauthenticated entry points a
  // caller-supplied secret flows through, so it is mounted in the `verify`
  // class (rate-limit-classes.ts; FIX-S7 moved GET
  // /agents/:agentDid to `read`, so this route now shares the `verify`
  // bucket only with POST /auth/passkey/verify, POST /auth/passkey/signin
  // and GET
  // /v1/credentials/:credentialId). completeGitHubOAuth is total (never
  // throws): null covers every failure path (bad state, reused state,
  // expired state, provider refusal), so null maps to 401 without
  // inspecting which one it was, the same stance verifySignature's own
  // verify() takes.
  //
  // P8e: GitHub redirects the BROWSER here, not a JSON client, so this
  // route negotiates on the Accept header the same way src/web/static.ts's
  // `negotiated` pages do: a caller that explicitly asks for text/html
  // gets a page, and everything else -- `*/*` from fetch and curl, no
  // Accept header at all -- keeps the byte-identical JSON it answered
  // before this card, on every status code this route can answer.
  //
  // FIX-B47b2, Make 2 (FIX-B47b decision 1): the ONE callback also carries
  // the one-click proof's completion. peekOAuthStatePurpose tells this
  // route which flow a state is FOR before either completion method runs
  // its own single-use check, so a proof-purpose state never reaches
  // completeGitHubOAuth (which would refuse it anyway, decision 1
  // direction two) and a sign-in-purpose state never reaches
  // completeGitHubProofOAuth (direction one). GitHub's own refusal for the
  // proof flow arrives as error=access_denied&state=<state> with NO code
  // at all, so that one case is read from the state's purpose BEFORE the
  // missing-code 400 below; a sign-in callback with no code keeps its 400
  // byte for byte, since peeking a sign-in-purpose (or unknown) state
  // never satisfies the purpose.kind === 'proof' guard.
  app.get(
    '/auth/github/callback',
    (req: Request, res: Response, next: NextFunction) => {
      const wantsHtml = prefersHtml(req.headers.accept);
      const code = req.query['code'];
      const state = req.query['state'];
      const errorParam = req.query['error'];

      const purpose = typeof state === 'string' ? session.peekOAuthStatePurpose(state) : null;

      function sendProofOutcome(outcome: 'verified' | 'refused' | 'failed', agentDid: string): void {
        if (wantsHtml) {
          res.redirect(302, `/agentsettings?agent=${encodeURIComponent(agentDid)}&github=${outcome}`);
          return;
        }
        res.status(200).json({ outcome, agentDid });
      }

      // B76: a proof state is bound to the browser that pressed Confirm
      // GitHub, the same way a sign-in state is (SW4-06 below). Every
      // answer this route gives for a proof state clears fa_oauth_state on
      // its path: the decline, the refusals and every outcome, so a
      // finished or refused attempt leaves nothing behind.
      if (purpose !== null && purpose.kind === 'proof') {
        res.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_STATE_COOKIE_PATH });
      }

      // Decision 1 and 3: GitHub's own decline arrives with no code at
      // all. Read straight from the peeked purpose (nothing to exchange,
      // nothing to write) rather than falling into the missing-code 400
      // below, which stays reserved for sign-in. B76: the decline needs no
      // cookie. It exchanges nothing and publishes nothing, so an owner who
      // declines lands back on /agentsettings whichever browser it is.
      if (purpose !== null && purpose.kind === 'proof' && errorParam === 'access_denied') {
        sendProofOutcome('refused', purpose.agentDid);
        return;
      }

      if (typeof code !== 'string' || typeof state !== 'string') {
        if (wantsHtml) {
          res.status(400).set('Content-Type', 'text/html; charset=utf-8').send(web.renderAuthCallbackErrorPage());
          return;
        }
        res.status(400).json({ error: 'code and state are both required and must be strings' });
        return;
      }

      if (purpose !== null && purpose.kind === 'proof') {
        // B76: a proof completes only in the browser that began it. A
        // missing fa_oauth_state cookie, or one that differs from the
        // query's state, answers what an invalid proof state answers,
        // BEFORE completeGitHubProofOAuth runs: nothing is exchanged,
        // published or written, and the state stays unused, so the owner's
        // own browser can still finish it. Without this, a link begun by
        // the owner and opened by someone else would publish the proof
        // from that person's GitHub account and record the owner's agent
        // as it. The two values come from the same request and the state
        // is a random token, so the comparison is plain and exact.
        if (readCookie(req.headers.cookie, OAUTH_STATE_COOKIE) !== state) {
          if (wantsHtml) {
            res.status(401).set('Content-Type', 'text/html; charset=utf-8').send(web.renderAuthCallbackErrorPage());
            return;
          }
          res.status(401).json({ error: 'invalid or expired sign-in attempt' });
          return;
        }
        (async () => {
          const completion = await session.completeGitHubProofOAuth({ code, state });
          if (completion.kind === 'invalid-state') {
            if (wantsHtml) {
              res.status(401).set('Content-Type', 'text/html; charset=utf-8').send(web.renderAuthCallbackErrorPage());
              return;
            }
            res.status(401).json({ error: 'invalid or expired sign-in attempt' });
            return;
          }
          if (completion.kind === 'exchange-failed') {
            sendProofOutcome('failed', purpose.agentDid);
            return;
          }

          // completion.kind === 'ok'. Make item 4 (FIX-B47b decision 6):
          // deleteGrant runs no matter what happens next, so it is a
          // finally around everything the exchanged token authorizes.
          let outcome: 'verified' | 'failed' = 'failed';
          try {
            // Decision 2: re-check the agent still belongs to the account
            // that started this proof BEFORE publishing anything, off a
            // FRESH lookup -- the state is minted at start time and the
            // agent's operator could have changed in the meantime.
            const fresh = await agentRepo.findByDid(completion.agentDid);
            if (fresh === null || !isAgentOperator(completion.accountDid, fresh.operatorDid)) {
              console.error(
                'GET /auth/github/callback (proof): the agent no longer belongs to the account that started this proof',
                completion.agentDid,
              );
            } else {
              let signed: SignedPayload | null;
              try {
                signed = await identityAdapter.sign(
                  completion.agentDid,
                  gistProofPayload(completion.agentDid, githubAccountUrl(completion.login)),
                  fresh.operatorDid,
                  fresh.delegation.id,
                );
              } catch (err) {
                const cause =
                  err instanceof AgentKeyDerivationMismatchError || err instanceof PlatformSeedUnavailableError
                    ? err.message
                    : err;
                console.error('GET /auth/github/callback (proof): signing the statement failed', cause);
                signed = null;
              }
              if (signed !== null) {
                const statement = buildGistStatement({
                  did: completion.agentDid,
                  github: githubAccountUrl(completion.login),
                  signature: signed.signature,
                  ...(signed.publicKeyMultibase !== undefined ? { key: signed.publicKeyMultibase } : {}),
                });

                let gistId: string | null = null;
                try {
                  const created = await github.createGist({
                    token: completion.token,
                    filename: 'freeagents-github-proof.txt',
                    content: statement,
                  });
                  gistId = created.id;
                } catch (err) {
                  console.error('GET /auth/github/callback (proof): publishing the gist failed', err);
                }

                if (gistId !== null) {
                  const checkOutcome = await checkSignedGist(
                    'GET /auth/github/callback (proof)',
                    completion.agentDid,
                    completion.login,
                    gistId,
                  );
                  if (checkOutcome.kind === 'verified') {
                    try {
                      const updated = await agentRepo.updateGithubBinding(completion.agentDid, {
                        handle: completion.login,
                        status: 'verified',
                      });
                      if (updated === null) {
                        console.error(
                          'GET /auth/github/callback (proof): the agent was no longer registered at write time',
                          completion.agentDid,
                        );
                      } else {
                        outcome = 'verified';
                      }
                    } catch (err) {
                      console.error('GET /auth/github/callback (proof): storage failed writing the binding', err);
                    }
                  } else {
                    // Make item 4: a gist that was created but did not
                    // verify is deleted with the SAME token before the
                    // grant is deleted, and decision 5 keeps the old
                    // binding exactly as it was (no write happens here at
                    // all, on any checkOutcome but verified).
                    try {
                      await github.deleteGist({ token: completion.token, id: gistId });
                    } catch (err) {
                      console.error('GET /auth/github/callback (proof): deleting the unverified gist failed', err);
                    }
                  }
                }
              }
            }
          } finally {
            try {
              await github.deleteGrant({ token: completion.token });
            } catch (err) {
              // The outcome above stands regardless: the operator-only log
              // names the failure, never the token.
              console.error('GET /auth/github/callback (proof): deleting the OAuth grant failed', err);
            }
          }
          sendProofOutcome(outcome, completion.agentDid);
        })().catch(next);
        return;
      }

      // SW4-06: the sign-in branch completes only in the browser that began
      // it. The proof branch above is bound the same way (B76): its start,
      // POST /agents/:agentDid/github-proof/start, sets the same cookie
      // and the page stores it by sending that one request with
      // credentials same-origin. Here a missing cookie, or one that differs
      // from the query's state, answers what an invalid state answers,
      // BEFORE completeGitHubOAuth runs, so a refused attempt leaves its
      // state unused. The two values come from the same request and the
      // state is a random token, so the comparison is plain and exact.
      // Every answer from here on clears the cookie, so a finished or
      // refused attempt leaves nothing behind.
      res.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_STATE_COOKIE_PATH });
      if (readCookie(req.headers.cookie, OAUTH_STATE_COOKIE) !== state) {
        if (wantsHtml) {
          res.status(401).set('Content-Type', 'text/html; charset=utf-8').send(web.renderAuthCallbackErrorPage());
          return;
        }
        res.status(401).json({ error: 'invalid or expired sign-in attempt' });
        return;
      }

      void session.completeGitHubOAuth({ code, state }).then((completed) => {
        if (completed === null) {
          if (wantsHtml) {
            res.status(401).set('Content-Type', 'text/html; charset=utf-8').send(web.renderAuthCallbackErrorPage());
            return;
          }
          res.status(401).json({ error: 'invalid or expired sign-in attempt' });
          return;
        }
        if (wantsHtml) {
          res
            .status(200)
            .set('Content-Type', 'text/html; charset=utf-8')
            .send(web.renderAuthCallbackSuccessPage(completed));
          return;
        }
        res.status(200).json(completed);
      }, next);
    },
  );

  // FIX-B61a: register reads no body. The server makes the passkey name and
  // binds it to the ceremony, so a browser never picks the account. The
  // adapter throws when passkeys are not configured (a deployment fact, not
  // a caller error), which is the same 503 every unconfigured capability gets.
  app.post('/auth/passkey/register', (_req: Request, res: Response) => {
    const subject = 'pk-' + randomBytes(32).toString('base64url');
    void session.registerPasskey(subject).then(
      (options) => {
        res.status(200).json(options);
      },
      (err: unknown) => {
        console.error('POST /auth/passkey/register: adapter failed', err);
        res.status(503).json({ error: 'passkey sign-in is not configured on this deployment' });
      },
    );
  });

  // P8b: the second unauthenticated entry point taking a caller-supplied
  // secret (brief scope item 6), so it rides the same verify rate limiter
  // as the GitHub callback. null (a wrong response, an expired, reused or
  // already-bound attempt) is 401 without saying which. A throw means the
  // passkey could not be stored: 503, no session.
  app.post(
    '/auth/passkey/verify',
    (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { responseJson?: unknown };
      const responseJson = body.responseJson;
      if (typeof responseJson !== 'string' || responseJson.length === 0) {
        res.status(400).json({ error: 'body must be { responseJson }, a non-empty string' });
        return;
      }
      void session.verifyPasskey(responseJson).then(
        (completed) => {
          if (completed === null) {
            res.status(401).json({ error: 'invalid or expired sign-in attempt' });
            return;
          }
          res.status(200).json(completed);
        },
        (err: unknown) => {
          console.error('POST /auth/passkey/verify: storage failed', err);
          res.status(503).json({ error: 'storage unavailable' });
        },
      );
    },
  );

  // FIX-B61a: the returning half. No body: the browser offers the passkeys
  // it holds for this site. Same 503 sentence as register when unconfigured.
  app.post('/auth/passkey/signin/start', (_req: Request, res: Response) => {
    void session.beginPasskeySignIn().then(
      (options) => {
        res.status(200).json(options);
      },
      (err: unknown) => {
        console.error('POST /auth/passkey/signin/start: adapter failed', err);
        res.status(503).json({ error: 'passkey sign-in is not configured on this deployment' });
      },
    );
  });

  // FIX-B61a: the assertion is checked against the stored passkey, and the
  // account comes from the passkey, never from a name the caller sends. null
  // is 401 without saying which check failed; a throw is the store being
  // unreachable, 503, never 401 and never 500.
  app.post('/auth/passkey/signin', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { responseJson?: unknown };
    const responseJson = body.responseJson;
    if (typeof responseJson !== 'string' || responseJson.length === 0) {
      res.status(400).json({ error: 'body must be { responseJson }, a non-empty string' });
      return;
    }
    void session.completePasskeySignIn(responseJson).then(
      (completed) => {
        if (completed === null) {
          res.status(401).json({ error: 'invalid or expired sign-in attempt' });
          return;
        }
        res.status(200).json(completed);
      },
      (err: unknown) => {
        console.error('POST /auth/passkey/signin: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
      },
    );
  });

  // P8b: endSession is idempotent by contract (dead, unknown, and absent
  // tokens are all a no-op), so signing out is never a 401. A caller
  // asking to be signed out is not making a claim about their identity,
  // unlike every other bearer-token route in this file.
  app.post('/auth/signout', (req: Request, res: Response, next: NextFunction) => {
    const token = bearerTokenOf(req);
    if (token === null) {
      res.status(204).end();
      return;
    }
    void session.endSession(token).then(() => {
      res.status(204).end();
    }, next);
  });

  // R-39 follow-up (issue 83, D1/bootstrap-deadlock): registering an
  // operator is account CREATION, not an action an existing account
  // performs. The issue's own anchor names hire and list, and access.ts's
  // own doc comment says 'identified' means "body must name the acting
  // party", not "must authenticate" -- registration is how a party comes
  // to exist, so it cannot be conditioned on a credential that itself
  // presupposes one. Gating this route was proved to deadlock
  // every fresh deployment: no route mints a session before an operator
  // exists, and the signing-key resolver only accepts an already-registered
  // DID, so a self-signed request from a brand-new operator would ALSO be
  // refused. The identityField in access.ts ('did') is still the acting
  // party's own claim, checked below the same way it always was; only the
  // session-or-signature gate in front of it is gone.
  //
  // FIX-B62a (B62): the body is { did, githubLogin?, gist?,
  // passkeySubject? }. Registration stays open to anyone, but a GitHub
  // login on the row is a claim about a person, so it is stored only when
  // a public gist authored by that GitHub account, signed by this DID's
  // own key, proves it (the proof POST /agents/:agentDid/account-proof
  // already takes for agents). Why: resolveActingParty and the conduct
  // lookups trust the githubLogin column, so a login typed by a stranger
  // would make the person who really holds it act as, and be shown as,
  // the stranger's account. Leaving the login out registers the DID with
  // none.
  app.post('/accounts', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      did?: unknown;
      githubLogin?: unknown;
      gist?: unknown;
      passkeySubject?: unknown;
    };
    const did = body.did;
    const claimedLogin = body.githubLogin;
    const gist = body.gist;
    const passkeySubject = body.passkeySubject;

    if (
      typeof did !== 'string' ||
      did.length === 0 ||
      (claimedLogin !== undefined &&
        (typeof claimedLogin !== 'string' || claimedLogin.length === 0 || /\s/.test(claimedLogin))) ||
      (gist !== undefined && (typeof gist !== 'string' || gist.length === 0))
    ) {
      res.status(400).json({
        error:
          'body must be { did, githubLogin?, gist?, passkeySubject? }; did and githubLogin are non-empty strings, githubLogin has no whitespace, gist is a URL',
      });
      return;
    }
    if (claimedLogin !== undefined && gist === undefined) {
      res.status(400).json({
        error:
          "a GitHub login needs proof: publish a gist from that GitHub account, signed by this DID's key, and send its URL as gist; or leave githubLogin out",
      });
      return;
    }
    if (claimedLogin === undefined && gist !== undefined) {
      res.status(400).json({ error: 'gist proves a githubLogin; send both or neither' });
      return;
    }
    if (!isValidOperatorDid(did)) {
      res.status(400).json({
        error: 'did must look like did:abt:<suffix>, non-empty suffix, no whitespace',
      });
      return;
    }
    // passkeySubject is optional (design item 3): an account may register
    // with a proved GitHub login, a passkey subject, both, or (FIX-B62a)
    // neither, and bind the rest here or later.
    // Present-but-wrong-type or present-but-empty is a 400, the same shape
    // githubLogin's own guard takes, rather than silently dropping a value
    // the caller explicitly sent.
    if (passkeySubject !== undefined && (typeof passkeySubject !== 'string' || passkeySubject.length === 0)) {
      res.status(400).json({
        error: 'passkeySubject, if present, must be a non-empty string',
      });
      return;
    }

    // P8a: the session path this card adds resolves
    // an acting party through Account.did (resolveActingParty), which
    // proves only possession of an Account row -- never possession of a
    // key. An agent's DID is delegated by its operator's Ed25519 key
    // (POST /agents) and is public (GET /agents lists it), so leaving this
    // route free to bind ANY did, including an already-delegated agent's
    // own, would let anyone claim that Account and, from a session alone,
    // act as the agent on every lifecycle route this card opens to
    // sessions -- turning "acting as the agent" from "holds the
    // delegation key" into "was first to POST this string". Refusing the
    // registration outright (409, the same status and shape a duplicate
    // Account already answers with) closes that gap while leaving the
    // bootstrap-deadlock path this route exists for untouched: a genuinely
    // new operator or buyer DID, one no Agent has ever claimed, still
    // registers exactly as it always has.
    let agentAlreadyClaimsDid: boolean;
    try {
      agentAlreadyClaimsDid = (await agentRepo.findByDid(did)) !== null;
    } catch (err) {
      console.error('POST /accounts: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (agentAlreadyClaimsDid) {
      res.status(409).json({
        error: `${did} is already delegated to an agent; an agent's own DID cannot be claimed as an Account`,
      });
      return;
    }

    // FIX-B62a: the proof. Everything above is a refusal that needs no
    // network; GitHub is asked only now, and the row is written only after
    // it answers `verified`. Every login comparison here ignores case
    // (GitHub logins do), and the row stores the spelling GitHub gave
    // (the gist author), the one a GitHub session's subject carries.
    let provedLogin: string | null = null;
    if (typeof claimedLogin === 'string' && typeof gist === 'string') {
      const gistRef: GistUrlRef | null = parseGistUrl(gist);
      if (gistRef === null) {
        res.status(400).json({ error: 'gist must be a URL like https://gist.github.com/<owner>/<id>' });
        return;
      }
      if (gistRef.owner.toLowerCase() !== claimedLogin.toLowerCase()) {
        res.status(409).json({
          error: `the gist URL owner ${gistRef.owner} does not match the claimed githubLogin ${claimedLogin}`,
        });
        return;
      }
      const outcome = await checkSignedGist('POST /accounts', did, claimedLogin, gistRef.id);
      switch (outcome.kind) {
        case 'verified':
          provedLogin = outcome.owner;
          break;
        case 'not-found':
          res.status(409).json({ error: 'the gist does not resolve: check the URL, and that the gist is public' });
          return;
        case 'github-unavailable':
          res.status(503).json({ error: 'github unavailable' });
          return;
        case 'author-mismatch':
          res.status(409).json({
            error: `the gist author ${outcome.author ?? 'unknown'} does not match the claimed githubLogin ${claimedLogin}`,
          });
          return;
        case 'no-statement':
          res.status(409).json({
            error: 'the gist does not hold a well-formed statement binding this DID to this GitHub account',
          });
          return;
        case 'malformed-signature':
          res.status(409).json({
            error: 'the signature field is not a well-formed ed25519 signature (base64, 64 bytes)',
          });
          return;
        case 'candidate-key-rejected':
          res.status(409).json({
            error: `the key line does not derive ${did}; check the publicKeyMultibase on the key line is this DID's own key`,
          });
          return;
        case 'no-key-on-record':
          res.status(409).json({
            error:
              "this DID has no key on record yet; add a `key: <publicKeyMultibase>` line to the gist statement naming this DID's own key",
          });
          return;
        case 'identity-unavailable':
          res.status(503).json({ error: 'identity verification unavailable' });
          return;
        case 'signature-invalid':
          res.status(409).json({ error: "the signature does not check out against this DID's key" });
          return;
      }

      // A proved login already on another account is refused with the
      // sentence that is true for it, before register() could turn the
      // unique column into a false "operator <did> is already registered".
      // The stored column matches exactly, so every spelling in play (the
      // one GitHub gave, the one the caller typed, and lower case) is
      // looked up; a row written before this rule may hold any of them.
      // A row that belongs to this same DID is not "another account": that
      // case falls through to register(), which answers that the DID is
      // already registered, the sentence that is true for it.
      try {
        for (const spelling of new Set([provedLogin, claimedLogin, provedLogin.toLowerCase()])) {
          const holder = await repo.findByGithubLogin(spelling);
          if (holder !== null && holder.did !== did) {
            res.status(409).json({ error: `the GitHub login ${provedLogin} is already bound to another account` });
            return;
          }
        }
      } catch (err) {
        console.error('POST /accounts: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
    }

    try {
      const row = await repo.register({
        did,
        ...(provedLogin === null ? {} : { githubLogin: provedLogin }),
        ...(passkeySubject === undefined ? {} : { passkeySubject }),
      });
      res.status(201).json(accountProjection(row));
    } catch (err) {
      // A duplicate DID is a 409: the operator registered it already, and
      // the message tells them what to check.
      if (err instanceof AccountAlreadyExistsError) {
        res.status(409).json({ error: `operator ${did} is already registered` });
        return;
      }
      // Anything else (a dead database, a disk error) is our problem, not the operator's:
      // 503 with the cause in the log, not the body, so a dead database fails closed.
      console.error('POST /accounts: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // P8m: GET /accounts/me. The wireframe needs no such route (a static
  // mock never resolves a live session to a DID), but the built page's
  // My jobs link into GET /accounts/:did/jobs needs the caller's own DID
  // to put in the path, and nothing until now turned a live session or a
  // verified signature into the caller's own account record: every
  // existing resolveActingParty call site already had a DID from
  // elsewhere (a job's buyerDid/agentDid, or an unrelated route's own
  // :did). Named here as the handoff departure this line forced.
  // Guarded the same way every other acting-party route is: no proof at
  // all is 401 (requireSessionOrSignature's own wording), and a live
  // session with no registered account is provisioned on the spot
  // exactly as resolveActingParty already does for every other route.
  app.get('/accounts/me', requireSessionOrSignature, async (req: Request, res: Response) => {
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('GET /accounts/me: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (actingParty === null) {
      res.status(401).json({ error: sessionOrSignatureRequiredMessage('the account reading its own record') });
      return;
    }
    try {
      const row = await repo.findByDid(actingParty);
      if (row === null) {
        // A verified signature names a real DID with no Account row
        // (an agent-only identity, R-34's own case): there is nothing
        // to provision from a bare signature (provisionAccountForSession
        // only ever runs off a live session, per resolveActingParty's
        // own header comment), so this reads as absent rather than a
        // synthesised row.
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(ownAccountProjection(row));
    } catch (err) {
      console.error('GET /accounts/me: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.get('/accounts/:did', async (req: Request, res: Response) => {
    try {
      const row = await repo.findByDid(String(req.params.did));
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(accountProjection(row));
    } catch (err) {
      console.error('GET /accounts/:did: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // S3, Ruling 4 / P8c: the ONLY way an account's payout addresses are ever
  // set, on any of the three rails (USDC on Arbitrum, ABT on ArcBlock, ABT
  // on Ethereum). Guarded by requireSessionOrSignature (401 with no
  // proof at all) and then by the resolved acting party equalling :did
  // (403 for a registered stranger; the domain rule is "an account may
  // only set its own address", never "the caller differs from the buyer"
  // -- there is no buyer here at all, only the account itself). Cannot
  // ride POST /accounts, which is deliberately unauthenticated to avoid
  // the fresh-deployment bootstrap deadlock (app.ts:900's own comment): a
  // settable recipient field on that route would be the same hole
  // wearing a different hat.
  app.patch('/accounts/:did/operator-address', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('PATCH /accounts/:did/operator-address: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (actingParty === null) {
      res.status(403).json({
        error: 'no registered account resolves from your session or signature; register an account before setting an operator address',
      });
      return;
    }
    if (actingParty !== did) {
      res.status(403).json({ error: 'an account may only set its own operator address' });
      return;
    }

    // Any one of the three addresses alone is a valid request, and a body
    // naming none of them is refused. Each address is its own value on its
    // own network: no field is ever filled from another.
    const body = (req.body ?? {}) as {
      operatorAddressEvm?: unknown;
      operatorAddressAbt?: unknown;
      operatorAddressAbtEth?: unknown;
      confirmContractAddress?: unknown;
    };
    if (body.operatorAddressEvm === undefined && body.operatorAddressAbt === undefined && body.operatorAddressAbtEth === undefined) {
      res.status(400).json({
        error: 'body must name at least one of operatorAddressEvm, operatorAddressAbt and operatorAddressAbtEth',
      });
      return;
    }
    if (body.operatorAddressEvm !== undefined && (typeof body.operatorAddressEvm !== 'string' || !isValidOperatorAddressEvm(body.operatorAddressEvm))) {
      res.status(400).json({
        error: 'operatorAddressEvm must be an EVM address matching /^0x[0-9a-fA-F]{40}$/',
      });
      return;
    }
    if (body.operatorAddressAbt !== undefined && (typeof body.operatorAddressAbt !== 'string' || !isValidOperatorAddressAbt(body.operatorAddressAbt))) {
      res.status(400).json({
        error: 'operatorAddressAbt must be an ABT DID suffix, the same shape isValidOperatorDid enforces on did:abt:<suffix>',
      });
      return;
    }
    if (body.operatorAddressAbtEth !== undefined && (typeof body.operatorAddressAbtEth !== 'string' || !isValidOperatorAddressEvm(body.operatorAddressAbtEth))) {
      res.status(400).json({
        error: 'operatorAddressAbtEth must be an Ethereum address matching /^0x[0-9a-fA-F]{40}$/',
      });
      return;
    }

    // The two Ethereum-style boxes are checked before anything is written:
    // the checksum first (a mistyped address is refused outright), then what
    // that box's own network says about the address. USDC is on Arbitrum and
    // ABT is on Ethereum, so each field is asked on its own network.
    const evmBoxes: { readonly field: 'operatorAddressEvm' | 'operatorAddressAbtEth'; readonly network: OperatorAddressNetwork; readonly address: string; readonly warning: string }[] = [];
    if (typeof body.operatorAddressEvm === 'string') {
      evmBoxes.push({
        field: 'operatorAddressEvm',
        network: 'arbitrum',
        address: body.operatorAddressEvm,
        warning:
          'This address on Arbitrum holds contract code, so it may be a contract and not an ordinary wallet. USDC sent to a contract only arrives if the contract was built to receive it. Check the address in your wallet before you save it.',
      });
    }
    if (typeof body.operatorAddressAbtEth === 'string') {
      evmBoxes.push({
        field: 'operatorAddressAbtEth',
        network: 'ethereum',
        address: body.operatorAddressAbtEth,
        warning:
          'This address on Ethereum holds contract code, so it may be a contract and not an ordinary wallet. ABT sent to a contract only arrives if the contract was built to receive it. Check the address in your wallet before you save it.',
      });
    }
    const checked = await Promise.all(evmBoxes.map((box) => operatorAddressCheck.check(box.network, box.address)));
    for (let i = 0; i < evmBoxes.length; i += 1) {
      if (!(checked[i] as { checksumOk: boolean }).checksumOk) {
        res.status(400).json({
          error: `${(evmBoxes[i] as { field: string }).field} does not pass its checksum, so a character is probably mistyped; copy the address from your wallet again`,
        });
        return;
      }
    }
    if (body.confirmContractAddress !== true) {
      const contractBoxes = evmBoxes.filter((_box, i) => (checked[i] as { holdsContractCode: boolean | null }).holdsContractCode === true);
      if (contractBoxes.length > 0) {
        res.status(409).json({
          error: contractBoxes.map((box) => box.warning).join(' '),
          contractAddressFields: contractBoxes.map((box) => box.field),
          confirmField: 'confirmContractAddress',
        });
        return;
      }
    }

    try {
      // Each field writes independently, through its own repository call,
      // so a body naming only one never touches another's stored value
      // (S3's own stance on operatorAddressEvm, unchanged; P8c widens it
      // to a second field and the Ethereum ABT address to a third). Every
      // check above has passed, so a refusal of any field wrote none.
      let row: Account | null = null;
      if (body.operatorAddressEvm !== undefined) {
        row = await repo.setOperatorAddressEvm(did, body.operatorAddressEvm as string);
        if (row === null) {
          res.status(404).json({ error: 'not found' });
          return;
        }
      }
      if (body.operatorAddressAbt !== undefined) {
        row = await repo.setOperatorAddressAbt(did, body.operatorAddressAbt as string);
        if (row === null) {
          res.status(404).json({ error: 'not found' });
          return;
        }
      }
      if (body.operatorAddressAbtEth !== undefined) {
        row = await repo.setOperatorAddressAbtEth(did, body.operatorAddressAbtEth as string);
        if (row === null) {
          res.status(404).json({ error: 'not found' });
          return;
        }
      }
      res.status(200).json(ownAccountProjection(row as Account));
    } catch (err) {
      console.error('PATCH /accounts/:did/operator-address: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // ==========================================================================
  // HT1 Part B: the hire thread (messages, reactions, edits, read receipts,
  // typing, the live stream), per-account notifications, browser Web Push
  // subscriptions and message attachments. One contiguous block, matching
  // the payment surface's own region-fence convention above.
  // ==========================================================================

  // The thread's own read/write gate (item 3 of the brief): "readable and
  // writable only by the job's two parties, and by the agent's own DID
  // only when negotiatesOnOwnersBehalf is on." Loads the job, resolves
  // the caller to a party (401/403 exactly like every other job route),
  // and applies requireThreadAccess. Returns the job and the caller's
  // identity, or null after already answering.
  async function requireThreadParty(
    label: string,
    jobId: string,
    req: Request,
    res: Response,
  ): Promise<{ readonly did: string; readonly job: Job; readonly party: Party } | null> {
    const job = await loadForExchange(label, jobId, res);
    if (job === null) return null;
    const gate = await resolveJobActingParty(req, res, job);
    if (gate === null) return null;
    if (!(await requireThreadAccess(label, res, job, gate.did, gate.party))) return null;
    return { did: gate.did, job, party: gate.party };
  }

  // GET /jobs/:jobId/messages: every message in the thread, oldest first
  // (MessageRepository.listByJobId's own convention). Available whether
  // the job is open or terminal (read-only never means unreadable): the
  // brief's own words, "stays open through the hire, and becomes
  // read-only once the job reaches a terminal status" -- read-only is a
  // WRITE restriction, checked only on the write routes below.
  app.get(
    '/jobs/:jobId/messages',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/messages';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      try {
        const rows = await messageRepo.listByJobId(gate.job.id);
        res.status(200).json({ messages: rows.map((row) => messageProjection(row)) });
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // POST /jobs/:jobId/messages: post a message. Refused once the thread
  // is read-only (a terminal job), and refused for the agent's own key
  // exactly where every other negotiation route already refuses it (the
  // original brief's own line: "the negotiation routes are:...and
  // posting a message"). authorKind is derived, never taken from the
  // body (the same "never trust the caller's own claim of identity"
  // stance every party-exchange route in this file already takes).
  app.post(
    '/jobs/:jobId/messages',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/messages';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      if (!threadIsWritable(gate.job.status)) {
        res.status(409).json({ error: new ThreadReadOnlyError(gate.job.id).message });
        return;
      }
      const body = (req.body ?? {}) as { body?: unknown; replyToId?: unknown; attachmentIds?: unknown };
      // Shape only: a string, no longer than the cap. Whether an EMPTY
      // body is allowed depends on attachmentIds (checked below and
      // resolved by createMessage itself, MSG1a make item 5) -- this
      // check does not duplicate that content rule, only the type and
      // length every body must satisfy regardless.
      if (typeof body.body !== 'string' || body.body.length > MESSAGE_BODY_MAX_LENGTH) {
        res.status(400).json({
          error: `body must be { body, replyToId?, attachmentIds? }; body a string up to ${MESSAGE_BODY_MAX_LENGTH} characters, empty only when attachmentIds names at least one qualifying attachment`,
        });
        return;
      }
      if (body.replyToId !== undefined && body.replyToId !== null && typeof body.replyToId !== 'string') {
        res.status(400).json({ error: 'replyToId, if present, must be a string or null' });
        return;
      }
      // attachmentIds names attachments this SAME
      // caller already uploaded to this SAME job (POST
      // /jobs/:jobId/attachments, above), and not already attached to
      // an earlier message -- an attachment is a one-time reference, so
      // a caller cannot replay someone else's upload id onto their own
      // message, and a message cannot silently absorb an attachment
      // twice.
      if (
        body.attachmentIds !== undefined &&
        (!Array.isArray(body.attachmentIds) || body.attachmentIds.some((id) => typeof id !== 'string'))
      ) {
        res.status(400).json({ error: 'attachmentIds, if present, must be an array of strings' });
        return;
      }
      const attachmentIds = (body.attachmentIds as string[] | undefined) ?? [];
      let existing: readonly Message[];
      try {
        existing = await messageRepo.listByJobId(gate.job.id);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      const attachmentRefs: MessageAttachmentRef[] = [];
      if (attachmentIds.length > 0) {
        const alreadyAttached = new Set(existing.flatMap((row) => row.attachments.map((a) => a.attachmentId)));
        for (const attachmentId of attachmentIds) {
          let attachment: Attachment | null;
          try {
            attachment = await attachmentRepo.findById(attachmentId);
          } catch (err) {
            console.error(`${label}: storage failed`, err);
            res.status(503).json({ error: 'storage unavailable' });
            return;
          }
          if (
            attachment === null ||
            attachment.jobId !== gate.job.id ||
            attachment.uploaderDid !== gate.did ||
            alreadyAttached.has(attachmentId)
          ) {
            res.status(400).json({
              error: `attachmentIds must name attachments the caller already uploaded to this job and not yet attached to another message: ${attachmentId} does not qualify`,
            });
            return;
          }
          // FIX-SW4f: the sweep removes an unsent upload after the TTL.
          if (unsentUploadExpired(attachment.createdAt, new Date())) {
            res.status(400).json({ error: `${attachmentId} expired before it was sent; upload the file again.` });
            return;
          }
          attachmentRefs.push({ attachmentId });
        }
      }
      const authorKind = authorKindFor(gate.party, gate.party === 'agent' && gate.did === gate.job.agentDid);
      let message: Message;
      try {
        message = createMessage(
          {
            id: 'm-' + randomBytes(8).toString('hex'),
            jobId: gate.job.id,
            authorDid: gate.did,
            authorParty: gate.party,
            authorKind,
            body: body.body,
            replyToId: (body.replyToId as string | null | undefined) ?? null,
            existingMessageIds: new Set(existing.map((row) => row.id)),
            attachments: attachmentRefs,
          },
          new Date(),
        );
      } catch (err) {
        if (err instanceof MessageError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      try {
        const row = await messageRepo.create(message);
        if (attachmentRefs.length > 0) {
          // FIX-SW4f: record which message carries each upload, so the quota
          // stops counting it and the sweep keeps it. The message is stored:
          // a failure here is logged, and the sweep records it later.
          try {
            await attachmentRepo.markSent(attachmentRefs.map((ref) => ref.attachmentId), row.id);
          } catch (err) {
            console.error(`${label}: markSent failed for message ${row.id}; the message is stored`, err);
          }
        }
        broadcastThreadEvent(gate.job.id, 'message', messageProjection(row));
        const excludeDid = gate.party === 'agent' && gate.did !== gate.job.agentDid ? gate.job.agentDid : gate.did;
        await notifyJobParties(gate.job, 'new_message', excludeDid);
        res.status(201).json(messageProjection(row));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // PATCH /jobs/:jobId/messages/:messageId: edit within 15 minutes, full
  // history kept (src/domain/message.ts's own editMessage). Only the
  // ORIGINAL author may edit their own message -- never the other party,
  // and never a system row (editMessage itself refuses a system row;
  // this route additionally refuses a caller editing someone else's).
  app.patch(
    '/jobs/:jobId/messages/:messageId',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'PATCH /jobs/:jobId/messages/:messageId';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      if (!threadIsWritable(gate.job.status)) {
        res.status(409).json({ error: new ThreadReadOnlyError(gate.job.id).message });
        return;
      }
      const body = (req.body ?? {}) as { body?: unknown };
      if (!messageBodyWellFormed(body.body)) {
        res.status(400).json({ error: `body must be { body }; a non-empty string up to ${MESSAGE_BODY_MAX_LENGTH} characters` });
        return;
      }
      let existing: Message | null;
      try {
        existing = await messageRepo.findById(String(req.params.messageId));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (existing === null || existing.jobId !== gate.job.id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (existing.authorDid !== gate.did) {
        res.status(403).json({ error: 'only the original author may edit this message' });
        return;
      }
      let edited: Message;
      try {
        edited = editMessage(existing, body.body, new Date());
      } catch (err) {
        if (err instanceof MessageEditWindowExpiredError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof MessageError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      try {
        const row = await messageRepo.update(edited);
        if (row === null) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        broadcastThreadEvent(gate.job.id, 'message', messageProjection(row));
        res.status(200).json(messageProjection(row));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // POST /jobs/:jobId/messages/:messageId/reactions: one per party per
  // message, any single emoji, replace on re-react (src/domain/message.ts's
  // reactToMessage). A DELETE on the same path removes it.
  app.post(
    '/jobs/:jobId/messages/:messageId/reactions',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/messages/:messageId/reactions';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      if (!threadIsWritable(gate.job.status)) {
        res.status(409).json({ error: new ThreadReadOnlyError(gate.job.id).message });
        return;
      }
      const body = (req.body ?? {}) as { emoji?: unknown };
      if (!isSingleEmoji(body.emoji)) {
        res.status(400).json({ error: 'body must be { emoji }; a single emoji character' });
        return;
      }
      let existing: Message | null;
      try {
        existing = await messageRepo.findById(String(req.params.messageId));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (existing === null || existing.jobId !== gate.job.id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      let reacted: Message;
      try {
        reacted = reactToMessage(existing, gate.party, body.emoji);
      } catch (err) {
        if (err instanceof MessageError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      try {
        const row = await messageRepo.update(reacted);
        if (row === null) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        broadcastThreadEvent(gate.job.id, 'message', messageProjection(row));
        res.status(200).json(messageProjection(row));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  app.delete(
    '/jobs/:jobId/messages/:messageId/reactions',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'DELETE /jobs/:jobId/messages/:messageId/reactions';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      if (!threadIsWritable(gate.job.status)) {
        res.status(409).json({ error: new ThreadReadOnlyError(gate.job.id).message });
        return;
      }
      let existing: Message | null;
      try {
        existing = await messageRepo.findById(String(req.params.messageId));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (existing === null || existing.jobId !== gate.job.id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      try {
        const row = await messageRepo.update(removeReaction(existing, gate.party));
        if (row === null) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        broadcastThreadEvent(gate.job.id, 'message', messageProjection(row));
        res.status(200).json(messageProjection(row));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // GET /jobs/:jobId/messages/read-state: both parties' lastReadAt
  // (read receipts were write-only -- POST recorded
  // a mark, but nothing ever showed the OTHER party's position, so a
  // client could never render "Read 2:14 PM"). Available to either
  // party regardless of which one's receipt is being asked about: the
  // brief's own words, "read receipts: per-party lastReadAt," readable
  // by both parties like every other thread fact.
  app.get(
    '/jobs/:jobId/messages/read-state',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/messages/read-state';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      try {
        const [buyerState, agentState] = await Promise.all([
          threadReadStateRepo.findByJobAndParty(gate.job.id, 'buyer'),
          threadReadStateRepo.findByJobAndParty(gate.job.id, 'agent'),
        ]);
        res.status(200).json({
          jobId: gate.job.id,
          buyer: { lastReadAt: buyerState === null ? null : buyerState.lastReadAt.toISOString() },
          agent: { lastReadAt: agentState === null ? null : agentState.lastReadAt.toISOString() },
        });
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // POST /jobs/:jobId/messages/read: read receipts, per-party lastReadAt,
  // monotonic (advanceReadState never regresses it). Available on a
  // read-only thread too: marking read is not a write to the CONVERSATION,
  // only to the reader's own position in it.
  app.post(
    '/jobs/:jobId/messages/read',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/messages/read';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      try {
        const current = await threadReadStateRepo.findByJobAndParty(gate.job.id, gate.party);
        const advanced = advanceReadState(current, gate.job.id, gate.party, new Date());
        await threadReadStateRepo.record(advanced);
        const projected = { jobId: advanced.jobId, party: advanced.party, lastReadAt: advanced.lastReadAt.toISOString() };
        // The SSE half: the other party's live
        // connection learns of this read the same way it learns of a
        // new message, rather than needing to poll read-state.
        broadcastThreadEvent(gate.job.id, 'read-state', projected);
        res.status(200).json(projected);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // POST /jobs/:jobId/typing: the typing signal. Deliberately NOT
  // persisted (a signal, not a stored fact) -- broadcast only, to
  // whichever SSE subscribers are listening on this thread right now. A
  // client with no open SSE connection simply never sees it, which is
  // the correct behaviour for a signal this ephemeral.
  app.post(
    '/jobs/:jobId/typing',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/typing';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      if (!threadIsWritable(gate.job.status)) {
        res.status(409).json({ error: new ThreadReadOnlyError(gate.job.id).message });
        return;
      }
      broadcastThreadEvent(gate.job.id, 'typing', { party: gate.party });
      res.status(204).end();
    }),
  );

  // GET /jobs/:jobId/messages/stream: the live stream (Server-Sent
  // Events), authenticated exactly like every other job route above.
  // "Fallback to polling for a client that cannot hold an SSE
  // connection" is GET /jobs/:jobId/messages itself: this route adds
  // nothing that route cannot already answer, only pushes it live.
  // The cap applies (SW4-04): a stream is one request that never ends, so
  // the request limiter cannot bound what it holds. One caller may hold
  // STREAM_LIMIT_PER_TARGET of these per job and STREAM_LIMIT_PER_CALLER
  // across every stream, counted after the party check (a stranger still
  // gets its 403) and before any header is written or any subscription is
  // made (a refused stream never hears a message). A place comes back when
  // the connection closes.
  app.get(
    '/jobs/:jobId/messages/stream',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/messages/stream';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      const place = streamCaps.acquire(gate.did, `thread:${gate.job.id}`);
      if (typeof place === 'string') {
        refuseStream(res, refusalSentence('thread', place));
        return;
      }
      // The client may have left while the checks above awaited; its close
      // event is already past, so the place is given back here instead.
      if (!holdUntilClosed(place, res)) return;
      res.status(200);
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.flushHeaders?.();
      let subscribers = threadStreams.get(gate.job.id);
      if (subscribers === undefined) {
        subscribers = new Set();
        threadStreams.set(gate.job.id, subscribers);
      }
      subscribers.add(res);
      req.on('close', () => {
        subscribers?.delete(res);
      });
    }),
  );

  // GET /accounts/:did/notifications: the plain notification list and
  // unread count (item 3's own scope limit: "build only the operator's
  // unread badge and a plain notification list... nothing more
  // elaborate"). Gated to the account's own DID: a notification is
  // addressed to exactly one account, never shared.
  app.get('/accounts/:did/notifications', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('GET /accounts/:did/notifications: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (actingParty === null) {
      res.status(403).json({
        error: 'no registered account resolves from your session or signature; register an account to see its notifications',
      });
      return;
    }
    if (actingParty !== did) {
      res.status(403).json({ error: 'an account may only read its own notifications' });
      return;
    }
    try {
      const rows = await notificationRepo.listByAccountDid(did);
      res.status(200).json({
        notifications: rows.map((row) => notificationProjection(row)),
        unreadCount: unreadCountOf(rows),
      });
    } catch (err) {
      console.error('GET /accounts/:did/notifications: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.post('/accounts/:did/notifications/:notificationId/read', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('POST /accounts/:did/notifications/:notificationId/read: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only mark its own notifications read' });
      return;
    }
    try {
      const row = await notificationRepo.markRead(String(req.params.notificationId), did, new Date());
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(notificationProjection(row));
    } catch (err) {
      console.error('POST /accounts/:did/notifications/:notificationId/read: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // GET /accounts/:did/notifications/stream: the badge's own live update,
  // the identical SSE shape the thread stream above uses, and the same cap
  // (SW4-04): at most STREAM_LIMIT_PER_TARGET for this account's
  // notifications and STREAM_LIMIT_PER_CALLER across every stream the
  // account holds, counted after the owner check and before any header or
  // subscription, released when the connection closes.
  app.get('/accounts/:did/notifications/stream', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('GET /accounts/:did/notifications/stream: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only stream its own notifications' });
      return;
    }
    const place = streamCaps.acquire(did, `notifications:${did}`);
    if (typeof place === 'string') {
      refuseStream(res, refusalSentence('notifications', place));
      return;
    }
    // The client may have left while the checks above awaited; see the thread stream.
    if (!holdUntilClosed(place, res)) return;
    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();
    let subscribers = notificationStreams.get(did);
    if (subscribers === undefined) {
      subscribers = new Set();
      notificationStreams.set(did, subscribers);
    }
    subscribers.add(res);
    req.on('close', () => {
      subscribers?.delete(res);
    });
  });

  // GET /push/vapid-public-key: the browser's own PushManager.subscribe()
  // needs the VAPID public key as applicationServerKey. Public by design
  // (a VAPID public key is meant to be published); null when push is
  // unconfigured on this deployment, so the client can hide the "enable
  // notifications" control rather than fail a subscribe attempt.
  app.get('/push/vapid-public-key', (_req: Request, res: Response) => {
    res.status(200).json({ publicKey: pushSender.publicKey });
  });

  // POST /accounts/:did/push-subscriptions: registers a browser's Push API
  // subscription (the standard PushSubscription.toJSON() shape). Upsert
  // by endpoint (PushSubscriptionRepository's own stance), except that an
  // endpoint another account already holds is refused (FIX-SW4b,
  // SW4-02): a subscription belongs to the account that registered it.
  app.post('/accounts/:did/push-subscriptions', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('POST /accounts/:did/push-subscriptions: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only register its own push subscription' });
      return;
    }
    const body = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (
      typeof body.endpoint !== 'string' || body.endpoint.length === 0 ||
      typeof body.keys?.p256dh !== 'string' || body.keys.p256dh.length === 0 ||
      typeof body.keys?.auth !== 'string' || body.keys.auth.length === 0
    ) {
      res.status(400).json({ error: 'body must be { endpoint, keys: { p256dh, auth } }, the standard PushSubscription.toJSON() shape' });
      return;
    }
    // FIX-SW4a (SW4-08): the endpoint is an address the platform
    // will send to, so it must be https on the public internet. A browser's
    // push service always is; a loopback, private, link-local or metadata
    // address, plain http or file: is refused here, before anything is
    // stored, and again at send time by the push sender.
    if (!isOutboundDestinationAllowed(body.endpoint)) {
      res.status(400).json({
        error: "endpoint must be the https address your browser's push service gave; private, loopback and link-local addresses are refused",
      });
      return;
    }
    try {
      // FIX-SW4b (SW4-02): the upsert is keyed by endpoint alone, so
      // without this look-up a POST naming another account's endpoint would
      // move that row to the caller with the caller's keys. The same account
      // posting its own endpoint again (a browser renewing its keys) passes.
      const holder = await pushSubscriptionRepo.findByEndpoint(body.endpoint);
      if (holder !== null && holder.accountDid !== did) {
        res.status(409).json({
          error: 'this push address is registered to another account; turn notifications off there, or subscribe again for a new address',
        });
        return;
      }
      const row = await pushSubscriptionRepo.upsert({
        id: 'ps-' + randomBytes(8).toString('hex'),
        accountDid: did,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        createdAt: new Date(),
      });
      res.status(201).json({ id: row.id, endpoint: row.endpoint });
    } catch (err) {
      console.error('POST /accounts/:did/push-subscriptions: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  app.delete('/accounts/:did/push-subscriptions', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('DELETE /accounts/:did/push-subscriptions: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only remove its own push subscription' });
      return;
    }
    const body = (req.body ?? {}) as { endpoint?: unknown };
    if (typeof body.endpoint !== 'string' || body.endpoint.length === 0) {
      res.status(400).json({ error: 'body must be { endpoint }' });
      return;
    }
    try {
      // FIX-SW4b (SW4-02): removes the caller's own row only. The
      // answer is 204 whether or not a row was removed, so it tells a caller
      // nothing about an endpoint another account holds.
      await pushSubscriptionRepo.removeForAccount(did, body.endpoint);
      res.status(204).end();
    } catch (err) {
      console.error('DELETE /accounts/:did/push-subscriptions: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // FIX-SW4f (SW4-05): removes uploads no message carries once they
  // are older than UNSENT_UPLOAD_TTL_MS. Called from the upload route, at
  // most once per UNSENT_SWEEP_INTERVAL_MS for this app, with no timer; the
  // run is recorded before anything is awaited and it never throws. Per old
  // row (oldest first, at most UNSENT_SWEEP_BATCH): a message that carries it
  // gets its id recorded and the row kept; otherwise the files (full, then
  // thumbnail) and then the row are removed. A failed row is logged, not fatal.
  let lastUnsentSweepAt = Number.NEGATIVE_INFINITY;
  async function sweepUnsentUploads(): Promise<void> {
    const startedAt = Date.now();
    if (startedAt - lastUnsentSweepAt < UNSENT_SWEEP_INTERVAL_MS) return;
    lastUnsentSweepAt = startedAt;
    try {
      const old = await attachmentRepo.listUnsentOlderThan(new Date(startedAt - UNSENT_UPLOAD_TTL_MS), UNSENT_SWEEP_BATCH);
      for (const row of old) {
        try {
          const carrying = (await messageRepo.listByJobId(row.jobId)).find((message) =>
            message.attachments.some((ref) => ref.attachmentId === row.id),
          );
          if (carrying !== undefined) {
            await attachmentRepo.markSent([row.id], carrying.id);
            continue;
          }
          await removeAttachmentFile(row.path);
          if (row.thumbnailPath !== null) await removeAttachmentFile(row.thumbnailPath);
          await attachmentRepo.remove(row.id);
        } catch (err) {
          console.error(`unsent upload sweep: could not clear upload ${row.id}`, err);
        }
      }
    } catch (err) {
      console.error('unsent upload sweep: could not list unsent uploads', err);
    }
  }

  // FIX-SW4f (SW4-05): makes the quota and the admission one step.
  // The route decodes and writes before its row exists, so stored rows alone
  // let every upload arriving meanwhile pass. An admitted upload holds a place
  // under the caller's DID until its request ends; the count adds held places
  // to stored rows. Places live in this process only, like the sweep's clock.
  // The check and the hold run in one synchronous stretch after the rows
  // return. A release by the same DID during the read could leave an upload
  // in neither the rows nor the places, so the read is repeated then; another
  // DID's release never does. A DID's state lives while it holds or reads.
  interface UnsentUploadState { held: Map<string, string>; released: number; reads: number }
  const unsentUploadStates = new Map<string, UnsentUploadState>();
  const dropIdleState = (did: string, state: UnsentUploadState): void => {
    if (state.reads === 0 && state.held.size === 0) unsentUploadStates.delete(did);
  };
  async function reserveUnsentUpload(did: string, jobId: string, uploadId: string): Promise<'job' | 'account' | null> {
    const state = unsentUploadStates.get(did) ?? { held: new Map<string, string>(), released: 0, reads: 0 };
    unsentUploadStates.set(did, state);
    state.reads += 1;
    try {
      for (;;) {
        const releasedBefore = state.released;
        const stored = await attachmentRepo.listUnsentByUploader(did, new Date(Date.now() - UNSENT_UPLOAD_TTL_MS));
        if (state.released !== releasedBefore) continue;
        const storedIds = new Set(stored.map((row) => row.id));
        const now = new Date();
        const pending = [...state.held]
          .filter(([heldId]) => !storedIds.has(heldId))
          .map(([, heldJobId]) => ({ jobId: heldJobId, messageId: null, createdAt: now }));
        const reached = unsentUploadCapReached([...stored, ...pending], jobId, now);
        if (reached !== null) return reached;
        state.held.set(uploadId, jobId);
        return null;
      }
    } finally {
      state.reads -= 1;
      dropIdleState(did, state);
    }
  }
  function releaseUnsentUpload(did: string, uploadId: string): void {
    const state = unsentUploadStates.get(did);
    if (state === undefined) return;
    state.held.delete(uploadId);
    state.released += 1;
    dropIdleState(did, state);
  }

  // POST /jobs/:jobId/attachments (attachments STEER): base64-encoded
  // upload, checked from its own bytes (assertAttachmentAllowed), never
  // its declared filename or content type. Images are decoded and
  // re-encoded (sharp) so EXIF/GPS never survives; the original bytes
  // are never written to disk. Refused once the thread is read-only,
  // the same gate every other write route above already applies.
  app.post(
    '/jobs/:jobId/attachments',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/attachments';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      if (!threadIsWritable(gate.job.status)) {
        res.status(409).json({ error: new ThreadReadOnlyError(gate.job.id).message });
        return;
      }
      const body = (req.body ?? {}) as { filename?: unknown; dataBase64?: unknown };
      if (typeof body.filename !== 'string' || body.filename.length === 0 || typeof body.dataBase64 !== 'string' || body.dataBase64.length === 0) {
        res.status(400).json({ error: 'body must be { filename, dataBase64 }; dataBase64 the file bytes, base64-encoded, up to 10 MB' });
        return;
      }
      // FIX-SW4f (SW4-05): sweep old unsent uploads, then refuse the
      // caller past either cap, after the checks above (a stranger still gets
      // 403, a read-only thread 409) and before anything is decoded or written.
      await sweepUnsentUploads();
      const id = randomFileId();
      let capReached: 'job' | 'account' | null;
      try {
        capReached = await reserveUnsentUpload(gate.did, gate.job.id, id);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (capReached !== null) {
        res.setHeader('retry-after', String(UNSENT_UPLOAD_RETRY_AFTER_SECONDS));
        res.status(429).json({ error: unsentUploadSentence(capReached) });
        return;
      }
      try {
        let bytes: Buffer;
        try {
          bytes = Buffer.from(body.dataBase64, 'base64');
        } catch {
          res.status(400).json({ error: 'dataBase64 is not valid base64' });
          return;
        }
        let kind;
        try {
          kind = assertAttachmentAllowed(bytes);
        } catch (err) {
          if (err instanceof AttachmentError) {
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }
        const dir = attachmentsDirFromEnv();
        let storedPath: string;
        let thumbnailPath: string | null = null;
        if (isImageKind(kind)) {
          let reencoded;
          try {
            reencoded = await reencodeImage(bytes, kind === 'image/heic');
          } catch (err) {
            if (err instanceof ImageReencodeError) {
              console.error(`${label}: image re-encode failed`, err.detail);
              res.status(400).json({ error: err.message });
              return;
            }
            throw err;
          }
          storedPath = await writeAttachmentFile(dir, id, reencoded.bytes);
          thumbnailPath = await writeAttachmentFile(dir, id + '-thumb', reencoded.thumbnailBytes);
        } else {
          // A PDF has no EXIF/GPS payload to strip (the domain's own
          // header comment); the uploaded bytes, already verified by
          // their magic bytes above, are stored verbatim.
          storedPath = await writeAttachmentFile(dir, id, bytes);
        }
        let attachment: Attachment;
        try {
          attachment = await attachmentRepo.create({
            id,
            jobId: gate.job.id,
            uploaderDid: gate.did,
            kind,
            originalFilename: body.filename,
            sizeBytes: bytes.length,
            path: storedPath,
            thumbnailPath,
            messageId: null,
            createdAt: new Date(),
          });
        } catch (err) {
          console.error(`${label}: storage failed`, err);
          // FIX-SW4f: the files were written first; nothing else would remove them.
          for (const orphan of thumbnailPath === null ? [storedPath] : [storedPath, thumbnailPath]) {
            try {
              await removeAttachmentFile(orphan);
            } catch (removeErr) {
              console.error(`${label}: could not remove the file of an upload that was not stored`, removeErr);
            }
          }
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        res.status(201).json({
          id: attachment.id,
          jobId: attachment.jobId,
          kind: attachment.kind,
          contentType: contentTypeFor(attachment.kind),
          originalFilename: attachment.originalFilename,
          sizeBytes: attachment.sizeBytes,
          createdAt: attachment.createdAt.toISOString(),
        });
      } finally {
        releaseUnsentUpload(gate.did, id);
      }
    }),
  );

  // GET /jobs/:jobId/attachments (MSG1a, Make item 2): the sent-
  // attachments list -- so the other party can name a file ("roadmap.pdf,
  // PDF, 2.1 MB") without downloading every upload first. Gated by
  // requireThreadParty, the same gate every other route in this block
  // uses. Only attachments a message in this thread actually references
  // are listed: an upload nobody has sent yet stays invisible, because
  // AttachmentRepository.listByJobId returns every upload (sent or not)
  // and this route is what narrows that down against the thread's own
  // messages. Oldest first, matching listByJobId's own convention.
  app.get(
    '/jobs/:jobId/attachments',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/attachments';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      try {
        const [messages, attachments] = await Promise.all([
          messageRepo.listByJobId(gate.job.id),
          attachmentRepo.listByJobId(gate.job.id),
        ]);
        const messageIdByAttachmentId = new Map<string, string>();
        for (const message of messages) {
          for (const ref of message.attachments) {
            messageIdByAttachmentId.set(ref.attachmentId, message.id);
          }
        }
        const sent = attachments
          .filter((attachment) => messageIdByAttachmentId.has(attachment.id))
          .map((attachment) => ({
            id: attachment.id,
            messageId: messageIdByAttachmentId.get(attachment.id)!,
            kind: attachment.kind,
            contentType: contentTypeFor(attachment.kind),
            originalFilename: attachment.originalFilename,
            sizeBytes: attachment.sizeBytes,
            createdAt: attachment.createdAt.toISOString(),
          }));
        res.status(200).json({ attachments: sent });
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // GET /jobs/:jobId/attachments/:attachmentId: serves only to the job's
  // two parties, through the identical thread-access gate every other
  // route in this block uses. Content-Disposition: attachment for a PDF
  // (attachments STEER: "PDFs are served as downloads... never opened
  // inline"), X-Content-Type-Options: nosniff and a restrictive CSP on
  // every response, image or PDF alike. MSG1a (Make item 4): the
  // full-size content-type is contentTypeFor(attachment.kind) -- what
  // the bytes actually are (every image kind re-encodes to JPEG on
  // upload, src/adapters/attachments/image.ts) -- never the uploaded
  // `kind` itself, so a PNG or HEIC upload is never served as
  // image/png or image/heic over JPEG bytes. The thumbnail path is
  // always a JPEG (reencodeImage's own thumbnail output), unchanged.
  app.get(
    '/jobs/:jobId/attachments/:attachmentId',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/attachments/:attachmentId';
      const gate = await requireThreadParty(label, String(req.params.jobId), req, res);
      if (gate === null) return;
      let attachment: Attachment | null;
      try {
        attachment = await attachmentRepo.findById(String(req.params.attachmentId));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (attachment === null || attachment.jobId !== gate.job.id) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const wantsThumbnail = req.query.thumbnail === '1' || req.query.thumbnail === 'true';
      const path = wantsThumbnail && attachment.thumbnailPath !== null ? attachment.thumbnailPath : attachment.path;
      let bytes: Buffer;
      try {
        bytes = await readAttachmentFile(path);
      } catch (err) {
        console.error(`${label}: could not read the stored attachment file`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'none'; sandbox");
      res.setHeader('content-type', wantsThumbnail && attachment.thumbnailPath !== null ? 'image/jpeg' : contentTypeFor(attachment.kind));
      if (attachment.kind === 'application/pdf') {
        res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(attachment.originalFilename)}"`);
      }
      res.status(200).send(bytes);
    }),
  );

  // MSG1a (Make item 1): GET /accounts/:did/threads, the conversation
  // list for BOTH seats -- the buyer's own hires (GET
  // /accounts/:did/jobs, every status, unlike that route which excludes
  // draft/proposed) and the owner's agents' hires (GET
  // /accounts/:did/incoming's roster, but every status, not only
  // draft/proposed). Built from the same parts in the same order as
  // both of those routes: resolveActingParty, then a 403 that never
  // says whether :did is a registered account or how many threads it
  // has.
  //
  // A job where the account is both buyer and owner (a self-hire)
  // appears once, as the buyer -- partyForDid's own resolution order
  // (buyer checked before agent) is mirrored here by building the
  // buyer set first and excluding any job id already claimed by it from
  // the agent-seat set.
  app.get('/accounts/:did/threads', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('GET /accounts/:did/threads: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    // Neither a stranger nor an unresolved caller ever learns whether
    // :did is a registered account or how many threads it has: the
    // refusal is identical whether or not the account exists.
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only read its own thread list' });
      return;
    }

    if (typeof jobRepo.findByBuyerDid !== 'function') {
      console.error('GET /accounts/:did/threads: storage does not support findByBuyerDid');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (typeof jobRepo.findByAgentDid !== 'function') {
      console.error('GET /accounts/:did/threads: storage does not support findByAgentDid');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (typeof agentRepo.listAll !== 'function') {
      console.error('GET /accounts/:did/threads: storage does not support listAll');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const buyerJobs = await jobRepo.findByBuyerDid(did);
      const buyerJobIds = new Set(buyerJobs.map((job) => job.id));

      // The exact `row.operatorDid === did` comparison GET
      // /accounts/:did/incoming already uses, never isAgentOperator's
      // didSuffix match: one account's roster must mean the same thing
      // on every route, and a caller whose DID shares a suffix with the
      // real operator must never inherit that operator's roster
      // (mutation-proof test: hire-thread-list.test.ts's
      // roster-collision case).
      const agentRows = await agentRepo.listAll();
      const ownAgents = agentRows.filter((row) => row.operatorDid === did);
      const findByAgentDid = jobRepo.findByAgentDid.bind(jobRepo);
      const perAgentJobs = await Promise.all(ownAgents.map((row) => findByAgentDid(row.did)));
      // A self-hire (this account is both buyer and agent's operator)
      // appears once, as the buyer: any job already in the buyer set is
      // excluded here, mirroring partyForDid's own buyer-first order.
      const agentSeatJobs = perAgentJobs.flat().filter((job) => !buyerJobIds.has(job.id));

      // SW1-09: the clocks run on both seats, after the self-hire
      // exclusion above, so a self-hired job is clocked once, as the
      // buyer's.
      const clock = liveLapsesForList('GET /accounts/:did/threads');
      const clockedBuyerJobs = await clock(buyerJobs);
      const clockedAgentSeatJobs = await clock(agentSeatJobs);

      const rows: Array<{ readonly job: Job; readonly seat: Party }> = [
        ...clockedBuyerJobs.map((job) => ({ job, seat: 'buyer' as const })),
        ...clockedAgentSeatJobs.map((job) => ({ job, seat: 'agent' as const })),
      ];

      // One agent/message/read-state lookup per DISTINCT job, not
      // recomputed per row (the same per-distinct-key caching every
      // other list route in this file already uses).
      const distinctAgentDids = [...new Set(rows.map((r) => r.job.agentDid))];
      const agentByDid = new Map<string, Agent | null>();
      await Promise.all(
        distinctAgentDids.map(async (agentDid) => {
          agentByDid.set(agentDid, await agentRepo.findByDid(agentDid));
        }),
      );
      const distinctBuyerDids = [...new Set(rows.map((r) => r.job.buyerDid))];
      const accountByDid = new Map<string, Account | null>();
      await Promise.all(
        distinctBuyerDids.map(async (buyerDid) => {
          accountByDid.set(buyerDid, await repo.findByDid(buyerDid));
        }),
      );
      // The counterpart account for a BUYER seat is the agent's own
      // operator (never the buyer's own account, which is the caller
      // here) -- a second, distinct set of lookups keyed by operatorDid,
      // resolved once per distinct operator, not once per row.
      const distinctOperatorDids = [
        ...new Set(distinctAgentDids.map((agentDid) => agentByDid.get(agentDid)?.operatorDid).filter((d): d is string => d !== undefined)),
      ];
      await Promise.all(
        distinctOperatorDids.map(async (operatorDid) => {
          if (!accountByDid.has(operatorDid)) {
            accountByDid.set(operatorDid, await repo.findByDid(operatorDid));
          }
        }),
      );

      const messagesByJobId = new Map<string, readonly Message[]>();
      const readStateByJobId = new Map<string, ThreadReadState | null>();
      await Promise.all(
        rows.map(async (r) => {
          const [messages, readState] = await Promise.all([
            messageRepo.listByJobId(r.job.id),
            threadReadStateRepo.findByJobAndParty(r.job.id, r.seat),
          ]);
          messagesByJobId.set(r.job.id, messages);
          readStateByJobId.set(r.job.id, readState);
        }),
      );

      const threads = rows.map((r) => {
        const { job, seat } = r;
        const messages = messagesByJobId.get(job.id) ?? [];
        const readState = readStateByJobId.get(job.id) ?? null;
        const agentRow = agentByDid.get(job.agentDid) ?? null;
        // The counterpart is the OTHER side: the agent's operator for a
        // buyer, the buyer for an owner. The login is null when that
        // account has none (a passkey-only account) or is unregistered.
        const counterpartDid = seat === 'buyer' ? (agentRow?.operatorDid ?? job.agentDid) : job.buyerDid;
        const counterpartGithubLogin = accountByDid.get(counterpartDid)?.githubLogin ?? null;
        return {
          jobId: job.id,
          status: job.status,
          writable: threadIsWritable(job.status),
          seat,
          brief: job.brief,
          createdAt: job.createdAt.toISOString(),
          agentDid: job.agentDid,
          agentName: agentRow?.name ?? job.agentDid,
          avatarSpec: resolveAvatar(agentRow?.avatarSpec ?? null, job.agentDid),
          counterpartDid,
          counterpartGithubLogin,
          lastActivityAt: lastActivityAtOf(job.createdAt, messages).toISOString(),
          lastMessage: (() => {
            const lm = lastMessageOf(messages);
            if (lm === null) return null;
            return {
              authorParty: lm.authorParty,
              authorKind: lm.authorKind,
              bodyPreview: lm.bodyPreview,
              attachmentCount: lm.attachmentCount,
              systemEventType: lm.systemEventType,
              createdAt: lm.createdAt.toISOString(),
            };
          })(),
          unreadCount: threadUnreadCount(seat, messages, readState === null ? null : readState.lastReadAt),
        };
      });

      threads.sort((a, b) => {
        const diff = new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
        if (diff !== 0) return diff;
        return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
      });

      const unreadTotal = threads.reduce((sum, t) => sum + t.unreadCount, 0);
      res.status(200).json({ threads, unreadTotal });
    } catch (err) {
      console.error('GET /accounts/:did/threads: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-19 (D4, ENT-1.2): the operator roster. ANCHOR: an operator page is the
  // sum of who they run, never a score for the operator. Widens the same
  // browse-card assembly R-20 built (toBrowseCard, agentWorkRecord), so a
  // roster row and a browse card can never drift for the same agent; the
  // aggregate is derived structurally from those same rows
  // (operatorAggregate, src/domain/operator-roster.ts), three separate
  // tier totals, never a caller-supplied number and never a blended score.
  //
  // Sort and filter (D4, above ten agents only, enforced client-side in
  // operator.js): ?sort and ?skill are read the same way GET /agents reads
  // them, reusing resolveBrowseSort and filterBySkill rather than a second
  // rule for the same two query parameters (Review finding, run 76, defect
  // inert-control-affordance: the controls must drive this route, the
  // exact mechanism browse's controls already drive).
  app.get('/accounts/:did/agents', async (req: Request, res: Response) => {
    const operatorDid = String(req.params.did);
    const sort = resolveBrowseSort(req.query.sort);
    const skillFilter = typeof req.query.skill === 'string' ? req.query.skill : null;

    let operatorRow: Account | null;
    try {
      operatorRow = await repo.findByDid(operatorDid);
    } catch (err) {
      console.error('GET /accounts/:did/agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (operatorRow === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    if (typeof agentRepo.listAll !== 'function') {
      console.error('GET /accounts/:did/agents: storage does not support listAll');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const rows = await agentRepo.listAll();
      const ownAgents = rows.filter((row) => row.operatorDid === operatorDid);
      const unsorted: BrowseCard[] = await Promise.all(
        ownAgents.map(async (row) => {
          const stored = await credentialRepo.listBySubjectDid(row.did);
          const evidence = credentialEvidenceOf(stored);
          const record = agentWorkRecord(evidence);
          return toBrowseCard(row, record);
        }),
      );
      // The aggregate is always over the FULL roster (item 1 of the R-19
      // card: no field derived from a wider or narrower population than
      // its own tier), so it is computed before filtering narrows the rows
      // that get rendered. A skill filter narrows what a visitor sees, not
      // what the operator is accountable for in the summary line.
      const aggregate = operatorAggregate(unsorted);
      const filtered = filterBySkill(unsorted, skillFilter);
      const cards = sortBrowseCards(filtered, sort);

      res.status(200).json({
        operatorDid,
        agents: cards,
        agentCount: unsorted.length,
        aggregate,
      });
    } catch (err) {
      console.error('GET /accounts/:did/agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // P8m: the buyer's own list of everything they have hired (P-16, brief
  // scope item 1). Reads jobRepo.findByBuyerDid, the same optional-method
  // stance buyerConductForDid and GET /agents/:agentDid/hires already
  // take: a driver that omits it is 503, never a silent empty list.
  // Private to its own account (scope item 2), not a public profile:
  // requireSessionOrSignature refuses no proof at all with 401 (the same
  // sessionOrSignatureRequiredMessage wording every other gated route
  // here uses), and the resolved party must equal :did or the route
  // refuses with 403 that names neither the account nor its job count,
  // the same stance requireCallerIsAgentOperator already takes at its own
  // 403 (app.ts:1044-1046 as measured on main).
  app.get('/accounts/:did/jobs', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('GET /accounts/:did/jobs: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    // Neither a stranger nor an unresolved caller ever learns whether
    // :did is a registered account or how many jobs it has (scope item
    // 2): the refusal is identical whether or not the account exists.
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only read its own job list' });
      return;
    }

    // findByBuyerDid is optional on JobRepository (the same stance
    // findCompletedByAgent already takes); a driver that omits it fails
    // the same way a driver that throws does (done-means item 3).
    if (typeof jobRepo.findByBuyerDid !== 'function') {
      console.error('GET /accounts/:did/jobs: storage does not support findByBuyerDid');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const stored = await jobRepo.findByBuyerDid(did);
      // ENT-4.1 (scope item 3): a job does not exist until the buyer
      // confirms. draft and proposed are excluded HERE, by the route,
      // never merely hidden by the page -- job-list.ts's own fifth
      // bucket value ('notReal') is what this filter reads. No clock
      // moves a draft or proposed job, so the filter runs first and the
      // clocks only see jobs that exist.
      const real = stored.filter((job) => jobListBucketOf(job.status) !== 'notReal');
      // SW1-09: the clocks run on every row this list reports, so a hire
      // whose deadline passed reads as ended without anyone opening it.
      const clocked = await liveLapsesForList('GET /accounts/:did/jobs')(real);
      const sorted = [...clocked].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      // One agent lookup per DISTINCT agent, not per row (the same
      // per-distinct-key caching withBuyerGithubLogins already uses
      // above): a buyer with several hires from the same agent pays for
      // that lookup once.
      const agentNameByDid = new Map<string, string>();
      const jobRows = await Promise.all(
        sorted.map(async (job) => {
          if (!agentNameByDid.has(job.agentDid)) {
            const agentRow = await agentRepo.findByDid(job.agentDid);
            agentNameByDid.set(job.agentDid, agentRow?.name ?? job.agentDid);
          }
          const date = jobListDateOf(job);
          return {
            id: job.id,
            brief: job.brief,
            agentName: agentNameByDid.get(job.agentDid) ?? job.agentDid,
            repository: job.repository,
            status: job.status,
            bucket: jobListBucketOf(job.status),
            date: date === null ? null : date.toISOString(),
          };
        }),
      );
      res.status(200).json({ jobs: jobRows });
    } catch (err) {
      console.error('GET /accounts/:did/jobs: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // P8p: GET /accounts/:did/incoming, the read of what work has been offered
  // to agents. Two callers, one route: an operator reads what has been
  // offered to the agents they run (the operator's own words:
  // "I thought we were just a intermediary between the two parties",
  // 2026-09-07), and an agent signing with its own key reads what has been
  // offered to it (SW3-12: without this an agent holding a brief had no read
  // that led to it). Built from the same parts in the same order as
  // GET /accounts/:did/jobs above: resolveActingParty, then a 403 that
  // never says whether :did is a registered account or agent, or how many
  // agents or offers it has. The party must be :did itself, so an owner's
  // session or a sibling agent's key never reads an agent's list.
  //
  // The roster is one of two things. When :did names a registered agent
  // (an agent's DID is never an account's), the roster is that agent alone
  // and the answer is { agentDid, offers }. Otherwise it comes from
  // agentRepo.listAll() filtered by the exact `row.operatorDid === did`
  // comparison GET /accounts/:did/agents uses above, not isAgentOperator's
  // didSuffix match: one account's roster must mean the same thing on both
  // routes, and a caller whose DID shares a suffix with the real operator
  // must never inherit that operator's roster. That answer is
  // { operatorDid, offers }. Neither roster looks at
  // negotiatesOnOwnersBehalf.
  //
  // Answers 200 with one entry per job whose jobListBucketOf(status) is
  // 'notReal' (draft or proposed, ENT-4.1): the exact complement of the
  // buyer's own list above. This route never scores, ranks by anything
  // but its own timestamp, or judges either party (the scope fence):
  // there is no recommended, urgent, or priority field.
  app.get('/accounts/:did/incoming', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('GET /accounts/:did/incoming: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    // Neither a stranger nor an unresolved caller ever learns whether
    // :did is a registered account or how many agents or offers it has:
    // the refusal is identical whether or not the account exists.
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only read its own incoming list' });
      return;
    }

    if (typeof agentRepo.listAll !== 'function') {
      console.error('GET /accounts/:did/incoming: storage does not support listAll');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (typeof jobRepo.findByAgentDid !== 'function') {
      console.error('GET /accounts/:did/incoming: storage does not support findByAgentDid');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      // An agent's DID is never an account's (POST /accounts and both
      // agent listing doors refuse the other's DID), so a :did that names a
      // registered agent can only be that agent reading with its own key:
      // its roster is itself and nothing else. Any other :did is an account
      // and keeps the roster of agents it runs. Neither branch looks at
      // negotiatesOnOwnersBehalf: seeing that work was offered is not
      // negotiating it.
      const ownAgent = await agentRepo.findByDid(did);
      const roster = ownAgent !== null ? [ownAgent] : (await agentRepo.listAll()).filter((row) => row.operatorDid === did);

      const findByAgentDid = jobRepo.findByAgentDid.bind(jobRepo);
      const perAgentJobs = await Promise.all(roster.map((row) => findByAgentDid(row.did)));
      const allJobs = perAgentJobs.flat();
      const offered = allJobs.filter((job) => jobListBucketOf(job.status) === 'notReal');
      const sorted = [...offered].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      // One agent lookup per DISTINCT agent, not per row (the same
      // per-distinct-key caching GET /accounts/:did/jobs already uses
      // above): an operator running several agents pays for that lookup
      // once per agent, not once per offer. The distinct DIDs are
      // resolved BEFORE building rows so two rows sharing an agent never
      // race each other into two lookups of the same DID.
      const distinctAgentDids = [...new Set(sorted.map((job) => job.agentDid))];
      const agentNameByDid = new Map<string, string>();
      // AV1 (ENT-2.3 ruling): the
      // an earlier audit table claimed this route already carried avatarSpec; it
      // did not. resolveAvatar is total -- an unregistered agent still
      // renders its DID-derived default -- so every row gets the field,
      // the same "no state to wait on" stance the pending mirror route
      // and agentProjection/toBrowseCard already take.
      const avatarSpecByDid = new Map<string, ReturnType<typeof resolveAvatar>>();
      await Promise.all(
        distinctAgentDids.map(async (agentDid) => {
          const agentRow = await agentRepo.findByDid(agentDid);
          agentNameByDid.set(agentDid, agentRow?.name ?? agentDid);
          avatarSpecByDid.set(agentDid, resolveAvatar(agentRow?.avatarSpec ?? null, agentDid));
        }),
      );
      const offers = sorted.map((job) => ({
        id: job.id,
        brief: job.brief,
        repository: job.repository,
        agentDid: job.agentDid,
        agentName: agentNameByDid.get(job.agentDid) ?? job.agentDid,
        avatarSpec: avatarSpecByDid.get(job.agentDid) ?? resolveAvatar(null, job.agentDid),
        waitingOn: waitingOnOf(job.criteria),
        createdAt: job.createdAt.toISOString(),
      }));
      res.status(200).json(ownAgent !== null ? { agentDid: did, offers } : { operatorDid: did, offers });
    } catch (err) {
      console.error('GET /accounts/:did/incoming: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // P8t: GET /accounts/:did/pending, the buyer's own read of the hires
  // they have started that are not real yet (the operator's own words:
  // "I thought we were just a intermediary between the two parties",
  // 2026-09-07). The mirror of GET /accounts/:did/incoming above: the
  // same filter over the caller's own buyerDid instead of their roster's
  // agentDid. Built from the same parts in the same order: resolveActingParty,
  // then a 403 that never says whether :did is a registered account or
  // how many rows it has.
  //
  // Answers 200 with one entry per job whose jobListBucketOf(status) is
  // 'notReal' (draft or proposed, ENT-4.1): the exact complement of
  // GET /accounts/:did/jobs above. This route never scores, ranks by
  // anything but its own timestamp, or judges either party (the scope
  // fence): there is no recommended, urgent, priority, stale, or
  // overdue field.
  app.get('/accounts/:did/pending', requireSessionOrSignature, async (req: Request, res: Response) => {
    const did = String(req.params.did);
    let actingParty: string | null;
    try {
      actingParty = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('GET /accounts/:did/pending: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    // Neither a stranger nor an unresolved caller ever learns whether
    // :did is a registered account or how many rows it has: the refusal
    // is identical whether or not the account exists.
    if (actingParty === null || actingParty !== did) {
      res.status(403).json({ error: 'an account may only read its own pending list' });
      return;
    }

    // findByBuyerDid is optional on JobRepository (the same stance
    // GET /accounts/:did/jobs already takes above); a driver that omits
    // it fails the same way a driver that throws does.
    if (typeof jobRepo.findByBuyerDid !== 'function') {
      console.error('GET /accounts/:did/pending: storage does not support findByBuyerDid');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const rows = await jobRepo.findByBuyerDid(did);
      // ENT-4.1: a job does not exist until the buyer confirms. draft
      // and proposed are the only statuses returned HERE, by the
      // route -- job-list.ts's own fifth bucket value ('notReal') is
      // what this filter reads, the exact complement of the filter
      // GET /accounts/:did/jobs applies above.
      const pendingRows = rows.filter((job) => jobListBucketOf(job.status) === 'notReal');
      const sorted = [...pendingRows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      // One agent lookup per DISTINCT agent, not per row (the same
      // per-distinct-key caching GET /accounts/:did/incoming already
      // uses above): a buyer with several briefs out to one agent pays
      // for that lookup once. The distinct DIDs are resolved BEFORE
      // building rows so two rows sharing an agent never race each
      // other into two lookups of the same DID.
      const distinctAgentDids = [...new Set(sorted.map((job) => job.agentDid))];
      const agentNameByDid = new Map<string, string>();
      // AV1 (ENT-2.3 ruling): dashboard.js's
      // progressPendingRow mounts an avatar straight off this row's own
      // agentDid (mountAvatar, dashboard.js), so this route resolves the
      // spec here rather than leaving that page to guess one from a bare
      // DID. resolveAvatar is total -- an unregistered agent still
      // renders its DID-derived default -- so every row gets the field,
      // the same "no state to wait on" stance avatarSpec already takes on
      // agentProjection and toBrowseCard.
      const avatarSpecByDid = new Map<string, ReturnType<typeof resolveAvatar>>();
      await Promise.all(
        distinctAgentDids.map(async (agentDid) => {
          const agentRow = await agentRepo.findByDid(agentDid);
          agentNameByDid.set(agentDid, agentRow?.name ?? agentDid);
          avatarSpecByDid.set(agentDid, resolveAvatar(agentRow?.avatarSpec ?? null, agentDid));
        }),
      );
      const pending = sorted.map((job) => ({
        id: job.id,
        brief: job.brief,
        repository: job.repository,
        agentDid: job.agentDid,
        agentName: agentNameByDid.get(job.agentDid) ?? job.agentDid,
        avatarSpec: avatarSpecByDid.get(job.agentDid) ?? resolveAvatar(null, job.agentDid),
        status: job.status,
        waitingOn: waitingOnOf(job.criteria),
        createdAt: job.createdAt.toISOString(),
      }));
      res.status(200).json({ buyerDid: did, pending });
    } catch (err) {
      console.error('GET /accounts/:did/pending: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-39 completion: `operator` is DERIVED from
  // the proof the caller presented, never trusted from the body -- the
  // same pattern POST /jobs applies to buyerDid. A body-supplied operator
  // is optional and, when present, is checked against the derived party
  // and refused on mismatch; it is never itself the value the delegation
  // binds to, so naming a different account in the body can only be
  // refused, never honoured.
  //
  // FIX-B41a: `did` and `delegation` are BOTH now optional, together.
  // Their absence is the site path (P-19, 2026-08-17 ruling: "the person
  // is never asked to sign anything"): a signed-in owner names no key at
  // all and the platform derives the agent DID and signs its own
  // delegation with the owner's own platform-derived key. `delegation`
  // present is the wallet path, unchanged. `did` present with no
  // `delegation` but with `agentProof` is the third shape: the owner
  // brings an agent DID of its own choosing and proves control of its key
  // with one signature, so the delegation still needs no wallet prompt.
  app.post('/agents', requireSessionOrSignature, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const did = body.did;
    const claimedOperator = body.operator;
    const name = body.name;
    const description = body.description;
    const skills = body.skills;
    const githubLogin = body.githubLogin;
    const floorPriceUsd = body.floorPriceUsd;
    const minBuyerMerges = body.minBuyerMerges;
    const maxWalkedAfterConfirm = body.maxWalkedAfterConfirm;
    // HT1 (ruling, 2026-09-25): off by default (the safe default every
    // other opt-in flag on this route takes), so a caller that omits it
    // gets the owner-first behavior with no extra step.
    const negotiatesOnOwnersBehalf = body.negotiatesOnOwnersBehalf;
    const delegationField = body.delegation;
    const agentProof = body.agentProof;

    // P7: both thresholds validate as non-negative integers when present.
    // Omitted or explicitly null means no filter, the same stance
    // floorPriceUsd already takes.
    const isValidThreshold = (value: unknown): boolean =>
      value === undefined || value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);

    if (
      (did !== undefined && (typeof did !== 'string' || did.length === 0)) ||
      (claimedOperator !== undefined && typeof claimedOperator !== 'string') ||
      typeof name !== 'string' || name.length === 0 ||
      !descriptionWellFormed(description) ||
      !Array.isArray(skills) || skills.length === 0 ||
      skills.some((s) => typeof s !== 'string' || s.length === 0) ||
      (githubLogin !== undefined && (typeof githubLogin !== 'string' || githubLogin.length === 0)) ||
      (floorPriceUsd !== undefined && floorPriceUsd !== null &&
        (typeof floorPriceUsd !== 'string' || !/^\d+\.\d{2}$/.test(floorPriceUsd))) ||
      !isValidThreshold(minBuyerMerges) ||
      !isValidThreshold(maxWalkedAfterConfirm) ||
      (negotiatesOnOwnersBehalf !== undefined && typeof negotiatesOnOwnersBehalf !== 'boolean')
    ) {
      res.status(400).json({
        error: 'body must be { name, skills, description?, did?, delegation?, agentProof?, operator?, githubLogin?, floorPriceUsd?, minBuyerMerges?, maxWalkedAfterConfirm?, negotiatesOnOwnersBehalf? }; name a non-empty string, description (if present) one line 1 to 160 characters trimmed with no line break, skills a non-empty list of strings, did (if present) a non-empty string, operator (if present) a string, floorPriceUsd (if present) a decimal string with exactly two places, minBuyerMerges and maxWalkedAfterConfirm (if present) non-negative integers, negotiatesOnOwnersBehalf (if present) a boolean',
      });
      return;
    }

    if (delegationField === undefined) {
      // FIX-B41a: the site path. No delegation was supplied at all, so
      // this can only be a signed-in owner's own session: a bare R-34
      // signature proves a key, but this route needs an owner SUBJECT
      // (the session's own login) to derive the signing key behind the
      // scenes, which a signature alone never carries.
      const sessioned = req as SessionedRequest;
      if (typeof sessioned.sessionSubject !== 'string' || sessioned.sessionMethod === undefined) {
        res.status(400).json({
          error: 'delegation is required when authenticating by request signature alone; sign in with GitHub or a passkey to list without one, or supply a delegation your own key signs',
        });
        return;
      }

      let operator: string | null;
      try {
        operator = await resolveActingParty(req, repo, identityAdapter);
      } catch (err) {
        console.error('POST /agents (site path): storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (operator === null) {
        res.status(403).json({
          error: 'no registered account resolves from your session or signature; register an account before listing an agent',
        });
        return;
      }
      if (typeof claimedOperator === 'string' && claimedOperator.length > 0 && claimedOperator !== operator) {
        res.status(403).json({ error: 'operator does not match the authenticated party' });
        return;
      }

      // FIX-B41a item 3: the route checks that the derived owner DID
      // equals the session's account DID FIRST, before anything else the
      // site path does. An account whose DID a wallet key produced
      // (registered through POST /accounts before P8d) has no
      // platform-held key this route can sign with at all.
      let ownerDerived: DidKeyPair;
      try {
        ownerDerived = await identityAdapter.createOperatorDid(sessioned.sessionSubject);
      } catch (err) {
        if (err instanceof PlatformSeedUnavailableError) {
          console.error('POST /agents (site path): FREEAGENTS_PLATFORM_SEED is not set; cannot derive the owner key', err);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        throw err;
      }
      if (didSuffix(ownerDerived.did) !== didSuffix(operator)) {
        res.status(409).json({
          error: `account ${operator} was not derived by the platform; list this agent with a delegation your own key signs (the wallet path) instead`,
        });
        return;
      }

      let agentDid: string;
      const credentialId = `urn:uuid:${randomUUID()}`;
      if (typeof did === 'string') {
        // FIX-B41a item 5: the owner brings its own agent DID. The
        // agentProof must be a real ed25519 signature, by the AGENT's own
        // key, over the exact string below -- never trusted from the
        // body alone.
        if (!isValidOperatorDid(did)) {
          res.status(400).json({
            error: 'did must look like did:abt:<suffix>, non-empty suffix, no whitespace',
          });
          return;
        }
        const proofBody = (typeof agentProof === 'object' && agentProof !== null) ? agentProof as Record<string, unknown> : null;
        const signature = proofBody?.signature;
        const publicKeyMultibase = proofBody?.publicKeyMultibase;
        const expectedPayload = `freeagents:list-agent:v1:${did}:${operator}`;
        if (
          typeof signature !== 'string' || signature.length === 0 ||
          typeof publicKeyMultibase !== 'string' || publicKeyMultibase.length === 0
        ) {
          res.status(400).json({
            error: `agentProof must be { signature, publicKeyMultibase }: sign the exact string "${expectedPayload}" with the agent's own key (ed25519, base64) and name that key's publicKeyMultibase`,
          });
          return;
        }
        let signatureVerified: boolean;
        try {
          signatureVerified = await identityAdapter.verify({
            payload: expectedPayload,
            signature,
            signerDid: did,
            candidateKeyMultibase: publicKeyMultibase,
          });
        } catch (err) {
          if (err instanceof CandidateKeyRejectedError || err instanceof DidNotResolvableError) {
            res.status(400).json({
              error: `agentProof does not check out: sign the exact string "${expectedPayload}" with the agent's own key (ed25519, base64) and name that key's publicKeyMultibase`,
            });
            return;
          }
          throw err;
        }
        if (!signatureVerified) {
          res.status(400).json({
            error: `agentProof does not check out: sign the exact string "${expectedPayload}" with the agent's own key (ed25519, base64) and name that key's publicKeyMultibase`,
          });
          return;
        }
        agentDid = did;
      } else {
        // FIX-B41a item 1: nothing to sign at all. A fresh agent DID,
        // re-derivable later from the seed, the owner DID and this same
        // credentialId (stored only inside the delegation's own `id`).
        const derived = await identityAdapter.createAgentDid(operator, credentialId);
        agentDid = derived.did;
      }

      let siteDidAlreadyAnAccount: boolean;
      try {
        siteDidAlreadyAnAccount = (await repo.findByDid(agentDid)) !== null;
      } catch (err) {
        console.error('POST /agents (site path): storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (siteDidAlreadyAnAccount) {
        res.status(409).json({
          error: `${agentDid} is already registered as an account; an account's own DID cannot be delegated as an agent`,
        });
        return;
      }

      if (typeof identityAdapter.issueSiteDelegation !== 'function') {
        console.error('POST /agents (site path): identity adapter does not support issueSiteDelegation');
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      let siteDelegation: Delegation;
      try {
        siteDelegation = await identityAdapter.issueSiteDelegation({
          ownerSubject: sessioned.sessionSubject,
          agentDid,
          credentialId,
        });
      } catch (err) {
        if (err instanceof PlatformSeedUnavailableError) {
          console.error('POST /agents (site path): FREEAGENTS_PLATFORM_SEED is not set; cannot sign the delegation', err);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        throw err;
      }

      try {
        let row = await agentRepo.create({
          did: agentDid,
          operatorDid: operator,
          delegation: siteDelegation,
          name,
          description: (description as string | undefined) ?? null,
          skills,
          githubLogin: githubLogin ?? null,
          floorPriceUsd: (floorPriceUsd as string | undefined) ?? null,
          minBuyerMerges: (minBuyerMerges as number | undefined) ?? null,
          maxWalkedAfterConfirm: (maxWalkedAfterConfirm as number | undefined) ?? null,
          negotiatesOnOwnersBehalf: (negotiatesOnOwnersBehalf as boolean | undefined) ?? false,
        });
        // G1 path one, same rule as the wallet path below: a GitHub
        // OAuth session naming its own login records verified immediately.
        if (
          typeof githubLogin === 'string' &&
          sessioned.sessionMethod === 'github-oauth' &&
          sessioned.sessionSubject.toLowerCase() === githubLogin.toLowerCase()
        ) {
          const verifiedRow = await agentRepo.updateGithubBinding(agentDid, { handle: githubLogin, status: 'verified' });
          if (verifiedRow !== null) row = verifiedRow;
        }
        res.status(201).json(agentProjection(row));
      } catch (err) {
        if (err instanceof AgentAlreadyExistsError) {
          res.status(409).json({ error: `agent ${agentDid} is already delegated` });
          return;
        }
        console.error('POST /agents (site path): storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
      }
      return;
    }

    // The wallet path, unchanged from before this card except description.
    if (typeof did !== 'string' || did.length === 0) {
      res.status(400).json({
        error: 'did is required when delegation is present: body must be { did, delegation, name, skills, ... }',
      });
      return;
    }
    // The registry speaks full DIDs (did:abt:...) in both fields; the
    // credential may carry either form, and that is reconciled below.
    if (!isValidOperatorDid(did)) {
      res.status(400).json({
        error: 'did must look like did:abt:<suffix>, non-empty suffix, no whitespace',
      });
      return;
    }
    // P8a: the guard on POST /accounts closes the
    // Account-second ordering (claim an already-delegated agent's did) but
    // this route never asked the mirror question -- whether the did being
    // delegated here is already an Account -- so the Account-FIRST ordering
    // (register the did as an Account before it is ever delegated, then
    // delegate normally) reached the exact state that guard was meant to make
    // unreachable: an Account row a session can authenticate as, sitting
    // underneath a live agent seat, no delegation key ever involved. Both
    // registries name the same DID namespace, and this card's own out-of-
    // scope line ("no change to who may act") requires that a did resolve
    // to at most one of the two identities, from whichever side claims it
    // second. Checked before the delegation is even parsed for validity:
    // a did already claimed by an Account cannot become a live agent seat
    // regardless of how good the delegation proof is.
    let didAlreadyAnAccount: boolean;
    try {
      didAlreadyAnAccount = (await repo.findByDid(did)) !== null;
    } catch (err) {
      console.error('POST /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (didAlreadyAnAccount) {
      res.status(409).json({
        error: `${did} is already registered as an account; an account's own DID cannot be delegated as an agent`,
      });
      return;
    }
    // R-39 completion: the acting party, derived server-side from whichever
    // proof requireSessionOrSignature accepted. One code path, both proofs
    // (the same call resolveActingParty makes for POST /jobs).
    let operator: string | null;
    try {
      operator = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('POST /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (operator === null) {
      res.status(403).json({
        error: 'no registered account resolves from your session or signature; register an account before listing an agent',
      });
      return;
    }
    if (typeof claimedOperator === 'string' && claimedOperator.length > 0 && claimedOperator !== operator) {
      res.status(403).json({ error: 'operator does not match the authenticated party' });
      return;
    }
    const proof = delegationShape(delegationField);
    if (proof === null) {
      res.status(400).json({
        error: 'delegation must be a W3C Verifiable Credential: object with @context, id, type, issuer (string), credentialSubject { id }, proof { type: Ed25519Signature2020, proofValue }, issuanceDate',
      });
      return;
    }

    let operatorRow: Account | null;
    try {
      operatorRow = await repo.findByDid(operator);
    } catch (err) {
      console.error('POST /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (operatorRow === null) {
      res.status(404).json({
        error: `operator ${operator} is not registered; register it before delegating from it`,
      });
      return;
    }

    if (!delegationConsistent({ did, operatorDid: operator, delegation: proof })) {
      res.status(400).json({
        error: 'delegation does not bind this operator to this agent DID: type must include AgentDelegation, issuer must be the operator, credentialSubject must be the agent DID',
      });
      return;
    }

    // ownerDid is the credential's own subject, verbatim, because the
    // verifier compares it by equality with credentialSubject.id.
    const verified = await identityAdapter.verifyDelegation(proof, proof.credentialSubject.id, operator);
    if (!verified) {
      res.status(400).json({
        error: 'delegation proof failed verification: the signature does not check out against the operator key',
      });
      return;
    }

    try {
      let row = await agentRepo.create({
        did,
        operatorDid: operator,
        delegation: proof,
        name,
        description: (description as string | undefined) ?? null,
        skills,
        githubLogin: githubLogin ?? null,
        floorPriceUsd: (floorPriceUsd as string | undefined) ?? null,
        minBuyerMerges: (minBuyerMerges as number | undefined) ?? null,
        maxWalkedAfterConfirm: (maxWalkedAfterConfirm as number | undefined) ?? null,
        negotiatesOnOwnersBehalf: (negotiatesOnOwnersBehalf as boolean | undefined) ?? false,
      });
      // G1 path one (ENT-5.1): sign-in is the proof when the agent works
      // from its operator's own GitHub account, zero extra steps. A GitHub
      // OAuth session already proved the operator controls sessionSubject
      // (session-github-passkey.ts returns the login GitHub itself
      // reported), so a githubLogin that names that SAME login, case-
      // insensitively (GitHub logins are their own case-insensitive
      // namespace), records verified immediately. The login is compared
      // against the session, never trusted from the body alone: a request
      // authenticated by an R-34 signature carries no sessionMethod at all
      // (authenticateRequest only sets it on the session path), so a
      // signature-only registration can never take this branch regardless
      // of what githubLogin claims, and a body naming a login that is not
      // the session's own falls through to path two (the signed gist) with
      // no verification recorded here.
      const sessioned = req as SessionedRequest;
      if (
        typeof githubLogin === 'string' &&
        sessioned.sessionMethod === 'github-oauth' &&
        typeof sessioned.sessionSubject === 'string' &&
        sessioned.sessionSubject.toLowerCase() === githubLogin.toLowerCase()
      ) {
        const verifiedRow = await agentRepo.updateGithubBinding(did, { handle: githubLogin, status: 'verified' });
        if (verifiedRow !== null) row = verifiedRow;
      }
      res.status(201).json(agentProjection(row));
    } catch (err) {
      if (err instanceof AgentAlreadyExistsError) {
        res.status(409).json({ error: `agent ${did} is already delegated` });
        return;
      }
      console.error('POST /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-20 (D1, ENT-2.2): the browse listing. GET /agents/:agentDid above
  // reads one agent's own record; this reads every listed agent as browse
  // cards, sorted and filtered per D1/Q1. Widens the same read agent-work-
  // record.ts already assembles, rather than a parallel endpoint. The card's
  // buyerCount is derived by toBrowseCard itself from the verified-hire tier
  // alone (src/domain/browse.ts), so this route no longer reads job history
  // at all: a job-repository read here is exactly how the tier-blind
  // buyerCount defect shipped.
  app.get('/agents', async (req: Request, res: Response) => {
    if (typeof agentRepo.listAll !== 'function') {
      console.error('GET /agents: storage does not support listAll');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    const sort = resolveBrowseSort(req.query.sort);
    const skillFilter = typeof req.query.skill === 'string' ? req.query.skill : null;

    try {
      const rows = await agentRepo.listAll();
      const cards: BrowseCard[] = await Promise.all(
        rows.map(async (row) => {
          const stored = await credentialRepo.listBySubjectDid(row.did);
          const evidence = credentialEvidenceOf(stored);
          const record = agentWorkRecord(evidence);
          return toBrowseCard(row, record);
        }),
      );

      // FIX-B43a: an unlisted agent leaves browse entirely, before any
      // skill filter or sort runs. The card itself carries `listed`
      // (toBrowseCard, src/domain/browse.ts) so the owner's roster below
      // can reuse the same assembly and keep the card, marked, while
      // this route is the one place that drops it.
      const onlyListed = cards.filter((card) => card.listed);

      const filtered = filterBySkill(onlyListed, skillFilter);
      const sorted = sortBrowseCards(filtered, sort);
      res.status(200).json({ sort, agents: sorted });
    } catch (err) {
      console.error('GET /agents: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // #30 addendum's original stance (this route's own single anonymous
  // limiter, before FIX-S7): the two verification routes, and only those,
  // carried the anonymous rate limit. FIX-S7 (security sweep S7+S11)
  // superseded that: EVERY route now carries a class-limiter bucket
  // (src/api/rate-limit-classes.ts's ROUTE_TABLE names every one, walked
  // by tests/architecture/rate-limit-enforcement.test.ts), not just these
  // two. FIX-S7 (the verify-vs-honest-user
  // conflict): this route is now in the `read` class
  // (300/minute), not `verify` -- it is the site's own ordinary
  // agent-record read (twelve page scripts fetch it for the agent strip),
  // never a stranger's or a script's verification. GET /accounts/:did and
  // GET /capabilities are also `read`, never "left alone" as an earlier
  // version of this comment claimed.
  app.get('/agents/:agentDid', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    try {
      const row = await agentRepo.findByDid(did);
      if (row === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      // R-17 (ENT-8, ENT-2.4): every credential this platform issued to
      // this agent, paired with the one fact evidenceTier needs beyond
      // what a merge already proves. Read at response time, never stored
      // as a tier column, so a private repository can never be relisted
      // into a verified tier just by not re-checking it.
      const stored = await credentialRepo.listBySubjectDid(did);
      const evidence = credentialEvidenceOf(stored);

      // R-37: freshness as a visible fact (ENT-2, ENT-4), never a
      // denormalised column. findCompletedByAgent is optional on
      // JobRepository (the same stance the /hires route already takes),
      // so a driver that cannot answer this read fails the same way an
      // actual outage does, rather than rendering a false "no hires".
      if (typeof jobRepo.findCompletedByAgent !== 'function') {
        console.error('GET /agents/:agentDid: storage does not support findCompletedByAgent');
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      const completedHires = await jobRepo.findCompletedByAgent(did);
      const record = agentWorkRecord(evidence);
      // lastHireCompletedAt must sit beside the
      // SAME population verifiedHires renders, or a private-repo agent's
      // page states both "no verified hires" and a date for the hire that
      // didn't verify. record.verifiedHires is the one array the "Verified
      // hire" section itself renders from (agent-work-record.ts), so
      // reading mergedAt off it, rather than off the tier-blind
      // completedHires, keeps the summary and the tier answering the same
      // question. recordLastChangedAt stays tier-agnostic on purpose: "did
      // anything in this record change" is a claim about the whole record,
      // not about the verified-hire tier, so it still reads completedHires.
      const freshness = {
        lastHireCompletedAt: lastHireCompletedAt(record.verifiedHires.map((hire) => ({ completedAt: hire.mergedAt }))),
        recordLastChangedAt: recordLastChangedAt(row, completedHires),
      };

      res.status(200).json({ ...agentProjection(row), ...record, ...freshness });
    } catch (err) {
      console.error('GET /agents/:agentDid: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // G1 path two (ENT-5.1): a signed gist, alone, is now the whole proof. An
  // agent with its own separate GitHub account (the account the operator's
  // own session did not already prove) authors a public gist holding a
  // statement its key signed; the route checks it out and records the
  // binding verified. Direction one (the DID document's alsoKnownAs entry)
  // is gone from this route entirely: this adapter's resolveDid can never
  // learn that field for real (identity.ts's own header comment), so
  // requiring it meant this route answered 503 for every agent, forever
  // (B22). Everything this route already checked about the gist
  // itself stays unchanged.
  // S3+S4 follow-on (security sweep, item 3): this route was also in the
  // ungated /agents/:agentDid/* write family. Same treatment as
  // key-rotation and compromise-report: body shape first, then
  // requireCallerIsAgentOperator carries authentication, the operator
  // match, and the 404, in that fixed order.
  app.post('/agents/:agentDid/account-proof', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { handle?: unknown; gist?: unknown };
    const handle = body.handle;

    if (typeof handle !== 'string' || handle.length === 0 || /\s/.test(handle)) {
      res.status(400).json({
        error: 'body must be { handle, gist }; handle is a non-empty string with no whitespace, gist a URL like https://gist.github.com/<owner>/<id>',
      });
      return;
    }

    // The gist is the whole proof now: a body naming a handle with no gist
    // at all has nothing this route can check, so it is the same 400 shape
    // a malformed gist URL already gets, not a silent no-op. Checked before
    // authentication, matching this route's own body-shape-first ordering.
    if (body.gist === undefined) {
      res.status(400).json({
        error: 'body must be { handle, gist }; gist is required (a URL like https://gist.github.com/<owner>/<id>)',
      });
      return;
    }

    const gated = await requireCallerIsAgentOperator('POST /agents/:agentDid/account-proof', req, res, did);
    if (gated === null) return;
    const row = gated;

    // A malformed gist URL is a client error, and the URL owner must be the
    // claimed handle: the operator is pointing at someone else's gist, which
    // no signature could fix anyway.
    let gistRef: GistUrlRef | null = null;
    if (typeof body.gist !== 'string' || (gistRef = parseGistUrl(body.gist)) === null) {
      res.status(400).json({
        error: 'gist must be a URL like https://gist.github.com/<owner>/<id>',
      });
      return;
    }
    if (gistRef.owner.toLowerCase() !== handle.toLowerCase()) {
      res.status(409).json({
        error: `direction two (signed gist): the gist URL owner ${gistRef.owner} does not match the claimed handle ${handle}`,
      });
      return;
    }

    const outcome = await checkSignedGist('POST /agents/:agentDid/account-proof', did, handle, gistRef.id);
    if (outcome.kind === 'not-found') {
      // R-5 (ENT-5.3): the gist no longer exists. That is not an outage; it
      // is the check resolving to "the proof no longer stands". A verified
      // binding drops to unverified (the handle is kept: the claim was
      // made, it no longer holds). Anything weaker than verified has
      // nothing to lose, and a missing gist is operator-fixable, so it is
      // a 409.
      if (row.proofStatus === 'verified') {
        let updated: Agent | null;
        try {
          updated = await agentRepo.updateGithubBinding(did, {
            handle,
            status: 'unverified',
          });
        } catch (storageErr) {
          console.error('POST /agents/:agentDid/account-proof: storage failed', storageErr);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        if (updated === null) {
          res.status(404).json({ error: `agent ${did} is not registered` });
          return;
        }
        res.status(200).json(agentProjection(updated));
        return;
      }
      res.status(409).json({
        error: 'direction two (signed gist): the gist no longer resolves: recreate it at the published URL',
      });
      return;
    }
    if (outcome.kind === 'github-unavailable') {
      res.status(503).json({ error: 'github unavailable' });
      return;
    }
    if (outcome.kind === 'author-mismatch') {
      res.status(409).json({
        error: `direction two (signed gist): the gist author ${outcome.author ?? 'unknown'} does not match the claimed handle ${handle}`,
      });
      return;
    }
    if (outcome.kind === 'no-statement') {
      res.status(409).json({
        error: 'direction two (signed gist): the gist does not hold a well-formed statement binding this agent DID to this account',
      });
      return;
    }
    if (outcome.kind === 'malformed-signature') {
      res.status(409).json({
        error:
          'direction two (signed gist): the signature field is not a well-formed ed25519 signature (base64, 64 bytes)',
      });
      return;
    }
    if (outcome.kind === 'candidate-key-rejected') {
      res.status(409).json({
        error: `direction two (signed gist): the key line does not derive ${did}; check the publicKeyMultibase on the key line matches this agent's own key`,
      });
      return;
    }
    if (outcome.kind === 'no-key-on-record') {
      res.status(409).json({
        error: 'direction two (signed gist): this agent has no key on record yet; add a `key: <publicKeyMultibase>` line to the gist statement naming the agent\'s own key',
      });
      return;
    }
    if (outcome.kind === 'identity-unavailable') {
      res.status(503).json({ error: 'identity verification unavailable' });
      return;
    }
    if (outcome.kind === 'signature-invalid') {
      res.status(409).json({
        error: 'direction two (signed gist): the signature does not check out against the agent key',
      });
      return;
    }

    try {
      const updated = await agentRepo.updateGithubBinding(did, { handle, status: 'verified' });
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('POST /agents/:agentDid/account-proof: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // FIX-B47b2, Make 1 (FIX-B47b decision 2): starts the one-click GitHub
  // proof for one agent. Operator only, through requireCallerIsAgentOperator
  // (the same 401/403/404 ordering every other operator-gated route on this
  // file already takes). The platform holds an agent's key only when
  // createAgentDid(row.operatorDid, row.delegation.id) re-derives EXACTLY
  // row.did -- the two inputs the site-listing route itself used to mint
  // that DID (app.ts's own site path, `operator` and `credentialId`).
  // row.operatorDid is the input, never row.delegation.issuer: the issuer
  // is the owner DID as deriveDidFromSeed writes it, which the site-listing
  // route compared with `operator` by SUFFIX only, so the two strings can
  // differ and only `operator` (stored as row.operatorDid) fed the
  // derivation. A wallet-path agent, and a site agent that brought its own
  // DID, both fail that comparison: 409, naming path two. That 409 is
  // checked BEFORE the OAuth-configured check, so a deployment with GitHub
  // OAuth unconfigured never masks it behind a 503.
  //
  // B76: the 200 also binds the proof to THIS browser. It sets the
  // fa_oauth_state cookie to the proof's state, through the same function
  // GET /auth/github/start uses (setOAuthStateCookie), and the callback's
  // proof branch completes only when that cookie comes back equal to the
  // state in the query. The page stores it by sending this one request with
  // credentials same-origin (FAApi.postAuthedSameOrigin); the cookie
  // authorizes nothing, since the operator check above still rides the
  // bearer token. The 401, 403, 404, 409 and 503 answers set no cookie, and
  // the state stays out of the body.
  app.post('/agents/:agentDid/github-proof/start', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const gated = await requireCallerIsAgentOperator('POST /agents/:agentDid/github-proof/start', req, res, did);
    if (gated === null) return;
    const row = gated;

    let derived: DidKeyPair | null;
    try {
      derived = await derivePlatformHeldAgentKey(row);
    } catch (err) {
      if (err instanceof PlatformSeedUnavailableError) {
        console.error('POST /agents/:agentDid/github-proof/start: FREEAGENTS_PLATFORM_SEED is not set; cannot derive the agent key', err);
        res.status(503).json({ error: 'FREEAGENTS_PLATFORM_SEED is not configured on this deployment; cannot derive the agent key' });
        return;
      }
      throw err;
    }
    if (derived === null) {
      res.status(409).json({
        error: `the platform holds no signing key for ${did}; prove ownership with a signed gist instead (POST /agents/:agentDid/account-proof)`,
      });
      return;
    }

    let start: OAuthStart;
    try {
      start = await session.beginGitHubProofOAuth(row.operatorDid, did);
    } catch (err) {
      console.error('POST /agents/:agentDid/github-proof/start: GitHub OAuth is not configured on this deployment', err);
      res.status(503).json({ error: 'github proof is not configured on this deployment' });
      return;
    }
    setOAuthStateCookie(res, start);
    res.status(200).json({ redirectUrl: start.redirectUrl });
  });

  // R-30 (ENT-8.4): the operator supersedes an agent's key. The route owns
  // only what the domain does not know about: the body's shape (checked
  // with R-29's rotationWellFormed, not restated), the agent's existence,
  // and the error mapping. fromKey === toKey is the no-op R-29's shape rule
  // defers to this route; it is rejected inline because a one-line equality
  // is the HTTP surface's call, not a domain rule (the validator's scope
  // finding on rotationIsIdentity). The record is public identifiers only,
  // so nothing here touches the identity adapter.
  // S3 (security sweep, high): this route mounted no authentication at all,
  // so an unsigned request could fabricate rotation history on any listed
  // agent, publicly readable afterwards. R-30 is an operator action on the
  // operator's own agent, never a stranger's. Body shape is checked first
  // (a statement about the request, not the record), then
  // requireCallerIsAgentOperator carries authentication, the operator
  // match, and the 404 for an unregistered agent, in that fixed order, so
  // an unauthenticated caller cannot read agent existence off the status
  // code alone. No Express middleware is mounted here on purpose: the
  // ordering the brief demands (400 before 401) is only reachable from
  // inside the handler, after the body is already parsed and checked.
  app.post('/agents/:agentDid/key-rotation', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { fromKey?: unknown; toKey?: unknown };

    // rotationWellFormed is total by contract, so the untyped body halves
    // may be passed straight in; the cast is the call site's honesty mark.
    if (
      !rotationWellFormed({
        fromKey: body.fromKey,
        toKey: body.toKey,
        rotatedAt: new Date(),
      } as KeyRotation)
    ) {
      res.status(400).json({
        error:
          'body must be { fromKey, toKey }; both are non-empty strings in DID fragment form, did:abt:<suffix>#<fragment>',
      });
      return;
    }

    if ((body.fromKey as string) === (body.toKey as string)) {
      res.status(400).json({
        error: 'a rotation supersedes a key with a different one: fromKey and toKey are the same key',
      });
      return;
    }

    const gated = await requireCallerIsAgentOperator('POST /agents/:agentDid/key-rotation', req, res, did);
    if (gated === null) return;

    try {
      const updated = await agentRepo.recordKeyRotation(did, {
        fromKey: body.fromKey as string,
        toKey: body.toKey as string,
      });
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('POST /agents/:agentDid/key-rotation: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // AV1 (ENT-2.3 ruling, 2026-09-22): the operator's own override on shape,
  // face and colour. Same auth shape as key-rotation and account-proof
  // above: requireCallerIsAgentOperator carries the unsigned-401,
  // stranger-403 and unknown-agent-404 gates in one call, so this route
  // owns only the body's shape and the write. Reject any value outside
  // the three fixed sets with 400, before the operator gate runs -- the
  // same "state a fact about the request before authenticating" order
  // key-rotation and compromise-report already use, so a malformed body
  // never depends on who sent it to be refused.
  function avatarSpecBodyError(body: { shape?: unknown; face?: unknown; colour?: unknown }): string | null {
    if (!isValidAvatarShape(body.shape)) {
      return `shape must be one of the fixed set: ${AVATAR_SHAPES.join(', ')}`;
    }
    if (!isValidAvatarFace(body.face)) {
      return `face must be one of the fixed set: ${AVATAR_FACES.join(', ')}`;
    }
    if (!isValidAvatarColourKey(body.colour)) {
      return 'colour must be a colour KEY (c1..c12), never a raw hex value';
    }
    return null;
  }

  app.put('/agents/:agentDid/avatar', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { shape?: unknown; face?: unknown; colour?: unknown };
    const bodyError = avatarSpecBodyError(body);
    if (bodyError !== null) {
      res.status(400).json({ error: bodyError });
      return;
    }

    const gated = await requireCallerIsAgentOperator('PUT /agents/:agentDid/avatar', req, res, did);
    if (gated === null) return;

    try {
      const updated = await agentRepo.setAvatarSpec(did, {
        shape: body.shape as AvatarShape,
        face: body.face as AvatarFace,
        colour: body.colour as string,
      });
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('PUT /agents/:agentDid/avatar: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // AV1: clears the stored override back to the DID-derived default. Same
  // operator gate as PUT above; no body to validate.
  app.delete('/agents/:agentDid/avatar', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const gated = await requireCallerIsAgentOperator('DELETE /agents/:agentDid/avatar', req, res, did);
    if (gated === null) return;

    try {
      const updated = await agentRepo.setAvatarSpec(did, null);
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('DELETE /agents/:agentDid/avatar: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // HT1 (ruling, 2026-09-25): "The agent should not be allowed to
  // negotiate on behalf of its owner unless they explicitly provide
  // instructions for their agent to do so." The operator's own switch,
  // gated the same way the avatar override is: requireCallerIsAgentOperator
  // carries the unsigned-401, stranger-403 and unknown-agent-404 gates in
  // one call, so this route owns only the body's shape and the write.
  app.put('/agents/:agentDid/negotiation', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { negotiatesOnOwnersBehalf?: unknown };
    if (typeof body.negotiatesOnOwnersBehalf !== 'boolean') {
      res.status(400).json({ error: 'body must be { negotiatesOnOwnersBehalf }, a boolean' });
      return;
    }

    const gated = await requireCallerIsAgentOperator('PUT /agents/:agentDid/negotiation', req, res, did);
    if (gated === null) return;

    try {
      const updated = await agentRepo.setNegotiatesOnOwnersBehalf(did, body.negotiatesOnOwnersBehalf);
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('PUT /agents/:agentDid/negotiation: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // FIX-B43a (ruling, 2026-09-27): "an owner can stop listing an agent at
  // any time and list it again at any time... Unlisting is a listing
  // state the owner can flip back, so it does not revoke the agent's
  // delegation." The same shape and gate as the negotiation route above:
  // the body's shape first (400), then requireCallerIsAgentOperator
  // (unsigned 401, registered stranger 403, unknown agent 404 in one
  // call), then the write, 200 with the agent projection, 503 on a
  // storage failure with the cause logged. The same call lists and
  // unlists; setting the value it already has is a 200 that changes
  // nothing. Nothing else on this agent (its delegation, credentials,
  // hires, or any job) is touched here.
  app.put('/agents/:agentDid/listing', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { listed?: unknown };
    if (typeof body.listed !== 'boolean') {
      res.status(400).json({ error: 'body must be { listed }, a boolean' });
      return;
    }

    const gated = await requireCallerIsAgentOperator('PUT /agents/:agentDid/listing', req, res, did);
    if (gated === null) return;

    try {
      const updated = await agentRepo.setListed(did, body.listed);
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('PUT /agents/:agentDid/listing: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // HT1 Part B (STEER item 4, 2026-09-25): "add an optional
  // notifyWebhookUrl the operator sets on the listing... validate the
  // URL as https-only." null clears it back off, mirroring the
  // negotiation route's own boolean-or-null shape. Same gate as the
  // negotiation route above: the agent's own operator, no one else.
  app.put('/agents/:agentDid/webhook', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { notifyWebhookUrl?: unknown };
    if (body.notifyWebhookUrl !== null && typeof body.notifyWebhookUrl !== 'string') {
      res.status(400).json({ error: 'body must be { notifyWebhookUrl }, an https URL string or null to clear it' });
      return;
    }
    if (body.notifyWebhookUrl !== null && !isHttpsUrl(body.notifyWebhookUrl)) {
      res.status(400).json({ error: 'notifyWebhookUrl must be an https:// URL' });
      return;
    }
    // FIX-SW4a (SW4-01): an https URL is not yet a URL the platform
    // may post to. A loopback, private, link-local or metadata address, or
    // `localhost`, is refused here, before the party gate, and again at send
    // time by the webhook sender (which also refuses a name that resolves to
    // one).
    if (body.notifyWebhookUrl !== null && !isOutboundDestinationAllowed(body.notifyWebhookUrl)) {
      res.status(400).json({
        error: 'notifyWebhookUrl must be an https address on the public internet; private, loopback and link-local addresses are refused',
      });
      return;
    }

    const gated = await requireCallerIsAgentOperator('PUT /agents/:agentDid/webhook', req, res, did);
    if (gated === null) return;

    try {
      const updated = await agentRepo.setNotifyWebhookUrl(did, body.notifyWebhookUrl);
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('PUT /agents/:agentDid/webhook: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // FIX-B41b: the owner's edit of an already-listed agent. Body may name
  // any of { name, description, skills, floorPriceUsd }, validated
  // exactly as POST /agents validates the same four fields, in the big
  // `if` guard inside the POST /agents handler above;
  // description and floorPriceUsd may be null (clears them), name and
  // skills may not. Naming none of the four is 400. Any other field in
  // the body (did, delegation, githubLogin, proofStatus, operatorDid...)
  // changes nothing: UpdateListingInput has no field for it, so it never
  // reaches the storage write regardless of what this function does with
  // the rest of the body. Order matches the PUT /agents/:agentDid/negotiation
  // route's own, above: the body's shape first (400), then
  // requireCallerIsAgentOperator, which carries unsigned 401, registered
  // stranger 403 and unknown agent 404 in one call, then the write.
  function editListingBodyError(body: Record<string, unknown>): string | null {
    const { name, description, skills, floorPriceUsd } = body;
    if (name === undefined && description === undefined && skills === undefined && floorPriceUsd === undefined) {
      return 'body must name at least one of { name, description, skills, floorPriceUsd }';
    }
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      return 'name must be a non-empty string';
    }
    if (!descriptionWellFormed(description)) {
      return 'description (if present) must be null or one line 1 to 160 characters trimmed with no line break';
    }
    if (
      skills !== undefined &&
      (!Array.isArray(skills) || skills.length === 0 || skills.some((s) => typeof s !== 'string' || s.length === 0))
    ) {
      return 'skills (if present) must be a non-empty list of non-empty strings';
    }
    if (
      floorPriceUsd !== undefined && floorPriceUsd !== null &&
      (typeof floorPriceUsd !== 'string' || !/^\d+\.\d{2}$/.test(floorPriceUsd))
    ) {
      return 'floorPriceUsd (if present) must be null or a decimal string with exactly two places';
    }
    return null;
  }

  app.patch('/agents/:agentDid', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bodyError = editListingBodyError(body);
    if (bodyError !== null) {
      res.status(400).json({ error: bodyError });
      return;
    }

    const gated = await requireCallerIsAgentOperator('PATCH /agents/:agentDid', req, res, did);
    if (gated === null) return;

    // Only the four validated fields are ever forwarded to storage: each is
    // included only when its key is present in the body (`'x' in body`), so
    // a caller who never named a field leaves the stored value untouched,
    // while an explicit `null` on description or floorPriceUsd is forwarded
    // and clears it. memory.ts and prisma.ts key their own clearing off
    // `!== undefined` on this already-picked input, a separate check at a
    // separate layer: this route decides which keys to forward at all, the
    // storage drivers decide what to do with the keys they receive.
    const input: UpdateListingInput = {
      ...('name' in body ? { name: body.name as string } : {}),
      ...('description' in body ? { description: body.description as string | null } : {}),
      ...('skills' in body ? { skills: body.skills as readonly string[] } : {}),
      ...('floorPriceUsd' in body ? { floorPriceUsd: body.floorPriceUsd as string | null } : {}),
    };

    if (typeof agentRepo.updateListing !== 'function') {
      console.error('PATCH /agents/:agentDid: storage does not support updateListing');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const updated = await agentRepo.updateListing(did, input);
      if (updated === null) {
        res.status(404).json({ error: `agent ${did} is not registered` });
        return;
      }
      res.status(200).json(agentProjection(updated));
    } catch (err) {
      console.error('PATCH /agents/:agentDid: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-16 (ENT-8.4): an operator reports one of the agent's keys compromised.
  // A side record beside the agent, never a field on it, and never written
  // into a signed credential (ENT-8.3 forbids a judgement inside the
  // signature envelope). The route owns the body's shape (checked with
  // reportWellFormed, not restated) and the one semantic check reportWellFormed
  // does not make: since must not be in the future.
  // S4 (security sweep, medium): this route mounted no authentication at
  // all, so an unsigned caller could brand any agent's keys compromised in
  // bulk (the sweep filed 60 unsigned reports against one victim in 9
  // seconds). R-16 is an operator action on the operator's own agent, never
  // a stranger's. Body shape and the future-since check run first (both
  // are statements about the request, not the record), then
  // requireCallerIsAgentOperator carries authentication, the operator
  // match, and the 404 for an unregistered agent, in that fixed order.
  app.post('/agents/:agentDid/compromise-report', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);
    const body = (req.body ?? {}) as { key?: unknown; since?: unknown };
    const since = new Date(String(body.since));

    // Checked ahead of reportWellFormed: that validator's own since <=
    // reportedAt rule would otherwise catch a future since first (it is
    // handed reportedAt: new Date() below), and report it with the generic
    // shape message instead of this more useful one. An unparseable since
    // has NaN for getTime(), and NaN > anything is false, so this falls
    // through to reportWellFormed's shape check without a separate guard.
    if (since.getTime() > Date.now()) {
      res.status(400).json({ error: 'since must not be in the future' });
      return;
    }

    // reportWellFormed is total by contract, so the untyped body halves may
    // be passed straight in; the cast is the call site's honesty mark.
    if (
      !reportWellFormed({
        key: body.key,
        since,
        reportedAt: new Date(),
      } as CompromiseReport)
    ) {
      res.status(400).json({
        error:
          'body must be { key, since }; key is a non-empty string in DID fragment form, did:abt:<suffix>#<fragment>, and since is an ISO-8601 instant at or before now',
      });
      return;
    }

    const gated = await requireCallerIsAgentOperator('POST /agents/:agentDid/compromise-report', req, res, did);
    if (gated === null) return;

    try {
      const report = await compromiseRepo.record(did, { key: body.key as string, since });
      res.status(201).json(compromiseReportProjection(report));
    } catch (err) {
      console.error('POST /agents/:agentDid/compromise-report: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-16: "the window is visible". Every report an operator has filed for
  // this agent, nothing hidden, nothing summarised away.
  app.get('/agents/:agentDid/compromise-reports', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('GET /agents/:agentDid/compromise-reports: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    try {
      const reports = await compromiseRepo.listByAgentDid(did);
      res.status(200).json({ agentDid: did, reports: reports.map(compromiseReportProjection) });
    } catch (err) {
      console.error('GET /agents/:agentDid/compromise-reports: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-22 (ENT-10, issue 29): reviews are public to read, restricted to
  // write. Every review filed for this agent, no aggregate, no rating, the
  // same "the window is visible" stance compromise-reports takes above.
  app.get('/agents/:agentDid/reviews', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('GET /agents/:agentDid/reviews: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    try {
      const reviews = await reviewRepo.listByAgentDid(did);
      res.status(200).json({ agentDid: did, reviews: reviews.map(reviewProjection) });
    } catch (err) {
      console.error('GET /agents/:agentDid/reviews: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-33: the agent's hire record. Distinct buyers ride beside total hires and
  // every row carries its self-hire label, so no reading of this response can
  // present five self-hires as five independent buyers (MISSION invariant 5).
  // Its own route rather than a field on agentProjection, the same way the
  // compromise window is (see compromiseReportProjection): agentProjection is
  // a pinned ten-key row projection with no storage aggregation in it.
  app.get('/agents/:agentDid/hires', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('GET /agents/:agentDid/hires: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    // findCompletedByAgent is optional on JobRepository (a hand-rolled stand-in
    // from an unrelated route's tests may omit it); a driver that cannot
    // answer this read fails the same way a driver that throws does.
    if (typeof jobRepo.findCompletedByAgent !== 'function') {
      console.error('GET /agents/:agentDid/hires: storage does not support findCompletedByAgent');
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    try {
      const hires = await jobRepo.findCompletedByAgent(row.did);
      // P7: the operator's own verified GitHub login, resolved once per
      // request (the operator is fixed per agent), and each buyer's own
      // login resolved per distinct buyer (withBuyerGithubLogins). Both
      // travel to buyerDiversity so isSelfHire's GitHub comparison
      // compares real accounts, not the undefined it silently treated
      // as never-a-match before this fix. A storage
      // failure in either lookup falls through to the same 503 the
      // existing catch below already maps every other failure here to.
      const operatorAccount = await repo.findByDid(row.operatorDid);
      const hiresWithLogins = await withBuyerGithubLogins(hires, repo);
      const { counts, entries } = buyerDiversity(hiresWithLogins, row.operatorDid, operatorAccount?.githubLogin ?? null);
      res.status(200).json({ agentDid: did, counts, entries });
    } catch (err) {
      console.error('GET /agents/:agentDid/hires: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // FIX-B58 (B58): the agent's work-history extension block, for the
  // owner to add to the agent's own A2A card. FreeAgents serves the block and
  // never a whole card, because a card needs the address where the agent
  // answers A2A calls and only the agent has it. The credential summary reads
  // through credentialEvidenceOf like every other reader of
  // listBySubjectDid, so a deemed-completion document is never counted as a
  // hire. An unlisted agent still answers: its finished work stays public.
  app.get('/agents/:agentDid/card', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    let evidence: CredentialEvidence[] = [];
    try {
      row = await agentRepo.findByDid(did);
      if (row !== null) evidence = credentialEvidenceOf(await credentialRepo.listBySubjectDid(did));
    } catch (err) {
      console.error('GET /agents/:agentDid/card: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    let attestedBy: string;
    try {
      attestedBy = (await credentialsAdapter.describeIssuer()).issuer;
    } catch (err) {
      console.error('GET /agents/:agentDid/card: failed to describe the issuer', err);
      res.status(503).json({ error: 'issuer identity unavailable' });
      return;
    }

    res
      .status(200)
      .set('Cache-Control', 'public, max-age=300')
      .json(buildWorkHistoryExtension({ agent: row, credentials: evidence, publicBaseUrl: publicBaseUrlFromEnv(), attestedBy }));
  });

  // B9: the receipts listing every agent profile already
  // links to. Same shape as GET /agents/:agentDid/reviews above: look the
  // agent up first, 404 when it is not registered, then read the listing,
  // and map a storage throw to 503. credentialEvidenceOf is the one
  // narrowing every reader of listBySubjectDid goes through (P6), so a
  // deemed-completion document can never widen into a hire here.
  app.get('/agents/:agentDid/credentials', async (req: Request, res: Response) => {
    const did = String(req.params.agentDid);

    let row: Agent | null;
    try {
      row = await agentRepo.findByDid(did);
    } catch (err) {
      console.error('GET /agents/:agentDid/credentials: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: `agent ${did} is not registered` });
      return;
    }

    try {
      const stored = await credentialRepo.listBySubjectDid(did);
      const evidence = credentialEvidenceOf(stored);
      // B9's own pinned contract: this route exposes exactly the seven
      // fields it always has, never every field CredentialEvidence grows
      // for other readers. W1 (spec/wireframe/agent.html) added
      // additions/deletions/filesChanged to CredentialEvidence for the
      // work-history row's diff-size display; those ride the profile
      // route's own verifiedHires/portfolio arrays and must not silently
      // widen this receipts listing's response shape too.
      const credentials = evidence.map((entry) => ({
        credentialId: entry.credentialId,
        repository: entry.repository,
        pullRequest: entry.pullRequest,
        mergedAt: entry.mergedAt,
        mergeCommit: entry.mergeCommit,
        buyerDid: entry.buyerDid,
        repositoryPublic: entry.repositoryPublic,
      }));
      res.status(200).json({ agentDid: did, credentials });
    } catch (err) {
      console.error('GET /agents/:agentDid/credentials: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // P7 (scope item 6): the buyer conduct record, keyed to the buyer's
  // verified GitHub account, public because this is the record that is
  // supposed to be visible - the counts are already publicly checkable on
  // GitHub by anyone who cares to look. Counts only: never the job ids,
  // the repositories, the briefs, or the counterparties. `keyed: false`
  // is a distinct answer from a record of zeroes, never rendered as clean
  // counts, so a fresh throwaway identity cannot read as a spotless buyer.
  app.get('/buyers/:githubLogin/conduct', async (req: Request, res: Response) => {
    const githubLogin = String(req.params.githubLogin);
    try {
      // SW1-09: one list clock for both counts, so a job read as buyer and
      // as operator (a self-hire) is clocked once per request. The record
      // is public and anonymous, so the clocks ask GitHub for no more
      // than the public GET /jobs/:jobId already does, once per lapsed
      // submitted job.
      const clock = liveLapsesForList('GET /buyers/:githubLogin/conduct');
      const counts = await buyerConductForLogin(githubLogin, repo, jobRepo, clock);
      if (counts === null) {
        res.status(200).json({ githubLogin, keyed: false });
        return;
      }
      const operatorCounts = await operatorConductForLogin(githubLogin, repo, agentRepo, jobRepo, clock);
      res.status(200).json({ githubLogin, keyed: true, counts, operatorCounts });
    } catch (err) {
      console.error('GET /buyers/:githubLogin/conduct: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-15 (ENT-8): resolve an issued credential by its stable id. The
  // credential is a linked-data document, so it is served as
  // application/ld+json, verbatim from storage, so the proof still verifies
  // off-platform (invariant 2). No authentication: resolvable is part of
  // the contract (spec/work-history-extension-v1.md, credentials.endpoint).
  // Issuance is R-13's wiring; this route serves what it is handed.
  app.get('/v1/credentials/:credentialId', async (req: Request, res: Response) => {
    const credentialId = String(req.params.credentialId);
    try {
      const document = await credentialsAdapter.getCredential(credentialId);
      res.status(200).set('Content-Type', 'application/ld+json').send(JSON.stringify(document));
    } catch (err) {
      if (err instanceof CredentialNotFoundError) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      console.error('GET /v1/credentials/:credentialId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  });

  // R-16 (ENT-8.4): "marks work signed inside the window as disputed". This
  // reads the credential; it never rewrites it. The marker lives here, on a
  // route beside the document, and never inside it: ENT-8.3 forbids a
  // judgement inside the signature envelope, and invariant 2 requires the
  // bytes that verified to be the bytes served at
  // GET /v1/credentials/:credentialId, unchanged by a report ever being filed.
  app.get('/v1/credentials/:credentialId/status', async (req: Request, res: Response) => {
    const credentialId = String(req.params.credentialId);
    let document;
    try {
      document = await credentialsAdapter.getCredential(credentialId);
    } catch (err) {
      if (err instanceof CredentialNotFoundError) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      console.error('GET /v1/credentials/:credentialId/status: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    // P6: this route's whole meaning is "was the signature on a completed
    // hire made inside a reported compromise window" -- a question only a
    // CompletedHireCredential's signedBy/mergedAt pair can even pose. A
    // deemed-completion credential observed no merge and carries no
    // signature to check, so it is 404 here the same way an unknown id is:
    // there is no signed-work status to report.
    if (!isCompletedHireCredential(document)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const subject = document.credentialSubject.id;
    const signedBy = document.credentialSubject.hire.signedBy;
    const signedAt = document.credentialSubject.hire.mergedAt;

    let reports: readonly CompromiseReport[];
    try {
      reports = await compromiseRepo.listByAgentDid(subject);
    } catch (err) {
      console.error('GET /v1/credentials/:credentialId/status: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    const windows = disputedBy(reports, signedBy, new Date(signedAt));
    res.status(200).json({
      credentialId,
      subject,
      signedBy,
      signedAt,
      disputed: windows.length > 0,
      windows: windows.map(compromiseReportProjection),
    });
  });

  // R-28 (ENT-4): open a draft job from the buyer's brief. The route owns
  // only what the domain does not know about: body shape, DID and repository
  // syntax, and agent existence (a driver asymmetry: Prisma rejects an
  // unknown agentDid through its foreign key while memory accepts it, so
  // the check lives here to keep both drivers answering identically).
  // Everything about the brief itself, including its emptiness and the hash,
  // is delegated to createJob rather than restated.
  //
  // R-39 completion: buyerDid is DERIVED from the
  // proof the caller presented, never trusted from the body. requireSessionOrSignature
  // already guarantees a session or a verified signature exists; here that
  // proof is resolved to an actual account DID (resolveActingParty), and a
  // proof that resolves to nobody (a live session with no matching
  // registered account) is refused, the same way an absent proof would be.
  // A body-supplied buyerDid is optional and, when present, is checked
  // against the derived party and refused on mismatch -- it is NEVER
  // itself the value written to the job, so smuggling a different DID into
  // the body can only be refused, never honoured.
  app.post('/jobs', requireSessionOrSignature, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const claimedBuyerDid = body.buyerDid;
    const agentDid = body.agentDid;
    const agentDidsRaw = body.agentDids;
    const repository = body.repository;
    const brief = body.brief;

    // HT1 Part A2: `agentDids` is the multi-agent shape (1 to 3 agents in
    // one request, per the brief). `agentDid` is the pre-existing
    // single-agent shape and stays completely unchanged in both its body
    // and its 201 response, so no existing test that posts a single
    // agentDid is touched. The two are mutually exclusive on the wire:
    // naming both is a 400, not a guess at which one wins.
    if (agentDidsRaw !== undefined && agentDid !== undefined) {
      res.status(400).json({
        error: 'body must name agentDid or agentDids, not both',
      });
      return;
    }

    let agentDids: string[];
    const isMultiAgentRequest = agentDidsRaw !== undefined;
    if (isMultiAgentRequest) {
      if (
        !Array.isArray(agentDidsRaw) ||
        agentDidsRaw.length === 0 ||
        !agentDidsRaw.every((value) => typeof value === 'string' && value.length > 0)
      ) {
        res.status(400).json({
          error: 'agentDids must be a non-empty array of non-empty agent DID strings',
        });
        return;
      }
      if (agentDidsRaw.length > 3) {
        res.status(400).json({
          error: 'a brief may go to at most 3 agents in one request',
        });
        return;
      }
      if (new Set(agentDidsRaw).size !== agentDidsRaw.length) {
        res.status(400).json({
          error: 'agentDids must not name the same agent twice',
        });
        return;
      }
      agentDids = agentDidsRaw as string[];
    } else {
      if (
        (claimedBuyerDid !== undefined && typeof claimedBuyerDid !== 'string') ||
        typeof agentDid !== 'string' || agentDid.length === 0 ||
        typeof repository !== 'string' || repository.length === 0 ||
        typeof brief !== 'string' || brief.length === 0
      ) {
        res.status(400).json({
          error: 'body must be { agentDid, repository, brief, buyerDid? }; agentDid, repository, brief non-empty strings, buyerDid (if present) a string',
        });
        return;
      }
      agentDids = [agentDid];
    }

    if (
      (claimedBuyerDid !== undefined && typeof claimedBuyerDid !== 'string') ||
      typeof repository !== 'string' || repository.length === 0 ||
      typeof brief !== 'string' || brief.length === 0
    ) {
      res.status(400).json({
        error: isMultiAgentRequest
          ? 'body must be { agentDids, repository, brief, buyerDid? }; repository, brief non-empty strings, buyerDid (if present) a string'
          : 'body must be { agentDid, repository, brief, buyerDid? }; agentDid, repository, brief non-empty strings, buyerDid (if present) a string',
      });
      return;
    }

    for (const candidateDid of agentDids) {
      if (!isValidOperatorDid(candidateDid)) {
        res.status(400).json({
          error: 'agentDid must look like did:abt:<suffix>, non-empty suffix, no whitespace',
        });
        return;
      }
    }
    // owner/name on GitHub (ENT-4). This check is syntactic only; whether
    // the repository exists and can take the work is read once, further
    // down, after every cheaper refusal has passed and before any job is
    // written.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) {
      res.status(400).json({
        error: 'repository must be an owner/name pair like buyer/target-repo',
      });
      return;
    }

    // R-39 completion: the acting party, derived server-side from whichever
    // proof requireSessionOrSignature accepted. One code path, both proofs.
    let buyerDid: string | null;
    try {
      buyerDid = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('POST /jobs: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (buyerDid === null) {
      res.status(403).json({
        error: 'no registered account resolves from your session or signature; register an account before hiring',
      });
      return;
    }
    if (typeof claimedBuyerDid === 'string' && claimedBuyerDid.length > 0 && claimedBuyerDid !== buyerDid) {
      res.status(403).json({ error: 'buyerDid does not match the authenticated party' });
      return;
    }

    // HT1 Part A2: every named agent is validated (existence, then the
    // buyer-conduct threshold gate) BEFORE any job row is written, so a
    // request naming 3 agents where the third is unregistered or refuses
    // the buyer's conduct record creates zero jobs, not two orphaned ones.
    const agentRows: Agent[] = [];
    for (const candidateDid of agentDids) {
      let agentRow: Agent | null;
      try {
        agentRow = await agentRepo.findByDid(candidateDid);
      } catch (err) {
        console.error('POST /jobs: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (agentRow === null) {
        res.status(404).json({
          error: `agent ${candidateDid} is not registered; delegate an agent on this DID before opening a job for it`,
        });
        return;
      }
      agentRows.push(agentRow);
    }

    // FIX-B43a (ruling, 2026-09-27): "unlisted, the agent... refuses new
    // hires." Checked after every named agent row loads (an unregistered
    // agent stays 404, checked first) and before the buyer-conduct gate,
    // the same all-or-nothing rule the 404 above already keeps: one
    // unlisted agent refuses the whole request and writes zero jobs.
    // Unlisting never revokes the delegation and never touches a job
    // already open, so this is the only place a listing flip is read on
    // the hire path.
    for (const agentRow of agentRows) {
      if (!agentRow.listed) {
        res.status(409).json({
          error: 'this agent is not taking new hires right now; its owner has stopped listing it',
        });
        return;
      }
    }

    // P7: the operator's own listing filters on buyer conduct. Enforced
    // here, after the acting party resolves and after every agent row
    // loads, so a caller sees the earlier failures (unresolved party,
    // unregistered agent) first. Null means no filter: skip the read
    // entirely when the operator set neither threshold, so an honest
    // agent with no filters never pays for a lookup it never asked for.
    let buyerCounts: BuyerConduct | null | undefined;
    for (const agentRow of agentRows) {
      if (agentRow.minBuyerMerges === null && agentRow.maxWalkedAfterConfirm === null) continue;
      if (buyerCounts === undefined) {
        try {
          // SW1-09: the threshold reads the same record the public
          // conduct page shows, so it runs the same clocks: a pull
          // request merged inside the window counts as a merge even
          // when nobody opened the job after it.
          buyerCounts = await buyerConductForDid(buyerDid, repo, jobRepo, liveLapsesForList('POST /jobs'));
        } catch (err) {
          console.error('POST /jobs: storage failed', err);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
      }
      const failure = buyerConductThresholdFailure(buyerCounts, {
        minBuyerMerges: agentRow.minBuyerMerges,
        maxWalkedAfterConfirm: agentRow.maxWalkedAfterConfirm,
      });
      if (failure !== null) {
        res.status(403).json({ error: buyerConductFailureMessage(failure) });
        return;
      }
    }

    // HT1 Part A2: requestId is set only when this request actually named
    // 2 or 3 agents (the design ruling on this seam). A single agentDids entry -- and the
    // pre-existing agentDid shape, always -- leaves it null, the same
    // meaning every pre-A2 row already carries.
    const requestId = agentDids.length > 1 ? 'req-' + randomBytes(8).toString('hex') : null;

    // The domain owns the brief rule (createJob rejects a brief that is
    // empty or whitespace-only): the route maps the thrown JobError to 400
    // and passes its message through, so there is one wording of the rule,
    // not two. Checked once, against the shared brief, before any row is
    // written: an empty brief refuses the whole request, not just one job.
    const jobsToCreate: Job[] = [];
    for (const candidateDid of agentDids) {
      const id = 'j-' + randomBytes(8).toString('hex');
      let job: Job;
      try {
        job = createJob({ id, buyerDid, agentDid: candidateDid, repository, brief, requestId }, new Date());
      } catch (err) {
        if (err instanceof JobError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      jobsToCreate.push(job);
    }

    // The request's one repository is read once here, whatever the agent
    // count, after every cheaper refusal above (so a request refused
    // anyway makes no GitHub call) and before the first row is written
    // (so a refusal writes zero jobs and notifies nobody). The deposit
    // doors and confirm read it again, because the repository can change
    // between the brief and the money. No job exists yet, so the
    // sentences carry no job address.
    //
    // A GitHub failure (a 503 from the shared check) does not refuse the
    // brief: a brief moves no money, and both money doors and confirm
    // re-read the repository before anything is paid or staged. It is
    // logged for the operator and the hire opens.
    const repositoryReadiness = await checkRepositoryReady(github, {
      repository,
      jobId: null,
      agentGithubLogin: null,
    });
    if (!repositoryReadiness.ok) {
      if (repositoryReadiness.status === 409) {
        res.status(409).json({ error: repositoryReadiness.message });
        return;
      }
      console.error('POST /jobs: repository read failed', repositoryReadiness.cause);
    }

    const createdRows: Job[] = [];
    try {
      for (const job of jobsToCreate) {
        createdRows.push(await jobRepo.create(job));
      }
    } catch (err) {
      // A duplicate id needs 64 bits of collision to fire and the id was
      // drawn this request, so this branch is unreachable in practice; it
      // is kept so the mapping is deterministic should entropy ever
      // shrink. The message names the id THIS ROUTE drew and passed to
      // create(), not whatever the thrown error's own message says (a
      // scripted stand-in may report a different id than it was asked to
      // create), matching every other id-naming refusal in this file.
      if (err instanceof JobAlreadyExistsError) {
        const failedJob = jobsToCreate[createdRows.length];
        res.status(409).json({ error: `job ${failedJob?.id ?? ''} already exists` });
        return;
      }
      console.error('POST /jobs: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }

    if (agentDids.length > 1) {
      // HT1 Part A2 (design ruling, sibling privacy is structural): the buyer is a party to every
      // sibling it just opened, so its own creation reply may name all of
      // them -- this is the one place besides the buyer's own
      // /accounts/:did/jobs list where that is true. jobProjection() itself
      // still never carries requestId or a sibling's facts to anyone else.
      // A request that named exactly one agent -- whether through the
      // legacy agentDid field or through agentDids with one entry -- gets
      // the bare single-job shape below: "the single-agent POST /jobs
      // shape... is one agent in a list of one" (the card's own wording).
      for (const row of createdRows) {
        await notifyJobParties(row, 'new_brief', buyerDid);
      }
      res.status(201).json({
        requestId,
        jobs: createdRows.map((row, i) => ({
          ...jobProjection(row),
          ...githubAccessNeededFor(agentRows[i] ?? null, row, github.platformLogin),
        })),
      });
      return;
    }
    await notifyJobParties(createdRows[0]!, 'new_brief', buyerDid);
    res.status(201).json({
      ...jobProjection(createdRows[0]!),
      ...githubAccessNeededFor(agentRows[0] ?? null, createdRows[0]!, github.platformLogin),
    });
  });

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    let row: Job | null;
    try {
      row = await jobRepo.findById(String(req.params.jobId));
    } catch (err) {
      console.error('GET /jobs/:jobId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    if (row === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const lapsed = await applyLiveLapses('GET /jobs/:jobId', row, res);
    if (lapsed === null) return;
    row = lapsed;
    // ORG1: the same one field POST /jobs carries, read fresh here so a
    // live GET reflects the agent's CURRENT verified login, never a
    // stale one captured at job creation.
    let jobAgent: Agent | null;
    try {
      jobAgent = await agentRepo.findByDid(row.agentDid);
    } catch (err) {
      console.error('GET /jobs/:jobId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    const accessNeeded = githubAccessNeededFor(jobAgent, row, github.platformLogin);
    // FIX-B39 (B39), rule 6: payableRails rides GET /jobs/:jobId
    // only, and only while the job is still 'proposed' and carries a
    // price -- the same conditional stance githubAccessNeeded takes on
    // this route. After confirm, price.rail is the one currency; there
    // is nothing left for this key to add.
    let payableRails: { readonly payableRails: readonly Rail[] } | Record<string, never> = {};
    if (row.status === 'proposed' && row.priceUsd !== null) {
      try {
        payableRails = {
          payableRails: await payableRailsFor(
            row,
            jobAgent,
            repo,
            settlementRepo,
            (await heldLegOf(row.id, 'deposit'))?.rail ?? null,
          ),
        };
      } catch (err) {
        console.error('GET /jobs/:jobId: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
    }
    // FIX-B74: `depositSettled` (boolean) rides GET /jobs/:jobId only, and
    // only on a 'proposed' job, so a page can word the paid state (the
    // agreement is locked against changes and only the buyer's confirm is
    // left). Read from the settlement repository payableRailsFor reads.
    // Absent on every other status (a confirmed job's deposit is settled
    // by definition) and never in jobProjection, so no write route and no
    // POST /jobs response carries it.
    let depositSettledKey: { readonly depositSettled: boolean } | Record<string, never> = {};
    if (row.status === 'proposed') {
      try {
        depositSettledKey = { depositSettled: (await settlementRepo.findByJobAndLeg(row.id, 'deposit')) !== null };
      } catch (err) {
        console.error('GET /jobs/:jobId: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
    }
    // Only a completed or deemed-completed job can carry a credential, so
    // every other row never pays for the lookup. P6 widens this guard:
    // deemed_completed carries a distinct credential type but no
    // mergeCommit (deemCompleted never sets one -- no merge was
    // observed), so the mergeCommit-only guard from before this card
    // would silently skip the lookup for every deemed-completed job.
    if (row.mergeCommit === null && row.status !== 'deemed_completed') {
      res.status(200).json({ ...jobProjection(row), ...accessNeeded, ...payableRails, ...depositSettledKey });
      return;
    }
    let credential: IssuedCredentialDocument | null;
    try {
      // The lookup key is the job id: credentialLookupKey takes the last
      // path segment, and a bare id is its own key - the same key the merge
      // route saved under.
      credential = await credentialRepo.findByDocumentId(row.id);
    } catch (err) {
      console.error('GET /jobs/:jobId: storage failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return;
    }
    // Absent, never null, when nothing was stored: absence says "there is no
    // credential", where a null would read as "issued, and empty".
    res
      .status(200)
      .json(
        credential === null
          ? { ...jobProjection(row), ...accessNeeded }
          : { ...jobProjection(row), ...accessNeeded, credential },
      );
  });

  // Express 4 does not route a rejected promise from an async handler to
  // its error layer: a rethrow like runExchange's would vanish into an
  // unhandled rejection and take the whole process down. Forwarding the
  // rejection here keeps the handler's own mapping untouched (JobError is
  // still mapped to 400 inside runExchange) while anything unexpected
  // reaches the terminal handler below as a 500 instead of a crash.
  function forwarded(fn: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  }

  // R-8's shared skeleton for the criteria exchange: load the job, let the
  // domain apply its rule, persist through repo.update. The error mapping
  // mirrors POST /jobs: a bad body or a domain rule is the caller's to fix
  // (400), an unknown id is 404, a state conflict is 409, and storage trouble
  // is 503 with the cause in the log, not the body.
  //
  // Split into a load half and an apply-and-persist half so the caller-
  // identity gate below (runPartyExchange) can insert itself between the
  // two without a second jobRepo.findById call: the exchange routes' own
  // storage-fault tests pin the exact call sequence a route makes, and a
  // second read would be an observable, untested behaviour change for no
  // reason.
  //
  // P4: the clocks used to bind only
  // to GET, so a job that lapsed while nobody was looking could still be
  // ACTED ON by a mutation route -- staging or opening a pull request on
  // an already-expired confirmed job, or opening one on a staged job that
  // had gone seven days unpaid. Applying the live lapse check here, in the
  // one load every mutation and exchange route shares, closes that gap at
  // its single choke point instead of one route at a time, and removes
  // the order dependency GET introduced: the outcome no longer depends on
  // whether some unrelated caller issued a read first.
  //
  // SW1-09: this is the choke point for job MUTATIONS and exchange routes.
  // The reads that report a job run the same clocks too: GET /jobs/:jobId
  // directly, and the list reads (job list, thread list, public conduct
  // record, the POST /jobs conduct threshold) through liveLapsesForList.
  async function loadForExchange(label: string, jobId: string, res: Response): Promise<Job | null> {
    let current: Job | null;
    try {
      current = await jobRepo.findById(jobId);
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return null;
    }
    if (current === null) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    return applyLiveLapses(label, current, res);
  }

  // The live half of applyLapses: two of its four clocks need a fact
  // beyond the row itself. lapseAtStaged needs whether the balance has
  // settled (or waits on the owner as a short payment), and lapseUndelivered
  // needs when the remainder settled (the
  // observedAt of its settlement row), so this is where the settlement
  // gate and the settlement row are actually asked, for staged
  // AND redo_requested (the earlier
  // fix widened lapseAtStaged to also cover redo_requested, but this
  // function still asked the gate only for staged, so a paid buyer with a
  // pending redo was fed a fabricated "not settled" answer and could be
  // terminated closed_unpaid with the gate never consulted). The other
  // two clocks, expireUnstaged and deemCompleted, never consult the
  // settlement gate or the settlement row; deemCompleted's own live
  // question, whether GitHub saw a merge inside the review window, is
  // asked by askGithubBeforeDeeming below. Deriving the set from
  // lapseAtStaged's own starting statuses, rather than repeating a second
  // literal here, is what keeps this call site from silently falling
  // behind the domain function again the next time that set changes. A
  // gate failure here is treated exactly like any other settlement-gate
  // failure in this file (POST /jobs/:jobId/pull-request's own leg): 503,
  // not a silent fail-closed guess, because reporting a status this call
  // could not actually verify is the same defect class the fail-closed
  // default gate exists to prevent. The persistence half stays
  // best-effort (as GET's stance always was): a write failure here must
  // not turn an otherwise-successful read or mutation into a false 503,
  // so the computed row is still what the caller sees either way.
  // P6: a deemed-completion credential is
  // recoverable, not one-shot. The transition itself (submitted ->
  // deemed_completed) still happens exactly once, the moment applyLapses
  // observes it, but issuance is decoupled from that single instant: any
  // later read of a job that is ALREADY deemed_completed and still has no
  // stored credential retries issuance instead of accepting the residual
  // as permanent. Unlike POST /jobs/:jobId/merge, nothing ever calls this
  // path again on a caller's behalf (there is no retry route, no
  // scheduler), so the retry has to live at the one choke point every
  // read and mutation already shares. findByDocumentId is checked first
  // so a job that already has its credential never pays for a second
  // signature, and CredentialAlreadyIssuedError (thrown by every
  // CredentialRepository.save on a duplicate key) is the belt-and-braces
  // guard against the narrow race between that check and this save.
  async function issueDeemedCompletionCredentialIfMissing(label: string, job: Job): Promise<void> {
    if (job.stagedCommit === null) return;
    let existing: IssuedCredentialDocument | null;
    try {
      existing = await credentialRepo.findByDocumentId(job.id);
    } catch (err) {
      console.error(`${label}: deemed-completion credential lookup failed`, err);
      return;
    }
    if (existing !== null) return;
    try {
      const claim: DeemedCompletionClaim = {
        jobId: job.id,
        stagedCommit: job.stagedCommit,
        buyerDid: job.buyerDid,
      };
      const credential = await credentialsAdapter.issueDeemedCompletionCredential(job.agentDid, claim);
      await credentialRepo.save({
        completedJobId: job.id,
        subjectDid: job.agentDid,
        document: credential,
        // R-17's evidence-tier fact has no meaning for a deemed
        // completion (no merge was ever observed to check publicity
        // against); false is the same fail-closed default every other
        // non-hire path in this file already uses.
        repositoryPublic: false,
      });
    } catch (err) {
      if (err instanceof CredentialAlreadyIssuedError) return;
      console.error(`${label}: deemed-completion credential issuance failed`, err);
    }
  }

  // FIX-B60D: the observation of a submitted job's pull request, shared by
  // POST /jobs/:jobId/merge and the deem path in applyLiveLapses. It parses
  // the stored URL, asks GitHub (ENT-7.1: never the caller) and runs the STG2
  // attested-commit check, writing nothing. A malformed URL is a corrupted
  // row and THROWS, as the route always did; the deem path catches it.
  type HttpAnswer = { readonly kind: 'answer'; readonly status: number; readonly body: { readonly error: string } };
  type PullRequestObservation =
    | HttpAnswer
    | { readonly kind: 'head_moved'; readonly attested: string | null; readonly head: string }
    | { readonly kind: 'observed'; readonly summary: PullRequestSummary; readonly pullRequestUrl: string };
  type MergedCompletion =
    | HttpAnswer
    | { readonly kind: 'completed'; readonly row: Job; readonly credential: VerifiableCredential };

  async function observePullRequest(label: string, job: Job): Promise<PullRequestObservation> {
    // A submitted job always carries a URL in the shape submitPullRequest
    // itself wrote (R-10); anything else is a corrupted row, not a caller
    // error, so it reaches the terminal handler as a 500 like the
    // pull-request route's own corrupted-state leg.
    const pullRequestUrl = job.pullRequestUrl;
    const match =
      pullRequestUrl === null ? null : /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(pullRequestUrl);
    if (match === null || pullRequestUrl === null) {
      throw new Error(`job ${job.id} is submitted but pullRequestUrl is missing or malformed`);
    }
    const [, owner, repo, prNumber] = match;
    if (owner === undefined || repo === undefined || prNumber === undefined) {
      throw new Error(`job ${job.id} is submitted but pullRequestUrl is missing or malformed`);
    }
    const ref: PullRequestRef = { owner, repo, number: Number(prNumber) };

    let summary: PullRequestSummary;
    try {
      summary = await github.getPullRequest(ref);
    } catch (err) {
      console.error(`${label}: github unavailable`, err);
      return { kind: 'answer', status: 503, body: { error: 'github unavailable' } };
    }

    // STG2: the attested-commit check, before ANY outcome is recorded --
    // open, closed or merged alike. The agent forked the buyer's
    // repository itself and holds push on that fork, so nothing stops
    // it from resetting the branch after the platform attested a
    // commit; this is the check that catches that. An open PR can be
    // fixed by the agent resetting the branch back to the attested
    // commit; a closed or merged PR whose head moved records nothing
    // either, since a mismatch here means this was never the work the
    // platform attested to.
    if (!chainIdentifiersMatch(summary.headSha, job.stagedCommit)) {
      return { kind: 'head_moved', attested: job.stagedCommit, head: summary.headSha };
    }
    return { kind: 'observed', summary, pullRequestUrl };
  }

  // The instant a merged pull request completed the job: GitHub's fact
  // (ENT-7.1); only a response with no timestamp is observed now, which on
  // the deem path is after the window, so that answer deems the job.
  function mergeInstantOf(summary: PullRequestSummary): Date {
    return summary.mergedAt ?? new Date();
  }

  // The one place an agent's platform-held key is re-derived from its row:
  // github-proof/start and the merge's credential both call it, so the two
  // cannot drift. The inputs are the ones the site listing used to mint the
  // DID, row.operatorDid and the delegation's own id (never
  // row.delegation.issuer, see github-proof/start). The platform holds the
  // key only when that derivation gives back EXACTLY row.did; a wallet-path
  // agent, or a site agent that brought its own DID, gets null and no key is
  // ever guessed for it. PlatformSeedUnavailableError and any other failure
  // of the derivation are thrown for the caller to map.
  async function derivePlatformHeldAgentKey(row: Agent): Promise<DidKeyPair | null> {
    const derived = await identityAdapter.createAgentDid(row.operatorDid, row.delegation.id);
    return derived.did === row.did ? derived : null;
  }

  // The verification method the credential names as the agent's key (ENT-8):
  // the key observed on the agent's own signed requests when there is one,
  // else, for an agent the platform holds a key for (a site-listed agent,
  // which never signs a request), the key re-derived from its row. Every
  // other outcome throws: a resolveDid failure that is not a missing key (a
  // resolver outage), no agent row, an agent the platform holds no key for,
  // a missing seed, a storage failure. The caller answers all of them 503.
  async function agentKeyForCredential(agentDid: string): Promise<string> {
    try {
      const doc = await identityAdapter.resolveDid(agentDid);
      const method = doc.verificationMethod[0];
      if (method === undefined) {
        throw new Error(`the DID document for ${agentDid} carries no verification method`);
      }
      return method;
    } catch (err) {
      if (!(err instanceof DidNotResolvableError)) throw err;
    }
    const row = await agentRepo.findByDid(agentDid);
    if (row === null) {
      throw new Error(`no agent row for ${agentDid}; its key cannot be named`);
    }
    const derived = await derivePlatformHeldAgentKey(row);
    if (derived === null) {
      throw new Error(`the platform holds no key for ${agentDid} and none has been observed; its key cannot be named`);
    }
    return `${row.did}#${derived.publicKeyMultibase}`;
  }

  // FIX-B60D: the merged branch of POST /jobs/:jobId/merge, moved here so
  // the deem path completes a job by the same steps. A merged summary with
  // no merge commit sha THROWS, as the route always did; the deem path
  // catches it.
  async function completeMergedPullRequest(
    label: string,
    job: Job,
    observed: { readonly summary: PullRequestSummary; readonly pullRequestUrl: string },
  ): Promise<MergedCompletion> {
    const { summary, pullRequestUrl } = observed;
    // A merged state with no merge commit sha is an inconsistent github
    // response, not a caller error: ENT-7 requires the merge commit, so
    // this is our problem to surface as a 500, not a 409 or 400.
    if (summary.mergeCommitSha === null) {
      throw new Error(`github reported job ${job.id}'s pull request merged with no merge commit sha`);
    }
    const mergeCommitSha = summary.mergeCommitSha;

    let outcome: { readonly job: Job; readonly completedJob: Omit<CompletedJob, 'id'> };
    try {
      outcome = completeJob(job, { mergeCommit: mergeCommitSha, completedAt: mergeInstantOf(summary) });
    } catch (err) {
      // Covers a job that completed between the read above and here.
      if (err instanceof JobTransitionError) {
        return { kind: 'answer', status: 409, body: { error: err.message } };
      }
      throw err;
    }

    // ENT-8: the credential names the agent's key, so its verification
    // method is named before anything is written. Two sources, in this
    // order: the key observed on the agent's own signed requests, then the
    // key the platform re-derives for a site-listed agent (see
    // agentKeyForCredential). Same mapping as POST
    // /agents/:agentDid/account-proof: a key we cannot name is a platform
    // failure, not a caller error, and the job stays submitted and fully
    // retryable.
    let signedBy: string;
    try {
      signedBy = await agentKeyForCredential(job.agentDid);
    } catch (err) {
      console.error(`${label}: identity resolution failed`, err);
      return { kind: 'answer', status: 503, body: { error: 'identity resolution unavailable' } };
    }

    // Issuance BEFORE persistence, deliberately: a failed signing leaves
    // the job submitted and retryable, rather than completing a hire this
    // platform cannot attest to.
    const claim: WorkHistoryClaim = {
      jobId: job.id,
      repository: job.repository,
      pullRequestUrl,
      mergeCommitSha,
      // GitHub's instant, the same one stamped on the row (ENT-7.1).
      mergedAt: outcome.completedJob.completedAt.toISOString(),
      diffAdditions: summary.additions,
      diffDeletions: summary.deletions,
      diffFiles: summary.filesChanged,
      briefHash: job.briefHash,
      specHash: job.confirmedSpecHash,
      buyerDid: job.buyerDid,
      signedBy,
    };
    let credential: VerifiableCredential;
    try {
      credential = await credentialsAdapter.issueWorkHistoryCredential(job.agentDid, claim);
    } catch (err) {
      console.error(`${label}: credential issuance failed`, err);
      return { kind: 'answer', status: 503, body: { error: 'credential issuance unavailable' } };
    }

    let row: Job | null;
    try {
      row = await jobRepo.complete(outcome.job, outcome.completedJob);
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      return { kind: 'answer', status: 503, body: { error: 'storage unavailable' } };
    }
    if (row === null) {
      // The row vanished between the read and the write.
      return { kind: 'answer', status: 404, body: { error: 'not found' } };
    }

    // Two writes to one driver with no transaction spanning them. The
    // residual is named rather than hidden: a crash between them leaves a
    // completed job with no credential, and the retry meets the 409 the
    // completed status already returns. Nothing is lost - the credential
    // is re-derivable from the stored job row, github's report and the
    // platform key - but it is not re-derived automatically.
    try {
      await credentialRepo.save({
        completedJobId: row.id,
        subjectDid: row.agentDid,
        document: credential,
        // R-17 (invariant 4, proof gate finding): the one fact
        // evidenceTier needs beyond the merge itself, read off github's own
        // report on the same PR object the merge commit came from. Before
        // this line no writer ever passed the field, so every real hire
        // defaulted to the fail-closed false and could never reach
        // verified-hire, no matter how public the repository actually was.
        repositoryPublic: summary.repositoryPublic,
      });
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      return { kind: 'answer', status: 503, body: { error: 'storage unavailable' } };
    }

    // HT1 Part B: "system events (... completed) are rows in the same
    // thread." Best-effort, logged, never turns a successful merge
    // into a 503: the credential is already durably issued by this
    // point, and a message write failing here must not undo that.
    try {
      const systemRow = await messageRepo.create(
        createSystemMessage(
          {
            id: 'm-' + randomBytes(8).toString('hex'),
            jobId: row.id,
            body: 'Completed',
            systemEvent: { type: 'completed', mergeCommit: mergeCommitSha },
          },
          new Date(),
        ),
      );
      broadcastThreadEvent(row.id, 'message', messageProjection(systemRow));
    } catch (err) {
      console.error(`${label}: failed to write the completed system row`, err);
    }

    return { kind: 'completed', row, credential };
  }

  // FIX-B60D: a job this load completed from a merge dated inside the window,
  // keyed by the row applyLiveLapses returned, with its receipt. The merge
  // route reads it so the request that caused the completion answers 200
  // with the receipt, not the 409 of a job completed by an earlier request.
  const completedOnLoad = new WeakMap<Job, VerifiableCredential>();

  // FIX-B60D (B60, second half): what applyLiveLapses asks, once,
  // before the deem clock runs on a submitted job whose review window has
  // passed. The clock is pure and cannot know the buyer merged on day 3 of a
  // job nobody opened until day 8, so the platform asks GitHub through the
  // merge route's own observation. The answers:
  //   completed: merged inside the window; the job is persisted completed
  //     with the work-history credential.
  //   deem: open, closed, merged after the window, merged with no date, or
  //     the head moved off the attested commit; the caller runs the deem
  //     clock and issues the deemed-completion credential as before.
  //   answered: GitHub, identity, signing or storage failed and the 503 is
  //     sent. The job stays submitted, nothing is issued, the next read asks
  //     again. A failure NEVER falls through to deeming: a merged pull
  //     request must not get a receipt saying no merge was observed.
  //     GET /jobs/:jobId is not wrapped in `forwarded`, so every throw is
  //     caught here rather than left as an unhandled rejection.
  // Once completed or deemed the job is no longer `submitted`, so this never
  // asks twice.
  async function askGithubBeforeDeeming(
    label: string,
    job: Job,
    res: Response,
  ): Promise<{ readonly kind: 'completed'; readonly row: Job } | { readonly kind: 'deem' } | { readonly kind: 'answered' }> {
    try {
      const observation = await observePullRequest(label, job);
      if (observation.kind === 'answer') {
        res.status(observation.status).json(observation.body);
        return { kind: 'answered' };
      }
      if (observation.kind === 'head_moved') return { kind: 'deem' };
      const { summary } = observation;
      if (summary.state !== 'merged' || !mergedInsideWindow(job, mergeInstantOf(summary))) {
        return { kind: 'deem' };
      }
      const completion = await completeMergedPullRequest(label, job, observation);
      if (completion.kind === 'answer') {
        res.status(completion.status).json(completion.body);
        return { kind: 'answered' };
      }
      completedOnLoad.set(completion.row, completion.credential);
      return { kind: 'completed', row: completion.row };
    } catch (err) {
      console.error(`${label}: could not observe the pull request before deeming`, err);
      res.status(503).json({ error: 'github unavailable' });
      return { kind: 'answered' };
    }
  }

  // The one place the job clocks run live: the settlement gate and the
  // short-payment store for staged and redo_requested jobs (a remainder that
  // reached the owner worth less than the agreed price waits on the owner and
  // is not closed as unpaid), GitHub once before deeming a submitted job
  // past its window, then applyLapses, the deemed-completion credential and
  // the persisted row. Every read that reports a job runs it: GET
  // /jobs/:jobId and loadForExchange (the load every job mutation and
  // exchange route shares) call it directly and answer 503 when it answers
  // null; the list reads (the buyer's job list, both seats of the thread
  // list, the public conduct record, the POST /jobs conduct threshold) go
  // through liveLapsesForList below, which never lets a null answer fail
  // the whole list.
  async function applyLiveLapses(label: string, job: Job, res: Response): Promise<Job | null> {
    let remainderIsSettled = false;
    let remainderSettledAt: Date | null = null;
    let awaitingOwner = false;
    if (LAPSE_AT_STAGED_STATUSES.has(job.status)) {
      try {
        remainderIsSettled = await remainderSettled(settlementGate, job.id);
      } catch (err) {
        console.error(`${label}: settlement gate failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return null;
      }
      // The delivery clock counts from the instant the remainder's
      // settlement row was first recorded. The gate says whether it
      // settled; only the row says when. A read that fails is the same
      // 503 as the gate's, never a guess at a time.
      try {
        const settlement = await settlementRepo.findByJobAndLeg(job.id, 'remainder');
        remainderSettledAt = settlement === null ? null : settlement.observedAt;
      } catch (err) {
        console.error(`${label}: settlement read failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return null;
      }
      // A remainder whose ABT-on-Ethereum payment reached the owner worth
      // less than the agreed price and is not settled waits on the owner's
      // answer. It is not unpaid, so the unpaid clock does not close it
      // while it waits; the delivery clock stays off because nothing has
      // settled. A failed read is the same 503, never "not short".
      if (!remainderIsSettled) {
        try {
          awaitingOwner = (await railHeldByShortPayment({ jobId: job.id, leg: 'remainder', abtEthShorts, settlementRepo })) !== null;
        } catch (err) {
          console.error(`${label}: short payment read failed`, err);
          res.status(503).json({ error: 'storage unavailable' });
          return null;
        }
      }
    }
    const now = new Date();
    if (deemWindowHasPassed(job, now)) {
      const asked = await askGithubBeforeDeeming(label, job, res);
      if (asked.kind === 'answered') return null;
      if (asked.kind === 'completed') return asked.row;
    }
    // The unpaid clock is told the remainder is not unpaid when it settled
    // or when it waits on the owner (awaitingOwner); the delivery clock is
    // told only the settled time, so it stays off for a remainder that
    // waits.
    const lapsed = applyLapses(job, now, remainderIsSettled || awaitingOwner, remainderSettledAt);
    if (lapsed.status === job.status) {
      // Already settled at this status on an earlier read -- but if that
      // earlier read is the one whose issuance attempt failed, this is
      // the read that recovers it (see the function's own header comment
      // above for why the retry has to live here rather than a caller).
      if (job.status === 'deemed_completed') {
        await issueDeemedCompletionCredentialIfMissing(label, job);
      }
      return job;
    }
    // P6 (design record row 3): the deemed-completion credential is
    // issued the instant the live check itself observes the transition,
    // the same "issue before persisting the outcome" order POST
    // /jobs/:jobId/merge already keeps for the work-history credential.
    // Deliberately best-effort like the rest of this function: a failure
    // here must not turn an otherwise-successful read or mutation into a
    // 503, since the lapse itself already happened and the job's OWN row
    // is the source of truth this function persists regardless. A crash
    // or a transient signing fault here no longer loses the credential
    // for good -- the very next read of this now-deemed_completed job
    // retries through the branch above.
    if (lapsed.status === 'deemed_completed') {
      await issueDeemedCompletionCredentialIfMissing(label, lapsed);
    }
    try {
      const persisted = await jobRepo.update(lapsed);
      return persisted ?? lapsed;
    } catch (err) {
      console.error(`${label}: failed to persist a lapsed status`, err);
      return lapsed;
    }
  }

  // SW1-09: the clocks for a list read. One clock per request, built by
  // the route (label names the route in the log): it runs applyLiveLapses
  // for each job it is handed and answers the rows a single-job read would
  // answer, in the same order. Nothing reaches the real response from in
  // here: applyLiveLapses writes its 503 to a sink that only records that
  // it was written.
  //
  // A job whose live check cannot be answered (the settlement gate or
  // GitHub failed, so applyLiveLapses answered null) keeps its stored row,
  // and the list still answers 200. The single-job read answers 503 because
  // it has one job to refuse; a list has others in it, and one unreachable
  // pull request must not take a buyer's whole job list, or a public
  // record, down. The stored row is the answer this read gave before the
  // clocks ran on lists, and the next read asks again. The kept row is
  // logged, never silent.
  //
  // A job the clock has already answered in this request (the same buyer
  // read as operator, a self-hire) is answered from memory, so the clocks
  // run once per job per request, GitHub included.
  function liveLapsesForList(label: string): JobListClock {
    const answered = new Map<string, Job>();
    return async (jobs) => {
      const rows: Job[] = [];
      // One job at a time: only a job past a deadline asks GitHub, and a
      // long list must not open a burst of upstream calls at once.
      for (const stored of jobs) {
        const earlier = answered.get(stored.id);
        if (earlier !== undefined) {
          rows.push(earlier);
          continue;
        }
        let refused = false;
        const sink = {
          status: () => sink,
          json: () => {
            refused = true;
            return sink;
          },
        } as unknown as Response;
        let row: Job | null = null;
        try {
          row = await applyLiveLapses(label, stored, sink);
        } catch (err) {
          console.error(`${label}: live check threw for job ${stored.id}`, err);
        }
        if (row === null || refused) {
          console.error(`${label}: kept the stored row of job ${stored.id}, its live check could not be answered`);
          row = stored;
        }
        answered.set(stored.id, row);
        rows.push(row);
      }
      return rows;
    };
  }

  // P4: the payment gate parameter every gated route (confirm,
  // pull-request) shares. Optional and inserted BETWEEN the pure apply
  // and the persist, so the existing 400/409 answers for a bad body,
  // outstanding criteria or a wrong transition keep firing first exactly
  // as before (the pure `apply` above still throws on those, unchanged) --
  // the money check runs only once the domain has already agreed the
  // transition itself is legal, and it runs before anything is written.
  interface PaymentGateCheck {
    // Answers whether the leg this route cares about is settled.
    readonly settled: (jobId: string) => Promise<boolean>;
    // The 402 body once `apply` has already succeeded but the leg has
    // not settled -- carries what the buyer must still pay.
    readonly unsettledBody: (updated: Job) => Record<string, unknown>;
  }

  async function applyAndPersist(
    label: string,
    res: Response,
    current: Job,
    apply: (job: Job) => Job,
    paymentGate?: PaymentGateCheck,
    // HT1 Part B: an optional post-persist hook (system messages,
    // notifications) run AFTER the row is durably written and BEFORE the
    // response is sent, with the persisted row. Never runs on a refusal
    // (400/402/409) or a storage failure (503): only on the exact same
    // path that would otherwise answer 200.
    onPersisted?: (persisted: Job) => Promise<void>,
  ): Promise<void> {
    let updated: Job;
    try {
      updated = apply(current);
    } catch (err) {
      if (err instanceof JobError) {
        res.status(400).json({ error: err.message });
        return;
      }
      // P1: the price gate is a state conflict (the AGREEMENT is not ready),
      // the same 409 a criteria-outstanding confirm already answers with --
      // never 400, because nothing the caller just sent is malformed.
      if (err instanceof JobPriceError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof JobTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      // P6: the redo allowance is exhausted -- a state conflict on the
      // agreement's own redo budget, the same 409 shape JobPriceError and
      // JobTransitionError already answer with.
      if (err instanceof RedoAllowanceExhaustedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      // DEP1 (B24 ruling, 2026-09-23), extended by FIX-B74 to withdraw and
      // criteria: the deposit has settled, so decline, withdraw and a
      // change to the terms are refused -- a state conflict, the same 409
      // shape every other domain refusal above already answers with. The
      // error carries its own sentence, naming the action it stopped.
      if (err instanceof DepositSettledError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }

    // P4 anchor: unpaid work never becomes visible. The domain has already
    // agreed the transition is otherwise legal (the try block above did
    // not throw); the money question is the LAST gate, after every
    // agreement problem, and before anything persists.
    if (paymentGate !== undefined) {
      let settled: boolean;
      try {
        settled = await paymentGate.settled(current.id);
      } catch (err) {
        console.error(`${label}: settlement gate failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (!settled) {
        res.status(402).json(paymentGate.unsettledBody(updated));
        return;
      }
    }

    try {
      const row = await jobRepo.update(updated);
      if (row === null) {
        // The row vanished between the read and the write; the id the caller
        // named does not resolve either way.
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (onPersisted !== undefined) await onPersisted(row);
      res.status(200).json(jobProjection(row));
    } catch (err) {
      console.error(`${label}: storage failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
    }
  }

  // R-34 party binding, for the routes outside the ENT-6.2 exchange
  // (withdraw, pull-request, merge): a verified signature must name a
  // party to the job it is acting on, or it is decoration. Unsigned
  // callers (signerDid === null) are unaffected -- this only fires when a
  // signature was actually presented and verified. None of those routes
  // are wired to didSignature yet, so signerDid stays null for them today;
  // the parameter is what a future signed route lands on without a second
  // rule to write.
  async function runExchange(
    label: string,
    jobId: string,
    res: Response,
    apply: (job: Job) => Job,
    signerDid: string | null = null,
    onPersisted?: (persisted: Job) => Promise<void>,
  ): Promise<void> {
    const current = await loadForExchange(label, jobId, res);
    if (current === null) return;
    if (signerDid !== null && signerDid !== current.buyerDid && signerDid !== current.agentDid) {
      res.status(403).json({ error: 'signature does not name a party to this job' });
      return;
    }
    await applyAndPersist(label, res, current, apply, undefined, onPersisted);
  }

  // ENT-6.2's caller-identity gate. The brief's defect #2: runExchange never
  // learned who was calling, so a buyer alone could accept every criterion
  // and confirm on the agent's behalf. R-34 closed the identity question for
  // good: a party to a job proves it is that party by possession of the
  // party's key, not by naming it. A header naming a party used to answer
  // that same question by assertion, as an interim seam while R-34 had not
  // yet landed on these routes; it has, so the header is gone. A verified
  // signerDid is the only source of identity here now.
  //
  // P8v (2026-09-08 ruling: "an operator acting on behalf of their own
  // listed agent should be accepted as that agent's party on a job"): the
  // buyer and the agent's own key are checked first, unchanged. Only when
  // neither matches does this look up the job's agent and ask
  // isAgentOperator (src/domain/agent.ts, the same operator-match predicate
  // the ungated agent-record routes already use) whether `did` is that
  // agent's own operator. The operator IS the agent's party -- there is no
  // third Party value and no new role string, only a second way to prove
  // the same 'agent' seat. The buyer check runs first and wins outright:
  // an operator who is also this job's buyer resolves to 'buyer', exactly
  // the 2026-09-01 self-hire ruling already requires (isSelfHire's own
  // header comment: "the job was never confirmable anyway").
  async function partyForDid(job: Job, did: string): Promise<Party | null> {
    if (did === job.buyerDid) return 'buyer';
    if (did === job.agentDid) return 'agent';
    let jobAgent: Agent | null;
    try {
      jobAgent = await agentRepo.findByDid(job.agentDid);
    } catch (err) {
      console.error('partyForDid: storage failed reading the job\'s agent', err);
      return null;
    }
    if (jobAgent !== null && isAgentOperator(did, jobAgent.operatorDid)) return 'agent';
    return null;
  }

  // P8a (invariant 8): one message shape for every job lifecycle route
  // that now accepts a session alongside a verified R-34 signature,
  // echoing requireSessionOrSignature's own wording so the two gates
  // read as one rule stated twice, not two different rules.
  function sessionOrSignatureRequiredMessage(subject: string): string {
    return `this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34); sign in, or sign the request naming ${subject}`;
  }

  // P8a (invariant 8): the shared gate every job-party route uses to
  // authenticate a caller from EITHER proof (resolveActingParty: a
  // verified signature first, unchanged, then a live session) and
  // resolve that proof to the job's own party. 401 when neither proof
  // resolves to any registered account at all (no proof, or a live
  // session naming an account nobody registered); 403 when the resolved
  // party is neither the job's buyer nor its agent. The 403 wording
  // names a signature only when a signature actually authenticated this
  // request (signerDidOf(req) is non-null only after a verified
  // signature, never after a session), so a session-authenticated
  // stranger is never told a signature was involved.
  async function resolveJobActingParty(
    req: Request,
    res: Response,
    job: Job,
  ): Promise<{ readonly did: string; readonly party: Party } | null> {
    let actingDid: string | null;
    try {
      actingDid = await resolveActingParty(req, repo, identityAdapter);
    } catch (err) {
      console.error('resolveJobActingParty: storage or provisioning failed', err);
      res.status(503).json({ error: 'storage unavailable' });
      return null;
    }
    if (actingDid === null) {
      res.status(401).json({
        error: sessionOrSignatureRequiredMessage("this job's buyer or agent DID"),
      });
      return null;
    }
    const party = await partyForDid(job, actingDid);
    if (party === null) {
      res.status(403).json({
        error:
          signerDidOf(req) !== null
            ? 'signature does not name a party to this job'
            : 'the authenticated party is not a party to this job',
      });
      return null;
    }
    return { did: actingDid, party };
  }

  // HT1 (ruling, 2026-09-25): "by default we should have all hiring
  // requests go to the owner to negotiate work and price points and
  // everything. The agent should not be allowed to negotiate on behalf of
  // its owner unless they explicitly provide instructions for their agent
  // to do so." The resolved party is 'agent' either because the caller's
  // DID equals the job's own agentDid (the agent's OWN key) or because the
  // caller is that agent's operator (partyForDid's own two-branch order,
  // checked first-buyer-then-agentDid-then-operator) -- so `did ===
  // job.agentDid` is exactly the caller-is-agent's-own-key fact, computed
  // for free from what resolveJobActingParty already returned, no second
  // lookup needed to tell the two apart. Only when that is true does this
  // function need to read the agent's stored flag at all: an operator
  // negotiating for their own agent is untouched, matching the brief's
  // "the operator's session or signature is always accepted there".
  async function requireNegotiationAllowed(
    label: string,
    res: Response,
    job: Job,
    actingDid: string,
    party: Party,
  ): Promise<boolean> {
    if (party !== 'agent' || actingDid !== job.agentDid) return true;
    let jobAgent: Agent | null;
    try {
      jobAgent = await agentRepo.findByDid(job.agentDid);
    } catch (err) {
      console.error(`${label}: storage failed reading the job's agent`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return false;
    }
    const negotiatesOnOwnersBehalf = jobAgent?.negotiatesOnOwnersBehalf ?? false;
    if (agentMayNegotiate({ callerIsAgentOwnKey: true, negotiatesOnOwnersBehalf })) return true;
    res.status(403).json({
      error: "the owner has not allowed this agent to negotiate on its own signature; sign in as the operator, or have the operator turn on negotiatesOnOwnersBehalf for this agent",
    });
    return false;
  }

  // HT1 Part B: the hire thread's message projection. No em dash, no
  // seat name, matching every other wire shape in this file.
  function messageProjection(row: Message): Record<string, unknown> {
    return {
      id: row.id,
      jobId: row.jobId,
      authorDid: row.authorDid,
      authorParty: row.authorParty,
      authorKind: row.authorKind,
      body: row.body,
      replyToId: row.replyToId,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
      editHistory: row.editHistory.map((edit) => ({ body: edit.body, editedAt: edit.editedAt.toISOString() })),
      reactions: row.reactions,
      attachments: row.attachments,
      systemEvent: row.systemEvent,
    };
  }

  function notificationProjection(row: Notification): Record<string, unknown> {
    return {
      id: row.id,
      accountDid: row.accountDid,
      jobId: row.jobId,
      eventType: row.eventType,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt === null ? null : row.readAt.toISOString(),
    };
  }

  // HT1 Part B: the thread's own read/write gate, the message-route
  // sibling of requireNegotiationAllowed above. The buyer is always
  // allowed (partyMayAccessThread's own short-circuit); the agent's own
  // key needs the identical negotiatesOnOwnersBehalf flag every
  // negotiation route already checks, since posting a message is named
  // in the original brief as one of the negotiation routes.
  async function requireThreadAccess(
    label: string,
    res: Response,
    job: Job,
    actingDid: string,
    party: Party,
  ): Promise<boolean> {
    let jobAgent: Agent | null = null;
    if (party === 'agent') {
      try {
        jobAgent = await agentRepo.findByDid(job.agentDid);
      } catch (err) {
        console.error(`${label}: storage failed reading the job's agent`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return false;
      }
    }
    const allowed = partyMayAccessThread({
      party,
      callerIsAgentOwnKey: party === 'agent' && actingDid === job.agentDid,
      negotiatesOnOwnersBehalf: jobAgent?.negotiatesOnOwnersBehalf ?? false,
    });
    if (allowed) return true;
    res.status(403).json({
      error: "the owner has not allowed this agent to negotiate on its own signature; sign in as the operator, or have the operator turn on negotiatesOnOwnersBehalf for this agent",
    });
    return false;
  }

  // HT1 Part B (STEER item 4): every new brief, message, quote change and
  // sibling withdrawal notifies the agent's operator (and the buyer, on
  // the buyer's own threads). notifyJobParties is the one call site every
  // job-event trigger below uses: it resolves the job's own agent row
  // once, notifies the agent's OPERATOR (never the agent's own DID; a
  // notification is a fact for a person to read, and the operator is who
  // reads it) and the buyer, skipping whichever DID authored the event
  // (excludeDid) so a party is never notified of its own action. The
  // webhook is fired ONLY toward the agent's own autonomous software, and
  // ONLY when both gates STEER item 4 names are open: negotiation is
  // turned on AND a webhook URL is set -- exactly
  // "the agent's own autonomous software is never contacted unless its
  // operator both enabled negotiation AND set the webhook."
  async function notifyJobParties(
    job: Job,
    eventType: NotificationEventType,
    excludeDid: string | null,
  ): Promise<void> {
    let jobAgent: Agent | null;
    try {
      jobAgent = await agentRepo.findByDid(job.agentDid);
    } catch (err) {
      console.error('notifyJobParties: storage failed reading the job\'s agent', err);
      jobAgent = null;
    }
    if (jobAgent !== null) {
      if (jobAgent.operatorDid !== excludeDid) {
        await notify(jobAgent.operatorDid, job.id, eventType);
      }
      // The webhook targets the agent's own autonomous software, a
      // DIFFERENT actor than its operator -- it fires whenever the two
      // STEER gates are open, independent of whether the OPERATOR
      // authored this particular event (excludeDid names the operator's
      // exclusion from the notify() call above, not the webhook's own
      // audience).
      //
      // This call is NOT awaited. The brief's own
      // words are "fire-and-forget with a short timeout" -- an operator
      // endpoint that is slow or down must never delay the job action
      // (POST /jobs, a message, a criteria change) that triggered this
      // notification. WebhookSender.send is already total (it never
      // rejects past its own boundary, per webhook.ts's own header
      // comment), so the .catch here is a defensive backstop, not the
      // primary error path.
      if (jobAgent.notifyWebhookUrl !== null && jobAgent.negotiatesOnOwnersBehalf) {
        void webhookSender
          .send(jobAgent.notifyWebhookUrl, {
            id: 'w-' + randomBytes(8).toString('hex'),
            accountDid: jobAgent.did,
            jobId: job.id,
            eventType,
            createdAt: new Date(),
            readAt: null,
          })
          .catch((err: unknown) => {
            console.error('notifyJobParties: webhook delivery failed', err);
          });
      }
    }
    if (job.buyerDid !== excludeDid) {
      await notify(job.buyerDid, job.id, eventType);
    }
  }

  // The stored notification row plus its delivery side effects (push and
  // the live notification stream). Never the webhook: the webhook is a
  // per-agent, per-DID concern only notifyJobParties resolves, since it
  // needs the job's own agent row to find the URL. The notification ROW
  // write and the live SSE broadcast are awaited (a caller reading the
  // notification list right after this call must see the row); the push
  // deliveries are NOT (a caller's own request must
  // never wait on a third-party push service, and PushSender.send is
  // already total per push.ts's own header comment).
  //
  // FIX-B56 (B56): the push payload carries jobId alongside
  // title and body, so the notification can open the conversation it is
  // about. Never message text or any other field -- push.ts's own
  // interface comment states the same rule at the type.
  async function notify(accountDid: string, jobId: string, eventType: NotificationEventType): Promise<void> {
    let row: Notification;
    try {
      row = await notificationRepo.create(createNotification({ id: 'n-' + randomBytes(8).toString('hex'), accountDid, jobId, eventType }, new Date()));
    } catch (err) {
      console.error('notify: storage failed writing the notification row', err);
      return;
    }
    broadcastNotification(accountDid, row);
    pushSubscriptionRepo
      .listByAccountDid(accountDid)
      .then((subscriptions) => {
        for (const subscription of subscriptions) {
          void pushSender.send(subscription, { title: 'FreeAgents', body: pushBodyFor(eventType), jobId });
        }
      })
      .catch((err: unknown) => {
        console.error('notify: push delivery failed', err);
      });
  }

  function pushBodyFor(eventType: NotificationEventType): string {
    switch (eventType) {
      case 'new_brief':
        return 'You have a new brief.';
      case 'new_message':
        return 'You have a new message.';
      case 'quote_changed':
        return 'A quote changed on one of your jobs.';
      case 'sibling_withdrawn':
        return 'A sibling job was withdrawn.';
      default:
        return 'You have a new notification.';
    }
  }

  // The place count for both streams above: one caller's open streams,
  // per target and in total. In-memory and single-process like the two
  // maps below, and for the same reason: a stream lives in this process's
  // memory and dies with it.
  const streamCaps = createStreamCaps();

  function refuseStream(res: Response, sentence: string): void {
    res.setHeader('retry-after', String(STREAM_RETRY_AFTER_SECONDS));
    res.status(429).json({ error: sentence });
  }

  // HT1 Part B: the live stream (SSE) and the typing signal. Both are
  // in-memory, single-process pub/sub -- the same architecture every
  // other ephemeral, non-durable signal in this codebase already uses
  // (the rate limiter's own in-memory window, for one). A typing signal
  // is explicitly NOT persisted (STEER names it a signal, not a stored
  // fact); an SSE connection observes only messages written AFTER it
  // subscribed, with polling as the documented fallback for a client
  // that cannot hold the connection open (GET /jobs/:jobId/messages
  // already answers that same fallback need). A stream refused by
  // streamCaps above never subscribes, so it is the same fallback: the
  // conversation page polls instead.
  const threadStreams = new Map<string, Set<Response>>();
  const notificationStreams = new Map<string, Set<Response>>();

  function sseSend(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function broadcastThreadEvent(jobId: string, event: string, data: unknown): void {
    const subscribers = threadStreams.get(jobId);
    if (subscribers === undefined) return;
    for (const subscriber of subscribers) sseSend(subscriber, event, data);
  }

  function broadcastNotification(accountDid: string, row: Notification): void {
    const subscribers = notificationStreams.get(accountDid);
    if (subscribers === undefined) return;
    for (const subscriber of subscribers) sseSend(subscriber, 'notification', notificationProjection(row));
  }

  // STEER (B19, 2026-09-25): "when the platform observes
  // a deposit or a balance leg settle... it writes a `deposit paid` or
  // `balance paid` system row into the hire thread, readable by both
  // parties. The row carries the leg, the amount in USD and the rail,
  // never a wallet address or a transaction hash." One function, called
  // from both the USDC wallet-response route below and the ABT DID
  // Connect onSettlementRecorded callback (abt-did-connect.ts), so the
  // two rails can never drift on what the row looks like. Best-effort,
  // logged, never turns a successful settlement observation into a 503:
  // the settlement row confirm() itself wrote is already durable by the
  // time this is called.
  async function recordSettlementSystemEvent(input: {
    readonly jobId: string;
    readonly leg: 'deposit' | 'remainder';
    readonly rail: 'abt' | 'usdc' | 'abt_eth';
    readonly amountUsd: string;
  }): Promise<void> {
    try {
      const row = await messageRepo.create(
        createSystemMessage(
          {
            id: 'm-' + randomBytes(8).toString('hex'),
            jobId: input.jobId,
            body: input.leg === 'deposit' ? 'Deposit paid' : 'Remainder paid',
            systemEvent:
              input.leg === 'deposit'
                ? { type: 'deposit_paid', leg: 'deposit', amountUsd: input.amountUsd, rail: input.rail }
                : { type: 'remainder_paid', leg: 'remainder', amountUsd: input.amountUsd, rail: input.rail },
          },
          new Date(),
        ),
      );
      // Every system row's SSE broadcast carries the
      // full projection, not an empty object, so a live client renders
      // the row (here, the settlement amount and rail) with no second
      // call.
      broadcastThreadEvent(input.jobId, 'message', messageProjection(row));
    } catch (err) {
      console.error('recordSettlementSystemEvent: failed to write the settlement system row', err);
    }
    // A settlement observation notifies both parties like any other new
    // thread row; 'new_message' is the closest of the four defined
    // NotificationEventType values (src/domain/notification.ts), since
    // the brief did not ask for a fifth event type just for this.
    let job: Job | null;
    try {
      job = await jobRepo.findById(input.jobId);
    } catch (err) {
      console.error('recordSettlementSystemEvent: storage failed reading the job', err);
      return;
    }
    if (job !== null) {
      await notifyJobParties(job, 'new_message', null);
    }
  }

  // Lifecycle routes (withdraw, decline, pull-request, merge) were outside
  // the ENT-6.2 gate: the launch rehearsal (2026-09-01, B6 to B8)
  // withdrew a job and opened a pull request with NO signature at all.
  // Same rule as the exchange routes, one place: no proof at all is 401, a
  // resolved party that is neither buyer nor agent on this job is 403, and
  // a route that only one seat may act from refuses the other seat with
  // 403 before the domain or GitHub is ever touched. P8a (invariant 8):
  // the identity half is resolveJobActingParty, which accepts a live
  // session exactly where it accepts a verified R-34 signature -- the
  // caller-identity question this function answers is unchanged, only
  // which proofs may answer it. Returns the row and the seat, or null
  // after answering.
  async function requireSignedParty(
    label: string,
    jobId: string,
    req: Request,
    res: Response,
    allowed: readonly Party[],
  ): Promise<{ readonly did: string; readonly job: Job; readonly party: Party } | null> {
    const current = await loadForExchange(label, jobId, res);
    if (current === null) return null;
    const gate = await resolveJobActingParty(req, res, current);
    if (gate === null) return null;
    if (!allowed.includes(gate.party)) {
      res.status(403).json({ error: `only the ${allowed.join(' or ')} may ${label.replace(/^POST \/jobs\/:jobId\//, '')} this job` });
      return null;
    }
    return { did: gate.did, job: current, party: gate.party };
  }

  // The party-aware sibling of runExchange, for the four routes ENT-6.2
  // binds: propose, request-changes, accept and confirm. No proof at all
  // is refused before the domain ever sees the request (401: sign in or
  // sign the request, per P8a/R-34). A resolved party naming neither side
  // of the job is refused too (403): proving who you are does not make
  // you a party to this particular job.
  async function runPartyExchange(
    label: string,
    jobId: string,
    req: Request,
    res: Response,
    apply: (job: Job, party: Party) => Job,
    paymentGate?: PaymentGateCheck,
  ): Promise<void> {
    const current = await loadForExchange(label, jobId, res);
    if (current === null) return;

    const gate = await resolveJobActingParty(req, res, current);
    if (gate === null) return;
    // HT1: the negotiation gate runs after the ordinary party check
    // (proving who you are, then whether that party may negotiate), and
    // before the domain ever applies the exchange.
    if (!(await requireNegotiationAllowed(label, res, current, gate.did, gate.party))) return;
    await applyAndPersist(label, res, current, (job) => apply(job, gate.party), paymentGate);
  }

  // The agent proposes acceptance criteria, or re-proposes after pushback
  // (ENT-6, D2): draft -> proposed on the first call, the list revised in
  // place while proposed. Emptiness, trimming and the proposer enum are the
  // domain's rules; only the body shape is checked here.
  //
  // P1: the proposal may also carry a price beside the criteria (scope item
  // 2) -- priceUsd, rail, and an optional deliveryWindowDays. All three are
  // optional as a group: a body naming none of them leaves whatever price
  // is already stored untouched (proposeCriteria's own stance). A body
  // naming priceUsd or rail must name both, since one without the other is
  // not an offer either party could accept. When a price is proposed, it is
  // refused before it ever reaches the domain if it falls below the
  // agent's optional floor (scope item 5), naming the floor.
  app.post(
    '/jobs/:jobId/criteria',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        criteria?: unknown;
        priceUsd?: unknown;
        rail?: unknown;
        deliveryWindowDays?: unknown;
      };
      const input = body.criteria;
      // The element guard is a conjunction of five conditions: typeof
      // object, non-null, non-array, string text, string proposedBy. Each
      // conjunct has its own input in tests/api/job-criteria.test.ts - with
      // any one deleted, its input either falls through to a later check or
      // crashes, so a test per conjunct is what makes the guard
      // non-deletable.
      const wellFormed =
        Array.isArray(input) &&
        input.every(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            !Array.isArray(c) &&
            typeof (c as Record<string, unknown>).text === 'string' &&
            typeof (c as Record<string, unknown>).proposedBy === 'string',
        );
      if (!wellFormed) {
        res.status(400).json({
          error:
            'body must be { criteria: [{ text, proposedBy }] }; text and proposedBy are strings, proposedBy is "agent" or "buyer"',
        });
        return;
      }

      const { priceUsd, rail, deliveryWindowDays } = body;
      const priceNamed = priceUsd !== undefined || rail !== undefined;
      if (priceNamed) {
        if (
          typeof priceUsd !== 'string' ||
          // FIX-B39, rule 1: rail is OPTIONAL on a price proposal (the ABT
          // ruling, 2026-09-15: "the buyer pays in whatever they came
          // with"). A proposal that names one still pins the job to it.
          (rail !== undefined && rail !== 'abt' && rail !== 'usdc' && rail !== 'abt_eth') ||
          (deliveryWindowDays !== undefined &&
            (typeof deliveryWindowDays !== 'number' || !Number.isInteger(deliveryWindowDays) || deliveryWindowDays <= 0))
        ) {
          res.status(400).json({
            error:
              'a proposed price must be { priceUsd, rail?, deliveryWindowDays? }; priceUsd a decimal string, rail (if present) "abt", "usdc" or "abt_eth", deliveryWindowDays (if present) a positive integer',
          });
          return;
        }
      }

      // One load, shared by the floor check and the exchange below (the
      // comment on loadForExchange/runPartyExchange documents why a second
      // jobRepo.findById here would be an untested behaviour change): the
      // caller-identity gate runs first, exactly as runPartyExchange runs
      // it for every other exchange route, so a request that fails
      // authentication never touches agentRepo either.
      const current = await loadForExchange('POST /jobs/:jobId/criteria', String(req.params.jobId), res);
      if (current === null) return;

      const gate = await resolveJobActingParty(req, res, current);
      if (gate === null) return;
      // HT1: proposing criteria/price is the negotiation route the brief
      // names first. Runs before the floor check below, so an agent
      // without permission never even learns its own floor was consulted.
      if (!(await requireNegotiationAllowed('POST /jobs/:jobId/criteria', res, current, gate.did, gate.party))) return;

      // FIX-B74 (B74): the third door DEP1 left open. A proposed
      // job whose deposit has settled takes no change to its lines or its
      // price, from either side: a change would clear marks the buyer paid
      // against. The gate is read only at 'proposed' (a draft has no
      // deposit; every other status is refused by the transition table
      // first, unchanged), after the party and negotiation gates and before
      // any floor read or write. A gate failure is 503, never a guess. The
      // refusal comes out of proposeCriteria below as DepositSettledError,
      // and applyAndPersist maps it to 409 without running onPersisted, so
      // no quote row and no notification is written.
      //
      // B88: a deposit whose price transfer already reached the owner but
      // has not settled holds the same way, because a change would put the
      // agreed price out from under money already paid against it. That
      // holds for a deposit half paid and for one stored short on the
      // ABT-on-Ethereum rail, waiting on the owner. The refusal is answered
      // here (409, the held sentence for that case) before proposeCriteria
      // runs, so it also writes nothing. A failed held-leg read is 503.
      let depositIsSettled = false;
      if (current.status === 'proposed') {
        try {
          depositIsSettled = await settlementGate.depositSettled(current.id);
        } catch (err) {
          console.error('POST /jobs/:jobId/criteria: settlement gate failed', err);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        if (!depositIsSettled && (await refuseWhenLegHeld('POST /jobs/:jobId/criteria', res, current.id, 'deposit', 'change terms'))) {
          return;
        }
      }

      let priceProposal: PriceProposal | undefined;
      if (priceNamed) {
        // Well-formed by the guard above; re-narrow so the domain call
        // below is typed without a cast. FIX-B39: rail may be absent
        // entirely (an open quote), so this stays undefined rather than
        // being forced to one of the three.
        const rawRail = rail as 'abt' | 'usdc' | 'abt_eth' | undefined;
        const rawWindow = deliveryWindowDays as number | undefined;
        // Scope item 5: refused at propose time, before the
        // domain ever sees it, naming the floor. Only fires when the job's
        // agent has one set; a missing agent row (should be unreachable --
        // POST /jobs already required one to exist) is treated as no floor
        // rather than a second 404 surface this route does not otherwise have.
        let floorPriceUsd: string | null = null;
        try {
          const agentRow = await agentRepo.findByDid(current.agentDid);
          floorPriceUsd = agentRow?.floorPriceUsd ?? null;
        } catch (err) {
          console.error('POST /jobs/:jobId/criteria: storage failed', err);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        try {
          assertPriceAboveFloor(priceUsd as string, floorPriceUsd);
        } catch (err) {
          if (err instanceof JobError) {
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }
        priceProposal = {
          priceUsd: priceUsd as string,
          ...(rawRail === undefined ? {} : { rail: rawRail }),
          ...(rawWindow === undefined ? {} : { deliveryWindowDays: rawWindow }),
        };
      }

      // B26, narrowed by FIX-B45:
      // every input line here is stamped with the caller's own
      // resolved seat (gate.party, from resolveJobActingParty above),
      // never the request body's own claim. A body naming the other seat
      // is silently corrected to the signer's actual seat, matching how
      // the price proposal below is credited: neither field trusts
      // self-reported authorship. That stamp is proposeCriteria's default
      // for a NEW or CHANGED line only; a line whose trimmed text matches
      // one already stored keeps that stored line's own proposedBy
      // instead (the domain's matched branch), so this stamp decides
      // authorship for what the sender actually wrote, not for every line
      // their request happens to carry through unchanged.
      const attributedInput = (input as ReadonlyArray<{ readonly text: string; readonly proposedBy: string }>).map(
        (criterion) => ({ text: criterion.text, proposedBy: gate.party }),
      );

      await applyAndPersist(
        'POST /jobs/:jobId/criteria',
        res,
        current,
        (job) => proposeCriteria(job, attributedInput, priceProposal, depositIsSettled),
        undefined,
        // HT1 Part B: "system events (quote sent...) are rows in the same
        // thread... a quote event carries the price, window, and criteria
        // count." Only when this call actually proposed a price -- a bare
        // criteria revision writes no quote row. STEER item 4: "every...
        // quote change... notifies the agent's operator," fired with the
        // acting party excluded so the author of the quote is never
        // notified of its own action.
        priceProposal === undefined
          ? undefined
          : async (persisted) => {
              try {
                const row = await messageRepo.create(
                  createSystemMessage(
                    {
                      id: 'm-' + randomBytes(8).toString('hex'),
                      jobId: persisted.id,
                      body: 'Quote sent',
                      systemEvent: {
                        type: 'quote_sent',
                        priceUsd: priceProposal!.priceUsd,
                        rail: priceProposal!.rail ?? null,
                        deliveryWindowDays: priceProposal!.deliveryWindowDays ?? null,
                        criteriaCount: persisted.criteria.length,
                      },
                    },
                    new Date(),
                  ),
                );
                broadcastThreadEvent(persisted.id, 'message', messageProjection(row));
              } catch (err) {
                console.error('POST /jobs/:jobId/criteria: failed to write the quote_sent system row', err);
              }
              await notifyJobParties(persisted, 'quote_changed', gate.did);
            },
      );
    }),
  );

  // The other side pushes back: the job stays in proposed, no new row.
  // requestChanges no longer resets acceptances itself (that would undo the
  // per-criterion reset proposeCriteria's diff now performs); it only
  // confirms the job is still open for negotiation. No body is required.
  app.post(
    '/jobs/:jobId/request-changes',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      await runPartyExchange(
        'POST /jobs/:jobId/request-changes',
        String(req.params.jobId),
        req,
        res,
        requestChanges,
      );
    }),
  );

  // Either party records ITS OWN agreement on one criterion (ENT-6.2: two
  // independent flags, not one shared one). Index comes from the path; NaN,
  // fractions and out-of-range values reach the domain and come back as 400.
  // Which party accepted comes from the caller-identity gate, never from the
  // request body: a buyer could otherwise accept on the agent's behalf by
  // simply claiming to be it.
  app.post(
    '/jobs/:jobId/criteria/:index/accept',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      await runPartyExchange(
        'POST /jobs/:jobId/criteria/:index/accept',
        String(req.params.jobId),
        req,
        res,
        (job, party) => acceptCriterion(job, Number(req.params.index), party),
      );
    }),
  );

  // P1: accepting the price is a line in the agreement like any criterion
  // (scope item 2) -- the same party-aware shape as criteria/:index/accept,
  // one route, no index because there is exactly one price line per job.
  // acceptPrice itself refuses (400, via JobError) when no price has been
  // proposed yet, mirroring the out-of-range-index refusal above.
  app.post(
    '/jobs/:jobId/price/accept',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      await runPartyExchange(
        'POST /jobs/:jobId/price/accept',
        String(req.params.jobId),
        req,
        res,
        (job, party) => acceptPrice(job, party),
      );
    }),
  );

  // Confirm (R-9, ENT-4.2): the domain computes specHash from the stored
  // criteria - no request body reaches it, so the wire cannot disagree with
  // what was agreed. Body-less like request-changes. The caller-identity
  // gate still applies (ENT-6.2): confirm is itself an exchange action, and
  // the gate this whole issue exists to close is that a single party could
  // call this route and lock in an agreement the other side never made.
  //
  // P4 anchor: a hire cannot confirm until the deposit is settled. The
  // check runs in this route layer, immediately before persistence and
  // after every existing 400/409 agreement-problem answer (confirmSpec
  // itself is unchanged and stays synchronous) -- a caller sees the
  // agreement problems first, the money problem last, and the response
  // carries the depositUsd amount so a 402 is actionable, not just a
  // refusal.
  //
  // B14a, FIX-B36 anchor: "every staged commit lives in a repository the
  // platform created, at a base the platform pinned". confirm is where
  // that repository comes into being: once the deposit has settled, this
  // route reads the buyer's repository's current facts (the base the
  // platform pins, and whether GitHub now reports it under a different
  // name than job.repository), follows a move if there is one
  // (followRepositoryMove, domain/job.ts), creates a private staging
  // repository seeded from it, and grants the agent's verified GitHub
  // login push. This route no longer shares runPartyExchange/
  // applyAndPersist's generic skeleton, because those two async GitHub
  // calls sit BETWEEN the money gate and persistence -- a shape no other
  // route in this file needs. Any failure creating the repository or
  // granting push fails confirm closed: nothing is persisted, so the job
  // stays at whatever status it was already stored at (proposed), and the
  // deposit settlement row already recorded is untouched (it settled on
  // chain; this route never reverses that, matching invariant 12's own
  // stance everywhere else).
  app.post(
    '/jobs/:jobId/confirm',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/confirm';
      const jobId = String(req.params.jobId);
      const current = await loadForExchange(label, jobId, res);
      if (current === null) return;

      // P8a (invariant 8): confirm is the one party route that does not
      // share runPartyExchange's skeleton (B14a's two GitHub calls sit
      // between the money gate and persistence), so it calls the shared
      // identity gate directly rather than inlining a signature-only
      // check. A signed-in buyer confirms a hire with no key.
      const confirmGate = await resolveJobActingParty(req, res, current);
      if (confirmGate === null) return;
      // HT1: confirm is a negotiation route too (the brief's own list).
      if (!(await requireNegotiationAllowed(label, res, current, confirmGate.did, confirmGate.party))) return;

      // HT1 Part A2 (design ruling, 2026-09-25): a job that carries a
      // requestId has siblings opened by the same brief. Fail closed if
      // storage cannot look them up (no silent skip: a one-agent job
      // never reaches this branch at all, so the hand-rolled JobRepository
      // stand-ins in the pre-existing confirm test files are untouched).
      // Confirming a job whose sibling has already been confirmed is a
      // state conflict (409): the buyer already chose a different agent
      // for this brief. confirmedAt is the durable marker (set once by
      // confirmSpec and never cleared), so it is checked here rather than
      // recomputing which statuses count as "already chosen".
      let siblingsExcludingSelf: readonly Job[] = [];
      if (current.requestId !== null) {
        if (typeof jobRepo.findByRequestId !== 'function') {
          console.error(`${label}: storage does not support findByRequestId`);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        let siblings: readonly Job[];
        try {
          siblings = await jobRepo.findByRequestId(current.requestId);
        } catch (err) {
          console.error(`${label}: storage failed reading siblings`, err);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        siblingsExcludingSelf = siblings.filter((sibling) => sibling.id !== current.id);
        if (siblingsExcludingSelf.some((sibling) => sibling.confirmedAt !== null)) {
          res.status(409).json({
            error: 'a sibling job from the same brief has already been confirmed; this job can no longer be confirmed',
          });
          return;
        }
      }

      // FIX-B39 (B39), rule 3: a job whose quote left the
      // currency open gets one from the settled DEPOSIT, backfilled
      // BEFORE confirmSpec runs. specHash still carries rail:<currency>
      // in the same position (confirmSpec itself is unchanged) so
      // tests/api/job-confirm.test.ts's recomputation holds. A pinned
      // job (current.rail already set) is untouched: this only fills a
      // null. openQuoteAwaitingDeposit distinguishes the two ways an
      // open quote can still be missing a rail at this point: no
      // settlement row exists yet (confirmSpec's rail-null JobPriceError
      // maps to the ordinary 402, or to the missing-record 409 if the
      // gate itself disagrees) versus a settlement row WAS found and
      // backfilled, in which case any JobPriceError confirmSpec throws
      // next has nothing to do with rail at all -- it is the ordinary
      // criteria or price-acceptance gate, and must answer with its own
      // message, not the missing-record one (a
      // re-proposed price resets acceptance on an open quote whose
      // deposit already settled, and the old check here read
      // current.rail, which stays null even after a successful
      // backfill, so it answered "no settlement record" for a job that
      // had one).
      let jobForConfirm = current;
      let openQuoteAwaitingDeposit = false;
      if (current.rail === null) {
        const settledDeposit = await settlementRepo.findByJobAndLeg(current.id, 'deposit');
        if (settledDeposit !== null) {
          jobForConfirm = { ...current, rail: settledDeposit.rail };
        } else {
          openQuoteAwaitingDeposit = true;
        }
      }
      let confirmed: Job;
      try {
        confirmed = confirmSpec(jobForConfirm, new Date());
      } catch (err) {
        // B27: confirmSpec only ever throws
        // JobError here for a criteria-readiness gap (no criteria at all,
        // or some outstanding) -- a state conflict, the identical fact
        // JobPriceError already answers with 409 two lines down. Nothing
        // the caller SENT on this request is malformed; the AGREEMENT
        // itself is not ready. 400 told the caller their input was wrong
        // when the actual defect was the job's own state, so both paths
        // now answer the same way.
        if (err instanceof JobError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof JobPriceError) {
          // FIX-B39, rule 3: this branch also carries the pre-existing
          // "no price has been proposed" case (JobPriceError with
          // priceUsd null), and the price-ACCEPTANCE gate case (a price
          // and rail both set, one party has not accepted), neither one
          // related to a currency at all -- both fall straight through
          // to the generic err.message answer below, unchanged from
          // before this card. The new branch here is narrower still: an
          // open-quote job that DOES have a price and has NO settled
          // deposit row yet (openQuoteAwaitingDeposit) fails
          // confirmSpec's price gate for the sole reason that rail is
          // missing, pending the deposit that will supply it. Before
          // answering the ordinary "the deposit has not settled yet" 402
          // every other job gets here, ask the settlement gate directly:
          // if it reports the deposit ALREADY settled (a state the repo
          // lookup above could not corroborate with a row), guessing a
          // currency would be wrong, so this refuses with 409 naming the
          // missing record instead.
          if (current.priceUsd !== null && openQuoteAwaitingDeposit) {
            let gateSaysSettledWithNoRecord = false;
            try {
              gateSaysSettledWithNoRecord = await settlementGate.depositSettled(current.id);
            } catch (gateErr) {
              console.error(`${label}: settlement gate failed`, gateErr);
              res.status(503).json({ error: 'storage unavailable' });
              return;
            }
            if (gateSaysSettledWithNoRecord) {
              res.status(409).json({
                error:
                  'the settlement gate reports this deposit settled, but no settlement record names its currency; confirm cannot proceed without one',
              });
              return;
            }
            res.status(402).json({
              error: 'the deposit has not settled; this job cannot confirm until it does',
              depositUsd: depositUsd(current.priceUsd, current.depositPercent),
            });
            return;
          }
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof JobTransitionError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }

      let depositIsSettled: boolean;
      try {
        depositIsSettled = await settlementGate.depositSettled(current.id);
      } catch (err) {
        console.error(`${label}: settlement gate failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (!depositIsSettled) {
        res.status(402).json({
          error: 'the deposit has not settled; this job cannot confirm until it does',
          depositUsd: depositUsd(String(confirmed.priceUsd), confirmed.depositPercent),
        });
        return;
      }

      // B14a: the agent's VERIFIED GitHub login is the only login
      // grantPush may ever target -- an agent with no verified binding
      // yet cannot be granted push on a repository nobody proved it
      // controls.
      //
      // B28: a missing or unverified
      // GitHub login is a fact about the AGENT's own record, not a GitHub
      // service fault -- confirm answered 503 for both, which told a
      // caller to retry something that would never work no matter how
      // many times it tried. This is now the same state-conflict 409
      // every other confirm-readiness gap already answers with, naming
      // the missing verified login so the caller knows what to fix. A
      // real GitHub outage (the catch block reaching the API calls below)
      // keeps its own 503, unchanged.
      let agent: Agent | null;
      try {
        agent = await agentRepo.findByDid(current.agentDid);
      } catch (err) {
        console.error(`${label}: storage failed reading agent`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (agent === null || agent.githubLogin === null || agent.proofStatus !== 'verified') {
        res.status(409).json({
          error: 'confirm needs the agent to have a verified GitHub login; none is on record for this agent yet',
        });
        return;
      }

      // repository was regex-checked to exactly one slash at POST /jobs
      // time (same slice every other github-facing route in this file
      // uses).
      const slashAt = current.repository.indexOf('/');
      const sourceOwner = current.repository.slice(0, slashAt);
      const sourceRepo = current.repository.slice(slashAt + 1);

      let withStagingRepo: Job;
      let stagingGrant: GrantPushResult;
      try {
        const facts = await github.readRepository({ owner: sourceOwner, repo: sourceRepo });
        // FIX-B36 (Make item 3): the buyer may have moved the repository
        // into a new GitHub organization between POST /jobs and confirm
        // (the whole reason this card exists -- B36). facts.fullName
        // is GitHub's own canonical name, which already reflects a move
        // (the adapter's read follows GitHub's 301). chainIdentifiersMatch,
        // never a bare !==: owners, repos and logins compare
        // case-insensitively everywhere else in this file, and a stored
        // spelling that merely differs in case from GitHub's own report is
        // not a move.
        const confirmedWithRepository = chainIdentifiersMatch(facts.fullName, confirmed.repository)
          ? confirmed
          : followRepositoryMove(confirmed, facts.fullName);
        const stagingRepo = await github.createStagingRepository({
          jobId: current.id,
          sourceOwner,
          sourceRepo,
          baseCommit: facts.sha,
        });
        // FIX-B14b: the PUT above never means the agent can push yet --
        // GitHub answers 201 (a pending invitation) unless the login was
        // already a collaborator (204). stagingGrant carries which one
        // came back, read after persistence below to tell the agent's
        // thread whether it must accept an invitation before it can push
        // (B14b: push readiness is measured live at stage time,
        // never inferred from having called this route).
        stagingGrant = await github.grantPush({
          owner: stagingRepo.owner,
          repo: stagingRepo.repo,
          githubLogin: agent.githubLogin,
          verifiedGithubLogin: agent.githubLogin,
        });
        withStagingRepo = attachStagingRepository(
          confirmedWithRepository,
          { owner: stagingRepo.owner, repo: stagingRepo.repo },
          stagingRepo.baseCommit,
        );
      } catch (err) {
        // ORG1: a 404/403 reading the buyer's repository names a fact
        // about the repository (the platform's account cannot see it --
        // typically a personal-account private repository, which GitHub
        // gives no read-only role), never a transient outage. Before
        // this, EVERY failure here fell into the 503 branch below, so a
        // repository the platform will never be able to read looked
        // exactly like GitHub being briefly down. This is a state
        // conflict the buyer can act on, so it is 409, checked before
        // the generic 503 catch-all so it never falls through to it.
        if (err instanceof RepositoryNotAccessibleError) {
          // FIX-B36: this message is shared with the three deposit-start
          // doors (route-support.ts's repositoryNotAccessibleMessage), so
          // the buyer sees the same wording whichever route answers. It
          // ends with the address of the walkthrough page for this job
          // (/private-repos, src/web/pages/private-repos.html). deposit.js
          // tells this case apart by the phrase "cannot see this
          // repository" and links that page itself.
          res.status(409).json({
            error: repositoryNotAccessibleMessage(agent.githubLogin, github.platformLogin, current.id),
          });
          return;
        }
        // Fails closed: nothing persists, so the row stays at whatever
        // status it was already stored at (proposed) -- see this route's
        // own header comment.
        console.error(`${label}: staging repository creation failed`, err);
        res.status(503).json({ error: 'github unavailable' });
        return;
      }

      try {
        const row = await jobRepo.update(withStagingRepo);
        if (row === null) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        // HT1 Part A2: every sibling from the same brief still in draft or
        // proposed moves to withdrawn now that the buyer has confirmed a
        // different agent. Best-effort (logged, never turns an otherwise
        // successful confirm into a 503): the confirm itself has already
        // persisted by this point, and a sibling this platform cannot
        // write to is a fact for the next read to reconcile, not a reason
        // to tell the buyer their own confirm failed.
        //
        // HT1 Part B (STEER item 4): "every... sibling withdrawal notifies
        // the agent's operator." Fires after the withdraw itself persists
        // (best-effort, logged, never turns an otherwise-successful
        // confirm into a 503, the same stance the withdraw loop above
        // already takes on its own storage failure). The buyer already
        // knows (it is the one that confirmed elsewhere); excludeDid is
        // the buyer's own DID so it is never notified of its own action.
        for (const sibling of siblingsExcludingSelf) {
          if (sibling.status !== 'draft' && sibling.status !== 'proposed') continue;
          try {
            const withdrawnSibling = await jobRepo.update(recordWithdrawn(sibling));
            if (withdrawnSibling !== null) {
              await notifyJobParties(withdrawnSibling, 'sibling_withdrawn', withdrawnSibling.buyerDid);
            }
          } catch (err) {
            console.error(`${label}: failed to withdraw sibling ${sibling.id}`, err);
          }
        }
        // FIX-B14b: the row confirm's own thread gets whenever the push
        // grant came back an invitation, not yet a collaborator. Written
        // AFTER the job itself persists, best-effort and logged like
        // every other system row in this file (recordSettlementSystemEvent,
        // the staged row above): a failed thread write never turns a
        // successful confirm into a 503, because the job row it describes
        // is already durable by the time this runs. An `active` grant
        // (already a collaborator, no invitation pending) writes nothing:
        // there is no accept step to tell either party about.
        if (stagingGrant.state === 'invited') {
          try {
            const systemRow = await messageRepo.create(
              createSystemMessage(
                {
                  id: 'm-' + randomBytes(8).toString('hex'),
                  jobId: row.id,
                  body: `${row.repository}'s staging repository is waiting on a GitHub invitation. ${agent.githubLogin} must accept it at ${stagingGrant.acceptUrl} before it can push.`,
                  systemEvent: { type: 'staging_invited', acceptUrl: stagingGrant.acceptUrl, githubLogin: agent.githubLogin },
                },
                new Date(),
              ),
            );
            broadcastThreadEvent(row.id, 'message', messageProjection(systemRow));
          } catch (err) {
            console.error(`${label}: failed to write the staging_invited system row`, err);
          }
          // Either party may confirm (app.ts's own note above,
          // confirmGate.did); the party that did NOT confirm is the one
          // that needs telling, the same excludeDid stance every other
          // thread-triggered notification in this file already takes.
          await notifyJobParties(row, 'new_message', confirmGate.did);
        }
        res.status(200).json(jobProjection(row));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // The buyer withdraws an open job (R-31, D3 2026-08-22): recorded
  // withdrawn, terminal, a timing fact. Body-less like request-changes;
  // every rule lives in recordWithdrawn, the route only names the label.
  //
  // FIX-B74 (B74): once the buyer's deposit has settled, a
  // proposed job can no longer be withdrawn; the buyer's way forward is
  // confirm. Same rule as decline and criteria below and above: three
  // doors, one rule. The settlement gate is asked only at 'proposed'
  // (any other status is the transition table's call, unchanged) and the
  // answer is threaded into recordWithdrawn, which throws
  // DepositSettledError, mapped to 409 by applyAndPersist. A gate
  // failure is 503, never a guess.
  //
  // B88: a deposit whose price transfer already reached the owner but has
  // not settled holds the same way: refused here (409, the held sentence,
  // nothing written) before recordWithdrawn runs. The buyer's way forward is
  // to finish a half-paid deposit, then confirm; for a deposit stored short
  // on the ABT-on-Ethereum rail it is to message the owner, who answers it.
  // A failed held-leg read is 503.
  app.post(
    '/jobs/:jobId/withdraw',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/withdraw';
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      let depositIsSettled = false;
      if (gate.job.status === 'proposed') {
        try {
          depositIsSettled = await settlementGate.depositSettled(gate.job.id);
        } catch (err) {
          console.error(`${label}: settlement gate failed`, err);
          res.status(503).json({ error: 'storage unavailable' });
          return;
        }
        if (!depositIsSettled && (await refuseWhenLegHeld(label, res, gate.job.id, 'deposit', 'withdraw'))) return;
      }
      await applyAndPersist(label, res, gate.job, (job) => recordWithdrawn(job, depositIsSettled));
    }),
  );

  // The agent side refuses a job (domain decline(), reachable for the first
  // time 2026-09-01, B10). Mirror of withdraw: the buyer walks
  // away with withdraw, the agent with decline. Which statuses allow it is
  // the transition table's call, not this route's.
  //
  // DEP1 (B24 ruling, 2026-09-23): once the buyer's deposit has
  // settled, the agent can no longer simply decline. The settlement gate
  // is asked the same depositSettled question confirm's own gate already
  // asks (settlementGate.depositSettled, the confirm route above), and
  // the answer is threaded into decline() as its second argument: the
  // domain throws DepositSettledError, which this route maps to 409 with
  // a plain-words reason, the same state-conflict shape JobTransitionError
  // already answers with. A gate failure is 503, never a silent guess,
  // matching every other settlement-gate call site in this file. FIX-B74
  // applies the same rule to withdraw (above) and criteria: three doors,
  // one rule.
  //
  // B88: a deposit whose price transfer already reached the owner but has
  // not settled holds the same way, at the statuses the deposit is payable
  // in (legStatusEligible): refused (409, the held sentence, nothing
  // written) before decline() runs. That covers a deposit half paid and one
  // stored short on the ABT-on-Ethereum rail, waiting on the owner. A failed
  // held-leg read is 503.
  app.post(
    '/jobs/:jobId/decline',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/decline';
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['agent']);
      if (gate === null) return;
      // HT1: decline before confirm is a negotiation route too.
      if (!(await requireNegotiationAllowed(label, res, gate.job, gate.did, gate.party))) return;
      let depositIsSettled: boolean;
      try {
        depositIsSettled = await settlementGate.depositSettled(gate.job.id);
      } catch (err) {
        console.error(`${label}: settlement gate failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (
        !depositIsSettled &&
        legStatusEligible('deposit', gate.job.status) &&
        (await refuseWhenLegHeld(label, res, gate.job.id, 'deposit', 'decline'))
      ) {
        return;
      }
      await applyAndPersist(label, res, gate.job, (job) => decline(job, depositIsSettled));
    }),
  );

  // P4: the agent stages the work (confirmed -> staged), posting the
  // commit SHA it staged. Party rule mirrors pull-request: only the agent
  // stages, the same way only the agent opens a pull request. No payment
  // gate here: staging is unpaid by design (the anchor is precisely that
  // the work sits in staging, unpaid and unseen, until the balance
  // settles at pull-request time).
  //
  // P5 anchor: `staged` is the state whose whole meaning is "there is
  // something to read", so a job does not reach it without a published
  // attestation. The attestation is generated, signed and STORED before
  // the job is persisted as staged, deliberately in that order: storing
  // first and flipping the status second means a crash between the two
  // leaves a job stuck at `confirmed` with an orphaned attestation record,
  // which is recoverable (restage), rather than a job sitting at `staged`
  // with nothing behind it for the buyer to read, which is the exact lie
  // this card exists to prevent. Any failure in the staging observation,
  // the attestation build, the signature, or the attestation storage fails
  // the whole stage: the job stays confirmed.
  //
  // B14a anchor: before any of that, this route verifies the commit
  // exists in the staging repository (getCommit) and descends from
  // baseCommit (a bounded ancestry walk). A SHA the agent posts that is
  // not actually in the staging repo -- or that does not descend from
  // the base the platform pinned at confirm -- is 409, naming the repo,
  // before the observer or the attestation ever sees it.
  const MAX_ANCESTRY_WALK_DEPTH = 500;

  // Walks parent commits from `sha` looking for `target`, bounded so a
  // pathological or forged history cannot spin this route forever. A
  // commit's own sha counts as descending from itself (depth 0): staging
  // a job at exactly baseCommit -- no work yet -- is legitimate.
  async function descendsFrom(owner: string, repo: string, sha: string, target: string): Promise<boolean> {
    let frontier = [sha];
    const visited = new Set<string>();
    for (let depth = 0; depth <= MAX_ANCESTRY_WALK_DEPTH; depth += 1) {
      const next: string[] = [];
      for (const candidate of frontier) {
        if (candidate === target) return true;
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        const commit = await github.getCommit({ owner, repo, sha: candidate });
        next.push(...commit.parents);
      }
      if (next.length === 0) return false;
      frontier = next;
    }
    return false;
  }

  app.post(
    '/jobs/:jobId/stage',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/stage';
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['agent']);
      if (gate === null) return;
      const body = (req.body ?? {}) as { stagedCommit?: unknown };
      if (typeof body.stagedCommit !== 'string' || body.stagedCommit.trim() === '') {
        res.status(400).json({ error: 'body must be { stagedCommit: string }: the commit SHA the agent staged' });
        return;
      }
      const stagedCommit = body.stagedCommit;
      const current = gate.job;

      // The transition guard runs BEFORE any github call: a job past its
      // lapse window (or otherwise ineligible) is a 409, not a 503 --
      // github never needs to hear about a stage attempt the state
      // machine was always going to refuse. stageWork re-validates below
      // (it is pure and cheap), so this is not a second source of truth,
      // only an ordering guarantee.
      try {
        validateJobTransition(current.status, 'staged');
      } catch (err) {
        if (err instanceof JobTransitionError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }

      // B14a: a job cannot stage before confirm created its staging
      // repository. Every honestly-reached `confirmed` job carries one
      // (confirm's own route sets it before it ever persists the
      // transition); a job missing one here is a fault this route
      // cannot recover from, not a client error.
      if (current.stagingRepo === null || current.baseCommit === null) {
        console.error(`${label}: job ${current.id} has no staging repository; confirm must create one before stage can verify a commit`);
        res.status(503).json({ error: 'staging repository unavailable' });
        return;
      }
      const stagingRepo = current.stagingRepo;
      const baseCommit = current.baseCommit;

      // B14b: the observer compares commit signers against the agent's
      // OWN verified GitHub login (R-3/R-4, ENT-5) -- the same fact
      // confirm already required to be verified before it would grant
      // push on this exact staging repository. A job cannot reach
      // `staged` without an agent that already cleared that bar, so a
      // missing or unverified login here is the same fault class as a
      // missing staging repository: this route cannot recover from it.
      let stagingAgent: Agent | null;
      try {
        stagingAgent = await agentRepo.findByDid(current.agentDid);
      } catch (err) {
        console.error(`${label}: storage failed reading agent`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (stagingAgent === null || stagingAgent.githubLogin === null || stagingAgent.proofStatus !== 'verified') {
        console.error(`${label}: agent ${current.agentDid} has no verified GitHub login; cannot measure commit signers`);
        res.status(503).json({ error: 'github unavailable' });
        return;
      }
      const verifiedAgentGithubLogin = stagingAgent.githubLogin;

      try {
        await github.getCommit({ owner: stagingRepo.owner, repo: stagingRepo.repo, sha: stagedCommit });
      } catch (err) {
        console.error(`${label}: staged commit ${stagedCommit} not found in staging repository`, err);
        // FIX-B14b (B14b): the commit not being visible here can
        // mean it was genuinely never pushed, OR it can mean the agent
        // never accepted the collaborator invitation confirm sent it, so
        // it never had anywhere to push TO. Reading the agent's real,
        // current permission tells the two apart before answering --
        // 'none' or 'read' names the fix (the accept link) instead of
        // repeating the generic commit-missing sentence; 'write' or
        // 'admin' means push access is fine, so the fault really is a
        // missing commit, and today's exact sentence stands. If the
        // permission read ITSELF throws, a check that cannot see must
        // not change what the caller is told: today's sentence stands,
        // and the read failure is logged separately from the commit
        // failure above.
        let permission: string | null = null;
        try {
          permission = await github.getCollaboratorPermission({
            owner: stagingRepo.owner,
            repo: stagingRepo.repo,
            githubLogin: verifiedAgentGithubLogin,
          });
        } catch (permissionErr) {
          console.error(`${label}: reading collaborator permission failed`, permissionErr);
        }
        if (permission === 'none' || permission === 'read') {
          res.status(409).json({
            error: `${verifiedAgentGithubLogin} does not have push access to ${stagingRepo.owner}/${stagingRepo.repo} yet; accept the invitation at https://github.com/${stagingRepo.owner}/${stagingRepo.repo}/invitations, push, then stage again`,
          });
          return;
        }
        res.status(409).json({
          error: `staged commit ${stagedCommit} does not exist in the staging repository ${stagingRepo.owner}/${stagingRepo.repo}`,
        });
        return;
      }

      let isDescendant: boolean;
      try {
        isDescendant = await descendsFrom(stagingRepo.owner, stagingRepo.repo, stagedCommit, baseCommit);
      } catch (err) {
        console.error(`${label}: ancestry walk failed`, err);
        res.status(503).json({ error: 'github unavailable' });
        return;
      }
      if (!isDescendant) {
        res.status(409).json({
          error: `staged commit ${stagedCommit} does not descend from base commit ${baseCommit} in the staging repository ${stagingRepo.owner}/${stagingRepo.repo}`,
        });
        return;
      }

      // stageWork re-validates the transition (cheap, pure); the guard
      // above is what keeps this route's ordering honest, not a
      // duplicated rule.
      const staged: Job = stageWork(current, stagedCommit, new Date());

      // P5: measure the staging repository. baseCommit now comes from
      // the job (B14a), the base the platform pinned at confirm -- not
      // an empty string.
      let observation;
      try {
        observation = await stagingObserver.observe({
          owner: stagingRepo.owner,
          repo: stagingRepo.repo,
          stagedCommit,
          baseCommit,
          verifiedAgentGithubLogin,
        });
      } catch (err) {
        if (err instanceof StagingComparisonTruncatedError) {
          console.error(`${label}: staging comparison truncated`, err);
          res.status(422).json({ error: 'the change is too large to attest; split the work' });
          return;
        }
        console.error(`${label}: staging observation failed`, err);
        res.status(503).json({ error: 'staging observation unavailable' });
        return;
      }

      let attestation;
      try {
        attestation = buildAttestation(staged, observation, new Date());
      } catch (err) {
        if (err instanceof AttestationError) {
          console.error(`${label}: attestation build failed`, err);
          res.status(503).json({ error: 'attestation generation failed' });
          return;
        }
        throw err;
      }

      let signed;
      try {
        signed = await credentialsAdapter.signAttestation(attestation);
      } catch (err) {
        console.error(`${label}: attestation signing failed`, err);
        res.status(503).json({ error: 'attestation signing unavailable' });
        return;
      }

      try {
        await attestationRepo.save({ jobId: current.id, attestation, signed });
      } catch (err) {
        if (err instanceof AttestationAlreadyStoredError) {
          res.status(409).json({ error: err.message });
          return;
        }
        console.error(`${label}: attestation storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }

      try {
        const row = await jobRepo.update(staged);
        if (row === null) {
          // The row vanished between the read and the write; the id the
          // caller named does not resolve either way. The attestation
          // this call just stored is now orphaned against a job that no
          // longer exists at this id -- the same shape of anomaly a
          // vanished row already represents everywhere else in this file.
          res.status(404).json({ error: 'not found' });
          return;
        }
        // HT1 Part B: "system events (quote sent, deposit paid, staged,
        // PR opened, completed) are rows in the same thread."
        // Best-effort, logged, never turns a successful stage into a 503.
        try {
          const systemRow = await messageRepo.create(
            createSystemMessage(
              { id: 'm-' + randomBytes(8).toString('hex'), jobId: row.id, body: 'Staged', systemEvent: { type: 'staged' } },
              new Date(),
            ),
          );
          broadcastThreadEvent(row.id, 'message', messageProjection(systemRow));
        } catch (err) {
          console.error(`${label}: failed to write the staged system row`, err);
        }
        res.status(200).json(jobProjection(row));
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // P5: the read route the buyer pays against. Party rule: the buyer and
  // the agent on the job -- this is the document the buyer decides on, so
  // a stranger does not get it (the anchor's own wording: "a buyer who
  // reads the attestation must not be able to reconstruct the diff",
  // which presumes the buyer is the one reading it, not the public).
  app.get(
    '/jobs/:jobId/attestation',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/attestation';
      const jobId = String(req.params.jobId);
      let job: Job | null;
      try {
        job = await jobRepo.findById(jobId);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (job === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const gate = await resolveJobActingParty(req, res, job);
      if (gate === null) return;
      let stored;
      try {
        stored = await attestationRepo.findByJobId(jobId);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (stored === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(200).json(stored.signed);
    }),
  );

  // Which payments of a hire settled. Answers 200 with
  //   { deposit: <leg or null>, remainder: <leg or null> }
  //   <leg> = { rail, amountUsd, operatorAddress, observedAt (ISO 8601) }
  // where null means no settled payment is on record for that leg. A leg
  // carries those four facts and nothing else: no transaction hash, no fee
  // address, no fee amount. `rail` is passed through as stored, so a rail
  // added later needs no change here.
  //
  // Party-only (the buyer, the agent's owner, the agent's own key): which
  // payments settled, when, and to which address are facts between the two
  // sides of the hire. The public GET /jobs/:jobId stays as it is and says
  // nothing about them.
  //
  // Built like GET /jobs/:jobId/attestation and for the same reason it does
  // not call applyLiveLapses: a plain read never moves a job's status.
  // Unknown job 404, no proof 401, not a party 403, any storage failure 503.
  app.get(
    '/jobs/:jobId/payments',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/payments';
      const jobId = String(req.params.jobId);
      let job: Job | null;
      try {
        job = await jobRepo.findById(jobId);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (job === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const gate = await resolveJobActingParty(req, res, job);
      if (gate === null) return;
      const legFor = (record: ObservedSettlementRecord | null): Record<string, string> | null =>
        record === null
          ? null
          : {
              rail: record.rail,
              amountUsd: record.amountUsd,
              operatorAddress: record.operatorAddress,
              observedAt: record.observedAt.toISOString(),
            };
      try {
        const deposit = await settlementRepo.findByJobAndLeg(job.id, 'deposit');
        const remainder = await settlementRepo.findByJobAndLeg(job.id, 'remainder');
        res.status(200).json({ deposit: legFor(deposit), remainder: legFor(remainder) });
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
      }
    }),
  );

  // Follow-up from the P6 audit:
  // both storage drivers already keep every attestation row
  // (AttestationRepository.listByJobId, append-only since P6), but until
  // this route existed no HTTP surface reached anything but the latest
  // one. After a redo restages, the document the buyer was shown before
  // the redo was bytes-durable but buyer-unreachable through the
  // platform -- the exact "make an unflattering measurement disappear"
  // failure the append-only rule exists to prevent, just moved from
  // storage (where P6 closed it) to the reader (where it was still open).
  //
  // Shape: a LISTING route, not a per-sequence route
  // (`/jobs/:jobId/attestations/:sequence`). A listing is a strict
  // superset of what a per-sequence route offers here -- every consumer
  // named in this card's brief (a buyer diffing what they saw before and
  // after a redo) wants the whole history in one call, oldest first, the
  // same order listByJobId already returns it in. A per-sequence route
  // would additionally need its own 400/404 vocabulary for an
  // out-of-range or non-numeric sequence with no caller this brief names
  // needing that address form; the listing route only needs the 401/403
  // gate every other attestation route already carries, plus the 200/404
  // job-existence split GET /jobs/:jobId/attestation already uses.
  //
  // Party rule is copied from GET /jobs/:jobId/attestation verbatim
  // (buyer and agent, never a stranger), and deliberately NOT routed
  // through requireSignedParty/loadForExchange: that helper runs
  // applyLiveLapses as a side effect, which can persist a lapse
  // transition on what is supposed to be a plain read -- the exact
  // reason the single-attestation route above already reimplements the
  // gate by hand instead of calling the shared helper. This route keeps
  // that same read-only stance for the same reason.
  //
  // Envelope: each entry is { sequence, document }, sequence sitting
  // beside the signed document rather than inside it. buildAttestation's
  // field list and the VerifiableCredential envelope
  // (`@context,id,type,issuer,validFrom,credentialSubject,proof`) both
  // stay byte-for-byte what they already are -- the brief forbids
  // touching buildAttestation's fields, and folding sequence into the
  // signed object would change what a third party's signature
  // verification sees versus what this platform originally signed. The
  // buyer's inability to tell which restage they are reading (this
  // card's other named gap) is fixed here, once, without touching the
  // singular route's response shape at all.
  app.get(
    '/jobs/:jobId/attestations',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'GET /jobs/:jobId/attestations';
      const jobId = String(req.params.jobId);
      let job: Job | null;
      try {
        job = await jobRepo.findById(jobId);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (job === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const gate = await resolveJobActingParty(req, res, job);
      if (gate === null) return;
      let stored: readonly StoredAttestation[];
      try {
        stored = await attestationRepo.listByJobId(jobId);
      } catch (err) {
        console.error(`${label}: storage failed`, err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      res.status(200).json({
        attestations: stored.map((row) => ({ sequence: row.sequence, document: row.signed })),
      });
    }),
  );

  // SW3-07: the buyer's decline and redo at staged are moves for a hire that
  // is not yet paid in full. The payment model ruling (2026-09-01)
  // is "one redo at staged before the balance, free decline at staged",
  // and the design record names three moves there: pay the balance, request
  // the one redo, or decline for free. Paying is one of the three, so once
  // the second payment has settled the other two are gone and the hire goes
  // on to its pull request. Declining a paid hire would end it in
  // staged_declined, whose money is deposit only (DATA-CONTRACT 8.7), and
  // the buyer would lose the work they paid for. The gate is async, so
  // this read lives here at the route layer, like the pull-request route's.
  //
  // B88: a remainder whose price transfer already reached the owner but has
  // not settled holds the same way, for the same reason: the buyer has paid
  // part of the second payment, and declining or redoing would leave that
  // money with the owner for work the buyer walked away from. The way
  // forward is to finish a half-paid remainder; a remainder stored short on
  // the ABT-on-Ethereum rail waits on the owner, and the sentence says so.
  //
  // Answers the response and returns true when the route must stop: 409
  // when paid in full (`refusal`) or when the remainder is held
  // (`heldAction`'s sentence), 503 when the settlement gate or the
  // held-leg read cannot answer. Any other status is left to the domain's
  // own transition refusal.
  async function refuseStagedMoveWhenPaid(
    label: string,
    res: Response,
    job: Job,
    refusal: string,
    heldAction: HeldLegAction,
  ): Promise<boolean> {
    if (job.status !== 'staged') return false;
    let paidInFull: boolean;
    try {
      paidInFull = await remainderSettled(settlementGate, job.id);
    } catch (err) {
      console.error(`${label}: settlement gate failed`, err);
      res.status(503).json({ error: 'storage unavailable' });
      return true;
    }
    if (!paidInFull) return refuseWhenLegHeld(label, res, job.id, 'remainder', heldAction);
    res.status(409).json({ error: refusal });
    return true;
  }

  // P4: the buyer declines the staged work, free of charge, before paying
  // the remainder (design record, 2026-09-01: pay, request the one redo,
  // or decline for free). Buyer-only, terminal, body-less like withdraw
  // and decline. On an unpaid hire no money moves and none is owed
  // (recordStagedDeclined's own header comment). Once the hire is paid in
  // full the decline is refused (SW3-07, refuseStagedMoveWhenPaid above),
  // after the party check so a stranger or the agent never learns whether
  // the hire is paid.
  app.post(
    '/jobs/:jobId/staged-decline',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/staged-decline';
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      if (
        await refuseStagedMoveWhenPaid(
          label,
          res,
          gate.job,
          'This hire is paid in full, so the work can no longer be declined. The agent opens the pull request next.',
          'staged-decline',
        )
      ) {
        return;
      }
      await applyAndPersist(label, res, gate.job, recordStagedDeclined);
    }),
  );

  // P6 (design record row 2): the buyer's one redo at staged, available
  // only before the hire is paid in full (SW3-07, refuseStagedMoveWhenPaid
  // above: "one redo at staged before the balance"). Party rule mirrors
  // staged-decline: buyer-only, since this is one of the buyer's three
  // moves at staged (pay, redo, decline), and the paid check runs after the
  // party check and the body check. The body names which confirmed
  // criterion the redo cites; requestRedo itself validates the index is in
  // range and that the allowance is not exhausted, mapping to 400
  // (malformed) and 409 (state conflict) respectively through the same
  // applyAndPersist error legs every other lifecycle route shares.
  app.post(
    '/jobs/:jobId/redo',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/redo';
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      const body = (req.body ?? {}) as { criterionIndex?: unknown };
      if (typeof body.criterionIndex !== 'number' || !Number.isInteger(body.criterionIndex)) {
        res.status(400).json({ error: 'body must be { criterionIndex: number }: the confirmed criterion this redo cites' });
        return;
      }
      const criterionIndex = body.criterionIndex;
      if (
        await refuseStagedMoveWhenPaid(
          label,
          res,
          gate.job,
          'This hire is paid in full, so a redo can no longer be requested. The agent opens the pull request next.',
          'redo',
        )
      ) {
        return;
      }
      await applyAndPersist(label, res, gate.job, (job) => requestRedo(job, criterionIndex, new Date()));
    }),
  );

  // P6 (design record row 2): the operator's refusal, returning the job to
  // staged untouched except for the recorded refusal (refuseRedo's own
  // header comment). Party rule: the agent, the same seat that stages the
  // work and is the only other party to a redo request.
  app.post(
    '/jobs/:jobId/redo-refuse',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/redo-refuse';
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['agent']);
      if (gate === null) return;
      await applyAndPersist(label, res, gate.job, (job) => refuseRedo(job, new Date()));
    }),
  );

  // R-10 (ENT-4.3, ENT-4.5), STG2: the agent, holding its own GitHub
  // credentials, pushes stagedCommit to a branch on ITS OWN fork of the
  // buyer repository and opens the pull request itself -- outside this
  // service. This route only ever READS that PR back (github.getPullRequest)
  // and records `submitted` when every one of five checked facts holds;
  // otherwise it answers 409 naming the one fact that failed. The platform
  // never opens anything and never writes a byte against the buyer's
  // repository or the agent's fork (invariant 1, refined 2026-09-25).
  app.post(
    '/jobs/:jobId/pull-request',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const jobId = String(req.params.jobId);

      // Only the agent submits its own work (B7): reading a stranger's PR
      // and recording it as this job's submission is exactly the kind of
      // write the party check exists to gate.
      const gate = await requireSignedParty('POST /jobs/:jobId/pull-request', jobId, req, res, ['agent']);
      if (gate === null) return;
      const current: Job = gate.job;

      const body = (req.body ?? {}) as { pullRequestUrl?: unknown };
      if (typeof body.pullRequestUrl !== 'string' || body.pullRequestUrl.trim() === '') {
        res.status(400).json({ error: 'body must be { pullRequestUrl: string }: the URL of the PR the agent opened from its own fork' });
        return;
      }
      const pullRequestUrl = body.pullRequestUrl;
      const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(pullRequestUrl);
      if (match === null) {
        res.status(400).json({ error: 'pullRequestUrl must look like https://github.com/<owner>/<repo>/pull/<n>' });
        return;
      }
      const [, prOwner, prRepo, prNumberText] = match;
      if (prOwner === undefined || prRepo === undefined || prNumberText === undefined) {
        res.status(400).json({ error: 'pullRequestUrl must look like https://github.com/<owner>/<repo>/pull/<n>' });
        return;
      }
      const ref: PullRequestRef = { owner: prOwner, repo: prRepo, number: Number(prNumberText) };

      // SW1-06: a finished job (any terminal status) is refused by name
      // before money is asked about. Its remainder can never be paid (the
      // remainder start route answers 409 for it), so the money sentence
      // below would send the agent to wait for a payment the platform will
      // refuse. The sentence is the state machine's own, so one fact has
      // one wording. No settlement read and no github read happen here.
      if (isTerminal(current.status)) {
        try {
          validateJobTransition(current.status, 'submitted');
        } catch (err) {
          if (!(err instanceof JobTransitionError)) {
            throw err;
          }
          res.status(409).json({ error: err.message });
          return;
        }
      }

      // P4 anchor: recording a submission cannot happen until the balance
      // is settled. For a job that is not finished this check sits in FRONT
      // of both the state machine check and the github read below (B15: a
      // draft, proposed, confirmed, staged or redo_requested job can still
      // be staged and paid, so "the remainder has not settled" is a true
      // instruction).
      let remainderIsSettled: boolean;
      try {
        remainderIsSettled = await remainderSettled(settlementGate, jobId);
      } catch (err) {
        console.error('POST /jobs/:jobId/pull-request: settlement gate failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (!remainderIsSettled) {
        res.status(402).json({
          error: 'the remainder has not settled; this job cannot open a pull request until it does',
          remainderUsd: current.priceUsd === null ? null : remainderUsd(current.priceUsd, current.depositPercent),
        });
        return;
      }

      // Recording `submitted` is a state transition like any other: the
      // state machine is consulted before github is ever asked. A finished
      // job was refused above, so this check now catches the statuses that
      // are not finished but have no edge to `submitted` (draft, proposed,
      // confirmed, redo_requested, and submitted or stale themselves) once
      // the remainder reads as settled, each with its 409 and without one
      // adapter call.
      try {
        validateJobTransition(current.status, 'submitted');
      } catch (err) {
        if (!(err instanceof JobTransitionError)) {
          throw err;
        }
        res.status(409).json({ error: err.message });
        return;
      }

      // The five facts this route checks all name the agent's own
      // verified GitHub login (agent.githubLogin, proofStatus ===
      // 'verified') -- the same bar confirm already required before it
      // would grant push on the staging repository, re-read here because
      // it could in principle have changed since.
      let agent: Agent | null;
      try {
        agent = await agentRepo.findByDid(current.agentDid);
      } catch (err) {
        console.error('POST /jobs/:jobId/pull-request: storage failed reading agent', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (agent === null || agent.githubLogin === null || agent.proofStatus !== 'verified') {
        res.status(409).json({
          error: 'pull-request needs the agent to have a verified GitHub login; none is on record for this agent',
        });
        return;
      }
      const verifiedGithubLogin = agent.githubLogin;

      let summary: PullRequestSummary;
      try {
        summary = await github.getPullRequest(ref);
      } catch (err) {
        console.error('POST /jobs/:jobId/pull-request: github unavailable', err);
        res.status(503).json({ error: 'github unavailable' });
        return;
      }

      // The five facts, checked in order, each naming itself in its own
      // 409 so the agent knows exactly what to fix (card brief: "else
      // answers 409 naming the one fact that failed"). No fact here is
      // ever asserted by either party -- every one comes straight off
      // what GitHub itself reports on the PR object.
      if (!chainIdentifiersMatch(summary.baseRepoFullName, current.repository)) {
        res.status(409).json({
          error: `the pull request's base repository (${summary.baseRepoFullName}) does not match this job's repository (${current.repository})`,
        });
        return;
      }
      if (!chainIdentifiersMatch(summary.headRepoOwner, verifiedGithubLogin) || !summary.headRepoIsFork) {
        res.status(409).json({
          error: `the pull request's head repository must be a fork owned by the agent's verified GitHub login (${verifiedGithubLogin})`,
        });
        return;
      }
      if (!chainIdentifiersMatch(summary.authorLogin, verifiedGithubLogin)) {
        res.status(409).json({
          error: `the pull request's author (${String(summary.authorLogin)}) must be the agent's verified GitHub login (${verifiedGithubLogin})`,
        });
        return;
      }
      if (!chainIdentifiersMatch(summary.headSha, current.stagedCommit)) {
        res.status(409).json({
          error: `the pull request's head sha (${summary.headSha}) does not match the attested commit (${String(current.stagedCommit)})`,
        });
        return;
      }
      if (summary.state !== 'open') {
        res.status(409).json({ error: `the pull request must be open; github reports it as ${summary.state}` });
        return;
      }
      // Invariant 2: anyone holding the PR alone can tie it to the job.
      if (!summary.body.includes(`Job: ${jobId}`)) {
        res.status(409).json({ error: `the pull request body must contain the line "Job: ${jobId}"` });
        return;
      }

      // The domain applies its rule and the shared skeleton persists it:
      // JobError->400, transition->409, vanished row->404, dead storage->503,
      // exactly like every sibling route after confirm.
      await runExchange(
        'POST /jobs/:jobId/pull-request',
        jobId,
        res,
        (job) => submitPullRequest(job, pullRequestUrl, new Date()),
        null,
        // HT1 Part B: "system events (... PR opened ...) are rows in the
        // same thread." Best-effort, logged, never turns a successful
        // submit into a 503.
        async (persisted) => {
          try {
            const row = await messageRepo.create(
              createSystemMessage(
                {
                  id: 'm-' + randomBytes(8).toString('hex'),
                  jobId: persisted.id,
                  body: 'Pull request opened',
                  systemEvent: { type: 'pr_opened', pullRequestUrl },
                },
                new Date(),
              ),
            );
            broadcastThreadEvent(persisted.id, 'message', messageProjection(row));
          } catch (err) {
            console.error('POST /jobs/:jobId/pull-request: failed to write the pr_opened system row', err);
          }
        },
      );
    }),
  );

  // ==========================================================================
  // P10: the payment surface (brief, "routes to both rails and the observed
  // settlement record"). One contiguous block, per the region fence: every
  // payment route and the ABT DID Connect handler attachment live here, so a
  // rebase against P6's own app.ts changes is one hunk.
  // ==========================================================================

  // The route-safe leg a path segment names. Only 'deposit' | 'remainder'
  // parses; anything else is a 400, never silently coerced.
  function parseRouteLeg(raw: string): RouteLeg | null {
    return raw === 'deposit' || raw === 'remainder' ? raw : null;
  }

  // RULE (brief, "the whole security of this section"): the leg amount
  // comes from the JOB's signed price via the domain's depositUsd /
  // remainderUsd helpers, never from the request body. A body carrying its
  // own amount is refused, not honoured -- callers below never read an
  // amount field off req.body at all, so there is nothing to honour.
  function legAmountUsdFromJob(job: Job, leg: RouteLeg): string {
    return leg === 'deposit'
      ? depositUsd(String(job.priceUsd), job.depositPercent)
      : remainderUsd(String(job.priceUsd), job.depositPercent);
  }

  // B23 and B25 (s8): legStatusEligible,
  // legStatusConflictMessage and legRailMismatchMessage now live in
  // route-support.ts (imported above), shared by every door onto the
  // payment surface -- both rails' /start routes below, the USDC
  // wallet-response route, the ABT session-mint door
  // (requireBuyerToMintAbtSession above) and the ABT wallet-response
  // callback (abt-did-connect.ts's onAuth) -- so the same eligibility and
  // rail rule applies everywhere a leg can be started or settled, rather
  // than each door growing its own copy (the
  // token-mint door and onAuth each had no gate at all, because the
  // check used to live only here, where those two doors could not reach
  // it).

  // S3, Ruling 3: the USDC recipient is the address on record for the
  // hired agent's operator Account, never derived (unlike ABT: an EVM
  // address is a different shape entirely, so there is no reduction from
  // a DID). 'no-agent' and 'no-account' name the two distinct ways this
  // can fail to resolve (an agent with a broken operatorDid vs. a
  // legitimate operator who never set an address), so the two USDC
  // routes below can log the actual cause without collapsing them; the
  // caller-facing outcome is 409 either way (Ruling 5, fail closed).
  type UsdcOperatorAddressResult =
    | { readonly ok: true; readonly operatorAddress: string }
    | { readonly ok: false; readonly reason: 'no-agent' | 'no-account' | 'not-set' };
  async function usdcOperatorAddressForJob(agentDid: string): Promise<UsdcOperatorAddressResult> {
    const agent = await agentRepo.findByDid(agentDid);
    if (agent === null) return { ok: false, reason: 'no-agent' };
    const account = await repo.findByDid(agent.operatorDid);
    if (account === null) return { ok: false, reason: 'no-account' };
    if (account.operatorAddressEvm === null) return { ok: false, reason: 'not-set' };
    return { ok: true, operatorAddress: account.operatorAddressEvm };
  }

  // The recipient of an ABT-on-Ethereum payment: the address the hired
  // agent's operator set for that network, resolved from the account the way
  // usdcOperatorAddressForJob resolves the USDC one. It reads operatorAddressAbtEth
  // and nothing else: an owner with only a USDC address has none here, and
  // the two are never swapped for each other (the same 0x shape on a
  // different network is exactly the wrong-network mistake).
  async function abtEthOperatorAddressForJob(agentDid: string): Promise<string | null> {
    const agent = await agentRepo.findByDid(agentDid);
    if (agent === null) return null;
    const account = await repo.findByDid(agent.operatorDid);
    if (account === null) return null;
    return account.operatorAddressAbtEth;
  }

  // FIX-B39 (B39), rule 5: whether the hired agent's operator has
  // an ABT payout address on record, resolved the same way
  // usdcOperatorAddressForJob resolves the USDC sibling, so
  // checkRailDoorEligible's operatorAddressOk input never has to reach
  // into AccountRepository itself. abt-did-connect.ts's own
  // operatorAddressForJob answers the identical question from inside the
  // exempted payment directory (used to build the actual recipient); this
  // is the route layer's own boolean-only read of the same fact, for the
  // three doors app.ts owns.
  async function abtOperatorAddressOk(agentDid: string): Promise<boolean> {
    const agent = await agentRepo.findByDid(agentDid);
    if (agent === null) return false;
    const account = await repo.findByDid(agent.operatorDid);
    if (account === null) return false;
    return account.operatorAddressAbt !== null;
  }

  // did-connect-js's own attachExpress mounts
  // `{prefix}/{action}/token` (here, /api/did/pay/token) with NO
  // middleware at all (node_modules/@arcblock/did-connect-js/dist/
  // adapters/express.js: `app.get(pathname, generateSession)` and the
  // POST sibling, neither one guarded). Reached directly rather than
  // through the /start route below, it minted a valid, job-bound
  // session token for any jobId a caller named, without a signature of
  // any kind. onAuth (abt-did-connect.ts) still refused to let that
  // session ever settle a payment, so this was never a fund-loss path,
  // but it let a stranger mint sessions for jobs they have no
  // relationship to, which is exactly what the /start route's own gate
  // is supposed to prevent. Registered here, before
  // attachAbtPaymentHandlers mounts its own routes on the same path
  // below: Express matches handlers for one path in the order they were
  // registered, and app.use with an exact path matches every method on
  // it, so this runs in front of did-connect-js's own token handler for
  // both GET and POST. It reuses the exact same requireSignedParty gate
  // /start uses, naming the buyer as the only allowed party. It then
  // hands the proven buyer's DID to the adapter for this one request
  // (setProvenStarter), and the adapter's onStart writes it on the
  // session row; onAuth's party check compares that recorded starter
  // with the job's buyerDid, so a payment the buyer started settles
  // whatever wallet signs it.
  //
  // This guard used to read jobId from req.body on
  // POST and never looked at req.query. did-connect-js's own
  // generateSession (dist/handlers/util.js) builds the session's
  // extraParams as `{ ...req.body, ...req.query, ...req.params }`, so on
  // a POST carrying both, the QUERY value is the one that lands in the
  // session (object spread: later keys win). A caller could name their
  // OWN job in the body, where this guard used to look, and a VICTIM's
  // job in the query, where the session was actually bound. The guard now
  // reads jobId (and leg, which rides the same merge) with the exact same
  // precedence generateSession applies, so it always authorizes the
  // value the session will actually carry.
  function mintExtraParam(req: Request, key: string): string {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const params = (req.params ?? {}) as Record<string, unknown>;
    const merged = { ...body, ...query, ...params };
    return String(merged[key] ?? '');
  }
  const requireBuyerToMintAbtSession = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const jobId = mintExtraParam(req, 'jobId');
      if (jobId === '') {
        res.status(400).json({ error: 'jobId is required to mint an abt payment session' });
        return;
      }
      const gate = await requireSignedParty('GET/POST /api/did/pay/token', jobId, req, res, ['buyer']);
      if (gate === null) return;
      // The proven buyer, for this request only: the adapter's onStart
      // records it on the session row (never read from a query, body or
      // header, and never from extraParams).
      setProvenStarter(req, gate.did);
      // B23 and B25: this is the SECOND door to the
      // exact same session mint /jobs/:jobId/payments/deposit/abt/start
      // opens (see the comment on this middleware's registration below),
      // so it must refuse the identical status and rail conflicts /start
      // refuses -- minting a session for a withdrawn or wrong-rail job
      // through this door was never blocked just because /start was.
      const leg = parseRouteLeg(mintExtraParam(req, 'leg'));
      if (leg === null) {
        res.status(400).json({ error: 'leg must be "deposit" or "remainder"' });
        return;
      }
      // FIX-B39 (B39), rule 5: ONE shared check, in place of
      // B25's job-rail-only check, in this order: the job's pinned
      // currency, the settled deposit's currency, the rail a
      // half-paid or short leg is held on, then the operator address for this
      // rail. This door mints only ABT sessions
      // (attachAbtPaymentHandlers mounts here), so routeRail is fixed.
      const heldAtTokenDoor = await readHeldRail('GET/POST /api/did/pay/token', res, gate.job.id, leg);
      if (heldAtTokenDoor === null) return;
      const tokenDoorEligibility = await checkRailDoorEligible({
        jobId: gate.job.id,
        leg,
        routeRail: 'abt',
        jobRail: gate.job.rail,
        heldRail: heldAtTokenDoor.rail,
        heldAwaitingOwner: heldAtTokenDoor.awaitingOwner,
        settlementRepo,
        operatorAddressOk: await abtOperatorAddressOk(gate.job.agentDid),
      });
      if (!tokenDoorEligibility.ok) {
        res.status(tokenDoorEligibility.status).json({ error: tokenDoorEligibility.message });
        return;
      }
      if (!legStatusEligible(leg, gate.job.status)) {
        res.status(409).json({ error: legStatusConflictMessage(leg, gate.job.status) });
        return;
      }
      // B49 (this card): a leg that already settled must never be
      // paid again. This door mints a payment session for the SAME leg
      // /start would start, so it needs the identical refusal.
      const tokenDoorAlreadySettled = await checkLegNotAlreadySettled({
        jobId: gate.job.id,
        leg,
        settlementRepo,
      });
      if (!tokenDoorAlreadySettled.ok) {
        res.status(tokenDoorAlreadySettled.status).json({ error: tokenDoorAlreadySettled.message });
        return;
      }
      // FIX-B37 (Make item 2): before a DEPOSIT leg starts, on all three
      // doors -- this is the token-mint door, the second door onto the
      // same session did-connect-js's own /api/did/pay/token would
      // otherwise mint unguarded. Runs after the party/rail/status checks
      // above and before anything is minted: a sibling already confirmed,
      // an unsigned agreement, a not-ready repository (FIX-B36, unchanged)
      // or an unverified agent GitHub login (B42) each start nothing. The
      // remainder leg is not checked here: the repository, agreement and
      // sibling facts were already proven at confirm (Not this card
      // section, brief).
      if (leg === 'deposit') {
        const readiness = await checkDepositReadiness({
          label: 'GET/POST /api/did/pay/token',
          job: gate.job,
          jobRepo,
          github,
          agent: await agentRepo.findByDid(gate.job.agentDid),
        });
        if (!readiness.ok) {
          res.status(readiness.status).json({ error: readiness.message });
          return;
        }
      }
      next();
    })().catch(next);
  };

  // The ABT DID Connect handlers are attached ONCE at app construction
  // (brief scope item 3), only when the rail is configured: an unwired
  // deployment mounts no DID Connect routes at all, and its /start route
  // (below) answers the same clean 503 every other unconfigured rail
  // answers, rather than a route that exists but can never complete.
  if (abtPaymentRail !== null) {
    app.use('/api/did/pay/token', didSignature, populateSessionSubject, requireBuyerToMintAbtSession);
  }
  const abtHandlers =
    abtPaymentRail === null
      ? null
      : attachAbtPaymentHandlers({
          app,
          rail: abtPaymentRail,
          jobRepo,
          agentRepo,
          accountRepo: repo,
          settlementRepo,
          heldRailFor: (jobId, leg) => heldLegOf(jobId, leg),
          platformSk: process.env.FREEAGENTS_ABT_PLATFORM_SK || '',
          chainHost: process.env.FREEAGENTS_ABT_CHAIN_HOST || '',
          baseUrl: publicBaseUrlFromEnv(),
          txEncoder: abtTxEncoder,
          onSettlementRecorded: recordSettlementSystemEvent,
        });

  // The buyer's browser calls this to START an ABT payment for a named
  // job and leg (brief scope item 3). It returns whatever the DID Connect
  // session token generator needs; the web layer renders the scan from
  // the response's own `url` field. RULE: the party check is made at
  // onAuth time (abt-did-connect.ts) against the session's recorded
  // starter, the buyer this route proved below (setProvenStarter), and
  // compares that starter with the job's own buyerDid; it does not look
  // at which wallet answers. That is the check that gates whether a
  // payment can ever settle.
  // This route's own buyer gate covers only calls
  // that go through this path. The `requireBuyerToMintAbtSession`
  // middleware registered above, in front of did-connect-js's own
  // /api/did/pay/token mount, is what stops a stranger reaching that
  // route directly and minting a session token for someone else's job
  // without ever touching this route at all.
  //
  // P8a (invariant 8): requireSignedParty below now accepts a live
  // session exactly where it accepts a verified R-34 signature, so a
  // signed-in buyer with no signing key can reach this route. That is
  // ALL a session buys here: reaching the route that BUILDS the
  // transaction. The transaction itself is still built for the buyer's
  // own wallet to sign (invariant 12: the platform is never an input
  // owner), and the DID Connect wallet callback below still refuses any
  // payment whose session was not started by the job's buyer. It requires
  // a wallet's signature on a payment the buyer started, whichever wallet
  // signs it. A session never substitutes for that signature; it only
  // gets the buyer past the door and is what the callback later checks
  // as the proven starter.
  app.post(
    '/jobs/:jobId/payments/:leg/abt/start',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/payments/:leg/abt/start';
      const leg = parseRouteLeg(String(req.params.leg));
      if (leg === null) {
        res.status(400).json({ error: 'leg must be "deposit" or "remainder"' });
        return;
      }
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      // The proven buyer, for this request only: the adapter's onStart
      // records it on the session row (never read from a query, body or
      // header, and never from extraParams).
      setProvenStarter(req, gate.did);
      if (abtPaymentRail === null || abtHandlers === null) {
        res.status(503).json({ error: 'the abt payment rail is not configured on this deployment' });
        return;
      }
      // S3, Ruling 6: operatorAddress is REMOVED from this route's body.
      // The recipient is resolved from the hired agent's operator inside
      // the adapter (abt-did-connect.ts), never from the request; a body
      // that still names one is refused outright, not silently ignored.
      const body = (req.body ?? {}) as { operatorAddress?: unknown };
      if (body.operatorAddress !== undefined) {
        res.status(400).json({
          error: "the recipient is resolved from the hired agent's operator and may not be supplied",
        });
        return;
      }
      if (gate.job.priceUsd === null) {
        res.status(409).json({ error: 'this job has no agreed price to pay against' });
        return;
      }
      // FIX-B39 (B39), rule 5: ONE shared check, in place of
      // B25's job-rail-only check, in this order: the job's pinned
      // currency, the settled deposit's currency, the rail a
      // half-paid or short leg is held on, then the operator address for this
      // rail.
      const heldAtAbtStart = await readHeldRail(label, res, gate.job.id, leg);
      if (heldAtAbtStart === null) return;
      const abtEligibility = await checkRailDoorEligible({
        jobId: gate.job.id,
        leg,
        routeRail: 'abt',
        jobRail: gate.job.rail,
        heldRail: heldAtAbtStart.rail,
        heldAwaitingOwner: heldAtAbtStart.awaitingOwner,
        settlementRepo,
        operatorAddressOk: await abtOperatorAddressOk(gate.job.agentDid),
      });
      if (!abtEligibility.ok) {
        res.status(abtEligibility.status).json({ error: abtEligibility.message });
        return;
      }
      // B23: the leg must belong to the job's CURRENT status.
      if (!legStatusEligible(leg, gate.job.status)) {
        res.status(409).json({ error: legStatusConflictMessage(leg, gate.job.status) });
        return;
      }
      // B49 (this card): a leg that already settled must never be
      // paid again, on either rail.
      const abtAlreadySettled = await checkLegNotAlreadySettled({
        jobId: gate.job.id,
        leg,
        settlementRepo,
      });
      if (!abtAlreadySettled.ok) {
        res.status(abtAlreadySettled.status).json({ error: abtAlreadySettled.message });
        return;
      }
      // FIX-B37 (Make item 2): before a DEPOSIT leg starts, the platform
      // checks the whole deposit-readiness surface and refuses (409,
      // nothing minted) a sibling already confirmed, an unsigned
      // agreement, a not-ready repository (FIX-B36, unchanged) or an
      // unverified agent GitHub login (B42). Runs after the
      // party/price/rail/status checks above and before generateSession
      // ever mints a wallet session.
      if (leg === 'deposit') {
        const readiness = await checkDepositReadiness({
          label,
          job: gate.job,
          jobRepo,
          github,
          agent: await agentRepo.findByDid(gate.job.agentDid),
        });
        if (!readiness.ok) {
          res.status(readiness.status).json({ error: readiness.message });
          return;
        }
      }
      // FIX-B70a: the price is read here once before a session is minted,
      // so a deployment with no ABT/USD price answers 503 and starts
      // nothing. The session's own lock is written by onStart in the
      // adapter (abt-did-connect.ts), which both doors run. The sentence
      // stays free of the payment vocabulary the no-custody test bans
      // outside the payment adapter directory.
      try {
        await abtPaymentRail.quote({ priceUsd: legAmountUsdFromJob(gate.job, leg) });
      } catch (error) {
        if (error instanceof RateUnavailableError) {
          res.status(503).json({ error: 'The ABT price is not available right now. Try again in a minute.' });
          return;
        }
        throw error;
      }
      // The did-connect-js generateSession route reads req.query,
      // req.body and req.params into extraParams (protocol.js's own
      // mechanism); jobId/leg ride through req.query so the web layer's
      // GET-based QR flow carries them the same way qr-server.mjs's own
      // reference does. operatorAddress no longer rides along at all
      // (S3, Ruling 6): the adapter derives it itself.
      req.query = {
        ...req.query,
        jobId: String(req.params.jobId),
        leg,
      };
      // did-connect-js's own generateSession builds the
      // wallet callback URL from req.originalUrl (preparePathname,
      // node_modules/@arcblock/did-connect-js/dist/handlers/util.js). It
      // expects to be invoked as the handler mounted directly at
      // /api/did/pay/token (attachExpress's own mount point) and strips
      // that exact path back out of whatever it is given. Calling
      // generateSession from this route's own different path left the
      // whole /jobs/.../abt/start prefix stuck on the front of the
      // callback URL, so a real wallet fetched a path that 404s. Only
      // the pathname half of preparePathname's split matters (the query
      // string plays no part in it), so rewriting originalUrl to the
      // path attachAbtPaymentHandlers actually mounted the token route at
      // is enough to make preparePathname resolve the same callback path
      // that route would have produced. Nothing downstream of this call
      // reads the pre-rewrite value.
      req.originalUrl = '/api/did/pay/token';
      await abtHandlers.generateSession(req, res);
    }),
  );

  // The USDC deposit/remainder start route (brief scope item 4). Answers
  // the rail's PaymentRequest, which already carries the two transfer
  // intents as a TUPLE (types.ts), so the web layer cannot receive one or
  // three of them.
  //
  // P8a (invariant 8): a session authorizes reaching this route exactly
  // like a verified R-34 signature does (requireSignedParty below); it
  // never authorizes moving funds. The PaymentRequest this route answers
  // still names transfers for the buyer's OWN wallet to sign and submit
  // on-chain (invariant 12: the platform is never an input owner) --
  // nothing here builds or holds a platform-signed transaction.
  app.post(
    '/jobs/:jobId/payments/:leg/usdc/start',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/payments/:leg/usdc/start';
      const leg = parseRouteLeg(String(req.params.leg));
      if (leg === null) {
        res.status(400).json({ error: 'leg must be "deposit" or "remainder"' });
        return;
      }
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      if (usdcPaymentRail === null) {
        res.status(503).json({ error: 'the usdc payment rail is not configured on this deployment' });
        return;
      }
      // S3, Ruling 6: operatorAddress is REMOVED from this route's body.
      // The recipient is resolved from the hired agent's operator account
      // below, never from the request; a body that still names one is
      // refused outright, not silently ignored.
      const body = (req.body ?? {}) as { operatorAddress?: unknown };
      if (body.operatorAddress !== undefined) {
        res.status(400).json({
          error: "the recipient is resolved from the hired agent's operator and may not be supplied",
        });
        return;
      }
      if (gate.job.priceUsd === null) {
        res.status(409).json({ error: 'this job has no agreed price to pay against' });
        return;
      }
      // S3, Ruling 5: resolved once, reused both for the shared
      // eligibility check below (rule 5) and for the actual recipient
      // address the rail needs to quote against.
      const operatorAddressResult = await usdcOperatorAddressForJob(gate.job.agentDid);
      // FIX-B39 (B39), rule 5: ONE shared check, in place of
      // B25's job-rail-only check, in this order: the job's pinned
      // currency, the settled deposit's currency, the rail a
      // half-paid or short leg is held on, then the operator address for this
      // rail.
      const heldAtUsdcStart = await readHeldRail(label, res, gate.job.id, leg);
      if (heldAtUsdcStart === null) return;
      const usdcEligibility = await checkRailDoorEligible({
        jobId: gate.job.id,
        leg,
        routeRail: 'usdc',
        jobRail: gate.job.rail,
        heldRail: heldAtUsdcStart.rail,
        heldAwaitingOwner: heldAtUsdcStart.awaitingOwner,
        settlementRepo,
        operatorAddressOk: operatorAddressResult.ok,
      });
      if (!usdcEligibility.ok) {
        res.status(usdcEligibility.status).json({ error: usdcEligibility.message });
        return;
      }
      // B23: the leg must belong to the job's CURRENT status.
      if (!legStatusEligible(leg, gate.job.status)) {
        res.status(409).json({ error: legStatusConflictMessage(leg, gate.job.status) });
        return;
      }
      // B49 (this card): a leg that already settled must never be
      // paid again.
      const usdcStartAlreadySettled = await checkLegNotAlreadySettled({
        jobId: gate.job.id,
        leg,
        settlementRepo,
      });
      if (!usdcStartAlreadySettled.ok) {
        res.status(usdcStartAlreadySettled.status).json({ error: usdcStartAlreadySettled.message });
        return;
      }
      // FIX-B37 (Make item 2): before a DEPOSIT leg starts, the platform
      // checks the whole deposit-readiness surface and refuses (409,
      // nothing quoted) a sibling already confirmed, an unsigned
      // agreement, a not-ready repository (FIX-B36, unchanged) or an
      // unverified agent GitHub login (B42). Runs after the
      // party/price/rail/status checks above and before the rail is ever
      // asked to quote.
      if (leg === 'deposit') {
        const readiness = await checkDepositReadiness({
          label,
          job: gate.job,
          jobRepo,
          github,
          agent: await agentRepo.findByDid(gate.job.agentDid),
        });
        if (!readiness.ok) {
          res.status(readiness.status).json({ error: readiness.message });
          return;
        }
      }
      // operatorAddressResult was already checked ok above (rule 5's own
      // eligibility gate); this narrows it back to the address string
      // for the rail call below without a second lookup.
      if (!operatorAddressResult.ok) {
        // Unreachable: checkRailDoorEligible already refused when this
        // was false. Kept only so TypeScript can narrow the union below
        // without a cast.
        res.status(409).json({
          error: "the hired agent's operator has not set a USDC operator address; PATCH /accounts/:did/operator-address first",
        });
        return;
      }
      // RULE: the amount comes from the job's signed price, never a body
      // field. A body carrying its own amount is refused, not honoured:
      // this call reads no amount from `body` at all.
      const amountUsd = legAmountUsdFromJob(gate.job, leg);
      let request: PaymentRequest;
      try {
        const quote = await usdcPaymentRail.quote({ priceUsd: amountUsd });
        request = await requestPayment(usdcPaymentRail, {
          jobId: gate.job.id,
          leg,
          operatorAddress: operatorAddressResult.operatorAddress,
          amountToken: quote.amountToken,
          feeToken: quote.feeToken,
        });
      } catch (err) {
        console.error(`${label}: rail failed`, err);
        res.status(503).json({ error: 'the usdc payment rail is unavailable' });
        return;
      }
      // Make 2 (B49 card): the leg's half-paid record, when one exists,
      // rides beside the transfers under its own top-level key so any
      // device can finish a half-paid payment by sending only the
      // missing transfer. Absent when the leg has never gone half-paid.
      const halfPaidRecord = await usdcHalfPaidRecordFor(usdcPaymentRail, gate.job.id, leg);
      res.status(200).json(halfPaidRecord === null ? request : { ...request, halfPaidRecord });
    }),
  );

  // The USDC wallet-response route (brief scope item 4): accepts what the
  // wallet reported, the price hash and the fee outcome as either a hash
  // or an explicit "the wallet never signed it". Passed straight into
  // onWalletResponse, whose input type already models all three cases;
  // this route never substitutes an empty string for a missing hash.
  app.post(
    '/jobs/:jobId/payments/:leg/usdc/wallet-response',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/payments/:leg/usdc/wallet-response';
      const leg = parseRouteLeg(String(req.params.leg));
      if (leg === null) {
        res.status(400).json({ error: 'leg must be "deposit" or "remainder"' });
        return;
      }
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      if (usdcPaymentRail === null) {
        res.status(503).json({ error: 'the usdc payment rail is not configured on this deployment' });
        return;
      }
      // B23: "a wallet response for a hash already
      // recorded stays idempotent" is the brief's own requirement, but the
      // status and rail gates below ran before any check for a hash this
      // leg has already settled -- so a replay of the SAME hash started
      // answering 409 the moment the job moved past its eligible status
      // (confirm() advancing it from 'proposed' to 'confirmed', for
      // example), which is exactly the case idempotency exists for: a
      // late or duplicate wallet callback for a payment that already
      // landed. A replay is recognised here, before either gate, by
      // comparing the incoming hash (normalized the same way onWalletResponse
      // itself normalizes one) against whatever this job and leg already
      // has recorded; a match skips both gates below and falls through to
      // the normal processing path, which re-confirms the same ref and
      // answers exactly as the first call did.
      // A replay must match the WHOLE recorded
      // settlement, not merely the price hash. Comparing priceTxHash
      // alone let a request carrying the recorded price hash and a
      // DIFFERENT feeTx hash skip both gates below as if it were the
      // same wallet response that already landed, and it would then
      // overwrite the settled row's secondaryHash. A replay is only ever
      // the exact pair (or the exact "wallet never signed the fee"
      // outcome) this leg already has recorded.
      const bodyForIdempotencyCheck = req.body as
        | { priceTxHash?: unknown; feeTx?: { signed?: unknown; hash?: unknown } }
        | undefined;
      const priceTxHashForIdempotencyCheck = bodyForIdempotencyCheck?.priceTxHash;
      const feeTxForIdempotencyCheck = bodyForIdempotencyCheck?.feeTx;
      const alreadyRecorded = await settlementRepo.findByJobAndLeg(gate.job.id, leg);
      const incomingFeeHashNormalized =
        typeof feeTxForIdempotencyCheck === 'object' &&
        feeTxForIdempotencyCheck !== null &&
        feeTxForIdempotencyCheck.signed === true &&
        typeof feeTxForIdempotencyCheck.hash === 'string'
          ? normalizeUsdcTxHash(feeTxForIdempotencyCheck.hash)
          : null;
      const recordedFeeHashNormalized =
        alreadyRecorded?.secondaryHash != null ? normalizeUsdcTxHash(alreadyRecorded.secondaryHash) : null;
      const isIdempotentReplay =
        alreadyRecorded !== null &&
        typeof priceTxHashForIdempotencyCheck === 'string' &&
        normalizeUsdcTxHash(alreadyRecorded.hash) === normalizeUsdcTxHash(priceTxHashForIdempotencyCheck) &&
        incomingFeeHashNormalized === recordedFeeHashNormalized;
      if (!isIdempotentReplay) {
        // FIX-B39 (B39), rule 5: ONE shared check, in place of
        // B25's job-rail-only check, in this order: the job's pinned
        // currency, the settled deposit's currency, the rail a
        // half-paid or short leg is held on, then the operator address for this
        // rail.
        const heldAtUsdcResponse = await readHeldRail(label, res, gate.job.id, leg);
        if (heldAtUsdcResponse === null) return;
        const usdcResponseEligibility = await checkRailDoorEligible({
          jobId: gate.job.id,
          leg,
          routeRail: 'usdc',
          jobRail: gate.job.rail,
          heldRail: heldAtUsdcResponse.rail,
          heldAwaitingOwner: heldAtUsdcResponse.awaitingOwner,
          settlementRepo,
          operatorAddressOk: (await usdcOperatorAddressForJob(gate.job.agentDid)).ok,
        });
        if (!usdcResponseEligibility.ok) {
          res.status(usdcResponseEligibility.status).json({ error: usdcResponseEligibility.message });
          return;
        }
        // B23: the leg must belong to the job's CURRENT status. A hash
        // that arrives after the job left the eligible window (a late
        // callback for a job the buyer has since withdrawn, for example)
        // is refused the same way a fresh start call would be refused --
        // never treated as a late-but-honoured payment.
        if (!legStatusEligible(leg, gate.job.status)) {
          res.status(409).json({ error: legStatusConflictMessage(leg, gate.job.status) });
          return;
        }
        // B49 (this card): a leg that already settled must never
        // be paid again. isIdempotentReplay above already lets the exact
        // recorded pair through unchanged; anything else touching a
        // settled leg is a fresh attempt and is refused here.
        const walletResponseAlreadySettled = await checkLegNotAlreadySettled({
          jobId: gate.job.id,
          leg,
          settlementRepo,
        });
        if (!walletResponseAlreadySettled.ok) {
          res.status(walletResponseAlreadySettled.status).json({ error: walletResponseAlreadySettled.message });
          return;
        }
      }
      const body = (req.body ?? {}) as {
        operatorAddress?: unknown;
        priceTxHash?: unknown;
        feeTx?: unknown;
      };
      // S3, Ruling 6: operatorAddress is REMOVED from this route's body,
      // same as /start. Resolved from the hired agent's operator account
      // below, never from the request.
      if (body.operatorAddress !== undefined) {
        res.status(400).json({
          error: "the recipient is resolved from the hired agent's operator and may not be supplied",
        });
        return;
      }
      const feeTxRaw = body.feeTx as { signed?: unknown; hash?: unknown } | undefined;
      const feeTxWellFormed =
        typeof feeTxRaw === 'object' &&
        feeTxRaw !== null &&
        (feeTxRaw.signed === false || (feeTxRaw.signed === true && typeof feeTxRaw.hash === 'string' && feeTxRaw.hash.length > 0));
      if (
        typeof body.priceTxHash !== 'string' ||
        body.priceTxHash.trim() === '' ||
        !feeTxWellFormed
      ) {
        res.status(400).json({
          error:
            'body must be { priceTxHash, feeTx }; feeTx is { signed: true, hash } or { signed: false }',
        });
        return;
      }
      const feeTx = feeTxRaw as { signed: true; hash: string } | { signed: false };

      // S3, Ruling 5: no address on record is a 409, fail closed, the
      // same rule /start already enforces.
      const operatorAddressResult = await usdcOperatorAddressForJob(gate.job.agentDid);
      if (!operatorAddressResult.ok) {
        res.status(409).json({
          error: "the hired agent's operator has not set a USDC operator address; PATCH /accounts/:did/operator-address first",
        });
        return;
      }

      // S1 scope item 4: priceTxHash equal to feeTx.hash is refused here,
      // at the route, as a malformed request (400) -- not answered by the
      // rail as a chain observation. One transfer can never satisfy both
      // legs of a payment. Normalized before comparison:
      // a real node resolves a transaction hash case-insensitively,
      // so the same transaction respelled in a different letter case is
      // still the same transaction and must still be refused.
      if (feeTx.signed && normalizeUsdcTxHash(feeTx.hash) === normalizeUsdcTxHash(body.priceTxHash)) {
        res.status(400).json({ error: 'priceTxHash and feeTx.hash must not be the same transaction' });
        return;
      }

      let ref: PaymentRef;
      let confirmation;
      try {
        ref = await processWalletResponse(usdcPaymentRail, leg, {
          rail: 'usdc',
          jobId: gate.job.id,
          operatorAddress: operatorAddressResult.operatorAddress,
          priceTxHash: body.priceTxHash,
          feeTx,
          amountUsd: legAmountUsdFromJob(gate.job, leg),
        });
        confirmation = await confirmPayment(usdcPaymentRail, ref);
      } catch (err) {
        console.error(`${label}: rail failed`, err);
        res.status(503).json({ error: 'the usdc payment rail is unavailable' });
        return;
      }

      // RULE: the settlement row is written ONLY here, and ONLY when
      // confirm() answered confirmed: true. The half-paid case writes no
      // settlement (the rail itself already wrote its own half-paid row);
      // this route leaves the gate refusing and answers the per-leg
      // statuses confirm() carries.
      // A replay is the exact pair this leg already has recorded, so the
      // row and the paid line it wrote the first time are still true.
      // Writing them again would move observedAt, which the delivery clock
      // counts its 7 days from, and repeat the paid line in the thread.
      if (confirmation.confirmed && ref.rail === 'usdc' && !isIdempotentReplay) {
        await settlementRepo.record({
          jobId: gate.job.id,
          leg,
          rail: 'usdc',
          hash: ref.priceTxHash,
          secondaryHash: ref.feeTxHash,
          operatorAddress: ref.operatorAddress,
          feeAddress: ref.feeAddress,
          amountUsd: legAmountUsdFromJob(gate.job, leg),
          observedAt: new Date(),
        });
        await recordSettlementSystemEvent({
          jobId: gate.job.id,
          leg,
          rail: 'usdc',
          amountUsd: legAmountUsdFromJob(gate.job, leg),
        });
      }

      res.status(200).json(confirmation);
    }),
  );

  // The ABT-on-Ethereum start route: the USDC start's gates in the USDC
  // start's order, then a quote, a lock and the request. The lock is what the
  // wallet-response route checks the report against: the buyer's wallet
  // broadcasts the two transfers itself and the platform hears of them
  // afterwards, so the amounts the buyer was asked to sign are kept here,
  // per start, and never read again from the price feed. The exception is a
  // leg that is already half-paid: its record names the lock its confirmed
  // transfer was checked against, and the start answers that lock (its own
  // amounts and hold end) instead of quoting again, so the payment is
  // finished at the price the buyer approved. If the agreed price has
  // changed since, the start refuses with a sentence asking for the earlier
  // price back (abtEthHalfPaidRefusal), because quoting again is exactly
  // what a half-paid leg must not do.
  //
  // Invariant 12: the answer is an intent for the buyer's own wallet. The
  // platform builds, signs and holds nothing.
  app.post(
    '/jobs/:jobId/payments/:leg/abt_eth/start',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/payments/:leg/abt_eth/start';
      const leg = parseRouteLeg(String(req.params.leg));
      if (leg === null) {
        res.status(400).json({ error: 'leg must be "deposit" or "remainder"' });
        return;
      }
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      if (abtEthPaymentRail === null || abtEthLocks === null) {
        res.status(503).json({ error: 'the abt_eth payment rail is not configured on this deployment' });
        return;
      }
      const body = (req.body ?? {}) as { operatorAddress?: unknown };
      if (body.operatorAddress !== undefined) {
        res.status(400).json({
          error: "the recipient is resolved from the hired agent's operator and may not be supplied",
        });
        return;
      }
      if (gate.job.priceUsd === null) {
        res.status(409).json({ error: 'this job has no agreed price to pay against' });
        return;
      }
      const operatorAddress = await abtEthOperatorAddressForJob(gate.job.agentDid);
      const heldAtAbtEthStart = await readHeldRail(label, res, gate.job.id, leg);
      if (heldAtAbtEthStart === null) return;
      // A leg whose payment reached the owner worth less than the agreed
      // price waits on the owner: it is not asked for again, so no new lock
      // is written, and the refusal comes before any check that could answer
      // with a step the hirer cannot take.
      if (heldAtAbtEthStart.awaitingOwner) {
        res.status(409).json({ error: SHORT_AWAITING_OWNER_MESSAGE });
        return;
      }
      const eligibility = await checkRailDoorEligible({
        jobId: gate.job.id,
        leg,
        routeRail: 'abt_eth',
        jobRail: gate.job.rail,
        heldRail: heldAtAbtEthStart.rail,
        heldAwaitingOwner: heldAtAbtEthStart.awaitingOwner,
        settlementRepo,
        operatorAddressOk: operatorAddress !== null,
      });
      if (!eligibility.ok) {
        res.status(eligibility.status).json({ error: eligibility.message });
        return;
      }
      if (!legStatusEligible(leg, gate.job.status)) {
        res.status(409).json({ error: legStatusConflictMessage(leg, gate.job.status) });
        return;
      }
      const alreadySettled = await checkLegNotAlreadySettled({
        jobId: gate.job.id,
        leg,
        settlementRepo,
      });
      if (!alreadySettled.ok) {
        res.status(alreadySettled.status).json({ error: alreadySettled.message });
        return;
      }
      if (leg === 'deposit') {
        const readiness = await checkDepositReadiness({
          label,
          job: gate.job,
          jobRepo,
          github,
          agent: await agentRepo.findByDid(gate.job.agentDid),
        });
        if (!readiness.ok) {
          res.status(readiness.status).json({ error: readiness.message });
          return;
        }
      }
      // Narrowing only: checkRailDoorEligible above already refused every
      // case where the owner has no ABT-on-Ethereum address.
      if (operatorAddress === null) {
        res.status(409).json({ error: operatorAddressNotSetMessage('abt_eth') });
        return;
      }
      // The amount comes from the job's signed price, never a body field.
      const amountUsd = legAmountUsdFromJob(gate.job, leg);
      // A leg with one transfer already confirmed is finished at the lock
      // that transfer was confirmed against: the same amounts and the same
      // hold, however the price reads now and however late the page asks.
      // Nothing is quoted and no lock is written for it. A record that
      // names no lock (written before the lock id was kept) and a leg with
      // no record take the ordinary path below.
      const storedHalfPaid = await abtEthHalfPaidRecordFor(abtEthPaymentRail, gate.job.id, leg);
      let lock;
      if (storedHalfPaid !== null && storedHalfPaid.lockId !== null) {
        const held = await checkAbtEthQuoteLock(abtEthLocks, { lockId: storedHalfPaid.lockId, jobId: gate.job.id, leg, amountUsd });
        if (!held.ok) {
          res.status(409).json({ error: abtEthHalfPaidRefusal(held.message) });
          return;
        }
        lock = held.lock;
      } else {
        let quote;
        try {
          quote = await abtEthPaymentRail.quote({ priceUsd: amountUsd });
        } catch (err) {
          if (err instanceof RateUnavailableError) {
            res.status(503).json({ error: 'The ABT price is not available right now. Try again in a minute.' });
            return;
          }
          console.error(`${label}: rail failed`, err);
          res.status(503).json({ error: 'the abt_eth payment rail is unavailable' });
          return;
        }
        lock = await lockAbtEthQuote(abtEthLocks, { jobId: gate.job.id, leg, amountUsd, quote, now: new Date() });
      }
      // The request is built from the lock's own amounts, never a second
      // quote: what the buyer is asked to sign is what the report is checked
      // against. A failure here (the node not answering for the token's
      // decimals) leaves a freshly written lock row behind, which no buyer
      // holds the id of and no report can name.
      let request: PaymentRequest;
      try {
        request = await requestPayment(abtEthPaymentRail, {
          jobId: gate.job.id,
          leg,
          operatorAddress,
          amountToken: lock.amountToken,
          feeToken: lock.feeToken,
        });
      } catch (err) {
        console.error(`${label}: rail failed`, err);
        res.status(503).json({ error: 'the abt_eth payment rail is unavailable' });
        return;
      }
      const quoteLock = {
        id: lock.id,
        usdPerAbt: lock.usdPerToken,
        rateUpdatedAt: lock.rateUpdatedAt === null ? null : lock.rateUpdatedAt.toISOString(),
        expiresAt: lock.expiresAt.toISOString(),
      };
      // The leg's half-paid record rides beside the request when the leg has
      // one, so a device can finish the payment by sending only what is
      // missing. Its four keys only: the lock rides in quoteLock.id.
      const halfPaidRecord =
        storedHalfPaid === null
          ? null
          : {
              priceTxHash: storedHalfPaid.priceTxHash,
              priceStatus: storedHalfPaid.priceStatus,
              feeTxHash: storedHalfPaid.feeTxHash,
              feeStatus: storedHalfPaid.feeStatus,
            };
      res.status(200).json(halfPaidRecord === null ? { ...request, quoteLock } : { ...request, quoteLock, halfPaidRecord });
    }),
  );

  // The ABT-on-Ethereum report route: what the wallet answered, the price
  // hash and the fee outcome, with the id of the lock the start answered.
  // The rail is handed the lock's amounts, never the body's and never a new
  // quote, so a price that moved since the start cannot change what the
  // network is checked against. On a half-paid leg the lock must be the one
  // the leg's record names, when the report is about the price transfer on
  // that record; the rail writes the id of the lock it was handed into the
  // record it keeps. A changed agreed price is refused with the lock
  // module's sentence, except on a half-paid leg that names a lock, where
  // the sentence asks for the earlier price back instead of a new start.
  //
  // The late-transfer rule. The buyer's wallet broadcast the transfers, so the
  // time that counts is the block time the rail read (priceRecordedAt), never
  // the time this request arrived. Recorded inside the hold: it counts at
  // the held price however late this report is. Recorded at or after the
  // hold's end, or with no block time: it counts only if the locked token
  // amount is still worth the agreed dollars at a price read now; otherwise
  // it is stored as short, nothing settles, and the hire waits on the owner.
  app.post(
    '/jobs/:jobId/payments/:leg/abt_eth/wallet-response',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/payments/:leg/abt_eth/wallet-response';
      const leg = parseRouteLeg(String(req.params.leg));
      if (leg === null) {
        res.status(400).json({ error: 'leg must be "deposit" or "remainder"' });
        return;
      }
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      if (abtEthPaymentRail === null || abtEthLocks === null || abtEthShorts === null) {
        res.status(503).json({ error: 'the abt_eth payment rail is not configured on this deployment' });
        return;
      }
      if (gate.job.priceUsd === null) {
        res.status(409).json({ error: 'this job has no agreed price to pay against' });
        return;
      }
      // A replay is the exact pair this leg already has recorded (the price
      // hash and the fee hash, or the same "the wallet never signed the
      // fee"), recognised before the status and rail gates so a late or
      // duplicate report still answers as the first one did after the job
      // moved on. It writes nothing: the settlement row's time is what the
      // delivery clock counts its 7 days from, and the paid line is already
      // in the thread. Hashes compare without case.
      const replayBody = req.body as
        | { priceTxHash?: unknown; feeTx?: { signed?: unknown; hash?: unknown } }
        | undefined;
      const alreadyRecorded = await settlementRepo.findByJobAndLeg(gate.job.id, leg);
      const incomingFeeHash =
        typeof replayBody?.feeTx === 'object' &&
        replayBody.feeTx !== null &&
        replayBody.feeTx.signed === true &&
        typeof replayBody.feeTx.hash === 'string'
          ? replayBody.feeTx.hash.toLowerCase()
          : null;
      const recordedFeeHash = alreadyRecorded?.secondaryHash != null ? alreadyRecorded.secondaryHash.toLowerCase() : null;
      const isIdempotentReplay =
        alreadyRecorded !== null &&
        typeof replayBody?.priceTxHash === 'string' &&
        alreadyRecorded.hash.toLowerCase() === replayBody.priceTxHash.toLowerCase() &&
        incomingFeeHash === recordedFeeHash;
      const operatorAddress = await abtEthOperatorAddressForJob(gate.job.agentDid);
      if (!isIdempotentReplay) {
        const heldAtAbtEthResponse = await readHeldRail(label, res, gate.job.id, leg);
        if (heldAtAbtEthResponse === null) return;
        // A leg whose payment reached the owner worth less than the agreed
        // price waits on the owner. The pair already stored short answers
        // what its first report answered, from the stored row and not from a
        // fresh price read, and writes nothing. Any other pair is refused
        // before anything is checked or written. Neither settles the leg.
        if (heldAtAbtEthResponse.awaitingOwner) {
          let stored: AbtEthShortPayment | null;
          try {
            stored = await abtEthShorts.findByHash(typeof replayBody?.priceTxHash === 'string' ? replayBody.priceTxHash : '');
          } catch (err) {
            console.error(`${label}: short payment read failed`, err);
            res.status(503).json({ error: 'storage unavailable' });
            return;
          }
          const firstAnswer = storedShortAnswer(stored, { jobId: gate.job.id, leg, report: replayBody });
          if (firstAnswer === null) {
            res.status(409).json({ error: SHORT_AWAITING_OWNER_MESSAGE });
            return;
          }
          res.status(200).json(firstAnswer);
          return;
        }
        const eligibility = await checkRailDoorEligible({
          jobId: gate.job.id,
          leg,
          routeRail: 'abt_eth',
          jobRail: gate.job.rail,
          heldRail: heldAtAbtEthResponse.rail,
          heldAwaitingOwner: heldAtAbtEthResponse.awaitingOwner,
          settlementRepo,
          operatorAddressOk: operatorAddress !== null,
        });
        if (!eligibility.ok) {
          res.status(eligibility.status).json({ error: eligibility.message });
          return;
        }
        if (!legStatusEligible(leg, gate.job.status)) {
          res.status(409).json({ error: legStatusConflictMessage(leg, gate.job.status) });
          return;
        }
        const alreadySettled = await checkLegNotAlreadySettled({
          jobId: gate.job.id,
          leg,
          settlementRepo,
        });
        if (!alreadySettled.ok) {
          res.status(alreadySettled.status).json({ error: alreadySettled.message });
          return;
        }
      }
      const body = (req.body ?? {}) as {
        operatorAddress?: unknown;
        priceTxHash?: unknown;
        feeTx?: unknown;
        quoteLockId?: unknown;
      };
      if (body.operatorAddress !== undefined) {
        res.status(400).json({
          error: "the recipient is resolved from the hired agent's operator and may not be supplied",
        });
        return;
      }
      const feeTxRaw = body.feeTx as { signed?: unknown; hash?: unknown } | undefined;
      const feeTxWellFormed =
        typeof feeTxRaw === 'object' &&
        feeTxRaw !== null &&
        (feeTxRaw.signed === false || (feeTxRaw.signed === true && typeof feeTxRaw.hash === 'string' && feeTxRaw.hash.length > 0));
      if (
        typeof body.priceTxHash !== 'string' ||
        body.priceTxHash.trim() === '' ||
        !feeTxWellFormed ||
        typeof body.quoteLockId !== 'string' ||
        body.quoteLockId === ''
      ) {
        res.status(400).json({
          error:
            'body must be { priceTxHash, feeTx, quoteLockId }; feeTx is { signed: true, hash } or { signed: false }; quoteLockId is the id the start answered',
        });
        return;
      }
      const feeTx = feeTxRaw as { signed: true; hash: string } | { signed: false };
      if (operatorAddress === null) {
        // Reached only by a replay of a leg whose owner has since cleared the
        // address; every other case was refused by the eligibility check.
        res.status(409).json({ error: operatorAddressNotSetMessage('abt_eth') });
        return;
      }
      if (feeTx.signed && feeTx.hash.toLowerCase() === body.priceTxHash.toLowerCase()) {
        res.status(400).json({ error: 'priceTxHash and feeTx.hash must not be the same transaction' });
        return;
      }
      const amountUsd = legAmountUsdFromJob(gate.job, leg);
      // A report for the price transfer a half-paid leg already has on
      // record must name the lock that transfer was confirmed against. A
      // report naming a newer lock is refused here, before anything is
      // checked or written, so the record that lets the payment finish stays
      // as it was. A report with a new price hash (the resend after a price
      // transfer failed on the network) is not about that transfer.
      const storedHalfPaid = await abtEthHalfPaidRecordFor(abtEthPaymentRail, gate.job.id, leg);
      if (
        storedHalfPaid !== null &&
        storedHalfPaid.lockId !== null &&
        storedHalfPaid.priceTxHash.toLowerCase() === body.priceTxHash.toLowerCase() &&
        storedHalfPaid.lockId !== body.quoteLockId
      ) {
        res.status(409).json({ error: STARTED_AT_EARLIER_PRICE_MESSAGE });
        return;
      }
      const lockCheck = await checkAbtEthQuoteLock(abtEthLocks, {
        lockId: body.quoteLockId,
        jobId: gate.job.id,
        leg,
        amountUsd,
      });
      if (!lockCheck.ok) {
        // On a half-paid leg that names a lock, "start the payment again"
        // would send the buyer to a start that refuses for the same reason,
        // so a changed price gets the sentence that says what finishes it.
        const onHalfPaidLeg = storedHalfPaid !== null && storedHalfPaid.lockId !== null;
        res.status(409).json({ error: onHalfPaidLeg ? abtEthHalfPaidRefusal(lockCheck.message) : lockCheck.message });
        return;
      }
      const lock = lockCheck.lock;

      let ref: Extract<PaymentRef, { rail: 'abt_eth' }>;
      let confirmation;
      try {
        const processed = await processWalletResponse(abtEthPaymentRail, leg, {
          rail: 'abt_eth',
          jobId: gate.job.id,
          operatorAddress,
          priceTxHash: body.priceTxHash,
          feeTx,
          amountToken: lock.amountToken,
          feeToken: lock.feeToken,
          quoteLockId: lock.id,
        });
        if (processed.rail !== 'abt_eth') throw new Error('the abt_eth rail answered a reference for another rail');
        ref = processed;
        confirmation = await abtEthPaymentRail.confirm(ref);
      } catch (err) {
        console.error(`${label}: rail failed`, err);
        res.status(503).json({ error: 'the abt_eth payment rail is unavailable' });
        return;
      }

      if (!confirmation.confirmed || isIdempotentReplay) {
        res.status(200).json(confirmation);
        return;
      }
      const judgement = await judgeLateAbtEthPayment({
        lock,
        priceRecordedAt: confirmation.priceRecordedAt,
        readPrice: (input) => abtEthPaymentRail.quote(input),
      });
      if (judgement.kind === 'short') {
        // Stored short, with no settlement row: from here the leg waits on
        // the owner (railHeldByShortPayment). A report of this same pair is
        // answered from this row above, never judged again, so a price that
        // recovers later does not settle it.
        await abtEthShorts.record({
          priceTxHash: ref.priceTxHash,
          jobId: gate.job.id,
          leg,
          lockId: lock.id,
          feeTxHash: ref.feeTxHash,
          amountToken: lock.amountToken,
          amountUsd: lock.amountUsd,
          usdPerTokenAtRead: judgement.usdPerToken,
          worthUsd: judgement.worthUsd,
          recordedAt: confirmation.priceRecordedAt === null ? null : new Date(confirmation.priceRecordedAt),
          readAt: new Date(),
        });
        res.status(200).json({
          ...confirmation,
          short: { recordedAt: confirmation.priceRecordedAt, agreedUsd: lock.amountUsd, worthUsd: judgement.worthUsd },
        });
        return;
      }
      await settlementRepo.record({
        jobId: gate.job.id,
        leg,
        rail: 'abt_eth',
        hash: ref.priceTxHash,
        secondaryHash: ref.feeTxHash,
        operatorAddress: ref.operatorAddress,
        feeAddress: ref.feeAddress,
        amountUsd,
        observedAt: new Date(),
      });
      await recordSettlementSystemEvent({ jobId: gate.job.id, leg, rail: 'abt_eth', amountUsd });
      res.status(200).json(confirmation);
    }),
  );

  // R-11 (ENT-7.1): the merge is observed from GitHub's API, never asserted
  // by either party. The route never trusts a client-supplied state - it
  // always asks github directly. A non-merged answer is handled by what it
  // means for the job: an open PR past its deadline becomes stale (R-12,
  // ENT-7.2). A closed, unmerged PR on a legacy stale row becomes
  // closed_unmerged, but on a submitted job it records nothing and answers
  // 409 (B71): a plain close does not end a paid job, the review window
  // keeps running, and only a cited close stops it. Stale is not terminal -
  // a merge observed after the stale marker still completes the job (D3
  // 2026-08-22).
  app.post(
    '/jobs/:jobId/merge',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const jobId = String(req.params.jobId);

      // Either party may ask the platform to look at GitHub (B8); a stranger
      // may not spend the platform's GitHub budget or learn a job's outcome
      // ahead of its parties.
      const gate = await requireSignedParty('POST /jobs/:jobId/merge', jobId, req, res, ['buyer', 'agent']);
      if (gate === null) return;
      const current: Job = gate.job;
      // Captured as a const so the outcome recorder below, an async closure,
      // sees the narrowed non-null row.
      const job = current;

      // FIX-B60D: the load above may itself have completed this job from a
      // merge inside the window (applyLiveLapses). This request asked for
      // that outcome, so it answers 200 with the receipt, not a 409.
      const completedByLoad = completedOnLoad.get(current);
      if (completedByLoad !== undefined) {
        res.status(200).json({ ...jobProjection(current), credential: completedByLoad });
        return;
      }

      // A known status other than submitted or stale is a conflict before
      // github is ever asked, so only submitted, stale and a corrupted
      // (non-enum) status reach the pull request read below. stale falls
      // through on purpose (D3 2026-08-22): a merge after the stale marker
      // still completes, so its PR is still observed. A corrupted status is
      // not in this list either, so it falls through to completeJob's own
      // validator below - the same contract the pull-request route uses for
      // its corrupted-status leg.
      const nonObservationStatuses: readonly JobStatus[] = [
        'draft',
        'proposed',
        'confirmed',
        'completed',
        'closed_unmerged',
        // B8: a withdrawn or declined job has nothing left to observe; before
        // this it fell through to the URL parse and surfaced as a 500.
        'withdrawn',
        'declined',
        // The five P4 statuses never carry
        // a pullRequestUrl either, so without this line each one fell
        // through to the submitted-only parse below and threw -- a caller
        // mistake (asking to merge a job that was never submitted) turning
        // into a 500 platform fault instead of the same honest 409 every
        // other non-observable status already answers. deemed_completed
        // additionally used to spend a real github.getPullRequest call
        // before failing; listing it here stops that call too. FIX-B60D: the
        // load asks GitHub before deeming; a merge inside the window at the
        // attested commit would have completed the job instead.
        'staged',
        'staged_declined',
        'closed_unpaid',
        'expired_unstaged',
        'deemed_completed',
        // SW1-02: a redo was asked on staged work, so no pull request has
        // been opened yet and the row carries no pullRequestUrl; it used to
        // reach the submitted-only parse and answer 500.
        'redo_requested',
        // SW1-03: the buyer's cited close is a final outcome already
        // recorded. The row still carries the pull request's URL, so it
        // used to spend a github read before it was refused.
        'cited_closed',
        // The hire ended paid in full before any pull request opened, so
        // the row carries no pullRequestUrl and there is nothing on GitHub
        // to observe; without this line a merge request reached the
        // submitted-only parse below and threw.
        'paid_undelivered',
      ];
      if (nonObservationStatuses.includes(current.status)) {
        res.status(409).json({ error: new JobTransitionError(current.status, 'merge').message });
        return;
      }

      // The URL parse, GitHub read and attested-commit check are
      // observePullRequest, shared with the deem path (applyLiveLapses).
      const observation = await observePullRequest('POST /jobs/:jobId/merge', current);
      if (observation.kind === 'answer') {
        res.status(observation.status).json(observation.body);
        return;
      }
      if (observation.kind === 'head_moved') {
        res.status(409).json({
          error: 'the pull request head moved off the attested commit',
          attested: observation.attested,
          head: observation.head,
        });
        return;
      }
      const summary = observation.summary;

      // R-12 (ENT-7.2): record the observed outcome, with the same storage
      // legs as the merged answer below - transition conflict 409, vanished
      // row 404, dead storage 503 with the cause in the log.
      const recordOutcome = async (record: (job: Job) => Job): Promise<void> => {
        let next: Job;
        try {
          next = record(job);
        } catch (err) {
          // Covers a row whose status moved between the read and here, or a
          // terminal row that reached this point (withdrawn is not in the
          // guard above): the outcome is refused, and the row is left as
          // found.
          if (err instanceof JobTransitionError) {
            res.status(409).json({ error: err.message });
            return;
          }
          throw err;
        }
        try {
          const row = await jobRepo.update(next);
          if (row === null) {
            // The row vanished between the read and the write.
            res.status(404).json({ error: 'not found' });
            return;
          }
          res.status(200).json(jobProjection(row));
        } catch (err) {
          console.error('POST /jobs/:jobId/merge: storage failed', err);
          res.status(503).json({ error: 'storage unavailable' });
        }
      };

      if (summary.state === 'open') {
        if (job.status === 'stale') {
          // Recording stale twice is not a no-op: the outcome is already on
          // record, so a second open observation is a conflict, not a
          // rewrite.
          res.status(409).json({ error: 'the job is already recorded stale and the pull request is still open' });
          return;
        }
        // Lazy detection: this route is the only observation point this
        // codebase has, so the deadline is checked here rather than by a
        // scheduler. Pre-R-12 rows carry no deadline and keep the 409.
        if (job.deadline !== null && Date.now() >= job.deadline.getTime()) {
          await recordOutcome(recordStale);
        } else {
          res.status(409).json({ error: 'pull request is open; it has not merged yet' });
        }
        return;
      }
      if (summary.state === 'closed') {
        // B71: a plain close does not end a paid job. A submitted job records
        // nothing and stays on the deem clock; only a legacy stale row
        // (R-31) still records closed_unmerged.
        if (job.status === 'submitted') {
          res.status(409).json({
            error:
              'the pull request is closed but not merged; the hire stays open until the review window ends, unless the buyer merges it or closes the hire with a cited reason',
          });
          return;
        }
        await recordOutcome(recordClosedUnmerged);
        return;
      }

      // The merged branch is completeMergedPullRequest, shared with the deem
      // path; a merged answer with no merge commit sha throws there and
      // reaches the terminal handler as a 500, as before.
      const completion = await completeMergedPullRequest('POST /jobs/:jobId/merge', current, observation);
      if (completion.kind === 'answer') {
        res.status(completion.status).json(completion.body);
        return;
      }
      res.status(200).json({ ...jobProjection(completion.row), credential: completion.credential });
    }),
  );

  // P6 (design record row 4): the buyer's cited close after paying. Party
  // rule: buyer-only (recordCitedClose's own header comment -- the author
  // is copied from the job, never taken as input). The body names the
  // confirmed criterion and the one sentence of reasoning; recordCitedClose
  // validates both, mapping to 400 through the same applyAndPersist leg
  // every other lifecycle route shares.
  //
  // P6: a payment gate IS required here, and asking it
  // is not optional the way the original comment on this route assumed.
  // "The balance already settled at pull-request time" is a fact about the
  // PAST, not the live state this route must check: the settlement gate is
  // an asynchronous external question (design record row 4: "available
  // only after the buyer has paid the remainder"), and its answer can
  // differ between the pull-request instant and this one -- the same
  // reason applyLiveLapses re-asks it on every read of a staged job rather
  // than trusting what confirm once observed. Asking again here, through
  // the same applyAndPersist paymentGate leg confirm already uses, closes
  // that gap: 402 when unsettled (naming the remainder still owed), 503 on
  // a gate failure, exactly like every other settlement-gated route in
  // this file.
  app.post(
    '/jobs/:jobId/cited-close',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const label = 'POST /jobs/:jobId/cited-close';
      const gate = await requireSignedParty(label, String(req.params.jobId), req, res, ['buyer']);
      if (gate === null) return;
      const body = (req.body ?? {}) as { criterionIndex?: unknown; reasonText?: unknown };
      if (typeof body.criterionIndex !== 'number' || !Number.isInteger(body.criterionIndex)) {
        res.status(400).json({ error: 'body must be { criterionIndex: number, reasonText: string }: the confirmed criterion and reasoning this close cites' });
        return;
      }
      if (typeof body.reasonText !== 'string') {
        res.status(400).json({ error: 'body must be { criterionIndex: number, reasonText: string }: the confirmed criterion and reasoning this close cites' });
        return;
      }
      const input = { criterionIndex: body.criterionIndex, reasonText: body.reasonText };
      await applyAndPersist(
        label,
        res,
        gate.job,
        (job) => recordCitedClose(job, input, new Date()),
        {
          settled: (jobId) => remainderSettled(settlementGate, jobId),
          unsettledBody: (updated) => ({
            error: 'the remainder has not settled; this job cannot be cited-closed until it does',
            remainderUsd: updated.priceUsd === null ? null : remainderUsd(updated.priceUsd, updated.depositPercent),
          }),
        },
      );
    }),
  );

  // R-22 (ENT-10, issue 29): the review write. Replaces the 501 stub. Every
  // refusal rule the card names lives here or in the domain functions it
  // calls, never restated twice:
  //   1. Eligibility is proven, not claimed (assertReviewEligible reads the
  //      job record: completed status, exact buyer, exact agent).
  //   2. Never blended with evidence (R-17's tier machinery never imports
  //      this route or src/domain/review.ts; see the structural no-blend
  //      test in tests/domain/agent-work-record.test.ts's sibling for
  //      reviews).
  //   3. No numeric field anywhere (buildReview's return type has nowhere
  //      to put one).
  //   4. One review per completed hire (ReviewRepository.save's unique
  //      constraint, mapped to 409 below).
  //   5. Caller identity comes from a verified R-34 signature or a live
  //      session (P8a, invariant 8), never a body field:
  //      resolveActingParty(req, repo, identityAdapter) is the only source of authorDid.
  app.post(
    '/jobs/:jobId/reviews',
    didSignature,
    populateSessionSubject,
    forwarded(async (req: Request, res: Response) => {
      const jobId = String(req.params.jobId);
      const body = (req.body ?? {}) as { agentDid?: unknown; text?: unknown };
      const agentDid = body.agentDid;

      if (typeof agentDid !== 'string' || agentDid.length === 0 || !reviewTextWellFormed(body.text)) {
        res.status(400).json({
          error: 'body must be { agentDid, text }; agentDid a non-empty string, text a non-empty string',
        });
        return;
      }
      const text = body.text as string;

      // Rule 5: identity comes from a verified signature or a live
      // session (P8a, invariant 8), never a body field. Neither proof at
      // all is refused before the job is even loaded, the same way
      // runPartyExchange refuses an unauthenticated exchange call. P8d:
      // a live session can now fail closed with a storage/provisioning
      // fault (no account existed yet and provisioning it failed), mapped
      // to 503 here rather than falling through to the terminal 500
      // handler, the same convention every other resolveActingParty call
      // site in this file already follows.
      let authorDid: string | null;
      try {
        authorDid = await resolveActingParty(req, repo, identityAdapter);
      } catch (err) {
        console.error('POST /jobs/:jobId/reviews: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (authorDid === null) {
        res.status(401).json({
          error: sessionOrSignatureRequiredMessage("this job's buyer DID"),
        });
        return;
      }

      let job: Job | null;
      try {
        job = await jobRepo.findById(jobId);
      } catch (err) {
        console.error('POST /jobs/:jobId/reviews: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      if (job === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      // Rule 1: the check reads the job record; it never trusts the
      // request. claimedIdentity.buyerDid is the PROVEN signerDid, not a
      // body field, and claimedIdentity.agentDid is what the caller named,
      // checked against the job's own agentDid rather than reconciled to
      // it.
      try {
        assertReviewEligible(job, { buyerDid: authorDid, agentDid });
      } catch (err) {
        if (err instanceof JobNotReviewableError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof ReviewerNotBuyerError) {
          res.status(403).json({ error: err.message });
          return;
        }
        if (err instanceof ReviewAgentMismatchError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }

      const review = buildReview(job, { authorDid, text }, new Date());
      try {
        await reviewRepo.save(review);
      } catch (err) {
        if (err instanceof ReviewAlreadyExistsError) {
          res.status(409).json({ error: err.message });
          return;
        }
        console.error('POST /jobs/:jobId/reviews: storage failed', err);
        res.status(503).json({ error: 'storage unavailable' });
        return;
      }
      res.status(201).json(reviewProjection(review));
    }),
  );

  // Unmatched paths, after every API route has had its chance. A browser
  // gets the 404 page; every other caller gets the same JSON body the API
  // uses for a missing record, because answering a JSON client with a web
  // page would be a worse lie than the 404 itself.
  // B69: a broken percent-escape in the address is handled just before it,
  // so a browser following a broken link is passed on to this same 404 page.
  app.use(brokenAddressErrorHandler);
  web.mountFallback(app);

  // Terminal error layer: a fault that reached here was not mapped by a
  // route's own catch, nor as a request the platform could not read (the
  // parser handler and the broken-address handler above answer those as the
  // caller's mistake), so it is our problem, not the caller's. Same terms as
  // every storage failure - cause in the log, not the body, so nothing the
  // process said internally leaks out.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('unhandled request failure', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
