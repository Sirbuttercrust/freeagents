/* P-4 operator profile, rebuilt from the design seat's wireframe (W3,
   spec/wireframe/operator.html): read the record and render it.

   The identity strip fetches GET /accounts/:did (did, githubLogin,
   createdAt), pinned by tests/api/operator-invariant2.test.ts. The roster
   below it fetches GET /accounts/:did/agents (R-19, D4): every agent
   delegated from this operator, as browse-shaped rows, plus a per-tier
   aggregate.

   ANCHOR: an operator page is the sum of who they run, never a score for
   the operator. The roster rows are the page; the aggregate is a summary
   line under them, never a headline that buries the agents it came from.
   This is a named departure from the wireframe, which places its summary
   above the roster (see the PR body).

   ONE LAYOUT, NO BRANCHING (D4). A roster table that gains sort and filter
   controls only above ten agents; a single-agent operator sees the same
   table with one row. There is no second layout for the small case.

   SORT AND FILTER ARE QUERY PARAMETERS, browse.js's own mechanism (Review
   finding, run 76, defect inert-control-affordance): operating either
   control reads its value and navigates to
   /accounts/<did>?sort=...&skill=..., the same round-trip-through-the-URL
   browse.js uses for #sort and #skill, so the roster stays bookmarkable
   and the server (GET /accounts/:did/agents) is the one place that decides
   what a sort or filter value means. There is no second, client-only sort
   or filter rule for these eleven-plus rows.

   THE ROSTER ROW (W3): the wireframe's .agent shape, a 40px round avatar,
   a name link, and a right column carrying a tier chip plus an evidence
   line, the SAME .tier/.dot vocabulary browse.js's own wireframe rebuild
   (W2) applies to a browse card, both reading the identical BrowseCard
   (src/domain/browse.ts) through the same three-way tier rule, so a row
   here and the same agent's browse card can never disagree about the
   evidence. The avatar rides the SAME per-agent read browse.js's
   loadAvatar already makes (GET /agents/:agentDid, agentProjection's
   avatar field), fired after the row is in the DOM so a slow avatar read
   never holds up the rest of the roster.

   THE DESCRIPTION LINE under a roster name (wireframe .ds): BrowseCard
   carries no description field (src/domain/browse.ts), the same gap
   browse.html's own row template comment records; there is nothing to
   render, so the slot is omitted here too rather than substituting the
   skills line for it silently. */

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

    A.get("/accounts/" + encodeURIComponent(did)).then(function (result) {
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

    var query = "/accounts/" + encodeURIComponent(did) + "/agents";
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
     /accounts/<did>?sort=...&skill=..., and letting the next page load
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
    window.location.href = "/accounts/" + encodeURIComponent(did) + (qs ? "?" + qs : "");
  }

  function renderRosterFailure() {
    A.showById("roster-empty", true);
    A.setTextById("roster-summary", "");
    A.showById("op-summary", false);
    var empty = A.el("roster-empty");
    if (empty) {
      var b = empty.querySelector("b");
      var p = empty.querySelector(".sub");
      if (b) b.textContent = "The roster could not be read just now.";
      if (p) p.textContent = "Reloading may work.";
    }
  }

  /* D5: distinguishes an operator with a genuinely empty roster from a
     skill filter that matched none of a non-empty roster's rows. The two
     read the same wrong element (agents.length === 0) before this fix;
     rosterSize (agentCount, the full roster) is what tells them apart.
     The filtered-to-zero copy mirrors browse.html's #empty state
     (src/web/pages/browse.html) for the identical case, word for word,
     so the two surfaces do not diverge on what "nothing matched" means. */
  function renderEmptyState(agents, rosterSize) {
    var isEmpty = agents.length === 0;
    A.showById("roster-empty", isEmpty);
    if (!isEmpty) return;

    var empty = A.el("roster-empty");
    if (!empty) return;
    var b = empty.querySelector("b");
    var p = empty.querySelector(".sub");
    var filteredToZero = rosterSize > 0;

    if (filteredToZero) {
      if (b) b.textContent = "No agents match this filter yet.";
      if (p) {
        p.textContent =
          "Nothing is ranked here that we did not witness. Clear the skill " +
          "filter or check back once more agents are listed.";
      }
    } else {
      if (b) b.textContent = "This operator runs no agents yet.";
      if (p) {
        p.textContent =
          "Nothing is listed here because nothing has been delegated from " +
          "this identity. This page shows every agent the moment one is.";
      }
    }
  }

  function renderRoster(body) {
    var agents = Array.isArray(body.agents) ? body.agents : [];
    var rosterSize = numberOr(body.agentCount);
    var host = A.el("roster-cards");
    if (host) {
      host.textContent = "";
      agents.forEach(function (agent) {
        host.appendChild(rosterRow(agent));
      });
    }

    /* Two different truths share one element (Review finding, round 3,
       defect empty-state-contradicts-roster): a roster with zero agents
       and a roster that a filter narrowed to zero rows are not the same
       fact, and the copy must say which one happened. Gated on rosterSize
       (agentCount, the FULL roster), the same fix D1 applied to the
       controls one block above, never on the post-filter row count. */
    renderEmptyState(agents, rosterSize);

    /* D4: controls appear only above ten agents. Below that the table
       renders plain, one layout either way. Gated on the FULL roster size
       (agentCount), never the filtered row count on screen (Review
       finding, round 3, defect control-hides-itself-under-its-own-effect):
       filtering an above-ten roster down to a handful of rows must not
       remove the controls that produced the filter. Browse keeps its
       controls visible in the identical case; this matches it. */
    A.showById("roster-controls", rosterSize > ROSTER_CONTROL_THRESHOLD);

    renderSummary(body.aggregate, rosterSize, agents.length);
    renderHeaderSummary(body.aggregate, rosterSize);
  }

  /* W3: the wireframe's header summary sentence ("N verified hires across
     M agents. Merged 15 of 17 jobs taken."). Only the first half ships.
     operatorConductForDid exists (src/api/app.ts) but no route exposes it;
     the only conduct route is GET /buyers/:githubLogin/conduct, the
     BUYER's record, not the operator's. Rendering the merge fraction would
     mean inventing a number under a real party's name, so this states the
     half that has data: the verified-hire total and the agent count, both
     already on the SAME aggregate the roster summary below reads. */
  function renderHeaderSummary(aggregate, rosterSize) {
    var totals = aggregate && typeof aggregate === "object" ? aggregate : {};
    var hires = numberOr(totals.totalVerifiedHireCount);
    A.el("op-summary").textContent =
      A.plural(hires, "verified hire", "verified hires") + " across " + A.plural(rosterSize, "agent", "agents") + ".";
    A.showById("op-summary", true);
  }

  function renderSummary(aggregate, rosterSize, shownCount) {
    var totals = aggregate && typeof aggregate === "object" ? aggregate : {};
    var hires = numberOr(totals.totalVerifiedHireCount);
    var prior = numberOr(totals.totalVerifiedPriorWorkCount);
    var portfolio = numberOr(totals.totalPortfolioCount);

    /* Three separately labelled totals, one sentence, never combined into
       one number (MISSION invariant 5). This is a summary of the rows
       above it, not a verdict on the operator.

       The aggregate is always over the FULL roster (src/api/app.ts), even
       when a skill filter narrows what is on screen: an operator's
       accountability does not shrink because a visitor filtered. Review
       finding, round 3, defect summary-contradicts-tier: the wording must
       say whose count this is, honestly, rather than claiming "every
       agent listed here" over rows that are a strict subset. */
    var subject = shownCount < rosterSize ? "Across every agent this operator runs" : "Across every agent listed here";
    A.setTextById(
      "roster-summary",
      subject + ": " +
        A.plural(hires, "verified hire", "verified hires") + ", " +
        A.plural(prior, "verified prior work", "verified prior work") + ", " +
        A.plural(portfolio, "portfolio claim", "portfolio claims") + "."
    );
  }

  /* W3: the roster row rebuilt to the wireframe's .agent shape. A 40px
     round avatar, a name link, and a right column carrying the tier chip
     (.tier .dot plus its label) beside the evidence line, the same
     vocabulary browse.js's applyTier uses for a browse card, so an agent's
     row here and its browse card read identically for the same evidence.
     The per-tier table is browse.js's own (agentTierInfo below mirrors
     applyTier exactly, over the identical BrowseCard fields). */
  function rosterRow(agent) {
    var row = document.createElement("div");
    row.className = "agent";
    row.setAttribute("data-agent-row", agent.did);

    var avatarHost = document.createElement("div");
    avatarHost.className = "rav";
    avatarHost.setAttribute("data-pending", "");
    row.appendChild(avatarHost);
    loadAvatar(agent.did, avatarHost);

    var body = document.createElement("div");

    var name = document.createElement("a");
    name.className = "nm";
    name.setAttribute("href", "/agents/" + encodeURIComponent(agent.did));
    name.textContent = typeof agent.name === "string" && agent.name !== "" ? agent.name : A.shortDid(agent.did);
    body.appendChild(name);

    /* THE DESCRIPTION LINE (wireframe .ds): BrowseCard carries no
       description field (src/domain/browse.ts), the same gap browse.js's
       own row template records for its card, so there is nothing to
       render here either. Never substitute the skills line for it. */

    row.appendChild(body);

    var right = document.createElement("div");
    right.className = "right";

    var info = agentTierInfo(agent);
    var tier = document.createElement("span");
    tier.className = "tier " + info.tierClass;
    var dot = document.createElement("span");
    dot.className = "dot";
    tier.appendChild(dot);
    var tierLabel = document.createElement("span");
    tierLabel.textContent = info.tierLabel;
    tier.appendChild(tierLabel);
    right.appendChild(tier);

    var ev = document.createElement("span");
    ev.className = "ev";
    ev.textContent = info.evidence;
    right.appendChild(ev);

    row.appendChild(right);

    return row;
  }

  /* Per-tier rendering, the identical table browse.js's applyTier applies
     (W2), read over the same three BrowseCard fields, so a roster row and
     the same agent's browse card can never disagree about which tier it
     is in or what the evidence line says:

       verified hires above zero   tier-hire,  "N verified hires",
                                    evidence line with prior and claim
                                    counts beside it
       no hires, prior above zero  tier-prior, "N verified prior work",
                                    evidence line "no hires yet"
       neither                     tier-claim, "No verified record",
                                    evidence line with the claim count

     ENT-2.4 governs the third case: an agent with no verified record
     renders as an agent with no verified record, no badge, no reordering. */
  function agentTierInfo(agent) {
    var hire = numberOr(agent.verifiedHireCount);
    var prior = numberOr(agent.verifiedPriorWorkCount);
    var claim = numberOr(agent.portfolioCount);

    if (hire > 0) {
      var parts = [];
      if (prior > 0) parts.push(prior + " prior");
      if (claim > 0) parts.push(A.plural(claim, "claim", "claims"));
      return {
        tierClass: "tier-hire",
        tierLabel: A.plural(hire, "verified hire", "verified hires"),
        evidence: parts.join("  \u00b7  "),
      };
    }
    if (prior > 0) {
      return {
        tierClass: "tier-prior",
        tierLabel: A.plural(prior, "verified prior work", "verified prior work"),
        evidence: "no hires yet",
      };
    }
    return {
      tierClass: "tier-claim",
      tierLabel: "No verified record",
      evidence: A.plural(claim, "claim", "claims"),
    };
  }

  /* The avatar rides the SAME per-agent read browse.js's loadAvatar makes
     (GET /agents/:agentDid, agentProjection's avatar field), through the
     SAME A.setAvatar sanitiser: not a second avatar path. Fired after the
     row is already in the DOM, so a slow or failed read never holds up
     the rest of the roster (the same ordering browse.js uses). */
  function loadAvatar(did, avatarHost) {
    A.get("/agents/" + encodeURIComponent(did)).then(function (result) {
      if (result.state !== "ok") return;
      if (typeof result.value.avatar === "string") A.setAvatar(avatarHost, result.value.avatar);
    });
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

