/* P8s conduct record (P-28): one account's counted conduct on both sides
   of a hire, from spec/wireframe/conduct.html. Reads
   GET /buyers/:githubLogin/conduct ONCE (src/api/app.ts) and takes no
   second read of any kind: no session, no /accounts/:did, no avatar
   fetch. The record is public and unauthenticated on purpose (ruling 1).

   THE ADDRESS: /conduct?account=<githubLogin>, read with
   URLSearchParams the same round-trip-through-the-URL mechanism
   agreement.js, deposit.js, staged.js and pullrequest.js already use for
   ?job=. Never A.idFromPath() -- this page is not addressed as
   /<collection>/<id>, and the record is keyed to a verified GitHub login,
   never a DID (ruling 1).

   FOUR STATES, FOUR DISTINCT SENTENCES, NEVER A COUNT ROW ON ANY OF THEM
   BUT THE FIFTH: no account parameter (ruling 1), keyed: false (ruling 3,
   its own sentence, never eight zeros -- the route's own comment states
   why), a failed read (network, malformed body, non-200), and the real
   render. The cold start (every count zero) is NOT a fifth state: it is
   the ordinary render path fed zeros, through the exact same selectors
   (ruling 4).

   DEPARTURES FROM THE WIREFRAME, NAMED HERE PER THE CARD:
   - No avatar renders. The wireframe's avatar is a static placeholder
     image; the real product's avatar (A.setAvatar) is SVG markup
     rendered server-side from a DID (src/api/avatar.ts, agentProjection
     in src/api/app.ts). This route returns no DID and no avatar field --
     GET /buyers/:githubLogin/conduct's own two response shapes
     (src/api/app.ts:2474-2488) carry neither -- so nothing here can
     produce one without a second read this card forbids (done-means
     item 2). The static placeholder in conduct.html stays a plain shape,
     the same "nothing to show" stance operator.html's own header .oav
     takes before a real avatar exists on that route either.
   - No "joined <date>" renders. accountProjection (src/api/app.ts:189-198)
     serves createdAt only from GET /accounts/:did, a route this page
     never calls (ruling 6); "GitHub account confirmed" ships alone, with
     no date, exactly as the ruling requires.
   - No "Their agents" button. It points at operator.html
     (/accounts/:did on the live product) and this page holds no DID to
     build that address from (ruling 6): a control this page cannot back
     with a real address is the inert-declared-control defect.

   EVERYTHING THROUGH textContent: githubLogin is user-supplied and every
   count is a number rendered with String(n), never a template into
   markup (api.js's own header rule). */
(function () {
  "use strict";
  var A = window.FAApi;

  function start() {
    var githubLogin = new URLSearchParams(window.location.search).get("account") || "";
    if (githubLogin === "") {
      failLoad("This address does not name an account.");
      return;
    }
    A.get("/buyers/" + encodeURIComponent(githubLogin) + "/conduct").then(function (result) {
      onLoaded(result, githubLogin);
    });
  }

  /* Ruling 3 / standing defect silent-success-on-failure: a missing
     account parameter, a failed read and an absent record each render
     their OWN sentence, and none of the three ever renders a count row
     or the cold start -- "this account has done nothing" is a claim a
     failed read knows nothing about. */
  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  function onLoaded(result, githubLogin) {
    if (result.state === "absent") {
      failLoad("There is no conduct record at that address.");
      return;
    }
    if (result.state !== "ok") {
      failLoad("The record could not be loaded just now. Reloading may work.");
      return;
    }
    var body = result.value && typeof result.value === "object" ? result.value : {};
    if (body.keyed !== true) {
      renderNotKeyed(githubLogin);
      return;
    }
    renderKeyed(body, githubLogin);
  }

  /* Ruling 3: keyed: false is its own state, distinct from the cold
     start -- it shares no copy and no DOM node with it, and it renders
     no count rows at all. Eight zeros here would be exactly the lie the
     route was built to refuse. */
  function renderNotKeyed(githubLogin) {
    A.setTextById(
      "not-keyed-detail",
      "\u201c" + githubLogin + "\u201d does not resolve to an account with a verified GitHub login, so there is no conduct record to show."
    );
    A.showById("not-keyed", true);
    document.title = "Conduct record: FreeAgents";
  }

  function renderKeyed(body, githubLogin) {
    A.setTextById("who-name", githubLogin);
    document.title = githubLogin + "\u2019s conduct record: FreeAgents";

    var counts = body.counts && typeof body.counts === "object" ? body.counts : {};
    var operatorCounts = body.operatorCounts && typeof body.operatorCounts === "object" ? body.operatorCounts : {};

    setCount("ct-confirmed", counts.confirmed);
    setCount("ct-merged", counts.merged);
    setCount("ct-deemed", counts.deemed);
    setCount("ct-cited-closes", counts.citedCloses);
    setCount("ct-redos-requested", counts.redosRequested);
    setCount("ct-walked-away", counts.walkedAway);

    setCount("ct-delivered-never-paid", operatorCounts.deliveredNeverPaid);
    setCount("ct-redos-refused", operatorCounts.redosRefused);

    A.showById("conduct-body", true);
  }

  /* Every number through String(n), never a template into markup -- the
     same rule every string on this page follows. A missing or malformed
     field renders 0 rather than throwing or leaving stale text, the same
     totality stance the domain layer this reads from already takes. */
  function setCount(id, value) {
    var n = typeof value === "number" && !isNaN(value) ? value : 0;
    A.setTextById(id, String(n));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
