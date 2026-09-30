/* HT1 Part B: the plain notification list (card's own scope limit: "build
   only the operator's unread badge and a plain notification list on the
   site, nothing more elaborate"). Reads GET /accounts/me the same way
   dashboard.js and myjobs.js already do to resolve the session to a DID,
   then GET /accounts/:did/notifications for the list and count.

   FIX-SW12k (SW3-09): the list now marks read, through the one route that
   does it, POST /accounts/:did/notifications/:notificationId/read.
   - A press on an unread row sends that POST once, with keepalive so it
     survives the navigation the press starts, and never holds the
     navigation. A press on a read row sends nothing. The screen does not
     change on a row press: the page is leaving, and a POST that fails
     leaves the row unread on the next visit, which is then true.
   - While anything is unread, one plain "Mark all as read" button sits
     beside the summary line. It posts once per unread row, one at a time,
     stops at the first refusal or lost request, and then reads the list
     again and draws what the server holds. A failure is one sentence in
     #mark-all-error, a role="alert" node present from page load. At zero
     unread the button is not in the document at all.

   EVENT TEXT IS A FIXED LOOKUP, never invented per row: new_brief,
   new_message, quote_changed and sibling_withdrawn are the only four
   NotificationEventType values the server ever writes
   (src/domain/notification.ts), and each maps to one fixed sentence.

   EVERYTHING THROUGH textContent: nothing here is markup. */
(function () {
  "use strict";
  var A = window.FAApi;

  var EVENT_TEXT = {
    new_brief: "New brief",
    new_message: "New message",
    quote_changed: "Quote changed",
    sibling_withdrawn: "A sibling job was withdrawn",
  };

  var MARK_ALL_FAILED = "Some notifications could not be marked read. Reloading may work.";

  // Set once the account resolves: { did, token }.
  var account = null;

  function eventLabel(eventType) {
    return Object.prototype.hasOwnProperty.call(EVENT_TEXT, eventType) ? EVENT_TEXT[eventType] : "Update";
  }

  function isUnread(n) {
    return n.readAt === null || n.readAt === undefined;
  }

  function readPath(id) {
    return "/accounts/" + encodeURIComponent(account.did) + "/notifications/" + encodeURIComponent(id) + "/read";
  }

  function failLoad(detail) {
    A.showById("notifications-body", false);
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  // One POST per unread row per page load, whatever the answer: the press
  // navigates away, so there is nothing on this page to retry into.
  function markOnOpen(row, n) {
    var sent = false;
    row.addEventListener("click", function () {
      if (sent) return;
      sent = true;
      A.postAuthedKeepalive(readPath(n.id), account.token, {});
    });
  }

  function renderRows(notifications) {
    var host = A.el("notification-rows");
    if (!host) return;
    host.textContent = "";
    if (notifications.length === 0) {
      A.showById("notifications-empty", true);
      return;
    }
    A.showById("notifications-empty", false);
    // Newest first: the list reads oldest-first from storage
    // (NotificationRepository's own convention), reversed here for
    // display, the same convention every other feed on this site uses.
    notifications
      .slice()
      .reverse()
      .forEach(function (n) {
        var tmpl = A.el("tmpl-notification-row");
        var row = tmpl.content.firstElementChild.cloneNode(true);
        if (isUnread(n)) {
          row.classList.add("is-unread");
          markOnOpen(row, n);
        } else {
          row.querySelector(".notif-dot").remove();
        }
        row.querySelector(".notif-label").textContent = eventLabel(n.eventType);
        var date = A.readableDate(n.createdAt);
        if (date !== null) row.querySelector(".notif-date").textContent = date;
        row.setAttribute("href", "/jobs/" + encodeURIComponent(n.jobId));
        host.appendChild(row);
      });
    if (window.FAIcon) window.FAIcon.paint(host);
  }

  // The button exists only while something is unread: cloned from its
  // template into the slot beside the summary, or the slot is emptied.
  function renderMarkAll(unread) {
    var slot = A.el("mark-all-slot");
    if (!slot) return;
    slot.textContent = "";
    if (unread.length === 0) return;
    var button = A.el("tmpl-mark-all").content.firstElementChild.cloneNode(true);
    button.addEventListener("click", function () { markAll(button, unread); });
    slot.appendChild(button);
  }

  function markAll(button, unread) {
    button.disabled = true;
    A.showById("mark-all-error", false);
    A.setTextById("mark-all-error", "");
    var i = 0;
    function next() {
      if (i >= unread.length) {
        loadList();
        return;
      }
      var n = unread[i];
      i += 1;
      A.postAuthed(readPath(n.id), account.token, {}).then(function (result) {
        if (result.state !== "ok" || result.value.status !== 200) {
          A.setTextById("mark-all-error", MARK_ALL_FAILED);
          A.showById("mark-all-error", true);
          loadList();
          return;
        }
        next();
      });
    }
    next();
  }

  function onLoaded(body) {
    var notifications = Array.isArray(body.notifications) ? body.notifications : [];
    var unreadCount = typeof body.unreadCount === "number" ? body.unreadCount : 0;
    A.setTextById(
      "unread-summary",
      unreadCount === 0 ? "You are all caught up." : A.plural(unreadCount, "unread notification", "unread notifications"),
    );
    renderRows(notifications);
    renderMarkAll(notifications.filter(isUnread));
    A.showById("notifications-body", true);
  }

  function loadList() {
    A.getAuthed("/accounts/" + encodeURIComponent(account.did) + "/notifications", account.token).then(function (result) {
      if (result.state !== "ok" || result.value.status !== 200) {
        failLoad("Your notifications could not be read just now. Reloading may work.");
        return;
      }
      onLoaded(result.value.body && typeof result.value.body === "object" ? result.value.body : {});
    });
  }

  function start() {
    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }
    A.getAuthed("/accounts/me", session.token).then(function (meResult) {
      if (meResult.state === "ok" && meResult.value.status === 401) {
        A.showById("signin-required", true);
        return;
      }
      if (meResult.state !== "ok" || meResult.value.status !== 200) {
        failLoad("Your account could not be read just now. Reloading may work.");
        return;
      }
      var me = meResult.value.body && typeof meResult.value.body === "object" ? meResult.value.body : {};
      var did = typeof me.did === "string" ? me.did : "";
      if (did === "") {
        failLoad("Your account could not be read just now. Reloading may work.");
        return;
      }
      account = { did: did, token: session.token };
      loadList();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
