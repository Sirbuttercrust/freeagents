/* P-4 operator profile, rebuilt on the polished wireframe (W12,
   spec/wireframe/operator.html): read the record and render it.

   THE POLISHED STACK. This page loads bots.js and icons.js (compare
   agent.html). icons.js sweeps the DOM ONCE at load, before this file's
   own fetches resolve, and so does polish.js's avatar sweep. Anything built
   here AFTER that sweep (the roster cards, the gallery cards, the header
   avatar) needs an explicit paint call: window.FAIcon.paint(host) for every
   [data-ico] span this file builds, and window.FABots.mount(...) for every
   avatar host, the same pattern agent.js and browse.js already use
   for their own script-built hosts. This is the W11 D2 defect class
   (script-rendered-icon-never-painted); it is fixed here by construction
   rather than left to be re-earned.

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

   THE ROSTER ROW (W12): market.css's own .acard shape (div.agrid.stagger
   of article.acard), the SAME card browse.html ships (W10), so an agent's
   card reads identically on browse and on its operator's page. Reads
   browse.js's own applyTier/cardbadgeFor/evidenceLineFor table over the
   identical BrowseCard fields, mirrored here rather than imported (page
   scripts here share no module system, the same reason browse.js and
   myagents.js each carry their own numberOr), so a row here and the same
   agent's browse card can never disagree about the evidence.

   THE GALLERY (W12): "Work from these agents" (wireframe lines 133-216).
   Backed by the SAME per-agent read the roster avatar already makes
   (GET /agents/:agentDid), read once per agent and reused for both the
   avatar paint and the work items, never a second request. Built from
   agent.js's own galleryCard/galleryClaimCard vocabulary
   (src/web/public/js/pages/agent.js), with one addition: .work-by, naming
   which agent produced the item. Same evidence gate as the agent page's
   own gallery (ENT-12.1): a claim never gets a preview. */

(function () {
  "use strict";

  var A = window.FAApi;
  var ROSTER_CONTROL_THRESHOLD = 10;
  var AVATAR_SIZE = 124; // matches league.css .pcard .pc-bot { width:124px; height:124px }
  var WORK_SHOT_CLASSES = ["work-shot-1", "work-shot-2", "work-shot-3", "work-shot-4"];


  function currentParams() {
    return new URLSearchParams(window.location.search);
  }

  function paintIcons(host) {
    if (window.FAIcon) window.FAIcon.paint(host);
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

    /* THE AVATAR (AV2): the bot bots.js derives from this operator's DID,
       drawn still. An operator is a person, and there is no operator avatar
       override (PUT /agents/:agentDid/avatar is for an agent), so it is
       always the DID default and never animates: motion on this site says
       something about an agent's work. The square corner (.pav.is-op,
       market.css) is what tells an operator from an agent at a glance.
       Mounted here, never by polish.js's load-time sweep, which runs before
       this read has anything to key on. */
    if (window.FABots && typeof operator.did === "string" && operator.did !== "") {
      window.FABots.mount(A.el("avatar"), operator.did, { size: 96, still: true });
    }

    A.showById("ident", true);
    A.setTextById("did-short", A.shortDid(operator.did));

    var github = A.el("github");
    if (github) {
      /* "proven both ways" is reserved for a checked account proof
         (DESIGN 1.3). accountProjection (src/api/app.ts) carries the
         handle an operator registered with and no proof status at all, so
         this says only what it knows: the handle. This is a DEPARTURE
         from the wireframe, which prints "proven both ways" for its own
         sample operator; the same box on the agent page can say more
         because AN AGENT record carries a checked account proof and an
         operator record does not. Claiming more here would be the exact
         overstatement the vocabulary table forbids. */
      github.textContent = login !== "" ? "registered as github @" + login : "no GitHub handle registered";
    }

    var since = A.readableDate(operator.createdAt);
    A.setTextById("since", since === null ? "not recorded" : since);

    setCopy("did-copy", operator.did);
    setCopy("did-copy-2", operator.did);
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
    renderGalleryEmpty();
  }

  /* D5: distinguishes an operator with a genuinely empty roster from a
     skill filter that matched none of a non-empty roster's rows. The two
     read the same wrong element (agents.length === 0) before this fix;
     rosterSize (agentCount, the full roster) is what tells them apart. */
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
      agents.forEach(function (agent, i) {
        var card = rosterRow(agent);
        card.style.setProperty("--i", String(i));
        host.appendChild(card);
      });
    }

    renderEmptyState(agents, rosterSize);

    /* D4: controls appear only above ten agents, gated on the FULL roster
       size (agentCount), never the filtered row count on screen. */
    A.showById("roster-controls", rosterSize > ROSTER_CONTROL_THRESHOLD);

    renderSummary(body.aggregate, rosterSize, agents.length);
    renderHeaderSummary(body.aggregate, rosterSize);
    renderPstats(body.aggregate, rosterSize);

    /* THE GALLERY: fires one read per agent in the roster
       (GET /agents/:agentDid), the SAME read the avatar paint below
       needs, and builds every gallery card from that shared response
       rather than a second request per agent. */
    loadGallery(agents);
  }

  /* W12: the wireframe's header summary sentence ("N verified hires
     across M agents. Merged 15 of 17 jobs taken."). Only the first half
     ships: operatorConductForDid exists (src/api/app.ts) but no route
     exposes it, and the only conduct route is
     GET /buyers/:githubLogin/conduct, the BUYER's record, not the
     operator's. Rendering the merge fraction would mean inventing a
     number under a real party's name, so this states the half that has
     data: the verified-hire total and the agent count, both already on
     the SAME aggregate the roster summary and the .pstats row below
     read. */
  function renderHeaderSummary(aggregate, rosterSize) {
    var totals = aggregate && typeof aggregate === "object" ? aggregate : {};
    var hires = numberOr(totals.totalVerifiedHireCount);
    A.el("op-summary").textContent =
      A.plural(hires, "verified hire", "verified hires") + " across " + A.plural(rosterSize, "agent", "agents") + ".";
    A.showById("op-summary", true);
  }

  /* The .pstats four-cell row (wireframe lines 83-104). Three separately
     labelled tier totals plus the agent count, never combined into one
     number (MISSION invariant 5): the same table renderSummary below
     applies to its own sentence, read off the SAME aggregate so the two
     can never disagree.

     Merge rate needs the total-jobs-taken denominator; no route serves
     it, so this row's merge-rate cell renders the static "not yet
     observed" fallback rather than a fraction this build cannot source
     (operator.html, #pstat-merge-rate). The agent profile carried the
     same cell until S2 removed it there. The
     wireframe's own comment (operator.html lines 113-123 on the pre-W12
     build) already recorded this reasoning; it carries forward unchanged. */
  function renderPstats(aggregate, rosterSize) {
    var totals = aggregate && typeof aggregate === "object" ? aggregate : {};
    var hires = numberOr(totals.totalVerifiedHireCount);
    var prior = numberOr(totals.totalVerifiedPriorWorkCount);
    var claims = numberOr(totals.totalPortfolioCount);
    A.setTextById("pstat-hires", String(hires));
    /* A zero is not a checked count, so the cell goes grey (market.css
       .pstat.is-hire.is-zero, DESIGN.md 2.2). */
    var hireCell = A.el("pstat-hires");
    if (hireCell && hireCell.parentNode) hireCell.parentNode.classList.toggle("is-zero", hires === 0);
    A.setTextById("pstat-hires-sub", "across " + A.plural(rosterSize, "agent", "agents"));
    A.setTextById("pstat-prior", String(prior));
    A.setTextById("pstat-claims", String(claims));
    A.setTextById("pstat-agents", String(rosterSize));
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
       accountability does not shrink because a visitor filtered. */
    var subject = shownCount < rosterSize ? "Across every agent this operator runs" : "Across every agent listed here";
    A.setTextById(
      "roster-summary",
      subject + ": " +
        A.plural(hires, "verified hire", "verified hires") + ", " +
        A.plural(prior, "verified prior work", "verified prior work") + ", " +
        A.plural(portfolio, "portfolio claim", "portfolio claims") + "."
    );
  }

  /* THE ROSTER ROW, market.css's own .acard shape (browse.js's cardFor,
     mirrored rather than imported). .acard-top holds the avatar host,
     .acard-body holds the name link, the work-kind tags and the
     visually-hidden tier sentence, .acard-foot holds the evidence line
     and the go icon. Keeps --id-hue, the identity colour, the same way
     browse.js derives it from the DID (FABots.hash), never picked
     and never cycled by position. */
  function rosterRow(agent) {
    /* THE LEAGUE LOOK: a roster row is a player card (DESIGN.md 2.6), the
       same one browse draws, built by pcard.js from the same BrowseCard
       fields. The visually-hidden tier sentence stays, below, so the
       roster and the same agent's browse card can never disagree about
       which tier it is in. */
    var article = window.FAPlayerCard.build(agent, { botSize: AVATAR_SIZE });
    article.setAttribute("data-agent-row", agent.did);
    var body = article.querySelector(".pc-body");

    var hire = numberOr(agent.verifiedHireCount);
    var prior = numberOr(agent.verifiedPriorWorkCount);

    /* The visually-hidden tier sentence: the SAME per-tier table
       browse.js's applyTier applies, read over the identical BrowseCard
       fields, so a roster row and the same agent's browse card can never
       disagree about which tier it is in. */
    var tier = document.createElement("span");
    tier.className = "tier tier-label-a11y";
    if (hire > 0) {
      tier.classList.add("tier-hire");
      tier.textContent = A.plural(hire, "verified hire", "verified hires");
    } else if (prior > 0) {
      tier.classList.add("tier-prior");
      tier.textContent = A.plural(prior, "verified prior work", "verified prior work");
    } else {
      tier.classList.add("tier-claim");
      tier.textContent = "No verified record";
    }
    body.appendChild(tier);

    /* The evidence line, visually hidden like the tier sentence: the same
       counts the stats show, in the words the roster always used, so a
       reader of the page source or a screen reader gets one sentence. */
    var ev = document.createElement("span");
    ev.className = "acard-ev tier-label-a11y";
    ev.appendChild(evidenceLineFor(hire, prior, numberOr(agent.portfolioCount)));
    body.appendChild(ev);

    paintIcons(article);
    return article;
  }

  /* The wireframe's cardbadge (market.css .pverified/.punverified), the
     same table browse.js's own cardbadgeFor uses over the identical
     fields. Omitted when the card has nothing to report at all (ENT-2.4:
     no promotional framing, nothing to state). */
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

  /* The wireframe's footer evidence line (market.css .acard-ev), the same
     table browse.js's own evidenceLineFor uses. */
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

  function numberOr(value) {
    return typeof value === "number" && !isNaN(value) ? value : 0;
  }

  /* ---------------------------------------------------------- gallery */

  /* Fires ONE read per roster agent (GET /agents/:agentDid), the same
     route browse.js's loadAvatar already calls for its own card, and
     reuses that SAME response for both the avatar paint and the work
     items rather than a second request. Once every read has settled
     (success or failure, Promise.allSettled so one bad agent never blanks
     the whole gallery), the collected work is sorted, capped, and
     rendered. */
  function loadGallery(agents) {
    if (agents.length === 0) {
      renderGalleryEmpty();
      return;
    }

    var reads = agents.map(function (agent) {
      return A.get("/agents/" + encodeURIComponent(agent.did)).then(function (result) {
        paintRosterAvatar(agent.did, result);
        return { agent: agent, result: result };
      });
    });

    Promise.all(reads).then(function (pairs) {
      renderGallery(collectGalleryItems(pairs));
    });
  }

  /* The roster avatar (AV2): bots.js (window.FABots) mounts the bot the
     per-agent read's avatarSpec names, the operator's choice or the DID
     default, once that read has settled, the same call browse.js's own
     loadAvatar makes for its card. Painted here rather than through the
     generic [data-avatar] sweep because that sweep already ran at load,
     before this fetch had anything to key on. */
  function paintRosterAvatar(did, result) {
    if (result.state !== "ok") return;
    var host = document.querySelector('[data-agent-row="' + cssEscape(did) + '"] .pc-bot');
    if (!host || !window.FABots) return;
    window.FABots.mount(host, did, { spec: result.value.avatarSpec, size: AVATAR_SIZE });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  /* Sort and cap: the verified-hire tier across EVERY agent first, most
     recent mergedAt first, then verified prior work, then claims. A cap
     keeps one prolific agent from filling the whole strip; twelve is the
     wireframe's own four cards times three, generous enough that a
     four-agent roster like the wireframe's own example never notices it
     and small enough that an operator running fifty agents does not ship
     an unbounded page. */
  var GALLERY_CAP = 12;

  function collectGalleryItems(pairs) {
    var hires = [];
    var prior = [];
    var claims = [];
    pairs.forEach(function (pair) {
      if (pair.result.state !== "ok") return;
      var agentName = typeof pair.agent.name === "string" && pair.agent.name !== "" ? pair.agent.name : A.shortDid(pair.agent.did);
      var record = pair.result.value;
      (Array.isArray(record.verifiedHires) ? record.verifiedHires : []).forEach(function (item) {
        hires.push({ item: item, agentName: agentName, tier: "hire" });
      });
      (Array.isArray(record.verifiedPriorWork) ? record.verifiedPriorWork : []).forEach(function (item) {
        prior.push({ item: item, agentName: agentName, tier: "prior" });
      });
      (Array.isArray(record.portfolio) ? record.portfolio : []).forEach(function (item) {
        claims.push({ item: item, agentName: agentName, tier: "claim" });
      });
    });

    hires.sort(function (a, b) { return dateMs(b.item.mergedAt) - dateMs(a.item.mergedAt); });
    prior.sort(function (a, b) { return dateMs(b.item.mergedAt) - dateMs(a.item.mergedAt); });

    return hires.concat(prior, claims).slice(0, GALLERY_CAP);
  }

  function dateMs(value) {
    var ms = typeof value === "string" ? Date.parse(value) : NaN;
    return isNaN(ms) ? -Infinity : ms;
  }

  function renderGalleryEmpty() {
    A.el("gallery").textContent = "";
    A.showById("gallery-empty", true);
  }

  function renderGallery(entries) {
    var host = A.el("gallery");
    if (!host) return;
    host.textContent = "";

    if (entries.length === 0) {
      A.showById("gallery-empty", true);
      return;
    }
    A.showById("gallery-empty", false);

    entries.forEach(function (entry, i) {
      var card = entry.tier === "claim"
        ? galleryClaimCard(entry.item, entry.agentName)
        : galleryCard(entry.item, entry.agentName, i, entry.tier);
      card.style.setProperty("--i", String(i));
      host.appendChild(card);
    });
  }

  /* .work-by (wireframe line 187): the one element the operator gallery
     adds beyond the agent page's own galleryCard, naming WHICH of the
     operator's agents produced the item. */
  function workByRow(agentName) {
    var span = document.createElement("span");
    span.className = "work-by";
    var icon = document.createElement("span");
    icon.className = "ico ico-sm";
    icon.setAttribute("data-ico", "user");
    span.appendChild(icon);
    span.appendChild(document.createTextNode(agentName));
    return span;
  }

  function tierBadge(tier) {
    var span = document.createElement("span");
    var icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    var label;
    if (tier === "hire") {
      span.className = "pverified pverified-sm";
      icon.className = "ico";
      icon.setAttribute("data-ico", "shield-check");
      label = "Verified hire";
    } else if (tier === "prior") {
      span.className = "tier tier-prior";
      icon.className = "ico";
      icon.setAttribute("data-ico", "link-2");
      label = "Verified prior work";
    } else {
      span.className = "tier tier-claim";
      icon.className = "ico";
      icon.setAttribute("data-ico", "file-dash");
      label = "Portfolio claim";
    }
    span.appendChild(icon);
    span.appendChild(document.createTextNode(label));
    return span;
  }

  /* ENT-12.1, the evidence gate: a claim never gets a preview, ever. The
     same dashed-frame shape agent.js's galleryClaimCard uses, plus
     .work-by naming the agent. */
  function galleryClaimCard(item, agentName) {
    var figure = document.createElement("figure");
    figure.className = "work is-claim";

    var frame = document.createElement("div");
    frame.className = "work-frame is-empty";
    var icon = document.createElement("span");
    icon.className = "ico ico-lg";
    icon.setAttribute("data-ico", "file-dash");
    icon.setAttribute("aria-hidden", "true");
    frame.appendChild(icon);
    var msg = document.createElement("span");
    msg.className = "work-empty-msg";
    msg.textContent = "No preview. We have not seen this work.";
    frame.appendChild(msg);
    figure.appendChild(frame);

    var caption = document.createElement("figcaption");
    var head = document.createElement("div");
    head.className = "work-head";
    var h3 = document.createElement("h3");
    h3.textContent = typeof item.repository === "string" && item.repository !== "" ? item.repository : "Portfolio claim";
    head.appendChild(h3);
    head.appendChild(tierBadge("claim"));
    caption.appendChild(head);
    caption.appendChild(workByRow(agentName));

    /* ENT-12.1: no verify affordance on a claim, ever. */
    var note = document.createElement("p");
    note.className = "work-note";
    note.textContent = "Anyone can write this. Treat it as a description, not a record.";
    caption.appendChild(note);

    figure.appendChild(caption);
    paintIcons(figure);
    return figure;
  }

  function galleryCard(item, agentName, index, tier) {
    var figure = document.createElement("figure");
    figure.className = "work";

    var frame = document.createElement("div");
    frame.className = "work-frame";
    var chrome = document.createElement("div");
    chrome.className = "work-chrome";
    for (var d = 0; d < 3; d += 1) {
      var dot = document.createElement("span");
      dot.className = "dot";
      chrome.appendChild(dot);
    }
    var url = document.createElement("span");
    url.className = "work-url";
    url.textContent = typeof item.repository === "string" && item.repository !== "" ? item.repository : "";
    chrome.appendChild(url);
    frame.appendChild(chrome);

    var shot = document.createElement("div");
    shot.className = "work-shot " + WORK_SHOT_CLASSES[index % WORK_SHOT_CLASSES.length];
    shot.setAttribute("role", "img");
    shot.setAttribute(
      "aria-label",
      "Preview of " + (typeof item.repository === "string" && item.repository !== "" ? item.repository : "this work"),
    );
    frame.appendChild(shot);
    figure.appendChild(frame);

    var caption = document.createElement("figcaption");
    var head = document.createElement("div");
    head.className = "work-head";
    var h3 = document.createElement("h3");
    h3.textContent = typeof item.repository === "string" && item.repository !== "" ? item.repository : "Merged work";
    head.appendChild(h3);
    head.appendChild(tierBadge(tier === "prior" ? "prior" : "hire"));
    caption.appendChild(head);
    caption.appendChild(workByRow(agentName));

    /* The verify link, the same two fields agent.js's own galleryCard
       keys its link on (agent.js galleryCard): credentialId gates whether the
       control renders at all, pullRequest gives it a real destination.
       Never built on galleryClaimCard, the evidence gate ENT-12.1 holds. */
    var links = document.createElement("div");
    links.className = "work-links";
    if (typeof item.credentialId === "string" && item.credentialId !== "") {
      var template = document.getElementById("tmpl-gallery-hire-link");
      if (template) {
        var linkEl = template.content.firstElementChild.cloneNode(true);
        linkEl.setAttribute("href", typeof item.pullRequest === "string" && item.pullRequest !== "" ? item.pullRequest : "#");
        links.appendChild(linkEl);
      }
    }
    caption.appendChild(links);

    figure.appendChild(caption);
    paintIcons(figure);
    return figure;
  }

  /* Test-only hook, mirroring the W3 round 2 pattern (agentTierInfo): a
     pure function exposed so a test can call it directly over a shaped
     object rather than fabricating an HTTP fixture. Never read by product
     code. */
  window.__operatorTestHooks = { cardbadgeFor: cardbadgeFor, evidenceLineFor: evidenceLineFor };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
