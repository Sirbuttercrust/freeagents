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
   - No avatar renders, and the mount point is absent rather than empty.
     The wireframe draws a real generated face here (a .av carrying
     data-avatar in spec/wireframe/conduct.html's account strip), and
     polish.js's avatars() sweep paints one by reading the DID off that
     attribute. This route serves no DID: both response shapes of
     GET /buyers/:githubLogin/conduct (its handler in src/api/app.ts)
     carry githubLogin and keyed, and the keyed one counts and
     operatorCounts, and nothing else, so there is no value to put on the
     attribute and no second read allowed to go and fetch one. An
     attribute with nothing behind it paints an empty box, and one
     carrying a guessed value paints a face for an identity nobody
     supplied, so neither ships, and the box is not reserved either:
     conduct.html carries the measurement for that half.

     THE DID IS NOT UNAVAILABLE TO THAT ROUTE, IT IS UNSERIALISED.
     buyerConductForLogin (src/api/app.ts) calls
     accountRepo.findByGithubLogin and holds account.did in hand on the
     line before it returns; the handler simply never puts it on the wire.
     Serialising it is a change to src/api/, which this card does not
     touch. Recorded here so the next reader knows this is one field away
     rather than architecturally impossible.
   - No "joined <date>" renders. createdAt is served only by the account
     routes (accountProjection in src/api/app.ts), none of which this
     page calls (ruling 6); "GitHub account confirmed" ships alone, with
     no date, exactly as the ruling requires.
   - No "Their agents" button. It points at operator.html
     (/accounts/:did on the live product) and this page holds no DID to
     build that address from (ruling 6): a control this page cannot back
     with a real address is the inert-declared-control defect.
   - DIAG1c: the counts are drawn as a diagram, "What was counted", and
     the definitions, both paragraphs and "How to read this" sit behind
     two disclosures (ruled 2026-09-29). This file still owns
     every number on it: it writes each count, as text and as the data-n
     the diagram counts up to, and then starts the diagram, once, at the
     end of the render state (renderKeyed). Nothing else on the page
     knows a number, and no sample number exists anywhere.

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

    /* DIAG1c: the diagram starts here and nowhere else, once, after all
       eight numbers are written and the body is shown, so it measures the
       layout a reader sees and counts up to the numbers this read gave.
       The other three states never reach this line, and they leave the
       body, and the diagram in it, hidden. */
    if (window.FADiagram) window.FADiagram.start(document.getElementById("conduct-diagram"));
  }

  /* Every number through String(n), never a template into markup -- the
     same rule every string on this page follows. A missing or malformed
     field renders 0 rather than throwing or leaving stale text, the same
     totality stance the domain layer this reads from already takes.

     DIAG1c: the same number also goes on data-n, the value the diagram
     counts up to (js/diagrams.js, THE MARKUP CONTRACT), and a 0 marks its
     leaf .is-zero, the quieter style. A zero leaf is never hidden. */
  function setCount(id, value) {
    var n = typeof value === "number" && !isNaN(value) ? value : 0;
    A.setTextById(id, String(n));
    var el = document.getElementById(id);
    if (!el) return;
    el.setAttribute("data-n", String(n));
    var leaf = el.closest(".dg-leaf");
    if (leaf) leaf.classList.toggle("is-zero", n === 0);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
