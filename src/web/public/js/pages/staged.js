/* P8j staged (P-13): a staged hire's buyer reads the machine-written
   account of the work and pays the balance. No route in src/api/app.ts
   changes. Reads GET /jobs/:jobId and GET /jobs/:jobId/attestation (the
   party probe, agreement.js/deposit.js's own pattern, no side effect).
   Ships ONE control, pay (ruling 1): redo and decline render as prose
   with real amounts, never a button or a stub. outOfCriteriaPathCount
   never renders (ruling 2, structurally always equals filesChanged).
   The clock states a fixed window and a deadline date, never a
   countdown (ruling 4); LAPSE_AT_STAGED_AFTER_DAYS and
   REDO_LAPSE_EXTENSION_DAYS are browser constants pinned by a test
   against the domain's own. Pays over ABT on the REMAINDER, never the
   deposit (ruling 5). Never claims settlement; the re-read control
   fires only on a press (ruling 6). Serves `staged` only (ruling 7).
   Everything through textContent (api.js rule 3). */
(function () {
  "use strict";
  var A = window.FAApi;
  var LAPSE_AT_STAGED_AFTER_DAYS = 7, REDO_LAPSE_EXTENSION_DAYS = 7, ABT_FEE_RATE_PERCENT = 3, MS_PER_DAY = 86400000;
  var jobId = "", token = "", job = null, currentFigures = null;
  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    var session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
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

  function onLoaded(results) {
    var jobResult = results[0], gate = results[1];
    if (jobResult.state === "absent") { failLoad("There is no hire at that address."); return; }
    if (jobResult.state !== "ok") { failLoad("The record could not be loaded just now. Reloading may work."); return; }
    if (gate.state !== "ok") { failLoad("Could not confirm your access to this hire just now. Reloading may work."); return; }
    job = jobResult.value;
    var status = gate.value.status;
    var body = gate.value.body && typeof gate.value.body === "object" ? gate.value.body : {};
    if (status === 401) {
      A.setTextById("signin-required-title", "Your session has expired. Sign in again to read the account of the work.");
      A.showById("signin-required", true);
      return;
    }
    if (status === 403) {
      showError("party-error", typeof body.error === "string" && body.error !== "" ? body.error : "Only the buyer and the agent named on this hire can read this screen.");
      return;
    }
    if (job.status !== "staged") { showNotReady(job.status); return; }
    if (status === 404) { A.showById("fault-error", true); return; }
    if (status !== 200) { failLoad("Your access to this hire could not be confirmed just now. Reloading may work."); return; }
    var subject = body.credentialSubject && typeof body.credentialSubject === "object" ? body.credentialSubject : {};
    var attestation = subject.attestation && typeof subject.attestation === "object" ? subject.attestation : null;
    if (attestation === null) { A.showById("fault-error", true); return; }
    A.showById("staged-body", true);
    renderLede(job);
    renderClock(job);
    renderFacts(attestation);
    renderChoices(job.price);
    renderTechnical(attestation);
    renderWho(job);
  }

  function showNotReady(status) {
    var detail = status === "redo_requested"
      ? "You have already asked for a redo on this work. The operator has not yet answered."
      : "This hire's status is \"" + status + "\", not staged. Reload this page or return to the hire to see its current state.";
    A.setTextById("not-ready-detail", detail);
    var link = A.el("not-ready-link");
    if (link) link.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    A.showById("not-ready-error", true);
  }

  function renderLede(job_) {
    var stagedDate = A.readableDate(job_.stagedAt);
    A.setTextById("lede", (stagedDate ? "The agent staged its work on " + stagedDate + ". " : "The agent has staged its work. ") +
      "Here is what is in it. Pay the balance and the pull request opens on your repository, where you read the code and decide whether to merge.");
  }

  // Ruling 4: a date and a consequence, never a countdown.
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

  // Scope item 6: six rows, fixed order, ruling 2's row omitted.
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

  // Ruling 5: remainderUsd(priceUsd, depositPercent), fee at
  // ABT_FEE_RATE_PERCENT on the remainder, half-up per payment.ts.
  function remainderAndFee(price) {
    var priceUsd = parseFloat(price.priceUsd);
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    var deposit = roundHalfUpCents((priceUsd * depositPercent) / 100);
    var remainder = roundHalfUpCents(priceUsd - deposit);
    var fee = roundHalfUpCents(remainder * (ABT_FEE_RATE_PERCENT / 100));
    return { deposit: deposit, remainder: remainder, fee: fee, total: roundHalfUpCents(remainder + fee) };
  }

  // Ruling 1: the wireframe's explainer, real computed amounts, no
  // button for the second or third row.
  function renderChoices(price) {
    price = price && typeof price === "object" ? price : {};
    var priceUsd = typeof price.priceUsd === "string" ? parseFloat(price.priceUsd) : NaN;
    var figures = isNaN(priceUsd) ? null : remainderAndFee(price);
    var redoAllowance = typeof price.redoAllowance === "number" ? price.redoAllowance : 1;
    var host = A.el("choices");
    host.textContent = "";
    if (figures !== null) {
      host.appendChild(choiceRow("Pay the balance", money(figures.total),
        money(figures.remainder) + " of the " + money(priceUsd) + " price, plus the " + ABT_FEE_RATE_PERCENT + " percent fee. When it clears, the pull request opens on your repository and you read the code there. Merging is yours, on GitHub."));
    }
    host.appendChild(choiceRow(redoAllowance === 1 ? "Send it back once" : "Send it back", redoAllowance === 1 ? "free, once per hire" : "free, " + redoAllowance + " times per hire",
      "Pick which of the lines you agreed it missed and say what is wrong in one sentence. Nothing is charged and the deadline above moves " + A.plural(REDO_LAPSE_EXTENSION_DAYS, "day", "days") + ". The operator can refuse, and if it does you are back on this screen with the same three choices."));
    host.appendChild(choiceRow("Decline", "free and final",
      "You owe nothing more, the code never leaves staging, and the deposit stays with the operator. It is recorded on both records that this happened, with no reason attached and no judgement about the work."));
    currentFigures = figures;
    var payBtn = A.el("pay-btn");
    if (payBtn) {
      if (figures !== null) { payBtn.textContent = "Pay the balance, " + money(figures.total); payBtn.disabled = false; }
      else { payBtn.textContent = "No agreed price to pay against"; payBtn.disabled = true; }
    }
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
    // Scope item 9: read, never assumed. Absent on a failed read or a
    // zero count, never an invented business metric.
    A.get("/agents/" + encodeURIComponent(agentDid) + "/hires").then(function (result) {
      if (result.state !== "ok") return;
      var counts = result.value.counts && typeof result.value.counts === "object" ? result.value.counts : null;
      if (counts === null || typeof counts.hires !== "number" || counts.hires <= 0) return;
      A.setTextById("agent-hires", A.plural(counts.hires, "verified hire", "verified hires"));
    });
  }

  // Scope item 10: every refusal gets a distinct, actionable sentence.
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

  // Ruling 1: the one control this card ships. Posts to the REMAINDER
  // leg only, never deposit.
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
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status !== 200) { showError("pay-error", refusalSentence(status, typeof body.error === "string" ? body.error : "")); return; }
        openScan(typeof body.url === "string" ? body.url : "");
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
    var dialog = A.el("scan");
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else if (dialog) dialog.setAttribute("open", "");
  }
  function closeScan() {
    var dialog = A.el("scan");
    if (dialog && typeof dialog.close === "function") dialog.close();
    else if (dialog) dialog.removeAttribute("open");
  }
  var scanDialog = A.el("scan");
  if (scanDialog) {
    Array.prototype.forEach.call(scanDialog.querySelectorAll("[data-closes]"), function (btn) { btn.addEventListener("click", closeScan); });
  }

  // Ruling 6: the only re-read, fired on a press and never by a timer.
  // Never claims settlement itself: shows the pull request link only
  // when the job's own pullRequestUrl is present.
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
