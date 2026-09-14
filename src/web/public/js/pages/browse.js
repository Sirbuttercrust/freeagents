/* P-2 browse (R-20, W2, rebuilt on the polished wireframe by W10): read
   the listing and render it as spec/wireframe/browse.html draws it, a
   grid of agent cards rather than a row list.

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
   button without one rather than with a guess.

   W10: THE CARD GRID. Built markup used to be div.rows of article.agent
   in a 44px/1fr/auto row grid; it is now div.agrid.stagger of
   article.acard.idc, matching market.css's card component (the same one
   agent.html's profile header and operator.html's roster already draw
   their own identity colour from). Every card's --id-hue is derived from
   its DID the same way agent.js derives --id-hue on #phero: the same
   FACore.hash the avatar generator itself seeds from, so the SAME agent
   gets the SAME hue on every render and on every page, never randomised
   and never cycled by position in the result list. */

(function () {
  "use strict";

  var A = window.FAApi;
  var PAGE_SIZE = 10;
  var SORT_KEYS = ["verified-hires", "recently-listed", "recently-verified"];
  var DEFAULT_SORT = "verified-hires";
  var AVATAR_SIZE = 52; // matches market.css .acard-av { width:52px; height:52px }

  // market.css's five discipline tints (.cat-frontend etc). Only a skill
  // string that matches one of these five, case-insensitive, gets the
  // matching class; every other self-asserted skill renders as a plain
  // .cat (DATA-CONTRACT section 7: skills are free text, no discipline
  // taxonomy exists to migrate the schema toward, so nothing here invents
  // a sixth category for a string that does not match one of the five).
  var CAT_CLASS = {
    frontend: "cat-frontend",
    backend: "cat-backend",
    infrastructure: "cat-infra",
    data: "cat-data",
    testing: "cat-testing",
  };

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

    wireMoreFilters();
  }

  /* THE DRAWER DISCLOSURE. The button carries data-disclose="drawer" so
     the attribute-level contract other code reads stays intact:
     tests/web/browse.test.ts's own real-Chrome tap-target case opens the
     drawer with `document.querySelector('[data-disclose="drawer"]')`,
     and polish.js's discloseAnim() also finds it by that same attribute
     and, on click, schedules a requestAnimationFrame callback that reads
     target.hidden and toggles .is-open (the class polish.css's
     .reveal-h.is-open rule keys its open state on, item 7 of this card's
     brief).

     It is NOT left to run through ui.js's disclosures(), the shared
     handler that unconditionally replaces a [data-disclose] button's
     children with a captured plain-text label on every click
     (`btn.textContent = label`): every OTHER disclosure control on this
     site is plain text already, so nine other buttons live with that
     rewrite for free, and this is the one control the wireframe gives
     icons to (item 8), so it is the one place the rewrite costs
     something -- it would delete both icon spans the first time anyone
     opened the drawer.

     SCRIPT LOAD ORDER. browse.html loads polish.js, then browse.js, then
     ui.js, and each attaches its own DOMContentLoaded listener in that
     order, so click listeners on this one button register in the same
     order: polish.js's discloseAnim listener first, this one second,
     ui.js's disclosures listener third. stopImmediatePropagation() here
     stops any listener registered AFTER this one on the SAME element
     (ui.js's, and only ui.js's: polish.js's already ran, synchronously,
     before this handler started).

     .is-open IS SET HERE TOO, SYNCHRONOUSLY, rather than left to
     discloseAnim's requestAnimationFrame callback alone. Both do the same
     work and neither races the other (discloseAnim's callback runs after
     this handler has already set the real drawer.hidden and .is-open
     state, so it just re-applies the same value), but a synchronous set
     is what makes the drawer's real, measurable height available to code
     that reads it in the very next task -- exactly what
     tests/web/browse.test.ts's "every rendered interactive control is at
     least 44px, drawer open" case does, back to back with no frame
     boundary it can rely on waiting for. */
  function wireMoreFilters() {
    var btn = A.el("more-filters-btn");
    var drawer = A.el("drawer");
    if (!btn || !drawer) return;
    btn.addEventListener("click", function (e) {
      e.stopImmediatePropagation();
      var opening = drawer.hidden;
      drawer.hidden = !opening;
      drawer.classList.toggle("is-open", opening);
      btn.setAttribute("aria-expanded", opening ? "true" : "false");
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
    renderCards(filtered.slice(startIndex, startIndex + PAGE_SIZE));
    renderPager(totalPages);
  }

  function renderResultBar(count) {
    A.setTextById("result-count", A.plural(count, "agent", "agents"));
    renderFilterCount();
  }

  /* The wireframe's data-filter-count slot beside the result count (item 9
     of this card's brief): how many filters are active right now, self
     and client side together. This page's own count rather than
     polish.js's announceFilters(), because that function counts
     [data-toggle][aria-pressed="true"] elements and this page's chips are
     wired directly by wireControls() above, never through [data-toggle]
     (the same reason the drawer disclosure above is wired directly
     instead of through [data-disclose]: a shared handler double-firing
     against a control this page already owns is worse than a second small
     function). Called from both renderResultBar() (the normal path) and
     renderZeroState() (review round 1, D1): polish.js's own init() calls
     announceFilters() once on page load, and skipping this call on the
     zero-result path left that stale, always-wrong write standing. */
  function renderFilterCount() {
    var host = A.el("filter-count");
    var sep = A.el("filter-count-sep");
    if (!host || !sep) return;
    var count = (state.skill !== "" ? 1 : 0) + activeClientFilters().length;
    if (count === 0) {
      sep.hidden = true;
      host.textContent = "";
      return;
    }
    sep.hidden = false;
    host.textContent = count === 1 ? "1 filter" : count + " filters";
  }

  function renderCards(cards) {
    var host = A.el("rows");
    host.textContent = "";
    cards.forEach(function (card, i) {
      var node = cardFor(card);
      // The stagger delay base.css's .js-reveal .stagger.is-in > * rule
      // reads (transition-delay: calc(min(var(--i, 0), 6) * 45ms)), the
      // same per-child index property myagents.js's own agentRow already
      // sets on its roster rows for the identical .stagger reveal.
      node.style.setProperty("--i", String(i));
      host.appendChild(node);
    });
  }

  function cardFor(card) {
    var tmpl = A.el("tmpl-card");
    var node = tmpl.content.firstElementChild.cloneNode(true);
    node.setAttribute("data-agent-card", card.did);

    /* Identity colour (DESIGN.md 2.4): per agent, derived from the DID,
       never picked and never cycled by position in the result list. The
       same hash swarm.js itself seeds the creature from, read through
       FACore so this page invents no second hash function -- the exact
       pattern agent.js already uses for #phero's --id-hue. Five bands,
       matching the five --agent-* tokens. */
    if (window.FACore) {
      var hue = window.FACore.hash(card.did) % 5;
      node.style.setProperty("--id-hue", "var(--agent-" + (hue + 1) + ")");
    }

    var avatarHost = node.querySelector(".acard-av");
    if (avatarHost) {
      avatarHost.setAttribute("data-avatar", card.did);
      loadAvatar(card.did, avatarHost);
    }

    var nameLink = node.querySelector(".acard-name");
    var href = "/agents/" + encodeURIComponent(card.did);
    nameLink.setAttribute("href", href);
    nameLink.textContent = typeof card.name === "string" && card.name !== "" ? card.name : A.shortDid(card.did);

    var catsHost = node.querySelector(".acard-cats");
    var skills = Array.isArray(card.skills) ? card.skills.filter(function (s) { return typeof s === "string" && s !== ""; }) : [];
    if (skills.length > 0) {
      skills.forEach(function (s) {
        var span = document.createElement("span");
        var mapped = CAT_CLASS[s.toLowerCase()];
        span.className = mapped ? "cat " + mapped : "cat";
        span.textContent = s;
        catsHost.appendChild(span);
      });
    } else {
      catsHost.remove();
    }

    applyTier(node, card);

    return node;
  }

  /* THE AVATAR RIDES THE SAME PER-ROW READ THIS PAGE ALWAYS MADE
     (GET /agents/:agentDid, the same shape myagents.js's loadDetail
     uses), fired after the card is already in the DOM so a slow or
     failed read never holds up the rest of the page. What changed is
     what happens once that read resolves: the built page used to hand
     the SERVER's agent.avatar field (an older, separate blobatar engine,
     src/api/avatar.ts) to A.setAvatar; DESIGN.md 2.4 and agent.js both
     say an agent's creature is derived from its DID and nothing else, so
     this hands the DID itself, already known before the fetch, to
     window.FASwarm.avatar -- the same generator and the same call agent.js
     makes for its own profile-header avatar. A failed read leaves the
     avatar host exactly as it started (data-pending), never a guessed or
     partial creature: the same fail-honest rule this file already applies
     to every other read. */
  function loadAvatar(did, avatarHost) {
    A.get("/agents/" + encodeURIComponent(did)).then(function (result) {
      if (result.state !== "ok") return;
      if (!window.FASwarm) return;
      avatarHost.innerHTML = window.FASwarm.avatar(did, AVATAR_SIZE);
      avatarHost.removeAttribute("data-pending");
    });
  }

  /* Per-tier rendering (the brief's own table):

       verified hires above zero   tier-hire,  "N verified hires",
                                    a pverified cardbadge with the count,
                                    evidence line with prior and claim
                                    counts beside it
       no hires, prior above zero  tier-prior, "N verified prior work",
                                    a punverified cardbadge reading
                                    "No hires yet", evidence line "N prior"
       neither, some claims        tier-claim, "No verified record",
                                    a punverified cardbadge reading
                                    "Unverified", evidence line with the
                                    claim count
       neither, no claims either   tier-claim, "No verified record",
                                    NO cardbadge (nothing at all to state,
                                    not even an unverified claim; see the
                                    comment on cardbadgeFor below)

     ENT-2.4 governs the third and fourth cases: an agent with no verified
     record renders as an agent with no verified record, no reordering, no
     scolding either.

     .tier and .proof carry the same fact a second time, visually hidden
     (browse.html's own .tier-label-a11y), so a screen reader and this
     page's own conformance/functional tests read the identical sentence
     the visible badge and evidence line state, never a second phrasing
     that could drift from the first. */
  function applyTier(node, card) {
    var hire = numberOr(card.verifiedHireCount);
    var prior = numberOr(card.verifiedPriorWorkCount);
    var claim = numberOr(card.portfolioCount);

    var top = node.querySelector(".acard-top");
    var badge = cardbadgeFor(hire, prior, claim);
    if (badge && top) top.appendChild(badge);

    node.querySelector(".acard-ev").appendChild(evidenceLineFor(hire, prior, claim));

    var tierEl = node.querySelector(".tier");
    var proofEl = node.querySelector(".proof");

    if (hire > 0) {
      tierEl.classList.add("tier-hire");
      tierEl.textContent = A.plural(hire, "verified hire", "verified hires");

      // The wireframe's proof line names the repository, the pull request
      // and a relative date (DATA-CONTRACT section 4's lastProof, minus
      // the diff statistic, per this card's own instruction). BrowseCard
      // (src/domain/browse.ts) carries none of repository/pullRequest --
      // by design, to keep the listing read cheap (R-20 item 2) -- only
      // lastVerifiedAt. Rendering the repository or PR here would be
      // inventing a fact this payload does not carry, so the hidden proof
      // line states the one real field it has instead of a fabricated one.
      var lastVerified = A.readableDate(card.lastVerifiedAt);
      if (lastVerified === null) {
        proofEl.remove();
      } else {
        proofEl.textContent = "Last verified " + lastVerified;
      }
    } else if (prior > 0) {
      tierEl.classList.add("tier-prior");
      tierEl.textContent = A.plural(prior, "verified prior work", "verified prior work");
      proofEl.remove();
    } else {
      tierEl.classList.add("tier-claim");
      tierEl.textContent = "No verified record";
      proofEl.classList.add("dim");
      proofEl.textContent = "Nothing verified. " + A.plural(claim, "claim", "claims") + ", all self-reported.";
    }
  }

  /* The wireframe's cardbadge (market.css .pverified / .punverified,
     top right of every card): a pverified stamp with the hire count when
     there is one to stamp, a punverified stamp naming why not otherwise.

     OMITTED WHEN THE CARD HAS NOTHING TO REPORT AT ALL (hire, prior and
     claim all zero). tests/web/browse.test.ts's cold-start case asserts a
     card with nothing on it carries zero elements matching
     [class*="badge"], the concrete form ENT-2.4's "no promotional
     framing" rule takes here: an "Unverified" stamp about zero claims
     states nothing the hidden tier text ("No verified record") does not
     already say, so the badge slot stays empty rather than becoming
     chrome with nothing behind it. Every wireframe sample DOES carry a
     badge, but every wireframe sample also carries at least one claim,
     one prior-work item or one hire; none illustrates the genuinely
     empty case this rule covers. */
  function cardbadgeFor(hire, prior, claim) {
    var span = document.createElement("span");
    var icon = document.createElement("span");
    icon.className = "ico";
    icon.setAttribute("aria-hidden", "true");

    if (hire > 0) {
      span.className = "pverified pverified-sm cardbadge";
      icon.setAttribute("data-ico", "shield-check");
      span.appendChild(icon);
      var b = document.createElement("b");
      b.textContent = String(hire);
      span.appendChild(b);
      span.appendChild(document.createTextNode(" verified"));
      return span;
    }
    if (prior > 0) {
      span.className = "punverified punverified-sm cardbadge";
      icon.setAttribute("data-ico", "link-2");
      span.appendChild(icon);
      span.appendChild(document.createTextNode("No hires yet"));
      return span;
    }
    if (claim > 0) {
      span.className = "punverified punverified-sm cardbadge";
      icon.setAttribute("data-ico", "file-dash");
      span.appendChild(icon);
      span.appendChild(document.createTextNode("Unverified"));
      return span;
    }
    return null;
  }

  /* The wireframe's footer evidence line (market.css .acard-ev): the
     verified-hire count first, always, then one more fact beside it
     separated by the drawn .sep rule -- prior work when there is any,
     the claim count otherwise. Matches the wireframe's own four sample
     cards cell for cell (axiom-ui: "12 verified · 31 prior", pellucid:
     "0 verified · 47 prior", tessellate: "0 verified · 3 claims",
     gridwright: "3 verified · 8 prior"). */
  function evidenceLineFor(hire, prior, claim) {
    var frag = document.createDocumentFragment();

    var first = document.createElement("span");
    first.className = hire > 0 ? "hires" : "none";
    if (hire > 0) {
      var icon = document.createElement("span");
      icon.className = "ico";
      icon.setAttribute("data-ico", "shield-check");
      icon.setAttribute("aria-hidden", "true");
      first.appendChild(icon);
    }
    first.appendChild(document.createTextNode(hire + " verified"));
    frag.appendChild(first);

    var secondText = "";
    var secondNone = false;
    if (prior > 0) {
      secondText = prior + " prior";
    } else if (claim > 0) {
      secondText = A.plural(claim, "claim", "claims");
      secondNone = true;
    }
    if (secondText !== "") {
      var sep = document.createElement("span");
      sep.className = "sep";
      sep.setAttribute("aria-hidden", "true");
      frag.appendChild(sep);

      var second = document.createElement("span");
      if (secondNone) second.className = "none";
      second.textContent = secondText;
      frag.appendChild(second);
    }

    return frag;
  }

  function renderPager(totalPages) {
    var host = A.el("pager");
    host.textContent = "";
    if (totalPages <= 1) {
      A.showById("pager", false);
      return;
    }
    A.showById("pager", true);

    /* "Previous" and "Next" are cloned from <template> rather than built
       with textContent, so the literal string a buyer sees and the
       string this page's own conformance test scans are the same source
       (browse.html's own comment on tmpl-pager-prev / tmpl-pager-next):
       a control whose text exists only inside this .js file is invisible
       to an instrument that reads only browse.html, which is exactly what
       left "Previous" and "Next" red before this card. */
    var prevTmpl = A.el("tmpl-pager-prev");
    var prev = prevTmpl.content.firstElementChild.cloneNode(true);
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

    var nextTmpl = A.el("tmpl-pager-next");
    var next = nextTmpl.content.firstElementChild.cloneNode(true);
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

    // D1 (review round 1): this slot is shared with polish.js's
    // announceFilters(), which counts [data-toggle] chips this page never
    // uses and always finds zero, so it can leave the slot reading "No
    // filters" here. renderResultBar() already corrects that write on the
    // non-zero path; the zero-result path skips renderResultBar()
    // entirely, so this calls the same page-owned writer directly to
    // state the true count (or nothing) instead of leaving whatever
    // polish.js wrote standing.
    renderFilterCount();

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
        return relaxedCount(relaxation, filters).then(function (count) {
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
  function relaxedCount(relaxation, clientFilters) {
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
    // hasSkill has no effect here: state.cards already has the skill
    // filter baked in from the server query, whether or not this
    // particular relaxation is a skill drop, so the base set is the same
    // either way.
    return Promise.resolve(state.cards.filter(function (c) { return matchesClientFilters(c, remaining); }).length);
  }

  /* The two "Drop ..." relaxation buttons are never templated (unlike the
     pager and Clear all): their wireframe sample digits ("· 3 results")
     are sample data (ALLOWED_ABSENT, browse), so this builds them from
     scratch with the real counts relaxedCount returns. The literal
     entity fix (browse's two ALLOWED_ABSENT keys correctly compare
     against the decoded middot now, tests/web/wireframe-conformance.
     test.ts's clean()) does not change anything here: this function
     already emitted the real \u00b7 character, never the &middot; entity. */
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
