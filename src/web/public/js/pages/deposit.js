/* P8i deposit (P-12): a fully-agreed buyer pays the deposit and the
   agreement locks. No route in src/api/app.ts changes. Reads
   GET /jobs/:jobId, starts ABT through POST .../payments/deposit/abt/start,
   calls POST /jobs/:jobId/confirm once per press of "I approved in my
   wallet". USDC's routes are never called (ruling 1): its row renders
   complete, its pay control states ABT is the rail that pays today.
   RAIL_*_FEE_PERCENT are venue constants (ruling 3), pinned by a test
   against src/domain/payment.ts's fee-rate constants. No simulated
   settlement, ever: a 402 from confirm is the expected waiting state,
   never an error, no timer polls it. Everything through textContent
   (api.js rule 3). */
(function () {
  "use strict";
  var A = window.FAApi;
  var RAIL_ABT_FEE_PERCENT = 3, RAIL_USDC_FEE_PERCENT = 6;
  var jobId = "", token = "", job = null, chosenRail = "abt", confirmInFlight = false;
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
    A.setTextById("tech-spec-hash", typeof job.specHash === "string" && job.specHash !== "" ? job.specHash : "computed when the deposit settles");
    wireRailChooser();
    wirePayButton();
    var back = A.el("back-to-agreement");
    if (back) back.setAttribute("href", "/agreement?job=" + encodeURIComponent(job.id));
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
  function renderTotals(price) {
    var abt = depositAndFee(price, RAIL_ABT_FEE_PERCENT), usdc = depositAndFee(price, RAIL_USDC_FEE_PERCENT), priceUsd = parseFloat(price.priceUsd);
    A.setTextById("rail-abt-amt", money(abt.total) + " today");
    A.setTextById("rail-usdc-amt", money(usdc.total) + " today");
    var depositPct = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    A.setTextById("counts-toward-line",
      "The deposit counts toward the " + money(priceUsd) + " price, it is not an extra charge. " +
      "The remaining " + money(roundHalfUpCents(priceUsd - abt.deposit)) + " plus the same fee is due when the work is ready, and you see what changed before you pay it.");
    A.el("deposit-label").textContent = "Deposit, " + depositPct + " percent of the " + money(priceUsd) + " price";
    applyRailTotals(price);
  }
  function applyRailTotals(price) {
    var feePercent = chosenRail === "usdc" ? RAIL_USDC_FEE_PERCENT : RAIL_ABT_FEE_PERCENT;
    var figures = depositAndFee(price, feePercent);
    A.setTextById("total-amount", money(figures.total));
    A.setTextById("deposit-amount", money(figures.deposit));
    A.setTextById("fee-label", "FreeAgents fee, " + feePercent + " percent");
    A.setTextById("fee-amount", money(figures.fee));
    A.setTextById("sum-amount", money(figures.total));
    var payBtn = A.el("pay-btn");
    if (payBtn) {
      if (chosenRail === "abt") {
        payBtn.textContent = "Pay " + money(figures.total) + " with your wallet";
        payBtn.disabled = false;
      } else {
        payBtn.textContent = "USDC payment is not available from the browser yet";
        payBtn.disabled = true;
      }
    }
    A.showById("usdc-pay-note", chosenRail === "usdc");
  }
  function wireRailChooser() {
    var abtRadio = A.el("rail-abt"), usdcRadio = A.el("rail-usdc"), price = job.price;
    if (abtRadio) abtRadio.addEventListener("change", function () { if (abtRadio.checked) { chosenRail = "abt"; applyRailTotals(price); } });
    if (usdcRadio) usdcRadio.addEventListener("change", function () { if (usdcRadio.checked) { chosenRail = "usdc"; applyRailTotals(price); } });
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
      A.setTextById("byline-sub", "Counted from the deposit landing, not from today.");
    } else {
      A.setTextById("byline", "The delivery window was not part of this agreement");
    }
  }
  function renderWho(job_) {
    var agentDid = typeof job_.agentDid === "string" ? job_.agentDid : "";
    if (agentDid === "") return;
    var profileLink = A.el("agent-profile-link");
    if (profileLink) profileLink.setAttribute("href", "/agents/" + encodeURIComponent(agentDid));
    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      var name = A.shortDid(agentDid);
      if (result.state === "ok") {
        name = typeof result.value.name === "string" && result.value.name !== "" ? result.value.name : agentDid;
        A.setAvatar(A.el("agent-avatar"), result.value.avatar);
        var operatorLink = A.el("operator-link");
        if (operatorLink && typeof result.value.operatorDid === "string" && result.value.operatorDid !== "") {
          operatorLink.setAttribute("href", "/accounts/" + encodeURIComponent(result.value.operatorDid));
          A.setText(operatorLink, A.shortDid(result.value.operatorDid));
        }
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
    A.setTextById("redo-line", "If the work misses one of the lines above, you can send it back " + (redoAllowance === 1 ? "once" : redoAllowance + " times") + ", free, naming which line.");
    A.setTextById("finality-line", "This " + money(depositAndFee(price, RAIL_ABT_FEE_PERCENT).deposit) + " deposit does not come back. Not if you decline the work, not if you never merge it, not if you change your mind tomorrow.");
  }
  // Scope item 8: every refusal gets a sentence a person can act on. One
  // shared shape for both writes (start and confirm); only the 401/409
  // sentences differ between them, so those two ride as params.
  function refusalSentence(status, serverMessage, sessionExpiredMessage, conflictMessage) {
    if (status === 401) return sessionExpiredMessage;
    if (status === 403) return serverMessage || "This account is not the buyer of this hire.";
    if (status === 409) return conflictMessage;
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
      if (chosenRail !== "abt") return; // ruling 1: USDC never starts a payment from this page
      A.showById("pay-error", false);
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
          showError("pay-error", refusalSentence(status, typeof body.error === "string" ? body.error : "", "Your session has expired. Sign in again to pay the deposit.", "There is no agreed price to pay against yet. Reload the page to see the latest state."));
          return;
        }
        openScan(typeof body.url === "string" ? body.url : "");
      });
    });
  }
  // Scope item 5: the scan dialog. The URL is selectable text with a
  // copy control, byte-identical to the route's own `url` (a test
  // asserts this). No QR dependency in package.json and this card adds
  // none: a code that encoded the wrong string is worse than none.
  function openScan(url) {
    var dialog = A.el("scan"), urlField = A.el("scan-url"), copyBtn = A.el("scan-url-copy");
    if (urlField) urlField.value = url;
    if (copyBtn) copyBtn.setAttribute("data-copy", url);
    A.setTextById("scan-approvals-line", "Open your wallet with this address, and approve. One approval, for this whole payment.");
    A.showById("confirm-error", false);
    A.showById("confirm-waiting", false);
    A.showById("scan-waiting", true);
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
          showError("confirm-waiting", "The chain has not confirmed your payment yet. Wait a moment and press this again to check.");
          return;
        }
        showError("confirm-error", refusalSentence(status, typeof body.error === "string" ? body.error : "", "Your session has expired. Sign in again to finish this hire.", "Finish signing the agreement before the deposit can lock it. Reload the page to see the latest state."));
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
