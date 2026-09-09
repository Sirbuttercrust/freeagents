/* P8h agreement (SITEMAP P-11): buyer's screen only, agent side is P-25.
   No src/api/app.ts route changes: reads GET /jobs/:jobId, marks a line
   via POST /jobs/:jobId/criteria/:index/accept or
   POST /jobs/:jobId/price/accept, never calls POST /jobs/:jobId/confirm.

   PARTY PROBE: GET /jobs/:jobId/attestations already runs the exact
   identity gate this page needs (resolveJobActingParty, app.ts:2790) with
   no side effect, reused rather than adding a fifth route. Every resolved
   party is a buyer: this build offers no wallet or signature, only a
   session, and an Account's DID can never equal an agent's DID (POST
   /accounts and POST /agents each refuse to claim a DID the other holds).
   A signed-request path for the agent is the one open seam this leaves.

   EVERYTHING THROUGH textContent (api.js rule 3). */
(function () {
  "use strict";
  var A = window.FAApi;
  var jobId = "";
  var token = "";
  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    var session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
    Promise.all([
      A.get("/jobs/" + encodeURIComponent(jobId)),
      A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/attestations", token)
    ]).then(onLoaded);
  }

  function onLoaded(results) {
    var jobResult = results[0];
    var gate = results[1];
    if (jobResult.state === "absent") { failLoad("There is no hire at that address."); return; }
    if (jobResult.state !== "ok") { failLoad("The record could not be loaded just now. Reloading may work."); return; }
    if (gate.state !== "ok") { failLoad("Could not confirm your access to this hire just now. Reloading may work."); return; }
    var status = gate.value.status;
    var body = gate.value.body && typeof gate.value.body === "object" ? gate.value.body : {};
    if (status === 401) {
      A.setTextById("signin-required-title", "Your session has expired. Sign in again to read and sign this agreement.");
      A.showById("signin-required", true);
      return;
    }
    if (status === 403) {
      A.setTextById("party-error-detail", typeof body.error === "string" && body.error !== "" ? body.error : "Only the buyer and the agent named on this hire can read and mark these lines.");
      A.showById("party-error", true);
      return;
    }
    if (status === 404) { failLoad("There is no hire at that address."); return; }
    if (status !== 200) { failLoad("Your access to this hire could not be confirmed just now. Reloading may work."); return; }
    A.showById("agreement-body", true);
    var job = jobResult.value;
    var back = A.el("back-link");
    if (back) back.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    renderWho(job);
    renderAll(job);
  }
  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    document.title = "Agreement: FreeAgents";
  }
  function renderWho(job) {
    var agentDid = typeof job.agentDid === "string" ? job.agentDid : "";
    if (agentDid === "") return;
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
      A.setTextById("agreement-h1", "What " + name + " is offering");
      document.title = "Agreement with " + name + ": FreeAgents";
    });
  }
  /* One ordered list (DATA-CONTRACT 8.1: never three lists). Price and
     delivery share ONE acceptance pair -- POST /jobs/:jobId/price/accept
     carries no index -- a named departure from the wireframe's two
     independently-signable rows 06/07. */
  function agreementLines(job) {
    var lines = [];
    (Array.isArray(job.criteria) ? job.criteria : []).forEach(function (c, i) {
      lines.push({ kind: "criterion", index: i, text: typeof c.text === "string" ? c.text : "", you: c.acceptedByBuyer === true, them: c.acceptedByAgent === true });
    });
    var price = job.price && typeof job.price === "object" ? job.price : null;
    if (price !== null) {
      var you = price.acceptedByBuyer === true;
      var them = price.acceptedByAgent === true;
      lines.push({ kind: "price", priceUsd: price.priceUsd, rail: price.rail, you: you, them: them });
      if (typeof price.deliveryWindowDays === "number") {
        lines.push({ kind: "delivery", deliveryWindowDays: price.deliveryWindowDays, you: you, them: them });
      }
    }
    return lines;
  }

  function padNum(n) { return n < 10 ? "0" + n : String(n); }
  function renderAll(job) {
    var lines = agreementLines(job);
    var host = A.el("terms");
    Array.prototype.slice.call(host.querySelectorAll(".trow")).forEach(function (row) { row.remove(); });
    lines.forEach(function (line, i) { host.appendChild(termRow(job, line, i + 1)); });
    renderOutstanding(job, lines);
    renderFixedTerms(job);
    A.setTextById("tech-spec-hash", typeof job.specHash === "string" && job.specHash !== "" ? job.specHash : "not computed yet");
  }

  function termRow(job, line, num) {
    var row = document.createElement("div");
    row.className = "trow";
    row.appendChild(spanWith("num", padNum(num)));
    var lineSpan = document.createElement("span");
    lineSpan.className = "line";
    if (line.kind === "criterion") {
      lineSpan.textContent = line.text;
    } else {
      var b = document.createElement("b");
      var why = spanWith("why", line.kind === "price" ? "The whole job, quoted by the agent." : "Counted from the deposit landing, not from today.");
      b.textContent = line.kind === "price"
        ? "Price: " + (typeof line.priceUsd === "string" ? "$" + line.priceUsd : "not recorded") + (typeof line.rail === "string" ? " (" + line.rail + ")" : "")
        : "Ready in " + A.plural(line.deliveryWindowDays, "day", "days");
      lineSpan.appendChild(b);
      lineSpan.appendChild(why);
    }
    row.appendChild(lineSpan);
    row.appendChild(markCell(job, line, num, "m-you", line.you, true));
    row.appendChild(markCell(job, line, num, "m-them", line.them, false));
    /* Ruling 2: editing is not in this card. The column keeps the
       wireframe's position and grid; no button, so nothing here can
       teach a false capability (claim-contradicts-implementation). */
    row.appendChild(spanWith("edit", "", spanWith("act", "not yet")));
    return row;
  }

  function spanWith(className, text, child) {
    var span = document.createElement("span");
    span.className = className;
    if (text) span.textContent = text;
    if (child) span.appendChild(child);
    return span;
  }
  function markCell(job, line, num, cellClass, signed, isYours) {
    var cell = document.createElement("span");
    cell.className = cellClass;
    var label = isYours ? (signed ? "You signed" : "Sign this line") : (signed ? "Agent signed" : "Agent has not signed");
    cell.setAttribute("data-who", label);
    if (isYours && !signed) {
      var btn = document.createElement("button");
      btn.className = "mark mark-off";
      btn.type = "button";
      btn.setAttribute("aria-label", "Sign line " + num);
      btn.addEventListener("click", function () { signLine(job, line, btn); });
      cell.appendChild(btn);
      return cell;
    }
    var mark = spanWith("mark " + (signed ? "mark-on" : "mark-off"), "");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", label + " line " + num);
    cell.appendChild(mark);
    return cell;
  }
  function signLine(job, line, btn) {
    btn.disabled = true;
    A.showById("submit-error", false);
    var path = line.kind === "criterion"
      ? "/jobs/" + encodeURIComponent(job.id) + "/criteria/" + line.index + "/accept"
      : "/jobs/" + encodeURIComponent(job.id) + "/price/accept";
    A.postAuthed(path, token, {}).then(function (result) {
      if (result.state !== "ok") { btn.disabled = false; showSubmitError("Could not reach the server just now. Try again in a moment."); return; }
      var status = result.value.status;
      if (status === 200) { renderAll(result.value.body); return; }
      btn.disabled = false;
      var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
      showSubmitError(refusalSentence(status, typeof body.error === "string" ? body.error : ""));
    });
  }

  /* Scope item 8: every refusal gets its own sentence, read off the route
     rather than restated (mutation proof 5: distinctness). */
  function refusalSentence(status, serverMessage) {
    if (status === 401) return "Your session has expired. Sign in again to sign this line.";
    if (status === 403) return serverMessage || "This account is no longer recognised as a party to this job.";
    if (status === 400) return serverMessage || "That line could not be signed as sent.";
    if (status === 409) return "This agreement changed since the page loaded. Reload the page to see the latest state before signing.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "That line could not be signed just now.";
  }
  function showSubmitError(message) {
    A.setTextById("submit-error-detail", message);
    A.showById("submit-error", true);
  }
  /* Decodes state into an actionable sentence; never merely reports a
     status (scope item 6). */
  function renderOutstanding(job, lines) {
    var host = A.el("outstanding");
    host.textContent = "";
    if (job.status !== "proposed") {
      host.appendChild(textNode("p", "This agreement is no longer open for changes: the hire has moved on. Reload this page to see its current state."));
      return;
    }
    if (lines.length === 0) {
      host.appendChild(textNode("p", "The agent has not proposed any lines yet."));
      return;
    }
    var outstandingForYou = [];
    var signedByThem = 0;
    lines.forEach(function (line, i) {
      if (!line.you) outstandingForYou.push(i + 1);
      if (line.them) signedByThem += 1;
    });
    if (outstandingForYou.length > 0) {
      host.appendChild(textNode("b", A.plural(outstandingForYou.length, "line is", "lines are") + " waiting on your signature: " + outstandingForYou.join(", ") + "."));
      var note = textNode("p", signedByThem === lines.length ? "The agent has signed every line." : "The agent has signed " + signedByThem + " of " + lines.length + " lines.");
      note.style.marginTop = "6px";
      host.appendChild(note);
      return;
    }
    if (signedByThem < lines.length) {
      host.appendChild(textNode("p", "You have signed every line. The agreement is waiting on the agent to sign the rest."));
      return;
    }
    var lockedLine = textNode("b", "This agreement is fully agreed. The deposit is next.");
    host.appendChild(lockedLine);
    var depositRow = document.createElement("div");
    depositRow.className = "row";
    depositRow.style.marginTop = "14px";
    var depositLink = document.createElement("a");
    depositLink.className = "btn btn-primary";
    depositLink.id = "deposit-link";
    depositLink.setAttribute("href", "/deposit?job=" + encodeURIComponent(job.id));
    depositLink.textContent = "Pay the deposit";
    depositRow.appendChild(depositLink);
    host.appendChild(depositRow);
  }

  function textNode(tag, text) {
    var node = document.createElement(tag);
    node.textContent = text;
    return node;
  }
  /* Scope item 7: no controls, no marks; figures derived from the agreed
     price using depositPercent/redoAllowance, never a hardcoded 25.
     Before a price exists, shares are stated in words. */
  function renderFixedTerms(job) {
    var price = job.price && typeof job.price === "object" ? job.price : null;
    A.setTextById("fixed-redo-v", price && typeof price.redoAllowance === "number" ? A.plural(price.redoAllowance, "redo", "redos") : "once per hire");
    if (price === null || typeof price.priceUsd !== "string") {
      A.setTextById("fixed-deposit-v", "a quarter of the price");
      A.setTextById("fixed-balance-v", "three quarters of the price");
      return;
    }
    var total = parseFloat(price.priceUsd);
    var depositPercent = typeof price.depositPercent === "number" ? price.depositPercent : 25;
    if (isNaN(total)) {
      A.setTextById("fixed-deposit-v", "not recorded");
      A.setTextById("fixed-balance-v", "not recorded");
      return;
    }
    var deposit = (total * depositPercent) / 100;
    A.setTextById("fixed-deposit-v", "$" + deposit.toFixed(2) + " of $" + total.toFixed(2));
    A.setTextById("fixed-balance-v", "$" + (total - deposit).toFixed(2) + " of $" + total.toFixed(2));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
