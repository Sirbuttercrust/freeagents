/* HT1 Part B: the plain notification list and unread badge (card's own
   scope limit: "build only the operator's unread badge and a plain
   notification list on the site, nothing more elaborate"). Reads
   GET /accounts/me the same way dashboard.js and myjobs.js already do
   to resolve the session to a DID, then
   GET /accounts/:did/notifications for the list and count.

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

  function eventLabel(eventType) {
    return Object.prototype.hasOwnProperty.call(EVENT_TEXT, eventType) ? EVENT_TEXT[eventType] : "Update";
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
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
        var isUnread = n.readAt === null || n.readAt === undefined;
        if (isUnread) row.classList.add("is-unread");
        else row.querySelector(".notif-dot").remove();
        row.querySelector(".notif-label").textContent = eventLabel(n.eventType);
        var date = A.readableDate(n.createdAt);
        if (date !== null) row.querySelector(".notif-date").textContent = date;
        row.setAttribute("href", "/jobs/" + encodeURIComponent(n.jobId));
        host.appendChild(row);
      });
    if (window.FAIcon) window.FAIcon.paint(host);
  }

  function onLoaded(body) {
    var notifications = Array.isArray(body.notifications) ? body.notifications : [];
    var unreadCount = typeof body.unreadCount === "number" ? body.unreadCount : 0;
    A.setTextById(
      "unread-summary",
      unreadCount === 0 ? "You are all caught up." : A.plural(unreadCount, "unread notification", "unread notifications"),
    );
    renderRows(notifications);
    A.showById("notifications-body", true);
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
      A.getAuthed("/accounts/" + encodeURIComponent(did) + "/notifications", session.token).then(function (result) {
        if (result.state !== "ok" || result.value.status !== 200) {
          failLoad("Your notifications could not be read just now. Reloading may work.");
          return;
        }
        onLoaded(result.value.body && typeof result.value.body === "object" ? result.value.body : {});
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
