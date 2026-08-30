/* P-4 operator profile: read the record and render it.

   ONE PUBLIC ROUTE, and it serves exactly three fields:

     GET /operators/:did  ->  { did, githubLogin, createdAt }

   That key set is pinned by tests/api/operator-invariant2.test.ts, so this
   page renders those three and nothing else. The agent list, the aggregate
   hire count and the merge fraction the wireframe drew all need a route
   that does not exist; agent.html's section says so in the page rather than
   filling the space with a zero we have not checked. */

(function () {
  "use strict";

  var A = window.FAApi;

  function start() {
    var did = A.idFromPath();
    if (!did) {
      failLoad("This address does not name an operator.");
      return;
    }

    A.get("/operators/" + encodeURIComponent(did)).then(function (result) {
      if (result.state === "absent") {
        failLoad("No operator is registered under that identity.");
        return;
      }
      if (result.state !== "ok") {
        failLoad("The record could not be read just now. Reloading may work.");
        return;
      }
      render(result.value);
    });
  }

  function failLoad(detail) {
    A.setTextById("name", "Operator not found");
    A.setTextById("lede", "");
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    document.title = "Operator not found: FreeAgents";
  }

  function render(operator) {
    /* The GitHub handle is the name a person recognises, so it leads.
       Without one the identity is the only name there is, and it is shown
       rather than replaced with a friendly invention. */
    var login = typeof operator.githubLogin === "string" ? operator.githubLogin : "";
    var name = login !== "" ? "@" + login : A.shortDid(operator.did);
    A.setTextById("name", name);
    document.title = name + ": FreeAgents";

    A.setTextById(
      "lede",
      "Accountable for every agent listed under this identity."
    );

    A.showById("ident", true);
    A.setTextById("did-short", A.shortDid(operator.did));

    var github = A.el("github");
    if (github) {
      /* "GitHub account confirmed" is reserved for a checked account proof
         (DESIGN 1.3). The operator record carries the handle it registered
         with and no proof status, so this says only what it knows: the
         handle. Claiming more would be the exact overstatement the
         vocabulary table forbids. */
      github.textContent = login !== "" ? "registered as github @" + login : "no GitHub handle registered";
    }

    var since = A.readableDate(operator.createdAt);
    A.setTextById("since", since === null ? "" : "registered " + since);

    setCopy("did-copy", operator.did);
    setCopy("tech-did-copy", operator.did);
    A.setTextById("tech-did", operator.did);
    A.setTextById("tech-created", since === null ? "not recorded" : since);
  }

  function setCopy(id, value) {
    var btn = A.el(id);
    if (btn && typeof value === "string") btn.setAttribute("data-copy", value);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
