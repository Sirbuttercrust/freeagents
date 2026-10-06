/* P8k staged (P-13): a staged hire's buyer reads the machine-written
   account of the work, then pays, sends it back once, or declines.
   No route in src/api/app.ts changes. Reads GET /jobs/:jobId and
   GET /jobs/:jobId/attestation (the party probe, agreement.js/deposit.js's
   own pattern, no side effect), and GET /jobs/:jobId/payments with the
   same session: once the balance leg has settled the page says so and
   offers no choice at all (renderPaid). P8j shipped pay alone (ruling 1 of that
   card); this card adds POST /jobs/:jobId/redo and
   POST /jobs/:jobId/staged-decline, both buyer-only.

   W-staged put this page on the polished visual system: staged.html links
   flow.css and polish.css and runs swarm.js and polish.js, and the .who
   avatar is the DID-derived creature painted by renderWho below rather
   than the server's agent.avatar field. Nothing else in this file's
   behaviour moved.

   Departures from spec/wireframe/staged.html, named per the handoff and
   restated beside the markup each governs in staged.html:
   the redo picker's free-text field does not ship (ruling 1: the route
   reads only { criterionIndex }, nothing else is stored); the picker's
   numbering and pickernote wording match agreement.js's own numbering,
   not the wireframe's 01-07 fixture (ruling 2); the decline dialog
   renders four consequence rows, never the wireframe's fifth
   (an agent-side declined count that does not exist anywhere in this
   codebase, ruling 3); the decline dialog's deposit figure is computed
   from depositUsd(priceUsd, depositPercent), never the wireframe's
   literal (ruling 4).

   The clock states a fixed window and a deadline
   date, never a countdown (ruling 4); LAPSE_AT_STAGED_AFTER_DAYS and
   REDO_LAPSE_EXTENSION_DAYS are browser constants pinned by a test
   against the domain's own. Pays the REMAINDER, never the deposit
   (ruling 5 of P8j), in the job's own price.rail: ABT on ArcBlock at
   .../abt/start, USDC and ABT on Ethereum through usdc-pay.js (USDC-WEBb;
   rail "abt_eth" for the second, whose sheet shows the lock its start
   answered before the wallet is asked to switch networks). The ABT on
   ArcBlock sheet shows the ABT/USD
   rate that press locked, when the lock ends and when CoinGecko last
   updated the price (FIX-B70b, FAApi.drawAbtQuote); a start answer with
   no usable lock opens no sheet. The pay path never claims settlement
   itself; the only paid sentence comes from a settled leg the payments
   read reports. Every re-read fires on load or on a press, never on a
   timer (ruling 6). Both redo_requested and
   staged_declined render on this page now (ruling 5): the former keeps
   the clock and the account of the work with no control, the latter is
   a terminal panel with no control. Every refusal gets its own sentence
   (scope item 4). Everything through textContent (api.js rule 3). */
(function () {
  "use strict";
  var A = window.FAApi;
  var LAPSE_AT_STAGED_AFTER_DAYS = 7, REDO_LAPSE_EXTENSION_DAYS = 7, ABT_FEE_RATE_PERCENT = 3, USDC_FEE_RATE_PERCENT = 6, MS_PER_DAY = 86400000;
  var ALREADY_PAID_PHRASE = "already been paid";
  var jobId = "", token = "", job = null, currentFigures = null, redoSelectedIndex = null, usdcPay = null, paying = false;
  // Whether the signed-in session IS this job's buyer: GET /accounts/me
  // answers the caller's own account, and the page compares its did with
  // job.buyerDid. Defaults false (fail closed): a buyer whose own account
  // read fails loses redo/decline for that load rather than a non-buyer
  // gaining them.
  var isBuyerParty = false;
  var session = null;

  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
    reload();
  }
  function reload() {
    // The payments read rides beside the other two so a paid balance is
    // known before anything renders. Its answer only ever removes the
    // choices once the balance has settled; a failed read changes nothing.
    Promise.all([
      A.get("/jobs/" + encodeURIComponent(jobId)),
      A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/attestation", token),
      A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/payments", token)
    ]).then(onLoaded);
  }
  // FIX-B61b: the buyer is whoever GET /accounts/me says this session is,
  // compared by did with job.buyerDid. A public account's passkeySubject
  // or githubLogin is not read: GET /accounts/:did answers anyone, so a
  // match against it is a match against a string, not a sign-in. Any
  // answer but a 200 naming the buyer's did resolves false, never true:
  // the redo and decline controls stay hidden rather than risk showing
  // them to a party the page could not confirm.
  function resolveIsBuyerParty(job_) {
    if (session === null || typeof job_.buyerDid !== "string" || job_.buyerDid === "") return Promise.resolve(false);
    return A.getAuthed("/accounts/me", session.token).then(function (result) {
      if (result.state !== "ok" || result.value.status !== 200) return false;
      var me = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
      return typeof me.did === "string" && me.did === job_.buyerDid;
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
    // The balance leg once it has settled, else null. Null too when the
    // payments read failed or answered anything but a 200, so a buyer who
    // could still pay always sees how.
    var legs = A.settledLegs(results[2]);
    var paidBalance = job.status === "staged" && legs !== null ? legs.remainder : null;
    A.showById("staged-body", true);
    renderWhere(job);
    renderLede(job, paidBalance);
    if (paidBalance === null) renderClock(job);
    else removeById("clock");
    renderFacts(attestation);
    renderTechnical(attestation);
    renderWho(job);
    // Redo and decline both ship hidden in the markup and are revealed
    // only after the party resolution settles, so a non-buyer's browser
    // never paints either control, not even for one frame. Pay is
    // unrelated to this gate and is visible to both parties, guarded
    // server-side only.
    resolveIsBuyerParty(job).then(function (result) {
      isBuyerParty = result;
      if (paidBalance === null) renderChoicesSection(job);
      else renderPaid(paidBalance);
    });
  }

  function removeById(id) {
    var node = A.el(id);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  // The balance has settled: the hire waits on the agent's pull request,
  // not on the buyer, so there is nothing left to press. The choices
  // section goes from the document with pay, redo and decline inside it
  // (removed, not disabled, the same rule renderActs keeps), and one line
  // says what was paid. The amount is the settled leg's own, which is the
  // balance; the fee was a separate transfer the payments read does not
  // report, so no figure here includes it.
  function renderPaid(leg) {
    removeById("choices-section");
    // Declining or doing nothing is no longer open to a buyer who paid, so
    // the link that explains both goes too, and the technical note stops
    // saying the work waits on a payment that has already landed.
    removeById("outcomes-more");
    A.setTextById("tech-hidden-note", "The work reaches your repository when the pull request opens.");
    A.showById("redo-pending-note", false);
    var currency = A.railName(leg.rail);
    var date = A.readableDate(leg.observedAt);
    A.setTextById("balance-paid-line", "Balance paid: " + money(parseFloat(leg.amountUsd)) +
      (currency ? " in " + currency : "") + (date ? " on " + date : "") + ".");
    A.showById("balance-paid", true);
  }

  function showDeclined() {
    var link = A.el("declined-link");
    if (link) link.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    A.showById("declined-panel", true);
  }

  // The raw status used to be quoted here ("status is \"confirmed\""), a
  // machine value on the surface; the hire's own page says where it is
  // in words, one click away.
  function showNotReady(status) {
    void status;
    A.setTextById("not-ready-detail", "This hire is at a different step. Open it to see where it is.");
    var link = A.el("not-ready-link");
    if (link) link.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    A.showById("not-ready-error", true);
  }

  // S1: the landing page's five steps, small. "You review the work" (4)
  // while the work is staged; "Agent works on a copy" (3) while a redo is
  // back with the agent. job.js's STEP_FOR_STATUS maps the same two
  // statuses the same way.
  function renderWhere(job_) {
    var host = A.el("staged-where");
    if (!host || !window.FAStepflow) return;
    window.FAStepflow.where(host, job_.status === "redo_requested" ? 3 : 4);
  }

  function renderLede(job_, paidBalance) {
    var stagedDate = A.readableDate(job_.stagedAt);
    A.setTextById("lede", (stagedDate ? "Staged on " + stagedDate + ". " : "") +
      (paidBalance ? "You paid the balance. The agent opens the pull request next." : "Pay the balance and the pull request opens on your repository."));
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
    A.setTextById("clock-then", "If you have not decided by then, the job closes and the work never reaches your repository" + depositLine + ". Nothing further is charged.");
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

  // Ruling 5 of P8j: remainderUsd(priceUsd, depositPercent), fee at the
  // job's own currency's rate on the remainder, half-up per payment.ts.
  // A hire's currency is price.rail: "abt" (ABT on ArcBlock), "abt_eth"
  // (ABT on Ethereum) or "usdc" (USDC on Arbitrum). Both ABT rails take
  // the ABT fee; ABT on Ethereum and USDC pay through the wallet sheet.
  function railOf(job_) {
    return job_ !== null && job_.price && typeof job_.price === "object" ? job_.price.rail : null;
  }
  function isUsdc(job_) { return railOf(job_) === "usdc"; }
  function isAbtEth(job_) { return railOf(job_) === "abt_eth"; }
  function feePercentOf(job_) { return isUsdc(job_) ? USDC_FEE_RATE_PERCENT : ABT_FEE_RATE_PERCENT; }
  function remainderAndFee(price) {
    var priceUsd = parseFloat(price.priceUsd);
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    var deposit = roundHalfUpCents((priceUsd * depositPercent) / 100);
    var remainder = roundHalfUpCents(priceUsd - deposit);
    var fee = roundHalfUpCents(remainder * (feePercentOf(job) / 100));
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
        money(figures.remainder) + " of the " + money(priceUsd) + " price, plus the " + feePercentOf(job_) + " percent fee. Then the pull request opens on your repository, and merging is up to you."));
    }
    host.appendChild(choiceRow(
      exhausted ? "Send it back" : (redoAllowance === 1 ? "Send it back once" : "Send it back"),
      exhausted ? "spent" : (redoAllowance === 1 ? "free, once per hire" : "free, " + redoAllowance + " times per hire"),
      exhausted
        ? "Already used on this hire. Pay or decline."
        : "Pick the line it missed. The deadline moves " + A.plural(REDO_LAPSE_EXTENSION_DAYS, "day", "days") + ". The operator can say no, and then you are back here."));
    host.appendChild(choiceRow("Decline", "free and final",
      "You owe nothing more, the work stays in staging, and the deposit stays with the operator. Your record shows one declined hire, with no reason."));
    currentFigures = figures;
    var payBtn = A.el("pay-btn");
    if (payBtn) {
      if (figures !== null) { payBtn.textContent = "Pay the balance, " + money(figures.total); payBtn.disabled = paying; }
      else { payBtn.textContent = "No agreed price to pay against"; payBtn.disabled = true; }
    }
    // USDC-WEBb Make 3: before the press, the gas line of the hire's own
    // network, and only on a hire whose currency needs one.
    A.setTextById("gas-network", isUsdc(job_) ? "Arbitrum" : "Ethereum");
    A.showById("gas-note", figures !== null && (isUsdc(job_) || isAbtEth(job_)));
  }

  // Ruling 6: the redo control renders only when a
  // redo can actually be requested BY THIS SESSION. No disabled button,
  // no stub: both controls are removed from the document entirely
  // rather than hidden or disabled, whether the reason is the allowance
  // being spent or this session not being the job's buyer. Pay is out
  // of this card's scope (P8j's own control, unchanged here).
  function renderActs(job_) {
    var exhausted = redoUsedCount(job_) >= redoAllowanceOf(job_);
    var redoBtn = A.el("redo-btn");
    if (exhausted || !isBuyerParty) {
      if (redoBtn && redoBtn.parentNode) redoBtn.parentNode.removeChild(redoBtn);
    } else if (redoBtn) {
      redoBtn.hidden = false;
    }
    var declineBtn = A.el("decline-btn");
    if (!isBuyerParty) {
      if (declineBtn && declineBtn.parentNode) declineBtn.parentNode.removeChild(declineBtn);
    } else if (declineBtn) {
      declineBtn.hidden = false;
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
    A.setTextById("redo-pickernote", "Price and delivery date are not listed: the work cannot miss them.");
    A.setTextById("redo-cost-note", "Free. The deadline moves " + A.plural(REDO_LAPSE_EXTENSION_DAYS, "day", "days") + ". You get " + A.plural(redoAllowanceOf(job_), "redo", "redos") + " per hire. The operator can say no, and nothing is charged either way.");
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
      ["The work", "never leaves staging"],
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

    /* THE AVATAR (AV2). bots.js (window.FABots) draws the bot the agent
       read's avatarSpec names, the operator's choice or the DID default.
       Mounted on the DID this page already holds from the job record, once
       the agent read settles; a failed read still mounts the DID default,
       which is what this strip showed before the read existed. polish.js's
       load-time sweep has long finished by then, so it is not what paints
       this mount. */
    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      // B57 (FIX-CIFLAKE cause 1): a read that answers after the page itself
      // has torn down (the jsdom tests close every window they render, which
      // deletes window.document) writes nothing rather than throwing into a
      // gone page.
      if (typeof document === "undefined" || !document) return;
      // S1: a name in words, never the DID (DESIGN.md 1.3).
      var name = A.agentName(result.state === "ok" ? result.value : null);
      A.setTextById("agent-name", name);
      var nameEl = A.el("agent-name");
      if (nameEl) nameEl.removeAttribute("data-pending");
      if (window.FABots) {
        window.FABots.mount(A.el("agent-avatar"), agentDid, {
          spec: result.state === "ok" ? result.value.avatarSpec : null, size: 32,
        });
      }
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
    // FIX-B70b: the price 503 names ABT too, so it is told apart first. It
    // is a price outage that passes, not a deployment without the rail.
    if (status === 503 && serverMessage.toLowerCase().indexOf(A.ABT_PRICE_PHRASE) !== -1) return A.ABT_PRICE_SENTENCE;
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
  // REMAINDER leg only, never deposit. A USDC hire's press pays in USDC,
  // an ABT-on-Ethereum hire's in ABT on Ethereum, both through the wallet
  // sheet; only an ABT-on-ArcBlock hire's goes to .../abt/start.
  var payBtn = A.el("pay-btn");
  if (payBtn) {
    payBtn.addEventListener("click", function () {
      if (currentFigures === null) return;
      A.showById("pay-error", false);
      if (isUsdc(job) || isAbtEth(job)) { openWallet(); return; }
      payBtn.disabled = true;
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/payments/remainder/abt/start", token, {}).then(function (result) {
        payBtn.disabled = false;
        if (result.state !== "ok") { showError("pay-error", "Could not reach the server just now. Try again in a moment."); return; }
        var status = result.value.status;
        var respBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status !== 200) {
          var serverMessage = typeof respBody.error === "string" ? respBody.error : "";
          // B54: already paid opens the sheet's paid state, never "no price".
          if (serverMessage.indexOf(ALREADY_PAID_PHRASE) !== -1) {
            fillScanTotals();
            scanMode("paid");
            openDialog("scan");
            usdcPay.alreadyPaid(serverMessage);
            return;
          }
          showError("pay-error", refusalSentence(status, serverMessage));
          return;
        }
        // FIX-B70b: this press's own locked rate goes in the sheet. With no
        // usable lock the wallet would refuse the payment, so no sheet opens.
        var extra = respBody.extra && typeof respBody.extra === "object" ? respBody.extra : {};
        if (!A.drawAbtQuote(extra.abtQuote)) { showError("pay-error", A.ABT_PRICE_SENTENCE); return; }
        openScan(typeof respBody.url === "string" ? respBody.url : "");
      });
    });
  }

  function fillScanTotals() {
    if (currentFigures === null) return;
    A.setTextById("scan-total", money(currentFigures.total));
    A.setTextById("scan-remainder", money(currentFigures.remainder));
    A.setTextById("scan-fee-label", "FreeAgents fee, " + feePercentOf(job) + " percent");
    A.setTextById("scan-fee", money(currentFigures.fee));
    A.setTextById("scan-total-2", money(currentFigures.total));
  }
  // One sheet, four modes: "abt" (address, its locked rate and status
  // line), "usdc" and "abt_eth" (usdc-pay.js, then the same status line on
  // paid) and "paid". #abt-rate sits inside #scan-abt with the address row
  // (#scan-abt-address): "abt" shows both, "abt_eth" shows the rate alone,
  // once the engine hands over the lock its start answered (onQuote).
  function scanMode(mode) {
    var wallet = mode === "usdc" || mode === "abt_eth";
    A.showById("scan-abt", mode === "abt" || mode === "abt_eth");
    A.showById("scan-abt-address", mode === "abt");
    A.showById("scan-status", mode === "abt");
    A.showById("scan-approvals-line", wallet);
    A.showById("scan-pr-wrap", false);
    if (usdcPay !== null) usdcPay.reset();
  }

  // Byte-identical to the route's own `url`, never re-derived (a test
  // asserts this, mirroring P8i's own mutation proof).
  function openScan(url) {
    fillScanTotals();
    scanMode("abt");
    var urlField = A.el("scan-url");
    if (urlField) urlField.value = url;
    var copyBtn = A.el("scan-url-copy");
    if (copyBtn) copyBtn.setAttribute("data-copy", url);
    openDialog("scan");
  }

  // Make 4: the deposit page's wallet choice, outcomes and presses, on the
  // hire's own currency. ABT on Ethereum's sheet empties the rate block an
  // earlier press drew; this press's own lock fills it (onQuote).
  function openWallet() {
    if (paying) return;
    fillScanTotals();
    scanMode(isAbtEth(job) ? "abt_eth" : "usdc");
    if (isAbtEth(job)) A.drawAbtQuote(null);
    A.setTextById("scan-approvals-line", "Two approvals, " + money(currentFigures.remainder) + " then " + money(currentFigures.fee) + ". Both are part of this one payment.");
    var dialog = A.el("scan");
    if (!dialog || !dialog.open) openDialog("scan");
    usdcPay.start();
  }
  usdcPay = window.FAUsdcPay.create({
    get jobId() { return jobId; },
    get token() { return token; },
    leg: "remainder",
    // Read at each press: undefined (USDC, the engine's default) unless
    // the hire's currency is ABT on Ethereum.
    get rail() { return isAbtEth(job) ? "abt_eth" : undefined; },
    onQuote: function (quoteLock) { A.drawAbtQuote(quoteLock); },
    onBusy: function (on) { paying = on; if (payBtn) payBtn.disabled = on || currentFigures === null; },
    onPaid: function () {
      A.showById("scan-approvals-line", false);
      A.setTextById("scan-status", "The pull request opens once the operator submits the work.");
      A.showById("scan-status", true);
    },
    onAlreadyPaid: function () { A.showById("scan-approvals-line", false); }
  });

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
