/* P-5 credential: read one receipt and render it.

   TWO PUBLIC ROUTES, no session:

     GET /v1/credentials/:id          the signed document, verbatim
     GET /v1/credentials/:id/status   whether a compromise window covers it

   WHY THE STATUS IS A SECOND REQUEST AND NOT A FIELD. The bytes served at
   the credential's own address are the bytes that verified, unchanged by a
   report ever being filed (invariant 2), and ENT-8.3 forbids a judgement
   inside the signature envelope. So the disputed marker lives on its own
   route beside the document, and this page reads both and shows them
   together. Merging them would break the thing the page exists to prove. */

(function () {
  "use strict";

  var A = window.FAApi;

  function start() {
    var id = A.idFromPath();
    if (!id) {
      failLoad("This address does not name a receipt.");
      return;
    }

    var base = "/v1/credentials/" + encodeURIComponent(id);

    A.getLinkedData(base).then(function (result) {
      if (result.state === "absent") {
        failLoad("There is no receipt at that address. A receipt is only issued when work actually ships.");
        return;
      }
      if (result.state !== "ok") {
        failLoad("The receipt could not be read just now. Reloading may work.");
        return;
      }
      render(result.value, base);
      /* The status read is separate and non-blocking: a receipt renders
         fully whether or not the dispute check answers. */
      A.get(base + "/status").then(function (status) {
        if (status.state === "ok") renderStatus(status.value);
      });
    });
  }

  function failLoad(detail) {
    A.setTextById("claim", "");
    A.setTextById("state-label", "No receipt here");
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    document.title = "Receipt not found: FreeAgents";
  }

  function render(credential, basePath) {
    var subject = credential.credentialSubject || {};
    var hire = subject.hire || {};
    var agentDid = typeof subject.id === "string" ? subject.id : "";

    /* THE PLAIN SENTENCE. Outcome first, mechanism second, identifier last
       (DESIGN 7.1). The repository and the date are what a person came for;
       the identity is behind a disclosure below. */
    var claim = A.el("claim");
    claim.textContent = "";
    var when = A.readableDate(hire.mergedAt);
    var repository = typeof hire.repository === "string" ? hire.repository : "";

    appendBold(claim, A.shortDid(agentDid));
    claim.appendChild(document.createTextNode(" shipped work to "));
    appendBold(claim, repository !== "" ? repository : "a repository");
    claim.appendChild(document.createTextNode(
      when === null ? ", and it merged." : ", and it merged on " + when + "."
    ));
    claim.removeAttribute("data-pending");

    document.title = "Receipt for work on " + (repository !== "" ? repository : "a repository") + ": FreeAgents";

    /* The four facts. Every one comes from the signed document; a field the
       document does not carry is left out rather than filled in. */
    A.showById("facts", true);

    var where = A.el("fact-where");
    if (typeof hire.pullRequest === "string" && hire.pullRequest !== "") {
      var link = document.createElement("a");
      link.setAttribute("href", hire.pullRequest);
      link.setAttribute("rel", "noreferrer");
      link.style.color = "var(--accent)";
      link.textContent = repository !== "" ? repository : hire.pullRequest;
      where.textContent = "";
      where.appendChild(link);
    } else {
      A.setText(where, repository !== "" ? repository : "not recorded");
    }

    /* Diff size is an observation and is never called large or small. Any
       weighting of it toward a quality judgement is out of scope
       permanently (MISSION, ENT-8.3). */
    var diff = "not recorded";
    if (typeof hire.additions === "number" && typeof hire.deletions === "number") {
      diff = "+" + hire.additions + " / -" + hire.deletions;
      if (typeof hire.filesChanged === "number") {
        diff += ", " + A.plural(hire.filesChanged, "file", "files");
      }
    }
    A.setTextById("fact-diff", diff);

    var agentCell = A.el("fact-agent");
    if (agentDid !== "") {
      var agentLink = document.createElement("a");
      agentLink.setAttribute("href", "/agents/" + encodeURIComponent(agentDid));
      agentLink.style.textDecoration = "underline";
      agentLink.style.textUnderlineOffset = "2px";
      agentLink.textContent = A.shortDid(agentDid);
      agentCell.textContent = "";
      agentCell.appendChild(agentLink);
      agentCell.removeAttribute("data-pending");
    } else {
      A.setText(agentCell, "not recorded");
    }

    var buyer = typeof hire.buyer === "string" ? hire.buyer : "";
    A.setTextById("fact-buyer", buyer !== "" ? A.shortDid(buyer) : "not recorded");

    /* Actions. "Check this yourself" carries the credential id, so the
       verify page reads the same document rather than asking for it again
       by a different name. */
    A.showById("actions", true);
    var key = A.credentialKey(typeof credential.id === "string" ? credential.id : basePath);
    setHref("verify-link", "/verify?credential=" + encodeURIComponent(key));
    setHref("agent-link", agentDid !== "" ? "/agents/" + encodeURIComponent(agentDid) : "/browse");
    setHref("download-link", basePath);

    /* The technical half. */
    setPair("id-agent", agentDid);
    setPair("id-buyer", buyer);
    setPair("id-issuer", typeof credential.issuer === "string" ? credential.issuer : "");
    setPair("id-signer", typeof hire.signedBy === "string" ? hire.signedBy : "");

    setPair("agreed-brief", typeof hire.brief === "string" ? hire.brief : "");

    /* specHash is absent on a job completed without a confirmed spec
       (R-35), and its absence is shown by removing the row rather than by
       printing an empty value that reads like a missing hash. */
    if (typeof hire.specHash === "string" && hire.specHash !== "") {
      setPair("agreed-spec", hire.specHash);
    } else {
      A.showById("agreed-spec-wrap", false);
    }

    A.setTextById("raw-json", JSON.stringify(credential, null, 2));
  }

  /* R-16: the window is visible. Nothing is hidden, nothing is deleted, and
     the receipt above is untouched: this is a fact about a key, stated
     beside the document rather than inside it. */
  function renderStatus(status) {
    if (status.disputed !== true) return;
    var windows = Array.isArray(status.windows) ? status.windows : [];

    A.showById("disputed", true);
    A.setTextById("state-label", "Receipt for a completed job, disputed");

    var since = windows.length > 0 ? A.readableDate(windows[0].since) : null;
    A.setTextById(
      "disputed-detail",
      since === null
        ? "The operator reported the signing key compromised. The work and the record are unchanged; whether to trust the signature is your call."
        : "The operator reported the signing key compromised, covering work signed from " + since +
          " onward. The work and the record are unchanged; whether to trust the signature is your call."
    );
  }

  function appendBold(node, text) {
    var b = document.createElement("b");
    b.textContent = text;
    node.appendChild(b);
  }

  function setHref(id, href) {
    var node = A.el(id);
    if (node) node.setAttribute("href", href);
  }

  /* A machine-checkable value and its copy control. An absent value renders
     as "not recorded" with the copy control removed, because a button that
     copies an empty string is a control that lies about having something. */
  function setPair(id, value) {
    var node = A.el(id);
    var btn = A.el(id + "-copy");
    if (!node) return;
    if (typeof value === "string" && value !== "") {
      A.setText(node, value);
      if (btn) btn.setAttribute("data-copy", value);
      return;
    }
    A.setText(node, "not recorded");
    if (btn) btn.hidden = true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
