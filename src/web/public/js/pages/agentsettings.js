/* FIX-B41d: agent settings (SITEMAP P-20). The owner of a listed agent
   changes its name, description, skills and lowest price, and can clear the
   description and the price, with PATCH /agents/:agentDid. FIX-B47c adds
   the second write: the GitHub account section's one button, which starts
   the one-click proof through github-proof.js (the press and its refusal
   sentences live there, shared with /listagent's created state).

   READS. GET /accounts/me for the signed-in account's did, then
   GET /agents/:agentDid for the agent. The form and the GitHub section
   show only when the two match (the agent's operatorDid is this account's
   did). Both routes answer 403 to anyone else whatever this page shows, so
   hiding them is a courtesy, never the guard.

   THE GITHUB SECTION reads proofStatus and githubLogin off that same agent
   read: verified shows "Confirmed: @login" and no button; anything else
   shows why it matters and the button.

   THE LANDING. GitHub's callback sends the owner back here as
   ?agent=<did>&github=verified|refused|failed. The outcome is read once,
   after the owner check, and then taken out of the address so a reload or
   a shared link does not say it again. "verified" is believed only when
   the agent itself reads verified: the query alone proves nothing.

   THE BODY. Every save sends all four fields and nothing else: name and
   skills always, description and floorPriceUsd as null when their field is
   empty, which clears them. A 200 refills the form from the route's answer,
   so "40" reads back "40.00".

   REFUSALS. Everything the page can check is checked before any request: a
   name, at least one skill, and a price in dollars and cents. What the
   server still refuses gets a plain sentence chosen by status. The route's
   own message is written for API callers (it names body fields and can
   print a DID), so it is never shown as it stands. A refusal changes
   nothing but that sentence: every typed value stays. */
(function () {
  "use strict";
  var A = window.FAApi;
  var agentDid = "";
  var sending = false;

  var OUTCOMES = {
    refused: "Nothing changed. You can confirm it whenever you are ready.",
    failed: "That did not work, and nothing changed. Try again."
  };

  function start() {
    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }
    A.getAuthed("/accounts/me", session.token).then(function (me) {
      if (me.state === "ok" && me.value.status === 401) {
        A.showById("signin-required", true);
        return;
      }
      if (me.state !== "ok" || me.value.status !== 200 || !me.value.body || typeof me.value.body.did !== "string") {
        A.showById("load-error", true);
        return;
      }
      var myDid = me.value.body.did;
      agentDid = new URLSearchParams(window.location.search).get("agent") || "";
      if (agentDid === "") {
        A.showById("missing", true);
        return;
      }
      A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
        if (result.state === "absent") {
          A.showById("missing", true);
          return;
        }
        if (result.state !== "ok" || !result.value || typeof result.value !== "object") {
          A.showById("load-error", true);
          return;
        }
        var agent = result.value;
        if (typeof agent.operatorDid !== "string" || agent.operatorDid !== myDid) {
          A.el("public-link").setAttribute("href", "/agents/" + encodeURIComponent(agentDid));
          A.showById("stranger", true);
          return;
        }
        fill(agent);
        showGithub(agent);
        A.showById("settings-body", true);
        var form = A.el("settings-form");
        form.addEventListener("submit", onSubmit);
        /* "Saved." speaks for the values on screen; an edit after it makes
           it stale, so it goes. */
        form.addEventListener("input", function () { A.setTextById("saved", ""); });
        A.el("gh-confirm").addEventListener("click", function () {
          A.setTextById("gh-outcome", "");
          window.FAGithubProof.press(agentDid, A.el("gh-confirm"), A.el("gh-error"));
        });
        landing(agent);
      });
    });
  }

  /* ------------------------------------------------------------- github */

  function showGithub(agent) {
    var verified = agent.proofStatus === "verified";
    A.setTextById("gh-login", typeof agent.githubLogin === "string" ? agent.githubLogin : "");
    A.showById("gh-confirmed", verified);
    A.showById("gh-unverified", !verified);
  }

  function landing(agent) {
    var params = new URLSearchParams(window.location.search);
    var outcome = params.get("github");
    if (outcome === null) return;
    params.delete("github");
    var query = params.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (query === "" ? "" : "?" + query) + window.location.hash);
    if (outcome === "verified" && agent.proofStatus === "verified") {
      A.setTextById("gh-outcome", "GitHub confirmed.");
    } else if (Object.prototype.hasOwnProperty.call(OUTCOMES, outcome)) {
      A.setTextById("gh-outcome", OUTCOMES[outcome]);
    }
  }

  function fill(agent) {
    A.setTextById("agent-name", A.agentName(agent));
    A.el("nm").value = typeof agent.name === "string" ? agent.name : "";
    A.el("ds").value = typeof agent.description === "string" ? agent.description : "";
    A.el("sk").value = Array.isArray(agent.skills) ? agent.skills.join(", ") : "";
    A.el("fl").value = typeof agent.floorPriceUsd === "string" ? agent.floorPriceUsd : "";
  }

  /* --------------------------------------------------------------- save */

  /* floorOf and skillsOf are copies of their twins in listagent.js, kept
     beside each page rather than shared, so the two forms read a price and
     a skill list by one rule. Change both or neither.

     Dollars, or dollars and cents: "40", "40.5", "40.50" and "$40" all read
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
    A.setTextById("saved", "");
    var name = A.el("nm").value.trim();
    var description = A.el("ds").value.trim();
    var skills = skillsOf(A.el("sk").value);
    var floor = floorOf(A.el("fl").value);

    if (name === "") return refuse("Give the agent a name.", "nm");
    if (skills.length === 0) return refuse("Add at least one skill.", "sk");
    if (floor === null) return refuse("Write the price in dollars and cents, like 40.00.", "fl");

    var session = A.getStoredSession();
    if (session === null) return refuse("Your session has expired. Sign in again to save your changes.");

    var body = {
      name: name,
      description: description === "" ? null : description,
      skills: skills,
      floorPriceUsd: floor === "" ? null : floor
    };
    var btn = A.el("save-btn");
    sending = true;
    btn.disabled = true;
    btn.setAttribute("data-busy", "true");
    A.showById("form-error", false);
    A.patchAuthed("/agents/" + encodeURIComponent(agentDid), session.token, body).then(function (result) {
      sending = false;
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      if (result.state === "ok" && result.value.status === 200 && result.value.body && typeof result.value.body.did === "string") {
        fill(result.value.body);
        A.setTextById("saved", "Saved.");
        return;
      }
      refuse(refusalSentence(result));
    });
  }

  /* One sentence per status a real save can reach. There is no 404 branch:
     nothing removes a listing, so an agent that loaded is still there. */
  function refusalSentence(result) {
    if (result.state !== "ok") return "That did not reach the server. Check your connection and try again.";
    var status = result.value.status;
    if (status === 401) return "Your session has expired. Sign in again to save your changes.";
    if (status === 400) return "That was not accepted. Keep the description to one line of up to 160 characters, and try again.";
    if (status === 403) return "Only this agent\u2019s owner can change it. Sign in with the account that listed it.";
    if (status === 503) return "Saving is unavailable just now. Try again in a moment.";
    return "That did not go through. Try again in a moment.";
  }

  function refuse(sentence, focusId) {
    A.setTextById("form-error-detail", sentence);
    A.showById("form-error", true);
    if (focusId && A.el(focusId)) A.el(focusId).focus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
