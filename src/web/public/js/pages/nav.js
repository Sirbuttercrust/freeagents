/* P8e: the nav tells the truth about whether you are signed in. One
   implementation, shared by every page that carries the nav (SITEMAP.md
   section 2's four-item bar), so the rule that decides signed-in vs
   signed-out lives in exactly one place instead of seven copies that would
   drift.

   BUILD ONLY WHAT EXISTS. SITEMAP.md's signed-in row also names My jobs,
   My agents and an avatar menu holding Dashboard, Settings, Sign out --
   none of those pages exist yet, so this script adds only what the
   product actually serves today: the Sign in link disappears, and a sign
   out control appears in its place. Nothing here links to a page this
   product does not serve.

   THE SESSION IT READS IS THE SAME fa_session KEY signin.js already
   writes (sessionStorage, never a cookie -- the security sweep's "zero
   cookie machinery, so zero CSRF surface" stance, brief scope item 3).
   P8g moved the read itself into api.js (FAApi.getStoredSession),
   because hire.js needs the identical read to attach a bearer token to a
   write, and a second page needing the same fact is exactly the case that
   must never grow a second implementation of it. This script still owns
   clearing the key on sign-out and re-rendering; only the read moved. */

(function () {
  "use strict";

  var A = window.FAApi;
  var SESSION_STORAGE_KEY = "fa_session";

  function clearStoredSession() {
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {
      /* private-browsing or a full quota: nothing further to clear */
    }
  }

  function render() {
    var session = A.getStoredSession();
    var signin = document.getElementById("nav-signin");
    var signedIn = document.getElementById("nav-signed-in");
    if (!signin || !signedIn) return;

    var isSignedIn = session !== null;
    signin.hidden = isSignedIn;
    signedIn.hidden = !isSignedIn;
  }

  function wireSignOut() {
    var btn = document.getElementById("nav-signout");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var session = A.getStoredSession();
      var token = session ? session.token : null;

      var finish = function () {
        clearStoredSession();
        render();
      };

      if (!token) {
        finish();
        return;
      }

      btn.disabled = true;
      fetch("/auth/signout", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      })
        .then(finish, finish)
        .then(function () {
          btn.disabled = false;
        });
    });
  }

  function start() {
    render();
    wireSignOut();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  /* One implementation of the nav state (brief scope item 6), so a page
     whose own script stores a session without navigating away -- the
     passkey path on /signin, unlike the GitHub callback, sends nobody
     anywhere -- has a way to ask this same rule to run again instead of
     copying it. window.FANav.refresh() re-reads fa_session and updates
     the same two elements render() already owns; nothing here invents a
     second copy of the rule. */
  window.FANav = { refresh: render };
})();
