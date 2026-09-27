/* USDC-WEBb: the USDC pay block the deposit and balance pages share. It
   drives window.FAUsdcWallet (usdc-wallet.js, loaded before this file)
   and owns one fixed set of elements, which each page draws inside its
   own #scan sheet: #usdc-pick and #usdc-wallets (the wallet choice),
   #scan-waiting, #usdc-status (the live region every outcome's own
   sentence lands in) and four footer presses, #usdc-retry, #usdc-resend,
   #usdc-check and #usdc-reload. At most one press shows at a time, and
   none while a payment runs: each run hides them first, and the page's
   own Pay stays disabled until the outcome is in (onBusy).

   The sentences are the engine's, word for word (only the first letter
   is raised, since the server's already-paid sentence starts lower
   case). What happens after `paid` and `already_paid` belongs to the
   page (onPaid, onAlreadyPaid): the deposit page confirms, the balance
   page shows what comes next. Nothing here runs on a timer: a check is
   one buyer press, and so is every send. Everything through textContent
   (api.js rule 3); a wallet's icon is drawn only when it is a data:image
   URI, and only ever as an <img src>. */
(function () {
  "use strict";
  var A = window.FAApi;
  var PRESSES = ["usdc-retry", "usdc-resend", "usdc-check", "usdc-reload"];

  function sentence(text) {
    var s = typeof text === "string" ? text : "";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // opts: { jobId, token, leg, onBusy(bool), onPaid(result),
  // onAlreadyPaid(result) }.
  function create(opts) {
    var engine = window.FAUsdcWallet;
    var wallet = null, resendLeg = null;

    function setBusy(on) {
      A.showById("scan-waiting", on);
      if (typeof opts.onBusy === "function") opts.onBusy(on);
    }
    function showOnly(id) {
      PRESSES.forEach(function (p) { A.showById(p, p === id); });
    }
    function status(text) { A.setTextById("usdc-status", sentence(text)); }
    function clear() {
      A.showById("usdc-pick", false);
      showOnly(null);
      status("");
    }

    // Outcome to next step. Every outcome keeps its own sentence; the
    // press shown is the one thing that sentence says to do.
    function settle(result) {
      setBusy(false);
      status(result.message);
      resendLeg = null;
      var outcome = result.outcome;
      if (outcome === "paid") { showOnly(null); if (opts.onPaid) opts.onPaid(result); return; }
      if (outcome === "already_paid") {
        showOnly("usdc-reload");
        if (opts.onAlreadyPaid) opts.onAlreadyPaid(result);
        return;
      }
      // Both name one transfer to send again; the press sends only that.
      if (outcome === "transfer_failed" || outcome === "price_due") {
        resendLeg = outcome === "price_due" ? "price" : result.leg;
        showOnly("usdc-resend");
        return;
      }
      if (outcome === "waiting_network") { showOnly("usdc-check"); return; }
      // mismatched says not to send anything else, so it offers nothing.
      if (outcome === "mismatched") { showOnly(null); return; }
      // no_wallet, cancelled, wallet_error, server_refused, fee_due: the
      // same press again is the next step. fee_due resumes on it, since
      // the engine reuses the price transfer it already sent.
      showOnly("usdc-retry");
    }

    function run(chosen, resend) {
      wallet = chosen;
      clear();
      setBusy(true);
      var payOpts = { wallet: wallet, jobId: opts.jobId, leg: opts.leg, token: opts.token };
      if (resend) payOpts.resend = resend;
      engine.pay(payOpts).then(settle);
    }

    function walletChoice(entry) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-block";
      // 44px at every width: .btn alone is 40 above 760px (base.css).
      btn.style.minHeight = "44px";
      if (typeof entry.icon === "string" && entry.icon.indexOf("data:image/") === 0) {
        var img = document.createElement("img");
        img.src = entry.icon;
        img.alt = "";
        img.style.width = "24px";
        img.style.height = "24px";
        btn.appendChild(img);
      }
      var name = document.createElement("span");
      name.textContent = typeof entry.name === "string" && entry.name !== "" ? entry.name : "Wallet";
      btn.appendChild(name);
      btn.addEventListener("click", function () { run(entry); });
      return btn;
    }

    // One found: used. Several: the buyer picks. None: the engine's own
    // no_wallet sentence, read from pay() with no wallet (it answers
    // that before any network call).
    function start() {
      wallet = null;
      clear();
      setBusy(true);
      engine.discover().then(function (found) {
        setBusy(false);
        if (found.length === 1) { run(found[0]); return; }
        if (found.length === 0) { engine.pay({ wallet: null }).then(settle); return; }
        var list = A.el("usdc-wallets");
        list.textContent = "";
        found.forEach(function (entry) { list.appendChild(walletChoice(entry)); });
        A.showById("usdc-pick", true);
      });
    }

    function press(id, fn) {
      var btn = A.el(id);
      if (btn) btn.addEventListener("click", fn);
    }
    // With no wallet found last time, Try again looks again.
    press("usdc-retry", function () { if (wallet === null) start(); else run(wallet); });
    press("usdc-resend", function () { run(wallet, resendLeg); });
    press("usdc-check", function () {
      clear();
      setBusy(true);
      engine.check({ wallet: wallet, jobId: opts.jobId, leg: opts.leg, token: opts.token }).then(settle);
    });
    // The already-paid sentence says to reload; this link is that, to the
    // same page with the same hire.
    var reloadLink = A.el("usdc-reload");
    if (reloadLink) reloadLink.setAttribute("href", window.location.pathname + window.location.search);

    // alreadyPaid(message): an ABT start door refused an already-paid
    // leg. Same sentence place and the same reload press as the USDC
    // already_paid outcome, so both currencies read the same.
    function alreadyPaid(message) {
      clear();
      settle({ outcome: "already_paid", message: message });
    }
    // reset(): the sheet opened another way; nothing of this block from
    // an earlier payment may show there.
    return { start: start, reset: clear, alreadyPaid: alreadyPaid };
  }

  window.FAUsdcPay = { create: create, sentence: sentence };
})();
