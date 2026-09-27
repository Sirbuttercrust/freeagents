/* USDC-WEBb: the USDC block the deposit and balance #scan sheets share,
   driving window.FAUsdcWallet. It owns #usdc-pick and #usdc-wallets,
   #scan-waiting, the #usdc-status live region and four footer presses
   (#usdc-retry, #usdc-resend, #usdc-check, #usdc-reload), at most one
   shown, none while a payment runs. Sentences are the engine's, word for
   word, first letter raised. The page decides what follows paid and
   already_paid, and may show a server refusal its own way (onRefused).
   No timers. textContent only (api.js rule 3); an icon is
   drawn only when it is a data:image URI, and only as an <img src>. */
(function () {
  "use strict";
  var A = window.FAApi;
  var PRESSES = ["usdc-retry", "usdc-resend", "usdc-check", "usdc-reload"];
  function sentence(text) {
    var s = typeof text === "string" ? text : "";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // opts: { jobId, token, leg, onBusy(bool), onPaid(), onAlreadyPaid(),
  // onRefused(message) }. onRefused answers true when the page shows a
  // server refusal its own way; the sheet then stays empty.
  function create(opts) {
    var engine = window.FAUsdcWallet, wallet = null, resendLeg = null;
    function setBusy(on) { A.showById("scan-waiting", on); if (opts.onBusy) opts.onBusy(on); }
    function showOnly(id) { PRESSES.forEach(function (p) { A.showById(p, p === id); }); }
    function status(text) { A.setTextById("usdc-status", sentence(text)); }
    function clear() { A.showById("usdc-pick", false); showOnly(null); status(""); }
    // Each outcome keeps its own sentence; the press shown is the one
    // thing that sentence says to do. mismatched says to send nothing
    // else, so it offers nothing. no_wallet, cancelled, wallet_error,
    // server_refused and fee_due retry (the engine reuses a sent price).
    function settle(result) {
      var outcome = result.outcome;
      setBusy(false);
      if (outcome === "server_refused" && opts.onRefused && opts.onRefused(result.message)) { clear(); return; }
      status(result.message);
      resendLeg = outcome === "price_due" ? "price" : result.leg;
      if (outcome === "paid") { showOnly(null); if (opts.onPaid) opts.onPaid(); return; }
      if (outcome === "already_paid") { showOnly("usdc-reload"); if (opts.onAlreadyPaid) opts.onAlreadyPaid(); return; }
      if (outcome === "transfer_failed" || outcome === "price_due") { showOnly("usdc-resend"); return; }
      if (outcome === "waiting_network") { showOnly("usdc-check"); return; }
      showOnly(outcome === "mismatched" ? null : "usdc-retry");
    }
    function run(chosen, resend) {
      wallet = chosen;
      clear();
      setBusy(true);
      var payOpts = { wallet: wallet, jobId: opts.jobId, leg: opts.leg, token: opts.token };
      if (resend) payOpts.resend = resend;
      engine.pay(payOpts).then(settle);
    }
    // A full-width .btn, 44px at every width (.btn alone is 40 above
    // 760px); a long name wraps and the icon keeps its size.
    function walletChoice(entry) {
      var btn = document.createElement("button"), name = document.createElement("span");
      btn.type = "button";
      btn.className = "btn btn-block";
      btn.style.cssText = "min-height:44px; white-space:normal; padding:8px 16px";
      if (typeof entry.icon === "string" && entry.icon.indexOf("data:image/") === 0) {
        var img = document.createElement("img");
        img.src = entry.icon;
        img.alt = "";
        img.style.cssText = "width:24px; height:24px; flex:none";
        btn.appendChild(img);
      }
      name.style.cssText = "min-width:0; overflow-wrap:anywhere";
      name.textContent = typeof entry.name === "string" && entry.name !== "" ? entry.name : "Wallet";
      btn.appendChild(name);
      btn.addEventListener("click", function () { run(entry); });
      return btn;
    }
    // One wallet: used. Several: the buyer picks. None: the engine's own
    // no_wallet sentence, from pay() with no wallet (no network call).
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
    function press(id, fn) { var btn = A.el(id); if (btn) btn.addEventListener("click", fn); }
    press("usdc-retry", function () { if (wallet === null) start(); else run(wallet); });
    press("usdc-resend", function () { run(wallet, resendLeg); });
    press("usdc-check", function () {
      clear();
      setBusy(true);
      engine.check({ wallet: wallet, jobId: opts.jobId, leg: opts.leg, token: opts.token }).then(settle);
    });
    // The already-paid sentence says to reload: this page, this hire.
    var reloadLink = A.el("usdc-reload");
    if (reloadLink) reloadLink.setAttribute("href", window.location.pathname + window.location.search);
    return {
      start: start,
      reset: clear,
      // An ABT start door's already-paid refusal, read the same way.
      alreadyPaid: function (message) { clear(); settle({ outcome: "already_paid", message: message }); }
    };
  }
  window.FAUsdcPay = { create: create, sentence: sentence };
})();
