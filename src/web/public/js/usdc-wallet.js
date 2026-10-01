/* USDC-WEBa: the browser wallet engine. Plain script, ES2020, no build
   step, no dependency. Pays a deposit or a balance leg in USDC: connects
   an EIP-1193 wallet, signs the two ERC-20 transfers the server already
   priced (price, then fee), and reports both hashes to the existing
   USDC routes (POST .../usdc/start, POST .../usdc/wallet-response).
   No page loads this yet: every call here goes straight at the real
   routes, proven by tests/web/usdc-wallet.test.ts.
   THE RULE: a refused or failed step never reports paid; confirmed is
   only ever set from the server's own { confirmed: true } answer, never
   guessed from a hash existing. No user-facing string here ever says
   "hash", "rail", "settlement", "credential" or a DID. */

(function () {
  "use strict";

  var STORAGE_PREFIX = "fa_usdc_wallet:";
  var ALREADY_PAID_PHRASE = "already been paid";
  var TRANSFER_SELECTOR = "0xa9059cbb";

  // Measured 2026-09-27: the two chains this engine switches to, keyed
  // by the chain id usdc/start names (wallet_addEthereumChain's shape).
  var KNOWN_CHAINS = {
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

  function storageKey(jobId, leg) { return STORAGE_PREFIX + jobId + ":" + leg; }

  function readStored(win, jobId, leg) {
    try {
      var raw = win.localStorage.getItem(storageKey(jobId, leg));
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
  function writeStored(win, jobId, leg, record) {
    try {
      win.localStorage.setItem(storageKey(jobId, leg), JSON.stringify(record));
    } catch (e) { /* see above */ }
  }

  function clearStored(win, jobId, leg) {
    try {
      win.localStorage.removeItem(storageKey(jobId, leg));
    } catch (e) { /* see writeStored */ }
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
  function outcomeFromResponse(win, jobId, leg, result, receipts, feeRefused) {
    if (result.state !== "ok") {
      return { outcome: "server_refused", unreachable: true, message: "Could not reach the payment service. Try again in a moment." };
    }
    var body = result.value.body || {};
    if (result.value.status !== 200) {
      var startError = typeof body.error === "string" ? body.error : "The payment could not be recorded.";
      if (startError.indexOf(ALREADY_PAID_PHRASE) !== -1) {
        clearStored(win, jobId, leg);
        return { outcome: "already_paid", message: startError };
      }
      return { outcome: "server_refused", status: result.value.status, message: startError };
    }
    if (body.confirmed === true) {
      clearStored(win, jobId, leg);
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

  // pay({ wallet, jobId, leg, token, resend }): wallet is one entry from
  // discover(). leg is 'deposit' or 'remainder'. resend is 'price' |
  // 'fee', set only on the buyer's own press after a transfer_failed
  // outcome named that leg; absent, a transfer already known (from this
  // device's own storage or the server's halfPaidRecord) is never sent
  // again.
  async function pay(opts) {
    opts = opts || {};
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

    var startPath = "/jobs/" + encodeURIComponent(jobId) + "/payments/" + leg + "/usdc/start";
    var startResult = await window.FAApi.postAuthed(startPath, token, {});
    if (startResult.state !== "ok") {
      return { outcome: "server_refused", unreachable: true, message: "Could not reach the payment service. Try again in a moment." };
    }
    var startBody = startResult.value.body || {};
    if (startResult.value.status !== 200) {
      var startError = typeof startBody.error === "string" ? startBody.error : "The payment could not start.";
      if (startError.indexOf(ALREADY_PAID_PHRASE) !== -1) {
        clearStored(win, jobId, leg);
        return { outcome: "already_paid", message: startError };
      }
      return { outcome: "server_refused", status: startResult.value.status, message: startError };
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
    var stored = readStored(win, jobId, leg) || {};
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
      writeStored(win, jobId, leg, { priceTxHash: priceHash, feeTxHash: feeHash });
    }

    if (!feeHash) {
      try {
        feeHash = await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: from, to: feeTransfer.tokenContract, data: transferCallData(feeTransfer.recipient, feeTransfer.amountBaseUnits), value: "0x0" }]
        });
        writeStored(win, jobId, leg, { priceTxHash: priceHash, feeTxHash: feeHash });
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
    var responsePath = "/jobs/" + encodeURIComponent(jobId) + "/payments/" + leg + "/usdc/wallet-response";
    var responseResult = await window.FAApi.postAuthed(responsePath, token, { priceTxHash: priceHash, feeTx: feeTx });
    return outcomeFromResponse(win, jobId, leg, responseResult, receipts, feeRefused);
  }

  // check({ wallet, jobId, leg, token }): reads this device's own stored
  // hashes, reads their receipts ONCE (never a timer), and posts
  // usdc/wallet-response once. For a payment pay() left "waiting on the
  // network": the buyer's own later press, never a poll loop.
  async function check(opts) {
    opts = opts || {};
    var win = opts.window || window;
    var wallet = opts.wallet;
    var jobId = opts.jobId;
    var leg = opts.leg;
    var token = opts.token;

    if (!wallet || !wallet.provider) {
      return { outcome: "no_wallet", message: "No wallet was found. Install a wallet extension, or open this page inside your wallet app." };
    }
    var stored = readStored(win, jobId, leg);
    if (!stored || !stored.priceTxHash) {
      return { outcome: "server_refused", message: "There is nothing to check yet for this payment." };
    }
    var feeRefused = !stored.feeTxHash;
    var items = [{ role: "price", hash: stored.priceTxHash }];
    if (!feeRefused) items.push({ role: "fee", hash: stored.feeTxHash });
    var receipts = await pollReceipts(wallet.provider, items, 0, 0);
    var feeTx = feeRefused ? { signed: false } : { signed: true, hash: stored.feeTxHash };
    var responsePath = "/jobs/" + encodeURIComponent(jobId) + "/payments/" + leg + "/usdc/wallet-response";
    var responseResult = await window.FAApi.postAuthed(responsePath, token, { priceTxHash: stored.priceTxHash, feeTx: feeTx });
    return outcomeFromResponse(win, jobId, leg, responseResult, receipts, feeRefused);
  }

  window.FAUsdcWallet = { discover: discover, pay: pay, check: check, transferCallData: transferCallData };
})();
