/* P-9 dashboard: a signed-in person's whole situation in one page, rebuilt
   on spec/wireframe/dashboard.html (W-dashboard). Reads GET /accounts/me
   (the same departure P8m, P8n and P8q each already named in their own
   handoffs) to resolve the session to a DID, then GET /accounts/:did/jobs,
   GET /accounts/:did/pending, GET /accounts/:did/incoming and
   GET /accounts/:did/agents fire together (ruling 1, W5 ruling).

   THE ROSTER READ IS UNCONDITIONAL (W5 ruling): accountProjection carries
   no operated-agent count, so the page cannot know whether it operates any
   agents without asking. A buyer who operates nothing still takes this
   read and gets an empty roster back.

   THE PER-AGENT READ IS SCOPED TO WHATEVER THE ROSTER RETURNED, exactly
   the departure myagents.js already named for the same route: BrowseCard
   carries no proofStatus (src/domain/browse.ts), so confirming GitHub for
   section 3's unproven-GitHub half needs GET /agents/:agentDid once per
   roster row, never fired speculatively and never more than once per row.
   /agents/:agentDid sits behind verifyRateLimiter at 60 requests per
   minute (src/api/app.ts), the same ceiling myagents.js's own handoff
   named.

   FOUR SECTIONS, NEVER RECOMPUTED. Every bucket a row carries
   (job.bucket from jobListBucketOf, pending.waitingOn from waitingOnOf)
   ran server side; this script only groups by it (ruling 1). Section 3's
   unproven-GitHub half reads two independent facts straight off the
   roster and the per-agent projection: never one inferred from the other
   (unverified-state-claim).

   THE SCOPE FENCE (ruling 8): rows render in the order the routes
   returned them, newest first where the section sorts by date, capped at
   five. No rank, no score, no elapsed time, no age, no badge count, no
   total across sections. A section's .secount is the number of rows that
   section is SHOWING, which can never disagree with what is on screen; a
   section whose read failed carries no count at all, because a failed
   read knows nothing to count.

   A SECTION WITH ZERO ROWS RENDERS NOTHING (ruling 4): no heading, no See
   all link. A FAILED READ RENDERS ITS OWN SENTENCE IN THE SECTION IT
   BREAKS, and never lets the page-level empty state fire
   (silent-success-on-failure): "nothing needs your attention" is a claim
   a failed read knows nothing about. A failed PER-AGENT read leaves that
   row exactly as the roster rendered it: no attention line, never a
   guessed "confirmed" (the same stance myagents.js:174-179 states).

   EVERY SECTION SHELL AND EVERY ROW SHAPE IS A <template> IN
   dashboard.html, cloned here (conformance-satisfied-by-dead-markup, W1
   round 2): the headings, the "See all" links and every control label a
   person sees are the same literal source the wireframe-conformance
   instrument scans, never a hand-typed duplicate string living only in
   this file.

   THE FIVE-STATE RAIL (W-dashboard). Section 2 draws SITEMAP.md P-13's
   five states, the same five job.html draws vertically, so the two
   screens share one vocabulary rather than each inventing its own. The
   stage is LOOKED UP from the status the route already computed, never
   guessed: a row whose status is not in the table below renders with no
   rail and no sentence rather than a stage nobody established
   (unverified-state-claim). The rail is aria-hidden because five stage
   names and a shape read aloud is less than one sentence; .flow-now
   underneath is that sentence, in real text, at every width.

   EVERYTHING THROUGH textContent: brief, repository and agentName are
   buyer-supplied and operator-supplied strings, content, never markup
   (api.js's own header rule). The one exception is the avatar, a canvas
   bots.js draws locally from a spec and a DID, the same call agent.js and
   agreement.js already make for the identical job. */
(function () {
  "use strict";
  var A = window.FAApi;
  var FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  var AVATAR_SIZE = 30;

  function start() {
    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }
    A.getAuthed("/accounts/me", session.token).then(function (meResult) {
      if (meResult.state === "ok" && meResult.value.status === 401) {
        A.showById("signin-required", true);
        return;
      }
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
      var encodedDid = encodeURIComponent(did);
      Promise.all([
        A.getAuthed("/accounts/" + encodedDid + "/jobs", session.token),
        A.getAuthed("/accounts/" + encodedDid + "/pending", session.token),
        A.getAuthed("/accounts/" + encodedDid + "/incoming", session.token),
        A.getAuthed("/accounts/" + encodedDid + "/agents", session.token),
      ]).then(onCoreLoaded);
    });
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  // A read is "ok" only on a real 200 with the expected array shape. Any
  // other outcome (network failure, a non-200 status, a malformed body)
  // is treated as a failed read for this section, never as an empty one.
  function readArray(result, field) {
    if (result.state !== "ok" || result.value.status !== 200) return null;
    var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
    return Array.isArray(body[field]) ? body[field] : null;
  }

  function numberOr(value) {
    return typeof value === "number" && !isNaN(value) ? value : 0;
  }

  function text(value) {
    return typeof value === "string" ? value : "";
  }

  function onCoreLoaded(results) {
    var jobs = readArray(results[0], "jobs");
    var pending = readArray(results[1], "pending");
    var offers = readArray(results[2], "offers");
    var rosterAgents = readArray(results[3], "agents");

    // The per-agent reads: exactly one per roster row, fired only when the
    // roster itself came back, and never fired at all when it did not
    // (no speculative read on a failed or absent roster).
    var agents = rosterAgents === null ? [] : rosterAgents;
    var detailPromises = agents.map(function (agent) {
      return A.get("/agents/" + encodeURIComponent(agent.did)).then(function (result) {
        return { did: agent.did, result: result };
      });
    });

    Promise.all(detailPromises).then(function (detailResults) {
      var detailByDid = {};
      detailResults.forEach(function (entry) {
        if (entry.result.state === "ok") detailByDid[entry.did] = entry.result.value;
      });
      onLoaded(jobs, pending, offers, rosterAgents, detailByDid);
    });
  }

  function onLoaded(jobs, pending, offers, rosterAgents, detailByDid) {
    A.showById("dashboard-body", true);

    var sections = [
      buildWaitingOnYou(jobs, pending),
      buildInProgress(jobs, pending),
      buildAttentionSection(rosterAgents, offers, detailByDid),
      buildRecentlyCompleted(jobs),
    ];

    var anyFailed = sections.some(function (s) { return s.failed; });
    var allEmpty = !anyFailed && sections.every(function (s) { return s.rows.length === 0; });

    if (allEmpty) {
      A.showById("page-empty-state", true);
      A.showById("grid-wrap", false);
      return;
    }

    A.showById("page-empty-state", false);
    A.showById("grid-wrap", true);
    renderGrid(sections);
  }

  /* ------------------------------------------------------- section data
     Every function below returns { failed, rows }. rows is empty when
     failed is true: a failed read contributes no row, only its own
     sentence, rendered by renderGrid. */

  function jobEntry(job) {
    return { kind: "job", at: Date.parse(job.date), job: job };
  }

  function pendingEntry(pending) {
    return { kind: "pending", at: Date.parse(pending.createdAt), pending: pending };
  }

  function sortNewestFirst(entries) {
    return entries.slice().sort(function (a, b) { return b.at - a.at; });
  }

  // Section 1 (ruling 1, ruling 2, ruling 3): waitingOnYou job rows plus
  // waitingOnBuyer pending rows, newest first, capped at five. The first
  // row whose source is a pending row carries the page's one primary.
  function buildWaitingOnYou(jobs, pending) {
    if (jobs === null || pending === null) return { failed: true, rows: [] };
    var jobRows = jobs.filter(function (j) { return j.bucket === "waitingOnYou"; }).map(jobEntry);
    var pendingRows = pending
      .filter(function (p) { return p.waitingOn === "waitingOnBuyer"; })
      .map(pendingEntry);
    var combined = sortNewestFirst(jobRows.concat(pendingRows)).slice(0, 5);
    var primaryAssigned = false;
    combined.forEach(function (entry) {
      if (!primaryAssigned && entry.kind === "pending") {
        entry.primary = true;
        primaryAssigned = true;
      }
    });
    return { failed: false, rows: combined };
  }

  // Section 2 (ruling 1, ruling 2): inProgress job rows plus noReply and
  // waitingOnOperator pending rows, newest first, capped at five. No
  // control at all on a pending row here (ruling 2).
  function buildInProgress(jobs, pending) {
    if (jobs === null || pending === null) return { failed: true, rows: [] };
    var jobRows = jobs.filter(function (j) { return j.bucket === "inProgress"; }).map(jobEntry);
    var pendingRows = pending
      .filter(function (p) { return p.waitingOn === "noReply" || p.waitingOn === "waitingOnOperator"; })
      .map(pendingEntry);
    var combined = sortNewestFirst(jobRows.concat(pendingRows)).slice(0, 5);
    return { failed: false, rows: combined };
  }

  // Section 3 (W5 ruling, handoff item 1): both halves SITEMAP P-9 names.
  // The unproven-GitHub half reads two independent facts per roster row,
  // never inferring one from the other: "no verified record yet" comes
  // straight off the roster's own BrowseCard (verifiedHireCount and
  // verifiedPriorWorkCount both zero), and "GitHub not confirmed" comes
  // from that row's own per-agent read (proofStatus !== "verified"). An
  // agent whose per-agent read failed carries no trail line at all: that
  // fact is unknown, never guessed as either confirmed or unconfirmed. A
  // row renders only when at least one half is true. The wireframe's
  // order (unproven-GitHub first, incoming offers second) is kept, and
  // the combined cap is five, not five of each. A failed roster read OR a
  // failed offers read fails the whole section, the same as every other
  // section here.
  function attentionRowFor(agent, detail) {
    var hireCount = numberOr(agent.verifiedHireCount);
    var priorCount = numberOr(agent.verifiedPriorWorkCount);
    var noRecord = hireCount === 0 && priorCount === 0;
    var notConfirmed = detail !== undefined && detail.proofStatus !== "verified";
    if (!noRecord && !notConfirmed) return null;
    return { kind: "attention", agent: agent, noRecord: noRecord, notConfirmed: notConfirmed };
  }

  function buildAttentionSection(rosterAgents, offers, detailByDid) {
    if (rosterAgents === null || offers === null) return { failed: true, rows: [] };
    var attentionRows = rosterAgents
      .map(function (agent) { return attentionRowFor(agent, detailByDid[agent.did]); })
      .filter(function (row) { return row !== null; });
    var offerRows = offers.map(function (offer) { return { kind: "offer", offer: offer }; });
    var combined = attentionRows.concat(offerRows).slice(0, 5);
    return { failed: false, rows: combined };
  }

  // Section 4 (ruling 5): only shipped/notShipped rows whose date is
  // known and within 14 days of now, newest first, capped at five. A
  // dateless closed job (declined, closed_unmerged, stale, withdrawn,
  // staged_declined, closed_unpaid, expired_unstaged) is never guessed
  // into a window (unverified-state-claim).
  function buildRecentlyCompleted(jobs) {
    if (jobs === null) return { failed: true, rows: [] };
    var now = Date.now();
    var rows = jobs
      .filter(function (j) { return j.bucket === "shipped" || j.bucket === "notShipped"; })
      .filter(function (j) { return typeof j.date === "string" && j.date !== ""; })
      .map(jobEntry)
      .filter(function (entry) { return !isNaN(entry.at) && now - entry.at >= 0 && now - entry.at <= FOURTEEN_DAYS_MS; });
    return { failed: false, rows: sortNewestFirst(rows).slice(0, 5) };
  }

  /* --------------------------------------------------------------- grid
     Each section is built fresh into the DOM only when it has something
     to show (a row, or a failure sentence): ruling 4 means a truly empty,
     non-failed section contributes no node at all, not a hidden one.

     THE FOUR SHELLS ARE NOT INTERCHANGEABLE, which is the shape change
     this rebuild is about (the wireframe's own words: "Four identical
     panels say the four things are equally urgent, which is false").
     Sections 1 and 2 are .dspan-12 and hold horizontal content, so their
     rows land in a .dcards grid and a .jobstack; sections 3 and 4 are
     .dspan-6 panes whose rows land in .rows. The container each shell
     fills is named beside its template id rather than assumed. */

  var SECTIONS = [
    { template: "tmpl-section-waiting", rows: ".dcards" },
    { template: "tmpl-section-inprogress", rows: ".jobstack" },
    { template: "tmpl-section-attention", rows: ".rows" },
    { template: "tmpl-section-completed", rows: ".rows" },
  ];

  function renderGrid(sections) {
    var host = A.el("dgrid");
    if (!host) return;
    host.textContent = "";
    sections.forEach(function (section, i) {
      if (!section.failed && section.rows.length === 0) return;
      host.appendChild(sectionPane(SECTIONS[i], section, i));
    });
    /* The glyphs section 4's state trails carry. icons.js paints once at
       load, before any of these rows exist, so this page repaints the
       subtree it just built, the same call agreement.js:165 and
       operator.js:82 already make for rows they render late. */
    if (window.FAIcon) window.FAIcon.paint(host);
  }

  function clone(templateId) {
    var tmpl = A.el(templateId);
    return tmpl.content.firstElementChild.cloneNode(true);
  }

  function sectionPane(shell, section, index) {
    var el = clone(shell.template);
    el.setAttribute("data-section", String(index));

    var count = el.querySelector(".secount");
    var rows = el.querySelector(shell.rows);

    if (section.failed) {
      // No count on a failed section: a read that did not answer knows
      // nothing to count, and a "0" here would be a claim about data
      // nobody has (unverified-state-claim).
      if (count && count.parentNode) count.parentNode.removeChild(count);
      var sentence = document.createElement("p");
      sentence.className = "sub";
      sentence.textContent = "This section could not be loaded just now. Reloading may work.";
      rows.appendChild(sentence);
      return el;
    }

    if (count) count.textContent = String(section.rows.length);
    section.rows.forEach(function (entry, i) {
      var row = rowFor(entry);
      // The stagger delay base.css reads (--i, capped at 6 there). The
      // wireframe writes it per card; this writes the same thing from
      // the row's own position.
      row.style.setProperty("--i", String(i));
      rows.appendChild(row);
    });
    return el;
  }

  function rowFor(entry) {
    if (entry.kind === "job") return jobRow(entry.job);
    if (entry.kind === "pending") return pendingRow(entry.pending, entry.primary === true);
    if (entry.kind === "attention") return attentionRow(entry);
    return offerRow(entry.offer);
  }

  /* ------------------------------------------------------------ rows */

  function rowText(t, m) {
    var node = document.createElement("div");
    node.className = "rowtext";
    var tEl = document.createElement("div");
    tEl.className = "t";
    tEl.textContent = t;
    var mEl = document.createElement("div");
    mEl.className = "m";
    mEl.textContent = m;
    node.appendChild(tEl);
    node.appendChild(mEl);
    return node;
  }

  function agentRepoLine(agentName, repository) {
    var name = text(agentName);
    var repo = text(repository);
    return name !== "" && repo !== "" ? name + " \u00b7 " + repo : (name || repo);
  }

  function joinSentences(parts) {
    return parts.filter(function (p) { return p !== ""; }).join(". ");
  }

  function fill(card, title, meta) {
    card.querySelector(".t").textContent = title;
    card.querySelector(".m").textContent = meta;
    return card;
  }

  /* THE AVATAR MOUNT. polish.js's generic [data-avatar] sweep runs once at
     load, before any of these reads resolve, so the bot is mounted here the
     moment the DID is known. bots.js (window.FABots) draws the bot the
     row's avatarSpec names (AV2: /pending and /incoming rows carry one),
     or the DID default when the row carries none. A job row works while
     its job is in progress, the one place this page knows that; a pending
     row does not, because nothing has been agreed yet.

     THE DID IS NOT ALWAYS THERE, and that is not a bug to paper over.
     GET /accounts/:did/pending, /incoming and /agents each carry
     agentDid; GET /accounts/:did/jobs carries agentName and no DID
     (src/api/app.ts). A row with no DID loses its mount entirely rather
     than carrying an empty one: an empty .jobav is a 30px grey disc
     standing in for an identity nobody supplied. Never invent a DID and
     never derive one from a name. */
  function mountAvatar(host, did, spec, state) {
    if (!host) return;
    var value = text(did);
    if (value === "") {
      // No DID from this read. The box stays for alignment (dashboard.html
      // explains the measurement) and carries no data-avatar: the engine
      // has nothing to paint and this page claims nothing.
      host.classList.add("is-unknown");
      return;
    }
    host.setAttribute("data-avatar", value);
    if (window.FABots) window.FABots.mount(host, value, { spec: spec, size: AVATAR_SIZE, state: state });
  }

  /* ---------------------------------------------------- section 1 rows

     Two cards rather than two rows (the wireframe's own reason: each one
     is a decision with a consequence, and a row treats it as an item in
     a list). The one primary action on the page sits on the first card
     whose source is a pending row waiting on this reader's signature. */

  function jobCard(job) {
    var card = clone("tmpl-dcard-job");
    card.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    var title = text(job.brief) !== "" ? job.brief : job.id;
    return fill(card, title, agentRepoLine(job.agentName, job.repository));
  }

  function pendingCard(pending, primary) {
    var title = text(pending.brief) !== "" ? pending.brief : pending.id;
    var meta = joinSentences([agentRepoLine(pending.agentName, pending.repository), "Waiting on your signature"]);
    var href = "/agreement?job=" + encodeURIComponent(pending.id);

    if (!primary) {
      var card = clone("tmpl-dcard-agreement");
      card.setAttribute("href", href);
      return fill(card, title, meta);
    }

    // Ruling 3: the page's one primary, cloned from tmpl-primary-sign in
    // dashboard.html rather than hand-built, so the button text this file
    // writes and the text the conformance instrument scans are the same
    // literal source.
    var primaryCard = clone("tmpl-dcard");
    fill(primaryCard, title, meta);
    var signLink = clone("tmpl-primary-sign");
    signLink.setAttribute("href", href);
    primaryCard.querySelector(".foot").appendChild(signLink);
    return primaryCard;
  }

  /* ---------------------------------------------------- section 2 rows

     THE FIVE STAGES ARE LOOKED UP, NEVER GUESSED. SITEMAP.md P-13 defines
     the track as brief, criteria, confirmed, pull request open, shipped,
     and job.html already draws exactly those five vertically. The table
     below maps the state the routes already computed onto a stage index
     into that rail, and nothing else reaches it: no new read, no derived
     state, no stage inferred from a date.

     Section 2 holds exactly four kinds of row. Two are pending
     (waitingOnOf, src/domain/incoming.ts: noReply and waitingOnOperator,
     both of which mean the criteria are not agreed yet) and two are jobs
     (jobListBucketOf's inProgress: confirmed and redo_requested, both of
     which mean the next move belongs to the operator, which is exactly
     what that function's own comment says). A row whose state is not one
     of these four renders its head with no rail and no sentence: an
     unmapped state is a state nobody established, and drawing a stage for
     it would be an unverified-state-claim. */

  var PENDING_STAGE = {
    noReply: { now: 1, sentence: "Brief sent, no reply yet" },
    waitingOnOperator: { now: 1, sentence: "Waiting on the agent to sign" },
  };

  var JOB_STAGE = {
    confirmed: { now: 2, sentence: "Confirmed, no pull request yet", when: "confirmed " },
    redo_requested: { now: 2, sentence: "A redo was asked for, back with the agent", when: "asked " },
  };

  // The rail: every step before the current one is done, the current one
  // carries the travelling light. The light is neutral white and never
  // the accent (DESIGN.md 2.2, and pipeline.css's own header): --accent
  // means "we watched this happen", and work in flight has not happened,
  // so the only node permitted accent is a merge that actually landed.
  //
  // WHOSE MOVE IT IS goes with the rail rather than living in the shell,
  // because it is the same claim in fewer words. All four states this
  // section can hold are waiting on the agent: the two pending ones have
  // criteria the agent has not signed (waitingOnOf, src/domain/incoming.ts)
  // and the two job ones are jobListBucketOf's inProgress, whose own
  // comment reads "the next move belongs to the operator". That is true
  // of the four, not of the section, so it is written beside the lookup
  // that establishes it and it leaves with the rail when a state is not
  // in the table. A row nobody can place says nothing about whose turn
  // it is (unverified-state-claim).
  function drawFlow(row, stage) {
    var flow = row.querySelector(".flow");
    var now = row.querySelector(".flow-now");
    var turn = row.querySelector(".jobrow-turn");
    if (!flow || !now) return;

    if (stage === null) {
      flow.parentNode.removeChild(flow);
      now.parentNode.removeChild(now);
      if (turn && turn.parentNode) turn.parentNode.removeChild(turn);
      return;
    }

    var steps = flow.querySelectorAll(".flow-step");
    for (var i = 0; i < steps.length; i += 1) {
      if (i < stage.now) steps[i].classList.add("is-done");
      if (i === stage.now) {
        steps[i].classList.add("is-now");
        var line = steps[i].querySelector(".flow-line");
        if (line) line.appendChild(clone("tmpl-flow-spark"));
      }
    }

    now.querySelector("b").textContent = stage.sentence;
    var when = now.querySelector(".when");
    if (stage.when === "") {
      when.parentNode.removeChild(when);
      return;
    }
    when.textContent = stage.when;
  }

  function fillJobHead(row, title, agentName, did, spec, state) {
    var id = row.querySelector(".jobrow-id");
    id.querySelector(".t").textContent = title;
    id.querySelector(".m").textContent = agentName;
    mountAvatar(row.querySelector(".jobav"), did, spec, state);
    return row;
  }

  function progressJobRow(job) {
    var stage = Object.prototype.hasOwnProperty.call(JOB_STAGE, job.status) ? JOB_STAGE[job.status] : null;
    var row = clone("tmpl-jobrow-link");
    row.setAttribute("href", "/jobs/" + encodeURIComponent(job.id));
    var title = text(job.repository) !== "" ? job.repository : (text(job.brief) !== "" ? job.brief : job.id);
    // GET /accounts/:did/jobs carries no agentDid today, so these rows
    // render with no mount until it does (the card in flight on
    // src/api adds it, and this page lights up with no edit here).
    fillJobHead(row, title, text(job.agentName), job.agentDid, job.avatarSpec,
      window.FABots ? window.FABots.stateForJob(job.status) : "default");
    var date = A.readableDate(job.date);
    drawFlow(row, stage === null ? null : {
      now: stage.now,
      sentence: stage.sentence,
      when: date === null ? "" : stage.when + date,
    });
    return row;
  }

  function progressPendingRow(pending) {
    var stage = Object.prototype.hasOwnProperty.call(PENDING_STAGE, pending.waitingOn)
      ? PENDING_STAGE[pending.waitingOn]
      : null;
    // Ruling 2: no anchor and no button on a pending row here, the same
    // inert-declared-control stance incoming.js's own ruling 1 takes.
    var row = clone("tmpl-jobrow");
    var title = text(pending.repository) !== "" ? pending.repository : (text(pending.brief) !== "" ? pending.brief : pending.id);
    fillJobHead(row, title, text(pending.agentName), pending.agentDid, pending.avatarSpec, "default");
    var date = A.readableDate(pending.createdAt);
    drawFlow(row, stage === null ? null : {
      now: stage.now,
      sentence: stage.sentence,
      when: date === null ? "" : "sent " + date,
    });
    return row;
  }

  /* ------------------------------------------------ sections 1, 2 and 4

     A job row is a real hire, ENT-4.1 already filtered to. In sections 1
     and 2 it is a card or a track; in section 4 it is a row in a list.
     Every one of them is a full-element link to /jobs/:id, the screen
     that holds the record. */

  function jobRow(job) {
    if (job.bucket === "waitingOnYou") return jobCard(job);
    if (job.bucket === "inProgress") return progressJobRow(job);
    return completedRow(job);
  }

  function pendingRow(pending, primary) {
    if (pending.waitingOn === "waitingOnBuyer") return pendingCard(pending, primary);
    return progressPendingRow(pending);
  }

  // Section 4's state trail, in the wireframe's own vocabulary: a glyph
  // and a word, so the two outcomes are told apart by shape as well as
  // by colour. The date is an absolute one and it sits in the meta line
  // beside the agent and repository, never an elapsed "3 days ago"
  // (the scope fence above, and done-means 15).
  function completedRow(job) {
    var shipped = job.bucket === "shipped";
    var a = document.createElement("a");
    a.className = "row between pane-lift";
    a.href = "/jobs/" + encodeURIComponent(job.id);
    var title = text(job.brief) !== "" ? job.brief : job.id;
    var date = A.readableDate(job.date);
    var meta = agentRepoLine(job.agentName, job.repository);
    a.appendChild(rowText(title, date === null ? meta : joinSentences([meta, date])));

    var trail = document.createElement("span");
    trail.className = "rowtrail";
    var state = document.createElement("span");
    state.className = "state " + (shipped ? "state-done" : "state-none");
    var ico = document.createElement("span");
    ico.className = "ico";
    ico.setAttribute("data-ico", shipped ? "check-circle" : "minus-circle");
    state.appendChild(ico);
    state.appendChild(document.createTextNode(shipped ? "Shipped" : "Not shipped"));
    trail.appendChild(state);
    a.appendChild(trail);
    return a;
  }

  /* ---------------------------------------------------- section 3 rows */

  // The unproven-GitHub half of section 3 (W5 ruling, handoff item 1): a
  // full-row link to /agents/:did, the screen that holds this agent's own
  // record. The wireframe's own row links to provegithub.html, which is
  // not built or mounted anywhere in src/web (no route in static.ts): the
  // same substitution myagents.js already made for the identical fact,
  // there rendered as inert text with no link at all. This row still
  // needs a destination (it is a door, the wireframe's own words), so it
  // goes to the agent's own profile, the nearest built page that holds
  // the fact this row is about. Named in the PR body as a departure.
  function attentionRow(entry) {
    var a = document.createElement("a");
    a.className = "row between pane-lift";
    a.href = "/agents/" + encodeURIComponent(entry.agent.did);
    var name = text(entry.agent.name) !== "" ? entry.agent.name : A.shortDid(entry.agent.did);
    var meta = entry.noRecord ? "no verified record yet" : "";
    a.appendChild(rowText(name, meta));
    if (entry.notConfirmed) {
      var trail = document.createElement("span");
      trail.className = "rowtrail";
      trail.textContent = "GitHub not confirmed";
      a.appendChild(trail);
    }
    return a;
  }

  // An incoming-offer row (section 3): P8v mounted P-25 (operatorjob.html)
  // at /operatorjob, so this row now links to the same operator job page
  // incoming.js's own rows link to, superseding P8q's own note about no
  // per-offer record page existing yet.
  var OFFER_STATE_TEXT = {
    noReply: "New, nothing sent back yet",
    waitingOnBuyer: "Sent, waiting on the buyer",
    waitingOnOperator: "Buyer proposed a change, waiting on you",
  };

  function offerRow(offer) {
    var a = document.createElement("a");
    a.className = "row between pane-lift";
    a.href = "/operatorjob?job=" + encodeURIComponent(offer.id);
    var name = text(offer.agentName) !== "" ? offer.agentName : A.shortDid(offer.agentDid);
    a.appendChild(rowText(name, text(offer.repository)));
    var trail = document.createElement("span");
    trail.className = "rowtrail";
    trail.textContent = OFFER_STATE_TEXT[offer.waitingOn] || OFFER_STATE_TEXT.noReply;
    a.appendChild(trail);
    return a;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
