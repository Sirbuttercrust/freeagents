/* P8l pullrequest (P-14): a submitted hire's buyer reads where its pull
   request is, learns silence now completes the job, and can close it
   with a cited reason. No route in src/api/app.ts changes. Reads
   GET /jobs/:jobId and GET /jobs/:jobId/attestation (party probe,
   staged.js's own pattern, no side effect). Adds
   POST /jobs/:jobId/cited-close, buyer-only.

   Departures from spec/wireframe/pullrequest.html (handoff): provenance
   names a platform-controlled staging repository, never a fork
   (app.ts:3741, B14a); the write-access sentence stays verbatim
   (invariant 1). No payment date renders anywhere (no route serves one
   to a party); the lede states paid in full and submittedAt, and the
   disclosure's deposit/balance rows keep amounts, lose dates. The clock
   is submittedAt + DEEM_COMPLETED_AFTER_DAYS, never the projection's own
   `deadline` (submittedAt + STALE_AFTER_DAYS). The diff line reads only
   from the signed attestation; absent on a failed or 404 read, never
   estimated. Serves `submitted` only; every other status renders
   not-ready or a terminal panel naming what happened. No control here
   ever calls POST /jobs/:jobId/merge. Everything through textContent
   (api.js rule 3); the anchor's href is set only once the URL parses and
   its origin is https://github.com. */
(function () {
  "use strict";
  var A = window.FAApi;
  var DEEM_COMPLETED_AFTER_DAYS = 7, ABT_FEE_RATE_PERCENT = 3, MS_PER_DAY = 86400000;
  var jobId = "", token = "", job = null, closeSelectedIndex = null;
  // Whether the signed-in session IS the job's buyer, resolved like
  // staged.js's own resolveIsBuyerParty (GET /accounts/:did). Fail closed.
  var isBuyerParty = false, session = null;

  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
    reload();
  }
  function reload() { Promise.all([A.get("/jobs/" + encodeURIComponent(jobId)), A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/attestation", token)]).then(onLoaded); }
  function resolveIsBuyerParty(job_) {
    if (session === null || typeof job_.buyerDid !== "string" || job_.buyerDid === "") return Promise.resolve(false);
    return A.get("/accounts/" + encodeURIComponent(job_.buyerDid)).then(function (result) {
      if (result.state !== "ok") return false;
      var account = result.value && typeof result.value === "object" ? result.value : {};
      if (session.method === "passkey") return typeof account.passkeySubject === "string" && account.passkeySubject === session.subject;
      return typeof account.githubLogin === "string" && account.githubLogin === session.subject;
    });
  }
  function failLoad(detail) { A.showById("load-error", true); A.setTextById("load-error-detail", detail); }
  function showError(idPrefix, message) { A.setTextById(idPrefix + "-detail", message); A.showById(idPrefix, true); }
  function roundHalfUpCents(amount) {
    var h = Math.round(amount * 10000), cents = Math.floor(h / 100);
    if (h - cents * 100 >= 50) cents += 1;
    return cents / 100;
  }
  function money(n) { return "$" + n.toFixed(2); }
  function padNum(n) { return n < 10 ? "0" + n : String(n); }
  var PANEL_IDS = ["load-error", "signin-required", "party-error", "not-ready-error", "fault-error", "terminal-panel", "pr-body"];
  function hideAllPanels() { PANEL_IDS.forEach(function (id) { A.showById(id, false); }); }
  // Terminal outcomes a buyer is most likely to reach by reloading name
  // what already happened, not a generic sentence.
  var TERMINAL_SENTENCES = {
    completed: "This hire is complete. The pull request merged.",
    deemed_completed: "This hire was deemed complete. The review window closed with no merge and no close recorded, so the job completed anyway.",
    cited_closed: "This hire was closed. The buyer cited a reason and no money returns.",
  };
  function onLoaded(results) {
    var jobResult = results[0], gate = results[1];
    if (jobResult.state === "absent") { failLoad("There is no hire at that address."); return; }
    if (jobResult.state !== "ok") { failLoad("The record could not be loaded just now. Reloading may work."); return; }
    if (gate.state !== "ok") { failLoad("Could not confirm your access to this hire just now. Reloading may work."); return; }
    job = jobResult.value;
    var status = gate.value.status;
    var body = gate.value.body && typeof gate.value.body === "object" ? gate.value.body : {};
    hideAllPanels();
    if (status === 401) { A.setTextById("signin-required-title", "Your session has expired. Sign in again to read where this hire is."); A.showById("signin-required", true); return; }
    if (status === 403) { showError("party-error", typeof body.error === "string" && body.error !== "" ? body.error : "Only the buyer and the agent named on this hire can read this screen."); return; }
    // Non-submitted status renders the not-ready/terminal panel, never
    // the pull request body.
    if (job.status !== "submitted") { showNotReadyOrTerminal(job.status); return; }
    // A 404 on the attestation is NOT a fault here (unlike staged): it
    // means no diff line, and the page still renders.
    var attestation = null;
    if (status === 200) {
      var subject = body.credentialSubject && typeof body.credentialSubject === "object" ? body.credentialSubject : {};
      attestation = subject.attestation && typeof subject.attestation === "object" ? subject.attestation : null;
    } else if (status !== 404) {
      failLoad("Your access to this hire could not be confirmed just now. Reloading may work.");
      return;
    }
    A.showById("pr-body", true);
    renderWho(job); renderLede(job); renderPrLink(job, attestation); renderClock(job); renderTechnical(job);
    resolveIsBuyerParty(job).then(function (result) { isBuyerParty = result; renderActs(job); renderClosePicker(job); });
  }
  function showNotReadyOrTerminal(status) {
    if (Object.prototype.hasOwnProperty.call(TERMINAL_SENTENCES, status)) {
      A.setTextById("terminal-title", TERMINAL_SENTENCES[status]);
      A.setTextById("terminal-detail", "There is nothing further to do on this screen.");
      var terminalLink = A.el("terminal-link");
      if (terminalLink) terminalLink.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
      A.showById("terminal-panel", true);
      return;
    }
    A.setTextById("not-ready-detail", "This hire's status is \"" + status + "\", not submitted. Reload this page or return to the hire to see its current state.");
    var link = A.el("not-ready-link");
    if (link) link.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    A.showById("not-ready-error", true);
  }
  function renderWho(job_) {
    var repoLine = A.el("repo-line");
    if (repoLine) repoLine.textContent = typeof job_.repository === "string" ? job_.repository : "";
    var agentDid = typeof job_.agentDid === "string" ? job_.agentDid : "";
    if (agentDid === "") return;
    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      var name = A.shortDid(agentDid);
      if (result.state === "ok") {
        name = typeof result.value.name === "string" && result.value.name !== "" ? result.value.name : agentDid;
        A.setAvatar(A.el("agent-avatar"), result.value.avatar);
      }
      A.setTextById("agent-name", name);
    });
    // Read, never assumed. Absent on a failed read or a zero count.
    A.get("/agents/" + encodeURIComponent(agentDid) + "/hires").then(function (result) {
      if (result.state !== "ok") return;
      var counts = result.value.counts && typeof result.value.counts === "object" ? result.value.counts : null;
      if (counts === null || typeof counts.hires !== "number" || counts.hires <= 0) return;
      A.setTextById("agent-hires", A.plural(counts.hires, "verified hire", "verified hires"));
    });
  }

  // No payment date, ever: paid in full is implied by the job existing
  // (POST .../pull-request answers 402 until settled); the date named
  // is submittedAt, a recorded projection fact.
  function renderLede(job_) {
    var submittedDate = A.readableDate(job_.submittedAt);
    A.setTextById("lede", "Paid in full. The pull request opened" + (submittedDate ? " on " + submittedDate : "") + ". The merge button is yours, in your repository.");
  }

  // The diff line renders only from the signed attestation. The
  // anchor's href is set only once the URL parses and its origin is
  // https://github.com; otherwise it renders as text with no anchor.
  function renderPrLink(job_, attestation) {
    var prlink = A.el("prlink");
    var url = typeof job_.pullRequestUrl === "string" ? job_.pullRequestUrl : "";
    var githubOrigin = false, parsed = null;
    if (url !== "") {
      try { parsed = new URL(url); githubOrigin = parsed.origin === "https://github.com"; }
      catch (e) { githubOrigin = false; }
    }
    var repoLabel = typeof job_.repository === "string" ? job_.repository : "";
    var linkText = repoLabel !== "" ? repoLabel : url;
    if (prlink) {
      var textNode = document.createElement(githubOrigin ? "a" : "span");
      if (githubOrigin) textNode.setAttribute("href", url);
      textNode.textContent = linkText;
      var diffSpan = A.el("pr-diff");
      prlink.textContent = "";
      prlink.appendChild(textNode);
      if (diffSpan) prlink.appendChild(diffSpan);
    }
    if (attestation !== null && typeof attestation.linesAdded === "number" && typeof attestation.linesRemoved === "number" && typeof attestation.filesChanged === "number") {
      A.setText(A.el("pr-diff"), "+" + attestation.linesAdded + " / -" + attestation.linesRemoved + ", " + A.plural(attestation.filesChanged, "file", "files"));
      A.showById("pr-diff", true);
    } else {
      A.showById("pr-diff", false);
    }
    A.setTextById("pr-provenance", "Opened by FreeAgents from a staging repository it controls, at the commit the agent attested. FreeAgents has never had write access to " + (repoLabel !== "" ? repoLabel : "your repository") + " and cannot be given it.");
    var openWrap = A.el("pr-open-wrap");
    if (openWrap) {
      openWrap.textContent = "";
      if (githubOrigin) {
        var openBtn = document.createElement("a");
        openBtn.className = "btn btn-primary";
        openBtn.setAttribute("href", url);
        openBtn.textContent = "Open the pull request on GitHub";
        openWrap.appendChild(openBtn);
      }
    }
  }

  // The deadline is submittedAt + DEEM_COMPLETED_AFTER_DAYS, never the
  // projection's own `deadline`. A date and a consequence, never a
  // countdown; the reversed clock is stated in full prose.
  function renderClock(job_) {
    var submittedAtMs = typeof job_.submittedAt === "string" ? Date.parse(job_.submittedAt) : NaN;
    var deadlineText = isNaN(submittedAtMs) ? "" : A.readableDate(new Date(submittedAtMs + DEEM_COMPLETED_AFTER_DAYS * MS_PER_DAY).toISOString());
    A.setTextById("clock-days", A.plural(DEEM_COMPLETED_AFTER_DAYS, "day", "days") + " to review" + (deadlineText ? ", until " + deadlineText + "." : "."));
    A.setTextById("clock-then", "If you merge, the job completes and a receipt is issued. If you do nothing by then, the job is recorded as completed anyway, with a receipt that says plainly that no merge was observed. The agent has delivered and been paid, so silence does not take that back.");
  }
  // Same computation P8j uses, from the same constants.
  function remainderAndFee(price) {
    var priceUsd = parseFloat(price.priceUsd);
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    var deposit = roundHalfUpCents((priceUsd * depositPercent) / 100);
    var remainder = roundHalfUpCents(priceUsd - deposit);
    var fee = roundHalfUpCents(remainder * (ABT_FEE_RATE_PERCENT / 100));
    var depositFee = roundHalfUpCents(deposit * (ABT_FEE_RATE_PERCENT / 100));
    return { deposit: deposit, depositFee: depositFee, remainder: remainder, fee: fee };
  }
  function renderTechnical(job_) {
    A.setTextById("prtech-note", "The state of this job comes from GitHub's API, not from either party telling us anything. A receipt is issued on an observed merge, or at the deemed-completion mark with a distinct type that records the staged commit and states that no merge was seen.");
    A.setTextById("tech-job-id", typeof job_.id === "string" ? job_.id : "");
    var copyJobId = A.el("copy-job-id");
    if (copyJobId) copyJobId.setAttribute("data-copy", typeof job_.id === "string" ? job_.id : "");
    A.setTextById("tech-staged-commit", typeof job_.stagedCommit === "string" ? job_.stagedCommit : "");
    var copyCommit = A.el("copy-staged-commit");
    if (copyCommit) copyCommit.setAttribute("data-copy", typeof job_.stagedCommit === "string" ? job_.stagedCommit : "");
    // Amounts only, no dates, on the deposit/balance rows.
    var price = job_.price && typeof job_.price === "object" ? job_.price : null;
    if (price !== null && typeof price.priceUsd === "string") {
      var figures = remainderAndFee(price);
      A.setTextById("tech-deposit", money(figures.deposit) + " plus " + money(figures.depositFee) + " fee, buyer to operator");
      A.setTextById("tech-balance", money(figures.remainder) + " plus " + money(figures.fee) + " fee, buyer to operator");
    } else {
      A.setTextById("tech-deposit", "not recorded");
      A.setTextById("tech-balance", "not recorded");
    }
  }
  // The close control renders only when this session resolves to the
  // job's buyer, removed from the document entirely rather than
  // disabled, the same stance staged.js holds for redo/decline.
  function renderActs(job_) {
    var closeBtn = A.el("close-btn");
    if (!isBuyerParty) { if (closeBtn && closeBtn.parentNode) closeBtn.parentNode.removeChild(closeBtn); }
    else if (closeBtn) { closeBtn.hidden = false; }
    void job_;
  }

  // One picker row per job.criteria, in stored order, numbered from 1.
  // The value posted is the array index regardless of the label.
  // Nothing preselected; send stays disabled until both a line is
  // chosen and the sentence is non-empty.
  function renderClosePicker(job_) {
    var host = A.el("close-picker");
    if (!host) return;
    host.textContent = "";
    closeSelectedIndex = null;
    var sendBtn = A.el("close-send-btn");
    if (sendBtn) sendBtn.disabled = true;
    var criteria = Array.isArray(job_.criteria) ? job_.criteria : [];
    criteria.forEach(function (c, i) {
      var li = document.createElement("li");
      var label = document.createElement("label");
      var input = document.createElement("input");
      input.type = "radio"; input.name = "closeline"; input.value = String(i);
      input.addEventListener("change", function () { closeSelectedIndex = i; updateSendEnabled(); });
      var span = document.createElement("span");
      span.textContent = padNum(i + 1) + "\u00A0\u00A0" + (typeof c.text === "string" ? c.text : "");
      label.appendChild(input); label.appendChild(span); li.appendChild(label); host.appendChild(li);
    });
    var price = job_.price && typeof job_.price === "object" ? job_.price : null;
    var priceUsd = price !== null && typeof price.priceUsd === "string" ? "$" + parseFloat(price.priceUsd).toFixed(2) : "";
    A.setTextById("close-consequence-lede", "Closing stops the receipt. Nothing is refunded" + (priceUsd ? ": you have paid the full " + priceUsd : "") + " and it stays with the agent.");
  }
  var closeWhyInput = A.el("close-why");
  function updateSendEnabled() {
    var sendBtn = A.el("close-send-btn");
    if (!sendBtn) return;
    var why = closeWhyInput ? closeWhyInput.value : "";
    sendBtn.disabled = closeSelectedIndex === null || why.trim() === "";
  }
  if (closeWhyInput) closeWhyInput.addEventListener("input", updateSendEnabled);
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
  var closeDialogEl = A.el("close");
  if (closeDialogEl) {
    Array.prototype.forEach.call(closeDialogEl.querySelectorAll("[data-closes]"), function (btn) { btn.addEventListener("click", function () { closeDialog("close"); }); });
  }

  var closeBtnTop = A.el("close-btn");
  if (closeBtnTop) closeBtnTop.addEventListener("click", function () { openDialog("close"); });

  // Every refusal from cited-close gets its own sentence.
  function closeRefusalSentence(status, serverMessage) {
    if (status === 400) return "This screen sent a malformed request. Reload the page and try again.";
    if (status === 401) return "Your session has expired. Sign in again to close this hire.";
    if (status === 403) return serverMessage || "This account is not a party to this hire.";
    if (status === 402) return "The remainder has not settled; this hire cannot be closed until it does.";
    if (status === 409) return "This hire is no longer at a step where it can be closed this way. Reloading shows its current state.";
    if (status === 404) return "There is no hire at that address.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The request could not complete just now. Try again in a moment.";
  }

  // Posts { criterionIndex, reasonText } and nothing else, exactly
  // once. Disables on press and never re-enables on success.
  var closeSendBtn = A.el("close-send-btn");
  if (closeSendBtn) {
    closeSendBtn.addEventListener("click", function () {
      if (closeSelectedIndex === null) return;
      var reasonText = closeWhyInput ? closeWhyInput.value.trim() : "";
      if (reasonText === "") return;
      A.showById("close-error", false);
      closeSendBtn.disabled = true;
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/cited-close", token, { criterionIndex: closeSelectedIndex, reasonText: reasonText }).then(function (result) {
        if (result.state !== "ok") { closeSendBtn.disabled = false; showError("close-error", "Could not reach the server just now. Try again in a moment."); return; }
        var status = result.value.status;
        var respBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        var serverMessage = typeof respBody.error === "string" ? respBody.error : "";
        if (status === 200 || status === 409) { closeDialog("close"); reload(); return; }
        closeSendBtn.disabled = false;
        showError("close-error", closeRefusalSentence(status, serverMessage));
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
