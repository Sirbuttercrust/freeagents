/* P8e: the nav tells the truth about whether you are signed in. One
   implementation, shared by every page that carries the nav (SITEMAP.md
   section 2), so the rule that decides signed-in vs signed-out lives in
   exactly one place instead of copies that would drift.

   THE SIGNED-IN BAR (NAV1, SITEMAP.md section 2): Browse, My jobs, My
   agents, Messages, then the account menu at the top right. My jobs, My
   agents and Messages are injected into .links here when a session exists
   and removed again when it does not; How it works, a signed-out link in
   every page's markup, is hidden while signed in. The account menu is
   static markup in every page's #nav-signed-in row (a <details
   class="avatarmenu">, the same row on every page, pinned by
   tests/web/account-menu.test.ts), and this file wires it: its summary is
   the person's own mark (FAApi.personMark, api.js), and it opens to the
   account's name, Dashboard, Settings and Sign out. Dashboard and Settings
   are no longer bar links; #nav-signout is the last item in the menu and
   keeps its id, label and behaviour.

   THE SESSION IT READS IS THE SAME fa_session KEY signin.js already
   writes (sessionStorage, never a cookie -- the security sweep's "zero
   cookie machinery, so zero CSRF surface" stance, brief scope item 3).
   P8g moved the read itself into api.js (FAApi.getStoredSession),
   because hire.js needs the identical read to attach a bearer token to a
   write, and a second page needing the same fact is exactly the case that
   must never grow a second implementation of it. This script still owns
   clearing the key on sign-out and re-rendering; only the read moved.

   ONE ACCOUNT READ PER LOAD. GET /accounts/me is read once when the nav
   renders signed in (loadMe below). Its answer feeds the account menu (the
   DID colours the mark, githubLogin names the account) and the Messages
   badge (the DID keys the threads read). Any answer but a 200 naming a
   DID (a 401, 404 or 503, or a network failure) leaves the mark neutral
   and the menu working without a name line. A 401 changes nothing else:
   the nav never signed anyone out on this read before this card and does
   not now, and each page's own account read keeps its own signed-out
   handling.

   IT ALSO REMEMBERS WHERE SIGN IN WAS PRESSED (SW3-01, wireReturnPath
   below): any press on a link to /signin stores the page's path and
   query, so signing in brings the person back to it. The rule that
   decides what may be stored and followed lives in api.js
   (FAApi.rememberReturnPath and FAApi.takeReturnPath), shared with the
   GitHub callback page and the passkey path on /signin. */

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

  // MSG1b: the Messages entry, the same injected-and-removed shape as the
  // two links above, appended after My agents, going to /messages (the
  // hire conversations). It replaced HT1's Notifications link in the same
  // slot. /notifications is still served, and the nav does not link it;
  // /dashboard does, while the account has something unread (FIX-SW12k).
  // Carries the unread badge: the unreadTotal of
  // GET /accounts/:did/threads (every unread message across every thread
  // the account is in, both seats), keyed on the DID the one
  // GET /accounts/me read below resolves.
  var MESSAGES_LINK_ID = "nav-messages";
  // The review's defect 10 (on the old Notifications link): a bare number
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

  /* THE ONE ACCOUNT READ (NAV1 Make 5). meRead holds the promise of this
     load's GET /accounts/me for the token it was made with; it resolves to
     the account object on a 200 that names a DID, and to null on anything
     else (401, 404, 503, a network failure). It is made at most once per
     token, so the account menu and the Messages badge share one request. */
  var meRead = null;
  function loadMe() {
    var session = A.getStoredSession();
    if (!session) return null;
    if (meRead && meRead.token === session.token) return meRead.promise;
    var promise = A.getAuthed("/accounts/me", session.token).then(function (result) {
      if (result.state !== "ok" || result.value.status !== 200) return null;
      var me = result.value.body && typeof result.value.body === "object" ? result.value.body : null;
      if (!me || typeof me.did !== "string" || me.did === "") return null;
      return me;
    }, function () { return null; });
    meRead = { token: session.token, promise: promise };
    return promise;
  }

  // Reads the count again. Called once when the link is built, and by
  // /messages itself (through window.FANav.refreshMessages) after it marks
  // a thread read, so the badge drops without a reload. The DID comes
  // from this load's one /accounts/me read, never a second one.
  function refreshMessagesBadge() {
    var session = A.getStoredSession();
    var pending = loadMe();
    if (!session || !pending) return;
    pending.then(function (me) {
      if (!me) return;
      return A.getAuthed("/accounts/" + encodeURIComponent(me.did) + "/threads", session.token).then(function (result) {
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

  /* NAV1 Make 3 (SITEMAP.md section 2): the signed-in bar is Browse, My
     jobs, My agents, Messages and the account menu. How it works is a
     signed-out link; every page's markup carries it in .links, so it is
     hidden while a session exists and shown again when it ends. */
  function renderHowLink(isSignedIn) {
    var how = document.querySelector('nav.nav .links a[href="/how"]');
    if (how) how.hidden = isSignedIn;
  }

  /* THE ACCOUNT MENU'S CONTENTS (NAV1 Make 2 and 5). The mark is drawn
     neutral at once and takes the account's identity colour when the one
     /accounts/me read answers with a DID. The name line is the GitHub
     login; an account with no GitHub login reads "Signed in with a
     passkey", and the passkey's own server-made name (passkeySubject) is
     never shown anywhere. Until the read answers, and if it fails, the
     name line stays hidden and the three items still work. */
  var PASSKEY_NAME = "Signed in with a passkey";
  function accountName(me) {
    var login = typeof me.githubLogin === "string" ? me.githubLogin.trim() : "";
    return login !== "" ? login : PASSKEY_NAME;
  }
  function renderAccount(isSignedIn) {
    var mark = document.getElementById("nav-account-mark");
    var name = document.getElementById("nav-account-name");
    if (!mark) return;
    A.personMark(mark, null);
    if (name) {
      name.textContent = "";
      name.hidden = true;
    }
    if (!isSignedIn) return;
    var pending = loadMe();
    if (!pending) return;
    pending.then(function (me) {
      if (!me || !A.getStoredSession()) return;
      try {
        A.personMark(mark, me.did);
        if (name) {
          name.textContent = accountName(me);
          name.hidden = false;
        }
      } catch (e) {
        /* the page tore down before this async update landed */
      }
    });
  }

  function render() {
    var session = A.getStoredSession();
    var signin = document.getElementById("nav-signin");
    var signedIn = document.getElementById("nav-signed-in");
    var isSignedIn = session !== null;
    if (!isSignedIn) meRead = null;
    renderMyJobsLink(isSignedIn);
    renderMyAgentsLink(isSignedIn);
    renderMessagesLink(isSignedIn);
    renderHowLink(isSignedIn);
    renderAccount(isSignedIn);
    if (!isSignedIn) closeAccountMenu(false);

    /* signin.js's "Once signed in" section is gated by
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

  /* THE ACCOUNT MENU'S BEHAVIOUR (NAV1 Make 4). A native <details> (the
     wireframe's own element, spec/wireframe/dashboard.html): collapsed on
     every load with no state to remember, and Enter, Space or a click on
     its <summary> open and close it with no script. This file adds what
     <details> does not do: Escape closes it and puts focus back on the
     summary; a click outside closes it; choosing an item closes it;
     tabbing out of it closes it; render() closes it when the session ends;
     ArrowDown and ArrowUp move through Dashboard, Settings and Sign out
     (Tab reaches them too); and it never stands open beside the phone
     Menu, so opening either closes the other. The item for the page you
     are on carries aria-current="page". */
  var account = null;
  function accountItems() {
    if (!account) return [];
    return Array.prototype.slice.call(account.drop.querySelectorAll("a[href], button"));
  }
  function isAccountOpen() {
    return !!account && account.root.open;
  }
  function closeAccountMenu(returnFocus) {
    if (!account) return;
    account.root.open = false;
    if (returnFocus) account.btn.focus();
  }
  function wireAccountMenu() {
    var root = document.getElementById("nav-account");
    var btn = document.getElementById("nav-account-btn");
    var drop = document.getElementById("nav-account-drop");
    if (!root || !btn || !drop) return;
    account = { root: root, btn: btn, drop: drop };
    closeAccountMenu(false);

    accountItems().forEach(function (item) {
      var href = item.getAttribute("href");
      if (href && href === window.location.pathname) item.setAttribute("aria-current", "page");
      item.addEventListener("click", function () { closeAccountMenu(false); });
    });

    root.addEventListener("toggle", function () {
      if (root.open) closePhoneMenu();
    });

    root.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      var items = accountItems();
      if (items.length === 0) return;
      e.preventDefault();
      root.open = true;
      var at = items.indexOf(document.activeElement);
      var next = e.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
      items[next].focus();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isAccountOpen()) closeAccountMenu(true);
    });
    document.addEventListener("click", function (e) {
      if (isAccountOpen() && !root.contains(e.target)) closeAccountMenu(false);
    });
    /* Tabbing past the last item leaves the menu; it closes behind you
       rather than staying open over the page. */
    root.addEventListener("focusout", function (e) {
      if (isAccountOpen() && e.relatedTarget && !root.contains(e.relatedTarget)) closeAccountMenu(false);
    });
  }

  /* SW3-01: remember where Sign in was pressed. One capture-phase listener
     for the whole page, so the nav's #nav-signin, every page's in-page
     #signin-link and any later link to /signin are covered with no page
     edited, and the page's own handling of the press is left alone (this
     stores and returns; it never cancels the navigation). It stores the
     page's path and query through FAApi.rememberReturnPath, never the
     origin or the hash. On /signin itself nothing is stored, so a person
     who opened the sign-in page on its own still lands on / afterwards. */
  function wireReturnPath() {
    document.addEventListener("click", function (e) {
      var target = e.target;
      var link = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
      if (!link) return;
      /* link.origin and link.pathname are the href resolved against this
         page, so "/signin", "signin" and a full URL to it all match, and a
         link to /signin on another site does not. */
      if (link.origin !== window.location.origin || !A.isSignInPath(link.pathname)) return;
      if (A.isSignInPath(window.location.pathname)) return;
      A.rememberReturnPath(window.location.pathname + window.location.search);
    }, true);
  }

  function start() {
    wireAccountMenu();
    render();
    wireSignOut();
    wireMenu();
    wireReturnPath();
  }

  /* THE PHONE MENU (DESIGN.md 5 nav, the league look). Below 761px the
     links fold behind one button, built here so every page gets it from
     the one nav implementation rather than twenty-five copies of markup.

     A real disclosure: the button carries aria-expanded and aria-controls
     naming the links it shows; Escape closes it and gives focus back to the
     button; widening past the breakpoint closes it. When open, the links sit
     in the bar's own flow under it (league.css), so the page is pushed down
     rather than covered. Without this script nothing is hidden: the links
     stay in the bar and wrap, the way they always did. The account menu's
     button stays in the bar beside it, and the two never stand open
     together: opening either closes the other.

     The current page's link carries aria-current="page", read from the
     path, so a person in the open menu can see where they are. */
  var MENU_BREAK = "(min-width: 761px)";
  var phoneSetOpen = null;
  function closePhoneMenu() {
    if (phoneSetOpen) phoneSetOpen(false);
  }
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
      if (open) closeAccountMenu(false);
      nav.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close menu" : "Menu");
    }
    phoneSetOpen = setOpen;
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
     the same elements render() already owns; nothing here invents a
     second copy of the rule. refreshMessages re-reads the Messages badge
     the same way, for /messages after it marks a thread read. */
  window.FANav = { refresh: render, refreshMessages: refreshMessagesBadge };
})();
