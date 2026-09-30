/* W11 agreement (SITEMAP P-11): one page, two seats. The buyer and the
   agent's owner (its operator, signed in) each sign their own side of every
   line and each can propose a change to any line, the price or the window
   while the agreement is open (FIX-B40 for the owner; SW3-04 for the buyer,
   after the 2026-08-28 ruling "Either side revises, line by line"). Only
   the owner writes the first quote (the draft composer). Reads GET
   /jobs/:jobId, marks a line via POST
   /jobs/:jobId/criteria/:index/accept or POST /jobs/:jobId/price/accept
   (the server takes the side from the session), sends lines and the price
   via POST /jobs/:jobId/criteria, and never calls POST /jobs/:jobId/confirm.
   agreement-edit.js builds the fields; every request is made here.

   PARTY PROBE: GET /jobs/:jobId/attestations runs the job's identity gate
   (resolveJobActingParty) with no side effect: 401, 403, or a party. It
   does not say which side, so GET /accounts/me supplies the caller's DID:
   the buyer's side when it equals job.buyerDid (the server's own order,
   partyForDid checks the buyer first), the owner's side for any other
   party. If /accounts/me does not answer, the page shows the load error
   and renders no control rather than guessing a side.

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
  /* isOwner: the agent's side. buyerName: "@login", or null for "the
     buyer". openEdit: which row's editor is open ("c0", "price", "days"). */
  var isOwner = false;
  var buyerName = null;
  var openEdit = null;
  var currentJob = null;
  var E = window.FAAgreementEdit;

  function start() {
    jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (!jobId) { failLoad("This address does not name a hire."); return; }
    var session = A.getStoredSession();
    if (session === null) { A.showById("signin-required", true); return; }
    token = session.token;
    Promise.all([
      A.get("/jobs/" + encodeURIComponent(jobId)),
      A.getAuthed("/jobs/" + encodeURIComponent(jobId) + "/attestations", token),
      A.getAuthed("/accounts/me", token)
    ]).then(onLoaded);
  }

  function onLoaded(results) {
    var jobResult = results[0];
    var gate = results[1];
    var me = results[2];
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
    var job = jobResult.value;
    if (me.state !== "ok" || me.value.status !== 200 || !me.value.body || typeof me.value.body.did !== "string") {
      failLoad("Could not tell which side of this hire you are on just now. Reloading may work.");
      return;
    }
    isOwner = me.value.body.did !== job.buyerDid;
    if (!isOwner) { showBody(job); return; }
    A.get("/accounts/" + encodeURIComponent(job.buyerDid)).then(function (r) {
      var login = r.state === "ok" && r.value ? r.value.githubLogin : null;
      buyerName = typeof login === "string" && login !== "" ? "@" + login : null;
      showBody(job);
    });
  }

  function showBody(job) {
    A.showById("agreement-body", true);
    /* The job's own record for the buyer; the operator's page for the
       owner, which carries the brief too. */
    var back = A.el("back-link");
    var own = "/operatorjob?job=" + encodeURIComponent(job.id);
    if (back) back.setAttribute("href", isOwner ? own : "/jobs/" + encodeURIComponent(job.id));
    if (isOwner) {
      A.el("s1-link").setAttribute("href", own);
      A.el("leave-link").setAttribute("href", "/incoming");
      A.setTextById("h-them", buyerName || "Buyer");
    }
    renderWho(job);
    renderAll(job);
    wireProposeForm();
  }

  /* FIX-SW12i: the walk-away control for whichever side holds the page,
     under the line that promises it ("Either side can walk away"). The
     buyer withdraws, the owner declines (api.js walkAway carries the
     window, the sheet and the departure). A 200 goes to the page that
     writes the end state: the job's record for the buyer, the operator's
     page for the owner. Re-run on every render, because signing the last
     line closes the window. */
  function renderWalkAway(job) {
    var kind = isOwner ? "decline" : "withdraw";
    var dest = isOwner ? "/operatorjob?job=" + encodeURIComponent(job.id) : "/jobs/" + encodeURIComponent(job.id);
    var row = A.walkAway(kind, document.querySelector("#agreement-body .draftflag"), job.id, token, function () {
      window.location.href = dest;
    });
    if (row) row.hidden = !A.walkAwayOpen(job);
  }

  function them(capital) { return buyerName || (capital ? "The buyer" : "the buyer"); }

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
      /* B57 (FIX-CIFLAKE cause 1): a read that answers after the page itself
         has torn down (the jsdom tests close every window they render, which
         deletes window.document) writes nothing rather than throwing into a
         gone page. */
      if (typeof document === "undefined" || !document) return;
      var name = A.shortDid(agentDid);
      if (result.state === "ok") {
        name = typeof result.value.name === "string" && result.value.name !== "" ? result.value.name : agentDid;
        agentDisplayName = name;
        if (window.FABots) {
          window.FABots.mount(A.el("agent-avatar"), agentDid, { spec: result.value.avatarSpec, size: 32 });
        }
        /* SW2-07: the operator is named the way /hire and /jobs name them,
           "@login" or "See who runs this agent", never the DID (DESIGN.md
           9). The helper sets the link's href and keeps the row hidden
           until the account read settles. */
        A.nameOperator("operated-by", "operator-link", result.value.operatorDid);
      }
      A.setTextById("agent-name", name);
      document.title = "Agreement with " + name + ": FreeAgents";
    });
  }

  /* One ordered list (DATA-CONTRACT 8.1: never three lists). Price and
     delivery share ONE acceptance pair -- POST /jobs/:jobId/price/accept
     carries no index -- a named departure from the wireframe's two
     independently-signable rows 06/07. `you` is the reader's own mark:
     the buyer's on the buyer's side, the agent's on the owner's. */
  function agreementLines(job) {
    var lines = [];
    function mine(buyerMark, agentMark) { return isOwner ? agentMark === true : buyerMark === true; }
    function theirs(buyerMark, agentMark) { return isOwner ? buyerMark === true : agentMark === true; }
    (Array.isArray(job.criteria) ? job.criteria : []).forEach(function (c, i) {
      lines.push({
        kind: "criterion",
        index: i,
        text: typeof c.text === "string" ? c.text : "",
        proposedBy: c.proposedBy === "buyer" || c.proposedBy === "agent" ? c.proposedBy : null,
        you: mine(c.acceptedByBuyer, c.acceptedByAgent),
        them: theirs(c.acceptedByBuyer, c.acceptedByAgent),
      });
    });
    var price = job.price && typeof job.price === "object" ? job.price : null;
    if (price !== null) {
      var you = mine(price.acceptedByBuyer, price.acceptedByAgent);
      var them = theirs(price.acceptedByBuyer, price.acceptedByAgent);
      lines.push({ kind: "price", priceUsd: price.priceUsd, rail: price.rail, you: you, them: them });
      if (typeof price.deliveryWindowDays === "number") {
        lines.push({ kind: "delivery", deliveryWindowDays: price.deliveryWindowDays, you: you, them: them });
      }
    } else if (isOwner && job.status === "proposed") {
      /* No price yet (the buyer sent lines first): a row to set one, with
         no marks, since there is nothing to sign until a price exists. The
         owner's alone: the agent names the first price, and the buyer's
         price row appears once one exists. */
      lines.push({ kind: "price", priceUsd: null, unset: true, you: false, them: false });
    }
    return lines;
  }

  function padNum(n) { return n < 10 ? "0" + n : String(n); }

  function isOpen(job) { return job.status === "proposed"; }

  function renderAll(job) {
    currentJob = job;
    var composing = isOwner && job.status === "draft";
    var lines = composing ? [] : agreementLines(job);
    A.show(A.el("terms-pane"), !composing);
    A.show(A.el("lockbar"), !composing);
    A.show(A.el("propose-field"), isOpen(job) || (!isOwner && job.status === "draft"));
    renderComposer(job, composing);
    /* The buyer's open lede is the markup's own. A buyer's draft has no row
       control yet (the agent has not quoted), so it says what the buyer
       can do there instead; a closed agreement reads the same on both
       sides. */
    if (isOwner || !isOpen(job)) {
      A.setTextById("lede", composing
        ? "Write what you will deliver, your price and the days it takes. The buyer signs each line."
        : isOpen(job)
          ? "Sign the lines you agree with. Changing a line clears both signatures on it."
          : !isOwner && job.status === "draft"
            ? "The agent has not sent its quote yet. You can propose lines for it below."
            : "This agreement is closed to changes.");
    }
    var host = A.el("terms");
    host.textContent = "";
    lines.forEach(function (line, i) { host.appendChild(termRow(line, i + 1, i, job)); });
    renderLockbar(job, lines);
    renderFixedTerms(job);
    renderRawList(job, lines);
    renderWalkAway(job);
    /* QA round 2, D2 script-rendered-icon-never-painted: icons.js paints
       once on DOMContentLoaded and polish.js once in init(), both before
       this fetch resolves, so every host this function builds (the
       .sigdot marks, the .from proposer arrow, the .act edit glyph) would
       otherwise stay empty forever, including after a re-render on sign
       or send. Same guarded call polish.js:66 already uses for
       script-inserted toast nodes. */
    if (window.FAIcon) window.FAIcon.paint(host);
    var editor = host.querySelector(".line-edit");
    if (editor && editor.focusField) editor.focusField();
  }

  /* The composer is the owner's draft seat only. A half-written quote
     lives in sessionStorage under one key per job, so a reload keeps it,
     and the key is cleared once the quote is sent. A saved draft that is
     not JSON is dropped, and storage that refuses a write costs only the
     reload copy, never the send. */
  function renderComposer(job, composing) {
    var host = A.el("composer-host");
    host.textContent = "";
    A.show(host, composing);
    if (!composing) return;
    var key = "fa_quote_draft:" + job.id;
    var saved = null;
    try { saved = JSON.parse(window.sessionStorage.getItem(key) || "null"); } catch (e) { saved = null; }
    host.appendChild(E.composer({
      saved: saved,
      onChange: function (state) {
        try { window.sessionStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* reload copy only */ }
      },
      send: function (quote) {
        var criteria = quote.lines.map(function (t) { return { text: t, proposedBy: "agent" }; });
        return sendQuote({ criteria: criteria, priceUsd: quote.priceUsd, deliveryWindowDays: quote.deliveryWindowDays }).then(function (refusal) {
          if (refusal === null) window.sessionStorage.removeItem(key);
          return refusal;
        });
      },
    }));
    if (window.FAIcon) window.FAIcon.paint(host);
  }

  /* The current list as the route wants it: every line, text unchanged,
     so the server's diff keeps every mark a send does not touch. */
  function currentCriteria(job) {
    return (Array.isArray(job.criteria) ? job.criteria : []).map(function (c) {
      return { text: c.text, proposedBy: c.proposedBy };
    });
  }

  /* One POST /jobs/:jobId/criteria from either side. Resolves null
     once the page has re-rendered from the response, or the sentence for
     a refusal (the page is left as it was). Never sends rail: the quote
     leaves the currency open and the buyer picks at checkout. */
  function sendQuote(body) {
    A.showById("submit-error", false);
    return A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/criteria", token, body).then(function (result) {
      if (result.state !== "ok") return "Could not reach the server just now. Try again in a moment.";
      var status = result.value.status;
      if (status === 200) { openEdit = null; renderAll(result.value.body); return null; }
      var b = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
      return sendRefusal(status, typeof b.error === "string" ? b.error : "");
    });
  }

  /* A 403 names the remedy the reader can take: signing in as the agent's
     owner is the owner's, and means nothing to the buyer. A 400 is the
     server's own sentence (the floor refusal names the floor). */
  function sendRefusal(status, serverMessage) {
    if (status === 401) return "Your session has expired. Sign in again to send this.";
    if (status === 409) return "This agreement changed since the page loaded. Reload the page to see the latest state.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    if (status === 403) return serverMessage || (isOwner ? "This account can no longer change this agreement. Sign in as the agent's owner." : "This account can no longer change this agreement.");
    return serverMessage || "That could not be sent just now. Try again in a moment.";
  }

  /* The price and the window travel together: a send naming a price
     without the window resets the window to the server's default, so
     each edit carries the other value unchanged. */
  function priceBody(job, priceUsd, days) {
    var body = { criteria: currentCriteria(job), priceUsd: priceUsd };
    if (typeof days === "number") body.deliveryWindowDays = days;
    return body;
  }

  /* One editor for either side. A changed line carries the reader's own
     side as proposedBy (the route stamps the caller's seat anyway; the
     page never claims the other side's). */
  function rowEditor(line, key, job) {
    function close() { openEdit = null; renderAll(currentJob); }
    var price = job.price || {};
    if (line.kind === "criterion") {
      return E.lineEditor("Line " + padNum(line.index + 1), line.text, function (text) {
        var criteria = currentCriteria(job);
        criteria[line.index] = { text: text, proposedBy: isOwner ? "agent" : "buyer" };
        return sendQuote({ criteria: criteria });
      }, close);
    }
    if (line.kind === "price") {
      return E.priceEditor(line.priceUsd || "", function (usd) {
        return sendQuote(priceBody(job, usd, price.deliveryWindowDays));
      }, close);
    }
    return E.daysEditor(line.deliveryWindowDays, function (days) {
      return sendQuote(priceBody(job, price.priceUsd, days));
    }, close);
  }

  function actControl(line, num, key) {
    var btn = document.createElement("button");
    btn.className = "act";
    btn.type = "button";
    var label = line.kind === "criterion" ? "Propose a change to line " + padNum(num)
      : line.kind === "price" ? "Propose a different price" : "Propose a different window";
    btn.setAttribute("title", label);
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-expanded", openEdit === key ? "true" : "false");
    var ico = document.createElement("span");
    ico.className = "ico";
    ico.setAttribute("data-ico", "edit");
    btn.appendChild(ico);
    btn.addEventListener("click", function () {
      openEdit = openEdit === key ? null : key;
      renderAll(currentJob);
    });
    return btn;
  }

  /* One <li> per line, the wireframe's five-column matrix grid
     (agreement.css .terms > li: num, text, your mark, their mark, act).
     The act column, the same on both sides: on an open agreement, the
     edit control that opens this row's editor under it (the wireframe's
     "Propose a change to line NN"), and an empty cell on any other status.
     Both sides revise line by line (ruled 2026-08-28; SW3-04 gave the
     buyer the control the owner already had). Once a quote is sent a line
     can be changed but never removed: a send that omits a line drops it
     while every other line keeps its signatures, so a removal could lock
     an agreement on a set the other side never saw whole. Removing a line
     is the owner's draft composer's alone. */
  function termRow(line, num, styleIndex, job) {
    var li = document.createElement("li");
    li.style.setProperty("--i", String(styleIndex));
    li.appendChild(spanWith("num", padNum(num)));

    var textHost = document.createElement("span");
    var txt = spanWith("txt", "");
    if (line.kind === "criterion") {
      txt.textContent = line.text;
    } else if (line.kind === "price") {
      txt.textContent = "Price: " + (typeof line.priceUsd === "string" ? "$" + line.priceUsd : line.unset ? "not set yet" : "not recorded") + (typeof line.rail === "string" ? " (" + line.rail + ")" : "");
    } else {
      txt.textContent = "Ready in " + A.plural(line.deliveryWindowDays, "day", "days");
    }
    textHost.appendChild(txt);
    /* Provenance: only a criterion carries proposedBy, and only a line
       the buyer proposed is worth saying so about -- a line the agent
       proposed is the default expectation of this screen and needs no
       annotation (ENT-6.2, wireframe row 05's "you proposed this"). The
       owner's side reads the same fact from the other side. No .from for
       price/delivery: those carry no proposedBy field to read honestly. */
    if (line.kind === "criterion" && line.proposedBy === "buyer") {
      var from = document.createElement("span");
      from.className = "from";
      var ico = document.createElement("span");
      ico.className = "ico";
      ico.setAttribute("data-ico", "arrow-right");
      from.appendChild(ico);
      from.appendChild(document.createTextNode(isOwner ? them(true) + " proposed this" : "you proposed this"));
      textHost.appendChild(from);
    }
    li.appendChild(textHost);

    if (line.unset) {
      li.appendChild(spanWith("sigcell", ""));
      li.appendChild(spanWith("sigcell", ""));
    } else {
      li.appendChild(sigCell(line, num, true));
      li.appendChild(sigCell(line, num, false));
    }

    var key = line.kind === "criterion" ? "c" + line.index : line.kind;
    if (isOpen(job)) {
      li.appendChild(actControl(line, num, key));
      if (openEdit === key) li.appendChild(rowEditor(line, key, job));
    } else {
      li.appendChild(spanWith("act", ""));
    }
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
    var party = isYours ? "you" : isOwner ? them(false) : agentDisplayName;

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

  /* "Propose your own criterion", from either side. POST
     /jobs/:jobId/criteria takes the FULL list, so a propose sends the
     current criteria's text unchanged (letting the server's own diff by
     exact trimmed text keep every existing line's acceptance flags where
     they are) plus the new line, proposed by the reader's side. A
     re-propose while status is already "proposed" stays in "proposed", no
     transition (src/domain/job.ts proposeCriteria). Reads currentJob, so
     a line added after any other send carries that send's list. */
  function wireProposeForm() {
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
      var criteria = currentCriteria(currentJob);
      criteria.push({ text: text, proposedBy: isOwner ? "agent" : "buyer" });
      A.postAuthed("/jobs/" + encodeURIComponent(jobId) + "/criteria", token, { criteria: criteria }).then(function (result) {
        btn.disabled = false;
        if (result.state !== "ok") {
          A.setTextById("propose-error", "Could not reach the server just now. Try again in a moment.");
          A.showById("propose-error", true);
          return;
        }
        var status = result.value.status;
        if (status === 200) {
          input.value = "";
          renderAll(result.value.body);
          return;
        }
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        var serverMessage = typeof body.error === "string" ? body.error : "";
        var message = isOwner ? sendRefusal(status, serverMessage) : serverMessage !== "" ? serverMessage : refusalSentence(status, "");
        A.setTextById("propose-error", message);
        A.showById("propose-error", true);
      });
    });
  }

  /* The outstanding panel reborn as the wireframe's .lockbar: a count and
     a bar instead of a paragraph naming row numbers (agreement.css's own
     header comment on .lockprog explains why). is-open while anything is
     outstanding, is-locked when every line carries both marks. On the
     buyer's side the deposit link (a named departure from the wireframe,
     which draws no button on this screen at all) appears once fully
     agreed; the owner's side says the buyer pays it next, with no link,
     because paying it is the buyer's act. */
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
    var other = isOwner ? them(true) : "The agent";

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
    var unset = lines.some(function (line) { return line.unset; });
    lines = lines.filter(function (line) { return !line.unset; });

    var needed = lines.length * 2;
    var collected = 0;
    var outstandingForYouCount = 0;
    var signedByThem = 0;
    lines.forEach(function (line) {
      if (line.you) collected += 1; else outstandingForYouCount += 1;
      if (line.them) { collected += 1; signedByThem += 1; }
    });
    setCount(collected, needed);

    if (unset) {
      bar.className = "lockbar reveal is-open";
      A.setText(mainEl, "Waiting on you to set the price.");
      A.setText(subEl, other + " signs it once it is set.");
      return;
    }
    if (outstandingForYouCount > 0) {
      bar.className = "lockbar reveal is-open";
      A.setText(mainEl, A.plural(outstandingForYouCount, "signature", "signatures") + " to go, waiting on you");
      A.setText(
        subEl,
        signedByThem === lines.length
          ? other + " has signed every line."
          : other + " has signed " + signedByThem + " of " + lines.length + " lines."
      );
      return;
    }
    if (signedByThem < lines.length) {
      bar.className = "lockbar reveal is-open";
      A.setText(mainEl, "Waiting on " + (isOwner ? them(false) : "the agent") + " to sign the rest.");
      A.setText(subEl, "You have signed every line.");
      return;
    }
    bar.className = "lockbar reveal is-locked";
    A.setText(mainEl, "This agreement is fully agreed.");
    if (isOwner) {
      A.setText(subEl, other + " pays the deposit next.");
      return;
    }
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
    lines.filter(function (line) { return !line.unset; }).forEach(function (line, i) {
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
      marks.textContent = " \u00b7 you: " + (line.you ? "signed" : "not yet signed") + " \u00b7 " + (isOwner ? "buyer" : "agent") + ": " + (line.them ? "signed" : "not yet signed");
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
