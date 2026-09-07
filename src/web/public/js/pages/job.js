/* P8f job: read one hire and render it.

   ONE PUBLIC ROUTE, no session: GET /jobs/:jobId, src/api/app.ts's
   jobProjection. THREE OUTCOMES, as api.js's get() distinguishes them:
   the record, absent (404), unreachable. Never rendered as an empty
   record.

   THE SCOPE FENCE (PLAN.md, the operator 2026-09-07): the platform
   confirms facts about staged work and never runs, scores, or reviews an
   agent's code. Every dated row is phrased as observed, never as a
   party's claim and never a verdict on quality.

   EVERYTHING THROUGH textContent: the brief is buyer-written prose and
   the repository is a buyer-supplied string, both content, never markup
   (api.js's own header rule). */

(function () {
  "use strict";

  var A = window.FAApi;

  // The plain sentence for every one of the fourteen JobStatus values
  // (prisma/schema.prisma:41). An unmapped status renders the raw value.
  var STATE_SENTENCES = {
    draft: "This hire is a draft. The buyer has written a brief and nothing has been agreed yet.",
    proposed: "The agent has proposed acceptance criteria and a price. Both sides are still agreeing terms.",
    confirmed: "Both sides have agreed the criteria and the price. The agreement is final and work has not yet been staged.",
    staged: "The agent has staged its work. It is unpaid and unseen by the public until the buyer settles the balance.",
    redo_requested: "The buyer has asked for a redo on the staged work. The operator has not yet answered.",
    submitted: "A pull request is open. The platform is watching for it to merge or close.",
    completed: "The work merged. This hire is complete.",
    declined: "This hire was declined before work was staged.",
    closed_unmerged: "The pull request was closed without merging.",
    stale: "The pull request has sat open past the platform's staleness window.",
    withdrawn: "The buyer withdrew this hire.",
    staged_declined: "The buyer saw the staged work and declined it.",
    closed_unpaid: "The staged work was never paid for within the window, and the hire closed unpaid.",
    expired_unstaged: "The agreement was confirmed but no work was ever staged within the window, and the hire expired.",
    deemed_completed: "The pull request was neither merged nor closed within the review window, so the hire was deemed complete.",
    cited_closed: "The buyer closed this hire after paying, citing a reason. No money returns."
  };

  function start() {
    var id = A.idFromPath();
    if (!id) {
      failLoad("This address does not name a hire.");
      return;
    }
    A.get("/jobs/" + encodeURIComponent(id)).then(function (result) {
      if (result.state === "absent") {
        failLoad("There is no hire at that address.");
        return;
      }
      if (result.state !== "ok") {
        failLoad("The record could not be loaded just now. Reloading may work.");
        return;
      }
      render(result.value);
    });
  }

  function failLoad(detail) {
    A.setTextById("state-label", "This hire was not found");
    A.setTextById("claim", "");
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    document.title = "Hire not found: FreeAgents";
  }

  function render(job) {
    var status = typeof job.status === "string" ? job.status : "";
    var sentence = Object.prototype.hasOwnProperty.call(STATE_SENTENCES, status) ? STATE_SENTENCES[status] : status;
    A.setTextById("state-label", sentence);

    var repository = typeof job.repository === "string" && job.repository !== "" ? job.repository : "a repository";
    var brief = typeof job.brief === "string" ? job.brief : "";

    var claim = A.el("claim");
    if (claim) {
      claim.textContent = "";
      var repoSpan = document.createElement("b");
      repoSpan.textContent = repository;
      claim.appendChild(document.createTextNode("A hire against "));
      claim.appendChild(repoSpan);
      claim.appendChild(document.createTextNode(brief === "" ? "." : ": " + brief));
      claim.removeAttribute("data-pending");
    }
    document.title = "Hire against " + repository + ": FreeAgents";

    renderWho(job);
    renderPrice(job);
    renderHistory(job);
    renderClose(job);
    renderCredential(job);
    renderTechnical(job);
  }

  function renderWho(job) {
    A.showById("who-section", true);
    A.setTextById("fact-buyer", typeof job.buyerDid === "string" ? A.shortDid(job.buyerDid) : "not recorded");

    var agentCell = A.el("fact-agent");
    if (agentCell && typeof job.agentDid === "string" && job.agentDid !== "") {
      var link = document.createElement("a");
      link.setAttribute("href", "/agents/" + encodeURIComponent(job.agentDid));
      link.style.textDecoration = "underline";
      link.textContent = A.shortDid(job.agentDid);
      agentCell.textContent = "";
      agentCell.appendChild(link);
    } else {
      A.setText(agentCell, "not recorded");
    }
  }

  // Present only once the agent has proposed one. Never a suggested
  // price or a range (SITEMAP P-10).
  function renderPrice(job) {
    var price = job.price && typeof job.price === "object" ? job.price : null;
    if (price === null) return;
    A.showById("price-section", true);

    var amount = typeof price.priceUsd === "string" ? "$" + price.priceUsd : "not recorded";
    var rail = typeof price.rail === "string" ? " (" + price.rail + ")" : "";
    A.setTextById("fact-price", amount + rail);
    A.setTextById("fact-deposit", typeof price.depositPercent === "number" ? price.depositPercent + "%" : "not recorded");
    A.setTextById("fact-window", typeof price.deliveryWindowDays === "number" ? A.plural(price.deliveryWindowDays, "day", "days") : "not recorded");
    A.setTextById("fact-redo", typeof price.redoAllowance === "number" ? A.plural(price.redoAllowance, "redo", "redos") : "not recorded");

    var acceptedByBuyer = price.acceptedByBuyer === true;
    var acceptedByAgent = price.acceptedByAgent === true;
    var accepted = "neither party yet";
    if (acceptedByBuyer && acceptedByAgent) accepted = "both the buyer and the agent";
    else if (acceptedByBuyer) accepted = "the buyer only";
    else if (acceptedByAgent) accepted = "the agent only";
    A.setTextById("fact-accepted", accepted);
  }

  // The dated history, from whichever conditional groups the projection
  // carries. Absent groups are absent from this list entirely: never a
  // pending row with an empty date, an empty date reads as a fact.
  function renderHistory(job) {
    var rows = [];

    if (typeof job.createdAt === "string" && job.createdAt !== "") rows.push({ label: "Brief written", when: job.createdAt });

    var confirmedAt = typeof job.confirmedAt === "string" ? job.confirmedAt : null;
    if (confirmedAt !== null) rows.push({ label: "Agreement confirmed", when: confirmedAt });

    var stagedAt = typeof job.stagedAt === "string" ? job.stagedAt : null;
    if (stagedAt !== null) rows.push({ label: "Work staged", when: stagedAt });

    var submission = job.pullRequestUrl;
    var submittedAt = typeof job.submittedAt === "string" ? job.submittedAt : null;
    if (typeof submission === "string" && submission !== "" && submittedAt !== null) {
      rows.push({
        label: "Pull request opened",
        when: submittedAt,
        href: submission,
        note: "Opened from the agent's own fork. Only the buyer's click on GitHub merges it."
      });
    }

    var mergedAt = typeof job.mergedAt === "string" ? job.mergedAt : null;
    if (mergedAt !== null) rows.push({ label: "Merged, confirmed by checking GitHub", when: mergedAt });

    var citedClose = job.citedClose && typeof job.citedClose === "object" ? job.citedClose : null;
    if (citedClose !== null && typeof citedClose.at === "string") rows.push({ label: "Closed, cited by the buyer", when: citedClose.at });

    if (rows.length === 0) return;
    A.showById("history-section", true);
    var host = A.el("history");
    if (!host) return;
    rows.forEach(function (row) { host.appendChild(historyRow(row)); });
  }

  function historyRow(row) {
    var li = document.createElement("li");
    var dot = document.createElement("span");
    dot.className = "dot";
    li.appendChild(dot);

    var body = document.createElement("span");
    var lbl = document.createElement("span");
    lbl.className = "lbl";
    if (row.href) {
      var link = document.createElement("a");
      link.setAttribute("href", row.href);
      link.setAttribute("rel", "noreferrer");
      link.textContent = row.label;
      lbl.appendChild(link);
    } else {
      lbl.textContent = row.label;
    }
    body.appendChild(lbl);

    var when = document.createElement("span");
    when.className = "when";
    var date = A.readableDate(row.when);
    when.textContent = date === null ? "" : date;
    body.appendChild(document.createElement("br"));
    body.appendChild(when);

    if (row.note) {
      var note = document.createElement("span");
      note.className = "when";
      note.textContent = row.note;
      body.appendChild(document.createElement("br"));
      body.appendChild(note);
    }

    li.appendChild(body);
    return li;
  }

  // moneyReturned is already in the projection for exactly this reason;
  // no refund vocabulary used anywhere on this page (invariant 12).
  function renderClose(job) {
    var citedClose = job.citedClose && typeof job.citedClose === "object" ? job.citedClose : null;
    if (citedClose === null) return;
    A.showById("close-section", true);
    var reason = typeof citedClose.reasonText === "string" ? citedClose.reasonText : "";
    A.setTextById("close-detail", "The buyer closed this hire, citing: " + reason + " No money returns.");
  }

  function renderCredential(job) {
    var credential = job.credential;
    if (!credential || typeof credential !== "object") return;
    var id = typeof credential.id === "string" ? credential.id : "";
    var path = A.credentialPath(id);
    if (path === null) return;
    A.showById("credential-section", true);
    var link = A.el("credential-link");
    if (link) link.setAttribute("href", path);
  }

  function renderTechnical(job) {
    setFact("tech-id", typeof job.id === "string" ? job.id : "");
    setFact("tech-brief-hash", typeof job.briefHash === "string" ? job.briefHash : "");
    showFact("tech-spec-hash-wrap", "tech-spec-hash", job.specHash);
    showFact("tech-staged-commit-wrap", "tech-staged-commit", job.stagedCommit);
    showFact("tech-merge-commit-wrap", "tech-merge-commit", job.mergeCommit);
    showFact("tech-base-commit-wrap", "tech-base-commit", job.baseCommit);

    var stagingRepo = job.stagingRepo && typeof job.stagingRepo === "object" ? job.stagingRepo : null;
    if (stagingRepo !== null && typeof stagingRepo.owner === "string" && typeof stagingRepo.repo === "string") {
      A.showById("tech-staging-repo-wrap", true);
      setFact("tech-staging-repo", stagingRepo.owner + "/" + stagingRepo.repo);
    }
  }

  // A present-only technical fact: shown only when the field carries a
  // real value, absent (never a blank row) otherwise.
  function showFact(wrapId, valueId, value) {
    if (typeof value !== "string" || value === "") return;
    A.showById(wrapId, true);
    setFact(valueId, value);
  }

  function setFact(id, value) {
    A.setText(A.el(id), typeof value === "string" && value !== "" ? value : "not recorded");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
