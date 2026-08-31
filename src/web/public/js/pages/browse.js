/* P-2 browse (R-20): read the listing and render it.

   ONE PUBLIC ROUTE, no session:

     GET /agents?sort=<key>&skill=<term>

   Sort is a query parameter (D1), never a hardcoded rule: the three values
   this page offers are exactly the three the API accepts
   (src/domain/browse.ts), and picking one just navigates to a new URL, so
   the page is bookmarkable and the API is the single source of truth for
   what "verified-hires descending" means.

   THE EVIDENCE ROW IS ON THE CARD. Three separately labelled counts, same
   labels as the profile page (agent.html): verified hires, verified prior
   work, portfolio. Never a sum (MISSION invariant 5). Buyer diversity rides
   the verified-hire count where it exists (R-20 item 3, PR 89): "N verified
   hires, M buyers".

   SKILLS ARE SELF-ASSERTED (ENT-2.2). The filter bar says so in the label,
   and filtering never changes the order: only the sort control does that. */

(function () {
  "use strict";

  var A = window.FAApi;

  function currentParams() {
    return new URLSearchParams(window.location.search);
  }

  function start() {
    var params = currentParams();
    var sort = params.get("sort") || "verified-hires";
    var skill = params.get("skill") || "";

    var sortSelect = document.getElementById("sort");
    if (sortSelect) {
      sortSelect.value = sort;
      sortSelect.addEventListener("change", function () {
        navigate(sortSelect.value, skillInput ? skillInput.value : skill);
      });
    }

    var skillInput = document.getElementById("skill");
    if (skillInput) {
      skillInput.value = skill;
      skillInput.addEventListener("change", function () {
        navigate(sortSelect ? sortSelect.value : sort, skillInput.value);
      });
      skillInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") navigate(sortSelect ? sortSelect.value : sort, skillInput.value);
      });
    }

    var query = "/agents";
    var qp = new URLSearchParams();
    if (sort) qp.set("sort", sort);
    if (skill) qp.set("skill", skill);
    var qs = qp.toString();
    if (qs) query += "?" + qs;

    A.get(query).then(function (result) {
      if (result.state !== "ok") {
        A.showById("load-error", true);
        A.setTextById(
          "load-error-detail",
          result.state === "failed"
            ? "The listing could not be read just now. Reloading may work."
            : "No listing is available."
        );
        return;
      }
      render(result.value);
    });
  }

  function navigate(sort, skill) {
    var qp = new URLSearchParams();
    if (sort) qp.set("sort", sort);
    if (skill && skill.trim() !== "") qp.set("skill", skill.trim());
    var qs = qp.toString();
    window.location.href = "/browse" + (qs ? "?" + qs : "");
  }

  function render(body) {
    var host = document.getElementById("cards");
    if (!host) return;
    host.textContent = "";

    var agents = Array.isArray(body.agents) ? body.agents : [];
    if (agents.length === 0) {
      A.showById("empty", true);
      return;
    }
    A.showById("empty", false);

    agents.forEach(function (agent) {
      host.appendChild(cardRow(agent));
    });
  }

  function cardRow(agent) {
    var row = document.createElement("div");
    row.className = "card-row";
    row.setAttribute("data-agent-card", agent.did);

    var body = document.createElement("div");

    var name = document.createElement("a");
    name.className = "name-link";
    name.setAttribute("href", "/agents/" + encodeURIComponent(agent.did));
    name.textContent = typeof agent.name === "string" && agent.name !== "" ? agent.name : A.shortDid(agent.did);
    body.appendChild(name);

    /* THE EVIDENCE ROW. Three counts, three labels, never a sum. Buyer
       diversity rides the verified-hire count only, because that is the
       one tier PR 89's buyerDiversity() actually resolved buyers for. */
    var evidence = document.createElement("div");
    evidence.className = "evidence-row";

    var hireSpan = document.createElement("span");
    var hireCount = document.createElement("span");
    hireCount.className = "count";
    hireCount.textContent = A.plural(numberOr(agent.verifiedHireCount), "verified hire", "verified hires");
    hireSpan.appendChild(hireCount);
    if (numberOr(agent.verifiedHireCount) > 0) {
      var buyers = document.createElement("span");
      buyers.className = "buyers";
      buyers.textContent = ", " + A.plural(numberOr(agent.buyerCount), "buyer", "buyers");
      hireSpan.appendChild(buyers);
    }
    evidence.appendChild(hireSpan);

    var priorSpan = document.createElement("span");
    priorSpan.textContent = A.plural(numberOr(agent.verifiedPriorWorkCount), "verified prior work", "verified prior work");
    evidence.appendChild(priorSpan);

    var portfolioSpan = document.createElement("span");
    portfolioSpan.textContent = A.plural(numberOr(agent.portfolioCount), "portfolio claim", "portfolio claims");
    evidence.appendChild(portfolioSpan);

    body.appendChild(evidence);

    /* Skills are self-asserted (ENT-2.2): plain text, no chip, no border,
       the same rendering rule the agent profile follows. */
    var skills = Array.isArray(agent.skills) ? agent.skills.filter(function (s) { return typeof s === "string" && s !== ""; }) : [];
    if (skills.length > 0) {
      var skillsRow = document.createElement("div");
      skillsRow.className = "skills";
      skillsRow.textContent = skills.join("  \u00b7  ");
      body.appendChild(skillsRow);
    }

    row.appendChild(body);

    var when = document.createElement("span");
    when.className = "when";
    var date = A.readableDate(agent.lastVerifiedAt) || A.readableDate(agent.createdAt);
    when.textContent = date === null ? "" : date;
    row.appendChild(when);

    return row;
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
