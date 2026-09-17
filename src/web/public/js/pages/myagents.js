/* P8n my agents (P-18): a signed-in operator's own roster of everything
   they operate. Reads GET /accounts/me (the same departure P8m named for
   My jobs) to resolve the session to a DID, then GET /accounts/:did/agents
   for the roster (BrowseCard rows, already carrying the three tier counts
   this page never sums), then GET /agents/:agentDid once per row for
   proofStatus -- the one fact BrowseCard does not carry
   (src/domain/browse.ts).

   THE PER-AGENT READ IS THE CARD'S ONE PERFORMANCE DEPARTURE, named in the
   handoff: /agents/:agentDid sits behind verifyRateLimiter at 60 requests
   per minute (src/api/app.ts), so a roster above that size would exhaust it
   on a single page load. A per-agent read that fails leaves that row's
   attention line ABSENT, never a guessed "confirmed" -- the same
   never-invent-a-fact rule api.js's own header states, applied here to a
   proof state rather than a count.

   THE THREE COUNTS ARE READ OFF THE ROSTER ROW ITSELF, never off the
   per-agent read: verifiedHireCount, verifiedPriorWorkCount and
   portfolioCount already ride on BrowseCard, so a failed per-agent read
   never blanks a count the roster call already answered.

   NO SETTINGS LINK, NO LIST-AN-AGENT BUTTON: none of agentsettings.html
   or listagent.html exist yet (brief's four wireframe rulings), so this
   script renders neither. The agent's name is the row's only link, and it
   opens /agents/<did>, which is built and public.

   W7B WORK-OFFERED ATTENTION LINE: one additional read of
   GET /accounts/:did/incoming, fired once for the page (not once per
   row), grouped by agentDid. An agent's count is the number of its
   offers whose waitingOn is NOT waitingOnBuyer -- those are the ones
   waiting on the operator, which is what "waiting on a reply" means on
   the operator's own roster; an offer sitting with the buyer is not an
   attention item for them. A failed or non-200 incoming read leaves
   every row exactly as the roster call rendered it: no attention line,
   never a guessed count, the same never-invent-a-fact rule the
   per-agent proofStatus read above already follows.

   EVERYTHING THROUGH textContent: the agent's name and skills are
   operator-supplied and agent-supplied strings, content, never markup
   (api.js's own header rule). The avatar is the one exception, and it is
   not operator input at all: the creature is generated client-side by
   swarm.js from the DID alone, which reaches the generator as a number
   (FACore.hash) and never as a string in the emitted SVG. */
(function () {
  "use strict";
  var A = window.FAApi;
  var workOfferedCountByAgentDid = {};

  function start() {
    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }
    A.getAuthed("/accounts/me", session.token).then(function (meResult) {
      if (meResult.state !== "ok" || meResult.value.status !== 200) {
        failLoad("Your account could not be read just now. Reloading may work.");
        return;
      }
      var me = meResult.value.body && typeof meResult.value.body === "object" ? meResult.value.body : {};
      var did = typeof me.did === "string" ? me.did : "";
      if (did === "") {
        failLoad("Your account could not be read just now. Reloading may work.");
        return;
      }
      var rosterPromise = A.getAuthed("/accounts/" + encodeURIComponent(did) + "/agents", session.token);
      /* Fired once for the page, in parallel with the roster read, never
         once per row: a failed or non-200 read here leaves
         workOfferedCountByAgentDid empty, so every row renders exactly
         as the roster call already rendered it. Waited on alongside the
         roster read so renderRows never races an incoming read that has
         not resolved yet. */
      var incomingPromise = A.getAuthed("/accounts/" + encodeURIComponent(did) + "/incoming", session.token);
      Promise.all([rosterPromise, incomingPromise]).then(function (results) {
        workOfferedCountByAgentDid = countsByAgentDid(results[1]);
        onRosterLoaded(results[0]);
      });
    });
  }

  // Counts, per agent, the offers whose waitingOn is NOT waitingOnBuyer.
  // A failed or non-200 read (or a malformed body) returns an empty map,
  // never a guessed count.
  function countsByAgentDid(result) {
    if (result.state !== "ok" || result.value.status !== 200) return {};
    var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
    var offers = Array.isArray(body.offers) ? body.offers : [];
    var counts = {};
    offers.forEach(function (offer) {
      if (offer.waitingOn === "waitingOnBuyer") return;
      var agentDid = typeof offer.agentDid === "string" ? offer.agentDid : "";
      if (agentDid === "") return;
      counts[agentDid] = (counts[agentDid] || 0) + 1;
    });
    return counts;
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  function onRosterLoaded(result) {
    if (result.state !== "ok" || result.value.status !== 200) {
      failLoad("Your agents could not be loaded just now. Reloading may work.");
      return;
    }
    var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
    var agents = Array.isArray(body.agents) ? body.agents : [];
    A.showById("myagents-body", true);
    if (agents.length === 0) {
      A.showById("empty-state", true);
      A.showById("rows", false);
      return;
    }
    renderRows(agents);
  }

  function renderRows(agents) {
    var host = document.getElementById("rows");
    if (!host) return;
    host.textContent = "";
    agents.forEach(function (agent, i) {
      var row = agentRow(agent);
      row.style.setProperty("--i", String(i));
      host.appendChild(row);
      /* The per-agent read, one per row, fired after the row itself is
         already in the DOM: a slow or failed detail read must never hold
         up the counts the roster call already answered. */
      loadDetail(agent, row);
    });
    /* The tier glyphs. icons.js paints every [data-ico] host once on
       DOMContentLoaded and polish.js calls FAIcon.paint() again inside
       init(), both long before this roster read resolves, so the spans
       built above would stay empty forever without this repaint. Same
       guarded call agreement.js:165, operator.js:82 and dashboard.js:305
       already make for rows they render late. If it never runs, the span
       collapses and the pill's text still states the fact. */
    if (window.FAIcon) window.FAIcon.paint(host);
  }

  function agentRow(agent) {
    var row = document.createElement("div");
    row.className = "arow pane-lift";
    row.setAttribute("data-agent-row", agent.did);

    /* THE AVATAR MOUNT. data-avatar names the identity this box stands
       for, and it is set HERE, at row-build time, once the DID from the
       roster read is known. It is never written into the static shell:
       there is no DID to name before the read resolves, and an invented
       one would be a fabricated identity.

       The attribute has exactly one consumer in the whole app, polish.js's
       [data-avatar] sweep (polish.js:490), which runs once inside init()
       on DOMContentLoaded. That is before this fetch resolves, so the
       sweep is not what paints these rows and the attribute alone would
       leave the box empty forever. The creature is painted below, in
       loadDetail, the same set-then-paint pair agent.js:163-168,
       hire.js:89-93 and dashboard.js:396-408 already use.

       It still carries the attribute rather than skipping it, because it
       is the mount contract the rest of the system reads: a re-entrant
       sweep, a later repaint, or anything else looking for "which identity
       is this box" finds the answer on the element instead of nowhere. */
    var avatar = document.createElement("div");
    avatar.className = "rav";
    /* Guarded for the same reason dashboard.js:396-404 guards its own
       mount: an EMPTY data-avatar is not a neutral placeholder, it is a
       creature generated from the empty string, a face standing in for an
       identity nobody supplied. A row whose roster entry carries no DID
       keeps the 40px box for alignment and claims nothing. */
    if (typeof agent.did === "string" && agent.did !== "") {
      avatar.setAttribute("data-avatar", agent.did);
    }
    avatar.setAttribute("data-pending", "");
    row.appendChild(avatar);

    var body = document.createElement("div");

    var name = document.createElement("a");
    name.className = "nm";
    name.setAttribute("href", "/agents/" + encodeURIComponent(agent.did));
    name.textContent = typeof agent.name === "string" && agent.name !== "" ? agent.name : A.shortDid(agent.did);
    body.appendChild(name);

    /* Ruling 1: no description field exists on Agent (src/domain/agent.ts),
       so the .ds line renders the agent's skills instead, the same way
       operator.js's own roster row does. No skills, no line. */
    var skills = Array.isArray(agent.skills) ? agent.skills.filter(function (s) { return typeof s === "string" && s !== ""; }) : [];
    if (skills.length > 0) {
      var ds = document.createElement("div");
      ds.className = "ds";
      ds.textContent = skills.join("  \u00b7  ");
      body.appendChild(ds);
    }

    row.appendChild(body);

    // W7b: the work-offered attention line. Already known synchronously
    // at this point (Promise.all in start() resolves the incoming read
    // before onRosterLoaded, and therefore before renderRows, ever
    // runs), so this renders inline rather than through a second async
    // callback. Rendered before the async GitHub-not-confirmed check
    // below can run, so renderAttention inserts before it to keep the
    // wireframe's own order (GitHub first, myagents.html:83,97).
    var workOfferedCount = numberOr(workOfferedCountByAgentDid[agent.did]);
    if (workOfferedCount > 0) {
      var workOffered = document.createElement("div");
      workOffered.className = "attn";
      workOffered.appendChild(document.createTextNode("Work offered \u00b7 "));
      var incomingLink = document.createElement("a");
      incomingLink.href = "/incoming";
      incomingLink.textContent = A.plural(workOfferedCount, "job waiting on a reply", "jobs waiting on a reply");
      workOffered.appendChild(incomingLink);
      body.appendChild(workOffered);
    }

    var right = document.createElement("div");
    right.className = "right";

    var hireCount = numberOr(agent.verifiedHireCount);
    var priorCount = numberOr(agent.verifiedPriorWorkCount);
    var portfolioCount = numberOr(agent.portfolioCount);

    var tier = document.createElement("span");
    tier.className = "tier " + tierClassFor(hireCount, priorCount);
    /* The wireframe's tier pill carries a GLYPH, not base.css's pre-polish
       .dot (base.css:161). myagents.html:88, 102, 115 and 128 draw
       file-dash, shield-check, shield-check and link-2 respectively, which
       is the same tier-to-icon map agent.js:672-695 and browse.js:514-545
       already use, so one tier means one glyph everywhere on the site.
       polish.css:46 gives .ico its box and :74 sizes it to 13px inside a
       .tier; the glyph inherits the tier's colour through currentColor, so
       the accent stays welded to its one meaning. aria-hidden because the
       pill's own text already states the fact. */
    var icon = document.createElement("span");
    icon.className = "ico";
    icon.setAttribute("data-ico", tierIconFor(hireCount, priorCount));
    icon.setAttribute("aria-hidden", "true");
    tier.appendChild(icon);
    tier.appendChild(document.createTextNode(headlineFor(hireCount, priorCount)));
    right.appendChild(tier);

    var ev = document.createElement("span");
    ev.className = "ev";
    /* The wireframe's own copy (pixelforge/driftcheck/seamline/hatchmark
       rows): when the headline promotes to verified prior work, the
       evidence line reads "no hires yet" rather than restating the prior-
       work count the headline already carries. Every other case states
       both remaining figures plainly, zeros included (ENT-2.4). */
    var evPrior = hireCount === 0 && priorCount > 0
      ? "no hires yet"
      : A.plural(priorCount, "prior work", "prior work");
    ev.textContent = evPrior + " \u00b7 " + A.plural(portfolioCount, "claim", "claims");
    right.appendChild(ev);

    row.appendChild(right);

    return row;
  }

  /* Same tier colour rule agent.js and browse.js already key their tier
     pill on: verified hires first, then verified prior work, then claims,
     never a blended rank (MISSION invariant 5). */
  function tierClassFor(hireCount, priorCount) {
    if (hireCount > 0) return "tier-hire";
    if (priorCount > 0) return "tier-prior";
    return "tier-claim";
  }

  /* The glyph that goes with each tier, keyed off the same two counts as
     tierClassFor so the icon and the colour can never disagree. The three
     names are icons.js's own evidence-tier set: shield-check (we watched
     the whole thing), link-2 (mutual link, nobody here watched it) and
     file-dash (a dashed page, unproven). */
  function tierIconFor(hireCount, priorCount) {
    if (hireCount > 0) return "shield-check";
    if (priorCount > 0) return "link-2";
    return "file-dash";
  }

  function headlineFor(hireCount, priorCount) {
    if (hireCount > 0) return A.plural(hireCount, "verified hire", "verified hires");
    if (priorCount > 0) return A.plural(priorCount, "verified prior work", "verified prior work");
    return A.plural(0, "verified hire", "verified hires");
  }

  /* Ruling 3 (the "GitHub not confirmed" item DOES have a fact):
     proofStatus rides on agentProjection, read here, once per row. A
     failed read leaves the row exactly as the roster call rendered it --
     no attention line, never a guessed "confirmed" (claim-contradicts-
     implementation is the defect class this guards).

     THE AVATAR IS PAINTED BY THE SWARM GENERATOR, NOT THE SERVER'S
     agent.avatar FIELD. This is the one behavioural change the polished
     pass makes to this read. DESIGN.md 2.4 and ENT-2.3: an agent's
     creature is derived from its DID and nothing else. window.FASwarm is
     the generator the polished pages standardise on, and browse.js:405-418
     made exactly this swap for exactly this reason, naming this file's
     loadDetail as the shape it shares; agent.avatar is a separate, older
     server-rendered engine (src/api/avatar.ts's own header calls it a
     blobatar stand-in) that renders a different face for the same
     identity. Two engines meant an agent wore one face on its profile and
     a different one on its operator's roster.

     The DID is known before the fetch is even fired, so nothing about the
     face depends on the response. The read is still what gates the paint,
     because a row for an agent whose record cannot be read should not
     assert an identity this page could not confirm: a failed read leaves
     the box exactly as it started, data-pending and empty, never a partial
     or guessed creature. That is the same fail-honest rule every other
     read in this file follows. */
  function loadDetail(agent, row) {
    A.get("/agents/" + encodeURIComponent(agent.did)).then(function (result) {
      if (result.state !== "ok") return;
      var detail = result.value;
      paintAvatar(row, agent.did);
      if (detail.proofStatus !== "verified") renderAttention(row);
    });
  }

  /* 40px, the width .arow .rav reserves for the box in this page's own
     style block. Passed explicitly rather than measured, because the
     generator emits a fixed width and height on its SVG and a box that
     has not been laid out yet measures zero. */
  var AVATAR_SIZE = 40;

  function paintAvatar(row, did) {
    var host = row.querySelector(".rav");
    if (!host || !window.FASwarm) return;
    if (typeof did !== "string" || did === "") return;
    host.innerHTML = window.FASwarm.avatar(did, AVATAR_SIZE);
    host.removeAttribute("data-pending");
  }

  function renderAttention(row) {
    var body = row.children[1];
    if (!body) return;
    var attn = document.createElement("div");
    attn.className = "attn";
    attn.textContent = "GitHub not confirmed";
    // The wireframe's own order is GitHub first (myagents.html:83,97): a
    // row already carrying the work-offered line (rendered synchronously
    // in agentRow, before this async callback ever runs) gets GitHub
    // inserted ahead of it rather than appended after.
    var existing = body.querySelector(".attn");
    if (existing) {
      body.insertBefore(attn, existing);
    } else {
      body.appendChild(attn);
    }
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
