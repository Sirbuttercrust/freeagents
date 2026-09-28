/* global self */
/* The FreeAgents service worker, served at /sw.js so its scope is the whole
   site and a notification can open /messages.

   It does three things and nothing else:
   - push: shows the notification the server sent. The payload is
     { title, body, jobId } (src/adapters/push/push.ts), where body is one
     fixed sentence per event and never the text of a message. A push with
     no payload, or one that will not parse, still shows a notification,
     because a browser that receives a push and shows nothing can take the
     permission away on some platforms.
   - activate: claims the pages already open, so a click can steer them.
   - notificationclick: opens the conversation the push is about,
     /messages?job=<jobId>, in a FreeAgents window if one is open and in a
     new one if not. With no jobId it opens /messages.

   It stores nothing. No cache, no offline copy, no fetch handler, no
   IndexedDB: the only state it ever holds is the jobId the browser keeps
   on the notification itself until the notification is closed. */
(function () {
  "use strict";

  var FALLBACK_TITLE = "FreeAgents";
  var FALLBACK_BODY = "You have a new notification.";

  function text(value) {
    return typeof value === "string" && value !== "" ? value : "";
  }

  function readPayload(event) {
    if (!event.data) return {};
    try {
      var parsed = event.data.json();
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  self.addEventListener("push", function (event) {
    var payload = readPayload(event);
    var jobId = text(payload.jobId);
    var options = {
      body: text(payload.body) || FALLBACK_BODY,
      icon: "/icon-192.png",
      data: { jobId: jobId },
    };
    // One notification per job: a burst of messages on one job replaces
    // the last notification instead of stacking.
    if (jobId !== "") options.tag = jobId;
    event.waitUntil(self.registration.showNotification(text(payload.title) || FALLBACK_TITLE, options));
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(self.clients.claim());
  });

  function targetFor(notification) {
    var jobId = notification && notification.data ? text(notification.data.jobId) : "";
    return jobId === "" ? "/messages" : "/messages?job=" + encodeURIComponent(jobId);
  }

  // Navigate first, then focus. navigate() rejects for a window this worker
  // does not control, and focus() spends the one window interaction a
  // notification click grants, after which openWindow() would be refused.
  // So the fallback has to be decided before anything is focused.
  function openConversation(url) {
    // matchAll only ever answers windows on this origin, so every one of
    // them is a FreeAgents window. The focused one wins when there is one.
    return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      var win = windows.filter(function (w) { return w.focused; })[0] || windows[0];
      if (!win) return self.clients.openWindow(url);
      return win.navigate(url).then(
        function (navigated) { return (navigated || win).focus(); },
        function () { return self.clients.openWindow(url); },
      );
    });
  }

  self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var url = new URL(targetFor(event.notification), self.location.origin).href;
    event.waitUntil(openConversation(url));
  });
})();
