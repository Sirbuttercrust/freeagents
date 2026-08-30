/* P-6 verify: fill the check instructions in with a real receipt's values.

   WHAT THIS FILE DOES NOT DO, and the page says so out loud: it runs no
   check. There is no code path here that decides a signature is valid, and
   none may be added. A "Verified" state this page computed would be
   indistinguishable, to a visitor, from one our server asserted, and that
   would make this the least trustworthy page on the site rather than the
   most (MISSION invariant 2, R-14).

   What it does: reads one public credential document so the commands below
   carry the real repository, pull request number, merge commit and keys,
   and a person copies something that runs instead of typing values by hand.
   Every command it fills in targets GitHub or a local verifier. With this
   site switched off, the same commands answer the same way, which is the
   entire point.

   The page is fully usable with this script absent: the commands render as
   templates with named placeholders, and the lookup form is a plain GET. */

(function () {
  "use strict";

  var A = window.FAApi;

  function start() {
    var id = requested();

    if (!id) {
      A.showById("lookup", true);
      wireLookup();
      return;
    }

    var base = "/v1/credentials/" + encodeURIComponent(id);
    A.getLinkedData(base).then(function (result) {
      if (result.state === "absent") {
        A.showById("lookup", true);
        wireLookup();
        showError("There is no receipt at that address. Check the id, or paste the full address from the receipt page.");
        return;
      }
      if (result.state !== "ok") {
        A.showById("lookup", true);
        wireLookup();
        showError("The receipt could not be read just now. Every check below still works if you have the document already.");
        return;
      }
      render(result.value, base);
    });
  }

  /* The receipt to describe, from the query string. Accepts a bare job id
     or a full receipt address, because a person pastes whichever they were
     handed. */
  function requested() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get("credential");
    if (!raw) return "";
    return A.credentialKey(raw.trim());
  }

  function wireLookup() {
    var form = A.el("lookup");
    if (!form) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var field = A.el("credential-id");
      var value = field && typeof field.value === "string" ? field.value.trim() : "";
      if (value === "") return;
      window.location.search = "?credential=" + encodeURIComponent(A.credentialKey(value));
    });
  }

  function showError(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  function render(credential, basePath) {
    var subject = credential.credentialSubject || {};
    var hire = subject.hire || {};
    var agentDid = typeof subject.id === "string" ? subject.id : "";
    var repository = typeof hire.repository === "string" ? hire.repository : "";

    A.showById("loaded", true);

    /* The claim, restated in plain language so a person knows which receipt
       the commands below belong to. This is a restatement, never a
       verdict. */
    var claim = A.el("claim");
    claim.textContent = "";
    var when = A.readableDate(hire.mergedAt);
    appendBold(claim, A.shortDid(agentDid));
    claim.appendChild(document.createTextNode(" shipped work to "));
    appendBold(claim, repository !== "" ? repository : "a repository");
    claim.appendChild(document.createTextNode(
      when === null
        ? ", and this receipt says it merged. Here is how to confirm that without us."
        : ", and this receipt says it merged on " + when + ". Here is how to confirm that without us."
    ));

    /* Check one: fetch the exact document a verifier reads. The absolute
       URL is built from this origin, so the command works behind any
       hostname or proxy this deployment sits under. */
    var fetchCmd = "curl -sH 'Accept: application/ld+json' " + window.location.origin + basePath;
    setCommand("cmd-fetch", fetchCmd);
    setPair("issuer", typeof credential.issuer === "string" ? credential.issuer : "");

    /* Check two: the two GitHub calls, with the real owner, repository,
       pull request number and merge commit filled in. A pull request URL
       that does not parse leaves the template in place rather than
       producing a command that cannot run. */
    var pr = parsePullRequest(hire.pullRequest);
    var mergeCommit = typeof hire.mergeCommit === "string" ? hire.mergeCommit : "";

    if (pr !== null) {
      setCommand("cmd-pr", "curl -s https://api.github.com/repos/" + pr.owner + "/" + pr.repo + "/pulls/" + pr.number);
      if (mergeCommit !== "") {
        setCommand("cmd-commit", "curl -s https://api.github.com/repos/" + pr.owner + "/" + pr.repo + "/commits/" + mergeCommit);
      }
    }

    /* Check three: the two identities that must agree. */
    setPair("agent-did", agentDid);
    setPair("signer", typeof hire.signedBy === "string" ? hire.signedBy : "");

    document.title = "Check this receipt yourself: FreeAgents";
  }

  /* owner, repo and number from a GitHub pull request URL. Returns null on
     anything that is not one, so a caller leaves its template alone rather
     than assembling a command from parts it does not have. */
  function parsePullRequest(url) {
    if (typeof url !== "string" || url === "") return null;
    var match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: match[3] };
  }

  function setCommand(id, command) {
    var node = A.el(id);
    if (node) node.textContent = command;
    var btn = A.el(id + "-copy");
    if (btn) btn.setAttribute("data-copy", command);
  }

  function setPair(id, value) {
    var node = A.el(id);
    var btn = A.el(id + "-copy");
    if (!node) return;
    if (typeof value === "string" && value !== "") {
      A.setText(node, value);
      if (btn) {
        btn.setAttribute("data-copy", value);
        btn.hidden = false;
      }
      return;
    }
    A.setText(node, "not recorded on this receipt");
  }

  function appendBold(node, text) {
    var b = document.createElement("b");
    b.textContent = text;
    node.appendChild(b);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
