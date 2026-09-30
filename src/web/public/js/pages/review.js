/* FIX-SW12m: write a review (SITEMAP P-17, ENT-10). The buyer of a
   completed hire writes one review of it, in words, from /review?job=<id>.
   There is no star, no rating and no score anywhere on this page
   (ENT-10.2), and nothing here counts reviews.

   READS, in this order, each only if the one before it allows:
   1. GET /jobs/:jobId (public). Absent shows "We could not find that
      hire", unreachable shows the reload sentence. A job that is not
      completed shows why it cannot be reviewed: still in flight ("once the
      work merges") or ended some other way, deemed_completed included,
      since the write route accepts only completed (src/domain/review.ts).
   2. The stored session. None shows the Sign in state; nav.js remembers
      this page when Sign in is pressed, so signing in comes back here.
   3. GET /accounts/me. A 401 is the Sign in state again; any other
      failure is the reload sentence; a did that is not the job's buyerDid,
      compared exactly, shows "Only the person who hired this agent...".
   4. GET /agents/:agentDid/reviews, filtered on this jobId (no route reads
      one job's review). A review already there is shown read-only; no
      review shows the form; a failed read is the reload sentence.
   One more read never blocks anything: GET /agents/:agentDid for the
   agent's name in the sub line, which reads "this agent" without it.

   The write route refuses everyone but this buyer whatever this page
   shows (POST /jobs/:jobId/reviews, src/api/app.ts), so hiding the form is
   a courtesy, never the guard.

   THE WRITE. Post review sends one POST /jobs/:jobId/reviews with
   { agentDid: job.agentDid, text } on the session's bearer token, the
   button disabled while it runs. Blank text is refused here first and
   sends nothing. A 201 replaces the form with the posted review, read
   back from the route's answer. Any refusal writes one sentence into
   #form-error, which is role="alert" in the shell from the start, and
   leaves the typed text where it was.

   Every state but the form removes the form from the page, so no
   textarea and no Post review button exist in it. */
(function () {
  "use strict";
  var A = window.FAApi;
  var job = null;
  var sending = false;

  var TERMINAL_UNREVIEWABLE = [
    "declined", "closed_unmerged", "withdrawn", "staged_declined",
    "closed_unpaid", "expired_unstaged", "deemed_completed", "cited_closed"
  ];

  var SENTENCES = {
    inFlight: "You can review this hire once the work merges.",
    ended: "Only a hire whose work merged can be reviewed.",
    blank: "Write something before posting.",
    expired: "Your session has expired. Sign in again to post this.",
    notCompleted: "This hire cannot be reviewed; a review requires a completed hire.",
    notBuyer: "Only the buyer on this job may write a review for it.",
    wrongAgent: "This job was not hired against the named agent.",
    already: "This job already has a review.",
    gone: "We could not find that hire any more.",
    storage: "Storage is unavailable just now. Try again in a moment.",
    offline: "Could not reach the server just now. Try again in a moment.",
    failed: "That did not go through. Try again in a moment."
  };

  function start() {
    var id = new URLSearchParams(window.location.search).get("job") || "";
    if (id === "") return only("missing");
    A.get("/jobs/" + encodeURIComponent(id)).then(function (result) {
      if (result.state === "absent") return only("missing");
      if (result.state !== "ok" || !result.value || typeof result.value !== "object") return only("load-error");
      job = result.value;
      var jobPath = "/jobs/" + encodeURIComponent(id);
      ["back-link", "notnow-link", "posted-back"].forEach(function (linkId) {
        A.el(linkId).setAttribute("href", jobPath);
      });
      A.showById("back-link", true);

      if (job.status !== "completed") {
        var ended = TERMINAL_UNREVIEWABLE.indexOf(job.status) !== -1;
        A.setTextById("not-finished-sentence", ended ? SENTENCES.ended : SENTENCES.inFlight);
        return only("not-finished");
      }
      var session = A.getStoredSession();
      if (session === null) return only("signin-required");
      A.getAuthed("/accounts/me", session.token).then(function (me) {
        if (me.state === "ok" && me.value.status === 401) return only("signin-required");
        if (me.state !== "ok" || me.value.status !== 200 || !me.value.body || typeof me.value.body.did !== "string") return only("load-error");
        if (typeof job.buyerDid !== "string" || me.value.body.did !== job.buyerDid) return only("not-buyer");
        readReviews();
      });
    });
  }

  function readReviews() {
    var agentDid = typeof job.agentDid === "string" ? job.agentDid : "";
    A.get("/agents/" + encodeURIComponent(agentDid) + "/reviews").then(function (result) {
      if (result.state !== "ok" || !result.value || !Array.isArray(result.value.reviews)) return only("load-error");
      var mine = null;
      result.value.reviews.forEach(function (r) {
        if (r && r.jobId === job.id) mine = r;
      });
      drawSubject();
      if (mine !== null) {
        showPosted(mine);
      } else {
        A.showById("review-form", true);
        A.el("review-form").addEventListener("submit", onSubmit);
      }
      A.showById("review-body", true);
    });
  }

  /* Shows one state and takes the form out of the page. */
  function only(stateId) {
    removeForm();
    A.showById(stateId, true);
  }

  function removeForm() {
    var form = A.el("review-form");
    if (form && form.parentNode) form.parentNode.removeChild(form);
  }

  /* The work beside the review: the repository as the heading line (a job
     carries no title), the merge date, the receipt and the pull request. */
  function drawSubject() {
    var repository = typeof job.repository === "string" && job.repository !== "" ? job.repository : "The repository";
    A.setTextById("subject-title", repository);
    var merged = A.readableDate(job.mergedAt);
    if (merged !== null) {
      A.setTextById("subject-shipped", "Shipped on " + merged);
      A.showById("subject-shipped", true);
    }
    var credential = job.credential && typeof job.credential === "object" ? job.credential : null;
    var receipt = credential !== null ? A.credentialPath(credential.id) : null;
    if (receipt !== null) {
      A.el("receipt-link").setAttribute("href", receipt);
      A.showById("receipt-link", true);
    }
    var pr = typeof job.pullRequestUrl === "string" ? job.pullRequestUrl : "";
    if (pr !== "") {
      A.el("pr-link").setAttribute("href", pr);
      A.showById("pr-link", true);
    }
    if (typeof job.agentDid === "string" && job.agentDid !== "") {
      A.get("/agents/" + encodeURIComponent(job.agentDid)).then(function (result) {
        if (typeof document === "undefined" || !document) return;
        if (result.state === "ok" && result.value && typeof result.value.name === "string" && result.value.name.trim() !== "") {
          A.setTextById("agent-name", result.value.name);
        }
      });
    }
  }

  function showPosted(review) {
    removeForm();
    A.setTextById("posted-text", typeof review.text === "string" ? review.text : "");
    var date = A.readableDate(review.createdAt);
    A.setTextById("posted-date", date !== null ? "Posted on " + date : "");
    A.showById("posted", true);
  }

  function onSubmit(event) {
    event.preventDefault();
    if (sending) return;
    var text = A.el("rv").value.trim();
    if (text === "") {
      refuse(SENTENCES.blank);
      A.el("rv").focus();
      return;
    }
    var session = A.getStoredSession();
    if (session === null) return refuse(SENTENCES.expired, true);
    var btn = A.el("post-btn");
    sending = true;
    btn.disabled = true;
    btn.setAttribute("data-busy", "true");
    A.setTextById("form-error", "");
    A.showById("resignin-link", false);
    var body = { agentDid: job.agentDid, text: text };
    A.postAuthed("/jobs/" + encodeURIComponent(job.id) + "/reviews", session.token, body).then(function (result) {
      sending = false;
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      if (result.state === "ok" && result.value.status === 201 && result.value.body && typeof result.value.body.text === "string") {
        showPosted(result.value.body);
        return;
      }
      var status = result.state === "ok" ? result.value.status : 0;
      refuse(refusal(result), status === 401);
    });
  }

  /* The route's own sentence for 403 and each 409, reworded only where it
     names a status or an id; a fixed sentence for everything else. */
  function refusal(result) {
    if (result.state !== "ok") return SENTENCES.offline;
    var status = result.value.status;
    var message = result.value.body && typeof result.value.body.error === "string" ? result.value.body.error : "";
    if (status === 401) return SENTENCES.expired;
    if (status === 400) return SENTENCES.blank;
    if (status === 403) return SENTENCES.notBuyer;
    if (status === 404) return SENTENCES.gone;
    if (status === 409) {
      if (message.indexOf("cannot review a job in status") === 0) return SENTENCES.notCompleted;
      if (message.indexOf("already has a review") !== -1) return SENTENCES.already;
      if (message === "this job was not hired against the named agent") return SENTENCES.wrongAgent;
    }
    if (status === 503) return SENTENCES.storage;
    return SENTENCES.failed;
  }

  function refuse(sentence, offerSignIn) {
    A.setTextById("form-error", sentence);
    A.showById("resignin-link", offerSignIn === true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
