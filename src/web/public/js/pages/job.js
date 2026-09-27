/* P8f job, rebuilt from spec/wireframe/job.html (W4): read one hire and
   render it. Rebuilt onto the polished visual system by W-job.

   ONE PUBLIC ROUTE for the record itself, no session: GET /jobs/:jobId,
   src/api/app.ts's jobProjection. THREE OUTCOMES, as api.js's get()
   distinguishes them: the record, absent (404), unreachable. Never
   rendered as an empty record.

   ONE SECONDARY READ: GET /agents/:agentDid, for the identity strip's
   name and operator link (agent.js's renderAgent is the working precedent for the
   same read). It never fires when the job carries no agentDid, and it
   never blocks or delays the primary render: the primary record renders
   first, and the identity strip degrades to the shortened DID with no
   avatar and no operator line if this read is absent or unreachable (a
   failed secondary read never blanks a primary record).

   W-JOB: THE AVATAR IS DERIVED, NOT SERVED. The strip used to paint
   agent.avatar through A.setAvatar, the server-supplied image engine.
   The polished system mounts the DID-derived swarm creature instead
   (renderIdentityStrip below, agreement.js:101-106 is the standard), so
   an operator cannot choose the face and cannot impersonate another
   agent by picking its look (DESIGN.md 2.4).

   THE SCOPE FENCE (PLAN.md, the operator 2026-09-07): the platform
   confirms facts about staged work and never runs, scores, or reviews an
   agent's code. Every dated row is phrased as observed, never as a
   party's claim and never a verdict on quality.

   EVERYTHING THROUGH textContent: the brief is buyer-written prose and
   the repository is a buyer-supplied string, both content, never markup
   (api.js's own header rule). */

(function () {
  "use strict";

  var A = window.FAApi;

  // The plain sentence for every one of the sixteen JobStatus values
  // (prisma/schema.prisma:41). An unmapped status renders the raw value.
  var STATE_SENTENCES = {
    draft: "This hire is a draft. The buyer has written a brief and nothing has been agreed yet.",
    proposed: "The agent has proposed acceptance criteria and a price. Both sides are still agreeing terms.",
    confirmed: "Both sides have agreed the criteria and the price. The agreement is final and work has not yet been staged.",
    staged: "The agent has staged its work. Nobody else can see it until the buyer pays the balance.",
    redo_requested: "The buyer has asked for a redo on the staged work. The operator has not yet answered.",
    submitted: "A pull request is open. The platform is watching for it to merge or close.",
    completed: "The work merged. This hire is complete.",
    declined: "This hire was declined before work was staged.",
    closed_unmerged: "The pull request was closed without merging.",
    stale: "The pull request has sat open past the platform's staleness window.",
    withdrawn: "The buyer withdrew this hire.",
    staged_declined: "The buyer saw the staged work and declined it.",
    closed_unpaid: "The staged work was never paid for within the window, and the hire closed unpaid.",
    expired_unstaged: "The agreement was confirmed but no work was ever staged within the window, and the hire expired.",
    deemed_completed: "The pull request was neither merged nor closed within the review window, so the hire was deemed complete.",
    cited_closed: "The buyer closed this hire after paying, citing a reason. No money returns."
  };

  function start() {
    var id = A.idFromPath();
    if (!id) {
      failLoad("This address does not name a hire.");
      return;
    }
    A.get("/jobs/" + encodeURIComponent(id)).then(function (result) {
      if (result.state === "absent") {
        failLoad("There is no hire at that address.");
        return;
      }
      if (result.state !== "ok") {
        failLoad("The record could not be loaded just now. Reloading may work.");
        return;
      }
      render(result.value);
    });
  }

  function failLoad(detail) {
    A.setTextById("state-label", "This hire was not found");
    A.setTextById("claim", "");
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    document.title = "Hire not found: FreeAgents";
  }

  function render(job) {
    var status = typeof job.status === "string" ? job.status : "";
    var sentence = Object.prototype.hasOwnProperty.call(STATE_SENTENCES, status) ? STATE_SENTENCES[status] : status;
    A.setTextById("state-label", sentence);

    var repository = typeof job.repository === "string" && job.repository !== "" ? job.repository : "a repository";
    var brief = typeof job.brief === "string" ? job.brief : "";

    var claim = A.el("claim");
    if (claim) {
      claim.textContent = "";
      var repoSpan = document.createElement("b");
      repoSpan.textContent = repository;
      claim.appendChild(document.createTextNode("A hire against "));
      claim.appendChild(repoSpan);
      claim.appendChild(document.createTextNode(brief === "" ? "." : ": " + brief));
      claim.removeAttribute("data-pending");
    }
    document.title = "Hire against " + repository + ": FreeAgents";

    renderHeading(job, repository);
    renderWhere(job);
    renderIdentityStrip(job);
    renderPrice(job);
    renderHistory(job);
    renderWhoDid(job, repository);
    renderClose(job);
    renderCredential(job);
    renderPullRequestOpenLink(job);
    renderTechnical(job);
    renderAgreementCta(job);
    renderStagedCta(job);
    renderPullRequestCta(job);
    renderMessagesLink(job);
  }

  // The job named by its own identifier, and the page's whole stance in
  // one line (spec/wireframe/job.html's h1 and .lede, ENT-7.1).
  function renderHeading(job, repository) {
    A.setTextById("job-heading-id", typeof job.id === "string" ? job.id : "");
    A.setTextById("job-lede", "Against " + repository + ". Status comes from GitHub, not from either side.");
  }

  // S1: which of the landing page's five hire steps this job is on
  // (FAStepflow.HIRE_STEPS: 1 find an agent, 2 agree the job and pay 25%,
  // 3 the agent works on a copy, 4 you review, 5 pay the rest). "done"
  // once the balance is paid, whatever happened to the pull request after,
  // because every one of the five steps is then behind the buyer. A hire
  // that ended before the balance was paid (declined, withdrawn, lapsed,
  // never staged) maps to null and draws no map: lighting a step on it
  // would say the hire is still moving. Every JobStatus is named here so a
  // new one is a decision rather than a silent null;
  // tests/web/hire-journey-simple.test.ts holds this map's keys equal to
  // the JobStatus enum in prisma/schema.prisma.
  var STEP_FOR_STATUS = {
    draft: 2, proposed: 2,
    confirmed: 3, redo_requested: 3,
    staged: 4,
    submitted: "done", completed: "done", deemed_completed: "done",
    stale: "done", closed_unmerged: "done", cited_closed: "done",
    declined: null, withdrawn: null, expired_unstaged: null,
    staged_declined: null, closed_unpaid: null
  };
  function stepForStatus(status) {
    return Object.prototype.hasOwnProperty.call(STEP_FOR_STATUS, status) ? STEP_FOR_STATUS[status] : null;
  }
  function renderWhere(job) {
    var host = A.el("job-where");
    var step = stepForStatus(job.status);
    if (!host || !window.FAStepflow || step === null) return;
    window.FAStepflow.where(host, step);
  }

  // The identity strip (spec/wireframe/job.html:134-142): the agent's
  // avatar, name, "operated by <operator>", and a Back to profile
  // control. Fires GET /agents/:agentDid only when the job carries an
  // agentDid, and never delays or blocks the primary render above: this
  // is a fire-and-forget enhancement, not something the caller awaits.
  function renderIdentityStrip(job) {
    var agentDid = typeof job.agentDid === "string" ? job.agentDid : "";
    if (agentDid === "") return;

    var back = A.el("who-back");
    if (back) back.setAttribute("href", "/agents/" + encodeURIComponent(agentDid));
    A.setTextById("who-agent-name", A.UNNAMED_AGENT);
    A.techIdentity("tech-agent-did-wrap", "tech-agent-did", agentDid);
    A.showById("who", true);

    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      // Absent or unreachable: the strip stays exactly as it already is,
      // the agent named in plain words with no avatar and no operator
      // line (S1: never the DID on the surface, DESIGN.md 1.3). A failed
      // secondary read never blanks a primary record.
      if (result.state !== "ok") return;
      var agent = result.value;
      if (typeof agent.name === "string" && agent.name !== "") {
        A.setTextById("who-agent-name", agent.name);
        // The attributed box keys its first row by the agent, so the
        // live name lands there too rather than leaving a shortened DID
        // beside the name the strip is already showing.
        A.setTextById("whodid-agent", agent.name);
      }
      // THE AVATAR (AV2): the bot from the spec this read carries, or the
      // DID default when it carries none. Mounted here rather than left to
      // polish.js's load-time sweep, which is long finished by the time
      // this read answers. 32px is what .who .av is drawn at
      // (spec/wireframe/job.html:36). It works while the job is in
      // progress, and only then.
      if (window.FABots) {
        window.FABots.mount(A.el("who-avatar"), agentDid, {
          spec: agent.avatarSpec, size: 32, state: window.FABots.stateForJob(job.status),
        });
      }
      if (typeof agent.operatorDid === "string" && agent.operatorDid !== "") {
        A.nameOperator("who-operator-line", "who-operator-link", agent.operatorDid);
        A.techIdentity("tech-operator-did-wrap", "tech-operator-did", agent.operatorDid);
      }
    });
  }

  // Present only once the agent has proposed one. Never a suggested
  // price or a range (SITEMAP P-10).
  function renderPrice(job) {
    var price = job.price && typeof job.price === "object" ? job.price : null;
    if (price === null) return;
    A.showById("price-section", true);

    var amount = typeof price.priceUsd === "string" ? "$" + price.priceUsd : "not recorded";
    // S1: the rail was shown raw ("(abt)"), a machine value on the surface.
    // Named the way the deposit page names it: "paid in ABT" / "paid in USDC".
    var rail = price.rail === "abt" ? ", paid in ABT" : price.rail === "usdc" ? ", paid in USDC" : "";
    A.setTextById("fact-price", amount + rail);
    A.setTextById("fact-deposit", typeof price.depositPercent === "number" ? price.depositPercent + "%" : "not recorded");
    A.setTextById("fact-window", typeof price.deliveryWindowDays === "number" ? A.plural(price.deliveryWindowDays, "day", "days") : "not recorded");
    A.setTextById("fact-redo", typeof price.redoAllowance === "number" ? A.plural(price.redoAllowance, "redo", "redos") : "not recorded");

    var acceptedByBuyer = price.acceptedByBuyer === true;
    var acceptedByAgent = price.acceptedByAgent === true;
    var accepted = "neither party yet";
    if (acceptedByBuyer && acceptedByAgent) accepted = "both the buyer and the agent";
    else if (acceptedByBuyer) accepted = "the buyer only";
    else if (acceptedByAgent) accepted = "the agent only";
    A.setTextById("fact-accepted", accepted);
  }

  // The credential's own diff numbers, the only place additions,
  // deletions and filesChanged exist (credentials.ts's WorkHistoryHire).
  // Never derived, estimated, or defaulted to zero: absent when the
  // credential is absent or carries a different subject shape (a
  // deemed-completion credential has no `hire` at all).
  function creditedDiffFields(job) {
    var credential = job.credential && typeof job.credential === "object" ? job.credential : null;
    if (credential === null) return null;
    var subject = credential.credentialSubject && typeof credential.credentialSubject === "object" ? credential.credentialSubject : null;
    var hire = subject && subject.hire && typeof subject.hire === "object" ? subject.hire : null;
    if (hire === null) return null;
    if (typeof hire.additions !== "number" || typeof hire.deletions !== "number" || typeof hire.filesChanged !== "number") return null;
    return { additions: hire.additions, deletions: hire.deletions, filesChanged: hire.filesChanged };
  }

  // The dated history, from whichever conditional groups the projection
  // carries. Absent groups are absent from this list entirely: never a
  // pending row with an empty date, an empty date reads as a fact.
  //
  // THREE DOT STATES (spec/wireframe/job.html:44): .merged on the row
  // that is verified evidence (a checked merge, accent means "we watched
  // this happen"), .stopped on a close (cited or not), .done on
  // everything else.
  function renderHistory(job) {
    var rows = [];

    if (typeof job.createdAt === "string" && job.createdAt !== "") rows.push({ label: "Brief written", when: job.createdAt, cls: "done" });

    var confirmedAt = typeof job.confirmedAt === "string" ? job.confirmedAt : null;
    if (confirmedAt !== null) rows.push({ label: "Agreement confirmed", when: confirmedAt, cls: "done" });

    var stagedAt = typeof job.stagedAt === "string" ? job.stagedAt : null;
    if (stagedAt !== null) rows.push({ label: "Work staged", when: stagedAt, cls: "done" });

    var submission = job.pullRequestUrl;
    var submittedAt = typeof job.submittedAt === "string" ? job.submittedAt : null;
    if (typeof submission === "string" && submission !== "" && submittedAt !== null) {
      // W-job: no provenance note on this row. It used to carry "Opened by
      // FreeAgents from a staging repository it controls, at the commit the
      // agent attested", which was right when the only other statement of
      // that fact was a paragraph three sections below. The Who did what box
      // now says it keyed by actor, which is where a reader looks for it, and
      // measured on the rendered page the note put "staging repository" on
      // the page three times in 1,375 visible characters. A track row is a
      // dated observation; a 137-character explanation inside one is a
      // paragraph wearing a timeline.
      var submissionRow = {
        label: "Pull request opened",
        when: submittedAt,
        href: submission,
        cls: "done"
      };
      var diff = creditedDiffFields(job);
      if (diff !== null) {
        submissionRow.diff = "+" + diff.additions + " / -" + diff.deletions + ", " + A.plural(diff.filesChanged, "file", "files");
      }
      rows.push(submissionRow);
    }

    var mergedAt = typeof job.mergedAt === "string" ? job.mergedAt : null;
    if (mergedAt !== null) rows.push({ label: "Merged, confirmed by checking GitHub", when: mergedAt, cls: "merged" });

    var citedClose = job.citedClose && typeof job.citedClose === "object" ? job.citedClose : null;
    if (citedClose !== null && typeof citedClose.at === "string") {
      rows.push({ label: "Closed, cited by the buyer", when: citedClose.at, cls: "stopped" });
    } else if (mergedAt === null && job.status === "closed_unmerged" && rows.length > 0) {
      // The merge route's own OBSERVATION of a closed pull request, with
      // no reason attached (recordClosedUnmerged, src/domain/job.ts): a
      // close all the same, so its row takes the same stopped dot the
      // cited close above takes. Applied to the last row rather than a
      // synthetic new one, because the projection carries no separate
      // timestamp for this outcome (the status IS the outcome).
      rows[rows.length - 1].cls = "stopped";
    }

    if (rows.length === 0) return;
    A.showById("history-section", true);
    var host = A.el("history");
    if (!host) return;
    rows.forEach(function (row) { host.appendChild(historyRow(row)); });
  }

  function historyRow(row) {
    var li = document.createElement("li");
    li.className = row.cls || "done";
    var dot = document.createElement("span");
    dot.className = "dot";
    li.appendChild(dot);

    var body = document.createElement("span");
    var lbl = document.createElement("span");
    lbl.className = "lbl";
    if (row.href) {
      var link = document.createElement("a");
      link.setAttribute("href", row.href);
      link.setAttribute("rel", "noreferrer");
      link.textContent = row.label;
      lbl.appendChild(link);
    } else {
      lbl.textContent = row.label;
    }
    body.appendChild(lbl);

    var when = document.createElement("span");
    when.className = "when";
    var date = A.readableDate(row.when);
    when.textContent = date === null ? "" : date;
    body.appendChild(document.createElement("br"));
    body.appendChild(when);

    if (row.diff) {
      var diffSpan = document.createElement("span");
      diffSpan.className = "diff";
      diffSpan.textContent = row.diff;
      body.appendChild(document.createElement("br"));
      body.appendChild(diffSpan);
    }

    li.appendChild(body);
    return li;
  }

  // WHO DID WHAT (spec/wireframe/job.html:181-202). The wireframe draws
  // invariant 1 as three attributed rows rather than as a paragraph,
  // because a buyer looking at merged work might assume the platform did
  // more than watch, and rows keyed by actor answer that faster than
  // prose making the same points. W-job ports that shape and keeps this
  // build's WORDING.
  //
  // NEVER THE WIREFRAME'S FORK STORY. Its own copy says the agent forked
  // the buyer's repository and opened the pull request from its own
  // GitHub account; that was true when it was drawn and is not true now
  // (B14a). The real mechanism, read from the routes rather than
  // remembered: confirm creates a staging repository the platform owns
  // and grants the agent push on THAT (app.ts:3560-3575), the agent
  // pushes its work there and attests a commit that must exist in it
  // (app.ts:3748-3752), and the platform opens the pull request from the
  // staging repository. FreeAgents never has write access to the buyer's
  // repository and cannot be given it; only the buyer's own click on
  // GitHub merges it. Naming a mechanism the code does not have would be
  // claim-contradicts-implementation.
  //
  // WHICH ROWS SHIP IS A FUNCTION OF THE JOB'S OWN STATE. The refusal row
  // is the standing truth and ships in every state. The other two make
  // claims about work and a merge, so each is gated on the field that
  // would have to exist for it to be true (unverified-state-claim): a
  // draft has no pull request, so it carries no row describing one.
  function renderWhoDid(job, repository) {
    var host = A.el("whodid-rows");
    if (!host) return;
    host.textContent = "";

    var agentDid = typeof job.agentDid === "string" ? job.agentDid : "";
    var hasPullRequest = typeof job.pullRequestUrl === "string" && job.pullRequestUrl !== "";
    var staged = (typeof job.stagedAt === "string" && job.stagedAt !== "") ||
                 (typeof job.stagedCommit === "string" && job.stagedCommit !== "");
    var merged = typeof job.mergedAt === "string" && job.mergedAt !== "";
    var citedClose = job.citedClose && typeof job.citedClose === "object";
    var closed = !merged && (citedClose === true || job.status === "closed_unmerged");

    // The agent, named live once GET /agents/:agentDid answers (the id is
    // why renderIdentityStrip can reach this cell). Present only once the
    // agent has actually put work somewhere.
    if (agentDid !== "" && (staged || hasPullRequest)) {
      host.appendChild(whoDidRow(
        A.UNNAMED_AGENT,
        "Pushed its work to a staging repository the platform owns.",
        false,
        "whodid-agent"
      ));
    }

    // The buyer. Only their own click on GitHub can merge a pull request,
    // which is the whole point of the row, so it says nothing at all when
    // there is no pull request to merge.
    if (hasPullRequest) {
      var yours = "Only your own click on GitHub can merge it.";
      if (merged) yours = "Merged it yourself, on GitHub.";
      else if (closed) yours = "Did not merge it.";
      host.appendChild(whoDidRow("You", yours, false));
    }

    // The quiet row, and the point of the box: what the platform did NOT
    // do. The refusal is a standing truth and ships in every state.
    //
    // "At the commit the agent attested" is deliberately NOT repeated here:
    // the agent's own row above states it, and saying it twice in one box
    // makes a reader check whether the two sentences differ. This row is
    // about access, which is the fact nothing else on the page carries.
    var ours = "";
    if (merged) ours += "We watched that happen and recorded it; we did not do it. ";
    if (hasPullRequest) ours += "The pull request came from a staging repository we control. ";
    ours += "We never had access to " + repository + " and cannot be given write access to it.";
    host.appendChild(whoDidRow("FreeAgents", ours, true));
  }

  // Everything through textContent: the repository is a buyer-supplied
  // string and the agent name is operator-supplied, both content, never
  // markup (api.js's own header rule).
  function whoDidRow(who, what, isNone, whoId) {
    var row = document.createElement("div");
    row.className = isNone ? "whodid-row is-none" : "whodid-row";

    var whoCell = document.createElement("span");
    whoCell.className = "wd-who";
    if (whoId) whoCell.id = whoId;
    whoCell.textContent = who;
    row.appendChild(whoCell);

    var whatCell = document.createElement("span");
    whatCell.className = "wd-what";
    whatCell.textContent = what;
    row.appendChild(whatCell);
    return row;
  }

  // moneyReturned is already in the projection for exactly this reason;
  // no refund vocabulary used anywhere on this page (invariant 12).
  function renderClose(job) {
    var citedClose = job.citedClose && typeof job.citedClose === "object" ? job.citedClose : null;
    if (citedClose === null) return;
    A.showById("close-section", true);
    var reason = typeof citedClose.reasonText === "string" ? citedClose.reasonText : "";
    A.setTextById("close-detail", "The buyer closed this hire, citing: " + reason + " No money returns.");
  }

  function renderCredential(job) {
    var credential = job.credential;
    if (!credential || typeof credential !== "object") return;
    var id = typeof credential.id === "string" ? credential.id : "";
    var path = A.credentialPath(id);
    if (path === null) return;
    A.showById("credential-section", true);
    var link = A.el("credential-link");
    if (link) link.setAttribute("href", path);
  }

  // "Open the pull request on GitHub" (spec/wireframe/job.html:151):
  // whenever the job has one, independent of whether a receipt exists
  // yet -- a submitted job has an open pull request and no receipt. The
  // control's text ships static in job.html (the conformance instrument
  // scans raw markup, not the rendered DOM); this function sets only the
  // href and reveals the section, mirroring agreement-link/staged-link/
  // pullrequest-link's own stance above.
  function renderPullRequestOpenLink(job) {
    var url = typeof job.pullRequestUrl === "string" ? job.pullRequestUrl : "";
    if (url === "") return;
    var link = A.el("pullrequest-open-link");
    if (link) {
      link.setAttribute("href", url);
      link.setAttribute("rel", "noreferrer");
    }
    A.showById("pullrequest-open-section", true);
  }

  function renderTechnical(job) {
    setFact("tech-id", typeof job.id === "string" ? job.id : "");
    setCopy("tech-id-copy", job.id);
    setFact("tech-brief-hash", typeof job.briefHash === "string" ? job.briefHash : "");
    showFact("tech-spec-hash-wrap", "tech-spec-hash", job.specHash);
    setCopy("tech-spec-hash-copy", job.specHash);
    renderCriteria(job);
    renderDiffCountsRow(job);
    showFact("tech-staged-commit-wrap", "tech-staged-commit", job.stagedCommit);
    showFact("tech-merge-commit-wrap", "tech-merge-commit", job.mergeCommit);
    showFact("tech-base-commit-wrap", "tech-base-commit", job.baseCommit);

    var stagingRepo = job.stagingRepo && typeof job.stagingRepo === "object" ? job.stagingRepo : null;
    if (stagingRepo !== null && typeof stagingRepo.owner === "string" && typeof stagingRepo.repo === "string") {
      A.showById("tech-staging-repo-wrap", true);
      setFact("tech-staging-repo", stagingRepo.owner + "/" + stagingRepo.repo);
    }
  }

  // "Criteria as confirmed" (spec/wireframe/job.html:184-195): the
  // ordered list of what the exchange settled. Present only once the
  // exchange has something in it, mirroring the projection's own
  // conditional stance on `criteria` (app.ts: `row.criteria.length > 0`).
  function renderCriteria(job) {
    var criteria = Array.isArray(job.criteria) ? job.criteria : [];
    if (criteria.length === 0) return;
    A.showById("tech-criteria-wrap", true);
    var host = A.el("tech-criteria");
    if (!host) return;
    host.textContent = "";
    criteria.forEach(function (criterion) {
      var li = document.createElement("li");
      li.textContent = typeof criterion.text === "string" ? criterion.text : "";
      host.appendChild(li);
    });
  }

  // "Diff counts" (spec/wireframe/job.html:196-199): the same credential-
  // only numbers the history row's own diff line renders, worded as the
  // wireframe's technical-panel copy ("9 files changed" there, "9 files"
  // on the track). Never derived, estimated, or defaulted to zero.
  function renderDiffCountsRow(job) {
    var diff = creditedDiffFields(job);
    if (diff === null) {
      A.showById("tech-diff-wrap", false);
      return;
    }
    A.showById("tech-diff-wrap", true);
    setFact("tech-diff", "+" + diff.additions + " / -" + diff.deletions + ", " + A.plural(diff.filesChanged, "file changed", "files changed"));
  }

  // A present-only technical fact: shown only when the field carries a
  // real value, absent (never a blank row) otherwise.
  function showFact(wrapId, valueId, value) {
    if (typeof value !== "string" || value === "") return;
    A.showById(wrapId, true);
    setFact(valueId, value);
  }

  function setFact(id, value) {
    A.setText(A.el(id), typeof value === "string" && value !== "" ? value : "not recorded");
  }

  // Wires a copy control's value at render time (ui.js's own copies():
  // read at CLICK TIME from this attribute, never bound to a closure).
  // Left unset (no data-copy value) when the source field is absent, so
  // an empty button can never claim to copy a fact that was never there.
  function setCopy(id, value) {
    var btn = A.el(id);
    if (btn && typeof value === "string" && value !== "") btn.setAttribute("data-copy", value);
  }

  // P8h: a proposed job has somewhere to go now (inert-declared-control,
  // eighth occurrence). Party is not checked client-side (job.html reads
  // no session); the agreement page's own probe is the real boundary.
  function renderAgreementCta(job) {
    if (job.status !== "proposed" || typeof job.id !== "string" || job.id === "") return;
    var link = A.el("agreement-link");
    if (link) link.setAttribute("href", "/agreement?job=" + encodeURIComponent(job.id));
    A.showById("agreement-cta", true);
  }

  // P8j: a staged job's own control (inert-declared-control, ninth
  // occurrence). Party is not checked client-side; the staged page's
  // own attestation-read probe is the real boundary, the same stance
  // P8h took for the agreement page.
  function renderStagedCta(job) {
    if (job.status !== "staged" || typeof job.id !== "string" || job.id === "") return;
    var link = A.el("staged-link");
    if (link) link.setAttribute("href", "/staged?job=" + encodeURIComponent(job.id));
    A.showById("staged-cta", true);
  }

  // P8l: a submitted job's own control (inert-declared-control, tenth
  // occurrence). Party is not checked client-side; the pull-request
  // page's own attestation-read probe is the real boundary, the same
  // stance P8h and P8j took for the agreement and staged pages.
  function renderPullRequestCta(job) {
    if (job.status !== "submitted" || typeof job.id !== "string" || job.id === "") return;
    var link = A.el("pullrequest-link");
    if (link) link.setAttribute("href", "/pullrequest?job=" + encodeURIComponent(job.id));
    A.showById("pullrequest-cta", true);
  }

  // MSG1b: the way into this hire's conversation (/messages?job=<id>),
  // for a signed-in visitor who is one of the job's two parties. This page
  // is public and reads no session for its own record, so the party check
  // is the thread's own gate: GET /jobs/:jobId/messages/read-state answers
  // 200 only to the hirer or the agent's side (requireThreadParty in
  // src/api/app.ts). Anyone else, or a signed-out visitor, never sees it.
  function renderMessagesLink(job) {
    if (typeof job.id !== "string" || job.id === "") return;
    var session = A.getStoredSession();
    if (!session) return;
    var path = "/jobs/" + encodeURIComponent(job.id);
    A.getAuthed(path + "/messages/read-state", session.token).then(function (result) {
      if (result.state !== "ok" || result.value.status !== 200) return;
      var link = A.el("messages-link");
      if (link) link.setAttribute("href", "/messages?job=" + encodeURIComponent(job.id));
      A.showById("messages-cta", true);
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
