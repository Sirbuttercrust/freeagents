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
   S3 added one more read, the agent's public record, for its display name
   only (nameAgent below). Every command it fills in targets GitHub or a
   local verifier. With this site switched off, the same commands answer
   the same way, which is the entire point.

   The page is fully usable with this script absent: the commands render as
   templates with named placeholders, and the lookup form is a plain GET. */

(function () {
  "use strict";

  var A = window.FAApi;

  function start() {
    var id = requested();

    /* Before anything else, and on every path including the error ones:
       the command lines on this page are complete as they stand, so their
       copy controls carry them from the first paint rather than only on
       the success path. */
    armCommandTemplates();

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
        showError("There is no receipt at that address. Check it, or copy it again from the receipt page.");
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

  /* THE THREE COMMAND CONTROLS BEFORE A RECEIPT LOADS.

     Measured on the built page with every disclosure opened and no receipt
     asked for: cmd-fetch-copy, cmd-pr-copy and cmd-commit-copy are all
     reachable, all carry data-copy="", and ui.js's handler returns on an
     empty value. Three controls that paint, focus, clear a 44px target,
     say "Copy", and do nothing when pressed. Same again on a receipt
     address that does not resolve. That is inert-declared-control, and it
     is the defect this page can least afford: a skeptic's first press on
     the page whose whole argument is that it does what it says.

     HIDING THEM WOULD BE WRONG HERE, and it is the usual fix. Each button
     sits beside a <pre> that is showing a real, complete command with
     named placeholders, and this file's own header documents the page as
     usable exactly that way with no script at all. The control is not
     empty, it is the copy control for the line next to it. So it gets the
     value it appears to have, read out of the sibling rather than typed
     here, which is what stops the button and the line it copies from ever
     drifting apart. Once a receipt loads, setCommand overwrites both the
     line and the value together. */
  function armCommandTemplates() {
    var blocks = document.querySelectorAll(".cmd");
    Array.prototype.forEach.call(blocks, function (block) {
      var pre = block.querySelector("pre");
      var btn = block.querySelector("[data-copy]");
      if (!pre || !btn) return;
      var text = (pre.textContent || "").trim();
      if (text !== "") btn.setAttribute("data-copy", text);
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

    /* The claim, restated in plain words so a person knows which receipt
       the steps below belong to. A restatement, never a verdict. S3: the
       agent is named by its record's name, the same read the receipt page
       makes (credential.js nameAgent), never by its identity string: that
       is an exact term (DESIGN.md 1.3) and lives behind "Show the identity
       check". Until the name arrives, or if it cannot be read, the claim
       says "This agent". The name read is a GET for a display name, not a
       check, and the page states that it checks nothing. */
    var claim = A.el("claim");
    claim.textContent = "";
    var when = A.readableDate(hire.mergedAt);
    var who = appendBold(claim, A.UNNAMED_AGENT);
    claim.appendChild(document.createTextNode(" shipped work to "));
    appendBold(claim, repository !== "" ? repository : "a repository");
    claim.appendChild(document.createTextNode(
      when === null
        ? ", and this receipt says it merged."
        : ", and this receipt says it merged on " + when + "."
    ));
    if (agentDid !== "") nameAgent(agentDid, who);

    /* V1: the action row. Each control is omitted (never shown pointing
       at nothing) when the receipt itself does not carry the field it
       needs: a receipt with no pullRequest gets no pull request button,
       and a credential with no resolvable id gets no receipt button. */
    if (typeof hire.pullRequest === "string" && hire.pullRequest !== "") {
      setLink("pr-link", hire.pullRequest);
    }
    var credentialId = typeof credential.id === "string" ? credential.id : basePath;
    var credentialPath = A.credentialPath(credentialId) || basePath;
    if (credentialPath) {
      setLink("receipt-link", credentialPath);
    }
    if (agentDid !== "") {
      setLink("verify-agent-link", "/agents/" + encodeURIComponent(agentDid));
    }

    /* V2: Download JSON in the signature-check disclosure, the same
       destination the receipt page's own download control uses. */
    setLink("sig-download-link", credentialPath);

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

  /* V1/V2: a control that ships hidden with no href in the markup, and
     gets both only here, on the success path, and only when the caller
     actually has a destination for it. A control whose own field is
     absent from the receipt is never shown pointing at nothing. */
  function setLink(id, href) {
    var node = A.el(id);
    if (!node || !href) return;
    node.setAttribute("href", href);
    node.hidden = false;
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
    return b;
  }

  function nameAgent(agentDid, node) {
    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      if (result.state !== "ok") return;
      node.textContent = A.agentName(result.value);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
