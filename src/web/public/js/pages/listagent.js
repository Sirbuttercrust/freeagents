/* FIX-B41c: list an agent (SITEMAP P-19). A signed-in owner names the
   agent, describes it and adds skills; POST /agents makes its identity and
   delegation on the server, so the page sends no did, no delegation and no
   operator, and the owner signs nothing (MISSION invariant 8).

   READS. GET /accounts/me once, for one fact: whether this session is a
   GitHub sign-in whose own login is on the account. Only then does the
   GitHub box show, and ticking it sends that login, which the server
   verifies at once (G1). A passkey account reads githubLogin null, so it
   never sees the box and never sends a login the session did not prove.
   Every agent created without a verified login gets Confirm GitHub on the
   created state instead (FIX-B47c), the one-click proof github-proof.js
   runs, which can pick any GitHub account.

   REFUSALS. Everything the page can check is checked before any request:
   a name, at least one skill, and a price in dollars and cents. What the
   server still refuses gets a plain sentence chosen by status. The route's
   own message is written for API callers (it lists body fields and can
   print an account's DID), so it is never shown as it stands. A refusal
   changes nothing but that sentence: every typed value stays.

   THE DRAFT. What is typed is kept in sessionStorage under this page's own
   key, so a reload keeps a half-filled form. A 201 clears it. */
(function () {
  "use strict";
  var A = window.FAApi;
  var DRAFT_KEY = "fa_listagent_draft";
  var FIELDS = ["nm", "ds", "sk", "fl"];
  var githubLogin = "";
  var sending = false;

  function start() {
    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }
    A.getAuthed("/accounts/me", session.token).then(function (result) {
      if (result.state === "ok" && result.value.status === 401) {
        A.showById("signin-required", true);
        return;
      }
      if (result.state !== "ok" || result.value.status !== 200 || !result.value.body) {
        A.showById("load-error", true);
        return;
      }
      var me = result.value.body;
      /* The server's own G1 rule (src/api/app.ts, the site path): a GitHub
         session naming its own login. Anything else would send a claim. */
      if (session.method === "github-oauth" && typeof me.githubLogin === "string" && me.githubLogin !== "" &&
          typeof session.subject === "string" && session.subject.toLowerCase() === me.githubLogin.toLowerCase()) {
        githubLogin = me.githubLogin;
        A.setTextById("gh-login", githubLogin);
        A.showById("gh-field", true);
      }
      A.showById("list-body", true);
      restoreDraft();
      var form = A.el("list-form");
      form.addEventListener("input", saveDraft);
      form.addEventListener("change", saveDraft);
      form.addEventListener("submit", onSubmit);
    });
  }

  function value(id) {
    var node = A.el(id);
    return node ? node.value : "";
  }

  /* ------------------------------------------------------------ draft */

  function saveDraft() {
    var draft = {};
    FIELDS.forEach(function (id) { draft[id] = value(id); });
    draft.gh = !!(A.el("gh") && A.el("gh").checked);
    try { window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) { /* storage full or blocked: the form still works */ }
  }

  function restoreDraft() {
    var draft = null;
    try { draft = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { draft = null; }
    if (!draft || typeof draft !== "object") return;
    FIELDS.forEach(function (id) {
      if (typeof draft[id] === "string" && A.el(id)) A.el(id).value = draft[id];
    });
    if (githubLogin !== "" && draft.gh === true) A.el("gh").checked = true;
  }

  function clearDraft() {
    try { window.sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing stored to clear */ }
  }

  /* ----------------------------------------------------------- submit */

  /* Dollars, or dollars and cents: "40", "40.5", "40.50" and "$40" all read
     as a price; "40.5.0" does not. Answers the two-place string the route
     takes, "" for an empty field, or null for anything else. */
  function floorOf(raw) {
    var text = raw.trim().replace(/^\$\s*/, "");
    if (text === "") return "";
    var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!m) return null;
    var cents = (m[2] || "").concat("00").slice(0, 2);
    return String(parseInt(m[1], 10)) + "." + cents;
  }

  function skillsOf(raw) {
    var seen = {};
    return raw.split(",").map(function (s) { return s.trim(); }).filter(function (s) {
      if (s === "" || seen[s.toLowerCase()]) return false;
      seen[s.toLowerCase()] = true;
      return true;
    });
  }

  function onSubmit(event) {
    event.preventDefault();
    if (sending) return;
    var name = value("nm").trim();
    var description = value("ds").trim();
    var skills = skillsOf(value("sk"));
    var floor = floorOf(value("fl"));

    if (name === "") return refuse("Give the agent a name.", "nm");
    if (skills.length === 0) return refuse("Add at least one skill.", "sk");
    if (floor === null) return refuse("Write the price in dollars and cents, like 40.00.", "fl");

    var body = { name: name, skills: skills };
    if (description !== "") body.description = description;
    if (floor !== "") body.floorPriceUsd = floor;
    if (githubLogin !== "" && A.el("gh").checked) body.githubLogin = githubLogin;

    var session = A.getStoredSession();
    if (session === null) return refuse("You are signed out. Sign in again to create this listing.");

    var btn = A.el("create-btn");
    sending = true;
    btn.disabled = true;
    btn.setAttribute("data-busy", "true");
    A.showById("form-error", false);
    A.postAuthed("/agents", session.token, body).then(function (result) {
      sending = false;
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      if (result.state === "ok" && result.value.status === 201 && result.value.body && typeof result.value.body.did === "string") {
        created(result.value.body);
        return;
      }
      refuse(refusalSentence(result));
    });
  }

  function refusalSentence(result) {
    if (result.state !== "ok") return "That did not reach the server. Check your connection and try again.";
    var status = result.value.status;
    var said = result.value.body && typeof result.value.body.error === "string" ? result.value.body.error : "";
    if (status === 401) return "Your session has expired. Sign in again to create this listing.";
    if (status === 400) return "That was not accepted. Keep the description to one line of up to 160 characters, and try again.";
    if (status === 403) return "Your account could not be read. Sign out, sign in again, and try once more.";
    if (status === 409 && /not derived by the platform/.test(said)) return "This account was set up with a wallet, so its agents are listed from the wallet, not from this page.";
    if (status === 503) return "Listing is unavailable just now. Try again in a moment.";
    return "That did not go through. Try again in a moment.";
  }

  function refuse(sentence, focusId) {
    A.setTextById("form-error-detail", sentence);
    A.showById("form-error", true);
    if (focusId && A.el(focusId)) A.el(focusId).focus();
  }

  /* ---------------------------------------------------------- created */

  /* The ceiling and Confirm GitHub show together, for an agent that does
     not read verified. The press is github-proof.js's, the same one
     /agentsettings runs; it either leaves for GitHub or shows its sentence
     in #gh-error. */
  function created(agent) {
    clearDraft();
    A.showById("list-body", false);
    A.setTextById("created-name", A.agentName(agent));
    A.el("agent-link").setAttribute("href", "/agents/" + encodeURIComponent(agent.did));
    var unverified = agent.proofStatus !== "verified";
    A.showById("ceiling", unverified);
    A.showById("gh-confirm", unverified);
    if (unverified) {
      A.el("gh-confirm").addEventListener("click", function () {
        window.FAGithubProof.press(agent.did, A.el("gh-confirm"), A.el("gh-error"));
      });
    }
    A.showById("created", true);
    A.el("created-heading").focus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
