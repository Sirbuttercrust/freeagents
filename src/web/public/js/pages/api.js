/* The API client the marketplace pages share.

   Every read here uses the SAME public routes a third party can call, with
   no session and no private endpoint, because a page that needed privileged
   access would be a page a skeptic cannot reproduce (MISSION invariant 2).

   THREE RULES THIS FILE ENFORCES FOR EVERY PAGE.

   1. A FAILED READ IS SAID OUT LOUD, never rendered as an empty record. An
      agent with no hires and an agent whose hire list could not be loaded
      look identical if a fetch failure falls back to zero, and one of those
      is a lie about somebody's work. `get` distinguishes the three outcomes
      a caller has to tell apart: the value, absent (404), and unreachable.

   2. NOTHING IS INVENTED. A field the API does not serve is not filled in
      from a guess, a default, or a placeholder that reads like data.

   3. TEXT GOES IN AS TEXT. Everything a page writes into the DOM goes
      through textContent, never innerHTML, so a name or a repository string
      is content rather than markup. The one exception is the avatar, which
      the API serves as an SVG string it generated itself from a DID, and it
      is inserted through a parser that keeps only shape elements.

   P8g adds two things scoped narrowly; the three rules above still govern
   every public GET, unchanged.

   `getStoredSession` was a private function inside nav.js's IIFE
   (`readStoredSession`); hire.js needs the identical read to attach a
   bearer token to a write, so it moved here rather than being copied
   (the defect class P8e was written against). nav.js now calls it and
   still owns clearing the key and re-rendering.

   `postAuthed` is this file's first authenticated write. `get` never
   carries a session, because every read here is one a third party can
   reproduce with no privileges; a hire is a WRITE by an authenticated
   buyer, and POST /jobs requires exactly that proof
   (requireSessionOrSignature, src/api/app.ts). It carries `Authorization:
   Bearer <token>` and nothing else privileged: `credentials: "omit"`
   still holds (the 2026-09-06 sweep's cookie finding is unaffected, since
   the token rides a header a cookie could never forge). */

(function (global) {
  "use strict";

  /* The three outcomes of a read, as a tagged result rather than a value
     that might be null for two different reasons. */
  function ok(value) { return { state: "ok", value: value }; }
  function absent() { return { state: "absent", value: null }; }
  function failed(reason) { return { state: "failed", value: null, reason: reason }; }

  /* A public GET, JSON. `Accept: application/json` is REQUIRED, not
     decorative: three of these paths also serve a web page, and the server
     tells them apart by this header alone. Without it a page fetching its
     own data would be handed its own HTML. */
  function get(path) {
    return fetch(path, { headers: { Accept: "application/json" }, credentials: "omit" })
      .then(function (res) {
        if (res.status === 404) return absent();
        if (!res.ok) return failed("http " + res.status);
        return res.json().then(ok, function () { return failed("unreadable response"); });
      })
      .catch(function () { return failed("network"); });
  }

  /* Same, for a document served as application/ld+json. A credential is a
     linked-data document and the server sets that type, so asking for plain
     JSON would be asking for something it does not offer. */
  function getLinkedData(path) {
    return fetch(path, { headers: { Accept: "application/ld+json" }, credentials: "omit" })
      .then(function (res) {
        if (res.status === 404) return absent();
        if (!res.ok) return failed("http " + res.status);
        return res.json().then(ok, function () { return failed("unreadable response"); });
      })
      .catch(function () { return failed("network"); });
  }

  /* -------------------------------------------------------------- write */

  /* The one storage key a session ever lives under, on this whole site.
     nav.js and signin.js used to each carry their own idea of it; this is
     now the single place that spells it. */
  var SESSION_STORAGE_KEY = "fa_session";

  /* The session a person is signed in with, or null. Moved from nav.js's
     private readStoredSession (P8g scope item 5): hire.js needs the same
     token to post, and a page gaining a second need for the same fact
     must not grow a second implementation of it. Malformed storage reads
     as signed out, never as a crash. */
  function getStoredSession() {
    var raw;
    try {
      raw = global.sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === "string" && parsed.token !== "") return parsed;
    } catch (e) {
      /* malformed storage reads as signed out below */
    }
    return null;
  }

  /* SW3-01: the page a person pressed Sign in on, so signing in brings
     them back to it instead of to the front page. nav.js writes it when a
     link to /signin is pressed; the GitHub callback page (auth-callback.js)
     and a passkey sign-in on /signin (signin.js) take it. One key, one
     rule, spelled here only. It holds a path and query, never an origin,
     a hash or a token. */
  var RETURN_STORAGE_KEY = "fa_return_to";

  /* The sign-in page's own paths. Express matches routes case-blind and
     with or without a trailing slash, so /Signin and /signin/ are the same
     page. */
  function isSignInPath(pathname) {
    var p = String(pathname).toLowerCase();
    return p === "/signin" || p === "/signin/";
  }

  function rememberReturnPath(path) {
    try {
      global.sessionStorage.setItem(RETURN_STORAGE_KEY, path);
    } catch (e) {
      /* private-browsing or a full quota: sign-in lands on / as before */
    }
  }

  function forgetReturnPath() {
    try {
      global.sessionStorage.removeItem(RETURN_STORAGE_KEY);
    } catch (e) {
      /* nothing stored, nothing to forget */
    }
  }

  /* A return path is a redirect target, so only this site's own paths may
     be one. Anything that a browser could read as another origin is
     refused: "//host" and "/\host" are both scheme-relative URLs to a
     browser, a backslash anywhere can turn into one, and whitespace or a
     control character can be stripped into one. The sign-in page and the
     /auth routes are refused too, so a sign-in never lands back on sign-in. */
  function isOwnReturnPath(value) {
    if (typeof value !== "string") return false;
    if (value.charAt(0) !== "/" || value.charAt(1) === "/") return false;
    for (var i = 0; i < value.length; i += 1) {
      var code = value.charCodeAt(i);
      if (code === 0x5c || code <= 0x20 || code === 0x7f) return false;
    }
    var pathname = value.split(/[?#]/)[0];
    if (isSignInPath(pathname)) return false;
    var lower = pathname.toLowerCase();
    if (lower === "/auth" || lower.indexOf("/auth/") === 0) return false;
    return true;
  }

  /* Reads the stored return path and removes it, always, whether or not
     it is used, so it is followed at most once. Answers the path when it
     passes isOwnReturnPath, else null (the caller lands on / as before).
     It is never read from the URL: a path in a query string would be a
     redirect anyone could send in a link. */
  function takeReturnPath() {
    var value = null;
    try {
      value = global.sessionStorage.getItem(RETURN_STORAGE_KEY);
    } catch (e) {
      value = null;
    }
    forgetReturnPath();
    return isOwnReturnPath(value) ? value : null;
  }
  /* An authenticated GET, mirroring postAuthed: resolves ok() with the
     response status/body attached even on non-2xx, since the caller
     needs the route's own status (401/403 here) to pick a sentence. */
  function getAuthed(path, token) {
    return fetch(path, {
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      credentials: "omit",
    })
      .then(function (res) {
        return res.json().then(
          function (parsed) { return ok({ status: res.status, body: parsed }); },
          function () { return ok({ status: res.status, body: null }); },
        );
      })
      .catch(function () { return failed("network"); });
  }

  /* A write by an authenticated buyer, JSON in, JSON out. Unlike `get`,
     this always resolves ok() with the response body attached even on a
     non-2xx status, because the CALLER needs the route's own status and
     message to distinguish several refusals (P8g scope item 9). A
     request that never reached the server is the only failed() case. */
  function postAuthed(path, token, body) {
    return fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
      credentials: "omit",
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(
          function (parsed) { return ok({ status: res.status, body: parsed }); },
          function () { return ok({ status: res.status, body: null }); },
        );
      })
      .catch(function () { return failed("network"); });
  }

  /* FIX-B60: ask the platform to look at GitHub for a submitted hire, once
     per page load, on the viewer's own session. job.js, pullrequest.js and
     operatorjob.js each call this after their own render; every condition
     lives here so the three pages ask the same way.

     It sends POST /jobs/:jobId/merge with an empty body. Nothing a party
     says rides it: the route reads the pull request from GitHub itself and
     records only what GitHub reports (src/api/app.ts, ENT-7.1). That is why
     a page may ask where no control ever may: a control would be a person
     saying "it merged", and this is the server checking.

     Asks only for a job at `submitted` and only when a session is stored.
     Each page calls it from the render its load draws, so a load asks
     once; the tests count the requests exactly. The same render runs again
     only after a 200 here (the hire has then left `submitted`, so it does
     not ask again) or after a party's own click on that page (a close, a
     stage, a refused redo). onRecorded() runs only on a 200: the route
     answers 200 only when it recorded what GitHub reported (completed,
     closed_unmerged or stale), and each page then reads the hire again
     rather than trusting this body, so it draws what a fresh load would.
     Every other answer (409 still open, 401, 403, 429, 503, a network
     failure) is silent: nothing on the page changes and nothing is
     retried. Resolves with the tagged answer, or null when it did not ask. */
  function checkMerge(job, onRecorded) {
    if (!job || job.status !== "submitted" || typeof job.id !== "string" || job.id === "") return null;
    var session = getStoredSession();
    if (session === null) return null;
    return postAuthed("/jobs/" + encodeURIComponent(job.id) + "/merge", session.token, {}).then(function (result) {
      // A page closed before the answer lands writes nothing (B57).
      if (typeof document === "undefined" || !document) return result;
      if (result.state === "ok" && result.value.status === 200) onRecorded();
      return result;
    });
  }

  /* An authenticated PATCH, mirroring postAuthed: resolves ok() with the
     response status/body attached even on a non-2xx status, so the CALLER
     picks the sentence a refusal gets (P8v ruling 1: the one write this
     screen has). A request that never reached the server is the only
     failed() case. */
  function patchAuthed(path, token, body) {
    return fetch(path, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
      credentials: "omit",
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().then(
          function (parsed) { return ok({ status: res.status, body: parsed }); },
          function () { return ok({ status: res.status, body: null }); },
        );
      })
      .catch(function () { return failed("network"); });
  }

  /* An authenticated PUT or DELETE, same contract as patchAuthed: ok() with
     the route's status and body on any response, failed() only when the
     request never reached the server. AV2: the avatar editor's Save and
     Reset to default. */
  function sendAuthed(method, path, token, body) {
    var init = {
      method: method,
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      credentials: "omit",
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init)
      .then(function (res) {
        return res.json().then(
          function (parsed) { return ok({ status: res.status, body: parsed }); },
          function () { return ok({ status: res.status, body: null }); },
        );
      })
      .catch(function () { return failed("network"); });
  }

  function putAuthed(path, token, body) { return sendAuthed("PUT", path, token, body); }
  function deleteAuthed(path, token) { return sendAuthed("DELETE", path, token); }

  /* ------------------------------------------------------------- DOM */

  function el(id) { return document.getElementById(id); }

  /* Write text into a node. Clears the pending mark, so the supporting
     colour that says "still loading" is not left on a real fact. */
  function setText(node, text) {
    if (!node) return;
    node.textContent = text;
    node.removeAttribute("data-pending");
  }

  function setTextById(id, text) { setText(el(id), text); }

  function show(node, on) {
    if (!node) return;
    node.hidden = !on;
  }

  function showById(id, on) { show(el(id), on); }

  /* An SVG string the API generated from a DID (ENT-2.3, no upload path
     exists anywhere in this product). Parsed as XML and copied in element by
     element, keeping only the shape and container elements an avatar is made
     of, so nothing else can ride in on that string. */
  var SVG_ALLOWED = [
    "svg", "g", "path", "circle", "ellipse", "rect", "line",
    "polyline", "polygon", "defs", "clippath", "use", "title"
  ];

  function sanitizedSvg(markup) {
    var doc = new DOMParser().parseFromString(String(markup), "image/svg+xml");
    var root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg") return null;
    if (doc.getElementsByTagName("parsererror").length > 0) return null;

    function copy(source) {
      var name = source.nodeName.toLowerCase();
      if (SVG_ALLOWED.indexOf(name) === -1) return null;
      var out = document.createElementNS("http://www.w3.org/2000/svg", name);
      Array.prototype.forEach.call(source.attributes || [], function (attr) {
        var attrName = attr.name.toLowerCase();
        /* No event handlers, and no href of any kind: an avatar is drawn
           shapes and needs neither. */
        if (attrName.indexOf("on") === 0) return;
        if (attrName === "href" || attrName === "xlink:href") return;
        out.setAttribute(attr.name, attr.value);
      });
      Array.prototype.forEach.call(source.childNodes, function (child) {
        if (child.nodeType === 3) { out.appendChild(document.createTextNode(child.nodeValue)); return; }
        if (child.nodeType !== 1) return;
        var kid = copy(child);
        if (kid) out.appendChild(kid);
      });
      return out;
    }

    return copy(root);
  }

  function setAvatar(node, markup) {
    if (!node) return false;
    var svg = sanitizedSvg(markup);
    if (!svg) return false;
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    node.textContent = "";
    node.appendChild(svg);
    node.removeAttribute("data-pending");
    return true;
  }

  /* ---------------------------------------------------------- format */

  /* A date a person reads. Returns null rather than a guess when the input
     is not a parseable instant, so a caller renders nothing instead of
     "Invalid Date". */
  function readableDate(value) {
    if (typeof value !== "string" || value === "") return null;
    var ms = Date.parse(value);
    if (isNaN(ms)) return null;
    var d = new Date(ms);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  /* A DID, shortened for a place where the full string would dominate. The
     full value stays available: every shortened DID on a page sits beside a
     copy control carrying the whole thing. */
  function shortDid(did) {
    if (typeof did !== "string") return "";
    if (did.length <= 26) return did;
    return did.slice(0, 16) + "\u2026" + did.slice(-6);
  }

  /* S1: the name a person reads for an agent (DESIGN.md 1.3: a did:abt
     string reads as the agent's name and avatar on the surface). The
     record's own name, or the plain words when it has none or the read
     failed. The DID itself stays on the agent's profile, one link away. */
  var UNNAMED_AGENT = "This agent";
  function agentName(agent) {
    return agent && typeof agent.name === "string" && agent.name.trim() !== "" ? agent.name : UNNAMED_AGENT;
  }

  /* S1: the "operated by" line, named in words. The operator's GitHub
     handle when their account carries one (the name operator.js leads
     with); otherwise the sentence becomes "See who runs this agent", which
     stays true whether the account has no handle or the read failed. Never
     the DID: that sits on the operator's own page and in a page's technical
     details. The row stays hidden until the account read settles, so it
     never shows a line with nothing on it.

     Markup contract: <div id=rowId hidden>operated by <a id=linkId></a></div>.
     The words before the link stay a text node, so the link reads as part
     of a sentence (the inline-link exemption to the 44px floor). */
  function nameOperator(rowId, linkId, operatorDid) {
    var row = el(rowId);
    var link = el(linkId);
    if (!row || !link || typeof operatorDid !== "string" || operatorDid === "") return;
    link.setAttribute("href", "/accounts/" + encodeURIComponent(operatorDid));
    get("/accounts/" + encodeURIComponent(operatorDid)).then(function (result) {
      var login = result.state === "ok" && typeof result.value.githubLogin === "string" ? result.value.githubLogin.trim() : "";
      var lead = link.previousSibling;
      if (!lead || lead.nodeType !== 3) {
        lead = document.createTextNode("");
        row.insertBefore(lead, link);
      }
      lead.nodeValue = login !== "" ? "operated by " : "See ";
      setText(link, login !== "" ? "@" + login : "who runs this agent");
      show(row, true);
    });
  }

  /* S1: one exact identity in a technical details panel, its row shown
     only once there is a value (never a blank row). */
  function techIdentity(wrapId, valueId, did) {
    if (typeof did !== "string" || did === "") return;
    setText(el(valueId), did);
    show(el(wrapId), true);
  }

  /* Wallet tooling signs with the short-form key hash (z...) while the
     registry records the full DID (did:abt:z...). Both name the same key
     (src/domain/agent.ts:35-37, the server-side original of this rule), so
     every DID comparison a page makes reconciles through this first. A raw
     string comparison would let one buyer in two forms read as two
     (MISSION invariant 5, src/domain/buyer-diversity.ts:93-95). */
  function didSuffix(did) {
    if (typeof did !== "string") return "";
    var prefix = "did:abt:";
    return did.indexOf(prefix) === 0 ? did.slice(prefix.length) : did;
  }

  /* A count and its noun, agreeing in number. "1 verified hire", never
     "1 verified hires". */
  function plural(n, one, many) {
    return String(n) + " " + (n === 1 ? one : many);
  }

  /* The path a credential id resolves to on THIS origin. A credential id is
     an absolute URL whose origin is the deployment that issued it, and a
     page fetching it must use the path so it works behind any proxy or
     hostname, rather than hardcoding an origin. Returns null for anything
     that is not a usable id. */
  function credentialPath(id) {
    if (typeof id !== "string" || id === "") return null;
    try {
      return new URL(id, global.location.origin).pathname;
    } catch (e) {
      return null;
    }
  }

  /* The last non-empty path segment of a credential id: the completed job id
     it attests. Mirrors credentialLookupKey in src/adapters/storage/types.ts,
     which is the same rule on the server side. */
  function credentialKey(id) {
    if (typeof id !== "string" || id === "") return "";
    var segments = id.split("/");
    for (var i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i]) return segments[i];
    }
    return id;
  }

  /* The identifier in the current URL's last path segment, decoded. Every
     page here is addressed as /<collection>/<id>. */
  function idFromPath() {
    var parts = global.location.pathname.split("/").filter(Boolean);
    var last = parts[parts.length - 1];
    if (!last) return "";
    try {
      return decodeURIComponent(last);
    } catch (e) {
      return last;
    }
  }

  /* ------------------------------------------------------ the ABT rate */

  /* FIX-B70b: the ABT payment sheet on /deposit and /staged shows the rate
     the payment is locked at. The start route (POST .../abt/start) answers
     it in `extra.abtQuote` as { usdPerAbt, rateUpdatedAt, expiresAt, ... },
     written once per press when the payment session is minted
     (src/adapters/payment/abt-did-connect.ts, onStart). Both pages read it
     through these, so they read it the same way. It lives here because
     both page shells already load this file first; a separate file would be
     one more script tag in each shell for the same two functions.

     A quote is usable when usdPerAbt is a plain decimal string, expiresAt
     parses as a time, and rateUpdatedAt is null or parses as a time. The
     rate is shown exactly as locked, trailing zeros trimmed to no fewer
     than two decimals and never rounded. Both times are local clock times,
     never "minutes ago" and never a countdown: the sheet stays open with no
     timer, so a relative time would go false while it sat there. No ABT
     amount is shown; the wallet shows that. */
  var ABT_PRICE_PHRASE = "price is not available";
  var ABT_PRICE_SENTENCE = "The ABT price is not available right now. Nothing was charged. Try again in a minute.";

  function clockTime(value) {
    if (typeof value !== "string" || value === "") return null;
    var ms = Date.parse(value);
    if (isNaN(ms)) return null;
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function lockedRate(usdPerAbt) {
    if (typeof usdPerAbt !== "string" || !/^\d+(\.\d+)?$/.test(usdPerAbt)) return null;
    var parts = usdPerAbt.split(".");
    var frac = (parts[1] || "").replace(/0+$/, "");
    while (frac.length < 2) frac += "0";
    return parts[0] + "." + frac;
  }

  /* The lines to draw for one start answer's quote, or null when the quote
     is unusable. `updated` is what follows "Price data by CoinGecko". */
  function abtQuoteLines(quote) {
    if (!quote || typeof quote !== "object") return null;
    var rate = lockedRate(quote.usdPerAbt);
    var heldUntil = clockTime(quote.expiresAt);
    var updatedAt = quote.rateUpdatedAt === null ? null : clockTime(quote.rateUpdatedAt);
    if (rate === null || heldUntil === null) return null;
    if (quote.rateUpdatedAt !== null && updatedAt === null) return null;
    return {
      rate: "1 ABT = $" + rate + ", held until " + heldUntil + ".",
      updated: updatedAt === null ? "." : ", updated " + updatedAt + "."
    };
  }

  /* Fills the sheet's #abt-rate block from this press's quote and shows
     it, overwriting whatever an earlier press drew. Unusable: the block is
     emptied and hidden, and this answers false so the page opens no sheet
     (a wallet opened on a payment with no locked price has to refuse it). */
  function drawAbtQuote(quote) {
    var lines = abtQuoteLines(quote);
    setTextById("abt-rate-line", lines === null ? "" : lines.rate);
    setTextById("abt-rate-updated", lines === null ? "" : lines.updated);
    showById("abt-rate", lines !== null);
    return lines !== null;
  }

  global.FAApi = {
    get: get,
    getLinkedData: getLinkedData,
    getAuthed: getAuthed,
    postAuthed: postAuthed,
    checkMerge: checkMerge,
    patchAuthed: patchAuthed,
    putAuthed: putAuthed,
    deleteAuthed: deleteAuthed,
    getStoredSession: getStoredSession,
    isSignInPath: isSignInPath,
    rememberReturnPath: rememberReturnPath,
    takeReturnPath: takeReturnPath,
    el: el,
    setText: setText,
    setTextById: setTextById,
    show: show,
    showById: showById,
    setAvatar: setAvatar,
    readableDate: readableDate,
    shortDid: shortDid,
    agentName: agentName,
    UNNAMED_AGENT: UNNAMED_AGENT,
    nameOperator: nameOperator,
    techIdentity: techIdentity,
    didSuffix: didSuffix,
    plural: plural,
    credentialPath: credentialPath,
    credentialKey: credentialKey,
    idFromPath: idFromPath,
    ABT_PRICE_PHRASE: ABT_PRICE_PHRASE,
    ABT_PRICE_SENTENCE: ABT_PRICE_SENTENCE,
    abtQuoteLines: abtQuoteLines,
    drawAbtQuote: drawAbtQuote
  };
})(window);
