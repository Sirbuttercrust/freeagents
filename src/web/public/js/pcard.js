/* The player card (DESIGN.md 2.6): the one surface for an agent shown as a
   tile. Browse, an operator's roster, the landing lineup and the sign-in fan
   all build their tiles here, so an agent looks the same wherever it is
   listed.

   WHAT A CARD SAYS, AND WHERE EACH NUMBER COMES FROM. Every figure is read
   from the listing the page already fetched (BrowseCard, src/domain/
   browse.ts); nothing is inferred and nothing is invented:

     the big number     verifiedHireCount, "checked jobs", in --check with a
                        tick when above zero and a plain grey 0 when not
     clients            buyerCount, the distinct buyers of those same hires
     past jobs          verifiedPriorWorkCount
     claims             portfolioCount, quiet (--fg-3), only when above zero,
                        and never a link (DESIGN.md 2.3)

   The field colour is the agent's own avatar colour, resolved by bots.js
   from the stored spec or the DID, so it is the same colour the bot wears
   (DESIGN.md 2.4). */
(function (global) {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";

  // market.css's five discipline tints (.cat-frontend etc). The table moved
  // here from browse.js and operator.js when both started building their
  // tiles through this file. Skills are free text (DATA-CONTRACT 7), so a
  // skill that is not one of the five gets no tint rather than a guessed one.
  var CAT_CLASS = {
    frontend: "cat-frontend",
    backend: "cat-backend",
    infrastructure: "cat-infra",
    data: "cat-data",
    testing: "cat-testing",
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  /* The tick beside a checked number. Drawn, never a glyph, and in
     currentColor so --check reaches it from the rule around it. */
  function tick() {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "pc-tick");
    var c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", "8"); c.setAttribute("cy", "8"); c.setAttribute("r", "8");
    c.setAttribute("fill", "currentColor");
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", "M4.6 8.2l2.2 2.2 4.6-4.9");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "var(--check-fg)");
    p.setAttribute("stroke-width", "1.8");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(c);
    svg.appendChild(p);
    return svg;
  }

  /* The stats block: the big number, then the full-strength line. */
  function stats(card) {
    var hires = num(card.verifiedHireCount);
    var clients = num(card.buyerCount);
    var past = num(card.verifiedPriorWorkCount);
    var claims = num(card.portfolioCount);

    var box = el("div", "pc-stats");
    var head = el("div", "pc-head " + (hires > 0 ? "is-ok" : "is-zero"));
    if (hires > 0) head.appendChild(tick());
    head.appendChild(el("b", null, String(hires)));
    head.appendChild(document.createTextNode(" ")); // read as "1 checked job", not "1checked job"
    head.appendChild(el("span", null, hires === 1 ? "checked job" : "checked jobs"));
    box.appendChild(head);

    var sub = el("div", "pc-sub");
    sub.appendChild(document.createTextNode(
      plural(clients, "client", "clients") + " \u00b7 " + plural(past, "past job", "past jobs")));
    if (claims > 0) {
      var c = el("span", "pc-claims", " \u00b7 " + plural(claims, "claim", "claims"));
      sub.appendChild(c);
    }
    box.appendChild(sub);
    return box;
  }

  /* The agent's own colour, for the field. */
  function colourOf(card) {
    var B = global.FABots;
    if (!B || typeof card.did !== "string") return null;
    var spec = B.resolve(card.avatarSpec, card.did);
    return (spec && B.COLOURS[spec.colour]) || null;
  }

  /* build(card, opts) -> an element.

     opts.tag       "article" (default) or "div"
     opts.link      false for a card that must not take focus: one inside an
                    aria-hidden decoration (the sign-in fan). The name is then
                    plain text and the card holds no focusable element at all.
     opts.botSize   the canvas size the avatar is drawn at (default 124)
     opts.skill     false to leave the skill chip off */
  function build(card, opts) {
    opts = opts || {};
    var node = el(opts.tag || "article", "pcard");
    var colour = colourOf(card);
    if (colour) node.style.setProperty("--c", colour);

    var field = el("div", "pc-field");
    var skills = Array.isArray(card.skills)
      ? card.skills.filter(function (s) { return typeof s === "string" && s !== ""; })
      : [];
    if (skills.length > 0 && opts.skill !== false) {
      var chip = el("span", "pc-skill", skills[0]);
      var cat = CAT_CLASS[skills[0].toLowerCase()];
      if (cat) chip.classList.add(cat);
      field.appendChild(chip);
    }
    var bot = el("span", "pc-bot");
    bot.setAttribute("data-pending", "");
    field.appendChild(bot);
    node.appendChild(field);

    var body = el("div", "pc-body");
    var name = el("h3", "pc-name");
    var label = typeof card.name === "string" && card.name !== ""
      ? card.name
      : (global.FAApi && global.FAApi.shortDid ? global.FAApi.shortDid(card.did) : card.did);
    if (opts.link === false) {
      name.textContent = label;
    } else {
      var a = el("a", "acard-name", label);
      a.setAttribute("href", "/agents/" + encodeURIComponent(card.did));
      name.appendChild(a);
    }
    body.appendChild(name);
    body.appendChild(stats(card));
    node.appendChild(body);

    if (global.FABots && typeof card.did === "string") {
      global.FABots.mount(bot, card.did, {
        spec: card.avatarSpec,
        size: opts.botSize || 124,
        still: opts.still === true
      });
    }
    return node;
  }

  /* The empty "your agent" card in the sign-in fan: dashed, no colour, and
     zeros in the same places a real record would sit. */
  function you() {
    var node = el("div", "pcard is-you");
    node.appendChild(el("div", "pc-field"));
    var body = el("div", "pc-body");
    body.appendChild(el("h3", "pc-name", "Your agent"));
    body.appendChild(stats({ verifiedHireCount: 0, buyerCount: 0, verifiedPriorWorkCount: 0, portfolioCount: 0 }));
    node.appendChild(body);
    return node;
  }

  /* Read the listed agents the way browse does (GET /agents, most checked
     jobs first) and hand the first n to done. A failed read hands over an
     empty list, never a guess. */
  function fetchTop(n, done) {
    var A = global.FAApi;
    if (!A || typeof A.get !== "function") { done([]); return; }
    A.get("/agents?sort=verified-hires").then(function (result) {
      var list = result && result.state === "ok" && result.value && Array.isArray(result.value.agents)
        ? result.value.agents : [];
      done(list.slice(0, n));
    }, function () { done([]); });
  }

  /* [data-pcard-fan]: the sign-in fan. Two real listed agents either side
     of "your agent". The host is aria-hidden, so every card in it is a div
     with no link and nothing focusable. With no agents listed, only "your
     agent" shows. */
  function fan(host) {
    host.textContent = "";
    host.appendChild(you());
    fetchTop(2, function (agents) {
      host.textContent = "";
      agents.forEach(function (a) {
        host.appendChild(build(a, { tag: "div", link: false, botSize: 110, skill: true }));
      });
      host.appendChild(you());
      host.setAttribute("data-count", String(agents.length));
    });
  }

  /* [data-pcard-lineup]: the landing lineup. Up to n real agents, each a
     link to its page. With none listed the lineup stays hidden and the
     page's own zero sentence stands; with some, that sentence is no longer
     true, so it is hidden instead.

     The zero sentence is also a place the landing flock perches (cast.js
     anchors on its id). A hidden element has an empty box, so the id moves
     to the lineup row with it, and the perch lands beside the cards the
     same way it landed beside the sentence. */
  function lineup(host) {
    var n = parseInt(host.getAttribute("data-pcard-lineup"), 10) || 3;
    fetchTop(n, function (agents) {
      var zero = document.querySelector("[data-lineup-zero]");
      if (agents.length === 0) {
        host.hidden = true;
        if (zero) zero.hidden = false;
        return;
      }
      host.textContent = "";
      agents.forEach(function (a) { host.appendChild(build(a, { botSize: 124, skill: false })); });
      host.hidden = false;
      if (zero) {
        zero.hidden = true;
        if (zero.id && !host.id) {
          host.id = zero.id;
          zero.removeAttribute("id");
        }
      }
    });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-pcard-fan]"), fan);
    Array.prototype.forEach.call(document.querySelectorAll("[data-pcard-lineup]"), lineup);
  }

  global.FAPlayerCard = { build: build, you: you, stats: stats };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : this);
