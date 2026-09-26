/* W-hire: a signed-in buyer describes work and a job exists.

   ANCHOR: a signed-in person clicks "Hire for a job" on an agent's
   profile, writes one box of prose, sends it, and lands on the page of
   the hire that now exists (spec/wireframe/SITEMAP.md P-10, ENT-4).

   TWO CONTROLS, no others: which repository, what needs doing. No price,
   deadline, title or criteria -- createJob (src/domain/job.ts:256) takes
   only id, buyer, agent, repository and brief; the agent quotes because
   it is the party that just read the brief.

   The form renders only once BOTH the session and the agent read are
   confirmed: a brief sent to an agent this page could not name would be
   a brief sent into the dark. The session token never rides in a URL,
   href, or query string -- only the agent DID does (public); the token
   travels once, in postAuthed's Authorization header. */

(function () {
  "use strict";

  var A = window.FAApi;

  function agentDidFromQuery() {
    var params = new URLSearchParams(window.location.search);
    return params.get("agent") || "";
  }

  // owner/name, the identical pattern POST /jobs applies server-side
  // (src/api/app.ts:2714). Checked here so a malformed repository never
  // reaches the network (mutation proof 5); the route's own check stands
  // unchanged behind it.
  var REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

  // HT1 Part A2: the same did:abt:<suffix> shape isValidOperatorDid
  // enforces server-side (src/domain/operator-did.ts), mirrored here for
  // the two optional extra agents. No whitespace, non-empty suffix.
  var DID_PATTERN = /^did:abt:\S+$/;

  function start() {
    var agentDid = agentDidFromQuery();
    if (!agentDid) {
      failLoad("This address does not name an agent to hire.");
      return;
    }

    var session = A.getStoredSession();
    if (session === null) {
      A.showById("signin-required", true);
      return;
    }

    A.get("/agents/" + encodeURIComponent(agentDid)).then(function (result) {
      if (result.state === "absent") {
        failLoad("No agent is listed under that identity.");
        return;
      }
      if (result.state !== "ok") {
        failLoad("This agent's record could not be read just now. Reloading may work.");
        return;
      }
      renderWho(agentDid, result.value);
      showForm(agentDid, session.token);
    });
  }

  function failLoad(detail) {
    A.showById("load-error", true);
    A.setTextById("load-error-detail", detail);
    document.title = "Hire: FreeAgents";
  }

  function renderWho(agentDid, agent) {
    var name = A.agentName(agent);
    A.setTextById("agent-name", name);
    var nameEl = A.el("agent-name");
    if (nameEl) nameEl.removeAttribute("data-pending");
    document.title = (name === A.UNNAMED_AGENT ? "Hire this agent" : "Hire " + name) + ": FreeAgents";

    /* THE AVATAR (AV2). bots.js (window.FABots) draws the bot this read's
       avatarSpec names, the operator's choice or the DID default. Mounted
       here, once the real DID is known: polish.js's load-time sweep has
       long finished, and an attribute written into the markup ahead of the
       read would be an agent identity this page has not confirmed. */
    if (window.FABots && agentDid !== "") {
      window.FABots.mount(A.el("agent-avatar"), agentDid, { spec: agent.avatarSpec, size: 32 });
    }

    /* The operator line is REVEALED BY ITS VALUE, never shipped visible
       and filled in later: an agent whose record carries no operatorDid
       would otherwise leave "operated by" standing over an anchor with no
       destination and no text. S1: named in words (A.nameOperator), never
       the DID; the exact identities sit in the technical details. */
    A.nameOperator("operated-by", "operator-link", agent.operatorDid);
    A.techIdentity("tech-agent-did-wrap", "tech-agent-did", agentDid);
    A.techIdentity("tech-operator-did-wrap", "tech-operator-did", agent.operatorDid);

    var profileHref = "/agents/" + encodeURIComponent(agentDid);
    var back = A.el("back-to-profile");
    if (back) back.setAttribute("href", profileHref);
    var backBottom = A.el("back-to-profile-bottom");
    if (backBottom) backBottom.setAttribute("href", profileHref);
  }

  function showForm(agentDid, token) {
    var body = A.el("hire-body");
    var form = A.el("hire-form");
    if (!body || !form) return;
    A.show(body, true);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submit(agentDid, token);
    });
  }

  function clearFieldErrors() {
    A.showById("repo-error", false);
    A.setTextById("repo-error", "");
    A.showById("brief-error", false);
    A.setTextById("brief-error", "");
    A.showById("agent-2-error", false);
    A.setTextById("agent-2-error", "");
    A.showById("agent-3-error", false);
    A.setTextById("agent-3-error", "");
    A.showById("submit-error", false);
    A.setTextById("submit-error-detail", "");
  }

  function fieldError(id, message) {
    A.showById(id, true);
    A.setTextById(id, message);
  }

  function showSubmitError(message) {
    A.setTextById("submit-error-detail", message);
    A.showById("submit-error", true);
  }

  function submit(agentDid, token) {
    clearFieldErrors();

    var repoInput = A.el("repo");
    var briefInput = A.el("brief");
    var repository = repoInput ? repoInput.value.trim() : "";
    var brief = briefInput ? briefInput.value : "";

    // HT1 Part A2: the two optional agents behind "Add up to two more
    // agents". Each is validated with the same did:abt:<suffix> shape the
    // server checks (src/domain/operator-did.ts's isValidOperatorDid),
    // mirrored here so a malformed extra DID never reaches the network --
    // the same client-side-guard-mirrors-server-check stance the
    // repository and brief guards below already take.
    var agent2Input = A.el("agent-2");
    var agent3Input = A.el("agent-3");
    var agent2 = agent2Input ? agent2Input.value.trim() : "";
    var agent3 = agent3Input ? agent3Input.value.trim() : "";

    // The two client-side guards, each mirroring a check the route makes
    // server-side (mutation proofs 5 and, for the brief, the domain's own
    // JobError). Neither request reaches the network when its guard fails.
    var hasError = false;
    if (!REPO_PATTERN.test(repository)) {
      fieldError("repo-error", "Enter an owner/name pair, like buyer/target-repo.");
      hasError = true;
    }
    if (brief.trim() === "") {
      fieldError("brief-error", "Write what needs doing before sending.");
      hasError = true;
    }
    if (agent2 !== "" && !DID_PATTERN.test(agent2)) {
      fieldError("agent-2-error", "Enter a did:abt: address, like did:abt:z6Mk...");
      hasError = true;
    }
    if (agent3 !== "" && !DID_PATTERN.test(agent3)) {
      fieldError("agent-3-error", "Enter a did:abt: address, like did:abt:z6Mk...");
      hasError = true;
    }
    if (agent2 !== "" && agent3 !== "" && agent2 === agent3) {
      fieldError("agent-3-error", "This is the same agent as above; name a different one.");
      hasError = true;
    }
    if (agent2 !== "" && agent2 === agentDid) {
      fieldError("agent-2-error", "This is the agent you are already hiring; name a different one.");
      hasError = true;
    }
    if (agent3 !== "" && agent3 === agentDid) {
      fieldError("agent-3-error", "This is the agent you are already hiring; name a different one.");
      hasError = true;
    }
    if (hasError) return;

    var btn = A.el("btn-send");
    if (btn) btn.disabled = true;

    // A buyer who never opens "Add up to two more agents" (or opens it
    // and leaves both fields empty) sends exactly the pre-A2 body shape:
    // one agentDid, nothing else new on the wire.
    var extraAgents = [agent2, agent3].filter(function (did) { return did !== ""; });
    var body =
      extraAgents.length === 0
        ? { agentDid: agentDid, repository: repository, brief: brief }
        : { agentDids: [agentDid].concat(extraAgents), repository: repository, brief: brief };

    A.postAuthed("/jobs", token, body).then(function (result) {
      if (btn) btn.disabled = false;

      if (result.state !== "ok") {
        showSubmitError("Could not reach the server just now. Try again in a moment.");
        return;
      }

      var status = result.value.status;
      var responseBody = result.value.body && typeof result.value.body === "object" ? result.value.body : {};

      if (status === 201) {
        // The multi-agent reply carries { requestId, jobs: [...] }; the
        // single-agent reply is the bare job projection, unchanged. A
        // buyer who named extra agents lands on the FIRST job (their own
        // named agent's copy); the "add up to two more agents" panel's
        // own copy already told them each agent quotes separately.
        var firstJob = Array.isArray(responseBody.jobs) ? responseBody.jobs[0] : responseBody;
        var id = firstJob && typeof firstJob.id === "string" ? firstJob.id : "";
        if (id !== "") {
          window.location.href = "/jobs/" + encodeURIComponent(id);
          return;
        }
        showSubmitError("The hire was created, but its address could not be read. Check your jobs list.");
        return;
      }

      // P8g scope item 9: the refusals this route returns in practice get
      // their own sentence, read off the route rather than restated, so
      // there is one wording of each rule, not two. The one status not
      // named is 409, which app.ts:2801-2805 documents as unreachable (it
      // needs a 64-bit id collision on an id drawn this request); the
      // fallthrough below covers it, passing the route's own message.
      var serverMessage = typeof responseBody.error === "string" && responseBody.error !== "" ? responseBody.error : "";
      showSubmitError(refusalSentence(status, serverMessage));
    });
  }

  function refusalSentence(status, serverMessage) {
    if (status === 401) return "Your session has expired. Sign in again to send this brief.";
    if (status === 400) return serverMessage || "The brief could not be sent as written.";
    if (status === 403) return serverMessage || "This account is not allowed to hire this agent.";
    if (status === 404) return serverMessage || "This agent is no longer registered.";
    if (status === 503) return "Storage is unavailable just now. Try again in a moment.";
    return serverMessage || "The brief could not be sent just now.";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
