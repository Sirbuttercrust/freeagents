/* P8m my jobs (P-16): a signed-in buyer's own list of everything they
   have hired. Reads GET /accounts/me (this card's own departure, named
   in the handoff) to resolve the session to a DID, then
   GET /accounts/:did/jobs (src/api/app.ts). Rows carry a bucket the
   server already computed (src/domain/job-list.ts); this script filters
   by it and counts what it filters, never recomputing the rule.

   ONLY REAL JOBS APPEAR HERE. ENT-4.1: the route already excludes draft
   and proposed, so nothing here needs to re-check that.

   EVERYTHING THROUGH textContent: the brief, the repository and the
   agent name are all buyer/agent-supplied strings, content, never markup
   (api.js's own header rule). */
(function () {
  "use strict";
  var A = window.FAApi;
  var allJobs = [];
  var activeBucket = "all";

  var BUCKET_LABELS = {
    all: "All",
    waitingOnYou: "Waiting on you",
    inProgress: "In progress",
    shipped: "Shipped",
    notShipped: "Didn\u2019t ship",
  };
  var BUCKET_ORDER = ["all", "waitingOnYou", "inProgress", "shipped", "notShipped"];

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
      A.getAuthed("/accounts/" + encodeURIComponent(did) + "/jobs", session.token).then(function (jobsResult) {
        onLoaded(jobsResult);
      });
    });
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
  }

  function onLoaded(result) {
    if (result.state !== "ok" || result.value.status !== 200) {
      failLoad("Your jobs could not be loaded just now. Reloading may work.");
      return;
    }
    var body = result.value.body && typeof result.value.body === "object" ? result.value.body : {};
    allJobs = Array.isArray(body.jobs) ? body.jobs : [];
    A.showById("myjobs-body", true);
    if (allJobs.length === 0) {
      A.showById("empty-state", true);
      return;
    }
    renderChips();
    renderRows();
    wireChips();
  }

  // The four bucket counts sum to the All count BY CONSTRUCTION: every
  // row's bucket comes from the same job-list.ts rule the route already
  // ran, and this just tallies what is already there. Never a second
  // count computed a different way.
  function countsByBucket() {
    var counts = { all: allJobs.length, waitingOnYou: 0, inProgress: 0, shipped: 0, notShipped: 0 };
    allJobs.forEach(function (job) {
      if (Object.prototype.hasOwnProperty.call(counts, job.bucket)) counts[job.bucket] += 1;
    });
    return counts;
  }

  function renderChips() {
    var counts = countsByBucket();
    var host = document.querySelector(".filters");
    if (!host) return;
    BUCKET_ORDER.forEach(function (bucket) {
      var chip = host.querySelector('[data-bucket="' + bucket + '"]');
      if (!chip) return;
      chip.textContent = BUCKET_LABELS[bucket] + " " + counts[bucket];
    });
  }

  function rowsForActiveBucket() {
    if (activeBucket === "all") return allJobs;
    return allJobs.filter(function (job) { return job.bucket === activeBucket; });
  }

  function stateClassFor(bucket) {
    if (bucket === "shipped") return "state-done";
    if (bucket === "notShipped") return "state-none";
    return "state-live";
  }

  function trailTextFor(job) {
    var date = A.readableDate(job.date);
    if (job.bucket === "shipped") return date ? "Shipped " + date : "Shipped";
    if (job.bucket === "notShipped") return date ? "Closed " + date : "Closed";
    if (job.bucket === "waitingOnYou") return "Waiting on you";
    return date ? "In progress since " + date : "In progress";
  }

  function jobRow(job) {
    var a = document.createElement("a");
    a.className = "row between pane-lift";
    a.href = "/jobs/" + encodeURIComponent(job.id);

    var text = document.createElement("div");
    text.className = "rowtext";
    var t = document.createElement("div");
    t.className = "t";
    t.textContent = typeof job.brief === "string" && job.brief !== "" ? job.brief : job.id;
    var m = document.createElement("div");
    m.className = "m";
    var agentName = typeof job.agentName === "string" ? job.agentName : "";
    var repository = typeof job.repository === "string" ? job.repository : "";
    m.textContent = agentName !== "" && repository !== "" ? agentName + " \u00b7 " + repository : (agentName || repository);
    text.appendChild(t);
    text.appendChild(m);

    var trail = document.createElement("div");
    trail.className = "rowtrail";
    var state = document.createElement("span");
    state.className = "state " + stateClassFor(job.bucket);
    var dot = document.createElement("span");
    dot.className = "dot";
    state.appendChild(dot);
    state.appendChild(document.createTextNode(trailTextFor(job)));
    trail.appendChild(state);

    a.appendChild(text);
    a.appendChild(trail);
    return a;
  }

  function renderRows() {
    var host = document.getElementById("rows");
    if (!host) return;
    host.textContent = "";
    var rows = rowsForActiveBucket();
    A.showById("filter-empty", rows.length === 0);
    rows.forEach(function (job, i) {
      var row = jobRow(job);
      row.style.setProperty("--i", String(i));
      host.appendChild(row);
    });
  }

  function wireChips() {
    var chips = document.querySelectorAll(".filters .chip");
    Array.prototype.forEach.call(chips, function (chip) {
      chip.addEventListener("click", function () {
        activeBucket = chip.getAttribute("data-bucket") || "all";
        Array.prototype.forEach.call(chips, function (c) {
          c.setAttribute("aria-pressed", c === chip ? "true" : "false");
        });
        renderRows();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
