/* P-4 operator profile: read the record and render it.

   The identity strip fetches GET /operators/:did (did, githubLogin,
   createdAt), pinned by tests/api/operator-invariant2.test.ts. The roster
   below it fetches GET /operators/:did/agents (R-19, D4): every agent
   delegated from this operator, as browse-shaped rows, plus a per-tier
   aggregate.

   ANCHOR: an operator page is the sum of who they run, never a score for
   the operator. The roster rows are the page; the aggregate is a summary
   line under them, never a headline that buries the agents it came from.

   ONE LAYOUT, NO BRANCHING (D4). A roster table that gains sort and filter
   controls only above ten agents; a single-agent operator sees the same
   table with one row. There is no second layout for the small case.

   SORT AND FILTER ARE QUERY PARAMETERS, browse.js's own mechanism (Proof,
   run 76, defect inert-control-affordance): operating either control reads
   its value and navigates to /operators/<did>?sort=...&skill=..., the same
   round-trip-through-the-URL browse.js uses for #sort and #skill, so the
   roster stays bookmarkable and the server (GET /operators/:did/agents) is
   the one place that decides what a sort or filter value means. There is
   no second, client-only sort or filter rule for these eleven-plus rows. */

(function () {
  "use strict";

  var A = window.FAApi;
  var ROSTER_CONTROL_THRESHOLD = 10;

  function currentParams() {
    return new URLSearchParams(window.location.search);
  }

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
      loadRoster(did);
    });
  }

  function failLoad(detail) {
    A.setTextById("name", "Operator not found");
    A.setTextById("lede", "");
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    /* Same rule as the agent page: the identity row is filled in by render
       and by nothing else, so on this path it holds placeholders only. */
    A.showById("ident", false);
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

  /* --------------------------------------------------------- the roster */

  function loadRoster(did) {
    var params = currentParams();
    var sort = params.get("sort") || "";
    var skill = params.get("skill") || "";
    wireControls(did, sort, skill);

    var query = "/operators/" + encodeURIComponent(did) + "/agents";
    var qp = new URLSearchParams();
    if (sort) qp.set("sort", sort);
    if (skill) qp.set("skill", skill);
    var qs = qp.toString();
    if (qs) query += "?" + qs;

    A.get(query).then(function (result) {
      if (result.state !== "ok") {
        renderRosterFailure();
        return;
      }
      renderRoster(result.value);
    });
  }

  /* Wires the sort select and skill filter the same way browse.js wires
     #sort and #skill: reading the control's current value, navigating to
     /operators/<did>?sort=...&skill=..., and letting the next page load
     read the query string back out (currentParams, above). Operating a
     control never rewrites the DOM in place; it round-trips through the
     URL, the one mechanism this platform uses for a bookmarkable listing. */
  function wireControls(did, sort, skill) {
    var sortSelect = A.el("roster-sort");
    if (sortSelect) {
      sortSelect.value = sort || "verified-hires";
      sortSelect.addEventListener("change", function () {
        navigateRoster(did, sortSelect.value, skillInput ? skillInput.value : skill);
      });
    }

    var skillInput = A.el("roster-skill");
    if (skillInput) {
      skillInput.value = skill;
      skillInput.addEventListener("change", function () {
        navigateRoster(did, sortSelect ? sortSelect.value : sort, skillInput.value);
      });
      skillInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") navigateRoster(did, sortSelect ? sortSelect.value : sort, skillInput.value);
      });
    }
  }

  function navigateRoster(did, sort, skill) {
    var qp = new URLSearchParams();
    if (sort) qp.set("sort", sort);
    if (skill && skill.trim() !== "") qp.set("skill", skill.trim());
    var qs = qp.toString();
    window.location.href = "/operators/" + encodeURIComponent(did) + (qs ? "?" + qs : "");
  }

  function renderRosterFailure() {
    A.showById("roster-empty", true);
    A.setTextById("roster-summary", "");
    var empty = A.el("roster-empty");
    if (empty) {
      var b = empty.querySelector("b");
      var p = empty.querySelector(".sub");
      if (b) b.textContent = "The roster could not be read just now.";
      if (p) p.textContent = "Reloading may work.";
    }
  }

  function renderRoster(body) {
    var agents = Array.isArray(body.agents) ? body.agents : [];
    var host = A.el("roster-cards");
    if (host) {
      host.textContent = "";
      agents.forEach(function (agent) {
        host.appendChild(rosterRow(agent));
      });
    }

    A.showById("roster-empty", agents.length === 0);

    /* D4: controls appear only above ten agents. Below that the table
       renders plain, one layout either way. */
    A.showById("roster-controls", agents.length > ROSTER_CONTROL_THRESHOLD);

    renderSummary(body.aggregate);
  }

  function renderSummary(aggregate) {
    var totals = aggregate && typeof aggregate === "object" ? aggregate : {};
    var hires = numberOr(totals.totalVerifiedHireCount);
    var prior = numberOr(totals.totalVerifiedPriorWorkCount);
    var portfolio = numberOr(totals.totalPortfolioCount);

    /* Three separately labelled totals, one sentence, never combined into
       one number (MISSION invariant 5). This is a summary of the rows
       above it, not a verdict on the operator. */
    A.setTextById(
      "roster-summary",
      "Across every agent listed here: " +
        A.plural(hires, "verified hire", "verified hires") + ", " +
        A.plural(prior, "verified prior work", "verified prior work") + ", " +
        A.plural(portfolio, "portfolio claim", "portfolio claims") + "."
    );
  }

  function rosterRow(agent) {
    var row = document.createElement("div");
    row.className = "card-row";
    row.setAttribute("data-agent-row", agent.did);

    var body = document.createElement("div");

    var name = document.createElement("a");
    name.className = "name-link";
    name.setAttribute("href", "/agents/" + encodeURIComponent(agent.did));
    name.textContent = typeof agent.name === "string" && agent.name !== "" ? agent.name : A.shortDid(agent.did);
    body.appendChild(name);

    /* THE EVIDENCE ROW. Same three separately labelled counts a browse
       card carries, read the same way (src/domain/browse.ts's toBrowseCard,
       shared by both the browse route and this roster route), so a row
       here and the same agent's browse card can never drift apart. */
    var evidence = document.createElement("div");
    evidence.className = "evidence-row";

    var hireSpan = document.createElement("span");
    var hireCount = document.createElement("span");
    hireCount.className = "count";
    hireCount.textContent = A.plural(numberOr(agent.verifiedHireCount), "verified hire", "verified hires");
    hireSpan.appendChild(hireCount);
    if (numberOr(agent.verifiedHireCount) > 0) {
      var buyers = document.createElement("span");
      buyers.className = "buyers";
      buyers.textContent = ", " + A.plural(numberOr(agent.buyerCount), "buyer", "buyers");
      hireSpan.appendChild(buyers);
    }
    evidence.appendChild(hireSpan);

    var priorSpan = document.createElement("span");
    priorSpan.textContent = A.plural(numberOr(agent.verifiedPriorWorkCount), "verified prior work", "verified prior work");
    evidence.appendChild(priorSpan);

    var portfolioSpan = document.createElement("span");
    portfolioSpan.textContent = A.plural(numberOr(agent.portfolioCount), "portfolio claim", "portfolio claims");
    evidence.appendChild(portfolioSpan);

    body.appendChild(evidence);

    var skills = Array.isArray(agent.skills) ? agent.skills.filter(function (s) { return typeof s === "string" && s !== ""; }) : [];
    if (skills.length > 0) {
      var skillsRow = document.createElement("div");
      skillsRow.className = "skills";
      skillsRow.textContent = skills.join("  \u00b7  ");
      body.appendChild(skillsRow);
    }

    row.appendChild(body);
    return row;
  }

  function numberOr(value) {
    return typeof value === "number" && !isNaN(value) ? value : 0;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
