/* P8e: the nav tells the truth about whether you are signed in. One
   implementation, shared by every page that carries the nav (SITEMAP.md
   section 2's four-item bar), so the rule that decides signed-in vs
   signed-out lives in exactly one place instead of seven copies that would
   drift.

   BUILD ONLY WHAT EXISTS. SITEMAP.md's signed-in row also names My jobs,
   My agents and an avatar menu holding Dashboard, Settings, Sign out.
   P8m built My jobs, P8n built My agents, P8u (ruling 7) added a plain
   Dashboard link and P8v (ruling 7) added a plain Settings link, the same
   injected-and-removed shape as the other two (this file's own items
   below); the avatar menu itself stays unbuilt, because collapsing four
   existing links into a menu is a visual change to every page carrying
   the nav and is a taste call for the polish pass, not any one card.

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
  // avatar menu: SITEMAP.md's signed-in row names one, but collapsing
  // four existing links into a menu is a visual change to every page
  // carrying the nav and is out of scope here (P8v ruling 7).
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

  // P8v ruling 7: the Settings entry, the same injected-and-removed shape
  // as the three links above, appended after Dashboard. Still no avatar
  // menu: settings.html exists now, but collapsing the signed-in row into
  // a menu remains a taste call for the polish pass, not this card.
  var SETTINGS_LINK_ID = "nav-settings";
  function renderSettingsLink(isSignedIn) {
    var links = document.querySelector(".links");
    if (!links) return;
    var existing = document.getElementById(SETTINGS_LINK_ID);
    if (!isSignedIn) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;
    var a = document.createElement("a");
    a.id = SETTINGS_LINK_ID;
    a.href = "/settings";
    a.textContent = "Settings";
    links.appendChild(a);
  }

  // MSG1b: the Messages entry, the same injected-and-removed shape as the
  // four links above, appended after Settings, going to /messages (the
  // hire conversations). It replaced HT1's Notifications link in the same
  // slot; /notifications is still served, and nothing new links to it.
  // Carries the unread badge: the unreadTotal of
  // GET /accounts/:did/threads (every unread message across every thread
  // the account is in, both seats), after resolving the signed-in DID via
  // GET /accounts/me the same way My jobs and My agents do.
  var MESSAGES_LINK_ID = "nav-messages";
  // Proof r1, defect 10 (on the old Notifications link): a bare number
  // appended inside the link made its accessible name read "Messages12"
  // with no "unread" text anywhere. An aria-label on the LINK itself (not
  // the badge span) states the count in words; the badge's visible text
  // stays just the digit for a sighted user.
  function renderMessagesBadge(count) {
    // Guarded: this runs at the end of a fire-and-forget fetch chain
    // (refreshMessagesBadge below), so the page may already have
    // navigated away or torn itself down by the time the response
    // lands (a test's own JSDOM window closing before the request
    // resolves is the same shape a real navigation would take). A
    // stale-page throw here must never become an unhandled rejection.
    try {
      var link = document.getElementById(MESSAGES_LINK_ID);
      if (!link) return;
      var existing = link.querySelector(".badge");
      if (count > 0) {
        if (!existing) {
          existing = document.createElement("span");
          existing.className = "badge";
          link.appendChild(existing);
        }
        existing.textContent = String(count);
        link.setAttribute("aria-label", "Messages, " + count + " unread");
      } else {
        if (existing && existing.parentNode) {
          existing.parentNode.removeChild(existing);
        }
        link.removeAttribute("aria-label");
      }
    } catch (e) {
      /* the page tore down before this async update landed; nothing to render */
    }
  }
  // Reads the count again. Called once when the link is built, and by
  // /messages itself (through window.FANav.refreshMessages) after it marks
  // a thread read, so the badge drops without a reload.
  function refreshMessagesBadge() {
    var session = A.getStoredSession();
    if (!session) return;
    A.getAuthed("/accounts/me", session.token).then(function (meResult) {
      if (meResult.state !== "ok" || meResult.value.status !== 200) return;
      var me = meResult.value.body && typeof meResult.value.body === "object" ? meResult.value.body : {};
      var did = typeof me.did === "string" ? me.did : "";
      if (did === "") return;
      return A.getAuthed("/accounts/" + encodeURIComponent(did) + "/threads", session.token).then(function (result) {
        if (result.state !== "ok" || result.value.status !== 200) return;
        var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
        var count = typeof body.unreadTotal === "number" ? body.unreadTotal : 0;
        renderMessagesBadge(count);
      });
    }).catch(function () {
      /* fire-and-forget: a failed badge refresh must never surface as an
         unhandled rejection, the same reasoning as renderMessagesBadge's
         own try/catch above */
    });
  }
  function renderMessagesLink(isSignedIn) {
    var links = document.querySelector(".links");
    if (!links) return;
    var existing = document.getElementById(MESSAGES_LINK_ID);
    if (!isSignedIn) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;
    var a = document.createElement("a");
    a.id = MESSAGES_LINK_ID;
    a.href = "/messages";
    a.textContent = "Messages";
    links.appendChild(a);
    refreshMessagesBadge();
  }

  function render() {
    var session = A.getStoredSession();
    var signin = document.getElementById("nav-signin");
    var signedIn = document.getElementById("nav-signed-in");
    var isSignedIn = session !== null;
    renderMyJobsLink(isSignedIn);
    renderMyAgentsLink(isSignedIn);
    renderDashboardLink(isSignedIn);
    renderSettingsLink(isSignedIn);
    renderMessagesLink(isSignedIn);

    /* W6 round 2, D1: signin.js's "Once signed in" section is gated by
       this exact session rule (S1), so it clears here too, wherever the
       session is cleared, rather than in a second copy on signin.js's
       own sign-out path (there is none: sign-out lives in nav.js only,
       clicked from the nav this file already owns). A.showById is a
       no-op when the page carries no #once-signed-in element, which is
       every page except signin.html. */
    A.showById("once-signed-in", isSignedIn);

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
    wireMenu();
  }

  /* THE PHONE MENU (DESIGN.md 5 nav, the league look). Below 761px the
     links fold behind one button, built here so every page gets it from
     the one nav implementation rather than twenty-five copies of markup.

     A real disclosure: the button carries aria-expanded and aria-controls
     naming the links it shows; Escape closes it and gives focus back to the
     button; widening past the breakpoint closes it. When open, the links sit
     in the bar's own flow under it (league.css), so the page is pushed down
     rather than covered. Without this script nothing is hidden: the links
     stay in the bar and wrap, the way they always did.

     The current page's link carries aria-current="page", read from the
     path, so a person in the open menu can see where they are. */
  var MENU_BREAK = "(min-width: 761px)";
  function wireMenu() {
    var nav = document.querySelector("nav.nav");
    if (!nav || nav.querySelector(".menu")) return;
    var inner = nav.querySelector(".inner") || nav.firstElementChild;
    var links = nav.querySelector(".links");
    if (!inner || !links) return;

    if (!links.id) links.id = "nav-links";
    Array.prototype.forEach.call(links.querySelectorAll("a[href]"), function (a) {
      var href = a.getAttribute("href");
      if (href && href.charAt(0) === "/" && href === window.location.pathname) {
        a.setAttribute("aria-current", "page");
      }
    });

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu";
    btn.setAttribute("aria-controls", links.id);
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Menu");
    btn.innerHTML =
      '<svg class="ico-open" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14"/></svg>' +
      '<svg class="ico-close" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';
    inner.appendChild(btn);
    nav.classList.add("has-menu");

    function setOpen(open) {
      nav.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close menu" : "Menu");
    }
    btn.addEventListener("click", function () {
      setOpen(btn.getAttribute("aria-expanded") !== "true");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        btn.focus();
      }
    });
    if (typeof window.matchMedia === "function") {
      var mq = window.matchMedia(MENU_BREAK);
      var onWide = function (e) { if (e.matches) setOpen(false); };
      if (mq.addEventListener) mq.addEventListener("change", onWide);
      else if (mq.addListener) mq.addListener(onWide);
    }
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
     second copy of the rule. refreshMessages re-reads the Messages badge
     the same way, for /messages after it marks a thread read. */
  window.FANav = { refresh: render, refreshMessages: refreshMessagesBadge };
})();
