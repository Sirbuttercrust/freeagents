/* Phone and desktop notifications for this browser, through the browser's own
   Web Push. One module so any page can offer the same switch; Settings is
   the only page that does today.

   window.FAPush:
   - supported(): true when this browser can do push here: a service
     worker, the Push API and notifications, on a secure page. Where any is
     missing the page hides the switch rather than offering one that fails.
   - readKey(): the server's public push key (GET /push/vapid-public-key),
     or null when the deployment has none or the read fails.
   - current(): this browser's subscription, or null. Counted only when
     permission is "granted", so a subscription whose permission was later
     taken away reads as off. Registers nothing: a page that is only
     looking never installs the worker.
   - turnOn(did, token, key): asks for permission, registers /sw.js,
     subscribes with the key, and stores the subscription on the server
     (POST /accounts/:did/push-subscriptions). Resolves
     { on: true, subscription } only after the server answered 201. Any
     refusal undoes the browser half, so the browser and the server never
     disagree, and resolves { on: false, sentence }.
   - turnOff(did, token, subscription): removes it from the server
     (DELETE), then from the browser, whatever the server said. Resolves
     { on: false }, with a sentence when the server did not confirm.
   - SENTENCES: every sentence the switch can show.

   CALL turnOn FROM THE PRESS ITSELF, SYNCHRONOUSLY. Its first statement is
   Notification.requestPermission(), and browsers (Safari most strictly)
   ignore a permission request that no press started, so nothing may be
   awaited before it. Registering the worker runs alongside it.

   Nothing here stores anything of its own. The subscription lives in the
   browser and on the server; the session token is read by the caller. */
(function () {
  "use strict";
  var A = window.FAApi;

  var SENTENCES = {
    blocked: "Notifications are blocked for this site. Allow them in your browser's settings, then try again.",
    dismissed: "Nothing changed.",
    expired: "Your session has expired. Sign in again to turn this on.",
    failed: "That did not go through. Try again in a moment.",
    offline: "That did not reach the server. Check your connection and try again.",
    // The server keeps its row when the DELETE fails (nothing prunes it),
    // but the browser's unsubscribe ends the address a push would be sent
    // to, so nothing more reaches this device. That is what is said.
    offAnyway: "Notifications are off on this device. The server did not confirm, but nothing more will reach it.",
  };

  function supported() {
    return (
      window.isSecureContext === true &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  function readKey() {
    return A.get("/push/vapid-public-key").then(function (r) {
      if (r.state !== "ok" || !r.value || typeof r.value.publicKey !== "string" || r.value.publicKey === "") return null;
      return r.value.publicKey;
    });
  }

  function current() {
    if (!supported() || window.Notification.permission !== "granted") return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration("/").then(function (reg) {
      return reg ? reg.pushManager.getSubscription() : null;
    }).then(function (sub) { return sub || null; }, function () { return null; });
  }

  // applicationServerKey takes the key's raw bytes; the server hands it out
  // as base64url, the form web-push generates.
  function keyBytes(key) {
    var b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    var raw = window.atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function refuse(sentence, sub) {
    var undo = sub ? sub.unsubscribe().catch(function () { return false; }) : Promise.resolve();
    return undo.then(function () { return { on: false, sentence: sentence }; });
  }

  function subscriptionsPath(did) {
    return "/accounts/" + encodeURIComponent(did) + "/push-subscriptions";
  }

  function turnOn(did, token, key) {
    var asked = window.Notification.requestPermission();
    var ready = navigator.serviceWorker.register("/sw.js").then(function () {
      return navigator.serviceWorker.ready;
    });
    // Handled below only when permission is granted; this keeps a failed
    // registration after a refused permission from surfacing as an
    // unhandled rejection.
    ready.catch(function () { return null; });
    return Promise.resolve(asked).then(function (permission) {
      if (permission === "denied") return { on: false, sentence: SENTENCES.blocked };
      if (permission !== "granted") return { on: false, sentence: SENTENCES.dismissed };
      return ready.then(function (reg) {
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      }).then(function (sub) {
        return A.postAuthed(subscriptionsPath(did), token, sub.toJSON()).then(function (r) {
          if (r.state !== "ok") return refuse(SENTENCES.offline, sub);
          if (r.value.status === 201) return { on: true, subscription: sub };
          if (r.value.status === 401) return refuse(SENTENCES.expired, sub);
          return refuse(SENTENCES.failed, sub);
        });
      }, function () {
        return { on: false, sentence: SENTENCES.failed };
      });
    });
  }

  // DELETE carries { endpoint } in its body, which FAApi.deleteAuthed does
  // not send, so this one request is written out here. Resolves the
  // route's status, or 0 when the request never reached the server.
  function deleteSubscription(did, token, endpoint) {
    return fetch(subscriptionsPath(did), {
      method: "DELETE",
      headers: { "content-type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
      credentials: "omit",
      body: JSON.stringify({ endpoint: endpoint }),
    }).then(function (res) { return res.status; }, function () { return 0; });
  }

  function turnOff(did, token, sub) {
    return deleteSubscription(did, token, sub.endpoint).then(function (status) {
      var confirmed = status === 204;
      return sub.unsubscribe().catch(function () { return false; }).then(function () {
        return confirmed ? { on: false } : { on: false, sentence: SENTENCES.offAnyway };
      });
    });
  }

  window.FAPush = {
    supported: supported,
    readKey: readKey,
    current: current,
    turnOn: turnOn,
    turnOff: turnOff,
    SENTENCES: SENTENCES,
  };
})();
