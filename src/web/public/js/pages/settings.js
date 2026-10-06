/* P8v settings (P-23): the account settings screen, from
   spec/wireframe/settings.html. Ruling 1: one account read, GET /accounts/me,
   and one account write, PATCH /accounts/:did/operator-address, sent only on
   a press of save. The notifications switch has its own: see renderPushRow.

   RULING 2: the payout addresses are the one addition to the wireframe.
   Three boxes, one per token and network: USDC on Arbitrum
   (operatorAddressEvm), ABT on Ethereum (operatorAddressAbtEth) and ABT on
   ArcBlock (operatorAddressAbt). Each box fills from its own field on
   GET /accounts/me and saves to that field only; no box is ever filled
   from another. A changed box saves only once its owner ticks "I control
   this wallet on <network>", which shows while the box holds a new,
   non-empty address. An address that holds contract code comes back as a
   409 with the route's own warning, and only "Save it anyway" sends that
   same body again with confirmContractAddress.

   RULING 3: validation is the server's. This file sends what was typed and
   never copies the route's patterns. A 400 is turned into a sentence that
   names the box in its label's words, picked by the field name the route's
   sentence begins with; a sentence that names no box is shown as it stands.

   RULING 4: no display name field -- Account has no such column.

   RULING 5: the account rows are facts with no control. GitHub renders only
   when githubLogin is not null; sign-in method reflects exactly which of
   githubLogin and passkeySubject are non-null. Email about your jobs never
   renders (gap G6), nor "checked N hours ago" (no check time is stored).
   The pane's one control is the per-device notifications switch.

   RULING 6: the identity disclosure ships close to whole; the signing
   key row does not (Account has no key column).

   RULING 8: closing-your-account does not render -- no delete route
   exists.

   EVERYTHING THROUGH textContent or as an input value: githubLogin, did
   and the three addresses are content, never markup (api.js's own header
   rule). The stagger index below is the one thing written as a property
   rather than as text, which is a style write and not markup either. */
(function () {
  "use strict";
  var A = window.FAApi;
  var did = "";

  // The three payout boxes in page order. `name` is the label's words, used
  // in every sentence about the box; `network` finishes its confirmation.
  var BOXES = [
    { id: "payout-evm", field: "operatorAddressEvm", name: "USDC on Arbitrum", network: "Arbitrum" },
    { id: "payout-abt-eth", field: "operatorAddressAbtEth", name: "ABT on Ethereum", network: "Ethereum" },
    { id: "payout-abt", field: "operatorAddressAbt", name: "ABT on ArcBlock", network: "ArcBlock" },
  ];
  // What the account has saved, by field: the last read or the last 200.
  var saved = {};
  // One save at a time, from either button.
  var inFlight = false;
  // The body the route warned about with its 409, while the warning shows.
  var warnedBody = null;
  // Counts edits to any box, so an answer can tell it is about a body the
  // person has since changed.
  var edits = 0;

  function start() {
    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }
    A.getAuthed("/accounts/me", session.token).then(function (meResult) {
      if (meResult.state === "ok" && meResult.value.status === 401) {
        A.showById("signin-required", true);
        return;
      }
      if (meResult.state !== "ok" || meResult.value.status !== 200) {
        failLoad("Your account could not be read just now. Reloading may work.");
        return;
      }
      var me = meResult.value.body && typeof meResult.value.body === "object" ? meResult.value.body : {};
      did = typeof me.did === "string" ? me.did : "";
      if (did === "") {
        failLoad("Your account could not be read just now. Reloading may work.");
        return;
      }
      render(me, session.token);
    });
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  function render(me, token) {
    A.showById("settings-body", true);

    BOXES.forEach(function (box) {
      saved[box.field] = typeof me[box.field] === "string" ? me[box.field] : "";
      var input = A.el(box.id);
      if (input) input.value = saved[box.field];
    });
    wireBoxes();

    renderAccountRows(me);
    renderPushRow();

    A.setText(A.el("did-value"), did);
    var copyBtn = A.el("did-copy");
    if (copyBtn) copyBtn.setAttribute("data-copy", did);

    wireSave(token);
  }

  // Ruling 5: at most two rows, neither carries a control. GitHub renders
  // only when githubLogin is not null; sign-in method reflects exactly
  // which of githubLogin/passkeySubject are non-null. An account
  // answering both null (which cannot occur through any sign-in path)
  // renders no rows rather than an empty pane.
  function renderAccountRows(me) {
    var host = A.el("account-rows");
    if (!host) return;
    host.textContent = "";

    var githubLogin = typeof me.githubLogin === "string" ? me.githubLogin : null;
    var passkeySubject = typeof me.passkeySubject === "string" ? me.passkeySubject : null;

    var rows = [];
    if (githubLogin !== null) {
      rows.push(factRow("GitHub account", githubStateSpan(githubLogin)));
    }

    var methods = [];
    if (githubLogin !== null) methods.push("GitHub");
    if (passkeySubject !== null) methods.push("a passkey on this device");
    if (methods.length > 0) {
      rows.push(factRow("Sign-in method", methods.join(", plus ")));
    }

    rows.forEach(function (row, i) {
      // The stagger delay base.css's .js-reveal .stagger.is-in > * rule
      // reads (base.css:407), which the container above already opts into
      // with .stagger.reveal. The wireframe writes the index by hand on
      // each of its rows (spec/wireframe/settings.html:61, 70, 77); these
      // rows are built at run time, so the index comes from position.
      // Without it every row falls back to 0 and they all arrive at once.
      row.style.setProperty("--i", String(i));
      host.appendChild(row);
    });

    // The GitHub row's state glyph. icons.js paints every [data-ico] host
    // at DOMContentLoaded and polish.js's init() calls FAIcon.paint()
    // again, both before the /accounts/me read above resolves, so a host
    // built here is never visited by either sweep. Same guarded repaint
    // myagents.js:139, dashboard.js:305, operator.js:82 and
    // agreement.js:165 already make for rows they render late; paint()
    // skips a host that already has a first element child (icons.js:119).
    // If it never runs the span collapses and the login beside it still
    // states the fact.
    if (window.FAIcon) window.FAIcon.paint(host);
  }

  // The notifications switch, per device because a push subscription
  // belongs to one browser. Built only when this browser can do push
  // (FAPush.supported) AND the server has a key (GET
  // /push/vapid-public-key, the one extra read, taken only in such a
  // browser); otherwise it never exists, so there is nothing hidden to
  // find and nothing in the accessibility tree. Its state on load is this
  // browser's own: "On" exactly when the worker holds a subscription and
  // permission is granted. There is no server read of it. Its two writes,
  // POST and DELETE /accounts/:did/push-subscriptions, go only on a press.
  function renderPushRow() {
    var P = window.FAPush;
    var host = A.el("account-rows");
    var tpl = A.el("push-row-template");
    if (!P || !host || !tpl || !P.supported()) return;
    Promise.all([P.readKey(), P.current()]).then(function (got) {
      var key = got[0];
      if (key === null) return;
      host.appendChild(tpl.content.cloneNode(true));
      var row = A.el("push-row");
      row.style.setProperty("--i", String(host.children.length - 1));
      wirePush(key, got[1]);
    });
  }

  function wirePush(key, initial) {
    var P = window.FAPush;
    var toggle = A.el("push-toggle");
    var sub = initial;

    function show(on, sentence) {
      toggle.checked = on;
      A.setTextById("push-state", on ? "On" : "Off");
      A.setTextById("push-note", sentence || "");
    }
    show(sub !== null, "");

    toggle.addEventListener("click", function (e) {
      // The box only moves when the server has answered, so the press
      // itself never flips it.
      e.preventDefault();
      // The token is read at the press, not at load: a session that
      // changed or ended since the page drew is the one the server judges.
      var session = A.getStoredSession();
      if (session === null) {
        A.setTextById("push-note", P.SENTENCES.expired);
        return;
      }
      // One press at a time: a disabled box takes no click, from the box
      // or from its label, until this one has settled.
      toggle.disabled = true;
      toggle.setAttribute("aria-busy", "true");
      A.setTextById("push-note", "");
      var work = sub === null ? P.turnOn(did, session.token, key) : P.turnOff(did, session.token, sub);
      work.then(function (r) {
        sub = r.on ? r.subscription : null;
        toggle.disabled = false;
        toggle.removeAttribute("aria-busy");
        // The click that started this has long finished dispatching (the
        // work above is never synchronous), so the browser's own restore
        // of the prevented click is done and this write is the last word.
        show(r.on, r.sentence);
      });
    });
  }

  // The wireframe's marker for this row is a glyph, not a dot
  // (spec/wireframe/settings.html:68). The distinction carries a rule:
  // polish.css sizes .state .ico (polish.css:379) and has no .dot rule at
  // all, so a dot here would wear none of the polished layer even with
  // the sheet loaded. check-circle is the name icons.js registers
  // (icons.js:52).
  function githubStateSpan(login) {
    var span = document.createElement("span");
    span.className = "state state-done";
    var ico = document.createElement("span");
    ico.className = "ico";
    ico.setAttribute("data-ico", "check-circle");
    span.appendChild(ico);
    span.appendChild(document.createTextNode("@" + login));
    return span;
  }

  function factRow(label, right) {
    var row = document.createElement("div");
    row.className = "between";
    var left = document.createElement("div");
    left.textContent = label;
    row.appendChild(left);
    if (typeof right === "string") {
      var small = document.createElement("span");
      small.className = "small muted";
      small.textContent = right;
      row.appendChild(small);
    } else {
      row.appendChild(right);
    }
    return row;
  }

  function wireSave(token) {
    var btn = A.el("save-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        save(token);
      });
    }
    var anyway = A.el("save-anyway");
    if (anyway) {
      anyway.addEventListener("click", function () {
        saveAnyway(token);
      });
    }
  }

  // Each box's confirmation row shows only while the box holds an address
  // that is new and not empty. Any edit to a box unticks its confirmation,
  // so the tick always answers for the address on screen, and any edit to
  // any box hides the contract warning, so "Save it anyway" can only ever
  // send an address the person saw warned. Unticking a confirmation hides
  // the warning too: the warning only ever showed for a body whose every
  // box was ticked, so without a tick there is nothing it may save.
  function wireBoxes() {
    BOXES.forEach(function (box) {
      var input = A.el(box.id);
      if (!input) return;
      var tick = A.el(box.id + "-confirm");
      input.addEventListener("input", function () {
        edits += 1;
        if (tick) tick.checked = false;
        syncConfirm(box);
        hideWarning();
      });
      if (tick) {
        tick.addEventListener("change", function () {
          if (!tick.checked) hideWarning();
        });
      }
    });
  }

  function confirmRow(box) {
    var tick = A.el(box.id + "-confirm");
    return tick ? tick.parentNode : null;
  }

  function isChanged(box) {
    var input = A.el(box.id);
    return input !== null && input.value !== saved[box.field];
  }

  function syncConfirm(box) {
    var row = confirmRow(box);
    if (!row) return;
    var input = A.el(box.id);
    var wanted = isChanged(box) && input.value !== "";
    if (!wanted) A.el(box.id + "-confirm").checked = false;
    row.hidden = !wanted;
  }

  function hideWarning() {
    warnedBody = null;
    A.showById("save-warning", false);
  }

  function hideOutcome() {
    A.showById("save-error", false);
    A.showById("save-success", false);
    hideWarning();
  }

  // The save outcome takes focus, so a keyboard or screen-reader user lands
  // on what happened. Each message carries tabindex="-1" in the page.
  function showOutcome(id) {
    A.showById(id, true);
    var box = A.el(id);
    if (box) box.focus();
  }

  function save(token) {
    if (inFlight) return;
    hideOutcome();

    // Ruling 1/3: only the boxes the person changed. An untouched box is
    // not in the body, so saving one address never overwrites another.
    // Every changed box must be ready before anything is sent: the first
    // one in page order that is not names itself and nothing goes.
    var body = {};
    for (var i = 0; i < BOXES.length; i += 1) {
      var box = BOXES[i];
      if (!isChanged(box)) continue;
      var value = A.el(box.id).value;
      if (value === "") {
        // The route takes no empty address, so a saved one can only be
        // replaced. Saying so here beats a refusal about a blank box.
        showSaveError("A saved address can be replaced but not removed. Paste the new " + box.name + " address to save it.");
        return;
      }
      if (!A.el(box.id + "-confirm").checked) {
        showSaveError("Tick \"I control this wallet on " + box.network + "\" to save the " + box.name + " address.");
        return;
      }
      body[box.field] = value;
    }

    if (Object.keys(body).length === 0) return;
    send(token, body);
  }

  // "Save it anyway": the body the route warned about, plus the one flag
  // the route's 409 named, and nothing else.
  function saveAnyway(token) {
    if (inFlight || warnedBody === null) return;
    var body = {};
    Object.keys(warnedBody).forEach(function (field) {
      body[field] = warnedBody[field];
    });
    body.confirmContractAddress = true;
    send(token, body);
  }

  // Both buttons say they are busy while a save is in flight and ignore
  // presses until it answers. Neither is ever `disabled`: a disabled button
  // that holds focus drops it to the page.
  function setBusy(on) {
    inFlight = on;
    ["save-btn", "save-anyway"].forEach(function (id) {
      var b = A.el(id);
      if (!b) return;
      if (on) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    });
  }

  function send(token, body) {
    setBusy(true);
    var editsAtSend = edits;

    A.patchAuthed("/accounts/" + encodeURIComponent(did) + "/operator-address", token, body).then(function (result) {
      setBusy(false);
      hideOutcome();

      if (result.state !== "ok") {
        showSaveError("Could not reach the server just now. Try again in a moment.");
        return;
      }

      var status = result.value.status;
      var resBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};

      if (status === 200) {
        BOXES.forEach(function (box) {
          if (typeof body[box.field] === "string") saved[box.field] = body[box.field];
          syncConfirm(box);
        });
        showOutcome("save-success");
        return;
      }

      // silent-success-on-failure: a save-path 401 reveals the sign-in
      // block, the same shape the load path already takes at start(),
      // and pullrequest.js's own 401 handling is the in-repo precedent
      // for a write path taking this branch. The typed value stays in
      // the input; nothing here clears it.
      if (status === 401) {
        A.showById("settings-body", false);
        A.showById("signin-required", true);
        return;
      }

      var serverMessage = typeof resBody.error === "string" && resBody.error !== "" ? resBody.error : "";

      // The route's own warning for an address that holds contract code,
      // as it stands: it was written for a person and names the network
      // and the token. It offers "Save it anyway" only while the boxes
      // still hold the body it is about; an edit made while the request
      // was out means the warning is about addresses no longer on screen,
      // so it shows without the button and Save asks again.
      if (status === 409 && serverMessage !== "") {
        if (edits !== editsAtSend) {
          showSaveError(serverMessage);
          return;
        }
        warnedBody = {};
        BOXES.forEach(function (box) {
          if (typeof body[box.field] === "string") warnedBody[box.field] = body[box.field];
        });
        A.setTextById("save-warning-detail", serverMessage);
        showOutcome("save-warning");
        return;
      }

      showSaveError(refusalSentence(status, serverMessage));
    });
  }

  // A 400 names the box in its label's words. The route's sentences each
  // begin with the field they refuse; the space after the name keeps
  // operatorAddressAbt from matching operatorAddressAbtEth. A sentence that
  // begins with no box's field is the route's own and is shown as it is.
  function plainRefusal(serverMessage) {
    for (var i = 0; i < BOXES.length; i += 1) {
      if (serverMessage.indexOf(BOXES[i].field + " ") === 0) {
        return "The " + BOXES[i].name + " address is not a valid address. Copy it from your wallet again.";
      }
    }
    return serverMessage || "The address could not be saved as written.";
  }

  function refusalSentence(status, serverMessage) {
    if (status === 400) return plainRefusal(serverMessage);
    if (status === 403) return serverMessage || "This account is not allowed to set that address.";
    if (status === 404) return serverMessage || "This account is no longer registered.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The address could not be saved just now.";
  }

  function showSaveError(message) {
    A.setTextById("save-error-detail", message);
    showOutcome("save-error");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
