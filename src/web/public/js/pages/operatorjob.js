/* P8v operator job (P-25): the operator's own side of one hire, from
   spec/wireframe/operatorjob.html. Reads GET /jobs/:jobId (public,
   job.js's own route) and GET /jobs/:jobId/attestation with the session
   attached (the same party-probe pattern staged.js and agreement.js
   already use: no side effect, but 401/403 comes back through the same
   resolveJobActingParty gate every acting control is checked against).
   P8v's own operator relation means this same probe now also admits a
   signed-in session that resolves to the agent's OWN OPERATOR, not just
   the agent's key or the buyer.

   ROUND 2 FIX (qa D1): GET /jobs/:jobId/attestation's own party check
   admits the buyer too (the buyer reads the same document, P5's own
   rule), so a 200 or 404 from that probe means only "not a stranger",
   never "this is the agent/operator seat" -- this screen's own controls
   are agent/operator-only. resolveIsBuyerParty (below, staged.js's own
   pattern) reads GET /accounts/:did for the job's buyerDid and compares
   the stored session's subject/method against it, the same join
   resolveActingParty makes server-side, before this screen's body ever
   renders. A buyer session lands on the party-error panel.

   Controls post to /jobs/:jobId/redo-refuse and /jobs/:jobId/stage (the
   same route the agent's own key already used to stage the first time
   and to restage after an accepted redo), both now open to the operator
   relation as well as the agent's key.

   Departures from spec/wireframe/operatorjob.html, named per the
   handoff: no drawn fixture numbers (the wireframe's "05 of 07" and
   dollar literals are illustrative; this build reads the real
   criterion text and the real price facts from the job's own
   projection); the accept-redo dialog asks for the restaged commit SHA
   (the wireframe shows no input because its own mockup already assumes
   one), since POST /jobs/:jobId/stage requires { stagedCommit } and
   there is no route that accepts a redo without naming what was
   restaged; the "drafting the agreement" section links to /agreement
   rather than rendering the brief and draft inline (agreement.html
   already is that screen, and duplicating it here would be a second
   copy of the same page, the inert-declared-control class this
   codebase's other handoffs are written against); no history rows this
   job's real projection carries no timestamp for (the wireframe's own
   fixed narrative names deposit/balance events this build's price
   projection does not carry a settlement timestamp for; see
   MONEY FACTS below); both redo dialogs render the consequence rows
   from the job's own real numbers (redoAllowance, redo.usedCount, the
   price line) rather than the wireframe's fixed prose figures --
   renderRedoConsequences below, joined to both dialogs, not just one.

   EVERYTHING THROUGH textContent: the brief, the repository and every
   criterion's text are buyer/agent-supplied strings, content, never
   markup (api.js's own header rule). */
(function () {
  "use strict";
  var A = window.FAApi;
  // Pinned to src/domain/job.ts's own REDO_LAPSE_EXTENSION_DAYS (staged.js's
  // own pattern: a browser constant a test pins against the domain's own
  // value, rather than this page recomputing a delivery date from fields
  // it does not carry).
  var REDO_LAPSE_EXTENSION_DAYS = 7;
  var jobId = "", token = null, job = null, redoAcceptSelectedCommit = "", session = null;

  var STATE_HEADINGS = {
    draft: "A brief arrived",
    proposed: "Drafting the agreement",
    confirmed: "Ready to stage",
    staged: "Work staged, waiting on the buyer",
    redo_requested: "A buyer sent it back",
    submitted: "A pull request is open",
    completed: "This hire is complete",
    declined: "This hire was declined",
    closed_unmerged: "The pull request was closed without merging",
    stale: "This hire has gone stale",
    withdrawn: "The buyer withdrew this hire",
    staged_declined: "The buyer declined the staged work",
    closed_unpaid: "The staged work was never paid for",
    expired_unstaged: "The agreement expired before work was staged",
    deemed_completed: "Deemed complete: no merge or close within the review window",
    cited_closed: "The buyer closed this hire, citing a reason"
  };

  var STATE_LEDES = {
    draft: "A brief has been written for this agent. Read it and draft the agreement.",
    proposed: "Criteria and a price have been proposed. Both sides are still agreeing terms.",
    confirmed: "Both sides have agreed the criteria and the price. Submit the staged commit when the work is ready.",
    staged: "The work is staged, unpaid and unseen by the public until the buyer settles the balance.",
    redo_requested: "The buyer cited a line and sent the work back. Answer it and this agent gets more time, or refuse it and the buyer decides whether to pay for what has already been delivered.",
    submitted: "The platform is watching for the pull request to merge or close.",
    completed: "The work merged.",
    declined: "This hire was declined before work was staged.",
    closed_unmerged: "The pull request was closed without merging.",
    stale: "The pull request has sat open past the platform's staleness window.",
    withdrawn: "The buyer withdrew this hire before it was confirmed.",
    staged_declined: "The buyer saw the staged work and declined it. No money returns.",
    closed_unpaid: "The staged work was never paid for within the window, and the hire closed unpaid.",
    expired_unstaged: "The agreement was confirmed but no work was ever staged within the window.",
    deemed_completed: "The pull request was neither merged nor closed within the review window, so the hire was deemed complete.",
    cited_closed: "The buyer closed this hire after paying, citing a reason. No money returns."
  };

  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
    reload();
  }

  function reload() {
    Promise.all([
      A.get("/jobs/" + encodeURIComponent(jobId)),
      A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/attestation", token)
    ]).then(onLoaded);
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  var PANEL_IDS = ["load-error", "signin-required", "party-error", "operatorjob-body"];
  function hideAllPanels() { PANEL_IDS.forEach(function (id) { A.showById(id, false); }); }

  // Round 2 fix (qa D1): the attestation probe's 200/403/404 answers
  // "may this session read the job", never "which seat is this session".
  // The attestation route admits the buyer AND the agent/operator by
  // design (src/api/app.ts, GET /jobs/:jobId/attestation's own header
  // comment), so a 200 or 404 here means only "not a stranger", and this
  // page's own controls are agent/operator-only (the header comment
  // above). resolveIsBuyerParty mirrors staged.js's own party probe: it
  // reads GET /accounts/:did for the job's buyerDid and compares the
  // stored session's subject/method against that account's own
  // githubLogin/passkeySubject, the same join resolveActingParty makes
  // server-side. A failed or absent read resolves false (fail closed):
  // this page shows the party-error panel rather than risk showing the
  // agent's controls to an unconfirmed caller.
  function resolveIsBuyerParty(job_) {
    if (session === null || typeof job_.buyerDid !== "string" || job_.buyerDid === "") return Promise.resolve(false);
    return A.get("/accounts/" + encodeURIComponent(job_.buyerDid)).then(function (result) {
      if (result.state !== "ok") return false;
      var account = result.value && typeof result.value === "object" ? result.value : {};
      if (session.method === "passkey") {
        return typeof account.passkeySubject === "string" && account.passkeySubject === session.subject;
      }
      return typeof account.githubLogin === "string" && account.githubLogin === session.subject;
    });
  }

  function onLoaded(results) {
    var jobResult = results[0], gate = results[1];
    if (jobResult.state === "absent") { failLoad("There is no hire at that address."); return; }
    if (jobResult.state !== "ok") { failLoad("The record could not be loaded just now. Reloading may work."); return; }
    job = jobResult.value;
    hideAllPanels();
    var status = gate.value ? gate.value.status : null;
    var body = gate.value && gate.value.body && typeof gate.value.body === "object" ? gate.value.body : {};
    if (gate.state !== "ok") { failLoad("Could not confirm your access to this hire just now. Reloading may work."); return; }
    if (status === 401) {
      A.showById("signin-required", true);
      return;
    }
    if (status === 403) {
      A.setTextById("party-error-detail", typeof body.error === "string" && body.error !== "" ? body.error : "Only the agent that took this job, or the account that operates it, can read this screen.");
      A.showById("party-error", true);
      return;
    }
    // 200 (an attestation exists) or 404 (party check passed but this
    // job has no attestation yet, e.g. it is not staged) both mean the
    // party check itself passed: resolveJobActingParty runs before the
    // attestation lookup on the server (src/api/app.ts), so a 404 here
    // is "no attestation", never "not a party". The attestation route's
    // party check admits the buyer too, so a further check (below)
    // resolves whether THIS caller is the buyer before this agent/
    // operator-only screen renders its controls.
    resolveIsBuyerParty(job).then(function (isBuyer) {
      if (isBuyer) {
        A.setTextById("party-error-detail", "Only the agent that took this job, or the account that operates it, can read this screen.");
        A.showById("party-error", true);
        return;
      }
      A.showById("operatorjob-body", true);
      render(job);
    });
  }

  function render(job_) {
    document.title = "Job " + job_.id + ", operator view: FreeAgents";
    renderWho(job_);
    renderState(job_);
    renderRedoPanel(job_);
    renderStagePanel(job_);
    renderMoney(job_);
    renderHistory(job_);
    renderDrafting(job_);
    renderTechnical(job_);
  }

  function renderWho(job_) {
    A.setTextById("job-line", "job " + job_.id + " \u00b7 " + (typeof job_.repository === "string" ? job_.repository : ""));
    var agentDid = typeof job_.agentDid === "string" ? job_.agentDid : "";
    if (agentDid === "") return;
    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      var name = A.shortDid(agentDid);
      if (result.state === "ok") {
        name = typeof result.value.name === "string" && result.value.name !== "" ? result.value.name : agentDid;
        A.setAvatar(A.el("agent-avatar-img"), result.value.avatar);
      }
      A.setTextById("agent-name", name);
    });
  }

  function renderState(job_) {
    var status = typeof job_.status === "string" ? job_.status : "";
    A.setTextById("state-heading", STATE_HEADINGS[status] || status);
    A.setTextById("state-lede", STATE_LEDES[status] || "");
  }

  // The redo panel: the one control that needs an answer. Renders only
  // at redo_requested, and names the cited criterion by its stored
  // text, never a fixture line number.
  function renderRedoPanel(job_) {
    if (job_.status !== "redo_requested") return;
    var redo = job_.redo && typeof job_.redo === "object" ? job_.redo : null;
    var criteria = Array.isArray(job_.criteria) ? job_.criteria : [];
    var citedIndex = redo !== null && typeof redo.requestedCriterionIndex === "number" ? redo.requestedCriterionIndex : null;
    var citedText = citedIndex !== null && criteria[citedIndex] && typeof criteria[citedIndex].text === "string" ? criteria[citedIndex].text : "";

    var host = A.el("redo-facts");
    host.textContent = "";
    host.appendChild(fixedRow("The line they cited", citedIndex === null ? "not recorded" : "criterion " + (citedIndex + 1), citedText));
    A.showById("redo-panel", true);
    renderRedoConsequences(job_);
  }

  // THE CONSEQUENCE, shown before the click (wireframe's own header
  // comment: "the one that makes the redo real"). Both dialogs read
  // from the job's own real numbers, never the wireframe's fixed prose
  // figures: the accept side reads redoAllowance/redo.usedCount for
  // "redos left" and the price line for "price unchanged"; the refuse
  // side reads the same price line for what the operator receives if
  // paid, or keeps as the deposit if declined.
  function renderRedoConsequences(job_) {
    var price = job_.price && typeof job_.price === "object" ? job_.price : null;
    var redo = job_.redo && typeof job_.redo === "object" ? job_.redo : null;

    var acceptHost = A.el("accept-consequences");
    if (acceptHost) {
      acceptHost.textContent = "";
      acceptHost.appendChild(fixedRow("More time", A.plural(REDO_LAPSE_EXTENSION_DAYS, "day", "days")));
      acceptHost.appendChild(fixedRow("Price", price !== null && typeof price.priceUsd === "string" ? "unchanged, " + money(parseFloat(price.priceUsd)) : "not agreed yet"));
      var redoAllowance = price !== null && typeof price.redoAllowance === "number" ? price.redoAllowance : null;
      var usedCount = redo !== null && typeof redo.usedCount === "number" ? redo.usedCount : null;
      var redosLeft = redoAllowance !== null && usedCount !== null ? Math.max(redoAllowance - usedCount, 0) : null;
      acceptHost.appendChild(fixedRow("Redos left after this", redosLeft === null ? "not recorded" : redosLeft === 0 ? "none" : String(redosLeft)));
    }

    var refuseHost = A.el("refuse-consequences");
    if (refuseHost) {
      refuseHost.textContent = "";
      if (price !== null && typeof price.priceUsd === "string") {
        var priceUsd = parseFloat(price.priceUsd);
        var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
        var deposit = roundHalfUpCents((priceUsd * depositPercent) / 100);
        refuseHost.appendChild(fixedRow("If they pay the balance", "you receive " + money(priceUsd)));
        refuseHost.appendChild(fixedRow("If they decline", "you keep " + money(deposit)));
      }
      refuseHost.appendChild(fixedRow("Who decides next", "the buyer, not FreeAgents"));
      refuseHost.appendChild(fixedRow("Your record", "gains one refused redo"));
    }
  }

  function fixedRow(k, v, para) {
    var li = document.createElement("li");
    var kSpan = document.createElement("span"); kSpan.className = "k"; kSpan.textContent = k;
    var vSpan = document.createElement("span"); vSpan.className = "v"; vSpan.textContent = v;
    li.appendChild(kSpan); li.appendChild(vSpan);
    if (para) {
      var pSpan = document.createElement("span"); pSpan.className = "para"; pSpan.textContent = para;
      li.appendChild(pSpan);
    }
    return li;
  }

  // The stage panel: submitting the staged commit for the first time,
  // reachable once the job is confirmed and has not yet staged.
  function renderStagePanel(job_) {
    if (job_.status !== "confirmed") return;
    A.showById("stage-panel", true);
  }

  // MONEY FACTS: the job's own price line, never a suggested figure.
  // This build's projection carries no deposit/balance SETTLEMENT
  // timestamp (job.price carries the agreed terms; settlement is
  // observed on the buyer's own payment routes, out of this card's
  // scope), so "received" and "settles when paid" read as states, not
  // dated facts -- a departure from the wireframe's fixed dates, named
  // in the handoff above.
  function renderMoney(job_) {
    var price = job_.price && typeof job_.price === "object" ? job_.price : null;
    var host = A.el("money-facts");
    host.textContent = "";
    if (price === null || typeof price.priceUsd !== "string") {
      host.appendChild(factRow("Agreed price", "not agreed yet"));
      return;
    }
    var priceUsd = parseFloat(price.priceUsd);
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    var deposit = roundHalfUpCents((priceUsd * depositPercent) / 100);
    var remainder = roundHalfUpCents(priceUsd - deposit);
    host.appendChild(factRow("Agreed price", money(priceUsd)));
    host.appendChild(factRow("Deposit", money(deposit)));
    host.appendChild(factRow("Balance, when the buyer pays it", money(remainder)));
    host.appendChild(factRow("Platform fee", "paid by the buyer, on top"));
  }

  function factRow(label, valueText) {
    var li = document.createElement("li");
    var f = document.createElement("span"); f.className = "f"; f.textContent = label;
    var v = document.createElement("span"); v.className = "v"; v.textContent = valueText;
    li.appendChild(f); li.appendChild(v);
    return li;
  }

  function roundHalfUpCents(amount) {
    var h = Math.round(amount * 10000), cents = Math.floor(h / 100);
    if (h - cents * 100 >= 50) cents += 1;
    return cents / 100;
  }
  function money(n) { return "$" + n.toFixed(2); }

  // THE HISTORY: every dated row this job's own projection carries.
  // Absent groups are absent from this list entirely, never a pending
  // row with an empty date (job.js's own rule, carried here).
  function renderHistory(job_) {
    var rows = [];
    if (typeof job_.createdAt === "string" && job_.createdAt !== "") rows.push({ label: "Brief arrived", when: job_.createdAt });
    var confirmedAt = typeof job_.confirmedAt === "string" ? job_.confirmedAt : null;
    if (confirmedAt !== null) rows.push({ label: "Agreement confirmed, both sides signed", when: confirmedAt });
    var stagedAt = typeof job_.stagedAt === "string" ? job_.stagedAt : null;
    if (stagedAt !== null) rows.push({ label: "Work staged", when: stagedAt });
    var redo = job_.redo && typeof job_.redo === "object" ? job_.redo : null;
    if (redo !== null && typeof redo.requestedAt === "string") rows.push({ label: "The buyer sent it back, citing a line", when: redo.requestedAt });
    if (redo !== null && typeof redo.refusedAt === "string" && redo.refusedAt !== null) rows.push({ label: "The redo was refused", when: redo.refusedAt });
    var submittedAt = typeof job_.submittedAt === "string" ? job_.submittedAt : null;
    if (submittedAt !== null) rows.push({ label: "Pull request opened", when: submittedAt });
    var mergedAt = typeof job_.mergedAt === "string" ? job_.mergedAt : null;
    if (mergedAt !== null) rows.push({ label: "Merged", when: mergedAt });

    var host = A.el("history");
    host.textContent = "";
    rows.forEach(function (row) { host.appendChild(historyRow(row)); });
  }

  function historyRow(row) {
    var li = document.createElement("li");
    var dot = document.createElement("span"); dot.className = "dot";
    li.appendChild(dot);
    var body = document.createElement("span");
    var lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = row.label;
    body.appendChild(lbl);
    var when = document.createElement("span"); when.className = "when";
    var date = A.readableDate(row.when);
    when.textContent = date === null ? "" : date;
    body.appendChild(document.createElement("br"));
    body.appendChild(when);
    li.appendChild(body);
    return li;
  }

  // DRAFTING: at draft/proposed, the agreement is not yet confirmed;
  // this links to /agreement, the same screen the buyer signs from,
  // rather than duplicating its content here.
  function renderDrafting(job_) {
    if (job_.status !== "draft" && job_.status !== "proposed") return;
    var link = A.el("agreement-link");
    if (link) link.setAttribute("href", "/agreement?job=" + encodeURIComponent(job_.id));
    A.showById("drafting-section", true);
  }

  function renderTechnical(job_) {
    A.setTextById("tech-job-id", job_.id);
    var copyId = A.el("copy-job-id");
    if (copyId) copyId.setAttribute("data-copy", job_.id);
    if (typeof job_.specHash === "string" && job_.specHash !== "") {
      A.showById("tech-spec-hash-wrap", true);
      A.setTextById("tech-spec-hash", job_.specHash);
      var copyHash = A.el("copy-spec-hash");
      if (copyHash) copyHash.setAttribute("data-copy", job_.specHash);
    }
    if (typeof job_.stagedCommit === "string" && job_.stagedCommit !== "") {
      A.showById("tech-staged-commit-wrap", true);
      A.setTextById("tech-staged-commit", job_.stagedCommit);
    }
  }

  /* ------------------------------------------------------------ dialogs */
  function openDialog(id) {
    var dialog = A.el(id);
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else if (dialog) dialog.setAttribute("open", "");
  }
  function closeDialog(id) {
    var dialog = A.el(id);
    if (dialog && typeof dialog.close === "function") dialog.close();
    else if (dialog) dialog.removeAttribute("open");
  }
  ["accept", "refuse"].forEach(function (id) {
    var dialog = A.el(id);
    if (dialog) {
      Array.prototype.forEach.call(dialog.querySelectorAll("[data-closes]"), function (btn) {
        btn.addEventListener("click", function () { closeDialog(id); });
      });
    }
  });

  function showError(idPrefix, message) { A.setTextById(idPrefix + "-detail", message); A.showById(idPrefix, true); }

  function stageRefusalSentence(status, serverMessage) {
    if (status === 400) return "This screen sent a malformed request. Reload the page and try again.";
    if (status === 401) return "Your session has expired. Sign in again to submit this commit.";
    if (status === 403) return serverMessage || "This account is not this job's agent or operator.";
    if (status === 409) return serverMessage || "This hire is not ready to stage.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The request could not complete just now. Try again in a moment.";
  }

  function redoRefuseRefusalSentence(status, serverMessage) {
    if (status === 401) return "Your session has expired. Sign in again to refuse this redo.";
    if (status === 403) return serverMessage || "This account is not this job's agent or operator.";
    if (status === 409) return serverMessage || "This hire is not waiting on a redo answer.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The request could not complete just now. Try again in a moment.";
  }

  // Posts { stagedCommit } to /jobs/:jobId/stage. Used both by the
  // confirmed-state stage panel (first submission) and the redo-accept
  // dialog (restaging): one route, P6's own "stageWork repeats its own
  // edge from redo_requested" rule, so this is one function, not two.
  function postStage(commit, onDone) {
    A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/stage", token, { stagedCommit: commit }).then(function (result) {
      onDone(result);
    });
  }

  var stageSubmitBtn = A.el("stage-submit-btn");
  var stageCommitInput = A.el("stage-commit-input");
  if (stageSubmitBtn) {
    stageSubmitBtn.addEventListener("click", function () {
      var commit = stageCommitInput ? stageCommitInput.value.trim() : "";
      if (commit === "") return;
      A.showById("stage-error", false);
      stageSubmitBtn.disabled = true;
      postStage(commit, function (result) {
        if (result.state !== "ok") {
          stageSubmitBtn.disabled = false;
          showError("stage-error", "Could not reach the server just now. Try again in a moment.");
          return;
        }
        var status = result.value.status;
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status === 200) { reload(); return; }
        stageSubmitBtn.disabled = false;
        showError("stage-error", stageRefusalSentence(status, typeof body.error === "string" ? body.error : ""));
      });
    });
  }

  var redoAcceptBtnTop = A.el("redo-accept-btn");
  if (redoAcceptBtnTop) redoAcceptBtnTop.addEventListener("click", function () { openDialog("accept"); });
  var redoRefuseBtnTop = A.el("redo-refuse-btn");
  if (redoRefuseBtnTop) redoRefuseBtnTop.addEventListener("click", function () { openDialog("refuse"); });

  var acceptCommitInput = A.el("accept-commit-input");
  var acceptConfirmBtn = A.el("accept-confirm-btn");
  if (acceptCommitInput && acceptConfirmBtn) {
    acceptCommitInput.addEventListener("input", function () {
      redoAcceptSelectedCommit = acceptCommitInput.value.trim();
      acceptConfirmBtn.disabled = redoAcceptSelectedCommit === "";
    });
  }
  if (acceptConfirmBtn) {
    acceptConfirmBtn.addEventListener("click", function () {
      if (redoAcceptSelectedCommit === "") return;
      A.showById("redo-error", false);
      acceptConfirmBtn.disabled = true;
      postStage(redoAcceptSelectedCommit, function (result) {
        if (result.state !== "ok") {
          acceptConfirmBtn.disabled = false;
          showError("redo-error", "Could not reach the server just now. Try again in a moment.");
          return;
        }
        var status = result.value.status;
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status === 200) { closeDialog("accept"); reload(); return; }
        acceptConfirmBtn.disabled = false;
        showError("redo-error", stageRefusalSentence(status, typeof body.error === "string" ? body.error : ""));
      });
    });
  }

  var refuseConfirmBtn = A.el("refuse-confirm-btn");
  if (refuseConfirmBtn) {
    refuseConfirmBtn.addEventListener("click", function () {
      A.showById("redo-error", false);
      refuseConfirmBtn.disabled = true;
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/redo-refuse", token, {}).then(function (result) {
        if (result.state !== "ok") {
          refuseConfirmBtn.disabled = false;
          showError("redo-error", "Could not reach the server just now. Try again in a moment.");
          return;
        }
        var status = result.value.status;
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status === 200) { closeDialog("refuse"); reload(); return; }
        refuseConfirmBtn.disabled = false;
        showError("redo-error", redoRefuseRefusalSentence(status, typeof body.error === "string" ? body.error : ""));
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
