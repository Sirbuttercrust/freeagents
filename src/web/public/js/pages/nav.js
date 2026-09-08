/* P8e: the nav tells the truth about whether you are signed in. One
   implementation, shared by every page that carries the nav (SITEMAP.md
   section 2's four-item bar), so the rule that decides signed-in vs
   signed-out lives in exactly one place instead of seven copies that would
   drift.

   BUILD ONLY WHAT EXISTS. SITEMAP.md's signed-in row also names My jobs,
   My agents and an avatar menu holding Dashboard, Settings, Sign out.
   P8m built My jobs, P8n built My agents and P8u (ruling 7) added a plain
   Dashboard link, the same injected-and-removed shape as the other two
   (this file's own items below); the avatar menu itself stays unbuilt,
   because settings.html still does not exist and this script must not
   link to a page this product does not serve.

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
  // P8m scope item 6: the My jobs entry, injected into .links (never
  // seventeen page-file edits) when a session exists, and removed again
  // when it does not. Built once per page load, appended after Browse.
  var MYJOBS_LINK_ID = "nav-myjobs";
  // P8n scope item 6: the My agents entry, the same injected-and-removed
  // shape as My jobs above, appended after it.
  var MYAGENTS_LINK_ID = "nav-myagents";

  function clearStoredSession() {
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {
      /* private-browsing or a full quota: nothing further to clear */
    }
  }

  // P8m: adds or removes the My jobs link from .links, the one nav
  // container every page's markup already carries. Idempotent: calling
  // this twice in the same state never produces a second link, and
  // toggling states removes exactly what it added.
  function renderMyJobsLink(isSignedIn) {
    var links = document.querySelector(".links");
    if (!links) return;
    var existing = document.getElementById(MYJOBS_LINK_ID);
    if (!isSignedIn) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;
    var a = document.createElement("a");
    a.id = MYJOBS_LINK_ID;
    a.href = "/myjobs";
    a.textContent = "My jobs";
    links.appendChild(a);
  }

  // P8n: same shape as renderMyJobsLink above, one implementation in this
  // file (brief scope item 6), appended after it so the nav order matches
  // SITEMAP.md's own signed-in row (Browse, My jobs, My agents).
  function renderMyAgentsLink(isSignedIn) {
    var links = document.querySelector(".links");
    if (!links) return;
    var existing = document.getElementById(MYAGENTS_LINK_ID);
    if (!isSignedIn) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;
    var a = document.createElement("a");
    a.id = MYAGENTS_LINK_ID;
    a.href = "/myagents";
    a.textContent = "My agents";
    links.appendChild(a);
  }

  // P8u ruling 7: the Dashboard entry, the same injected-and-removed
  // shape as My jobs and My agents above, appended after My agents. No
  // avatar menu, no Settings entry: settings.html is not built and
  // src/web/static.ts mounts no /settings, so this stays a plain link.
  var DASHBOARD_LINK_ID = "nav-dashboard";
  function renderDashboardLink(isSignedIn) {
    var links = document.querySelector(".links");
    if (!links) return;
    var existing = document.getElementById(DASHBOARD_LINK_ID);
    if (!isSignedIn) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;
    var a = document.createElement("a");
    a.id = DASHBOARD_LINK_ID;
    a.href = "/dashboard";
    a.textContent = "Dashboard";
    links.appendChild(a);
  }

  function render() {
    var session = A.getStoredSession();
    var signin = document.getElementById("nav-signin");
    var signedIn = document.getElementById("nav-signed-in");
    var isSignedIn = session !== null;
    renderMyJobsLink(isSignedIn);
    renderMyAgentsLink(isSignedIn);
    renderDashboardLink(isSignedIn);
    if (!signin || !signedIn) return;

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
