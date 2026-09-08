/* P8q incoming work (P-24): a signed-in operator's own list of offers made
   to the agents they run. Reads GET /accounts/me (the same departure P8m
   and P8n already named in their own handoffs) to resolve the session to a
   DID, then GET /accounts/:did/incoming for the offers (src/api/app.ts).
   Two reads, no per-row read: the route already resolves each offer's
   agent name (agentName, src/api/app.ts:1665), which is exactly the
   per-row lookup P8n had to make itself for myagents.

   RULING 1 (row control, superseded by P8v): P8q's own original ruling
   said P-25 (operatorjob.html) was not built and no row here carried a
   control. P8v built it and mounted /operatorjob (SITEMAP P-25), so
   every row here now links to it (the wireframe's own operatorjob.html
   href, spec/wireframe/incoming.html), the same door dashboard.js's own
   offer row already opened before this card, now landing on the real
   screen instead of back on this same list.

   RULING 2 (buyer identity): the route returns no buyer name and
   src/domain/account.ts carries no display-name field. The .repo line
   renders `repository` alone; no domain name the product does not hold.

   RULING 3 (date, not history): the route returns createdAt and nothing
   about signature history or which line changed. The .foot renders the
   offer's date through A.readableDate, the same absolute-date helper
   every other built page uses, and nothing else.

   RULING 4 (state mapping): waitingOnOf's three values map to the
   wireframe's three row states exactly:
     noReply           -> state-none, "New, nothing sent back yet"
     waitingOnBuyer    -> state-done, "Sent, waiting on the buyer"
     waitingOnOperator -> state-none, "Buyer proposed a change, waiting on you"

   THE SCOPE FENCE: nothing here ranks, scores, prioritises or totals the
   rows. Rows render in the exact order the route returns them (already
   newest first, src/api/app.ts:1656); this script never re-sorts.

   EVERY REFUSAL RENDERS ITS OWN SENTENCE: a 403, a 503 and a network
   failure each render different, honest copy, and none of them renders
   the empty state -- "no work is waiting" is a claim about the roster a
   failed read knows nothing about.

   EVERYTHING THROUGH textContent: the brief and the repository are
   buyer-supplied and operator-supplied strings, content, never markup
   (api.js's own header rule). */
(function () {
  "use strict";
  var A = window.FAApi;

  var STATE_INFO = {
    noReply: { cls: "state-none", text: "New, nothing sent back yet" },
    waitingOnBuyer: { cls: "state-done", text: "Sent, waiting on the buyer" },
    waitingOnOperator: { cls: "state-none", text: "Buyer proposed a change, waiting on you" },
  };

  function start() {
    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }
    A.getAuthed("/accounts/me", session.token).then(function (meResult) {
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
      A.getAuthed("/accounts/" + encodeURIComponent(did) + "/incoming", session.token).then(function (incomingResult) {
        onIncomingLoaded(incomingResult);
      });
    });
  }

  /* Every refusal renders its own distinct sentence (brief scope item 4):
     a 403, a 503 and a network failure never share copy, and none of
     them ever falls through to the empty state. */
  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  function onIncomingLoaded(result) {
    if (result.state !== "ok") {
      failLoad("Your incoming work could not be reached just now. Reloading may work.");
      return;
    }
    var status = result.value.status;
    var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
    if (status === 403) {
      failLoad(typeof body.error === "string" && body.error !== "" ? body.error : "Your incoming work could not be confirmed for this account.");
      return;
    }
    if (status === 503) {
      failLoad("Storage is unavailable just now. Try again in a moment.");
      return;
    }
    if (status !== 200) {
      failLoad("Your incoming work could not be loaded just now. Reloading may work.");
      return;
    }
    var offers = Array.isArray(body.offers) ? body.offers : [];
    A.showById("incoming-body", true);
    if (offers.length === 0) {
      A.showById("empty-state", true);
      A.showById("rows", false);
      return;
    }
    renderRows(offers);
  }

  function renderRows(offers) {
    var host = document.getElementById("rows");
    if (!host) return;
    host.textContent = "";
    // The route's own order is kept as-is (already newest first,
    // src/api/app.ts:1656): this script never re-sorts by state or by
    // anything else (the scope fence).
    offers.forEach(function (offer, i) {
      var row = offerRow(offer);
      row.style.setProperty("--i", String(i));
      host.appendChild(row);
    });
  }

  function offerRow(offer) {
    var row = document.createElement('a');
    row.className = 'orow pane-lift';
    row.href = '/operatorjob?job=' + encodeURIComponent(offer.id);

    var between = document.createElement("div");
    between.className = "between";

    var left = document.createElement("div");
    var who = document.createElement("div");
    who.className = "who";
    who.textContent = typeof offer.agentName === "string" && offer.agentName !== "" ? offer.agentName : A.shortDid(offer.agentDid);
    left.appendChild(who);

    var repo = document.createElement("div");
    repo.className = "repo mono";
    repo.textContent = typeof offer.repository === "string" ? offer.repository : "";
    left.appendChild(repo);
    between.appendChild(left);

    var info = STATE_INFO[offer.waitingOn] || STATE_INFO.noReply;
    var state = document.createElement("span");
    state.className = "state " + info.cls;
    var dot = document.createElement("span");
    dot.className = "dot";
    state.appendChild(dot);
    state.appendChild(document.createTextNode(info.text));
    between.appendChild(state);

    row.appendChild(between);

    var brief = document.createElement("p");
    brief.className = "brief";
    brief.textContent = typeof offer.brief === "string" ? offer.brief : "";
    row.appendChild(brief);

    var foot = document.createElement("div");
    foot.className = "foot";
    var date = A.readableDate(offer.createdAt);
    var dateSpan = document.createElement("span");
    dateSpan.className = "small dim";
    dateSpan.textContent = date || "";
    foot.appendChild(dateSpan);
    row.appendChild(foot);

    return row;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
