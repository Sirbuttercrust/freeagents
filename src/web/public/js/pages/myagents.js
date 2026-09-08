/* P8n my agents (P-18): a signed-in operator's own roster of everything
   they operate. Reads GET /accounts/me (the same departure P8m named for
   My jobs) to resolve the session to a DID, then GET /accounts/:did/agents
   for the roster (BrowseCard rows, already carrying the three tier counts
   this page never sums), then GET /agents/:agentDid once per row for
   proofStatus and the avatar -- the one fact and the one image BrowseCard
   does not carry (src/domain/browse.ts).

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

   NO SETTINGS LINK, NO WORK-OFFERED ATTENTION ITEM, NO LIST-AN-AGENT
   BUTTON: none of agentsettings.html, an open-work read, or listagent.html
   exist yet (brief's four wireframe rulings), so this script renders none
   of them. The agent's name is the row's only link, and it opens
   /agents/<did>, which is built and public.

   EVERYTHING THROUGH textContent: the agent's name and skills are
   operator-supplied and agent-supplied strings, content, never markup
   (api.js's own header rule). The avatar is the one exception, and it goes
   through A.setAvatar, the sanitiser that keeps only shape elements. */
(function () {
  "use strict";
  var A = window.FAApi;

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
      A.getAuthed("/accounts/" + encodeURIComponent(did) + "/agents", session.token).then(function (rosterResult) {
        onRosterLoaded(rosterResult);
      });
    });
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
  }

  function agentRow(agent) {
    var row = document.createElement("div");
    row.className = "arow pane-lift";
    row.setAttribute("data-agent-row", agent.did);

    var avatar = document.createElement("div");
    avatar.className = "rav";
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

    var right = document.createElement("div");
    right.className = "right";

    var hireCount = numberOr(agent.verifiedHireCount);
    var priorCount = numberOr(agent.verifiedPriorWorkCount);
    var portfolioCount = numberOr(agent.portfolioCount);

    var tier = document.createElement("span");
    tier.className = "tier " + tierClassFor(hireCount, priorCount);
    var dot = document.createElement("span");
    dot.className = "dot";
    tier.appendChild(dot);
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

  function headlineFor(hireCount, priorCount) {
    if (hireCount > 0) return A.plural(hireCount, "verified hire", "verified hires");
    if (priorCount > 0) return A.plural(priorCount, "verified prior work", "verified prior work");
    return A.plural(0, "verified hire", "verified hires");
  }

  /* Ruling 3 (the "GitHub not confirmed" item DOES have a fact):
     proofStatus rides on agentProjection, read here, once per row. A
     failed read leaves the row exactly as the roster call rendered it --
     no attention line, never a guessed "confirmed" (claim-contradicts-
     implementation is the defect class this guards). The avatar rides the
     same read: BrowseCard carries no avatar field at all. */
  function loadDetail(agent, row) {
    A.get("/agents/" + encodeURIComponent(agent.did)).then(function (result) {
      if (result.state !== "ok") return;
      var detail = result.value;
      var avatar = row.querySelector(".rav");
      if (avatar && typeof detail.avatar === "string") A.setAvatar(avatar, detail.avatar);
      if (detail.proofStatus !== "verified") renderAttention(row);
    });
  }

  function renderAttention(row) {
    var body = row.children[1];
    if (!body) return;
    var attn = document.createElement("div");
    attn.className = "attn";
    attn.textContent = "GitHub not confirmed";
    body.appendChild(attn);
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
