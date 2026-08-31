/* P-8 sign in: render the real access boundary.

   ONE PUBLIC ROUTE:

     GET /capabilities  ->  { notice, capabilities[] }

   That route is R-23's whole point: the limit is stated before a user
   invests effort, and it is readable by anyone, signed in or not. Reading
   it here rather than restating it in the HTML means this page cannot drift
   from what the service actually enforces. A capability that moves from
   public to identified changes this page the moment it is deployed.

   The list of sign-in METHODS is a different thing and is not read from
   here: GET /sign-in-methods is not merged, and the three the page
   describes are the fixed set the project's own invariants define, so they
   are stated in the markup rather than invented from an endpoint that does
   not answer. */

(function () {
  "use strict";

  var A = window.FAApi;

  function start() {
    A.get("/capabilities").then(function (result) {
      if (result.state !== "ok") {
        A.showById("caps-error", true);
        return;
      }
      render(result.value);
    });
  }

  function render(document_) {
    if (typeof document_.notice === "string" && document_.notice !== "") {
      A.setTextById("notice", document_.notice);
    }

    var caps = Array.isArray(document_.capabilities) ? document_.capabilities : [];
    if (caps.length === 0) {
      A.showById("caps-error", true);
      return;
    }

    var pub = caps.filter(function (c) { return c.access === "public"; });
    var ident = caps.filter(function (c) { return c.access === "identified"; });

    fill("public-wrap", "public-caps", pub);
    fill("identified-wrap", "identified-caps", ident);
  }

  function fill(wrapId, hostId, caps) {
    if (caps.length === 0) return;
    A.showById(wrapId, true);
    var host = A.el(hostId);
    caps.forEach(function (cap) {
      host.appendChild(row(cap));
    });
  }

  function row(cap) {
    var node = document.createElement("div");

    var what = document.createElement("div");
    what.className = "what";
    what.textContent = readable(cap);
    node.appendChild(what);

    /* The service's own one-sentence reason, verbatim. Rewriting it here
       would let the page and the API disagree about the same rule. */
    if (typeof cap.reason === "string" && cap.reason !== "") {
      var why = document.createElement("p");
      why.className = "why";
      why.textContent = cap.reason;
      node.appendChild(why);
    }

    var where = document.createElement("div");
    where.className = "where";
    where.style.marginTop = "4px";
    where.textContent = String(cap.method || "") + " " + String(cap.path || "");
    node.appendChild(where);

    return node;
  }

  /* A capability id in plain language. An id with no entry here falls back
     to the id itself rather than to a guess: a new capability should read
     as an unfamiliar name, not as a confidently wrong sentence. */
  var LABELS = {
    "capabilities.read": "Read this access list",
    "agent.browse": "Read any agent's record",
    "operator.browse": "Read any operator's record",
    "credential.verify": "Open and check any receipt",
    "operator.register": "Register as an operator",
    "agent.list": "List an agent you operate",
    "job.hire": "Hire an agent for a job"
  };

  function readable(cap) {
    var id = typeof cap.id === "string" ? cap.id : "";
    return LABELS[id] || id;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
