/* P8v settings (P-23): the account settings screen, from
   spec/wireframe/settings.html. Ruling 1: one account read, GET /accounts/me,
   and one account write, PATCH /accounts/:did/operator-address, sent only on
   a press of save. The notifications switch has its own: see renderPushRow.

   RULING 2: the payout addresses are the one addition to the wireframe.
   Validation is the server's (Ruling 3): this file sends what was typed
   and renders the route's own message on a 400. It never copies either
   regex.

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
   and both addresses are content, never markup (api.js's own header
   rule). The stagger index below is the one thing written as a property
   rather than as text, which is a style write and not markup either. */
(function () {
  "use strict";
  var A = window.FAApi;
  var did = "";
  var initialEvm = "";
  var initialAbt = "";

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

    initialEvm = typeof me.operatorAddressEvm === "string" ? me.operatorAddressEvm : "";
    initialAbt = typeof me.operatorAddressAbt === "string" ? me.operatorAddressAbt : "";
    var evmInput = A.el("payout-evm");
    var abtInput = A.el("payout-abt");
    if (evmInput) evmInput.value = initialEvm;
    if (abtInput) abtInput.value = initialAbt;

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
    if (!btn) return;
    btn.addEventListener("click", function () {
      save(token);
    });
  }

  function save(token) {
    A.showById("save-error", false);
    A.showById("save-success", false);

    // Ruling 1/3: only the fields the person changed. An untouched input
    // is not in the body, so saving one rail never overwrites the other.
    var evmInput = A.el("payout-evm");
    var abtInput = A.el("payout-abt");
    var body = {};
    if (evmInput && evmInput.value !== initialEvm) body.operatorAddressEvm = evmInput.value;
    if (abtInput && abtInput.value !== initialAbt) body.operatorAddressAbt = abtInput.value;

    if (Object.keys(body).length === 0) return;

    var btn = A.el("save-btn");
    if (btn) btn.disabled = true;

    A.patchAuthed("/accounts/" + encodeURIComponent(did) + "/operator-address", token, body).then(function (result) {
      if (btn) btn.disabled = false;

      if (result.state !== "ok") {
        showSaveError("Could not reach the server just now. Try again in a moment.");
        return;
      }

      var status = result.value.status;
      var resBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};

      if (status === 200) {
        initialEvm = evmInput ? evmInput.value : initialEvm;
        initialAbt = abtInput ? abtInput.value : initialAbt;
        A.showById("save-success", true);
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
      showSaveError(refusalSentence(status, serverMessage));
    });
  }

  function refusalSentence(status, serverMessage) {
    if (status === 400) return serverMessage || "The address could not be saved as written.";
    if (status === 403) return serverMessage || "This account is not allowed to set that address.";
    if (status === 404) return serverMessage || "This account is no longer registered.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The address could not be saved just now.";
  }

  function showSaveError(message) {
    A.setTextById("save-error-detail", message);
    A.showById("save-error", true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
