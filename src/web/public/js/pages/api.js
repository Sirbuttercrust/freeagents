/* The API client the marketplace pages share.

   Every page here reads the SAME public routes a third party can call, with
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
      is inserted through a parser that keeps only shape elements. */

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

  global.FAApi = {
    get: get,
    getLinkedData: getLinkedData,
    el: el,
    setText: setText,
    setTextById: setTextById,
    show: show,
    showById: showById,
    setAvatar: setAvatar,
    readableDate: readableDate,
    shortDid: shortDid,
    didSuffix: didSuffix,
    plural: plural,
    credentialPath: credentialPath,
    credentialKey: credentialKey,
    idFromPath: idFromPath
  };
})(window);
