/* P8i deposit (P-12): a fully-agreed buyer pays the deposit and the
   agreement locks. No route in src/api/app.ts changes. Reads
   GET /jobs/:jobId and offers only its payableRails (USDC-WEBb), in the
   page's own order: ABT on ArcBlock, ABT on Ethereum, USDC on Arbitrum,
   with the first one offered chosen. ABT on ArcBlock
   starts at .../payments/deposit/abt/start and "I approved in my wallet"
   calls POST /jobs/:jobId/confirm, once per press. The sheet that start
   opens shows the ABT/USD rate that press locked, when the lock ends and
   when CoinGecko last updated the price (FIX-B70b, FAApi.drawAbtQuote);
   a start answer with no usable lock opens no sheet. USDC and ABT on
   Ethereum pay in the browser (usdc-pay.js, rail "abt_eth" for the
   second), and on paid that same press confirms. ABT on Ethereum's sheet
   draws the lock its start answered (the engine's onQuote) before the
   wallet is asked to switch networks, and a payment that reads short
   never confirms.
   RAIL_*_FEE_PERCENT are venue constants (ruling 3), pinned by a test
   against src/domain/payment.ts's fee-rate constants; both ABT rails
   take the ABT one. No simulated
   settlement, ever: a 402 from confirm is the expected waiting state,
   never an error, no timer polls it. Everything through textContent
   (api.js rule 3), with one named exception: the avatar, which is an SVG
   this deployment's own swarm generator builds from a DID (paintAvatar
   below states the reasoning). */
(function () {
  "use strict";
  var A = window.FAApi;
  var RAIL_ABT_FEE_PERCENT = 3, RAIL_USDC_FEE_PERCENT = 6;
  // The options in page order, each with the suffix its element ids carry
  // (#railopt-<id>, #rail-<id>, #rail-<id>-amt).
  var RAILS = [{ rail: "abt", id: "abt" }, { rail: "abt_eth", id: "abt-eth" }, { rail: "usdc", id: "usdc" }];
  var ALREADY_PAID_PHRASE = "already been paid";
  var jobId = "", token = "", job = null, chosenRail = "abt", confirmInFlight = false, usdcPay = null, paying = false;
  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    var session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
    // PARTY PROBE: GET .../attestations already runs the identity gate
    // this page needs (agreement.js's own pattern), no side effect.
    Promise.all([
      A.get("/jobs/" + encodeURIComponent(jobId)),
      A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/attestations", token)
    ]).then(onJobLoaded);
  }
  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }
  function onJobLoaded(results) {
    var jobResult = results[0], gate = results[1];
    if (jobResult.state === "absent") { failLoad("There is no hire at that address."); return; }
    if (jobResult.state !== "ok") { failLoad("The record could not be loaded just now. Reloading may work."); return; }
    if (gate.state !== "ok") { failLoad("Could not confirm your access to this hire just now. Reloading may work."); return; }
    var status = gate.value.status;
    var body = gate.value.body && typeof gate.value.body === "object" ? gate.value.body : {};
    if (status === 401) {
      A.setTextById("signin-required-title", "Your session has expired. Sign in again to pay the deposit.");
      A.showById("signin-required", true);
      return;
    }
    if (status === 403) {
      showError("party-error", typeof body.error === "string" && body.error !== "" ? body.error : "Only the buyer and the agent named on this hire can read this deposit screen.");
      return;
    }
    if (status === 404) { failLoad("There is no hire at that address."); return; }
    if (status !== 200) { failLoad("Your access to this hire could not be confirmed just now. Reloading may work."); return; }
    job = jobResult.value;
    if (job.status !== "proposed") {
      showNotReady("This hire has already moved past the deposit.", "Reload this page or return to the hire to see its current state.", "/jobs/" + encodeURIComponent(job.id));
      return;
    }
    var price = job.price && typeof job.price === "object" ? job.price : null;
    if (price === null || !allLinesAgreed(job, price)) {
      showNotReady("This hire is not ready for a deposit yet.", "Every line of the agreement needs both signatures before the deposit can be paid.", "/agreement?job=" + encodeURIComponent(job.id));
      return;
    }
    A.showById("deposit-body", true);
    renderTotals(price);
    renderGetList(job);
    renderByWhen(price);
    renderWho(job);
    renderRedoAndFinality(price);
    A.setTextById("tech-spec-hash", typeof job.specHash === "string" && job.specHash !== "" ? job.specHash : "computed once the deposit clears");
    wireRailChooser();
    wirePayButton();
    wireUsdc();
    offerPayableRails();
    var back = A.el("back-to-agreement");
    if (back) back.setAttribute("href", "/agreement?job=" + encodeURIComponent(job.id));
  }
  // Make 1: one option per payable currency; none hides Pay and the total
  // and points at the hire's conversation. The chosen one is always the
  // first offered in page order, so a hidden option is never checked or
  // chosen (the markup's own checked on #rail-abt included).
  function offerPayableRails() {
    var payable = Array.isArray(job.payableRails) ? job.payableRails : ["abt", "usdc"];
    var offered = RAILS.filter(function (r) { return payable.indexOf(r.rail) !== -1; });
    RAILS.forEach(function (r) { A.showById("railopt-" + r.id, offered.indexOf(r) !== -1); });
    if (offered.length === 0) {
      ["rails-heading", "rails", "total-pane", "pay-btn", "gas-note"].forEach(function (id) { A.showById(id, false); });
      var link = A.el("no-rails-link");
      if (link) link.setAttribute("href", "/messages?job=" + encodeURIComponent(job.id));
      A.showById("no-rails", true);
      return;
    }
    RAILS.forEach(function (r) {
      var radio = A.el("rail-" + r.id);
      if (radio) radio.checked = r === offered[0];
    });
    chosenRail = offered[0].rail;
    applyRailTotals(job.price);
  }
  function showNotReady(title, detail, href) {
    A.setTextById("not-ready-title", title);
    A.setTextById("not-ready-detail", detail);
    var link = A.el("not-ready-link");
    if (link) link.setAttribute("href", href);
    A.showById("not-ready-error", true);
  }
  function showError(idPrefix, message) {
    A.setTextById(idPrefix + "-detail", message);
    A.showById(idPrefix, true);
  }
  function allLinesAgreed(job_, price) {
    var criteria = Array.isArray(job_.criteria) ? job_.criteria : [];
    var ok = criteria.every(function (c) { return c.acceptedByBuyer === true && c.acceptedByAgent === true; });
    return ok && price.acceptedByBuyer === true && price.acceptedByAgent === true && criteria.length > 0;
  }
  // Scope item 6: deposit = priceUsd * depositPercent / 100, fee = that
  // times the rail's rate, rounded half-up at the cent to match
  // src/domain/payment.ts's calculateFee (a test pins the tie case).
  function roundHalfUpCents(amount) {
    var h = Math.round(amount * 10000), cents = Math.floor(h / 100);
    if (h - cents * 100 >= 50) cents += 1;
    return cents / 100;
  }
  function money(n) { return "$" + n.toFixed(2); }
  function depositAndFee(price, feePercent) {
    var priceUsd = parseFloat(price.priceUsd);
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    var deposit = roundHalfUpCents((priceUsd * depositPercent) / 100);
    var fee = roundHalfUpCents(deposit * (feePercent / 100));
    return { deposit: deposit, fee: fee, total: roundHalfUpCents(deposit + fee) };
  }
  function feePercentOf(rail) { return rail === "usdc" ? RAIL_USDC_FEE_PERCENT : RAIL_ABT_FEE_PERCENT; }
  function renderTotals(price) {
    var abt = depositAndFee(price, RAIL_ABT_FEE_PERCENT), priceUsd = parseFloat(price.priceUsd);
    RAILS.forEach(function (r) { A.setTextById("rail-" + r.id + "-amt", money(depositAndFee(price, feePercentOf(r.rail)).total) + " today"); });
    var depositPct = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    A.setTextById("counts-toward-line",
      "This counts toward the " + money(priceUsd) + " price. " +
      "The other " + money(roundHalfUpCents(priceUsd - abt.deposit)) + " plus the same fee is due when the work is ready, after you see what changed.");
    A.el("deposit-label").textContent = "Deposit, " + depositPct + " percent of the " + money(priceUsd) + " price";
    applyRailTotals(price);
  }
  function applyRailTotals(price) {
    var feePercent = feePercentOf(chosenRail);
    var figures = depositAndFee(price, feePercent);
    A.setTextById("total-amount", money(figures.total));
    A.setTextById("deposit-amount", money(figures.deposit));
    A.setTextById("fee-label", "FreeAgents fee, " + feePercent + " percent");
    A.setTextById("fee-amount", money(figures.fee));
    A.setTextById("sum-amount", money(figures.total));
    var payBtn = A.el("pay-btn");
    if (payBtn) {
      payBtn.textContent = "Pay " + money(figures.total) + " with your wallet";
      payBtn.disabled = paying;
    }
    // Before the press, the gas line of the chosen option's network only.
    A.setTextById("gas-network", chosenRail === "usdc" ? "Arbitrum" : "Ethereum");
    A.showById("gas-note", chosenRail === "usdc" || chosenRail === "abt_eth");
  }
  function wireRailChooser() {
    var price = job.price;
    RAILS.forEach(function (r) {
      var radio = A.el("rail-" + r.id);
      if (radio) radio.addEventListener("change", function () { if (radio.checked) { chosenRail = r.rail; applyRailTotals(price); } });
    });
  }
  function getRow(n, text) {
    var li = document.createElement("li"), num = document.createElement("span"), span = document.createElement("span");
    num.className = "num";
    num.textContent = n < 10 ? "0" + n : String(n);
    span.textContent = text;
    li.appendChild(num);
    li.appendChild(span);
    return li;
  }
  function renderGetList(job_) {
    var host = A.el("getlist");
    host.textContent = "";
    var criteria = Array.isArray(job_.criteria) ? job_.criteria : [];
    var n = 0;
    criteria.forEach(function (c) { n += 1; host.appendChild(getRow(n, typeof c.text === "string" ? c.text : "")); });
    var price = job_.price;
    host.appendChild(getRow(n += 1, "Price: $" + price.priceUsd));
    if (typeof price.deliveryWindowDays === "number") {
      host.appendChild(getRow(n += 1, "Ready in " + A.plural(price.deliveryWindowDays, "day", "days") + " of this payment clearing."));
    }
  }
  // Ruling 5: no date the platform cannot know. Stated relative to the
  // event (payment clearing), never a calendar date computed from
  // today; absent, says the window was not part of the agreement.
  function renderByWhen(price) {
    if (typeof price.deliveryWindowDays === "number") {
      A.setTextById("byline", "Ready " + A.plural(price.deliveryWindowDays, "day", "days") + " after this payment clears");
      A.setTextById("byline-sub", "Counted from when the deposit arrives.");
    } else {
      A.setTextById("byline", "The delivery window was not part of this agreement");
    }
  }
  /* THE AVATAR (AV2). bots.js (window.FABots) draws the bot the agent read's
     avatarSpec names: the operator's choice, or the DID default. Painted
     only once that read succeeds, so a mount never asserts an identity this
     page could not confirm; polish.js's load-time sweep has long finished
     by then. Without bots.js the mount stays empty rather than showing a
     different engine's face for the same agent. */
  function paintAvatar(agentDid, spec) {
    if (!window.FABots || agentDid === "") return;
    window.FABots.mount(A.el("agent-avatar"), agentDid, { spec: spec, size: 32 });
  }
  function renderWho(job_) {
    var agentDid = typeof job_.agentDid === "string" ? job_.agentDid : "";
    if (agentDid === "") return;
    var profileLink = A.el("agent-profile-link");
    if (profileLink) profileLink.setAttribute("href", "/agents/" + encodeURIComponent(agentDid));
    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      // B57 (FIX-CIFLAKE cause 1): a read that answers after the page itself
      // has torn down (the jsdom tests close every window they render, which
      // deletes window.document) writes nothing rather than throwing into a
      // gone page.
      if (typeof document === "undefined" || !document) return;
      // S1: a name in words, never the DID (DESIGN.md 1.3); the exact
      // identities go to the technical details.
      var name = A.agentName(result.state === "ok" ? result.value : null);
      A.techIdentity("tech-agent-did-wrap", "tech-agent-did", agentDid);
      if (result.state === "ok") {
        paintAvatar(agentDid, result.value.avatarSpec);
        // Revealed by its value (hire.js's own rule): "operated by" over
        // an empty link would be a line with nothing on it.
        A.nameOperator("operated-by", "operator-link", result.value.operatorDid);
        A.techIdentity("tech-operator-did-wrap", "tech-operator-did", result.value.operatorDid);
      }
      A.setTextById("agent-name", name);
    });
    A.get("/agents/" + encodeURIComponent(agentDid) + "/hires").then(function (result) {
      if (result.state !== "ok") return;
      var counts = result.value.counts && typeof result.value.counts === "object" ? result.value.counts : null;
      if (counts === null || typeof counts.hires !== "number" || counts.hires <= 0) return;
      A.setTextById("agent-hires", A.plural(counts.hires, "verified hire", "verified hires"));
    });
  }
  function renderRedoAndFinality(price) {
    var redoAllowance = typeof price.redoAllowance === "number" ? price.redoAllowance : 1;
    A.setTextById("redo-line", "If the work misses a line above, you can send it back " + (redoAllowance === 1 ? "once" : redoAllowance + " times") + ", free.");
    A.setTextById("finality-line", "The " + money(depositAndFee(price, RAIL_ABT_FEE_PERCENT).deposit) + " deposit does not come back, even if you decline the work or never merge it.");
  }
  // Scope item 8: every refusal gets a sentence a person can act on. One
  // shared shape for both writes (start and confirm); only the 401/409
  // sentences differ between them, so those two ride as params.
  function refusalSentence(status, serverMessage, sessionExpiredMessage, conflictMessage) {
    if (status === 401) return sessionExpiredMessage;
    if (status === 403) return serverMessage || "This account is not the buyer of this hire.";
    if (status === 409) return conflictMessage;
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
  function wirePayButton() {
    var payBtn = A.el("pay-btn");
    if (!payBtn) return;
    payBtn.addEventListener("click", function () {
      A.showById("pay-error", false);
      if (chosenRail === "usdc" || chosenRail === "abt_eth") { openWallet(); return; }
      payBtn.disabled = true;
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/payments/deposit/abt/start", token, {}).then(function (result) {
        payBtn.disabled = false;
        if (result.state !== "ok") {
          showError("pay-error", "Could not reach the server just now. Try again in a moment.");
          return;
        }
        var status = result.value.status;
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status !== 200) {
          var serverMessage = typeof body.error === "string" ? body.error : "";
          // B54: an already-paid 409 reads as paid, never "no agreed price".
          if (serverMessage.indexOf(ALREADY_PAID_PHRASE) !== -1) { openAlreadyPaid(serverMessage); return; }
          var repository = status === 409 ? repositoryRefusal(serverMessage) : null;
          if (repository !== null) {
            showRepositoryRefusal("pay", repository);
            return;
          }
          showError("pay-error", refusalSentence(status, serverMessage, "Your session has expired. Sign in again to pay the deposit.", "There is no agreed price to pay against yet. Reload the page to see the latest state."));
          return;
        }
        // FIX-B70b: this press's own locked rate goes in the sheet. With no
        // usable lock the wallet would refuse the payment, so no sheet opens.
        var extra = body.extra && typeof body.extra === "object" ? body.extra : {};
        if (!A.drawAbtQuote(extra.abtQuote)) { showError("pay-error", A.ABT_PRICE_SENTENCE); return; }
        openScan(typeof body.url === "string" ? body.url : "");
      });
    });
  }
  // One sheet, four modes: "abt" (address, its locked rate, one approval,
  // "I approved"), "usdc" and "abt_eth" (usdc-pay.js draws the wallet
  // choice and outcomes) and "paid". #abt-rate sits inside #scan-abt with
  // the address row (#scan-abt-address): "abt" shows both, "abt_eth" shows
  // the rate alone, once the engine hands over the lock (onQuote).
  var SCAN_HEADINGS = { abt: "Open this in your wallet", usdc: "Approve in your wallet", abt_eth: "Approve in your wallet", paid: "Already paid" };
  function openSheet(mode, approvalsLine) {
    var dialog = A.el("scan");
    A.setTextById("scanh", SCAN_HEADINGS[mode]);
    A.showById("scan-abt", mode === "abt" || mode === "abt_eth");
    A.showById("scan-abt-address", mode === "abt");
    A.showById("scan-waiting", mode === "abt");
    A.showById("approved-btn", mode === "abt");
    A.showById("confirm-error", false);
    A.showById("confirm-waiting", false);
    if (usdcPay !== null) usdcPay.reset();
    A.setTextById("scan-approvals-line", approvalsLine);
    if (dialog && typeof dialog.showModal === "function") { if (!dialog.open) dialog.showModal(); }
    else if (dialog) dialog.setAttribute("open", "");
  }
  // Scope item 5: the scan dialog. The URL is selectable text with a
  // copy control, byte-identical to the route's own `url` (a test
  // asserts this). No QR dependency in package.json and this card adds
  // none: a code that encoded the wrong string is worse than none. The
  // press has already drawn its locked rate into #abt-rate by the time
  // this runs (FIX-B70b).
  function openScan(url) {
    var urlField = A.el("scan-url"), copyBtn = A.el("scan-url-copy");
    if (urlField) urlField.value = url;
    if (copyBtn) copyBtn.setAttribute("data-copy", url);
    openSheet("abt", "Open your wallet with this address, and approve. One approval, for this whole payment.");
  }
  // Make 2: the wireframe's two-approvals line (deposit.html:256), at the
  // chosen option's fee. ABT on Ethereum's sheet empties the rate block
  // an earlier press drew; this press's own lock fills it (onQuote).
  function openWallet() {
    if (paying) return;
    var figures = depositAndFee(job.price, feePercentOf(chosenRail));
    openSheet(chosenRail, "Two approvals, " + money(figures.deposit) + " then " + money(figures.fee) + ". Both are part of this one payment.");
    if (chosenRail === "abt_eth") A.drawAbtQuote(null);
    usdcPay.start();
  }
  // Paid: the same press carries on into ONE press of "I approved in my
  // wallet", so its 200, 402 and refusals all read as they always have.
  function confirmNow() {
    A.showById("approved-btn", true);
    var approvedBtn = A.el("approved-btn");
    if (approvedBtn) approvedBtn.click();
  }
  // Already paid (B54): the server's sentence, its reload, and "I approved
  // in my wallet" waiting for a press, since that press locks the deal.
  function openAlreadyPaid(serverMessage) {
    openSheet("paid", "");
    usdcPay.alreadyPaid(serverMessage);
  }
  function showAlreadyPaidPresses() {
    A.setTextById("scanh", SCAN_HEADINGS.paid);
    A.setTextById("scan-approvals-line", "");
    A.showById("approved-btn", true);
    A.showById("usdc-reload", true);
  }
  // The rail is read at each press: undefined (USDC, the engine's default)
  // unless ABT on Ethereum is the chosen option.
  function wireUsdc() {
    usdcPay = window.FAUsdcPay.create({
      jobId: jobId, token: token, leg: "deposit",
      get rail() { return chosenRail === "abt_eth" ? "abt_eth" : undefined; },
      onQuote: function (quoteLock) { A.drawAbtQuote(quoteLock); },
      onBusy: function (on) { paying = on; var payBtn = A.el("pay-btn"); if (payBtn) payBtn.disabled = on; },
      onPaid: confirmNow,
      onAlreadyPaid: showAlreadyPaidPresses,
      onRefused: usdcRepositoryRefusal
    });
  }
  // The USDC start door refuses a repository that is not ready the way the
  // ABT door does, so it reads the same: the sheet closes and the page's
  // own sentence and link show beside Pay.
  function usdcRepositoryRefusal(serverMessage) {
    var repository = repositoryRefusal(serverMessage);
    if (repository === null) return false;
    closeScan();
    showRepositoryRefusal("pay", repository);
    return true;
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
  // Ruling 4: confirm is called on the buyer's own press, once, and
  // never fakes a settlement. A 402 is the expected waiting state, not
  // an error. A 200 means the agreement locked; the buyer goes to
  // /jobs/<id>. No timer ever calls this.
  var approvedBtn = A.el("approved-btn");
  if (approvedBtn) {
    approvedBtn.addEventListener("click", function () {
      if (confirmInFlight) return;
      confirmInFlight = true;
      approvedBtn.disabled = true;
      A.showById("confirm-error", false);
      A.showById("confirm-waiting", false);
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/confirm", token, {}).then(function (result) {
        confirmInFlight = false;
        approvedBtn.disabled = false;
        if (result.state !== "ok") {
          showError("confirm-error", "Could not reach the server just now. Try again in a moment.");
          return;
        }
        var status = result.value.status;
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        if (status === 200) { window.location.href = "/jobs/" + encodeURIComponent(jobId); return; }
        if (status === 402) {
          A.setTextById("usdc-status", ""); // "confirmed" cannot sit beside this
          A.showById("usdc-reload", false);
          showError("confirm-waiting", "The chain has not confirmed your payment yet. Wait a moment and press this again to check.");
          return;
        }
        var serverMessage = typeof body.error === "string" ? body.error : "";
        var repository = status === 409 ? repositoryRefusal(serverMessage) : null;
        if (repository !== null && repository.key === "hidden") {
          showRepositoryRefusal("confirm", { key: "hidden", sentence: "We can't see this repository yet. If it's private, share it first, then press this again.", link: true });
          return;
        }
        showError("confirm-error", refusalSentence(status, serverMessage, "Your session has expired. Sign in again to finish this hire.", "Finish signing the agreement before the deposit can lock it. Reload the page to see the latest state."));
      });
    });
  }
  // ORG1b: the platform reads the buyer's repository before a deposit
  // starts (every start door) and again at confirm, and refuses with 409
  // when it is not ready. Each case gets its own plain sentence, told apart
  // by the server's own phrase (pinned by tests/api/job-deposit-repository-
  // check.test.ts and tests/adapters/payment/route-support.test.ts). The
  // three that are about sharing link the walkthrough page for this job;
  // an empty repository needs a first commit, not sharing, so it has no
  // link. Pay can meet all four; confirm only answers the first. Either
  // refusal persists nothing, so the same press works once the buyer has
  // done what it says: GitHub answers the job's old repository path with
  // the moved repository once it is shared, and confirm stores the new
  // name. Any other 409 keeps its route's own sentence.
  var REPOSITORY_REFUSALS = [
    { key: "personal", phrase: "owned by a personal account", link: true,
      sentence: "This private repository is on a personal account. Move it into an organization and share it, then press Pay again." },
    { key: "forking", phrase: "forking of private repositories is off", link: true,
      sentence: "Forking of private repositories is off in this organization's Settings. Turn it on, or ask an owner to, then press Pay again." },
    { key: "empty", phrase: "has no commits yet", link: false,
      sentence: "This repository has no commits yet. Add a first commit, then press Pay again." },
    { key: "hidden", phrase: "cannot see this repository", link: true,
      sentence: "We can't see this repository yet. If it's private, share it first, then press Pay again." }
  ];
  function repositoryRefusal(serverMessage) {
    var lower = serverMessage.toLowerCase();
    for (var i = 0; i < REPOSITORY_REFUSALS.length; i += 1) {
      if (lower.indexOf(REPOSITORY_REFUSALS[i].phrase) !== -1) return REPOSITORY_REFUSALS[i];
    }
    return null;
  }
  // prefix is "pay" or "confirm": the refusal box beside that press.
  function showRepositoryRefusal(prefix, refusal) {
    var detail = A.el(prefix + "-error-detail");
    if (!detail) return;
    detail.textContent = refusal.sentence;
    if (refusal.link) {
      var line = document.createElement("span");
      line.className = "sf-mores";
      line.style.marginTop = "6px";
      var link = document.createElement("a");
      link.className = "sf-more";
      link.id = prefix + "-private-repos-link";
      link.setAttribute("href", "/private-repos?job=" + encodeURIComponent(jobId));
      link.textContent = "How to share a private repository";
      line.appendChild(link);
      detail.appendChild(line);
    }
    A.showById(prefix + "-error", true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
