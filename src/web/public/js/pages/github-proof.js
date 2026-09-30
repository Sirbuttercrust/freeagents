/* FIX-B47c: the one-click GitHub proof, the press. Loaded by
   /agentsettings and by /listagent's created state, so both doors run this
   one function and neither page carries a copy of it.

   WHAT IT CALLS. POST /agents/:agentDid/github-proof/start, once, with the
   stored session's bearer token and no body, through
   FAApi.postAuthedSameOrigin: the one write on the site that sends
   credentials same-origin (B76). A 200 answers { redirectUrl }, GitHub's own
   authorize page, and sets the fa_oauth_state cookie that binds this proof
   to this browser; the page goes to GitHub and the browser sends the cookie
   back on GitHub's redirect, so the proof completes only here. The cookie
   authorizes nothing and is never read by the page (HttpOnly).
   The route's 200 shape is trusted as its contract states: the start
   answers 503 when GitHub is not configured, so there is no "200 but
   unconfigured" case to read out of the URL the way signin.js must.

   WHAT IT NEVER SHOWS. The route's own error text. It is written for API
   callers (it names routes and can print the agent's DID), so every
   refusal gets a plain sentence chosen by status instead, and a refusal
   changes nothing on the page but that sentence and the button coming
   back. There is no 404 sentence: both pages only offer the button for an
   agent they have just read or created, so the agent exists.

   WHY THE LANDING IS NOT HERE. GitHub sends the owner back to
   /agentsettings?agent=<did>&github=<outcome> only, so reading that
   outcome is /agentsettings' own job (agentsettings.js). /listagent never
   receives one. */
(function (global) {
  "use strict";
  var A = global.FAApi;

  var SENTENCES = {
    401: "Your session has expired. Sign in again to confirm it.",
    403: "Only this agent\u2019s owner can confirm its GitHub account. Sign in with the account that listed it.",
    409: "This agent was registered with its own identity, so it confirms its GitHub account through the API.",
    503: "Confirming GitHub is not available just now. Try again later."
  };
  var OFFLINE = "That did not reach the server. Check your connection and try again.";
  var OTHER = "That did not go through. Try again in a moment.";

  function sentenceFor(result) {
    if (result.state !== "ok") return OFFLINE;
    return SENTENCES[result.value.status] || OTHER;
  }

  function busy(button, on) {
    button.disabled = on;
    if (on) button.setAttribute("data-busy", "true");
    else button.removeAttribute("data-busy");
  }

  /* agentDid: the agent to confirm. button: the control pressed.
     sentence: a node that already carries role="alert", where a refusal is
     written. Answers nothing; the page either leaves for GitHub or shows
     the sentence. The button sits in no form, so disabling it while the
     request is out is the whole double-press guard: a disabled button
     takes no click and no key. */
  function press(agentDid, button, sentence) {
    A.setText(sentence, "");
    A.show(sentence, false);
    var session = A.getStoredSession();
    if (session === null) {
      refuse(button, sentence, SENTENCES[401]);
      return;
    }
    busy(button, true);
    A.postAuthedSameOrigin("/agents/" + encodeURIComponent(agentDid) + "/github-proof/start", session.token, {}).then(function (result) {
      if (result.state === "ok" && result.value.status === 200) {
        global.location.href = result.value.body.redirectUrl;
        return;
      }
      refuse(button, sentence, sentenceFor(result));
    });
  }

  function refuse(button, sentence, text) {
    busy(button, false);
    A.setText(sentence, text);
    A.show(sentence, true);
  }

  /* Back from GitHub's page restores this one from the browser's page
     cache with the button still spinning. It comes back ready. */
  global.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    var buttons = document.querySelectorAll("[data-github-proof][data-busy]");
    Array.prototype.forEach.call(buttons, function (b) { busy(b, false); });
  });

  global.FAGithubProof = { press: press };
})(window);
