/* The browser wallet engine. Plain script, ES2020, no build step, no
   dependency. Pays a deposit or a balance leg from a browser wallet:
   connects an EIP-1193 wallet, signs the two ERC-20 transfers the server
   already priced (price, then fee), and reports both transaction ids to
   the routes of the chosen rail: POST .../<rail>/start and
   POST .../<rail>/wallet-response, where <rail> is "usdc" (the default)
   or "abt_eth" (ABT on Ethereum, pay({ rail: "abt_eth" })).
   The USDC checkout (pages/usdc-pay.js, loaded by the deposit and staged
   pages) is the only page that loads this, and it pays in USDC. No page
   passes "abt_eth" yet. Both rails are proven against the real routes by
   tests/web/usdc-wallet.test.ts and tests/web/abt-eth-wallet.test.ts.
   The ABT report also carries the id of the price lock the start answered
   (quoteLockId), and a transfer that arrived after the price hold and is
   worth less now is the outcome "short", never "paid".
   THE RULE: a refused or failed step never reports paid; paid is only
   ever set from the server's own { confirmed: true } answer with no
   "short", never guessed from a transaction id existing. No user-facing
   string here ever says "hash", "rail", "settlement", "credential" or a
   DID. */

(function () {
  "use strict";

  var ALREADY_PAID_PHRASE = "already been paid";
  var TRANSFER_SELECTOR = "0xa9059cbb";

  // The rails this engine pays on. prefix keys the stored record, so a
  // record of one rail is never read as another's; lock is true where the
  // start answers a price lock that the report must name.
  var RAILS = {
    usdc: { name: "usdc", prefix: "fa_usdc_wallet:", lock: false },
    abt_eth: { name: "abt_eth", prefix: "fa_abt_eth_wallet:", lock: true }
  };
  var UNSUPPORTED_RAIL = { outcome: "server_refused", message: "This page cannot pay that way yet. Nothing was charged." };
  var SHORT_SENTENCE =
    "Your payment arrived after the price hold, and ABT is now worth less than the agreed price. The owner will either accept it as paid or send it back to you, and the hire waits until they choose.";
  var NO_SAVED_PRICE_SENTENCE = "There is no saved price for this payment. Start the payment again to finish it.";

  // An absent rail is USDC; anything that is not a key of RAILS is null.
  function railOf(value) {
    if (value === undefined) return RAILS.usdc;
    if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(RAILS, value)) return null;
    return RAILS[value];
  }

  // Measured 2026-09-27 and 2026-10-06: the chains this engine switches to,
  // keyed by the chain id the start answers (wallet_addEthereumChain's shape).
  var KNOWN_CHAINS = {
    1: {
      chainId: "0x1", chainName: "Ethereum",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://ethereum-rpc.publicnode.com"], blockExplorerUrls: ["https://etherscan.io"]
    },
    42161: {
      chainId: "0xa4b1", chainName: "Arbitrum One",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://arb1.arbitrum.io/rpc"], blockExplorerUrls: ["https://arbiscan.io"]
    },
    421614: {
      chainId: "0x66eee", chainName: "Arbitrum Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"], blockExplorerUrls: ["https://sepolia.arbiscan.io"]
    }
  };

  function storageKey(rail, jobId, leg) { return rail.prefix + jobId + ":" + leg; }

  function readStored(win, rail, jobId, leg) {
    try {
      var raw = win.localStorage.getItem(storageKey(rail, jobId, leg));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  // A wallet with storage disabled still completes the payment; it only
  // loses the resume-after-reload convenience, so both writers below
  // swallow their own errors rather than failing the payment over them.
  function writeStored(win, rail, jobId, leg, record) {
    try {
      win.localStorage.setItem(storageKey(rail, jobId, leg), JSON.stringify(record));
    } catch (e) { /* see above */ }
  }

  function clearStored(win, rail, jobId, leg) {
    try {
      win.localStorage.removeItem(storageKey(rail, jobId, leg));
    } catch (e) { /* see writeStored */ }
  }

  // The report body. An ABT report names the price lock too; the USDC
  // body is exactly what it was.
  function reportBody(rail, priceHash, feeTx, lockId) {
    var body = { priceTxHash: priceHash, feeTx: feeTx };
    if (rail.lock) body.quoteLockId = lockId;
    return body;
  }

  // The record kept on this device. USDC's is the two ids it always was;
  // ABT on Ethereum's carries the lock id the start answered beside them.
  function storedRecord(rail, priceHash, feeHash, lockId) {
    var record = { priceTxHash: priceHash, feeTxHash: feeHash };
    if (rail.lock) record.quoteLockId = lockId;
    return record;
  }

  function routePath(rail, jobId, leg, route) {
    return "/jobs/" + encodeURIComponent(jobId) + "/payments/" + leg + "/" + rail.name + "/" + route;
  }

  // EIP-6963: every wallet that answers within the window, deduped by
  // uuid. window.ethereum is listed only when nothing announces, for
  // in-app wallet browsers that inject only that. `win` is a parameter
  // so a test controls exactly what answers.
  function discover(opts) {
    opts = opts || {};
    var win = opts.window || window;
    var discoveryWindowMs = opts.discoveryWindowMs === undefined ? 120 : opts.discoveryWindowMs;
    return new Promise(function (resolve) {
      var found = [];
      var seen = {};
      function onAnnounce(event) {
        var detail = event && event.detail;
        if (!detail || !detail.info || seen[detail.info.uuid]) return;
        seen[detail.info.uuid] = true;
        found.push({ id: detail.info.uuid, name: detail.info.name, icon: detail.info.icon, provider: detail.provider });
      }
      win.addEventListener("eip6963:announceProvider", onAnnounce);
      win.dispatchEvent(new win.Event("eip6963:requestProvider"));
      setTimeout(function () {
        win.removeEventListener("eip6963:announceProvider", onAnnounce);
        if (found.length === 0 && win.ethereum) {
          found.push({ id: "window.ethereum", name: "Browser wallet", icon: "", provider: win.ethereum });
        }
        resolve(found);
      }, discoveryWindowMs);
    });
  }

  function walletErrorMessage(err) {
    if (err && typeof err.message === "string" && err.message !== "") return err.message;
    return "The wallet reported a problem completing this request.";
  }

  // EIP-3326/3085: no unknown-chain error code, so this never branches
  // on one. Any switch failure other than 4001 tries an add, once,
  // then a switch, once more.
  async function ensureChain(provider, chainId) {
    var entry = KNOWN_CHAINS[chainId];
    if (!entry) {
      return { ok: false, message: "This payment is on a network this wallet engine does not support yet." };
    }
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: entry.chainId }] });
      return { ok: true };
    } catch (switchErr) {
      if (switchErr && switchErr.code === 4001) {
        return { ok: false, cancelled: true, message: "You closed the wallet before switching networks." };
      }
      try {
        await provider.request({ method: "wallet_addEthereumChain", params: [entry] });
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: entry.chainId }] });
        return { ok: true };
      } catch (addErr) {
        return { ok: false, message: walletErrorMessage(addErr) };
      }
    }
  }

  // transfer(address,uint256): selector, recipient left-padded to 32
  // bytes, amount from the base-unit decimal string through BigInt so an
  // amount above 2^53 base units survives exactly (never a float).
  function transferCallData(recipient, amountBaseUnits) {
    var addr = String(recipient).toLowerCase().replace(/^0x/, "").padStart(64, "0");
    var amount = BigInt(amountBaseUnits).toString(16).padStart(64, "0");
    return TRANSFER_SELECTOR + addr + amount;
  }

  function receiptStatus(receipt) {
    if (!receipt || receipt.status === undefined || receipt.status === null) return "pending";
    var value = typeof receipt.status === "string" ? parseInt(receipt.status, 16) : receipt.status;
    return value === 1 ? "confirmed" : "failed";
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Reads each hash's receipt once per round. pay() calls this bounded
  // (interval, limit); check() calls it with limit 0, reading once.
  async function pollReceipts(provider, items, intervalMs, limit) {
    var result = {};
    items.forEach(function (item) { result[item.role] = { hash: item.hash, status: "pending" }; });
    async function pollOnce() {
      var pending = items.filter(function (item) { return result[item.role].status === "pending"; });
      for (var i = 0; i < pending.length; i += 1) {
        var receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [pending[i].hash] });
        result[pending[i].role].status = receiptStatus(receipt);
      }
    }
    await pollOnce();
    var attempt = 0;
    while (attempt < limit && items.some(function (item) { return result[item.role].status === "pending"; })) {
      attempt += 1;
      await sleep(intervalMs);
      await pollOnce();
    }
    return result;
  }

  // The one outcome-mapping function pay() and check() both end on: the
  // server's own Confirmation, read against what this device observed on
  // chain, so a transfer this device watched fail on the network reads
  // as failed even where not_confirmed alone can't tell that apart from
  // still-pending.
  function outcomeFromResponse(win, rail, jobId, leg, result, receipts, feeRefused) {
    if (result.state !== "ok") {
      return { outcome: "server_refused", unreachable: true, message: "Could not reach the payment service. Try again in a moment." };
    }
    var body = result.value.body || {};
    if (result.value.status !== 200) {
      var startError = typeof body.error === "string" ? body.error : "The payment could not be recorded.";
      if (startError.indexOf(ALREADY_PAID_PHRASE) !== -1) {
        clearStored(win, rail, jobId, leg);
        return { outcome: "already_paid", message: startError };
      }
      return { outcome: "server_refused", status: result.value.status, message: startError };
    }
    // Both transfers confirmed, but after the price hold and worth less now:
    // nothing settles and the owner decides, so this is never "paid" and
    // nothing more is sent from this device for the leg.
    if (body.confirmed === true && body.short && typeof body.short === "object") {
      clearStored(win, rail, jobId, leg);
      return { outcome: "short", message: SHORT_SENTENCE };
    }
    if (body.confirmed === true) {
      clearStored(win, rail, jobId, leg);
      return { outcome: "paid", message: "This payment is confirmed." };
    }
    var price = receipts.price;
    var fee = receipts.fee;
    var legs = body.legs || {};
    if (price && price.status === "failed" && fee && fee.status === "confirmed") {
      return { outcome: "price_due", message: "The fee transfer landed, but the price transfer did not. Send the price transfer again." };
    }
    if (price && price.status === "failed") {
      return { outcome: "transfer_failed", leg: "price", message: "The price transfer failed on the network. You can send it again." };
    }
    if (fee && fee.status === "failed") {
      return { outcome: "transfer_failed", leg: "fee", message: "The fee transfer failed on the network. You can send it again." };
    }
    // fee_due requires the price CONFIRMED server-side (B49):
    // the price can still be unconfirmed when the fee is
    // refused, and only the server's legs.price.status knows that.
    if (feeRefused && legs.price && legs.price.status === "confirmed") {
      return { outcome: "fee_due", message: "The price transfer landed. The fee transfer is still due." };
    }
    if ((legs.price && legs.price.status === "mismatched") || (legs.fee && legs.fee.status === "mismatched")) {
      return { outcome: "mismatched", message: "One of the transfers did not pay what this job expects. Do not send anything else yet." };
    }
    if (legs.price && legs.price.status === "confirmed" && legs.fee && legs.fee.status !== "confirmed") {
      return { outcome: "waiting_network", message: "The price transfer landed. Waiting for the fee transfer to confirm." };
    }
    return { outcome: "waiting_network", message: "The network has not confirmed this payment yet. Check again shortly." };
  }

  // pay({ wallet, jobId, leg, token, resend, rail }): wallet is one entry
  // from discover(). leg is 'deposit' or 'remainder'. rail is 'usdc'
  // (the default) or 'abt_eth'; anything else is refused with a sentence
  // before any request or wallet call. resend is 'price' | 'fee', set
  // only on the buyer's own press after a transfer_failed outcome named
  // that leg; absent, a transfer already known (from this device's own
  // storage or the server's halfPaidRecord) is never sent again.
  async function pay(opts) {
    opts = opts || {};
    var rail = railOf(opts.rail);
    if (rail === null) return UNSUPPORTED_RAIL;
    var win = opts.window || window;
    var wallet = opts.wallet;
    var jobId = opts.jobId;
    var leg = opts.leg;
    var token = opts.token;
    var resend = opts.resend;
    var pollIntervalMs = opts.pollIntervalMs === undefined ? 1500 : opts.pollIntervalMs;
    var pollLimit = opts.pollLimit === undefined ? 20 : opts.pollLimit;

    if (!wallet || !wallet.provider) {
      return { outcome: "no_wallet", message: "No wallet was found. Install a wallet extension, or open this page inside your wallet app." };
    }
    var provider = wallet.provider;

    var accounts;
    try {
      accounts = await provider.request({ method: "eth_requestAccounts" });
    } catch (err) {
      if (err && err.code === 4001) return { outcome: "cancelled", message: "You closed the wallet before approving." };
      return { outcome: "wallet_error", message: walletErrorMessage(err) };
    }
    var from = accounts && accounts[0];

    var startResult = await window.FAApi.postAuthed(routePath(rail, jobId, leg, "start"), token, {});
    if (startResult.state !== "ok") {
      return { outcome: "server_refused", unreachable: true, message: "Could not reach the payment service. Try again in a moment." };
    }
    var startBody = startResult.value.body || {};
    if (startResult.value.status !== 200) {
      var startError = typeof startBody.error === "string" ? startBody.error : "The payment could not start.";
      if (startError.indexOf(ALREADY_PAID_PHRASE) !== -1) {
        clearStored(win, rail, jobId, leg);
        return { outcome: "already_paid", message: startError };
      }
      if (rail.lock && startResult.value.status === 503 && startError.toLowerCase().indexOf(window.FAApi.ABT_PRICE_PHRASE) !== -1) {
        return { outcome: "server_refused", status: 503, message: window.FAApi.ABT_PRICE_SENTENCE };
      }
      return { outcome: "server_refused", status: startResult.value.status, message: startError };
    }

    // The report names the lock this start answered, so a start with no
    // usable lock is refused before the wallet is asked to do anything.
    var quoteLock = startBody.quoteLock;
    var lockId = quoteLock && typeof quoteLock.id === "string" && quoteLock.id !== "" ? quoteLock.id : null;
    if (rail.lock && lockId === null) {
      return { outcome: "server_refused", message: window.FAApi.ABT_PRICE_SENTENCE };
    }

    var chainResult = await ensureChain(provider, startBody.chainId);
    if (!chainResult.ok) {
      return { outcome: chainResult.cancelled ? "cancelled" : "wallet_error", message: chainResult.message };
    }

    var transfers = startBody.transfers || [];
    var priceTransfer = transfers[0];
    var feeTransfer = transfers[1];
    if (!priceTransfer || !feeTransfer) {
      return { outcome: "server_refused", message: "The payment service did not name both transfers." };
    }

    // A known hash is reused whenever one exists (B49):
    // a transfer can still be "not_confirmed" (merely slow)
    // rather than failed, and only a buyer's own resend press after a
    // transfer_failed outcome ever sends a known transfer again.
    var stored = readStored(win, rail, jobId, leg) || {};
    var halfPaidRecord = startBody.halfPaidRecord;
    var priceHash =
      resend === "price"
        ? null
        : (halfPaidRecord && halfPaidRecord.priceTxHash ? halfPaidRecord.priceTxHash : stored.priceTxHash) || null;
    var feeHash =
      resend === "fee"
        ? null
        : (halfPaidRecord && halfPaidRecord.feeTxHash ? halfPaidRecord.feeTxHash : stored.feeTxHash) || null;
    var feeRefused = false;

    if (!priceHash) {
      try {
        priceHash = await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: from, to: priceTransfer.tokenContract, data: transferCallData(priceTransfer.recipient, priceTransfer.amountBaseUnits), value: "0x0" }]
        });
      } catch (err) {
        if (err && err.code === 4001) return { outcome: "cancelled", message: "You closed the wallet before approving the price transfer." };
        return { outcome: "wallet_error", message: walletErrorMessage(err) };
      }
      writeStored(win, rail, jobId, leg, storedRecord(rail, priceHash, feeHash, lockId));
    }

    if (!feeHash) {
      try {
        feeHash = await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: from, to: feeTransfer.tokenContract, data: transferCallData(feeTransfer.recipient, feeTransfer.amountBaseUnits), value: "0x0" }]
        });
        writeStored(win, rail, jobId, leg, storedRecord(rail, priceHash, feeHash, lockId));
      } catch (err) {
        // Either the buyer refused, or the wallet failed some other way:
        // the price already sent, so this reports as the fee still due,
        // never as a cancellation implying nothing happened.
        feeRefused = true;
      }
    }

    var pollItems = [{ role: "price", hash: priceHash }];
    if (!feeRefused) pollItems.push({ role: "fee", hash: feeHash });
    var receipts = await pollReceipts(provider, pollItems, pollIntervalMs, pollLimit);

    var feeTx = feeRefused ? { signed: false } : { signed: true, hash: feeHash };
    var responseResult = await window.FAApi.postAuthed(routePath(rail, jobId, leg, "wallet-response"), token, reportBody(rail, priceHash, feeTx, lockId));
    return outcomeFromResponse(win, rail, jobId, leg, responseResult, receipts, feeRefused);
  }

  // check({ wallet, jobId, leg, token, rail }): reads this device's own
  // stored transaction ids (and, for ABT on Ethereum, the stored price
  // lock id), reads their receipts ONCE (never a timer), and posts
  // <rail>/wallet-response once. For a payment pay() left "waiting on the
  // network": the buyer's own later press, never a poll loop.
  async function check(opts) {
    opts = opts || {};
    var rail = railOf(opts.rail);
    if (rail === null) return UNSUPPORTED_RAIL;
    var win = opts.window || window;
    var wallet = opts.wallet;
    var jobId = opts.jobId;
    var leg = opts.leg;
    var token = opts.token;

    if (!wallet || !wallet.provider) {
      return { outcome: "no_wallet", message: "No wallet was found. Install a wallet extension, or open this page inside your wallet app." };
    }
    var stored = readStored(win, rail, jobId, leg);
    if (!stored || !stored.priceTxHash) {
      return { outcome: "server_refused", message: "There is nothing to check yet for this payment." };
    }
    var lockId = typeof stored.quoteLockId === "string" && stored.quoteLockId !== "" ? stored.quoteLockId : null;
    if (rail.lock && lockId === null) {
      return { outcome: "server_refused", message: NO_SAVED_PRICE_SENTENCE };
    }
    var feeRefused = !stored.feeTxHash;
    var items = [{ role: "price", hash: stored.priceTxHash }];
    if (!feeRefused) items.push({ role: "fee", hash: stored.feeTxHash });
    var receipts = await pollReceipts(wallet.provider, items, 0, 0);
    var feeTx = feeRefused ? { signed: false } : { signed: true, hash: stored.feeTxHash };
    var responseResult = await window.FAApi.postAuthed(routePath(rail, jobId, leg, "wallet-response"), token, reportBody(rail, stored.priceTxHash, feeTx, lockId));
    return outcomeFromResponse(win, rail, jobId, leg, responseResult, receipts, feeRefused);
  }

  window.FAUsdcWallet = { discover: discover, pay: pay, check: check, transferCallData: transferCallData };
})();
