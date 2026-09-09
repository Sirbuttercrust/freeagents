/* P8b sign in: render the real access boundary, and wire the two real
   sign-in controls to the routes that mint a session.

   ONE PUBLIC ROUTE FOR THE ACCESS BOUNDARY:

     GET /capabilities  ->  { notice, capabilities[] }

   That route is R-23's whole point: the limit is stated before a user
   invests effort, and it is readable by anyone, signed in or not. Reading
   it here rather than restating it in the HTML means this page cannot drift
   from what the service actually enforces. A capability that moves from
   public to identified changes this page the moment it is deployed.

   The list of sign-in METHODS is a different thing and is not read from
   here: GET /sign-in-methods is a separate conformance surface, and the
   three the page describes are the fixed set the project's own invariants
   define, so they are stated in the markup rather than invented from an
   endpoint whose only job is to describe them, not drive them.

   THE TWO REAL CONTROLS.

   GitHub: fetches GET /auth/github/start and follows the redirect it
   answers. The GitHub client id rides inside that redirect's own query
   string, so an unconfigured deployment (FREEAGENTS_GITHUB_CLIENT_ID
   empty) is detected by reading it back rather than guessing at server
   configuration from the browser.

   Passkey: a real WebAuthn ceremony against POST /auth/passkey/register
   and POST /auth/passkey/verify, using the browser's own
   navigator.credentials API. No @simplewebauthn/browser here (not a
   project dependency; the brief forbids adding one) -- the base64url and
   ArrayBuffer conversions below are the whole of what that package's
   client half would otherwise do for these two calls.

   THE TOKEN IS A BEARER TOKEN, NEVER A COOKIE (the brief, and the security
   sweep it cites). It is kept in sessionStorage, which a script can read
   and attach to a later fetch's Authorization header, and which never
   rides on the wire the way a cookie would. */

(function () {
  "use strict";

  var A = window.FAApi;
  var SESSION_STORAGE_KEY = "fa_session";

  function start() {
    A.get("/capabilities").then(function (result) {
      if (result.state !== "ok") {
        A.showById("caps-error", true);
        return;
      }
      render(result.value);
    });
    wireControls();

    /* S1: "Once signed in" is meaningful only to a signed-in person, so
       it renders by the same rule nav.js already uses to decide that
       question (A.getStoredSession()), rather than inventing a second
       rule. A signed-out visitor must not be shown a menu of pages that
       will bounce them back here. */
    A.showById("once-signed-in", A.getStoredSession() !== null);
  }

  function render(document_) {
    if (typeof document_.notice === "string" && document_.notice !== "") {
      A.setTextById("notice", document_.notice);
    }

    var caps = Array.isArray(document_.capabilities) ? document_.capabilities : [];
    if (caps.length === 0) {
      A.showById("caps-error", true);
      return;
    }

    var pub = caps.filter(function (c) { return c.access === "public"; });
    var ident = caps.filter(function (c) { return c.access === "identified"; });

    fill("public-wrap", "public-caps", pub);
    fill("identified-wrap", "identified-caps", ident);
  }

  function fill(wrapId, hostId, caps) {
    if (caps.length === 0) return;
    A.showById(wrapId, true);
    var host = A.el(hostId);
    caps.forEach(function (cap) {
      host.appendChild(row(cap));
    });
  }

  function row(cap) {
    var node = document.createElement("div");

    var what = document.createElement("div");
    what.className = "what";
    what.textContent = readable(cap);
    node.appendChild(what);

    /* The service's own one-sentence reason, verbatim. Rewriting it here
       would let the page and the API disagree about the same rule. */
    if (typeof cap.reason === "string" && cap.reason !== "") {
      var why = document.createElement("p");
      why.className = "why";
      why.textContent = cap.reason;
      node.appendChild(why);
    }

    var where = document.createElement("div");
    where.className = "where";
    where.style.marginTop = "4px";
    where.textContent = String(cap.method || "") + " " + String(cap.path || "");
    node.appendChild(where);

    return node;
  }

  /* A capability id in plain language. An id with no entry here falls back
     to the id itself rather than to a guess: a new capability should read
     as an unfamiliar name, not as a confidently wrong sentence. */
  var LABELS = {
    "capabilities.read": "Read this access list",
    "agent.browse": "Read any agent's record",
    "operator.browse": "Read any operator's record",
    "credential.verify": "Open and check any receipt",
    "operator.register": "Register as an operator",
    "agent.list": "List an agent you operate",
    "job.hire": "Hire an agent for a job"
  };

  function readable(cap) {
    var id = typeof cap.id === "string" ? cap.id : "";
    return LABELS[id] || id;
  }

  /* ------------------------------------------------------- sign-in wiring */

  function wireControls() {
    var githubBtn = A.el("btn-github");
    var passkeyBtn = A.el("btn-passkey");

    if (githubBtn) {
      githubBtn.addEventListener("click", function () { beginGithub(githubBtn); });
    }

    if (!("credentials" in navigator) || !window.PublicKeyCredential) {
      A.showById("passkey-unavailable", true);
      if (passkeyBtn) passkeyBtn.disabled = true;
    } else if (passkeyBtn) {
      passkeyBtn.addEventListener("click", function () { beginPasskey(passkeyBtn); });
    }
  }

  function setStatus(text) {
    var node = A.el("signin-status");
    if (!node) return;
    if (!text) { node.hidden = true; return; }
    A.setText(node, text);
    node.hidden = false;
  }

  function storeSession(session) {
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch (e) {
      /* Private-browsing or a full quota: the sign-in itself still
         succeeded, so this is not surfaced as a failure. */
    }
  }

  /* The passkey subject this browser registers with, stable across
     sign-ins (qa review round 1, D1). Read from localStorage first so a
     returning visitor's second sign-in reuses the exact subject their
     Account was bound to; minted and persisted once when none exists yet.
     localStorage, not sessionStorage: a passkey outlives a closed tab, so
     the subject naming it must too. A storage failure (private browsing,
     a full quota) still returns a usable subject for this one attempt; it
     is simply not remembered for the next tab. */
  var PASSKEY_SUBJECT_STORAGE_KEY = "fa_passkey_subject";

  function passkeySubject() {
    try {
      var existing = window.localStorage.getItem(PASSKEY_SUBJECT_STORAGE_KEY);
      if (typeof existing === "string" && existing !== "") return existing;
    } catch (e) {
      /* fall through to minting a fresh one below */
    }
    var minted = "web-" + bufferToBase64url(window.crypto.getRandomValues(new Uint8Array(16)).buffer);
    try {
      window.localStorage.setItem(PASSKEY_SUBJECT_STORAGE_KEY, minted);
    } catch (e) {
      /* Private-browsing or a full quota: this attempt still proceeds with
         the minted subject; it just will not be remembered next time. */
    }
    return minted;
  }

  /* GitHub: begin the flow, then follow the redirect the server answers.
     The client id rides inside redirectUrl's own query string, so reading
     it back is how the page tells an unconfigured deployment apart from a
     working one, rather than guessing at server configuration. */
  function beginGithub(btn) {
    btn.disabled = true;
    setStatus("");
    A.showById("github-unconfigured", false);

    fetch("/auth/github/start", { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("http " + res.status);
        return res.json();
      })
      .then(function (body) {
        var redirectUrl = typeof body.redirectUrl === "string" ? body.redirectUrl : "";
        var clientId = "";
        try {
          clientId = new URL(redirectUrl).searchParams.get("client_id") || "";
        } catch (e) {
          clientId = "";
        }
        if (clientId === "") {
          A.showById("github-unconfigured", true);
          btn.disabled = false;
          return;
        }
        window.location.href = redirectUrl;
      })
      .catch(function () {
        setStatus("Could not start GitHub sign-in just now. Try again in a moment.");
        btn.disabled = false;
      });
  }

  /* base64url <-> ArrayBuffer, the two conversions
     @simplewebauthn/server's JSON options and the browser's
     navigator.credentials API disagree on. */
  function base64urlToBuffer(value) {
    var padded = value.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4 !== 0) padded += "=";
    var raw = window.atob(padded);
    var buffer = new ArrayBuffer(raw.length);
    var bytes = new Uint8Array(buffer);
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return buffer;
  }

  function bufferToBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /* The JSON shape generateRegistrationOptions() produces, converted to
     the shape navigator.credentials.create() expects: challenge and
     user.id as ArrayBuffers, everything else passed through unchanged. */
  function toCreationOptions(optionsJson) {
    var out = {};
    for (var key in optionsJson) {
      if (Object.prototype.hasOwnProperty.call(optionsJson, key)) out[key] = optionsJson[key];
    }
    out.challenge = base64urlToBuffer(optionsJson.challenge);
    if (optionsJson.user) {
      out.user = { id: base64urlToBuffer(optionsJson.user.id), name: optionsJson.user.name, displayName: optionsJson.user.displayName };
    }
    if (Array.isArray(optionsJson.excludeCredentials)) {
      out.excludeCredentials = optionsJson.excludeCredentials.map(function (c) {
        return { id: base64urlToBuffer(c.id), type: c.type, transports: c.transports };
      });
    }
    return out;
  }

  /* The browser's RegistrationCredential, converted back to the JSON shape
     verifyRegistrationResponse() expects (the same shape
     tests/helpers/webauthn-fixtures.ts builds by hand for the test suite). */
  function credentialToJson(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: bufferToBase64url(credential.response.attestationObject),
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      },
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
    };
  }

  function beginPasskey(btn) {
    btn.disabled = true;
    setStatus("Setting up your passkey…");

    /* A single browser-scoped subject, stable across every sign-in on this
       device (qa review round 1, D1): the identity the passkey PROVES is
       the platform account it resolves to server-side
       (Account.passkeySubject), so a subject that changed on every click
       could never match an account bound to an earlier one. Persisted in
       localStorage rather than sessionStorage: the whole point is that it
       survives a closed tab, the same way the passkey itself does. */
    var subject = passkeySubject();

    fetch("/auth/passkey/register", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ subject: subject }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("http " + res.status);
        return res.json();
      })
      .then(function (body) {
        var options = JSON.parse(body.optionsJson);
        return navigator.credentials.create({ publicKey: toCreationOptions(options) });
      })
      .then(function (credential) {
        if (!credential) throw new Error("no credential");
        var responseJson = JSON.stringify({ subject: subject, response: credentialToJson(credential) });
        return fetch("/auth/passkey/verify", {
          method: "POST",
          headers: { "content-type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ responseJson: responseJson }),
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error("http " + res.status);
        return res.json();
      })
      .then(function (session) {
        storeSession(session);
        if (window.FANav && typeof window.FANav.refresh === "function") window.FANav.refresh();
        A.showById("once-signed-in", true);
        setStatus("Signed in with a passkey. You can hire or list an agent now.");
        btn.disabled = false;
      })
      .catch(function () {
        setStatus("The passkey did not go through. Try again, or continue with GitHub.");
        btn.disabled = false;
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
