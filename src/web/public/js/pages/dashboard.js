/* P8u dashboard (P-9): a signed-in person's whole situation in one page,
   from spec/wireframe/dashboard.html. Reads GET /accounts/me (the same
   departure P8m, P8n and P8q each already named in their own handoffs) to
   resolve the session to a DID, then GET /accounts/:did/jobs,
   GET /accounts/:did/pending and GET /accounts/:did/incoming fire together
   (ruling 1). No per-agent read, no fifth read, no read this page's own
   buckets did not already come pre-computed from.

   FOUR SECTIONS, NEVER RECOMPUTED. Every bucket a row carries
   (job.bucket from jobListBucketOf, pending.waitingOn from waitingOnOf)
   ran server side; this script only groups by it (ruling 1).

   THE SCOPE FENCE (ruling 8): rows render in the order the routes
   returned them, newest first, capped at five. No rank, no score, no
   elapsed time, no age, no badge count, no total across sections.

   A SECTION WITH ZERO ROWS RENDERS NOTHING (ruling 4): no heading, no See
   all link. A FAILED READ RENDERS ITS OWN SENTENCE IN THE SECTION IT
   BREAKS, and never lets the page-level empty state fire
   (silent-success-on-failure): "nothing needs your attention" is a claim
   a failed read knows nothing about.

   EVERYTHING THROUGH textContent: brief, repository and agentName are
   buyer-supplied and operator-supplied strings, content, never markup
   (api.js's own header rule). */
(function () {
  "use strict";
  var A = window.FAApi;
  var FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

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
      ]).then(onLoaded);
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

  function onLoaded(results) {
    var jobs = readArray(results[0], "jobs");
    var pending = readArray(results[1], "pending");
    var offers = readArray(results[2], "offers");

    A.showById("dashboard-body", true);

    var sections = [
      buildWaitingOnYou(jobs, pending),
      buildInProgress(jobs, pending),
      buildIncomingSection(offers),
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

  // Section 3 (ruling 1): every incoming offer, already newest first at
  // the route (src/api/app.ts), capped at five here. Never re-sorted.
  function buildIncomingSection(offers) {
    if (offers === null) return { failed: true, rows: [] };
    var rows = offers.slice(0, 5).map(function (offer) { return { kind: "offer", offer: offer }; });
    return { failed: false, rows: rows };
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
     non-failed section contributes no node at all, not a hidden one. */

  var SECTION_META = [
    { heading: "Waiting on you", seeAll: "/myjobs" },
    { heading: "In progress", seeAll: "/myjobs" },
    { heading: "Your agents need attention", seeAll: "/incoming" },
    { heading: "Recently completed", seeAll: "/myjobs" },
  ];

  function renderGrid(sections) {
    var host = A.el("dgrid");
    if (!host) return;
    host.textContent = "";
    sections.forEach(function (section, i) {
      if (!section.failed && section.rows.length === 0) return;
      host.appendChild(sectionPane(SECTION_META[i], section, i));
    });
  }

  function sectionPane(meta, section, index) {
    var el = document.createElement("section");
    el.className = "pane pane-pad reveal";
    el.setAttribute("data-reveal", "");
    el.setAttribute("data-section", String(index));

    var between = document.createElement("div");
    between.className = "between";
    var h2 = document.createElement("h2");
    h2.style.margin = "0";
    h2.textContent = meta.heading;
    between.appendChild(h2);
    var seeAll = document.createElement("a");
    seeAll.className = "small seeall";
    seeAll.style.color = "var(--fg-2)";
    seeAll.href = meta.seeAll;
    seeAll.textContent = "See all \u2192";
    between.appendChild(seeAll);
    el.appendChild(between);

    var rows = document.createElement("div");
    rows.className = "rows";
    rows.style.marginTop = "14px";

    if (section.failed) {
      var sentence = document.createElement("p");
      sentence.className = "sub";
      sentence.textContent = "This section could not be loaded just now. Reloading may work.";
      rows.appendChild(sentence);
    } else {
      section.rows.forEach(function (entry) { rows.appendChild(rowFor(entry)); });
    }
    el.appendChild(rows);
    return el;
  }

  function rowFor(entry) {
    if (entry.kind === "job") return jobRow(entry.job);
    if (entry.kind === "pending") return pendingRow(entry.pending, entry.primary === true);
    return offerRow(entry.offer);
  }

  /* ------------------------------------------------------------ rows */

  function rowText(t, m) {
    var text = document.createElement("div");
    text.className = "rowtext";
    var tEl = document.createElement("div");
    tEl.className = "t";
    tEl.textContent = t;
    var mEl = document.createElement("div");
    mEl.className = "m";
    mEl.textContent = m;
    text.appendChild(tEl);
    text.appendChild(mEl);
    return text;
  }

  function agentRepoLine(agentName, repository) {
    var name = typeof agentName === "string" ? agentName : "";
    var repo = typeof repository === "string" ? repository : "";
    return name !== "" && repo !== "" ? name + " \u00b7 " + repo : (name || repo);
  }

  // A job row (sections 1, 2 and 4): a real hire, ENT-4.1 already
  // filtered to. Every job row is a full-row link to /jobs/:id, the
  // screen that holds the record (the anchor's own words).
  function jobRow(job) {
    var a = document.createElement("a");
    a.className = "row between";
    a.href = "/jobs/" + encodeURIComponent(job.id);
    var title = typeof job.brief === "string" && job.brief !== "" ? job.brief : job.id;
    a.appendChild(rowText(title, agentRepoLine(job.agentName, job.repository)));

    var trail = document.createElement("span");
    trail.className = "rowtrail";
    if (job.bucket === "shipped" || job.bucket === "notShipped") {
      var state = document.createElement("span");
      state.className = "state " + (job.bucket === "shipped" ? "state-done" : "state-none");
      var dot = document.createElement("span");
      dot.className = "dot";
      state.appendChild(dot);
      var date = A.readableDate(job.date);
      state.appendChild(document.createTextNode(
        job.bucket === "shipped" ? (date ? "Shipped " + date : "Shipped") : (date ? "Closed " + date : "Closed"),
      ));
      trail.appendChild(state);
    } else if (job.bucket === "inProgress") {
      var progressDate = A.readableDate(job.date);
      trail.textContent = progressDate ? "In progress since " + progressDate : "In progress";
    } else {
      trail.textContent = "Waiting on you";
    }
    a.appendChild(trail);
    return a;
  }

  // A pending row (sections 1 and 2, ruling 2): not a hire, never linked
  // to /jobs/:id. Section 1's first waitingOnBuyer row carries the page's
  // one primary (ruling 3); every other pending row here is a plain row,
  // and a section-2 pending row carries no control at all.
  function pendingRow(pending, primary) {
    var title = typeof pending.brief === "string" && pending.brief !== "" ? pending.brief : pending.id;
    var meta = agentRepoLine(pending.agentName, pending.repository);

    if (primary) {
      var wrap = document.createElement("div");
      wrap.className = "between";
      wrap.appendChild(rowText(title, meta));
      var signLink = document.createElement("a");
      signLink.className = "btn btn-sm btn-primary";
      signLink.href = "/agreement?job=" + encodeURIComponent(pending.id);
      signLink.textContent = "Read and sign";
      wrap.appendChild(signLink);
      return wrap;
    }

    if (pending.waitingOn === "waitingOnBuyer") {
      var link = document.createElement("a");
      link.className = "row between";
      link.href = "/agreement?job=" + encodeURIComponent(pending.id);
      link.appendChild(rowText(title, meta));
      var linkTrail = document.createElement("span");
      linkTrail.className = "rowtrail";
      linkTrail.textContent = "Waiting on your signature";
      link.appendChild(linkTrail);
      return link;
    }

    // Section 2: no anchor, no button (ruling 2, the same
    // inert-declared-control stance incoming.js's own ruling 1 takes).
    var plain = document.createElement("div");
    plain.className = "row between";
    plain.appendChild(rowText(title, meta));
    var plainTrail = document.createElement("span");
    plainTrail.className = "rowtrail";
    plainTrail.textContent = pending.waitingOn === "noReply" ? "Brief sent, no reply yet" : "Waiting on the agent to sign";
    plain.appendChild(plainTrail);
    return plain;
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
    a.className = "row between";
    a.href = "/operatorjob?job=" + encodeURIComponent(offer.id);
    var name = typeof offer.agentName === "string" && offer.agentName !== "" ? offer.agentName : A.shortDid(offer.agentDid);
    a.appendChild(rowText(name, typeof offer.repository === "string" ? offer.repository : ""));
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
