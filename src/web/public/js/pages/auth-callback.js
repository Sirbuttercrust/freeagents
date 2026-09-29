/* P8e: the GitHub callback page's own script. It runs after api.js, the
   only other script the page loads, and its whole job is to take the
   session the server embedded in the page body, move it into
   sessionStorage under the same fa_session key signin.js already uses,
   then send the person into the product signed in: back to the page they
   pressed Sign in on (SW3-01), or to / when there is none.

   WHERE IT LANDS. FAApi.takeReturnPath (api.js) reads the path nav.js
   stored when Sign in was pressed, removes it whether or not it is used,
   and answers it only when it is this site's own path; anything else, and
   no stored path at all, lands on / as before. The rule lives in api.js
   because a passkey sign-in on /signin follows the same one. The path is
   never read from this page's URL: a path in a query string would be a
   redirect anyone could send in a link.

   THE TOKEN NEVER TOUCHES A URL. It arrives in a <script type="application/
   json"> element's text content (read with textContent, per the sanitising
   pattern api.js's own header comment describes: text goes in as text,
   never innerHTML), and this script never writes it into location.href,
   an href, or a query string. Reading window.location here would be the
   one way to leak it into browser history or a referrer header, so this
   file does not touch it at all except to redirect AWAY from this page.
   The stored return path holds no token either: it is the page the person
   was on before signing in. */

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
  var returnPath = window.FAApi ? window.FAApi.takeReturnPath() : null;
  window.location.replace(returnPath || "/");
})();
