/* P-2 browse (R-20, W2): read the listing and render it as the design
   seat's wireframe (spec/wireframe/browse.html) draws it.

   ONE SERVER ROUTE, no session, unchanged from before this card:

     GET /agents?sort=<key>&skill=<term>

   Sort is a query parameter (D1), never a hardcoded rule: the three values
   this page offers are exactly the three the API accepts
   (src/domain/browse.ts), and picking one just navigates to a new URL, so
   the page stays bookmarkable and the API stays the single source of truth
   for what "verified-hires descending" means.

   SKILLS ARE SELF-ASSERTED (ENT-2.2). The five discipline chips and the
   five Language checkboxes all set the one ?skill= parameter the route
   accepts; pressing one replaces whatever was pressed before, because the
   route takes exactly one skill.

   "HAS VERIFIED HIRES" AND "HAS VERIFIED PRIOR WORK" ARE CLIENT SIDE. The
   payload already carries verifiedHireCount and verifiedPriorWorkCount per
   card (src/domain/browse.ts, BrowseCard), so narrowing the rendered list
   on either needs no second route: this script fetches the sort+skill
   listing once, then narrows and paginates the array in memory.

   THE ZERO STATE'S RELAXATION COUNTS ARE REAL. When the filtered set is
   empty, this re-queries GET /agents once per active filter with that one
   filter dropped, and labels the button with the count that comes back
   (DATA-CONTRACT.md section 3 asks for an aggregate facet endpoint that
   does not exist yet; this reads the honest way available today instead
   of inventing that route). A count that cannot be read renders the
   button without one rather than with a guess. */

(function () {
  "use strict";

  var A = window.FAApi;
  var PAGE_SIZE = 10;
  var SORT_KEYS = ["verified-hires", "recently-listed", "recently-verified"];
  var DEFAULT_SORT = "verified-hires";

  // The page's whole state lives here, always derived from the URL on
  // load and always written back to the URL on change (D1: bookmarkable).
  var state = {
    sort: DEFAULT_SORT,
    skill: "",
    hires: false,
    prior: false,
    page: 1,
    cards: [], // the last GET /agents?sort&skill response, unfiltered by hires/prior
  };

  function resolveSort(value) {
    return SORT_KEYS.indexOf(value) !== -1 ? value : DEFAULT_SORT;
  }

  function parsePage(value) {
    var n = parseInt(value, 10);
    return isFinite(n) && n > 0 ? n : 1;
  }

  function numberOr(value) {
    return typeof value === "number" && !isNaN(value) ? value : 0;
  }

  function start() {
    var params = new URLSearchParams(window.location.search);
    state.sort = resolveSort(params.get("sort"));
    state.skill = params.get("skill") || "";
    state.hires = params.get("hires") === "1";
    state.prior = params.get("prior") === "1";
    state.page = parsePage(params.get("page"));

    wireControls();
    load();
  }

  /* Every control here changes the URL and lets the load below re-read it,
     rather than mutating `state` directly and re-rendering in place: the
     same bookmarkable-URL discipline the sort control already followed
     before this card, extended to every filter. */
  function navigate(overrides) {
    var next = {
      sort: "sort" in overrides ? overrides.sort : state.sort,
      skill: "skill" in overrides ? overrides.skill : state.skill,
      hires: "hires" in overrides ? overrides.hires : state.hires,
      prior: "prior" in overrides ? overrides.prior : state.prior,
      page: "page" in overrides ? overrides.page : state.page,
    };
    var qp = new URLSearchParams();
    if (next.sort && next.sort !== DEFAULT_SORT) qp.set("sort", next.sort);
    if (next.skill) qp.set("skill", next.skill);
    if (next.hires) qp.set("hires", "1");
    if (next.prior) qp.set("prior", "1");
    if (next.page && next.page > 1) qp.set("page", String(next.page));
    var qs = qp.toString();
    window.location.href = "/browse" + (qs ? "?" + qs : "");
  }

  function wireControls() {
    var q = A.el("q");
    if (q) q.value = state.skill;

    var searchBtn = A.el("search-btn");
    if (searchBtn) {
      searchBtn.addEventListener("click", function () {
        navigate({ skill: q ? q.value.trim() : "", page: 1 });
      });
    }
    if (q) {
      q.addEventListener("keydown", function (e) {
        if (e.key === "Enter") navigate({ skill: q.value.trim(), page: 1 });
      });
    }

    var chips = document.querySelectorAll("#chips .chip[data-skill]");
    Array.prototype.forEach.call(chips, function (chip) {
      var skill = chip.getAttribute("data-skill");
      chip.setAttribute("aria-pressed", state.skill.toLowerCase() === skill ? "true" : "false");
      chip.addEventListener("click", function () {
        navigate({ skill: state.skill.toLowerCase() === skill ? "" : skill, page: 1 });
      });
    });

    var hiresChip = A.el("chip-has-hires");
    if (hiresChip) {
      hiresChip.setAttribute("aria-pressed", state.hires ? "true" : "false");
      hiresChip.addEventListener("click", function () {
        navigate({ hires: !state.hires, page: 1 });
      });
    }

    var langBoxes = document.querySelectorAll(".drawer input[type=checkbox][data-skill]");
    Array.prototype.forEach.call(langBoxes, function (box) {
      var skill = box.getAttribute("data-skill");
      box.checked = state.skill.toLowerCase() === skill;
      box.addEventListener("change", function () {
        navigate({ skill: box.checked ? skill : "", page: 1 });
      });
    });

    var priorBox = A.el("ev-prior");
    if (priorBox) {
      priorBox.checked = state.prior;
      priorBox.addEventListener("change", function () {
        navigate({ prior: priorBox.checked, page: 1 });
      });
    }

    var sortButtons = document.querySelectorAll("#sort-buttons button[data-sort]");
    Array.prototype.forEach.call(sortButtons, function (btn) {
      var key = btn.getAttribute("data-sort");
      btn.setAttribute("aria-pressed", state.sort === key ? "true" : "false");
      btn.addEventListener("click", function () {
        navigate({ sort: key, page: 1 });
      });
    });
  }

  function load() {
    A.showById("load-error", false);
    var qp = new URLSearchParams();
    if (state.sort) qp.set("sort", state.sort);
    if (state.skill) qp.set("skill", state.skill);
    var qs = qp.toString();
    A.get("/agents" + (qs ? "?" + qs : "")).then(function (result) {
      if (result.state !== "ok") {
        A.showById("load-error", true);
        A.setTextById(
          "load-error-detail",
          result.state === "failed"
            ? "The listing could not be read just now. Reloading may work."
            : "No listing is available."
        );
        return;
      }
      state.cards = Array.isArray(result.value.agents) ? result.value.agents : [];
      renderAll();
    });
  }

  /* The active client-side filters, as a small structured list rather than
     two booleans read ad hoc: every place that needs to describe, drop, or
     re-check one filter (relaxation buttons included) walks this same
     list, so the zero-state relaxation can never name a filter the main
     render did not actually apply. */
  function activeClientFilters() {
    var filters = [];
    if (state.hires) filters.push({ type: "hires", label: "verified hires" });
    if (state.prior) filters.push({ type: "prior", label: "verified prior work" });
    return filters;
  }

  function matchesClientFilters(card, filters) {
    return filters.every(function (f) {
      if (f.type === "hires") return numberOr(card.verifiedHireCount) > 0;
      if (f.type === "prior") return numberOr(card.verifiedPriorWorkCount) > 0;
      return true;
    });
  }

  function renderAll() {
    var filters = activeClientFilters();
    var filtered = state.cards.filter(function (c) {
      return matchesClientFilters(c, filters);
    });

    if (filtered.length === 0) {
      A.el("rows").textContent = "";
      A.showById("pager", false);
      renderZeroState();
      return;
    }

    A.showById("zero-host", false);
    renderResultBar(filtered.length);

    var totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    var startIndex = (state.page - 1) * PAGE_SIZE;
    renderRows(filtered.slice(startIndex, startIndex + PAGE_SIZE));
    renderPager(totalPages);
  }

  function renderResultBar(count) {
    A.setTextById("result-count", A.plural(count, "agent", "agents"));
  }

  function renderRows(cards) {
    var host = A.el("rows");
    host.textContent = "";
    cards.forEach(function (card) {
      host.appendChild(rowFor(card));
    });
  }

  function rowFor(card) {
    var tmpl = A.el("tmpl-row");
    var node = tmpl.content.firstElementChild.cloneNode(true);
    node.setAttribute("data-agent-card", card.did);

    var avatarHost = node.querySelector(".avatar");
    loadAvatar(card.did, avatarHost);

    var nameLink = node.querySelector(".name");
    var href = "/agents/" + encodeURIComponent(card.did);
    nameLink.setAttribute("href", href);
    nameLink.textContent = typeof card.name === "string" && card.name !== "" ? card.name : A.shortDid(card.did);

    var skillsHost = node.querySelector(".skills");
    var skills = Array.isArray(card.skills) ? card.skills.filter(function (s) { return typeof s === "string" && s !== ""; }) : [];
    if (skills.length > 0) {
      skills.forEach(function (s) {
        var span = document.createElement("span");
        span.textContent = s;
        skillsHost.appendChild(span);
      });
    } else {
      skillsHost.remove();
    }

    var viewLink = node.querySelector(".right a.btn");
    viewLink.setAttribute("href", href);

    applyTier(node, card);

    return node;
  }

  /* Per-tier rendering (the brief's own table):

       verified hires above zero   tier-hire,  "N verified hires",
                                    evidence line with prior and claim
                                    counts beside it
       no hires, prior above zero  tier-prior, "N verified prior work",
                                    evidence line "no hires yet"
       neither                     tier-claim, "No verified record",
                                    evidence line with the claim count,
                                    proof line "Nothing verified." dim

     ENT-2.4 governs the third case: an agent with no verified record
     renders as an agent with no verified record, no badge, no reordering,
     no scolding either. */
  function applyTier(node, card) {
    var hire = numberOr(card.verifiedHireCount);
    var prior = numberOr(card.verifiedPriorWorkCount);
    var claim = numberOr(card.portfolioCount);

    var tierEl = node.querySelector(".tier");
    var labelEl = node.querySelector(".tier-label");
    var evEl = node.querySelector(".ev");
    var proofEl = node.querySelector(".proof");

    if (hire > 0) {
      tierEl.classList.add("tier-hire");
      labelEl.textContent = A.plural(hire, "verified hire", "verified hires");

      var parts = [];
      if (prior > 0) parts.push(prior + " prior");
      if (claim > 0) parts.push(A.plural(claim, "claim", "claims"));
      evEl.textContent = parts.join("  \u00b7  ");

      // The wireframe's proof line names the repository, the pull request
      // and a relative date (DATA-CONTRACT section 4's lastProof, minus
      // the diff statistic, per this card's own instruction). BrowseCard
      // (src/domain/browse.ts) carries none of repository/pullRequest --
      // by design, to keep the listing read cheap (R-20 item 2) -- only
      // lastVerifiedAt. Rendering the repository or PR here would be
      // inventing a fact this payload does not carry, so the proof line
      // states the one real field it has instead of a fabricated one.
      var lastVerified = A.readableDate(card.lastVerifiedAt);
      if (lastVerified === null) {
        proofEl.remove();
      } else {
        proofEl.textContent = "Last verified " + lastVerified;
      }
    } else if (prior > 0) {
      tierEl.classList.add("tier-prior");
      labelEl.textContent = A.plural(prior, "verified prior work", "verified prior work");
      evEl.textContent = "no hires yet";
      proofEl.remove();
    } else {
      tierEl.classList.add("tier-claim");
      labelEl.textContent = "No verified record";
      evEl.textContent = A.plural(claim, "claim", "claims");
      proofEl.classList.add("dim");
      proofEl.textContent = "Nothing verified. " + A.plural(claim, "claim", "claims") + ", all self-reported.";
    }
  }

  /* The avatar rides the SAME per-agent read myagents.js's loadDetail
     already makes (GET /agents/:agentDid, agentProjection's `avatar`
     field), through the SAME A.setAvatar sanitiser: not a second avatar
     path, and not a field this listing route needs to grow. Fired after
     the row is already in the DOM, so a slow or failed read never holds
     up the rest of the page (the same ordering myagents.js uses). */
  function loadAvatar(did, avatarHost) {
    A.get("/agents/" + encodeURIComponent(did)).then(function (result) {
      if (result.state !== "ok") return;
      if (typeof result.value.avatar === "string") A.setAvatar(avatarHost, result.value.avatar);
    });
  }

  function renderPager(totalPages) {
    var host = A.el("pager");
    host.textContent = "";
    if (totalPages <= 1) {
      A.showById("pager", false);
      return;
    }
    A.showById("pager", true);

    var prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "Previous";
    prev.disabled = state.page <= 1;
    prev.addEventListener("click", function () {
      if (state.page > 1) navigate({ page: state.page - 1 });
    });
    host.appendChild(prev);

    for (var p = 1; p <= totalPages; p += 1) {
      (function (pageNumber) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = String(pageNumber);
        if (pageNumber === state.page) btn.setAttribute("aria-current", "page");
        btn.addEventListener("click", function () {
          navigate({ page: pageNumber });
        });
        host.appendChild(btn);
      })(p);
    }

    var next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next";
    next.disabled = state.page >= totalPages;
    next.addEventListener("click", function () {
      if (state.page < totalPages) navigate({ page: state.page + 1 });
    });
    host.appendChild(next);
  }

  /* The zero state (DESIGN.md "empty": states what is absent, offers the
     widest single relaxation, never apologises, never invents). Every
     relaxation button's count comes from a real re-query with that ONE
     filter dropped and the rest held constant, fired only now, because
     the empty result is the one moment these extra requests are worth
     making. */
  function renderZeroState() {
    A.showById("zero-host", true);

    var filters = activeClientFilters();
    var hasSkill = state.skill !== "";
    var anyFilterActive = hasSkill || filters.length > 0;

    A.setTextById("empty-title", anyFilterActive ? "No agents match all your filters." : "No agents are listed yet.");
    A.setTextById("empty-sub", anyFilterActive ? "Drop one of the filters below to widen the search." : "");

    var actionsHost = A.el("empty-actions");
    actionsHost.textContent = "";

    if (!anyFilterActive) return;

    var relaxations = [];
    if (hasSkill) relaxations.push({ type: "skill", label: state.skill });
    relaxations = relaxations.concat(filters);

    Promise.all(
      relaxations.map(function (relaxation) {
        return relaxedCount(relaxation, hasSkill, filters).then(function (count) {
          return { relaxation: relaxation, count: count };
        });
      })
    ).then(function (results) {
      results.forEach(function (r) {
        actionsHost.appendChild(relaxationButton(r.relaxation, r.count));
      });
      actionsHost.appendChild(clearAllButton());
    });
  }

  /* The count for ONE relaxation button: how many agents would match if
     this single filter, and only this one, were dropped. Dropping the
     skill filter needs a fresh server read (skill is a route parameter);
     dropping a client filter (hires/prior) just re-filters the already-
     fetched card set. Either way the OTHER active filters stay applied,
     so the number answers "what if I drop exactly this one". */
  function relaxedCount(relaxation, hasSkill, clientFilters) {
    if (relaxation.type === "skill") {
      var qp = new URLSearchParams();
      if (state.sort) qp.set("sort", state.sort);
      var qs = qp.toString();
      return A.get("/agents" + (qs ? "?" + qs : "")).then(
        function (result) {
          if (result.state !== "ok") return null;
          var cards = Array.isArray(result.value.agents) ? result.value.agents : [];
          return cards.filter(function (c) { return matchesClientFilters(c, clientFilters); }).length;
        },
        function () { return null; }
      );
    }
    var remaining = clientFilters.filter(function (f) { return f.type !== relaxation.type; });
    var base = hasSkill ? state.cards : state.cards; // skill, if any, is already baked into state.cards
    return Promise.resolve(base.filter(function (c) { return matchesClientFilters(c, remaining); }).length);
  }

  function relaxationButton(relaxation, count) {
    var btn = document.createElement("button");
    btn.className = "btn btn-sm";
    btn.type = "button";
    btn.textContent = count === null
      ? "Drop \"" + relaxation.label + "\""
      : "Drop \"" + relaxation.label + "\" \u00b7 " + A.plural(count, "result", "results");
    btn.addEventListener("click", function () {
      var overrides = { page: 1 };
      if (relaxation.type === "skill") overrides.skill = "";
      if (relaxation.type === "hires") overrides.hires = false;
      if (relaxation.type === "prior") overrides.prior = false;
      navigate(overrides);
    });
    return btn;
  }

  function clearAllButton() {
    var tmpl = A.el("tmpl-clear-all");
    var node = tmpl.content.firstElementChild.cloneNode(true);
    node.addEventListener("click", function () {
      navigate({ skill: "", hires: false, prior: false, page: 1 });
    });
    return node;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
