/* W11 agreement (SITEMAP P-11): buyer's screen only, agent side is P-25.
   No src/api/app.ts route changes for marking: reads GET /jobs/:jobId,
   marks a line via POST /jobs/:jobId/criteria/:index/accept or
   POST /jobs/:jobId/price/accept, never calls POST /jobs/:jobId/confirm.
   P1's genuine new capability: POST /jobs/:jobId/criteria, which this
   build uses to propose an additional criterion (the wireframe's "Propose
   your own criterion" field).

   PARTY PROBE: GET /jobs/:jobId/attestations already runs the exact
   identity gate this page needs (resolveJobActingParty, app.ts:2790) with
   no side effect, reused rather than adding a fifth route. Every resolved
   party is a buyer: this build offers no wallet or signature, only a
   session, and an Account's DID can never equal an agent's DID (POST
   /accounts and POST /agents each refuse to claim a DID the other holds).
   A signed-request path for the agent is the one open seam this leaves.

   REBUILT ON THE POLISHED WIREFRAME (spec/wireframe/agreement.html,
   spec/wireframe/agreement.css). The retired vocabulary this file no
   longer emits: .thead/.th-line, .trow, .m-you/.m-them, .mark-on/
   .mark-off, .edit, .outstanding (RECONCILE-NOTES.md section 1). The
   matrix is now a <ul class="terms"> of <li> rows, each mark a
   .sigcell > .sig(.is-signed|.is-waiting), and the outstanding panel is
   the wireframe's .lockbar.

   EVERYTHING THROUGH textContent (api.js rule 3). */
(function () {
  "use strict";
  var A = window.FAApi;
  var jobId = "";
  var token = "";
  var agentDisplayName = "the agent";

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
    /* Group 3 of the five failing strings: label only. The href this
       control carries is UNCHANGED (brief: "The href behaviour it
       asserts does not change") -- still the job's own record, not
       /hire, because that is what pinned test coverage already verifies
       for this build. */
    if (back) back.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    renderWho(job);
    renderAll(job);
    wireProposeForm(job);
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    document.title = "Agreement: FreeAgents";
  }

  /* Group 2 of the five failing strings: "Back to profile", wireframe
     line 122. job.agentDid is already fetched here; /agents/:agentDid is
     already served (src/web/static.ts:335). Group 1: the h1 is now the
     wireframe's own static "Agree the terms" (set in the markup); the
     live agent name renders in the .who strip instead, the same trade
     the agent page already makes for its own header. */
  function renderWho(job) {
    var agentDid = typeof job.agentDid === "string" ? job.agentDid : "";
    var profileLink = A.el("agent-profile-link");
    if (agentDid === "") return;
    if (profileLink) profileLink.setAttribute("href", "/agents/" + encodeURIComponent(agentDid));
    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      var name = A.shortDid(agentDid);
      if (result.state === "ok") {
        name = typeof result.value.name === "string" && result.value.name !== "" ? result.value.name : agentDid;
        agentDisplayName = name;
        if (window.FASwarm) {
          var avatarEl = A.el("agent-avatar");
          if (avatarEl) {
            avatarEl.setAttribute("data-avatar", agentDid);
            avatarEl.innerHTML = window.FASwarm.avatar(agentDid, 32);
            avatarEl.removeAttribute("data-pending");
          }
        }
        var operatorLink = A.el("operator-link");
        if (operatorLink && typeof result.value.operatorDid === "string" && result.value.operatorDid !== "") {
          operatorLink.setAttribute("href", "/accounts/" + encodeURIComponent(result.value.operatorDid));
          A.setText(operatorLink, A.shortDid(result.value.operatorDid));
        }
      }
      A.setTextById("agent-name", name);
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
      lines.push({
        kind: "criterion",
        index: i,
        text: typeof c.text === "string" ? c.text : "",
        proposedBy: c.proposedBy === "buyer" || c.proposedBy === "agent" ? c.proposedBy : null,
        you: c.acceptedByBuyer === true,
        them: c.acceptedByAgent === true,
      });
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
    host.textContent = "";
    lines.forEach(function (line, i) { host.appendChild(termRow(line, i + 1, i)); });
    renderLockbar(job, lines);
    renderFixedTerms(job);
    renderRawList(job, lines);
  }

  /* One <li> per line, the wireframe's five-column matrix grid
     (agreement.css .terms > li: num, text, your mark, their mark, act).
     Ruling 2 (P8h, still standing): editing is not in this card. The
     column keeps the wireframe's position and grid; the cell carries the
     "not yet" text, never a button, so nothing here teaches a capability
     the screen does not have. */
  function termRow(line, num, styleIndex) {
    var li = document.createElement("li");
    li.style.setProperty("--i", String(styleIndex));
    li.appendChild(spanWith("num", padNum(num)));

    var textHost = document.createElement("span");
    var txt = spanWith("txt", "");
    if (line.kind === "criterion") {
      txt.textContent = line.text;
    } else if (line.kind === "price") {
      txt.textContent = "Price: " + (typeof line.priceUsd === "string" ? "$" + line.priceUsd : "not recorded") + (typeof line.rail === "string" ? " (" + line.rail + ")" : "");
    } else {
      txt.textContent = "Ready in " + A.plural(line.deliveryWindowDays, "day", "days");
    }
    textHost.appendChild(txt);
    /* Provenance: only a criterion carries proposedBy, and only a line
       the buyer themselves proposed is worth saying so about -- a line
       the agent proposed is the default expectation of this screen and
       needs no annotation (ENT-6.2, wireframe row 05's "you proposed
       this"). No .from for price/delivery: those carry no proposedBy
       field to read honestly. */
    if (line.kind === "criterion" && line.proposedBy === "buyer") {
      var from = document.createElement("span");
      from.className = "from";
      var ico = document.createElement("span");
      ico.className = "ico";
      ico.setAttribute("data-ico", "arrow-right");
      from.appendChild(ico);
      from.appendChild(document.createTextNode("you proposed this"));
      textHost.appendChild(from);
    }
    li.appendChild(textHost);

    li.appendChild(sigCell(line, num, true));
    li.appendChild(sigCell(line, num, false));

    /* No .act button: this screen has no per-line edit capability
       (P8h ruling, src/web/pages/agreement.html handoff, carried
       forward here). A plain span keeps the grid column without
       teaching a control that does nothing. */
    li.appendChild(spanWith("act", "not yet"));
    return li;
  }

  function spanWith(className, text) {
    var span = document.createElement("span");
    span.className = className;
    if (text) span.textContent = text;
    return span;
  }

  /* One mark, as the wireframe draws it: a report for every mark but
     your own outstanding one, which is the one interactive control on
     the row (agreement.css: "the only mark that is also a control").
     Never .is-cleared: nothing in Criterion records that an acceptance
     was cleared by an edit (src/domain/job.ts's proposeCriteria comment),
     so an unaccepted line always renders .is-waiting, honestly silent
     about whether it is new or was cleared. */
  function sigCell(line, num, isYours) {
    var cell = document.createElement("span");
    cell.className = "sigcell";
    var signed = isYours ? line.you : line.them;
    var party = isYours ? "you" : agentDisplayName;

    if (isYours && !signed) {
      var btn = document.createElement("button");
      btn.className = "sig is-waiting";
      btn.type = "button";
      btn.setAttribute("data-party", "you");
      btn.setAttribute("title", "Sign line " + padNum(num));
      btn.setAttribute("aria-label", "Sign line " + padNum(num) + " as you");
      btn.appendChild(sigDot("clock"));
      btn.addEventListener("click", function () { signLine(line, btn); });
      cell.appendChild(btn);
      return cell;
    }

    var mark = document.createElement("span");
    mark.className = "sig " + (signed ? "is-signed" : "is-waiting");
    mark.setAttribute("role", "img");
    mark.setAttribute("data-party", party);
    mark.setAttribute(
      "aria-label",
      signed ? "this line: signed by " + party : "this line: not yet signed by " + party
    );
    mark.appendChild(sigDot(signed ? "check" : "clock"));
    cell.appendChild(mark);
    return cell;
  }

  function sigDot(icon) {
    var dot = document.createElement("span");
    dot.className = "sigdot";
    var ico = document.createElement("span");
    ico.className = "ico";
    ico.setAttribute("data-ico", icon);
    dot.appendChild(ico);
    return dot;
  }

  function signLine(line, btn) {
    btn.disabled = true;
    A.showById("submit-error", false);
    var path = line.kind === "criterion"
      ? "/jobs/" + encodeURIComponent(jobId) + "/criteria/" + line.index + "/accept"
      : "/jobs/" + encodeURIComponent(jobId) + "/price/accept";
    A.postAuthed(path, token, {}).then(function (result) {
      if (result.state !== "ok") { btn.disabled = false; showSubmitError("Could not reach the server just now. Try again in a moment."); return; }
      var status = result.value.status;
      if (status === 200) { renderAll(result.value.body); return; }
      btn.disabled = false;
      var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
      showSubmitError(refusalSentence(status, typeof body.error === "string" ? body.error : ""));
    });
  }

  /* Scope item 8: every refusal gets its own sentence, read off the
     route rather than restated (mutation proof 5: distinctness). */
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

  /* Group 5 (the card's one genuine new capability): "Propose your own
     criterion". POST /jobs/:jobId/criteria takes the FULL list, so a
     propose sends the current criteria's text unchanged (letting the
     server's own diff by exact trimmed text keep every existing line's
     acceptance flags where they are) plus the new line with
     proposedBy: "buyer". A re-propose while status is already
     "proposed" stays in "proposed", no transition (src/domain/job.ts
     proposeCriteria). */
  function wireProposeForm(job) {
    var input = A.el("newcrit");
    var btn = A.el("propose-submit");
    if (!input || !btn) return;
    btn.addEventListener("click", function () {
      var text = input.value.trim();
      A.showById("propose-error", false);
      if (text === "") {
        A.setTextById("propose-error", "Write a criterion before proposing it.");
        A.showById("propose-error", true);
        return;
      }
      btn.disabled = true;
      var criteria = (Array.isArray(job.criteria) ? job.criteria : []).map(function (c) {
        return { text: c.text, proposedBy: c.proposedBy };
      });
      criteria.push({ text: text, proposedBy: "buyer" });
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/criteria", token, { criteria: criteria }).then(function (result) {
        btn.disabled = false;
        if (result.state !== "ok") {
          A.setTextById("propose-error", "Could not reach the server just now. Try again in a moment.");
          A.showById("propose-error", true);
          return;
        }
        var status = result.value.status;
        if (status === 200) {
          job = result.value.body;
          input.value = "";
          renderAll(job);
          return;
        }
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        var message = typeof body.error === "string" && body.error !== "" ? body.error : refusalSentence(status, "");
        A.setTextById("propose-error", message);
        A.showById("propose-error", true);
      });
    });
  }

  /* The outstanding panel reborn as the wireframe's .lockbar: a count and
     a bar instead of a paragraph naming row numbers (agreement.css's own
     header comment on .lockprog explains why). is-open while anything is
     outstanding, is-locked when every line carries both marks; the
     deposit link (a named departure from the wireframe, which draws no
     button on this screen at all) appears only once fully agreed. */
  function renderLockbar(job, lines) {
    var bar = A.el("lockbar");
    var mainEl = A.el("lockmain");
    var subEl = A.el("locksub");
    var countEl = A.el("lockcount");
    var meterHost = A.el("lockmeter");
    var meterFill = A.el("lockmeter-fill");
    var depositRow = A.el("deposit-row");
    if (!bar) return;
    depositRow.hidden = true;

    function setCount(collected, needed) {
      countEl.textContent = "";
      var b = document.createElement("b");
      b.textContent = String(collected);
      countEl.appendChild(b);
      countEl.appendChild(document.createTextNode(" of " + needed));
      var pct = needed > 0 ? (collected / needed) * 100 : 0;
      meterFill.style.width = pct + "%";
      meterHost.setAttribute("aria-label", collected + " of " + needed + " signatures collected");
    }

    if (job.status !== "proposed") {
      bar.className = "lockbar reveal is-open";
      A.setText(mainEl, "This agreement is no longer open for changes.");
      A.setText(subEl, "The hire has moved on. Reload this page to see its current state.");
      setCount(0, 0);
      return;
    }
    if (lines.length === 0) {
      bar.className = "lockbar reveal is-open";
      A.setText(mainEl, "The agent has not proposed any lines yet.");
      A.setText(subEl, "There is nothing to sign until the agent proposes terms.");
      setCount(0, 0);
      return;
    }

    var needed = lines.length * 2;
    var collected = 0;
    var outstandingForYouCount = 0;
    var signedByThem = 0;
    lines.forEach(function (line) {
      if (line.you) collected += 1; else outstandingForYouCount += 1;
      if (line.them) { collected += 1; signedByThem += 1; }
    });
    setCount(collected, needed);

    if (outstandingForYouCount > 0) {
      bar.className = "lockbar reveal is-open";
      A.setText(mainEl, A.plural(outstandingForYouCount, "signature", "signatures") + " to go, waiting on you");
      A.setText(
        subEl,
        signedByThem === lines.length
          ? "The agent has signed every line."
          : "The agent has signed " + signedByThem + " of " + lines.length + " lines."
      );
      return;
    }
    if (signedByThem < lines.length) {
      bar.className = "lockbar reveal is-open";
      A.setText(mainEl, "Waiting on the agent to sign the rest.");
      A.setText(subEl, "You have signed every line.");
      return;
    }
    bar.className = "lockbar reveal is-locked";
    A.setText(mainEl, "This agreement is fully agreed.");
    A.setText(subEl, "The deposit is next.");
    var depositLink = A.el("deposit-link");
    if (depositLink) depositLink.setAttribute("href", "/deposit?job=" + encodeURIComponent(job.id));
    depositRow.hidden = false;
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

  /* Group 4 of the five failing strings: "Show the raw list", wireframe
     lines 313-339. The wireframe prints signature prefixes this build
     does not have (records two independent marks per line, not a
     signature over the line text; R-34 is the seam a later build lands
     that on), so each row states the mark in words instead of
     fabricating a prefix -- never `buyerSig: z...`. */
  function renderRawList(job, lines) {
    var host = A.el("rawlist-items");
    if (!host) return;
    host.textContent = "";
    lines.forEach(function (line, i) {
      var li = document.createElement("li");
      var text = line.kind === "criterion"
        ? line.text
        : line.kind === "price"
          ? "price: " + (typeof line.priceUsd === "string" ? "$" + line.priceUsd : "not recorded")
          : "deliveryWindow: " + A.plural(line.deliveryWindowDays, "day", "days");
      li.appendChild(document.createTextNode((i + 1) + ". " + text));
      var marks = document.createElement("span");
      marks.className = "mono";
      marks.style.color = "var(--fg-3)";
      marks.textContent = " \u00b7 you: " + (line.you ? "signed" : "not yet signed") + " \u00b7 agent: " + (line.them ? "signed" : "not yet signed");
      li.appendChild(marks);
      host.appendChild(li);
    });
    A.setTextById("tech-job-id", typeof job.id === "string" ? job.id : "");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
