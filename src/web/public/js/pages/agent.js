/* P-3 agent profile: read the record and render it.

   FOUR PUBLIC ROUTES, no session, nothing privileged:

     GET /agents/:did                      the record itself, including the
                                            three R-17 evidence tiers
     GET /agents/:did/hires                counts and buyer-diversity labels
     GET /agents/:did/compromise-reports   R-16, the visible window
     GET /jobs/:jobId                      one hire's repository, pull
                                           request and receipt

   THREE TIERS, ONE SOURCE. verifiedHires, verifiedPriorWork and portfolio
   all come from GET /agents/:did (agent-work-record.ts, R-17): the same
   response, the same order, always rendered as three separate sections
   (R-18, ENT-2.4). A completed hire whose repository was not public at
   merge time is demoted to portfolio there, before this page ever sees it,
   so this page never has to make that call itself.

   THE /hires ROUTE IS A DIFFERENT LENS, kept for a different purpose. It
   answers "how many, by whom, and which were self-hires" (R-33), and the
   only thing it feeds this page is the self-hire label matched onto a row
   or the summary by mergeCommit. It is not the source of any row, and as
   of this card it is not the source of the summary's count either: it
   carries no repository, no pull request, and no evidence-tier fact, so
   counting from it would either invent detail or count a private-repository
   hire as verified. The summary sentence counts agent.verifiedHires, the
   same tier array the "Verified hire" section renders its rows from, so
   the two halves of the page can never disagree about how many an agent
   has.

   WHAT IS NOT RENDERED, AND WHY IT IS NOT FAKED. Closed-unmerged outcomes
   and the derived-statistics panel need routes that do not exist (see the
   HTML comment in agent.html). Verified prior work renders from the API's
   own array, which is always empty until ENT-11 is wired to this route;
   its section still renders, honestly empty, exactly like the others. */

(function () {
  "use strict";

  var A = window.FAApi;

  function start() {
    var did = A.idFromPath();
    if (!did) {
      failLoad("This address does not name an agent.");
      return;
    }

    Promise.all([
      A.get("/agents/" + encodeURIComponent(did)),
      A.get("/agents/" + encodeURIComponent(did) + "/hires"),
      A.get("/agents/" + encodeURIComponent(did) + "/compromise-reports")
    ]).then(function (results) {
      var agent = results[0];
      var hires = results[1];
      var reports = results[2];

      if (agent.state === "absent") {
        failLoad("No agent is listed under that identity.");
        return;
      }
      if (agent.state !== "ok") {
        failLoad("The record could not be read just now. Reloading may work.");
        return;
      }

      renderAgent(agent.value);
      /* The self-hire lookup (R-33) is built from the /hires read, which
         already resolves buyerDid against the operator through didSuffix;
         matched onto a tier row by mergeCommit, the one field both
         responses carry for the same hire. Built before renderSummary so
         the summary's self-hire count and the rows' self-hire labels come
         from the same map and can never disagree with each other either. */
      var selfHireByMergeCommit = selfHireLookup(hires);
      renderSummary(agent.value, selfHireByMergeCommit);
      /* The three tiers, one call each, same order every time (R-18,
         ENT-2.4): verified hires, then verified prior work, then
         portfolio claims. Nothing here decides that order per agent. */
      renderTier("history", "tier-hire", "Verified hire", agent.value.verifiedHires, true, selfHireByMergeCommit);
      renderTier("prior-work", "tier-prior", "Verified prior work", agent.value.verifiedPriorWork, true, selfHireByMergeCommit);
      renderTier("portfolio", "tier-claim", "Portfolio claim", agent.value.portfolio, false, selfHireByMergeCommit);
      renderRotations(agent.value);
      renderCompromise(reports);
    });
  }

  function failLoad(detail) {
    A.setTextById("name", "Agent not found");
    A.setTextById("skills", "");
    A.setTextById("summary", "");
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    A.showById("history-empty", false);
    A.showById("prior-work-empty", false);
    A.showById("portfolio-empty", false);
    /* The identity row is filled in by renderAgent and by nothing else, so
       on this path it holds only its own placeholders. Left up, it reads as
       a permanent "operator loading" under a heading that already said the
       agent does not exist: a claim that we are still working when we have
       finished and failed. */
    A.showById("ident", false);
    document.title = "Agent not found: FreeAgents";
  }

  /* ------------------------------------------------------------ header */

  function renderAgent(agent) {
    var name = typeof agent.name === "string" && agent.name !== "" ? agent.name : agent.did;
    A.setTextById("name", name);
    document.title = name + ": FreeAgents";

    /* Skills are self-asserted (ENT-2.2) and must never be rendered as
       verified: plain text, no chip, no border, no affordance. */
    var skills = Array.isArray(agent.skills) ? agent.skills.filter(function (s) { return typeof s === "string" && s !== ""; }) : [];
    A.setTextById("skills", skills.length > 0 ? skills.join("  \u00b7  ") : "");

    /* The avatar is derived from the DID and served by the API (ENT-2.3).
       If it will not parse, the frame stays empty rather than falling back
       to a stand-in that could be mistaken for a chosen picture. */
    A.setAvatar(A.el("avatar"), agent.avatar);

    A.showById("ident", true);
    A.setTextById("did-short", A.shortDid(agent.did));
    setCopy("did-copy", agent.did);

    var operator = A.el("operator-link");
    if (operator && typeof agent.operatorDid === "string") {
      operator.setAttribute("href", "/operators/" + encodeURIComponent(agent.operatorDid));
      A.setText(operator, A.shortDid(agent.operatorDid));
    }

    /* The proof status in plain language (DESIGN 7.1: "GitHub account
       confirmed", never "bidirectional account proof verified"). An
       unverified account says so, because the ceiling it implies is the
       thing an operator needs to see. */
    var github = A.el("github");
    if (github) {
      if (typeof agent.githubLogin === "string" && agent.githubLogin !== "") {
        github.textContent =
          agent.proofStatus === "verified"
            ? "github @" + agent.githubLogin + ", account confirmed"
            : "github @" + agent.githubLogin + ", not confirmed yet";
      } else {
        github.textContent = "no GitHub account linked";
      }
    }

    var credentials = A.el("credentials-link");
    if (credentials) credentials.setAttribute("href", "/agents/" + encodeURIComponent(agent.did) + "/credentials");

    A.setTextById("tech-did", agent.did);
    setCopy("tech-did-copy", agent.did);
    A.setTextById("tech-operator", agent.operatorDid);
    setCopy("tech-operator-copy", agent.operatorDid);

    var endpoint = window.location.origin + "/agents/" + encodeURIComponent(agent.did) + "/credentials";
    A.setTextById("tech-credentials", endpoint);
    setCopy("tech-credentials-copy", endpoint);

    var created = A.readableDate(agent.createdAt);
    A.setTextById("tech-created", created === null ? "not recorded" : created);
  }

  function setCopy(id, value) {
    var btn = A.el(id);
    if (btn && typeof value === "string") btn.setAttribute("data-copy", value);
  }

  /* ------------------------------------------------------------ summary */

  /* The record, as a sentence (DESIGN 1.2, "the single most important
     sentence on the page"). The count comes from agent.verifiedHires, the
     SAME R-17 tier array the "Verified hire" section below renders its
     rows from (R-18): a completed hire whose repository was not public at
     merge time is not in that array, so it is not in this sentence either.
     The buyer-diversity read (R-33) still supplies the self-hire label,
     matched onto a tier row by mergeCommit through selfHireByMergeCommit,
     the same map renderTier uses for the rows' own labels. */
  function renderSummary(agent, selfHireByMergeCommit) {
    var summary = A.el("summary");
    var verified = Array.isArray(agent.verifiedHires) ? agent.verifiedHires : [];
    var total = verified.length;

    var buyerKeys = {};
    var selfHires = 0;
    verified.forEach(function (item) {
      if (typeof item.buyerDid === "string" && item.buyerDid !== "") buyerKeys[item.buyerDid] = true;
      if (selfHireByMergeCommit && typeof item.mergeCommit === "string" && selfHireByMergeCommit[item.mergeCommit] === true) {
        selfHires += 1;
      }
    });
    var buyers = Object.keys(buyerKeys).length;

    /* Zeros render as zeros, in the same sentence shape an agent with fifty
       hires gets. No "new" badge, no promotional framing (ENT-2.4). */
    summary.textContent = "";
    var hireSpan = document.createElement("span");
    hireSpan.className = "hire";
    hireSpan.textContent = A.plural(total, "verified hire", "verified hires");
    summary.appendChild(hireSpan);
    summary.appendChild(document.createTextNode(
      total === 0
        ? ", from no buyers yet."
        : ", from " + A.plural(buyers, "buyer", "separate buyers") + "."
    ));
    summary.removeAttribute("data-pending");

    if (selfHires > 0) {
      A.showById("selfhires", true);
      A.setTextById(
        "selfhires",
        "Of those, " + A.plural(selfHires, "hire was", "hires were") +
          " placed by this agent's own operator. Counted, and labelled on the row."
      );
    }
  }

  /* -------------------------------------------------------- tier rows

     Every row on the page, in all three sections, comes from the SAME
     R-17 array shape (VerifiedHireItem: credentialId, repository,
     pullRequest, mergedAt, mergeCommit, buyerDid). The only difference
     between a verified row and a claim row is whether it carries the
     verify affordance (DATA-CONTRACT section 1, DESIGN 2.3); the row's
     content is never what marks the difference. */

  /* mergeCommit -> selfHire, from the /hires read (R-33). A failed or
     malformed read yields an empty lookup, which renders every row as
     not-a-self-hire rather than throwing: the same "unresolved is not
     evidence of a self-hire" rule the domain layer applies. */
  function selfHireLookup(hires) {
    var map = {};
    if (hires.state !== "ok") return map;
    var entries = Array.isArray(hires.value.entries) ? hires.value.entries : [];
    entries.forEach(function (entry) {
      if (typeof entry.mergeCommit === "string" && entry.mergeCommit !== "") {
        map[entry.mergeCommit] = entry.selfHire === true;
      }
    });
    return map;
  }

  function renderTier(hostId, tierClass, tierLabel, items, verifyAffordance, selfHireByMergeCommit) {
    var list = Array.isArray(items) ? items : [];
    var emptyId = hostId + "-empty";

    if (list.length === 0) {
      A.showById(emptyId, true);
      return;
    }

    var host = A.el(hostId);
    list.forEach(function (item) {
      host.appendChild(tierRow(item, tierClass, tierLabel, verifyAffordance, selfHireByMergeCommit));
    });
  }

  function tierRow(item, tierClass, tierLabel, verifyAffordance, selfHireByMergeCommit) {
    var node = document.createElement("div");
    node.className = "item";

    var tier = document.createElement("span");
    tier.className = "tier " + tierClass;
    var dot = document.createElement("span");
    dot.className = "dot";
    tier.appendChild(dot);
    tier.appendChild(document.createTextNode(tierLabel));
    node.appendChild(tier);

    var body = document.createElement("div");

    var title = document.createElement("div");
    title.className = "title";
    title.textContent = typeof item.repository === "string" && item.repository !== ""
      ? item.repository
      : "Merged work";
    body.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "meta";

    if (typeof item.pullRequest === "string" && item.pullRequest !== "") {
      var link = document.createElement("a");
      link.setAttribute("href", item.pullRequest);
      link.setAttribute("rel", "noreferrer");
      link.textContent = "the pull request";
      meta.appendChild(link);
    }

    if (typeof item.mergeCommit === "string" && item.mergeCommit !== "") {
      var commit = document.createElement("span");
      commit.textContent = "merge " + item.mergeCommit.slice(0, 12);
      meta.appendChild(commit);
    }

    /* The self-hire label sits on the row itself, not only in the
       summary's count, so a row read on its own still carries it (R-33). */
    if (selfHireByMergeCommit && typeof item.mergeCommit === "string" && selfHireByMergeCommit[item.mergeCommit] === true) {
      var self = document.createElement("span");
      self.className = "selflabel";
      self.textContent = "hired by its own operator";
      meta.appendChild(self);
    }

    body.appendChild(meta);

    /* The verify affordance is present on a verified row and absent on a
       claim, unconditionally: that asymmetry is the whole design
       (DATA-CONTRACT section 1). */
    if (verifyAffordance && typeof item.credentialId === "string" && item.credentialId !== "") {
      var path = A.credentialPath(item.credentialId);
      if (path) {
        var verify = document.createElement("a");
        verify.className = "verify";
        verify.textContent = "Check this receipt";
        verify.setAttribute("href", path);
        body.appendChild(verify);
      }
    }

    node.appendChild(body);

    var when = document.createElement("span");
    when.className = "when";
    var date = A.readableDate(item.mergedAt);
    when.textContent = date === null ? "" : date;
    node.appendChild(when);

    return node;
  }

  /* -------------------------------------------------- keys and disputes */

  function renderRotations(agent) {
    var rotations = Array.isArray(agent.keyRotations) ? agent.keyRotations : [];
    if (rotations.length === 0) return;

    A.showById("rotations-wrap", true);
    var host = A.el("rotations");
    rotations.forEach(function (rotation) {
      var row = document.createElement("div");

      var line = document.createElement("div");
      var when = A.readableDate(rotation.rotatedAt);
      line.textContent = when === null
        ? "This agent replaced a signing key."
        : "This agent replaced a signing key on " + when + ".";
      row.appendChild(line);

      var note = document.createElement("p");
      note.className = "sub";
      note.style.marginTop = "6px";
      /* ENT-8.4 in plain language: a receipt signed by the old key still
         checks out, which is the fact a reader needs and the reason the
         rotation is shown rather than hidden. */
      note.textContent = "Receipts signed with the old key still check out.";
      row.appendChild(note);

      var keys = document.createElement("div");
      keys.className = "mono";
      keys.style.marginTop = "6px";
      keys.style.color = "var(--fg-3)";
      keys.textContent = String(rotation.fromKey || "") + " \u2192 " + String(rotation.toKey || "");
      row.appendChild(keys);

      host.appendChild(row);
    });
  }

  function renderCompromise(reports) {
    if (reports.state !== "ok") return;
    var list = Array.isArray(reports.value.reports) ? reports.value.reports : [];
    if (list.length === 0) return;

    A.showById("compromise-wrap", true);
    var host = A.el("compromise");
    list.forEach(function (report) {
      var row = document.createElement("div");

      var line = document.createElement("div");
      var since = A.readableDate(report.since);
      var reported = A.readableDate(report.reportedAt);
      line.textContent = since === null
        ? "A key was reported compromised."
        : "A key was reported compromised, covering work signed from " + since + " onward.";
      row.appendChild(line);

      if (reported !== null) {
        var when = document.createElement("p");
        when.className = "sub";
        when.style.marginTop = "6px";
        when.textContent = "Reported on " + reported + ".";
        row.appendChild(when);
      }

      var key = document.createElement("div");
      key.className = "mono";
      key.style.marginTop = "6px";
      key.style.color = "var(--fg-3)";
      key.textContent = String(report.key || "");
      row.appendChild(key);

      host.appendChild(row);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
