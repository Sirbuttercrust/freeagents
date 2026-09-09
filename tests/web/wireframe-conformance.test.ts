// Wireframe conformance.
//
// Written 2026-09-08 after review found that much of the designed work for the
// agent profile and other pages had never reached the built site.
//
// The wireframes in spec/wireframe/ passed the design gate and are the
// binding source for every page under src/web/pages/. The pages built on
// 2026-08-31 were briefed on the data contract instead, and rendered fields
// where the wireframe had a designed page: no tab bar, no timeline, no
// discipline filters, no "What it works on". Nothing measured the gap, so it
// went out. This file is the measurement, and it is deliberately blunt: for
// every built page with a wireframe, every heading and every control label
// the wireframe carries must be present in the built page, unless the
// departure is listed below with a reason a reader can weigh.
//
// Text is compared after stripping tags, scripts, styles, comments, and the
// wireframe's own design notes (div.note), which explain the design and are
// not part of the page. A control is a <button> or an <a> with visible text.
// Sample data in the wireframe (an agent name, a repo#PR) is filtered by the
// SAMPLE list: those are values, not design.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const builtDir = join(here, '../../src/web/pages');
const wireDir = join(here, '../../spec/wireframe');

// Built page -> wireframe file, where the names differ. The landing page was
// built from the design seat's landing-swarm.html (kept outside the repo,
// see PLAN.md); spec/wireframe/index.html is the sitemap page, so landing is
// not compared here.
const WIREFRAME_FOR: Record<string, string | null> = {
  landing: null,
  'auth-callback-error': null,
  'auth-callback-success': null,
};

// Justified departures, per page, each with the reason. A heading or control
// listed here may be absent from the built page. Adding a line here is a
// design decision and belongs in the PR body.
const ALLOWED_ABSENT: Record<string, Record<string, string>> = {
  agent: {
    'The same profile, brand new': 'the cold-start variant is the same page with zero data, not a second section (R-18)',
    // The wireframe's tab-bar chip labels bake in one sample agent's own
    // counts (axiom-ui: 45/12/31/2). The built page's chips carry the SAME
    // labels with LIVE counts computed from GET /agents/:did at render time
    // (DESIGN.md invariant 5, "no invented numbers"), so the literal sample
    // digits can never appear in this page's static markup -- baking them in
    // would ship a fabricated number under a real agent's name. The chip
    // controls themselves (the "All", "Hires", "Prior", "Claims" buttons and
    // their live-count behaviour) are asserted in
    // tests/web/agent-cold-start.test.ts and tests/web/agent-work-history-tabs.test.ts.
    'All 45': 'sample count from the wireframe\u2019s one example agent; the built chip carries a live count instead (see reason on "All 45" above)',
    'Hires 12': 'same reason as "All 45": a live count, never the wireframe\u2019s sample digit',
    'Prior 31': 'same reason as "All 45": a live count, never the wireframe\u2019s sample digit',
    'Claims 2': 'same reason as "All 45": a live count, never the wireframe\u2019s sample digit',
    // Proof round 2, D1 (conformance-satisfied-by-dead-markup): these two
    // prior-work controls used to sit inside <template> elements that
    // nothing cloned, so removed conformance-agent-carries-every-control's
    // pass by neither a page change nor an honest absence. R-17's three
    // tiers share ONE item shape (VerifiedHireItem, agent-work-record.ts)
    // that carries no commit count or gist URL, because no prior-work item
    // has ever reached this route (ENT-11 not wired). Both controls are
    // removed until that type gains gistUrl/commitCount/lastCheckedAt
    // (handoff gap, this card).
    'gist proof': 'ENT-11 not wired: no prior-work item reaches this route yet, so there is no row for this control to sit on (see the removed tmpl-verify-prior in agent.html)',
    'Check the ownership proof': 'same reason as "gist proof": ENT-11 not wired, no prior-work row exists for this affordance yet',
  },
  browse: {
    // The brief's one authorised departure: nothing in the data carries a
    // line-count. CredentialEvidence (src/domain/agent-work-record.ts)
    // holds repository, pullRequest, mergedAt, mergeCommit, buyerDid,
    // repositoryPublic, additions, deletions, filesChanged -- no bucketed
    // "typical change size" a checkbox could filter on. These three are
    // checkbox <label> text, never matched by controls() (button/a only),
    // so this entry documents the omission rather than being load-bearing
    // for the test itself.
    'Under 200 lines': 'no diff-size bucket exists on CredentialEvidence (agent-work-record.ts); rendering the control would ship a filter that cannot filter (brief: "Typical change size" is the one authorised departure)',
    '200 to 1000': 'same reason as "Under 200 lines": no diff-size bucket in the data',
    'Over 1000': 'same reason as "Under 200 lines": no diff-size bucket in the data',
    // Wireframe sample values (SAMPLE's regex does not happen to cover
    // these two), never baked into the shipped page as fabricated agent
    // facts: pellucid and gridwright/tessellate/axiom-ui are the
    // wireframe's example agent names, rendered live from GET /agents
    // instead. A real agent named exactly "pellucid" would still render
    // fine; this entry is about the wireframe's SAMPLE row, not a ban.
    'pellucid': "wireframe sample data (an example agent's name); this page renders agent names live from GET /agents, never a hardcoded sample",
    'github.com/quietloop': 'wireframe sample data (an example GitHub proof link); the built proof line renders real data per card (DATA-CONTRACT section 4), never this sample URL',
    // The two zero-state relaxation buttons ship as real controls with
    // real re-queried counts (browse.js: relaxationButton); only the
    // wireframe's SAMPLE digits ("3 results", "12 results") can never
    // appear verbatim, because they are not this platform's real data.
    'Drop "verified hires" \u00b7 3 results': 'the control ships (browse.js renderZeroState); the sample count "3 results" is wireframe sample data, replaced with a real re-queried count',
    'Drop "Rust" \u00b7 12 results': 'the control ships (browse.js renderZeroState); the sample count "12 results" is wireframe sample data, replaced with a real re-queried count',
  },
  operator: {},
  myjobs: {
    // The five bucket chips ship, wired to real live counts, but the
    // labels with their digits are appended at render time by myjobs.js
    // (chip.textContent = BUCKET_LABELS[bucket] + " " + counts[bucket],
    // myjobs.js:93-95), so the wireframe's sample digits (6, 1, 2, 3, 1)
    // can never appear in this page's static markup: baking them in would
    // ship a fabricated number about a person's own job list. The same
    // call the agent page already makes for "All 45", "Hires 12", "Prior
    // 31" and "Claims 2" above. tests/web/myjobs.test.ts:207 pins the
    // chip behaviour: it reads the digits back off the four bucket chips
    // and asserts they sum to the All count.
    'All 6': 'a live count appended at render time (myjobs.js:93-95: chip.textContent = BUCKET_LABELS[bucket] + " " + counts[bucket]); the wireframe\u2019s sample digit can never appear in static markup, pinned by tests/web/myjobs.test.ts:207',
    'Waiting on you 1': 'same reason as "All 6": a live count, never the wireframe\u2019s sample digit (myjobs.js:93-95, tests/web/myjobs.test.ts:207)',
    'In progress 2': 'same reason as "All 6": a live count, never the wireframe\u2019s sample digit (myjobs.js:93-95, tests/web/myjobs.test.ts:207)',
    'Shipped 3': 'same reason as "All 6": a live count, never the wireframe\u2019s sample digit (myjobs.js:93-95, tests/web/myjobs.test.ts:207)',
    'Didn&#8217;t ship 1': 'same reason as "All 6": a live count, never the wireframe\u2019s sample digit (myjobs.js:93-95, tests/web/myjobs.test.ts:207)',
  },
  job: {
    // The wireframe draws the closed-without-shipping state as a second
    // job on the same page. The built page shows ONE hire, and it already
    // has that state: close-section and the stopped track row (the same
    // call the agent page already made for "The same profile, brand new").
    'If the job does not ship': 'the wireframe draws this as a second example job on the same page; the built page shows one hire and already has this state (close-section, the stopped track row)',
    // The wireframe's two sample job identifiers. The heading renders the
    // real job id from the projection, pinned by a dedicated test, never
    // one of these baked-in sample ids.
    'Job fa-7k29': "wireframe sample data (the shipped example's job id); the built heading renders the job's real id from the projection",
    'Job ac-3m81': "wireframe sample data (the second example's job id); this page shows one hire, so this id never ships",
    // Both sample labels belong to the wireframe's second example job,
    // which does not ship as its own section (see the entry above). The
    // real page's identity strip renders the operator's own shortened DID,
    // and its one back control is "Back to profile", which does ship.
    'a different operator': 'wireframe sample data from the second example job, which does not ship as its own section; the real identity strip renders the operator\u2019s own shortened DID',
    "See tessellate's profile": 'wireframe sample data from the second example job, which does not ship as its own section',
  },
  dashboard: {},
  how: {
    // Same situation as verify's own entry below: the built footer emits
    // GitHub and Licence at serve time from sourceLinks()
    // (src/web/static.ts:200-216), pinned by tests/web/static.test.ts:394,
    // 409. This instrument reads the file on disk and can only see the
    // <!--SOURCE_LINKS--> placeholder, never the anchors it resolves to.
    'Licence': 'the built footer emits GitHub and Licence at serve time from sourceLinks() (src/web/static.ts:200-216, pinned by tests/web/static.test.ts:394,409); this instrument reads the file on disk and can only see the <!--SOURCE_LINKS--> placeholder',
  },
  notfound: {
    // Same mechanism as how's entry above, on both of the wireframe's
    // static footer anchors. The built label says "Source code" where the
    // wireframe says "GitHub": the built label names the thing (the
    // repository) rather than the vendor, the same naming rule this repo
    // already applies to its adapters, carried into footer copy.
    'GitHub': 'the built footer emits this link at serve time from sourceLinks() (src/web/static.ts:200-216, pinned by tests/web/static.test.ts:394,409) under the label "Source code", which names the thing rather than the vendor (this repo\u2019s adapter-naming rule applied to copy); this instrument reads the file on disk and can only see the <!--SOURCE_LINKS--> placeholder',
    'Licence': 'the built footer emits Licence at serve time from sourceLinks() (src/web/static.ts:200-216, pinned by tests/web/static.test.ts:394,409); this instrument reads the file on disk and can only see the <!--SOURCE_LINKS--> placeholder',
  },
  conduct: {
    // The wireframe's cold-start block (line 203, "A new account") is the
    // design seat showing the same eight rows with zeros in them, the same
    // shape as agent.html's "The same profile, brand new" (already excused
    // above under R-18). tests/web/conduct.test.ts's "the cold start"
    // describe block proves the built page renders through the identical
    // selectors with real zeros, not a second section.
    'A new account': 'the cold-start variant is the same eight rows rendered with zeros through the same selectors, not a second section (tests/web/conduct.test.ts, "the cold start" describe block; setCount coercion at conduct.js:124-127)',
    // conduct.js:37-40 names this a deliberate departure and app.ts:2576-
    // 2590 confirms it: GET /buyers/:githubLogin/conduct's two response
    // shapes (keyed: false and keyed: true) carry githubLogin, counts and
    // operatorCounts, never a DID. "Their agents" points at operator.html,
    // addressed by DID, so this route holds nothing to build that href
    // from. tests/web/conduct.test.ts's inert-declared-control mutation
    // proof (line 446) asserts no such anchor and no /accounts/ href ships.
    'Their agents': 'GET /buyers/:githubLogin/conduct (src/api/app.ts:2576-2590) carries githubLogin, counts and operatorCounts, never a DID; the button\u2019s destination (operator.html, addressed by DID) cannot be built from this response, so it is dropped rather than shipped inert (conduct.js:37-40, tests/web/conduct.test.ts:446-463)',
  },
  deposit: {
    // The wireframe's own comment (deposit.html:238-240) says the drawn QR
    // "encodes nothing", because a wireframe QR either encodes nothing (a
    // dead control) or invents a live payment request. The built sheet
    // solves the same problem with a mechanism instead of a drawing: a
    // one-time payment URL in a readonly input with a Copy button, headed
    // "Open this in your DID Wallet" (src/web/pages/deposit.html:158).
    // Telling someone to scan when nothing on screen can be scanned is the
    // inert-declared-control defect wearing copy instead of markup; the
    // heading follows the mechanism the page actually ships.
    'Scan with your DID Wallet': 'the wireframe\u2019s own comment (deposit.html:238-240) says its drawn QR "encodes nothing"; the built sheet ships a real mechanism instead, a one-time payment URL in a readonly input with a Copy button headed "Open this in your DID Wallet" (src/web/pages/deposit.html:158), because a heading promising a scan with nothing to scan is the inert-declared-control defect in copy',
  },
  credential: {
    // The wireframe draws the closed-without-shipping state as a second
    // worked example on this page. It does not ship as a section here,
    // and the state is not missing from the product: a receipt exists
    // only for work that shipped, so this address has nothing to render,
    // and credential.js's failLoad (47-60) already holds that exact state
    // with the wireframe's own reasoning ("A receipt is only issued when
    // work actually ships"), hiding the facts and the action row rather
    // than painting dead controls. The job's own record of a non-merge
    // lives on the job page (STATE_SENTENCES.closed_unmerged, job.js:43).
    // Same call W4 already made and Proof already passed for "If the job
    // does not ship".
    'Job did not ship': 'the wireframe draws this as a second worked example on the same page; a receipt exists only for shipped work, so this address renders failLoad (credential.js:47-60) and the non-merge fact lives on the job page (job.js STATE_SENTENCES.closed_unmerged)',
    // Wireframe sample data. SAMPLE's own regex covers vercel/commerce#\d+,
    // but clean() never unescapes &#35;, so the escaped form in the
    // wireframe's markup slips past it. The built page renders the real
    // repository from the signed document (credential.js:89-100).
    // clean() and SAMPLE are untouched here: loosening the instrument
    // mid phase would move the goalposts under four merged cards.
    'vercel/commerce&#35;4471': "wireframe sample data (SAMPLE covers the unescaped form vercel/commerce#4471, not this HTML-escaped one); the built page renders the real repository from the signed document (credential.js:89-100)",
  },
  incoming: {
    // The three row actions ship (W7b), but each is built by
    // incoming.js's offerRow at render time, keyed off the offer's own
    // waitingOn value (FOOT_ACTION, incoming.js:69-73). This instrument
    // reads the file on disk and can only see the static #rows container,
    // never what renderRows appends into it, the same limitation the
    // agent page's live-count chips and myagents' work-offered line
    // already carry (this file's own header comment, line 16-18).
    'Draft the agreement': 'built by incoming.js\u2019s offerRow at render time, keyed off waitingOn (FOOT_ACTION, incoming.js:69-73); this instrument reads the file on disk and never sees what renderRows appends into #rows',
    'See what you sent': 'same reason as "Draft the agreement": rendered live by offerRow, keyed off waitingOn (FOOT_ACTION, incoming.js:69-73)',
    'Review the change': 'same reason as "Draft the agreement": rendered live by offerRow, keyed off waitingOn (FOOT_ACTION, incoming.js:69-73)',
  },
  myagents: {
    // Two of the wireframe's four example agent names (myagents.html:109,
    // 122). SAMPLE covers pixelforge and driftcheck and not these two.
    // The built page renders every agent name live from
    // GET /accounts/:did/agents (myagents.js:144-147), never a hardcoded
    // sample, the same reason browse's own "pellucid" entry above states.
    'seamline': "wireframe sample data (one of the wireframe's four example agent names, myagents.html:109); this page renders agent names live from GET /accounts/:did/agents, never a hardcoded sample",
    'hatchmark': "wireframe sample data (one of the wireframe's four example agent names, myagents.html:122); this page renders agent names live from GET /accounts/:did/agents, never a hardcoded sample",
    // The wireframe's link points at provegithub.html, which is not
    // built and has no route in src/web/static.ts: one of the five
    // wireframed operator-onboarding screens PLAN 2026-09-08 records as
    // never given a card (listagent.html, provegithub.html,
    // agentsettings.html, priorwork.html, claim.html), the same reason
    // signin's own entries cite. The built page renders the attention
    // line as plain text with no anchor (myagents.js:251), and
    // tests/web/myagents.test.ts:361 asserts the absence of the link.
    'confirm it': 'provegithub.html is not built and /provegithub is not mounted (the recorded operator-onboarding gap, PLAN 2026-09-08); the built attention line renders as plain text with no anchor (myagents.js:251), asserted by tests/web/myagents.test.ts:361',
    // The work-offered attention line ships (W7b), built inline in
    // agentRow at render time from a second read of
    // GET /accounts/:did/incoming, grouped by agentDid and counted
    // (myagents.js:82-95, myagents.js:170-178). This instrument reads
    // the file on disk and can only see the static #rows container,
    // never what renderRows appends into it live, the same limitation
    // the row names above and the agent page's live-count chips already
    // carry.
    '1 job waiting on a reply': 'built inline in agentRow at render time from GET /accounts/:did/incoming, grouped by agentDid and counted (myagents.js:82-95, myagents.js:170-178); this instrument reads the file on disk and never sees what renderRows appends into #rows live',
  },
  signin: {
    // All four excuses below share one root, already on the record: PLAN
    // 2026-09-08 (the P8 close-out) names five wireframed screens that
    // were never given a card, all of them the operator's onboarding
    // path (listagent.html, provegithub.html, agentsettings.html,
    // priorwork.html, claim.html). None is built, none has a route in
    // src/web/static.ts. That is a recorded launch-scope question for
    // the operator, not a defect for this card.
    //
    // MISSION invariant 8: "Sign-in is GitHub OAuth or a passkey." The
    // auth surface is exactly /auth/github/start, /auth/github/callback,
    // /auth/passkey/register, /auth/passkey/verify, /auth/signout
    // (src/api/app.ts:1149-1257). There is no wallet sign-in route, so
    // the wireframe's third button has no destination. Invariant 7 asks
    // for the rail to be shown and explained, never required, and the
    // built page does exactly that as method 03 ("Bring your own
    // wallet", src/web/pages/signin.html). A button that cannot sign
    // anyone in is worse than honest prose.
    'Sign in with a DID Wallet': 'no wallet sign-in route exists (the auth surface is exactly GitHub OAuth, passkey, and signout, src/api/app.ts:1149-1257); the built page shows and explains the wallet rail as method 03 instead of a button with no destination (invariant 7 asks for the rail to be visible, never required)',
    // The wireframe's dim link beside the wallet button points at "#".
    // Nothing explains the wallet anywhere a link could land (how.html
    // has no wallet section). The explanation ships inline in method 03,
    // which is what the link was for.
    'What is this': 'nothing to link to (how.html has no wallet section); the explanation ships inline in method 03 on this page instead of behind a link with no destination',
    // The wireframe's whole section sends a person to provegithub.html
    // and promises "One click, whenever you want". provegithub.html is
    // not built and /provegithub is not mounted. The only route behind
    // it is POST /agents/:agentDid/account-proof (src/api/app.ts:2083),
    // which nothing in src/web/ calls. Shipping the heading and its copy
    // would advertise a one-click path that does not exist.
    'Proving your GitHub account': 'provegithub.html is not built and /provegithub is not mounted (part of the recorded operator-onboarding gap, PLAN 2026-09-08); shipping this heading would advertise a page that does not exist',
    'See how the proof works': 'same reason as "Proving your GitHub account": the page this control would link to is not built',
    // The wireframe's "After you sign in" section lists three rows: hire
    // (true), list an agent (true), and "Prove you control your GitHub
    // account, one click, whenever you want" (not true: S4/S5 above).
    // Shipping the row list verbatim would state something that is not
    // true through this site today. The first row is already answered,
    // honestly, by #account-notice and "How signing in works".
    'After you sign in': 'its third row promises the one-click GitHub proof (see "Proving your GitHub account" above), which is not true through this site today; the first row is already answered honestly by #account-notice and "How signing in works"',
  },
  settings: {
    // The wireframe's nav button (settings.html:45) points at
    // dashboard.html under the local label "Account". nav.js renders that
    // same destination on every page under the label "Dashboard"
    // (nav.js:100-105), which is in this instrument's own SHARED_NAV set;
    // this entry reaches the shared-nav mechanism under this one
    // wireframe's local label instead of "Dashboard".
    'Account': 'the shared-nav mechanism (nav.js:100-105) renders this destination on every page under the label "Dashboard", already excused by SHARED_NAV; this wireframe names the same button "Account" locally',
    // href="#" in the wireframe itself (settings.html:74), on the sign-in
    // method row. The auth surface is exactly /auth/github/start,
    // /auth/github/callback, /auth/passkey/register, /auth/passkey/verify
    // and /auth/signout (src/api/app.ts:1149-1257); there is no route
    // that manages a connected sign-in method, and gap G6 (the
    // wireframe's own closing note, settings.html:186-192) is why.
    'Manage': 'href="#" in the wireframe itself (settings.html:74); the auth surface is exactly GitHub OAuth, passkey and signout (src/api/app.ts:1149-1257), no route manages a connected sign-in method, and gap G6 (settings.html:186-192, the wireframe\u2019s own closing note) is why',
    // settings.html:113 points at keys.html, a wireframe with no built
    // page and no route. Account (src/domain/account.ts:13-38) carries
    // did, githubLogin, passkeySubject, createdAt and the two payout
    // addresses, and no signing-key column, which is why the wireframe's
    // own ruling 6 (settings.html's built counterpart, settings.js:19-20)
    // already drops the signing-key row.
    'Manage keys': 'keys.html has no built page and no route; Account (src/domain/account.ts:13-38) carries no signing-key column, which is why ruling 6 (settings.js:19-20) already drops the signing-key row this button sits on',
    // The whole closing-your-account section: a launch-scope finding, not
    // a page bug (see the handoff). There is no account-closure route
    // (src/api/app.ts mounts POST /accounts, GET /accounts/me, GET
    // /accounts/:did, PATCH /accounts/:did/operator-address and four read
    // routes, and no DELETE), and Agent (src/domain/agent.ts:53-74)
    // carries no listed/unlisted state for the alternative action to set.
    // Shipping the section would put three inert controls under a
    // heading promising an irreversible act the product cannot perform,
    // which is worse than its absence. Gap G6 (settings.html:186-192, the
    // wireframe's own closing note) is the same filed, unbuilt-entity gap
    // "Manage" cites above.
    'Closing your account': 'no account-closure route exists (src/api/app.ts has no DELETE) and Agent (src/domain/agent.ts:53-74) carries no listed/unlisted state; shipping the section would put inert controls under a heading promising an act the product cannot perform (gap G6, settings.html:186-192)',
    'Unlist agents instead': 'same reason as "Closing your account": no listed/unlisted state on Agent (src/domain/agent.ts:53-74) for this control to set',
    'Close my account': 'same reason as "Closing your account": no account-closure route exists (src/api/app.ts has no DELETE)',
  },
  verify: {
    // The wireframe's footer carries GitHub and Licence as static
    // anchors. The built footer emits both at SERVE time from
    // sourceLinks() (src/web/static.ts:200-216), pinned by
    // tests/web/static.test.ts:394 and :409, so the control ships and
    // this instrument, which reads the file on disk, can only ever see
    // the <!--SOURCE_LINKS--> placeholder. A hardcoded licence link here
    // would ship a second, drifting copy of a link the deployment
    // already emits from its own environment.
    'Licence': 'the built footer emits GitHub and Licence at serve time from sourceLinks() (src/web/static.ts:200-216, pinned by tests/web/static.test.ts:394,409); this instrument reads the file on disk and can only see the <!--SOURCE_LINKS--> placeholder',
    // The built disclosure is "Show the identity check" and shows the
    // agent's identity and the key that signed the merge commit, both
    // from the receipt. It does not show a DID document, because
    // nothing serves one: there is no DID document route in
    // src/api/app.ts and none may be added here, since a document this
    // site served would be a check that depends on us, which is the one
    // thing this page exists not to do. DESIGN 4.2 requires the label to
    // name what is behind it, so the label stays honest to its panel.
    'Show the identity document': 'no DID document route exists in src/api/app.ts and none may be added (a document this site served would be a check depending on us); the built disclosure "Show the identity check" names what is actually behind it (DESIGN 4.2), the agent\u2019s identity and the merge-commit signer from the receipt',
  },
};

// Sample values the wireframe uses to look real. Not design; never required.
// Anything carrying a dollar figure or a wireframe-only "Simulate" control is
// a value or a demo affordance, not a control the product ships.
const SAMPLE = /^(axiom-ui|gridwright|stylewright|a11y-sweep|northsound(\.dev)?|northline(\.dev)?|@northsound|pixelforge|driftcheck|tessellate|brightloop\/api|vercel\/commerce#\d+|acme\/[\w-]+#?\d*|northline\/design-tokens ?#?\d*|tailwindlabs\/headlessui|did:abt:[\w…]+|fa-[\w]+|job [0-9a-f]{6}|\d+ (Aug|Jul|Jan)|[A-Z][a-z]{2} \d{4}|Jan to Jul|Simulate:|.*\$\d)/;

// The signed-in navigation (My jobs, My agents, Dashboard, Settings, Sign
// out) is rendered by src/web/public/js/pages/nav.js into #nav-signed-in on
// every page, so the wireframe's static nav links are satisfied by the shared
// script rather than by each page's HTML. Asserted once, below, against nav.js.
const SHARED_NAV = new Set(['My jobs', 'My agents', 'Dashboard', 'Settings', 'Sign out', 'Sign in', 'Browse', 'List an agent', 'FreeAgents']);

function strip(htmlText: string): string {
  return htmlText
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div class="note"[\s\S]*?<\/div>\s*<\/div>/g, '')
    .replace(/<div class="note"[\s\S]*?<\/div>/g, '');
}

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&rarr;|→/g, '').replace(/\s+/g, ' ').trim();
}

function headings(htmlText: string): string[] {
  return [...strip(htmlText).matchAll(/<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => clean(m[2] ?? '')).filter((h) => h.length > 0);
}

function controls(htmlText: string): string[] {
  return [...strip(htmlText).matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/g)]
    .map((m) => clean(m[1] ?? ''))
    .filter((c) => c.length > 1 && c.length < 60 && !SAMPLE.test(c) && !SHARED_NAV.has(c));
}

function visibleText(htmlText: string): string {
  return clean(strip(htmlText));
}

const builtPages = readdirSync(builtDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.slice(0, -5))
  .filter((name) => WIREFRAME_FOR[name] !== null);

describe('the shared navigation carries the wireframe nav', () => {
  it('nav.js renders every signed-in link the wireframes draw', () => {
    const nav = readFileSync(join(here, '../../src/web/public/js/pages/nav.js'), 'utf8');
    const missing = ['My jobs', 'My agents', 'Dashboard', 'Settings', 'Sign out'].filter((l) => !nav.includes(l));
    expect(missing, 'signed-in nav links absent from nav.js').toEqual([]);
  });
});

describe('every built page carries its wireframe', () => {
  it('found pages to compare', () => {
    expect(builtPages.length).toBeGreaterThan(10);
  });

  it.each(builtPages)('%s has a wireframe', (name) => {
    const wire = join(wireDir, `${WIREFRAME_FOR[name] ?? name}.html`);
    expect(existsSync(wire), `no wireframe for ${name}; add it to spec/wireframe or list it in WIREFRAME_FOR as null with a reason`).toBe(true);
  });

  it.each(builtPages)('%s carries every wireframe heading', (name) => {
    const wire = readFileSync(join(wireDir, `${WIREFRAME_FOR[name] ?? name}.html`), 'utf8');
    const built = visibleText(readFileSync(join(builtDir, `${name}.html`), 'utf8'));
    const allowed = ALLOWED_ABSENT[name] ?? {};
    const missing = headings(wire).filter((h) => !SAMPLE.test(h) && !built.includes(h) && !(h in allowed));
    expect(missing, `${name}: wireframe headings absent from the built page`).toEqual([]);
  });

  it.each(builtPages)('%s carries every wireframe control', (name) => {
    const wire = readFileSync(join(wireDir, `${WIREFRAME_FOR[name] ?? name}.html`), 'utf8');
    const built = visibleText(readFileSync(join(builtDir, `${name}.html`), 'utf8'));
    const allowed = ALLOWED_ABSENT[name] ?? {};
    const missing = [...new Set(controls(wire))].filter((c) => !built.includes(c) && !(c in allowed));
    expect(missing, `${name}: wireframe controls absent from the built page`).toEqual([]);
  });
});
