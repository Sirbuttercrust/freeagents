/* USDC-WEBb: the wallet block the deposit and balance #scan sheets share,
   driving window.FAUsdcWallet. It pays in USDC, or in ABT on Ethereum when
   the page passes rail "abt_eth" (a page that passes none pays in USDC,
   exactly as before). It owns #usdc-pick and #usdc-wallets,
   #scan-waiting, the #usdc-status live region and four footer presses
   (#usdc-retry, #usdc-resend, #usdc-check, #usdc-reload), at most one
   shown, none while a payment runs. Sentences are the engine's, word for
   word, first letter raised, except the ABT-on-Ethereum not-configured
   refusal, which reads in this file's own words. The page decides what
   follows paid and already_paid, and may show a server refusal its own way
   (onRefused). No timers. textContent only (api.js rule 3); an icon is
   drawn only when it is a data:image URI, and only as an <img src>. */
(function () {
  "use strict";
  var A = window.FAApi;
  var PRESSES = ["usdc-retry", "usdc-resend", "usdc-check", "usdc-reload"];
  function sentence(text) {
    var s = typeof text === "string" ? text : "";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // SW2-11: a server refusal offers Try again only when pressing it can
  // get a different answer: the service was unreachable, it said slow
  // down (429), or it failed on its side (5xx) for a reason that can
  // pass, like a storage 503. A rail-not-configured 503 cannot pass on
  // this deployment, told apart by its own words the way deposit.js
  // tells the ABT price 503 apart; the phrase is the part both wallet
  // rails' sentences share ("the usdc payment rail is not configured ...",
  // "the abt_eth payment rail is not configured ..."). Any other 4xx, and
  // a refusal with no status (the start answer named fewer than two
  // transfers, or there is nothing stored to check), says a retry would
  // get the same answer.
  var RAIL_MISSING_PHRASE = "payment rail is not configured";
  // The ABT-on-Ethereum one reads in plain words; the USDC one keeps the
  // server's own, as it always has.
  var ABT_ETH_MISSING_PHRASE = "abt_eth payment rail is not configured";
  var ABT_ETH_MISSING_SENTENCE = "Paying in ABT on Ethereum is not available on this site right now. Nothing was charged.";
  function retryable(result) {
    if (result.unreachable === true) return true;
    var code = result.status;
    if (code === 429) return true;
    if (typeof code !== "number" || code < 500) return false;
    return !(code === 503 && String(result.message).toLowerCase().indexOf(RAIL_MISSING_PHRASE) !== -1);
  }
  function refusalText(result) {
    var lower = String(result.message).toLowerCase();
    return result.status === 503 && lower.indexOf(ABT_ETH_MISSING_PHRASE) !== -1 ? ABT_ETH_MISSING_SENTENCE : result.message;
  }
  // opts: { jobId, token, leg, rail, onBusy(bool), onPaid(), onAlreadyPaid(),
  // onRefused(message), onQuote(quoteLock) }. rail is read at each press
  // (a page may pass a getter) and handed to the engine only when it is a
  // string; onQuote goes to the engine as is, and is also called with null
  // as each attempt begins (start and run, forgetRate). onRefused answers
  // true when the page shows a server refusal its own way; the sheet then
  // stays empty.
  function create(opts) {
    var engine = window.FAUsdcWallet, wallet = null, resendLeg = null, settled = false;
    // Once a leg reads short, nothing more is sent from this device for it:
    // the page is told it is busy from then on, so Pay stays disabled
    // until the page is loaded again.
    function setBusy(on) { A.showById("scan-waiting", on); if (opts.onBusy) opts.onBusy(on || settled); }
    function showOnly(id) { PRESSES.forEach(function (p) { A.showById(p, p === id); }); }
    function status(text) { A.setTextById("usdc-status", sentence(text)); }
    function clear() { A.showById("usdc-pick", false); showOnly(null); status(""); }
    function withRail(base) {
      if (typeof opts.rail === "string") base.rail = opts.rail;
      return base;
    }
    // Each outcome keeps its own sentence; the press shown is the one
    // thing that sentence says to do. mismatched says to send nothing
    // else, so it offers nothing; short says the owner decides, so it
    // offers nothing and is never paid. no_wallet, cancelled, wallet_error
    // and fee_due retry (the engine reuses a sent price). server_refused
    // retries only where a retry can change the answer (retryable).
    function settle(result) {
      var outcome = result.outcome;
      if (outcome === "short") settled = true;
      setBusy(false);
      if (outcome === "server_refused" && opts.onRefused && opts.onRefused(result.message)) { clear(); return; }
      status(outcome === "server_refused" ? refusalText(result) : result.message);
      resendLeg = outcome === "price_due" ? "price" : result.leg;
      if (outcome === "short") { showOnly(null); return; }
      if (outcome === "paid") { showOnly(null); if (opts.onPaid) opts.onPaid(); return; }
      if (outcome === "already_paid") { showOnly("usdc-reload"); if (opts.onAlreadyPaid) opts.onAlreadyPaid(); return; }
      if (outcome === "transfer_failed" || outcome === "price_due") { showOnly("usdc-resend"); return; }
      if (outcome === "waiting_network") { showOnly("usdc-check"); return; }
      if (outcome === "server_refused") { showOnly(retryable(result) ? "usdc-retry" : null); return; }
      showOnly(outcome === "mismatched" ? null : "usdc-retry");
    }
    // A rate on show belongs to the attempt that drew it. Pay (start, which
    // may stop on the wallet pick), a picked wallet, Try again and Send
    // again (run) each empty it first (onQuote(null)), so neither the pick
    // list nor a refused start shows an old price; only this attempt's own
    // lock fills it. Check again keeps it: it reports the same lock.
    function forgetRate() { if (typeof opts.onQuote === "function") opts.onQuote(null); }
    function run(chosen, resend) {
      wallet = chosen;
      clear();
      setBusy(true);
      forgetRate();
      var payOpts = withRail({ wallet: wallet, jobId: opts.jobId, leg: opts.leg, token: opts.token, onQuote: opts.onQuote });
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
      forgetRate();
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
      engine.check(withRail({ wallet: wallet, jobId: opts.jobId, leg: opts.leg, token: opts.token })).then(settle);
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
