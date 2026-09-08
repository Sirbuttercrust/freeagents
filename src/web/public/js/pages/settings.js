/* P8v settings (P-23): the account settings screen, from
   spec/wireframe/settings.html. Ruling 1: one read, GET /accounts/me, and
   one write, PATCH /accounts/:did/operator-address, sent only on a human
   press of the save control.

   RULING 2: the payout addresses are the one addition to the wireframe.
   Validation is the server's (Ruling 3): this file sends what was typed
   and renders the route's own message on a 400. It never copies either
   regex.

   RULING 4: no display name field -- Account has no such column.

   RULING 5: the connected-accounts rows render as facts, with no
   controls. GitHub renders only when githubLogin is not null; the
   sign-in method rows reflect exactly which of githubLogin and
   passkeySubject are non-null. Email about your jobs never renders (gap
   G6). No "checked N hours ago": nothing on Account stores a check time.

   RULING 6: the identity disclosure ships close to whole; the signing
   key row does not (Account has no key column).

   RULING 8: closing-your-account does not render -- no delete route
   exists.

   EVERYTHING THROUGH textContent or as an input value: githubLogin, did
   and both addresses are content, never markup (api.js's own header
   rule). */
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

    if (githubLogin !== null) {
      host.appendChild(factRow("GitHub account", githubStateSpan(githubLogin)));
    }

    var methods = [];
    if (githubLogin !== null) methods.push("GitHub");
    if (passkeySubject !== null) methods.push("a passkey on this device");
    if (methods.length > 0) {
      host.appendChild(factRow("Sign-in method", methods.join(", plus ")));
    }
  }

  function githubStateSpan(login) {
    var span = document.createElement("span");
    span.className = "state state-done";
    var dot = document.createElement("span");
    dot.className = "dot";
    span.appendChild(dot);
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
