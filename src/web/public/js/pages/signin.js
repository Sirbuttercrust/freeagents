/* P8b sign in: render the real access boundary, and wire the two real
   sign-in controls to the routes that mint a session.

   W-signin rebuilt the page around this file on the polished visual
   system. Two things here changed with it, and nothing else did: row()
   sets the .cap class its page-local rules were written for, and the
   labels below are unchanged because they are read by a test.

   ONE PUBLIC ROUTE FOR THE ACCESS BOUNDARY:

     GET /capabilities  ->  { notice, capabilities[] }

   That route is R-23's whole point: the limit is stated before a user
   invests effort, and it is readable by anyone, signed in or not. Reading
   it here rather than restating it in the HTML means this page cannot drift
   from what the service actually enforces. A capability that moves from
   public to identified changes this page the moment it is deployed.

   The page shows the account boundary only. SW1-04: the document also
   names the steps of a hire after it opens (every capability whose path
   contains /jobs/:jobId). Those are the machine's route list, one set per
   job, and eighteen more rows of them here would make this page busy, which
   the simplicity law (MAP.md, "Design law: simplicity") rules out. render()
   drops them; job.hire (/jobs) is the door to a hire, not a step inside
   one, so it stays.

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

   Passkey: two controls, because signing in with a passkey and making
   one are two different browser ceremonies, and the page cannot tell a
   first visit from a return without asking the browser.

     Use a passkey      POST /auth/passkey/signin/start, then
                        navigator.credentials.get, then POST
                        /auth/passkey/signin with the assertion. The server
                        sends no allowCredentials, so the browser offers the
                        passkeys it holds for this site, and the one picked
                        names its account by its own user handle.
     Create a passkey   POST /auth/passkey/register with no body, then
                        navigator.credentials.create, then POST
                        /auth/passkey/verify with { response }. The server
                        makes the account's name and puts it in user.id.

   The page sends no name and keeps none: the account comes from the
   passkey, never from something this browser says about itself. No
   @simplewebauthn/browser here (not a project dependency) and no
   PublicKeyCredential JSON helpers (newer than WebAuthn itself): the
   base64url and ArrayBuffer conversions below are the whole of what either
   would do for these four calls.

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

    /* S1: "Once signed in" is meaningful only to a signed-in person.
       nav.js's own render() (loaded before this file, and the one place
       that already owns nav-signin/nav-signed-in and every session-gated
       injected link) owns this section too, and runs once on every page
       load before this file's own start() does: by the time this line
       would have run, the section is already correct. Adding a second
       call here was the round 1 defect (Proof, D1): a rule that fires on
       load but is never told when the session clears is not the nav's
       rule, it is a copy of the nav's rule at one instant. nav.js's
       render() is also what FANav.refresh() calls (see finish()
       below and nav.js's sign-out handler), so on-load, sign-in and
       sign-out all clear or set this section through the one place that
       decides it. A signed-out visitor must not be shown a menu of pages
       that will bounce them back here. */
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

    /* The per-job hire steps are left out (see the header). The filter is on
       the path, so a step added to access.ts under /jobs/:jobId stays off
       the page without a change here. */
    caps = caps.filter(function (c) {
      return typeof c.path !== "string" || c.path.indexOf("/jobs/:jobId") === -1;
    });

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
    /* The row carries the class its page-local rules are written for.
       Before W-signin this built a bare <div> and signin.html declared
       .cap and its inner rules with nothing to match: dead rules that
       looked like a styled component and painted nothing. The children's
       classes were already correct; only the row's was missing. */
    var node = document.createElement("div");
    node.className = "cap";

    var what = document.createElement("div");
    what.className = "what";
    what.textContent = readable(cap);
    node.appendChild(what);

    /* DOM order is the reading order the sheet lays out: the capability's
       plain name, then the service's reason underneath it. SW2-06: no HTTP
       route renders here. A person signing in needs to know what they can
       do and why, and DESIGN.md 9 keeps machine terms off a primary path;
       the routes stay readable at GET /capabilities itself. */

    /* The service's own one-sentence reason, verbatim. Rewriting it here
       would let the page and the API disagree about the same rule. */
    if (typeof cap.reason === "string" && cap.reason !== "") {
      var why = document.createElement("p");
      why.className = "why";
      why.textContent = cap.reason;
      node.appendChild(why);
    }

    return node;
  }

  /* A capability id in plain language. An id with no entry here falls back
     to the id itself rather than to a guess: a new capability should read
     as an unfamiliar name, not as a confidently wrong sentence.

     That fallback is the right failure mode and it is not a licence to
     leave an entry out. W-signin found agent.browse.list rendering as its
     raw id on the live page, which is the one thing DESIGN 7 forbids
     everywhere else: a protocol identifier shown to a person. The label
     below states what the route does and nothing more (GET /agents is the
     browse listing, and the service's own reason sentence for it is
     rendered underneath). tests/web/signin-polished.test.ts reads every
     rendered label back off the page and fails on any that still looks
     like an id, so the next capability added to src/domain/access.ts
     cannot reach a person unlabelled. The exception is a capability under
     /jobs/:jobId: render() never draws those (see the header), so they need
     no label here, and the same test asserts none of them reaches the page. */
  var LABELS = {
    "capabilities.read": "Read this access list",
    "agent.browse": "Read any agent's record",
    "agent.browse.list": "Browse every listed agent",
    "operator.browse": "Read any operator's record",
    "credential.verify": "Open and check any receipt",
    "operator.register": "Register as an operator",
    "agent.list": "List an agent you operate",
    "job.hire": "Hire an agent for a job",
    "agent.negotiation": "Turn owner-first negotiation on or off",
    "agent.listing": "Unlist an agent you operate, or list it again"
  };

  function readable(cap) {
    var id = typeof cap.id === "string" ? cap.id : "";
    return LABELS[id] || id;
  }

  /* ------------------------------------------------------- sign-in wiring */

  function wireControls() {
    var githubBtn = A.el("btn-github");
    var passkeyBtns = [A.el("btn-passkey"), A.el("btn-passkey-create")];

    if (githubBtn) {
      githubBtn.addEventListener("click", function () { beginGithub(githubBtn); });
    }

    if (!("credentials" in navigator) || !window.PublicKeyCredential) {
      A.showById("passkey-unavailable", true);
      passkeyBtns.forEach(function (btn) { if (btn) btn.disabled = true; });
      return;
    }
    if (passkeyBtns[0]) passkeyBtns[0].addEventListener("click", function () { beginPasskeySignIn(passkeyBtns); });
    if (passkeyBtns[1]) passkeyBtns[1].addEventListener("click", function () { beginPasskeyCreate(passkeyBtns); });
  }

  /* #signin-status carries role="status" in the markup, so a screen reader
     is already listening to it before the first sentence lands. */
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

  /* The JSON shape generateAuthenticationOptions() produces, converted to
     the shape navigator.credentials.get() expects: the challenge, and any
     allowCredentials ids, as ArrayBuffers. */
  function toRequestOptions(optionsJson) {
    var out = {};
    for (var key in optionsJson) {
      if (Object.prototype.hasOwnProperty.call(optionsJson, key)) out[key] = optionsJson[key];
    }
    out.challenge = base64urlToBuffer(optionsJson.challenge);
    if (Array.isArray(optionsJson.allowCredentials)) {
      out.allowCredentials = optionsJson.allowCredentials.map(function (c) {
        return { id: base64urlToBuffer(c.id), type: c.type, transports: c.transports };
      });
    }
    return out;
  }

  /* The browser's assertion, converted to the JSON shape
     verifyAuthenticationResponse() reads. userHandle is the name the
     server made at register; the server checks it against the stored
     passkey rather than trusting it. */
  function assertionToJson(credential) {
    var r = credential.response;
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        authenticatorData: bufferToBase64url(r.authenticatorData),
        clientDataJSON: bufferToBase64url(r.clientDataJSON),
        signature: bufferToBase64url(r.signature),
        userHandle: r.userHandle ? bufferToBase64url(r.userHandle) : undefined,
      },
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
    };
  }

  /* A POST to one of the four passkey routes. A non-2xx answer rejects
     with the route's status and its error sentence, so failureSentence
     can tell a refusal, a storage fault and an unconfigured deployment
     apart. Register and signin/start take no body, so none is sent. */
  function postPasskey(path, body) {
    var init = { method: "POST", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().then(null, function () { return null; }).then(function (parsed) {
        if (res.ok) return parsed;
        var err = new Error("http " + res.status);
        err.status = res.status;
        err.serverError = parsed && typeof parsed.error === "string" ? parsed.error : "";
        throw err;
      });
    });
  }

  var NOT_CONFIGURED = "passkey sign-in is not configured on this deployment";

  /* One sentence per outcome, each naming what the person can do. The
     browser gives NotAllowedError both for a cancelled prompt and for a
     device holding no passkey for this site, and the page cannot tell
     those apart, so that sentence is true of both. */
  function failureSentence(err, ceremony) {
    var status = err && err.status;
    if (status === 503 && err.serverError === NOT_CONFIGURED) {
      return "Passkeys are not set up on this deployment. Continue with GitHub instead.";
    }
    if (status === 503) {
      return "FreeAgents could not reach its records just now, so you are not signed in. Try again in a moment.";
    }
    if (status === 401 && ceremony === "signin") {
      return "That passkey did not sign you in. Press Use a passkey to try again, or press Create a passkey if this device has none for FreeAgents.";
    }
    if (status === 401) {
      return "That passkey was not accepted, so no account was made. Press Create a passkey to try again, or continue with GitHub.";
    }
    if (err && err.name === "NotAllowedError" && ceremony === "signin") {
      return "No passkey was used. If this device has none for FreeAgents yet, press Create a passkey, or continue with GitHub.";
    }
    if (err && err.name === "NotAllowedError") {
      return "No passkey was made. Press Create a passkey to try again, or continue with GitHub.";
    }
    return "The passkey did not go through. Try again, or continue with GitHub.";
  }

  /* Both passkey controls stay disabled while either ceremony runs, so a
     second press cannot start a second ceremony over the first. */
  function setBusy(btns, busy) {
    btns.forEach(function (btn) { if (btn) btn.disabled = busy; });
  }

  function finishPasskey(btns, ceremony, chain) {
    chain
      .then(function (session) {
        storeSession(session);
        /* SW3-01: a person who pressed Sign in on another page goes back
           to it, by the same rule the GitHub callback page follows
           (FAApi.takeReturnPath in api.js, which removes the stored path
           whether or not it is used). With no usable path the person
           stays here, told they are signed in, as before. */
        var returnPath = A.takeReturnPath();
        if (returnPath) {
          window.location.replace(returnPath);
          return;
        }
        /* FANav.refresh() re-runs nav.js's render(), which owns
           #once-signed-in too: one call sets the nav's signed-in state and
           that section together. */
        if (window.FANav && typeof window.FANav.refresh === "function") window.FANav.refresh();
        setStatus("Signed in with a passkey. You can hire or list an agent now.");
        setBusy(btns, false);
      })
      .catch(function (err) {
        setStatus(failureSentence(err, ceremony));
        setBusy(btns, false);
      });
  }

  /* Use a passkey: a returning person. The browser offers the passkeys it
     holds for this site, and the server finds the account from the one
     picked. The assertion is posted as itself, not wrapped. */
  function beginPasskeySignIn(btns) {
    setBusy(btns, true);
    setStatus("Waiting for your passkey\u2026");
    finishPasskey(btns, "signin", postPasskey("/auth/passkey/signin/start")
      .then(function (body) {
        return navigator.credentials.get({ publicKey: toRequestOptions(JSON.parse(body.optionsJson)) });
      })
      .then(function (credential) {
        if (!credential) throw new Error("no credential");
        return postPasskey("/auth/passkey/signin", { responseJson: JSON.stringify(assertionToJson(credential)) });
      }));
  }

  /* Create a passkey: a first visit. Register takes no body because the
     server makes the account's name, and verify's envelope carries only
     { response }. */
  function beginPasskeyCreate(btns) {
    setBusy(btns, true);
    setStatus("Setting up your passkey\u2026");
    finishPasskey(btns, "create", postPasskey("/auth/passkey/register")
      .then(function (body) {
        return navigator.credentials.create({ publicKey: toCreationOptions(JSON.parse(body.optionsJson)) });
      })
      .then(function (credential) {
        if (!credential) throw new Error("no credential");
        return postPasskey("/auth/passkey/verify", { responseJson: JSON.stringify({ response: credentialToJson(credential) }) });
      }));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
