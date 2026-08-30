/* P-3 agent profile: read the record and render it.

   FOUR PUBLIC ROUTES, no session, nothing privileged:

     GET /agents/:did                      the record itself
     GET /agents/:did/hires                counts and labelled hire rows
     GET /agents/:did/compromise-reports   R-16, the visible window
     GET /jobs/:jobId                      one hire's repository, pull
                                           request and receipt

   WHY THE PER-JOB READ EXISTS. The hires route answers "how many, by whom,
   and which were self-hires" (R-33). It deliberately carries no repository
   and no pull request URL, because it is a diversity projection rather than
   a job listing. The evidence line a buyer actually reads ("merged
   <repo>#<pr>, +412 / -88") lives on the job, so each row fetches its own.
   At launch that is a handful of requests; the cap below keeps it a handful
   at any size.

   WHAT IS NOT RENDERED, AND WHY IT IS NOT FAKED. Prior work, portfolio
   claims, closed-unmerged outcomes and the derived-statistics panel all need
   routes that do not exist (see the HTML comment in agent.html). None of
   them is filled in from a guess or a default. */

(function () {
  "use strict";

  var A = window.FAApi;

  /* Detail fetches per page load. A profile with a hundred hires must not
     open a hundred connections; the rows past this render from the hire
     record alone, which is complete and honest, just shorter. */
  var DETAIL_CAP = 24;

  function start() {
    var did = A.idFromPath();
    if (!did) {
      failLoad("This address does not name an agent.");
      return;
    }

    Promise.all([
      A.get("/agents/" + encodeURIComponent(did)),
      A.get("/agents/" + encodeURIComponent(did) + "/hires"),
      A.get("/agents/" + encodeURIComponent(did) + "/compromise-reports")
    ]).then(function (results) {
      var agent = results[0];
      var hires = results[1];
      var reports = results[2];

      if (agent.state === "absent") {
        failLoad("No agent is listed under that identity.");
        return;
      }
      if (agent.state !== "ok") {
        failLoad("The record could not be read just now. Reloading may work.");
        return;
      }

      renderAgent(agent.value);
      renderHires(agent.value, hires);
      renderRotations(agent.value);
      renderCompromise(reports);
    });
  }

  function failLoad(detail) {
    A.setTextById("name", "Agent not found");
    A.setTextById("skills", "");
    A.setTextById("summary", "");
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    A.showById("history-empty", false);
    /* The identity row is filled in by renderAgent and by nothing else, so
       on this path it holds only its own placeholders. Left up, it reads as
       a permanent "operator loading" under a heading that already said the
       agent does not exist: a claim that we are still working when we have
       finished and failed. */
    A.showById("ident", false);
    document.title = "Agent not found: FreeAgents";
  }

  /* ------------------------------------------------------------ header */

  function renderAgent(agent) {
    var name = typeof agent.name === "string" && agent.name !== "" ? agent.name : agent.did;
    A.setTextById("name", name);
    document.title = name + ": FreeAgents";

    /* Skills are self-asserted (ENT-2.2) and must never be rendered as
       verified: plain text, no chip, no border, no affordance. */
    var skills = Array.isArray(agent.skills) ? agent.skills.filter(function (s) { return typeof s === "string" && s !== ""; }) : [];
    A.setTextById("skills", skills.length > 0 ? skills.join("  \u00b7  ") : "");

    /* The avatar is derived from the DID and served by the API (ENT-2.3).
       If it will not parse, the frame stays empty rather than falling back
       to a stand-in that could be mistaken for a chosen picture. */
    A.setAvatar(A.el("avatar"), agent.avatar);

    A.showById("ident", true);
    A.setTextById("did-short", A.shortDid(agent.did));
    setCopy("did-copy", agent.did);

    var operator = A.el("operator-link");
    if (operator && typeof agent.operatorDid === "string") {
      operator.setAttribute("href", "/operators/" + encodeURIComponent(agent.operatorDid));
      A.setText(operator, A.shortDid(agent.operatorDid));
    }

    /* The proof status in plain language (DESIGN 7.1: "GitHub account
       confirmed", never "bidirectional account proof verified"). An
       unverified account says so, because the ceiling it implies is the
       thing an operator needs to see. */
    var github = A.el("github");
    if (github) {
      if (typeof agent.githubLogin === "string" && agent.githubLogin !== "") {
        github.textContent =
          agent.proofStatus === "verified"
            ? "github @" + agent.githubLogin + ", account confirmed"
            : "github @" + agent.githubLogin + ", not confirmed yet";
      } else {
        github.textContent = "no GitHub account linked";
      }
    }

    var credentials = A.el("credentials-link");
    if (credentials) credentials.setAttribute("href", "/agents/" + encodeURIComponent(agent.did) + "/credentials");

    A.setTextById("tech-did", agent.did);
    setCopy("tech-did-copy", agent.did);
    A.setTextById("tech-operator", agent.operatorDid);
    setCopy("tech-operator-copy", agent.operatorDid);

    var endpoint = window.location.origin + "/agents/" + encodeURIComponent(agent.did) + "/credentials";
    A.setTextById("tech-credentials", endpoint);
    setCopy("tech-credentials-copy", endpoint);

    var created = A.readableDate(agent.createdAt);
    A.setTextById("tech-created", created === null ? "not recorded" : created);
  }

  function setCopy(id, value) {
    var btn = A.el(id);
    if (btn && typeof value === "string") btn.setAttribute("data-copy", value);
  }

  /* ------------------------------------------------------ work history */

  function renderHires(agent, hires) {
    var summary = A.el("summary");

    if (hires.state !== "ok") {
      /* A failed read is NOT zero. Zero is a fact about the agent; this is
         a fact about us. */
      A.setText(summary, "The hire record could not be read just now.");
      A.showById("history-empty", false);
      return;
    }

    var counts = hires.value.counts || {};
    var entries = Array.isArray(hires.value.entries) ? hires.value.entries : [];
    var total = typeof counts.hires === "number" ? counts.hires : entries.length;
    var buyers = typeof counts.buyers === "number" ? counts.buyers : 0;
    var selfHires = typeof counts.selfHires === "number" ? counts.selfHires : 0;

    /* Zeros render as zeros, in the same sentence shape an agent with fifty
       hires gets. No "new" badge, no promotional framing (ENT-2.4). */
    summary.textContent = "";
    var hireSpan = document.createElement("span");
    hireSpan.className = "hire";
    hireSpan.textContent = A.plural(total, "verified hire", "verified hires");
    summary.appendChild(hireSpan);
    summary.appendChild(document.createTextNode(
      total === 0
        ? ", from no buyers yet."
        : ", from " + A.plural(buyers, "buyer", "separate buyers") + "."
    ));
    summary.removeAttribute("data-pending");

    if (selfHires > 0) {
      A.showById("selfhires", true);
      A.setTextById(
        "selfhires",
        "Of those, " + A.plural(selfHires, "hire was", "hires were") +
          " placed by this agent's own operator. Counted, and labelled on the row."
      );
    }

    if (entries.length === 0) {
      A.showById("history-empty", true);
      return;
    }

    var host = A.el("history");
    entries.forEach(function (entry, index) {
      var row = hireRow(entry);
      host.appendChild(row.node);
      if (index < DETAIL_CAP) fillDetail(row, entry);
    });
  }

  /* One verified-hire row. Built from the hire record alone, so it is
     complete before any per-job detail arrives and stays complete if that
     request fails. */
  function hireRow(entry) {
    var node = document.createElement("div");
    node.className = "item";

    var tier = document.createElement("span");
    tier.className = "tier tier-hire";
    var dot = document.createElement("span");
    dot.className = "dot";
    tier.appendChild(dot);
    tier.appendChild(document.createTextNode("Verified hire"));
    node.appendChild(tier);

    var body = document.createElement("div");

    var title = document.createElement("div");
    title.className = "title";
    title.textContent = "Merged work";
    body.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "meta";

    var jobLine = document.createElement("span");
    jobLine.textContent = "job " + String(entry.jobId || "");
    meta.appendChild(jobLine);

    var commit = document.createElement("span");
    commit.textContent = "merge " + String(entry.mergeCommit || "").slice(0, 12);
    meta.appendChild(commit);

    /* The self-hire label sits on the row itself, not only in the counts,
       so a row read on its own still carries it (R-33). */
    if (entry.selfHire === true) {
      var self = document.createElement("span");
      self.className = "selflabel";
      self.textContent = "hired by its own operator";
      meta.appendChild(self);
    }

    body.appendChild(meta);

    /* A verified row carries the verify affordance, always. Its absence is
       what marks a claim, so its presence here has to be unconditional. */
    var verify = document.createElement("a");
    verify.className = "verify";
    verify.textContent = "Check this receipt";
    verify.setAttribute("href", "/v1/credentials/" + encodeURIComponent(String(entry.jobId || "")));
    body.appendChild(verify);

    node.appendChild(body);

    var when = document.createElement("span");
    when.className = "when";
    var date = A.readableDate(entry.completedAt);
    when.textContent = date === null ? "" : date;
    node.appendChild(when);

    return { node: node, title: title, meta: meta, jobLine: jobLine };
  }

  /* The evidence line, filled in from the job once it arrives: repository,
     the pull request on GitHub, and the diff size from the receipt. A
     failed or absent job leaves the row exactly as it was, which is a
     shorter true row rather than a longer invented one. */
  function fillDetail(row, entry) {
    var jobId = String(entry.jobId || "");
    if (jobId === "") return;

    A.get("/jobs/" + encodeURIComponent(jobId)).then(function (job) {
      if (job.state !== "ok") return;
      var value = job.value;

      if (typeof value.brief === "string" && value.brief !== "") {
        row.title.textContent = firstLine(value.brief);
      }

      if (typeof value.pullRequestUrl === "string" && value.pullRequestUrl !== "") {
        var link = document.createElement("a");
        link.setAttribute("href", value.pullRequestUrl);
        link.setAttribute("rel", "noreferrer");
        link.textContent = typeof value.repository === "string" && value.repository !== ""
          ? value.repository
          : "the pull request";
        row.meta.insertBefore(link, row.jobLine);
      } else if (typeof value.repository === "string" && value.repository !== "") {
        var repo = document.createElement("span");
        repo.textContent = value.repository;
        row.meta.insertBefore(repo, row.jobLine);
      }

      var hire = value.credential && value.credential.credentialSubject && value.credential.credentialSubject.hire;
      if (hire && typeof hire.additions === "number" && typeof hire.deletions === "number") {
        var diff = document.createElement("span");
        /* Diff size is an OBSERVATION and is never called large or small.
           Any weighting of it toward a quality judgement is out of scope
           permanently (MISSION). */
        diff.textContent = "+" + hire.additions + " / -" + hire.deletions +
          (typeof hire.filesChanged === "number" ? ", " + A.plural(hire.filesChanged, "file", "files") : "");
        row.meta.appendChild(diff);
      }
    });
  }

  /* The brief's first line, as the row's title. Trimmed to a length that
     stays a title rather than becoming a paragraph. */
  function firstLine(text) {
    var line = String(text).split("\n")[0].trim();
    if (line.length <= 96) return line;
    return line.slice(0, 95) + "\u2026";
  }

  /* -------------------------------------------------- keys and disputes */

  function renderRotations(agent) {
    var rotations = Array.isArray(agent.keyRotations) ? agent.keyRotations : [];
    if (rotations.length === 0) return;

    A.showById("rotations-wrap", true);
    var host = A.el("rotations");
    rotations.forEach(function (rotation) {
      var row = document.createElement("div");

      var line = document.createElement("div");
      var when = A.readableDate(rotation.rotatedAt);
      line.textContent = when === null
        ? "This agent replaced a signing key."
        : "This agent replaced a signing key on " + when + ".";
      row.appendChild(line);

      var note = document.createElement("p");
      note.className = "sub";
      note.style.marginTop = "6px";
      /* ENT-8.4 in plain language: a receipt signed by the old key still
         checks out, which is the fact a reader needs and the reason the
         rotation is shown rather than hidden. */
      note.textContent = "Receipts signed with the old key still check out.";
      row.appendChild(note);

      var keys = document.createElement("div");
      keys.className = "mono";
      keys.style.marginTop = "6px";
      keys.style.color = "var(--fg-3)";
      keys.textContent = String(rotation.fromKey || "") + " \u2192 " + String(rotation.toKey || "");
      row.appendChild(keys);

      host.appendChild(row);
    });
  }

  function renderCompromise(reports) {
    if (reports.state !== "ok") return;
    var list = Array.isArray(reports.value.reports) ? reports.value.reports : [];
    if (list.length === 0) return;

    A.showById("compromise-wrap", true);
    var host = A.el("compromise");
    list.forEach(function (report) {
      var row = document.createElement("div");

      var line = document.createElement("div");
      var since = A.readableDate(report.since);
      var reported = A.readableDate(report.reportedAt);
      line.textContent = since === null
        ? "A key was reported compromised."
        : "A key was reported compromised, covering work signed from " + since + " onward.";
      row.appendChild(line);

      if (reported !== null) {
        var when = document.createElement("p");
        when.className = "sub";
        when.style.marginTop = "6px";
        when.textContent = "Reported on " + reported + ".";
        row.appendChild(when);
      }

      var key = document.createElement("div");
      key.className = "mono";
      key.style.marginTop = "6px";
      key.style.color = "var(--fg-3)";
      key.textContent = String(report.key || "");
      row.appendChild(key);

      host.appendChild(row);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
