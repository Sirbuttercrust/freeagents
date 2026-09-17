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
      A.showById("filters", false);
      A.showById("rows", false);
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

  // The glyph beside the state words, mapped from the same bucket
  // stateClassFor() reads, so the icon and the colour class can never
  // disagree. The three names are the ones the wireframe pairs with those
  // three classes (spec/wireframe/myjobs.html:77, 98, 129), and all three
  // exist in icons.js (icons.js:52, 55, 56).
  //
  // This replaces a <span class="dot">. base.css:284 styles .state .dot as
  // a plain 6px disc; polish.css declares no .dot rule anywhere and keys
  // its state styling on .ico instead (polish.css:379-386, including the
  // live-job pulse, which gates on prefers-reduced-motion), so a row built
  // with a .dot would load the polished sheet and wear none of it.
  function stateIconFor(bucket) {
    if (bucket === "shipped") return "check-circle";
    if (bucket === "notShipped") return "minus-circle";
    return "dot-live";
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
    var ico = document.createElement("span");
    ico.className = "ico";
    ico.setAttribute("data-ico", stateIconFor(job.bucket));
    state.appendChild(ico);
    state.appendChild(document.createTextNode(trailTextFor(job)));
    trail.appendChild(state);

    // The wireframe's first row carries a second line here, "Write a
    // review" (spec/wireframe/myjobs.html:78). It is not built. Neither
    // review.html nor a /review route exists (src/web/static.ts contains
    // no "review"), and src/api/app.ts:172-174 records reviews as the hire
    // loop's last unbuilt stub, so the control would have no destination.
    // dashboard.html:259-264 refused the same control on the same grounds.
    //
    // Nothing excuses it in ALLOWED_ABSENT, and nothing needs to. The
    // conformance instrument extracts <button> and <a> only, and the
    // wireframe draws this as a <span> inside row one's anchor, so the
    // string is never asked for on its own; the anchor it sits in is
    // extracted as one 100-character run and dropped by the instrument's
    // own 60-character ceiling, like all six wireframe rows.

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
    // The state glyph in every trail jobRow() just built. icons.js paints
    // once at load (icons.js:127-131, both branches), before this page's
    // two fetches resolve, so a row rendered afterwards would keep an
    // empty span forever, including after a chip re-renders the list. The
    // same call dashboard.js:305, agreement.js:165 and operator.js:82
    // already make for rows they render late.
    if (window.FAIcon) window.FAIcon.paint(host);
  }

  // The five chips are wired here, directly, rather than by handing the bar
  // to polish.js's [data-pick] radio-group handler (polish.js:137-159). A
  // chip on this page has to filter the rows as well as move the pressed
  // state, and picks() only moves the state and raises a toast, so adding
  // the attribute would bind a second click handler to the same buttons and
  // fire a toast on every filter. browse.js:309-328 records the same
  // wired-directly stance on the identical .filters markup, for the same
  // reason, after a real defect.
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
