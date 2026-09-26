/* P-32 private repositories. Opened as /private-repos?job=<id>, step 4
   names the two GitHub accounts that need the Read role, from the job's
   own githubAccessNeeded field (GET /jobs/:jobId, public, no session).
   The field is present only while the job has no staging repository and
   its agent has a verified GitHub login (githubAccessNeededFor in
   src/api/app.ts), so a job past staging, an unknown job, a failed read or
   no job at all leaves the plain line in place. The four steps are static
   markup and render whatever happens here. Everything through
   textContent (api.js rule 3). */
(function () {
  "use strict";
  var A = window.FAApi;

  function login(value) {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  }

  function row(name, who) {
    var li = document.createElement("li");
    var span = document.createElement("span");
    span.className = "login";
    span.textContent = "@" + name;
    li.appendChild(span);
    li.appendChild(document.createTextNode(", " + who));
    return li;
  }

  function done() {
    var host = A.el("step-accounts");
    if (host) host.removeAttribute("data-pending");
  }

  function nameAccounts(job) {
    var need = job && typeof job === "object" && job.githubAccessNeeded && typeof job.githubAccessNeeded === "object"
      ? job.githubAccessNeeded : null;
    if (need === null) return;
    var agent = login(need.agentGithubLogin), platform = login(need.platformGithubLogin);
    if (agent === "" || platform === "") return;
    var list = A.el("accounts");
    if (!list) return;
    list.textContent = "";
    list.appendChild(row(agent, "the agent"));
    list.appendChild(row(platform, "FreeAgents"));
    A.showById("accounts", true);
    A.showById("accounts-plain", false);
  }

  function start() {
    var jobId = new URLSearchParams(window.location.search).get("job") || "";
    if (jobId === "") { done(); return; }
    A.get("/jobs/" + encodeURIComponent(jobId)).then(function (result) {
      if (result.state === "ok") nameAccounts(result.value);
      done();
    }, done);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
