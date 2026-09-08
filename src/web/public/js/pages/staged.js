/* P8k staged (P-13): a staged hire's buyer reads the machine-written
   account of the work, then pays, sends it back once, or declines.
   No route in src/api/app.ts changes. Reads GET /jobs/:jobId and
   GET /jobs/:jobId/attestation (the party probe, agreement.js/deposit.js's
   own pattern, no side effect). P8j shipped pay alone (ruling 1 of that
   card); this card adds POST /jobs/:jobId/redo and
   POST /jobs/:jobId/staged-decline, both buyer-only.

   Departures from spec/wireframe/staged.html, named per the handoff:
   the redo picker's free-text field does not ship (ruling 1: the route
   reads only { criterionIndex }, nothing else is stored); the picker's
   numbering and pickernote wording match agreement.js's own numbering,
   not the wireframe's 01-07 fixture (ruling 2); the decline dialog
   renders four consequence rows, never the wireframe's fifth
   (an agent-side declined count that does not exist anywhere in this
   codebase, ruling 3); the decline dialog's deposit figure is computed
   from depositUsd(priceUsd, depositPercent), never the wireframe's
   literal (ruling 4).

   outOfCriteriaPathCount never renders (ruling 2, structurally always
   equals filesChanged). The clock states a fixed window and a deadline
   date, never a countdown (ruling 4); LAPSE_AT_STAGED_AFTER_DAYS and
   REDO_LAPSE_EXTENSION_DAYS are browser constants pinned by a test
   against the domain's own. Pays over ABT on the REMAINDER, never the
   deposit (ruling 5 of P8j). Never claims settlement; every re-read
   fires only on a press (ruling 6). Both redo_requested and
   staged_declined render on this page now (ruling 5): the former keeps
   the clock and the account of the work with no control, the latter is
   a terminal panel with no control. Every refusal gets its own sentence
   (scope item 4). Everything through textContent (api.js rule 3). */
(function () {
  "use strict";
  var A = window.FAApi;
  var LAPSE_AT_STAGED_AFTER_DAYS = 7, REDO_LAPSE_EXTENSION_DAYS = 7, ABT_FEE_RATE_PERCENT = 3, MS_PER_DAY = 86400000;
  var jobId = "", token = "", job = null, currentFigures = null, redoSelectedIndex = null;

  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    var session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
    reload();
  }
  function reload() {
    Promise.all([A.get("/jobs/" + encodeURIComponent(jobId)), A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/attestation", token)]).then(onLoaded);
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

  // A panel this page can show; hiding every one before showing the
  // right one keeps a re-render after redo/decline from leaving a stale
  // panel visible underneath the new one.
  var PANEL_IDS = ["load-error", "signin-required", "party-error", "not-ready-error", "fault-error", "declined-panel", "staged-body"];
  function hideAllPanels() { PANEL_IDS.forEach(function (id) { A.showById(id, false); }); }

  function onLoaded(results) {
    var jobResult = results[0], gate = results[1];
    if (jobResult.state === "absent") { failLoad("There is no hire at that address."); return; }
    if (jobResult.state !== "ok") { failLoad("The record could not be loaded just now. Reloading may work."); return; }
    if (gate.state !== "ok") { failLoad("Could not confirm your access to this hire just now. Reloading may work."); return; }
    job = jobResult.value;
    var status = gate.value.status;
    var body = gate.value.body && typeof gate.value.body === "object" ? gate.value.body : {};
    hideAllPanels();
    if (status === 401) {
      A.setTextById("signin-required-title", "Your session has expired. Sign in again to read the account of the work.");
      A.showById("signin-required", true);
      return;
    }
    if (status === 403) {
      showError("party-error", typeof body.error === "string" && body.error !== "" ? body.error : "Only the buyer and the agent named on this hire can read this screen.");
      return;
    }
    // Ruling 5: staged_declined is terminal, no control, a link back.
    if (job.status === "staged_declined") { showDeclined(); return; }
    // Ruling 5: redo_requested renders on this page too, not the
    // not-ready panel: GET .../attestation has no status gate, and the
    // staged clock keeps running through this status.
    if (job.status !== "staged" && job.status !== "redo_requested") { showNotReady(job.status); return; }
    if (status === 404) { A.showById("fault-error", true); return; }
    if (status !== 200) { failLoad("Your access to this hire could not be confirmed just now. Reloading may work."); return; }
    var subject = body.credentialSubject && typeof body.credentialSubject === "object" ? body.credentialSubject : {};
    var attestation = subject.attestation && typeof subject.attestation === "object" ? subject.attestation : null;
    if (attestation === null) { A.showById("fault-error", true); return; }
    A.showById("staged-body", true);
    renderLede(job);
    renderClock(job);
    renderFacts(attestation);
    renderChoicesSection(job);
    renderTechnical(attestation);
    renderWho(job);
  }

  function showDeclined() {
    var link = A.el("declined-link");
    if (link) link.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    A.showById("declined-panel", true);
  }

  function showNotReady(status) {
    A.setTextById("not-ready-detail", "This hire's status is \"" + status + "\", not staged. Reload this page or return to the hire to see its current state.");
    var link = A.el("not-ready-link");
    if (link) link.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    A.showById("not-ready-error", true);
  }

  function renderLede(job_) {
    var stagedDate = A.readableDate(job_.stagedAt);
    A.setTextById("lede", (stagedDate ? "The agent staged its work on " + stagedDate + ". " : "The agent has staged its work. ") +
      "Here is what is in it. Pay the balance and the pull request opens on your repository, where you read the code and decide whether to merge.");
  }

  // Ruling 4 (P8j): a date and a consequence, never a countdown.
  function renderClock(job_) {
    var redo = job_.redo && typeof job_.redo === "object" ? job_.redo : null;
    var extension = redo !== null && typeof redo.stagedLapseExtensionDays === "number" ? redo.stagedLapseExtensionDays : 0;
    var windowDays = LAPSE_AT_STAGED_AFTER_DAYS + extension;
    var stagedAtMs = typeof job_.stagedAt === "string" ? Date.parse(job_.stagedAt) : NaN;
    var deadlineText = isNaN(stagedAtMs) ? "" : A.readableDate(new Date(stagedAtMs + windowDays * MS_PER_DAY).toISOString());
    A.setTextById("clock-days", A.plural(windowDays, "day", "days") + " to decide" + (deadlineText ? ", until " + deadlineText + "." : "."));
    var price = job_.price && typeof job_.price === "object" ? job_.price : null;
    var depositLine = "";
    if (price !== null && typeof price.priceUsd === "string") {
      var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
      depositLine = ", and the " + money(roundHalfUpCents((parseFloat(price.priceUsd) * depositPercent) / 100)) + " deposit stays with the operator";
    }
    A.setTextById("clock-then", "If you have not decided by then the job closes, the code stays in staging and never reaches your repository" + depositLine + ". Nothing further is charged.");
  }

  function factRow(label, valueText, listItems) {
    var li = document.createElement("li");
    var f = document.createElement("span"); f.className = "f"; f.textContent = label;
    var v = document.createElement("span"); v.className = "v"; v.textContent = valueText;
    li.appendChild(f); li.appendChild(v);
    if (listItems && listItems.length > 0) {
      var ul = document.createElement("ul"); ul.className = "paths";
      listItems.forEach(function (item) { var pli = document.createElement("li"); pli.textContent = item; ul.appendChild(pli); });
      li.appendChild(ul);
    }
    return li;
  }
  function choiceRow(k, v, para) {
    var li = document.createElement("li");
    var kSpan = document.createElement("span"); kSpan.className = "k"; kSpan.textContent = k;
    var vSpan = document.createElement("span"); vSpan.className = "v"; vSpan.textContent = v;
    var pSpan = document.createElement("span"); pSpan.className = "para"; pSpan.textContent = para;
    li.appendChild(kSpan); li.appendChild(vSpan); li.appendChild(pSpan);
    return li;
  }

  // Scope item 6 (P8j): six rows, fixed order, ruling 2's row omitted.
  function renderFacts(attestation) {
    var host = A.el("facts");
    host.textContent = "";
    host.appendChild(factRow("Files changed", String(attestation.filesChanged)));
    var linesLi = factRow("Lines", ""), linesV = linesLi.querySelector(".v");
    linesV.textContent = "";
    linesV.classList.add("diffline");
    var addSpan = document.createElement("span"); addSpan.className = "add"; addSpan.textContent = "+" + attestation.linesAdded;
    var delSpan = document.createElement("span"); delSpan.className = "del"; delSpan.textContent = "-" + attestation.linesRemoved;
    linesV.appendChild(addSpan); linesV.appendChild(document.createTextNode(" / ")); linesV.appendChild(delSpan);
    host.appendChild(linesLi);
    var paths = Array.isArray(attestation.changedPaths) ? attestation.changedPaths : [];
    host.appendChild(factRow("Where the changes are", A.plural(paths.length, "path", "paths"), paths));
    var testsDeleted = Array.isArray(attestation.testsDeleted) ? attestation.testsDeleted : [];
    host.appendChild(factRow("Tests deleted", String(testsDeleted.length), testsDeleted));
    var testsSkipped = Array.isArray(attestation.testsSkipAdded) ? attestation.testsSkipAdded : [];
    host.appendChild(factRow("Tests newly skipped", String(testsSkipped.length), testsSkipped));
    var signers = Array.isArray(attestation.commitSigners) ? attestation.commitSigners : [];
    var matching = signers.filter(function (s) { return s.matchesAgentDid === true; }).length;
    host.appendChild(factRow("Commits signed by the agent", matching + " of " + signers.length));
  }

  // Ruling 5 of P8j: remainderUsd(priceUsd, depositPercent), fee at
  // ABT_FEE_RATE_PERCENT on the remainder, half-up per payment.ts.
  function remainderAndFee(price) {
    var priceUsd = parseFloat(price.priceUsd);
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    var deposit = roundHalfUpCents((priceUsd * depositPercent) / 100);
    var remainder = roundHalfUpCents(priceUsd - deposit);
    var fee = roundHalfUpCents(remainder * (ABT_FEE_RATE_PERCENT / 100));
    return { deposit: deposit, remainder: remainder, fee: fee, total: roundHalfUpCents(remainder + fee) };
  }

  // How many redos this job has spent. Zero when no redo has ever been
  // requested (the projection's redo object only joins once one has),
  // never guessed from anything else (app.ts:404-414, ruling 6).
  function redoUsedCount(job_) {
    var redo = job_.redo && typeof job_.redo === "object" ? job_.redo : null;
    return redo !== null && typeof redo.usedCount === "number" ? redo.usedCount : 0;
  }
  function redoAllowanceOf(job_) {
    var price = job_.price && typeof job_.price === "object" ? job_.price : {};
    return typeof price.redoAllowance === "number" ? price.redoAllowance : 1;
  }
  function depositFigure(job_) {
    var price = job_.price && typeof job_.price === "object" ? job_.price : null;
    if (price === null || typeof price.priceUsd !== "string") return null;
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    return roundHalfUpCents((parseFloat(price.priceUsd) * depositPercent) / 100);
  }

  // Choices list (ruling: stays and stays accurate). Real computed
  // amounts, no button anywhere in this list; the redo row's wording
  // changes to "spent" once the allowance is exhausted.
  function renderChoices(job_) {
    var price = job_.price && typeof job_.price === "object" ? job_.price : {};
    var priceUsd = typeof price.priceUsd === "string" ? parseFloat(price.priceUsd) : NaN;
    var figures = isNaN(priceUsd) ? null : remainderAndFee(price);
    var redoAllowance = redoAllowanceOf(job_);
    var exhausted = redoUsedCount(job_) >= redoAllowance;
    var host = A.el("choices");
    host.textContent = "";
    if (figures !== null) {
      host.appendChild(choiceRow("Pay the balance", money(figures.total),
        money(figures.remainder) + " of the " + money(priceUsd) + " price, plus the " + ABT_FEE_RATE_PERCENT + " percent fee. When it clears, the pull request opens on your repository and you read the code there. Merging is yours, on GitHub."));
    }
    host.appendChild(choiceRow(
      exhausted ? "Send it back" : (redoAllowance === 1 ? "Send it back once" : "Send it back"),
      exhausted ? "spent" : (redoAllowance === 1 ? "free, once per hire" : "free, " + redoAllowance + " times per hire"),
      exhausted
        ? "You have used this hire's redo already. Pay or decline are the two choices left."
        : "Pick which of the lines you agreed it missed. Nothing is charged and the deadline above moves " + A.plural(REDO_LAPSE_EXTENSION_DAYS, "day", "days") + ". The operator can refuse, and if it does you are back on this screen with the same three choices."));
    host.appendChild(choiceRow("Decline", "free and final",
      "You owe nothing more, the code never leaves staging, and the deposit stays with the operator. It is recorded on your own record that this happened, with no reason attached and no judgement about the work."));
    currentFigures = figures;
    var payBtn = A.el("pay-btn");
    if (payBtn) {
      if (figures !== null) { payBtn.textContent = "Pay the balance, " + money(figures.total); payBtn.disabled = false; }
      else { payBtn.textContent = "No agreed price to pay against"; payBtn.disabled = true; }
    }
  }

  // Ruling 6: the redo control renders only when a redo can actually be
  // requested. No disabled button, no stub: the button is removed from
  // the document entirely once the allowance is spent, never merely
  // hidden or disabled.
  function renderActs(job_) {
    var exhausted = redoUsedCount(job_) >= redoAllowanceOf(job_);
    var redoBtn = A.el("redo-btn");
    if (exhausted) {
      if (redoBtn && redoBtn.parentNode) redoBtn.parentNode.removeChild(redoBtn);
    } else if (redoBtn) {
      redoBtn.hidden = false;
    }
  }

  // Ruling 2: the picker's rows are exactly job.criteria, in stored
  // order, numbered the way agreement.js numbers the same lines (from 1,
  // in render order, criteria always contiguous since price and
  // delivery are appended after). The value posted is the array index
  // regardless of the label. Nothing is preselected (a live screen is
  // not a screenshot of a decision already made); send stays disabled
  // until a line is chosen.
  function renderRedoPicker(job_) {
    var host = A.el("redo-picker");
    if (!host) return;
    host.textContent = "";
    redoSelectedIndex = null;
    var sendBtn = A.el("redo-send-btn");
    if (sendBtn) sendBtn.disabled = true;
    var criteria = Array.isArray(job_.criteria) ? job_.criteria : [];
    criteria.forEach(function (c, i) {
      var li = document.createElement("li");
      var label = document.createElement("label");
      var input = document.createElement("input");
      input.type = "radio";
      input.name = "rline";
      input.value = String(i);
      input.addEventListener("change", function () {
        redoSelectedIndex = i;
        if (sendBtn) sendBtn.disabled = false;
      });
      var span = document.createElement("span");
      span.textContent = padNum(i + 1) + "\u00A0\u00A0" + (typeof c.text === "string" ? c.text : "");
      label.appendChild(input);
      label.appendChild(span);
      li.appendChild(label);
      host.appendChild(li);
    });
    A.setTextById("redo-pickernote", "The price and the delivery date are lines in the agreement, but they are not something the work can miss, so they are not here.");
    A.setTextById("redo-cost-note", "This costs nothing and moves the delivery date forward " + A.plural(REDO_LAPSE_EXTENSION_DAYS, "day", "days") + ". You get " + A.plural(redoAllowanceOf(job_), "redo", "redos") + " per hire and this uses it. The operator can refuse, and if it does you are back on the same three choices with nothing charged.");
  }

  // Ruling 3: four consequence rows, never the wireframe's fifth (no
  // agent-side declined count exists anywhere in this codebase).
  // Ruling 4: the deposit figure is computed, never a literal.
  function renderDeclineConsequences(job_) {
    var host = A.el("decline-consequences");
    if (!host) return;
    host.textContent = "";
    var deposit = depositFigure(job_);
    var depositText = deposit === null ? "stays with the operator" : money(deposit) + " stays with the operator";
    [
      ["You pay", "nothing more"],
      ["The deposit", depositText],
      ["The code", "never leaves staging"],
      ["Your record", "gains one declined hire"],
    ].forEach(function (row) {
      var li = document.createElement("li");
      var k = document.createElement("span"); k.className = "k"; k.textContent = row[0];
      var v = document.createElement("span"); v.className = "v"; v.textContent = row[1];
      li.appendChild(k); li.appendChild(v);
      host.appendChild(li);
    });
  }

  // Ruling 5: two rendered branches at the choices section. staged shows
  // the three controls and the choices list; redo_requested shows one
  // sentence and no control at all.
  function renderChoicesSection(job_) {
    var pending = job_.status === "redo_requested";
    A.showById("choices-section", !pending);
    A.showById("redo-pending-note", pending);
    if (pending) {
      // Matches src/web/public/js/pages/job.js's own redo_requested
      // sentence verbatim: a buyer should not read two different
      // sentences about one fact.
      A.setTextById("redo-pending-note", "The buyer has asked for a redo on the staged work. The operator has not yet answered.");
      return;
    }
    renderChoices(job_);
    renderActs(job_);
    renderRedoPicker(job_);
    renderDeclineConsequences(job_);
  }

  function renderTechnical(attestation) {
    A.setTextById("tech-staged-commit", typeof attestation.stagedCommit === "string" ? attestation.stagedCommit : "");
    var copyCommit = A.el("copy-staged-commit");
    if (copyCommit) copyCommit.setAttribute("data-copy", typeof attestation.stagedCommit === "string" ? attestation.stagedCommit : "");
    A.setTextById("tech-diff-hash", typeof attestation.diffHash === "string" ? attestation.diffHash : "");
    var copyHash = A.el("copy-diff-hash");
    if (copyHash) copyHash.setAttribute("data-copy", typeof attestation.diffHash === "string" ? attestation.diffHash : "");
    var share = attestation.lineShareByCategory && typeof attestation.lineShareByCategory === "object" ? attestation.lineShareByCategory : {};
    var named = ["source", "test", "lockfile", "generated", "vendored"];
    var sum = named.reduce(function (acc, key) { return acc + (typeof share[key] === "number" ? share[key] : 0); }, 0);
    var parts = named.map(function (key) { return key + " " + (typeof share[key] === "number" ? share[key] : 0) + " percent"; });
    parts.push("other " + (100 - sum) + " percent");
    A.setTextById("tech-line-share", parts.join(", "));
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
    // Scope item 9 (P8j): read, never assumed. Absent on a failed read or
    // a zero count, never an invented business metric.
    A.get("/agents/" + encodeURIComponent(agentDid) + "/hires").then(function (result) {
      if (result.state !== "ok") return;
      var counts = result.value.counts && typeof result.value.counts === "object" ? result.value.counts : null;
      if (counts === null || typeof counts.hires !== "number" || counts.hires <= 0) return;
      A.setTextById("agent-hires", A.plural(counts.hires, "verified hire", "verified hires"));
    });
  }

  // Scope item 4: every refusal from pay-start gets its own sentence.
  function refusalSentence(status, serverMessage) {
    if (status === 401) return "Your session has expired. Sign in again to pay the balance.";
    if (status === 403) return serverMessage || "This account is not a party to this hire.";
    if (status === 409) return "There is no agreed price to pay against. Reload the page to see the latest state.";
    if (status === 503) {
      return serverMessage.toLowerCase().indexOf("abt") !== -1
        ? "Payment is not available on this deployment right now. Nothing was charged."
        : "Storage is unavailable just now. Try again in a moment.";
    }
    return serverMessage || "The request could not complete just now. Try again in a moment.";
  }

  // Scope item 4: the redo route's own refusals. 400 is a fault in this
  // screen, never the buyer's mistake. 409 with the allowance message is
  // distinct from every other sentence here; the OTHER 409 (someone
  // acted first) is handled by the caller, which reloads instead of
  // showing this sentence.
  function redoRefusalSentence(status, serverMessage) {
    if (status === 400) return "This screen sent a malformed request. Reload the page and try again.";
    if (status === 401) return "Your session has expired. Sign in again to send this work back.";
    if (status === 403) return serverMessage || "This account is not a party to this hire.";
    if (status === 409) return "There is no redo left on this hire.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The request could not complete just now. Try again in a moment.";
  }

  function declineRefusalSentence(status, serverMessage) {
    if (status === 401) return "Your session has expired. Sign in again to decline this hire.";
    if (status === 403) return serverMessage || "This account is not a party to this hire.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The request could not complete just now. Try again in a moment.";
  }

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
  ["scan", "redo", "decline"].forEach(function (id) {
    var dialog = A.el(id);
    if (dialog) {
      Array.prototype.forEach.call(dialog.querySelectorAll("[data-closes]"), function (btn) {
        btn.addEventListener("click", function () { closeDialog(id); });
      });
    }
  });

  // Ruling 1 (P8j): the one control that card shipped. Posts to the
  // REMAINDER leg only, never deposit.
  var payBtn = A.el("pay-btn");
  if (payBtn) {
    payBtn.addEventListener("click", function () {
      if (currentFigures === null) return;
      A.showById("pay-error", false);
      payBtn.disabled = true;
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/payments/remainder/abt/start", token, {}).then(function (result) {
        payBtn.disabled = false;
        if (result.state !== "ok") { showError("pay-error", "Could not reach the server just now. Try again in a moment."); return; }
        var status = result.value.status;
        var respBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status !== 200) { showError("pay-error", refusalSentence(status, typeof respBody.error === "string" ? respBody.error : "")); return; }
        openScan(typeof respBody.url === "string" ? respBody.url : "");
      });
    });
  }

  // Byte-identical to the route's own `url`, never re-derived (a test
  // asserts this, mirroring P8i's own mutation proof).
  function openScan(url) {
    if (currentFigures !== null) {
      A.setTextById("scan-total", money(currentFigures.total));
      A.setTextById("scan-remainder", money(currentFigures.remainder));
      A.setTextById("scan-fee", money(currentFigures.fee));
      A.setTextById("scan-total-2", money(currentFigures.total));
    }
    var urlField = A.el("scan-url");
    if (urlField) urlField.value = url;
    var copyBtn = A.el("scan-url-copy");
    if (copyBtn) copyBtn.setAttribute("data-copy", url);
    A.showById("scan-pr-wrap", false);
    openDialog("scan");
  }

  // Ruling 6 (P8j): the only re-read on the pay path, fired on a press
  // and never by a timer. Never claims settlement itself: shows the
  // pull request link only when the job's own pullRequestUrl is present.
  var checkPrBtn = A.el("check-pr-btn");
  if (checkPrBtn) {
    checkPrBtn.addEventListener("click", function () {
      A.get("/jobs/" + encodeURIComponent(jobId)).then(function (result) {
        if (result.state !== "ok") return;
        var url = typeof result.value.pullRequestUrl === "string" ? result.value.pullRequestUrl : "";
        if (url === "") return;
        var link = A.el("scan-pr-link");
        if (link) link.setAttribute("href", url);
        A.showById("scan-pr-wrap", true);
      });
    });
  }

  // Ruling 6: opens the picker dialog. The button itself may be absent
  // from the document (allowance spent), in which case there is nothing
  // to wire.
  var redoBtnTop = A.el("redo-btn");
  if (redoBtnTop) redoBtnTop.addEventListener("click", function () { openDialog("redo"); });

  var declineBtnTop = A.el("decline-btn");
  if (declineBtnTop) declineBtnTop.addEventListener("click", function () { openDialog("decline"); });

  // Rulings 1, 2, 6: posts { criterionIndex } and nothing else, exactly
  // once. Disables on press and never re-enables on success (mutation
  // proof 12). A 409 naming the exhausted allowance is a refusal shown
  // in place; a 409 naming anything else means someone acted on this
  // hire first, so this reloads and re-renders rather than leaving a
  // stale screen (scope item 4).
  var redoSendBtn = A.el("redo-send-btn");
  if (redoSendBtn) {
    redoSendBtn.addEventListener("click", function () {
      if (redoSelectedIndex === null) return;
      A.showById("redo-error", false);
      redoSendBtn.disabled = true;
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/redo", token, { criterionIndex: redoSelectedIndex }).then(function (result) {
        if (result.state !== "ok") {
          redoSendBtn.disabled = false;
          showError("redo-error", "Could not reach the server just now. Try again in a moment.");
          return;
        }
        var status = result.value.status;
        var respBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        var serverMessage = typeof respBody.error === "string" ? respBody.error : "";
        if (status === 200) { closeDialog("redo"); reload(); return; }
        redoSendBtn.disabled = false;
        if (status === 409 && serverMessage.toLowerCase().indexOf("redo allowance") === -1) {
          closeDialog("redo");
          reload();
          return;
        }
        showError("redo-error", redoRefusalSentence(status, serverMessage));
      });
    });
  }

  // Ruling 6: body-less, exactly once, disables on press and never
  // re-enables on success. A 409 means the hire already left staged;
  // reload rather than leaving a stale screen.
  var declineSendBtn = A.el("decline-send-btn");
  if (declineSendBtn) {
    declineSendBtn.addEventListener("click", function () {
      A.showById("decline-error", false);
      declineSendBtn.disabled = true;
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/staged-decline", token).then(function (result) {
        if (result.state !== "ok") {
          declineSendBtn.disabled = false;
          showError("decline-error", "Could not reach the server just now. Try again in a moment.");
          return;
        }
        var status = result.value.status;
        var respBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        var serverMessage = typeof respBody.error === "string" ? respBody.error : "";
        if (status === 200) { closeDialog("decline"); reload(); return; }
        declineSendBtn.disabled = false;
        if (status === 409) { closeDialog("decline"); reload(); return; }
        showError("decline-error", declineRefusalSentence(status, serverMessage));
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
