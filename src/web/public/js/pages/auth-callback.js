/* P8e: this is the ONLY script the GitHub callback page loads. Its whole
   job is to take the session the server embedded in the page body, move it
   into sessionStorage under the same fa_session key signin.js already
   uses, then send the person into the product signed in.

   THE TOKEN NEVER TOUCHES A URL. It arrives in a <script type="application/
   json"> element's text content (read with textContent, per the sanitising
   pattern api.js's own header comment describes: text goes in as text,
   never innerHTML), and this script never writes it into location.href,
   an href, or a query string. Reading window.location here would be the
   one way to leak it into browser history or a referrer header, so this
   file does not touch it at all except to redirect AWAY from this page. */

(function () {
  "use strict";

  var SESSION_STORAGE_KEY = "fa_session";

  function readEmbeddedSession() {
    var node = document.getElementById("fa-session-data");
    if (!node) return null;
    try {
      return JSON.parse(node.textContent || "");
    } catch (e) {
      return null;
    }
  }

  function storeSession(session) {
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch (e) {
      /* Private-browsing or a full quota: the sign-in itself still
         succeeded server-side, so this is not surfaced as a failure. */
    }
  }

  var session = readEmbeddedSession();
  if (session) storeSession(session);
  window.location.replace("/");
})();
