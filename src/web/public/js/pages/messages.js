/* MSG1b: the hire conversation at /messages (SITEMAP P-33). Direction A,
   "Pinned", from the MSG0 design board, ported onto the live routes. The
   board's engine (its shared chat.js) is the source of the behaviour and
   the class vocabulary; its sample hire, state machine and fake timers are
   not here. Everything on this screen comes from the API.

   WHAT IT READS. GET /accounts/me for the signed-in DID, then
   GET /accounts/:did/threads for the list (both seats, newest first, an
   unreadCount per row and the unreadTotal). Opening a thread reads, side by
   side: GET /jobs/:jobId/messages (oldest first), GET /jobs/:jobId (status,
   price, the brief's date, the receipt), GET /jobs/:jobId/attachments
   (names, sizes and kinds of the files sent) and
   GET /jobs/:jobId/messages/read-state (both seats' lastReadAt).

   WHAT IT WRITES. POST /jobs/:jobId/messages (send, reply, a file with no
   words), PATCH /jobs/:jobId/messages/:id (edit, 15 minutes, author only),
   POST and DELETE .../reactions (one per seat), POST .../messages/read (on
   open, and when new rows land while the page is visible), POST
   /jobs/:jobId/typing (at most once every 3 seconds while typing) and
   POST /jobs/:jobId/attachments (with upload progress, so XMLHttpRequest).

   LIVE. EventSource cannot carry the Bearer header, so the stream at
   GET /jobs/:jobId/messages/stream is read with fetch and a stream reader.
   Anything that stops that path (no stream reader, no TextDecoder, a
   refused or ended stream) falls back to re-reading the messages and the
   read state every 10 seconds while the page is visible.

   SAFETY. Every word that came from a person or from the API reaches the
   page through textContent. A link in a message body is built as an
   element, http and https only, rel="noopener nofollow ugc" and
   target="_blank", and nothing is previewed. The only innerHTML in this
   file writes its own constant icon markup. Image bytes need the Bearer
   header, so they are fetched and shown through object URLs, revoked when
   replaced or when the thread closes.

   SIDES. A row is on my side when its authorParty is my seat, so an owner
   sees their own agent's automatic messages on the right, marked "Sent by
   <agent> automatically". Only the row's own author may edit it
   (authorDid, the route's own rule). */

(function () {
  "use strict";

  var A = window.FAApi;
  var EDIT_MS = 15 * 60 * 1000;
  var GAP_MS = 15 * 60 * 1000;
  var TYPING_SEND_MS = 3000;
  var TYPING_SHOW_MS = 6000;
  var POLL_MS = 10000;
  var MAX_BYTES = 10 * 1024 * 1024;
  var BODY_MAX = 4000;
  var BRIEF_CUT = 280;
  var DRAFT_PREFIX = "fa-msg-draft:";
  var IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
  var IMAGE_EXT = /\.(png|jpe?g|webp|heic|heif)$/i;
  var PDF_EXT = /\.pdf$/i;

  /* The five hire steps, the same table job.js uses (its STEP_FOR_STATUS);
     tests/web/messages.test.ts holds the two equal. */
  var STEP_FOR_STATUS = {
    draft: 2, proposed: 2,
    confirmed: 3, redo_requested: 3,
    staged: 4,
    submitted: "done", completed: "done", deemed_completed: "done",
    stale: "done", closed_unmerged: "done", cited_closed: "done",
    declined: null, withdrawn: null, expired_unstaged: null,
    staged_declined: null, closed_unpaid: null
  };
  var TERMINAL = {
    completed: 1, declined: 1, closed_unmerged: 1, withdrawn: 1, staged_declined: 1,
    closed_unpaid: 1, expired_unstaged: 1, deemed_completed: 1, cited_closed: 1
  };
  var EVENT_WORDS = {
    quote_sent: "Sent a quote",
    deposit_paid: "Deposit paid",
    remainder_paid: "Final payment sent",
    staged: "Work ready for review",
    pr_opened: "Pull request opened",
    completed: "Hire complete"
  };

  function mq(q) { return !!(window.matchMedia && window.matchMedia(q).matches); }
  function coarse() { return mq("(pointer: coarse)"); }
  function enc(s) { return encodeURIComponent(s); }
  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ icons
     The board's own set. Constant markup, never data. */
  var ICON = {
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
    wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M17 13h.01"/>',
    pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    smileplus: '<path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01M16 5h6M19 2v6"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>',
    up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
  };
  function fromMarkup(markup) {
    var holder = document.createElement("span");
    holder.innerHTML = markup;
    return holder.firstChild;
  }
  function icon(name, cls) {
    var svg = fromMarkup('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON[name] + "</svg>");
    if (cls) svg.setAttribute("class", cls);
    return svg;
  }
  /* The tail: one path, mirrored for my side (chat.css). */
  function tail() {
    return fromMarkup('<svg class="tailsvg" viewBox="0 0 12 20" aria-hidden="true" focusable="false"><path d="M6 0V5.5C6 13.5 4.6 17.6 0 20H12V0Z"/></svg>');
  }
  var RING = 2 * Math.PI * 18;
  function ring(pct) {
    return fromMarkup('<svg viewBox="0 0 44 44" aria-hidden="true" focusable="false">' +
      '<circle cx="22" cy="22" r="18" style="fill:none;stroke:var(--line-2);stroke-width:3"/>' +
      '<circle class="ring" cx="22" cy="22" r="18" transform="rotate(-90 22 22)" style="fill:none;stroke:var(--fg);stroke-width:3;stroke-linecap:round" stroke-dasharray="' + RING.toFixed(1) + '" stroke-dashoffset="' + (RING * (1 - pct / 100)).toFixed(1) + '"/>' +
      '<path d="M17 17l10 10M27 17 17 27" style="stroke:var(--fg);stroke-width:2.2;stroke-linecap:round"/></svg>');
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return parent;
  }
  function button(cls, label, text) {
    var b = el("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    return b;
  }

  /* ------------------------------------------------------------ state */
  var S = {
    token: null, me: null, threads: [], unreadTotal: 0, gen: 0,
    jobId: null, row: null, job: null, seat: null, writable: false,
    messages: [], byId: {}, files: {}, readState: { buyer: null, agent: null },
    replyTo: null, editing: null, draftBeforeEdit: "",
    uploads: [], upSeq: 0, fresh: {}, pops: {},
    thumbs: {}, thumbLoading: {}, listKinds: {},
    typingOn: false, typingTimer: null, lastTypingSent: 0,
    live: null, listTimer: null,
    convEl: null, threadEl: null, scrollEl: null, slotEl: null, cmpEl: null
  };

  /* ------------------------------------------------------------ words */
  function agentName(row) {
    var n = row && typeof row.agentName === "string" ? row.agentName.trim() : "";
    if (n === "" || n === row.agentDid || /^did:/i.test(n)) return A.UNNAMED_AGENT || "This agent";
    return n;
  }
  function agentMid(row) {
    var n = agentName(row);
    return n === "This agent" ? "this agent" : n;
  }
  function login(row) {
    var l = row && typeof row.counterpartGithubLogin === "string" ? row.counterpartGithubLogin.trim() : "";
    return l === "" ? null : "@" + l;
  }
  /* The other person: their GitHub handle, or their role in plain words. */
  function otherLabel(row) { return login(row) || (row.seat === "buyer" ? "Owner" : "Hirer"); }
  function otherWords(row) { return login(row) || (row.seat === "buyer" ? "the owner" : "the hirer"); }
  /* A system row (the quote) belongs to the agent's side of the hire. */
  function sideOf(m) { return m.authorParty === "system" ? "agent" : m.authorParty; }
  function authorShort(m) {
    if (sideOf(m) === S.seat) return "You";
    if (m.authorKind === "agent-autonomous") return agentName(S.row);
    return otherLabel(S.row);
  }

  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function ms(iso) { var v = Date.parse(iso); return isNaN(v) ? 0 : v; }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() * 1000 + d.getMonth() * 40 + d.getDate(); }
  function clock(t) {
    var d = new Date(t), h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
  }
  function dayName(t) {
    var a = new Date(t); a.setHours(0, 0, 0, 0);
    var b = new Date(); b.setHours(0, 0, 0, 0);
    var diff = Math.round((b - a) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff > 1 && diff < 7) return DAYS[a.getDay()];
    return DAYS[a.getDay()].slice(0, 3) + ", " + MON[a.getMonth()] + " " + a.getDate();
  }
  function shortWhen(t) { var n = dayName(t); return n === "Today" ? clock(t) : n; }
  function usd(value) {
    var n = parseFloat(value);
    if (!isFinite(n)) return "";
    var whole = Math.round(n * 100) % 100 === 0;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  }
  function bytes(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  function firstLine(text, max) {
    var lines = String(text || "").split(/\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var line = lines.length ? lines[0] : "";
    return line.length > max ? line.slice(0, max - 1).replace(/\s+\S*$/, "") + "\u2026" : line;
  }
  function kindWord(aid) {
    var f = S.files[aid];
    if (!f) return "File";
    return f.kind === "application/pdf" ? "PDF" : "Image";
  }
  function preview(m) {
    if (m.authorParty === "system") {
      var ev = m.systemEvent || {};
      return ev.type === "quote_sent" ? "Quote, " + usd(ev.priceUsd) : (EVENT_WORDS[ev.type] || "Update");
    }
    if (typeof m.body === "string" && m.body !== "") return m.body;
    var a = (m.attachments || [])[0];
    return a ? kindWord(a.attachmentId) : "";
  }
  function agreed(job) {
    if (!job || !job.price || !Array.isArray(job.criteria) || job.criteria.length === 0) return false;
    var lines = job.criteria.every(function (c) { return c.acceptedByBuyer === true && c.acceptedByAgent === true; });
    return lines && job.price.acceptedByBuyer === true && job.price.acceptedByAgent === true;
  }

  /* ------------------------------------------------------------ requests */
  function api(method, path, body) {
    if (method === "GET") return A.getAuthed(path, S.token);
    if (method === "POST") return A.postAuthed(path, S.token, body === undefined ? {} : body);
    if (method === "PATCH") return A.patchAuthed(path, S.token, body);
    return A.deleteAuthed(path, S.token);
  }
  function status(r) { return r && r.state === "ok" ? r.value.status : 0; }
  function body(r) { return r && r.state === "ok" && r.value.body && typeof r.value.body === "object" ? r.value.body : null; }
  function blob(path) {
    return fetch(path, { headers: { Authorization: "Bearer " + S.token }, credentials: "omit" })
      .then(function (res) { return res.ok ? res.blob() : null; })
      .catch(function () { return null; });
  }
  function jobPath() { return "/jobs/" + enc(S.jobId); }
  function hireHref() {
    return S.seat === "agent" ? "/operatorjob?job=" + enc(S.jobId) : "/jobs/" + enc(S.jobId);
  }

  /* ------------------------------------------------------------ page states */
  function showState(id, detail) {
    ["signin-required", "load-error"].forEach(function (x) { A.showById(x, x === id); });
    A.showById("msg-app", false);
    if (detail) A.setTextById("load-error-detail", detail);
    document.body.classList.remove("in-thread", "show-list");
    layout();
  }
  function showApp() {
    A.showById("signin-required", false);
    A.showById("load-error", false);
    A.showById("msg-app", true);
    layout();
  }
  /* The app fills the screen under the site bar, so it needs the bar's
     height. On a phone inside a thread the bar is hidden and this is 0. */
  function layout() {
    var nav = document.querySelector("nav.nav");
    var h = 0;
    if (nav && window.getComputedStyle(nav).display !== "none") h = Math.round(nav.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--msg-top", h + "px");
  }

  function start() {
    var session = A.getStoredSession();
    if (!session) { showState("signin-required"); return; }
    S.token = session.token;
    api("GET", "/accounts/me").then(function (r) {
      if (status(r) === 401) { showState("signin-required"); return; }
      var me = body(r);
      if (status(r) !== 200 || !me || typeof me.did !== "string" || me.did === "") {
        showState("load-error", "Reloading may work.");
        return;
      }
      S.me = me.did;
      loadThreads().then(function (ok) {
        if (!ok) { showState("load-error", "Reloading may work."); return; }
        showApp();
        route();
      });
    });
    wire();
  }

  function loadThreads() {
    return api("GET", "/accounts/" + enc(S.me) + "/threads").then(function (r) {
      var b = body(r);
      if (status(r) !== 200 || !b || !Array.isArray(b.threads)) return false;
      S.threads = b.threads;
      S.unreadTotal = typeof b.unreadTotal === "number" ? b.unreadTotal : 0;
      if (S.jobId) {
        var fresh = findRow(S.jobId);
        if (fresh) {
          var was = S.writable;
          S.row = fresh;
          S.writable = fresh.writable !== false && !(S.job && TERMINAL[S.job.status]);
          if (was !== S.writable) { renderComposer(); renderThread(); }
        }
      }
      return true;
    });
  }
  function findRow(jobId) {
    for (var i = 0; i < S.threads.length; i++) if (S.threads[i].jobId === jobId) return S.threads[i];
    return null;
  }

  function route() {
    var job = new URLSearchParams(window.location.search).get("job");
    if (job) { if (job !== S.jobId) openThread(job); }
    else showList();
  }
  function go(url) {
    if (window.history && window.history.pushState) {
      window.history.pushState({}, "", url);
      route();
    } else {
      window.location.href = url;
    }
  }

  /* ------------------------------------------------------------ the list */
  function showList() {
    closeThread();
    document.body.classList.add("show-list");
    document.body.classList.remove("in-thread");
    noThread(S.threads.length ? "Pick a conversation." : "No conversations yet.", false);
    renderList(null);
    document.title = "Messages: FreeAgents";
    layout();
  }

  function lastLine(t) {
    var lm = t.lastMessage;
    if (!lm) return "Brief sent";
    if (lm.authorParty === "system") return EVENT_WORDS[lm.systemEventType] || "Update";
    var words = typeof lm.bodyPreview === "string" ? firstLine(lm.bodyPreview, 200) : "";
    if (words === "" && lm.attachmentCount > 0) words = S.listKinds[t.jobId] || "File";
    return (lm.authorParty === t.seat ? "You: " : "") + words;
  }

  function renderList(selected) {
    var ul = $("convlist");
    if (!ul) return;
    ul.textContent = "";
    A.showById("list-empty", S.threads.length === 0);
    S.threads.forEach(function (t) {
      var li = el("li");
      if (t.unreadCount > 0) li.classList.add("unread");
      var sel = t.jobId === selected;
      if (sel) li.classList.add("sel");
      var a = el("a");
      a.href = "/messages?job=" + enc(t.jobId);
      a.setAttribute("data-job", t.jobId);
      if (sel) a.setAttribute("aria-current", "true");
      var dot = el("span", "dot"); dot.setAttribute("aria-hidden", "true");
      var av = el("span", "av");
      var top = el("span", "cl-top");
      var name = el("b", null, agentName(t) + " ");
      name.appendChild(el("span", "cl-own", "with " + otherWords(t)));
      var when = el("time", null, shortWhen(ms(t.lastActivityAt)));
      when.setAttribute("datetime", t.lastActivityAt);
      add(top, name, when);
      var last = el("span", "cl-last");
      if (t.unreadCount > 0) last.appendChild(el("span", "sr", t.unreadCount + " unread. "));
      last.appendChild(el("span", "cl-lt", lastLine(t)));
      add(a, dot, av, add(el("span", "cl-body"), top, el("span", "cl-hire", firstLine(t.brief, 90)), last));
      li.appendChild(a);
      ul.appendChild(li);
      mountAv(av, t.agentDid, t.avatarSpec, 44);
      kindForList(t);
    });
  }
  /* A last message that is only a file: the row names its kind, which the
     thread list does not carry, so it is read from the thread's own list of
     sent files (the newest one is the last message's). */
  function kindForList(t) {
    var lm = t.lastMessage;
    if (!lm || lm.authorParty === "system" || lm.attachmentCount === 0 || lm.bodyPreview) return;
    if (S.listKinds[t.jobId] !== undefined) return;
    S.listKinds[t.jobId] = null;
    api("GET", "/jobs/" + enc(t.jobId) + "/attachments").then(function (r) {
      var b = body(r);
      if (!b || !Array.isArray(b.attachments) || b.attachments.length === 0) return;
      var newest = b.attachments.reduce(function (x, y) { return ms(y.createdAt) >= ms(x.createdAt) ? y : x; });
      S.listKinds[t.jobId] = newest.kind === "application/pdf" ? "PDF" : "Image";
      var a = document.querySelector('.convlist a[data-job="' + (window.CSS && CSS.escape ? CSS.escape(t.jobId) : t.jobId) + '"] .cl-lt');
      if (a) a.textContent = lastLine(t);
    });
  }
  function refreshListSoon() {
    clearTimeout(S.listTimer);
    S.listTimer = setTimeout(function () {
      loadThreads().then(function (ok) { if (ok) { renderList(S.jobId); renderBackBadge(); } });
    }, 500);
  }

  /* ------------------------------------------------------------ a thread */
  function noThread(text, withBack) {
    var conv = $("conv");
    Array.prototype.slice.call(conv.children).forEach(function (c) { if (c.id !== "conv-none") conv.removeChild(c); });
    conv.classList.add("is-none");
    conv.setAttribute("aria-label", "Conversation");
    A.setTextById("conv-none-text", text);
    var back = $("conv-none-back");
    if (back) { back.hidden = !withBack; back.setAttribute("data-list", ""); }
  }

  function closeThread() {
    S.gen += 1;
    stopLive();
    closeOverlays();
    S.uploads.forEach(function (u) { u.cancelled = true; if (u.xhr) try { u.xhr.abort(); } catch (e) { /* gone */ } });
    Object.keys(S.thumbs).forEach(function (k) { try { URL.revokeObjectURL(S.thumbs[k]); } catch (e) { /* gone */ } });
    clearTimeout(S.typingTimer);
    S.jobId = null; S.row = null; S.job = null; S.seat = null; S.writable = false;
    S.messages = []; S.byId = {}; S.files = {}; S.readState = { buyer: null, agent: null };
    S.replyTo = null; S.editing = null; S.uploads = []; S.fresh = {}; S.pops = {};
    S.thumbs = {}; S.thumbLoading = {}; S.typingOn = false;
    S.threadEl = null; S.scrollEl = null; S.slotEl = null; S.cmpEl = null;
  }

  function openThread(jobId) {
    closeThread();
    S.jobId = jobId;
    var gen = S.gen;
    document.body.classList.add("in-thread");
    document.body.classList.remove("show-list");
    layout();
    renderList(jobId);
    var p = "/jobs/" + enc(jobId);
    Promise.all([
      api("GET", p + "/messages"),
      A.get(p),
      api("GET", p + "/attachments"),
      api("GET", p + "/messages/read-state"),
      findRow(jobId) ? Promise.resolve(true) : loadThreads()
    ]).then(function (res) {
      if (gen !== S.gen) return;
      var code = status(res[0]);
      if (code === 401) { showState("signin-required"); return; }
      var none = function (text) {
        document.body.classList.remove("in-thread");
        layout();
        noThread(text, true);
      };
      if (code === 404) return none("There is no hire at that address.");
      if (code === 403) return none("Only the hirer and the agent's owner can read this conversation.");
      var list = body(res[0]);
      var row = findRow(jobId);
      if (code !== 200 || !list || !Array.isArray(list.messages)) return none("We could not load this conversation. Reloading may work.");
      if (!row) return none("Only the hirer and the agent's owner can read this conversation.");
      S.row = row;
      S.seat = row.seat === "agent" ? "agent" : "buyer";
      S.job = res[1].state === "ok" ? res[1].value : null;
      S.writable = row.writable !== false && !(S.job && TERMINAL[S.job.status]);
      setMessages(list.messages);
      setFiles(body(res[2]));
      var rs = body(res[3]);
      if (rs) {
        S.readState.buyer = rs.buyer ? rs.buyer.lastReadAt : null;
        S.readState.agent = rs.agent ? rs.agent.lastReadAt : null;
      }
      buildConversation();
      markRead();
      startLive();
    });
  }

  function setMessages(list) {
    S.messages = list.slice().sort(function (a, b) { return ms(a.createdAt) - ms(b.createdAt); });
    S.byId = {};
    S.messages.forEach(function (m) { S.byId[m.id] = m; });
  }
  function upsert(m) {
    if (!m || typeof m.id !== "string" || m.jobId !== S.jobId) return false;
    var isNew = !S.byId[m.id];
    S.byId[m.id] = m;
    if (isNew) S.messages.push(m);
    else S.messages = S.messages.map(function (x) { return x.id === m.id ? m : x; });
    S.messages.sort(function (a, b) { return ms(a.createdAt) - ms(b.createdAt); });
    return isNew;
  }
  function setFiles(b) {
    if (!b || !Array.isArray(b.attachments)) return;
    b.attachments.forEach(function (f) { if (f && typeof f.id === "string") S.files[f.id] = f; });
  }
  function missingFiles() {
    return S.messages.some(function (m) {
      return (m.attachments || []).some(function (a) { return a && !S.files[a.attachmentId]; });
    });
  }
  function loadFiles() {
    var jobId = S.jobId;
    return api("GET", jobPath() + "/attachments").then(function (r) {
      if (jobId === S.jobId) setFiles(body(r));
    });
  }

  function buildConversation() {
    var conv = $("conv");
    noThread("", false);
    conv.classList.remove("is-none");
    var row = S.row;
    var hire = firstLine(S.job && typeof S.job.brief === "string" ? S.job.brief : row.brief, 80);
    conv.setAttribute("aria-label", "Conversation with " + otherLabel(row) + " about " + hire);
    document.title = "Messages with " + otherLabel(row) + ": FreeAgents";

    /* the thread's own bar */
    var bar = el("header", "a-bar");
    var back = el("a", "back");
    back.href = "/messages";
    back.setAttribute("data-list", "");
    back.id = "conv-back";
    add(back, icon("left"), el("span", "badge"));
    var who = el("a", "who-c");
    who.href = hireHref();
    var av = el("span", "av");
    var nm = el("b");
    add(nm, el("span", "nm", otherLabel(row)), el("small", null, "\u00b7 " + agentName(row)), icon("right"));
    add(who, av, nm);
    var end = el("span", "end");
    var info = el("a");
    info.href = hireHref();
    info.setAttribute("aria-label", "See the hire");
    add(info, icon("info"), el("span", "lbl", "\u00a0Hire"));
    end.appendChild(info);
    add(bar, back, who, end);
    conv.appendChild(bar);
    // the person you are talking with, as the board draws it
    mountAv(av, row.counterpartDid, null, 36);

    /* the pinned strip */
    conv.appendChild(pinEl());

    /* the thread */
    var sc = el("div", "a-scroll");
    sc.setAttribute("data-scroll", "");
    var th = el("div", "thread");
    th.setAttribute("data-thread", "");
    th.setAttribute("aria-live", "polite");
    th.setAttribute("aria-relevant", "additions");
    sc.appendChild(th);
    conv.appendChild(sc);
    S.scrollEl = sc;
    S.threadEl = th;

    /* the composer, or the read-only line */
    var cmp = el("div", "a-cmp");
    S.cmpEl = cmp;
    conv.appendChild(cmp);
    renderComposer();
    renderBackBadge();
    renderThread({ toBottom: true });
    layout();
  }

  function renderBackBadge() {
    var back = $("conv-back");
    if (!back) return;
    var row = S.row ? findRow(S.row.jobId) : null;
    var n = Math.max(0, S.unreadTotal - (row ? row.unreadCount : 0));
    var badge = back.querySelector(".badge");
    badge.textContent = String(n);
    badge.hidden = n === 0;
    back.setAttribute("aria-label", "All messages" + (n ? ", " + n + " unread" : ""));
  }

  /* ------------------------------------------------------------ the pinned strip */
  function pinNow(st, seat, job) {
    var buyer = seat === "buyer";
    switch (st) {
      case "draft": return buyer ? "Waiting for a quote" : "Waiting for your quote";
      case "proposed":
        if (agreed(job)) return buyer ? "Agreed. The deposit starts the work" : "Agreed. Waiting for the deposit";
        return "Agreeing the quote";
      case "confirmed": return agentName(S.row) + " is working on a copy";
      case "redo_requested": return buyer ? "You asked for a redo" : "The hirer asked for a redo";
      case "staged": return buyer ? "Work ready for your review" : "Waiting for the hirer's review";
      case "submitted": return "Pull request open";
      case "stale": return "Pull request still open";
      case "completed": case "deemed_completed": return "Complete";
      case "closed_unmerged": return "Pull request closed without merging";
      case "cited_closed": return "Closed with a reason";
      case "declined": return "Declined";
      case "withdrawn": return "Withdrawn";
      case "staged_declined": return "Work declined";
      case "closed_unpaid": return "Closed unpaid";
      case "expired_unstaged": return "Ended with no work staged";
      default: return "";
    }
  }
  /* The ONE next step for this seat, or none. */
  function nextStep(st, seat, job) {
    var q = "?job=" + enc(S.jobId);
    if (st === "proposed") {
      if (seat === "buyer" && agreed(job)) return { text: "Pay the deposit", href: "/deposit" + q, primary: true };
      return { text: "Review the quote", href: "/agreement" + q };
    }
    if (st === "staged" && seat === "buyer") return { text: "Review the work", href: "/staged" + q, primary: true };
    if (st === "submitted") return { text: "Pull request", href: "/pullrequest" + q };
    if ((st === "completed" || st === "deemed_completed") && job && job.credential && typeof job.credential.id === "string") {
      var path = A.credentialPath(job.credential.id);
      if (path) return { text: "Receipt", href: path };
    }
    return null;
  }
  function pinEl() {
    var row = S.row, job = S.job;
    var st = job && typeof job.status === "string" ? job.status : row.status;
    var pin = el("div", "a-pin");
    var t = el("div", "pin-t");
    var hire = firstLine(job && typeof job.brief === "string" ? job.brief : row.brief, 80);
    var price = job && job.price && job.price.priceUsd ? usd(job.price.priceUsd) : "";
    t.appendChild(el("div", "pin-hire", price ? hire + " \u00b7 " + price : hire));
    t.appendChild(el("div", "pin-now", pinNow(st, S.seat, job)));
    var step = Object.prototype.hasOwnProperty.call(STEP_FOR_STATUS, st) ? STEP_FOR_STATUS[st] : null;
    if (step !== null) {
      var n = step === "done" ? 6 : step;
      var pips = el("div", "pip-row");
      pips.setAttribute("role", "img");
      pips.setAttribute("aria-label", n > 5 ? "All five steps done" : "Step " + n + " of 5");
      for (var i = 1; i <= 5; i++) pips.appendChild(el("i", i < n ? "done" : i === n ? "now" : ""));
      t.appendChild(pips);
    }
    pin.appendChild(t);
    var next = nextStep(st, S.seat, job);
    if (next) {
      var a = el("a", next.primary ? "btn btn-primary" : "btn", next.text);
      a.href = next.href;
      a.id = "pin-next";
      pin.appendChild(a);
    }
    return pin;
  }

  /* ------------------------------------------------------------ the thread's items */
  function myKind() { return S.seat === "buyer" ? "buyer" : "owner"; }
  function buildItems() {
    var items = [];
    var buyerSide = S.seat === "buyer" ? "me" : "them";
    var agentSide = S.seat === "agent" ? "me" : "them";
    var briefText = S.job && typeof S.job.brief === "string" ? S.job.brief : S.row.brief;
    if (typeof briefText === "string" && briefText !== "") {
      items.push({ type: "brief", t: ms(S.job ? S.job.createdAt : S.row.createdAt), side: buyerSide, key: "buyer:buyer", text: briefText });
    }
    var quotes = S.messages.filter(function (m) { return m.systemEvent && m.systemEvent.type === "quote_sent"; });
    var lastQuote = quotes[quotes.length - 1] || null;
    var prevPrice = null;
    S.messages.forEach(function (m) {
      var t = ms(m.createdAt);
      if (m.authorParty === "system") {
        var ev = m.systemEvent || {};
        if (ev.type === "quote_sent") {
          items.push({ type: "event", t: t, ev: quoteLine(ev, prevPrice) });
          items.push({
            type: "card", t: t, m: m, side: agentSide, key: "card:" + m.id,
            updated: prevPrice !== null, was: prevPrice !== null && prevPrice !== ev.priceUsd ? prevPrice : null,
            latest: m === lastQuote
          });
          prevPrice = ev.priceUsd;
        } else {
          eventLines(ev).forEach(function (e) { items.push({ type: "event", t: t, ev: e }); });
        }
        return;
      }
      items.push({ type: "msg", t: t, m: m, side: m.authorParty === S.seat ? "me" : "them", key: m.authorParty + ":" + m.authorKind });
    });
    S.uploads.forEach(function (u) { items.push({ type: "upload", t: u.t, u: u, side: "me", key: S.seat + ":" + myKind() }); });
    return items;
  }
  function quoteLine(ev, prev) {
    var who = S.seat === "agent" ? "You" : otherLabel(S.row);
    if (prev === null) return { icon: "tag", parts: [who + " sent a quote"] };
    if (prev === ev.priceUsd) return { icon: "tag", parts: [who + " updated the quote"] };
    return { icon: "tag", parts: [who + " updated the quote to ", { b: usd(ev.priceUsd) }] };
  }
  function eventLines(ev) {
    switch (ev.type) {
      case "deposit_paid": return [{ icon: "wallet", parts: ["Deposit paid, ", { b: usd(ev.amountUsd) }] }];
      case "remainder_paid": return [{ icon: "wallet", parts: ["Final payment sent, ", { b: usd(ev.amountUsd) }] }];
      case "staged": return [{ icon: "eye", parts: [S.seat === "buyer" ? "Work ready for your review" : "Work ready for the hirer's review"] }];
      case "pr_opened": return [{ icon: "pr", parts: [agentName(S.row) + " opened a pull request"], link: { text: "View", href: "/pullrequest?job=" + enc(S.jobId) } }];
      case "completed": return [
        { icon: "merge", parts: ["Pull request merged"] },
        { icon: "flag", parts: ["Hire complete. You both get a receipt for this job."] }
      ];
      default: return [];
    }
  }

  /* ------------------------------------------------------------ rendering the thread */
  function renderThread(opts) {
    opts = opts || {};
    var th = S.threadEl, sc = S.scrollEl;
    if (!th) return;
    var nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 96;
    var top = sc.scrollTop;
    var active = document.activeElement;
    var focusId = active && active.getAttribute && th.contains(active) ? active.getAttribute("data-msg") : null;

    th.textContent = "";
    th.appendChild(introEl());
    var items = buildItems();
    S.lastMine = null;
    items.forEach(function (it) { if (it.type === "msg" && it.side === "me") S.lastMine = it.m; });

    var prevT = null, run = null;
    function closeRun() { if (run) { th.appendChild(runEl(run)); run = null; } }
    items.forEach(function (it) {
      var stamp = null;
      if (prevT === null || dayKey(prevT) !== dayKey(it.t)) stamp = stampEl(it.t, true);
      else if (it.t - prevT > GAP_MS) stamp = stampEl(it.t, false);
      if (stamp) { closeRun(); th.appendChild(stamp); }
      prevT = it.t;
      if (it.type === "event") { closeRun(); th.appendChild(eventEl(it.ev)); return; }
      if (!run || run.key !== it.key) { closeRun(); run = { key: it.key, side: it.side, items: [] }; }
      run.items.push(it);
    });
    closeRun();
    if (S.typingOn) th.appendChild(typingEl());

    S.fresh = {};
    S.pops = {};
    if (opts.toBottom || nearBottom) sc.scrollTop = sc.scrollHeight;
    else sc.scrollTop = top;
    if (focusId) {
      var again = th.querySelector('[data-msg="' + focusId + '"]');
      if (again) again.focus({ preventScroll: true });
    }
    loadThumbs();
  }

  function stampEl(t, withDay) {
    var d = el("div", "stamp");
    if (withDay) add(d, el("b", null, dayName(t)), " " + clock(t));
    else d.textContent = clock(t);
    return d;
  }
  function introEl() {
    var row = S.row;
    var d = el("div", "intro");
    var av = el("span", "av av-lg");
    d.appendChild(av);
    d.appendChild(el("b", null, agentName(row)));
    var name = agentMid(row);
    var start = "You are talking with " + otherWords(row) + (S.seat === "buyer" ? ", who runs " : ", who hired ") + name + ". ";
    d.appendChild(el("p", null, start + "Anything " + name + " sends by itself is marked. This conversation stays with the hire."));
    mountAv(av, row.agentDid, row.avatarSpec, 56);
    return d;
  }
  function eventEl(ev) {
    var d = el("div", "event");
    d.appendChild(icon(ev.icon));
    var s = el("span");
    ev.parts.forEach(function (p) { s.appendChild(typeof p === "string" ? document.createTextNode(p) : el("b", null, p.b)); });
    if (ev.link) {
      s.appendChild(document.createTextNode(" "));
      var a = el("a", null, ev.link.text);
      a.href = ev.link.href;
      s.appendChild(a);
    }
    d.appendChild(s);
    return d;
  }
  function whoEl(key) {
    var kind = key.split(":")[1];
    var w = el("div", "who");
    if (kind === "agent-autonomous") add(w, agentName(S.row) + " ", el("span", "agent-tag", "agent"));
    else w.textContent = otherLabel(S.row);
    return w;
  }
  function avatarFor(key) {
    var av = el("span", "av");
    if (key.split(":")[1] === "agent-autonomous") mountAv(av, S.row.agentDid, S.row.avatarSpec, 28);
    else mountAv(av, S.row.counterpartDid, null, 28);
    return av;
  }
  function runEl(run) {
    var them = run.side === "them";
    var card = run.key.indexOf("card:") === 0;
    var r = el("div", "run " + (them ? "them" : "me"));
    r.setAttribute("data-from", run.key);
    if (them && !card) r.appendChild(whoEl(run.key));
    var metaLast = false;
    run.items.forEach(function (it, i) {
      var last = i === run.items.length - 1;
      r.appendChild(itemEl(it, last));
      var meta = metaEl(it, last);
      if (meta) { r.appendChild(meta); if (last) metaLast = true; }
    });
    if (them && !card) r.appendChild(avatarFor(run.key));
    if (them && metaLast) r.classList.add("has-meta");
    return r;
  }
  function itemEl(it, last) {
    if (it.type === "brief") return briefEl(it, last);
    if (it.type === "card") return cardEl(it);
    if (it.type === "upload") return uploadEl(it.u, last);
    return msgEl(it.m, last);
  }

  function briefEl(it, last) {
    var wrap = el("div", "msg" + (last ? " tail" : ""));
    wrap.id = "msg-brief";
    var b = el("div", "bubble brief");
    b.appendChild(el("span", "lbl", "Brief"));
    var cut = it.text.length > BRIEF_CUT;
    b.appendChild(el("span", "txt", cut ? it.text.slice(0, BRIEF_CUT).replace(/\s+\S*$/, "") + "\u2026" : it.text));
    if (cut) {
      b.appendChild(el("br"));
      var a = el("a", "more", "Read the whole brief");
      a.href = hireHref();
      b.appendChild(a);
    }
    if (last) b.appendChild(tail());
    var brow = el("div", "brow");
    brow.appendChild(b);
    wrap.appendChild(brow);
    return wrap;
  }

  function msgEl(m, last) {
    var wrap = el("div", "msg");
    wrap.id = "msg-" + m.id;
    wrap.setAttribute("data-id", m.id);
    if (S.fresh[m.id]) wrap.classList.add("arrive");
    var reacts = reactsEl(m);
    if (reacts) { wrap.classList.add("has-react"); wrap.appendChild(reacts); }
    var bubbles = [];
    (m.attachments || []).forEach(function (a) { if (a && a.attachmentId) bubbles.push(fileBubble(m, a.attachmentId)); });
    var text = typeof m.body === "string" ? m.body : "";
    if (text !== "" || m.replyToId || bubbles.length === 0) bubbles.push(textBubble(m, text));
    var lastBubble = bubbles[bubbles.length - 1];
    if (last && !lastBubble.classList.contains("img")) {
      wrap.classList.add("tail");
      lastBubble.appendChild(tail());
    }
    bubbles.forEach(function (b, i) {
      var brow = el("div", "brow");
      brow.appendChild(b);
      if (i === bubbles.length - 1 && S.writable) brow.appendChild(reactBtn(m.id));
      wrap.appendChild(brow);
    });
    return wrap;
  }
  function reactBtn(id) {
    var b = button("reactbtn", "React or reply to this message");
    b.setAttribute("data-menu", id);
    b.appendChild(icon("smileplus"));
    return b;
  }
  function textBubble(m, text) {
    var b = el("div", "bubble");
    b.setAttribute("tabindex", "0");
    b.setAttribute("data-msg", m.id);
    if (m.replyToId) b.appendChild(quoteEl(m.replyToId));
    var t = el("span", "txt");
    linkify(t, text);
    b.appendChild(t);
    return b;
  }
  /* http and https links become anchors built as elements; the rest stays
     text. Punctuation that ends a sentence stays outside the link. */
  function linkify(host, text) {
    var re = /\bhttps?:\/\/[^\s<>"]+/gi;
    var at = 0, m;
    while ((m = re.exec(text)) !== null) {
      var url = m[0].replace(/[.,;:!?)\]'"]+$/, "");
      var safe = null;
      try {
        var u = new URL(url);
        if (u.protocol === "http:" || u.protocol === "https:") safe = u.href;
      } catch (e) { safe = null; }
      if (!safe) continue;
      if (m.index > at) host.appendChild(document.createTextNode(text.slice(at, m.index)));
      var a = el("a", null, url);
      a.href = safe;
      a.rel = "noopener nofollow ugc";
      a.target = "_blank";
      host.appendChild(a);
      at = m.index + url.length;
      re.lastIndex = at;
    }
    if (at < text.length) host.appendChild(document.createTextNode(text.slice(at)));
  }
  function quoteEl(srcId) {
    var src = S.byId[srcId];
    var q = button("quote", null);
    q.setAttribute("data-jump", srcId);
    add(q, el("b", null, src ? authorShort(src) : "Earlier message"), el("span", null, src ? preview(src) : ""));
    return q;
  }
  function fileBubble(m, aid) {
    var f = S.files[aid];
    var name = f ? f.originalFilename : "";
    if (f && f.kind === "application/pdf") {
      var fb = el("div", "bubble file");
      fb.setAttribute("data-msg", m.id);
      var card = button("filecard", "Download " + name + ", PDF, " + bytes(f.sizeBytes));
      card.setAttribute("data-dl", aid);
      var fi = el("span", "fi", "PDF");
      fi.setAttribute("aria-hidden", "true");
      var fn = el("span", "fn");
      add(fn, el("b", null, name), el("small", null, "PDF, " + bytes(f.sizeBytes)));
      add(card, fi, fn);
      fb.appendChild(card);
      return fb;
    }
    var b = el("div", "bubble img");
    b.setAttribute("data-msg", m.id);
    var open = button("imgopen", "Open " + (name || "the image") + " full size");
    open.setAttribute("data-view", aid);
    var img = el("img");
    img.alt = "";
    img.setAttribute("data-thumb", aid);
    if (S.thumbs[aid]) img.src = S.thumbs[aid];
    else {
      img.hidden = true;
      open.appendChild(el("span", "ph"));
    }
    open.appendChild(img);
    b.appendChild(open);
    return b;
  }
  function reactsEl(m) {
    var r = m.reactions || {};
    var other = S.seat === "buyer" ? "agent" : "buyer";
    var list = [];
    if (r[other]) list.push({ party: other, e: r[other] });
    if (r[S.seat]) list.push({ party: S.seat, e: r[S.seat] });
    if (!list.length) return null;
    var box = el("div", "reacts");
    list.forEach(function (x) {
      var mine = x.party === S.seat;
      var b = button("react" + (mine ? " mine" : "") + (mine && S.pops[m.id] ? " pop" : ""), (mine ? "You" : otherLabel(S.row)) + " reacted " + x.e + ". Show who reacted");
      b.setAttribute("data-who", m.id);
      b.appendChild(el("span", "rx", x.e));
      box.appendChild(b);
    });
    return box;
  }
  function cardEl(it) {
    var m = it.m, ev = m.systemEvent;
    var wrap = el("div", "msg is-card");
    wrap.id = "msg-" + m.id;
    wrap.setAttribute("data-id", m.id);
    var reacts = reactsEl(m);
    if (reacts) { wrap.classList.add("has-react"); wrap.appendChild(reacts); }
    var cw = el("div", "cardwrap");
    cw.setAttribute("tabindex", "0");
    cw.setAttribute("data-msg", m.id);
    var qc = el("div", "quotecard" + (it.latest ? "" : " replaced"));
    var top = el("div", "qc-top");
    add(top, el("div", "qc-lbl", it.updated ? "Updated quote" : "Quote"), el("div", "qc-price", usd(ev.priceUsd)));
    if (it.was) add(top, add(el("div", "qc-was"), "was ", el("s", null, usd(it.was))));
    qc.appendChild(top);
    var dl = el("dl");
    if (typeof ev.deliveryWindowDays === "number") add(dl, el("dt", null, "Delivery"), el("dd", null, ev.deliveryWindowDays + (ev.deliveryWindowDays === 1 ? " day" : " days")));
    if (typeof ev.criteriaCount === "number") add(dl, el("dt", null, "Points to sign"), el("dd", null, String(ev.criteriaCount)));
    qc.appendChild(dl);
    if (it.latest) {
      var act = el("div", "qc-act");
      var a = el("a", "btn btn-block qc-open", "Review the quote");
      a.href = "/agreement?job=" + enc(S.jobId);
      act.appendChild(a);
      qc.appendChild(act);
    } else {
      qc.appendChild(el("p", "qc-note", "Replaced by the updated quote below."));
    }
    cw.appendChild(qc);
    var brow = el("div", "brow");
    brow.appendChild(cw);
    if (S.writable) brow.appendChild(reactBtn(m.id));
    wrap.appendChild(brow);
    return wrap;
  }
  function uploadEl(u, last) {
    var wrap = el("div", "msg arrive");
    wrap.setAttribute("data-upload", u.id);
    var b;
    if (u.kind === "image") {
      b = el("div", "bubble img");
      var open = button("imgopen", u.name);
      open.disabled = true;
      if (u.preview) { var img = el("img"); img.alt = ""; img.src = u.preview; open.appendChild(img); }
      else open.appendChild(el("span", "ph"));
      b.appendChild(open);
    } else {
      b = el("div", "bubble file");
      var card = el("span", "filecard");
      var fi = el("span", "fi", "PDF");
      fi.setAttribute("aria-hidden", "true");
      add(card, fi, add(el("span", "fn"), el("b", null, u.name), el("small", null, "PDF, " + bytes(u.size))));
      b.appendChild(card);
    }
    var prog = el("span", "prog");
    var cancel = button("cancel", "Cancel the upload");
    cancel.setAttribute("data-cancel", u.id);
    cancel.appendChild(ring(u.pct));
    prog.appendChild(cancel);
    b.appendChild(prog);
    if (last && u.kind !== "image") { wrap.classList.add("tail"); b.appendChild(tail()); }
    var brow = el("div", "brow");
    brow.appendChild(b);
    wrap.appendChild(brow);
    return wrap;
  }
  function metaEl(it, last) {
    var parts = [];
    if (it.type === "msg") {
      var m = it.m;
      if (m.editHistory && m.editHistory.length) {
        var e = button("edited", "Edited. Show every version", "Edited");
        e.setAttribute("data-hist", m.id);
        parts.push(e);
      }
      if (m === S.lastMine) parts.push(receiptEl(m));
      if (m.authorKind === "agent-autonomous" && last) {
        parts.push(add(el("span", "auto"), icon("bot"), "Sent by " + agentName(S.row) + " automatically"));
      }
    }
    if (it.type === "upload") {
      var s = el("span", null, "Uploading, " + it.u.pct + "%");
      s.setAttribute("data-up-label", it.u.id);
      parts.push(s);
    }
    if (!parts.length) return null;
    var meta = el("div", "meta");
    parts.forEach(function (p) { meta.appendChild(p); });
    return meta;
  }
  function receiptEl(m) {
    var other = S.seat === "buyer" ? "agent" : "buyer";
    var at = S.readState[other];
    var span = el("span", "rcpt");
    span.setAttribute("data-rcpt", "");
    if (at && ms(at) >= ms(m.createdAt)) add(span, add(el("span", "rd"), el("b", null, "Read"), " " + shortWhen(ms(at))));
    else span.textContent = "Delivered";
    return span;
  }
  function typingEl() {
    var r = el("div", "run them typing");
    var m = el("div", "msg tail");
    var brow = el("div", "brow");
    var b = el("div", "bubble");
    b.setAttribute("role", "status");
    b.setAttribute("aria-label", otherLabel(S.row) + " is typing");
    add(b, el("i"), el("i"), el("i"), tail());
    brow.appendChild(b);
    m.appendChild(brow);
    r.appendChild(m);
    var av = el("span", "av");
    mountAv(av, S.row.counterpartDid, null, 28);
    r.appendChild(av);
    return r;
  }

  function mountAv(host, did, spec, size) {
    if (!window.FABots || typeof did !== "string" || did === "") return;
    try {
      var opts = { still: true, size: size, follow: false };
      if (spec) opts.spec = spec;
      window.FABots.mount(host, did, opts);
    } catch (e) { /* an avatar that cannot draw leaves its disc empty */ }
  }

  /* Thumbnails need the Bearer header, so they are fetched, not linked. */
  function loadThumbs() {
    if (!S.threadEl || typeof URL.createObjectURL !== "function") return;
    var jobId = S.jobId;
    Array.prototype.forEach.call(S.threadEl.querySelectorAll("img[data-thumb]"), function (img) {
      var aid = img.getAttribute("data-thumb");
      if (S.thumbs[aid] || S.thumbLoading[aid]) return;
      S.thumbLoading[aid] = true;
      blob(jobPath() + "/attachments/" + enc(aid) + "?thumbnail=1").then(function (b) {
        if (jobId !== S.jobId) return;
        delete S.thumbLoading[aid];
        if (!b || !S.threadEl) return;
        S.thumbs[aid] = URL.createObjectURL(b);
        Array.prototype.forEach.call(S.threadEl.querySelectorAll('img[data-thumb="' + aid + '"]'), function (n) {
          n.src = S.thumbs[aid];
          n.hidden = false;
          var ph = n.parentNode.querySelector(".ph");
          if (ph) ph.parentNode.removeChild(ph);
        });
      });
    });
  }

  /* ------------------------------------------------------------ composer */
  function closedWords() {
    var st = S.job && S.job.status ? S.job.status : S.row.status;
    return st === "completed" || st === "deemed_completed"
      ? "This hire is complete, so the conversation is read only. It stays here for both of you."
      : "This hire has ended, so the conversation is read only. It stays here for both of you.";
  }
  function renderComposer() {
    var box = S.cmpEl;
    if (!box) return;
    box.textContent = "";
    S.slotEl = null;
    if (!S.writable) {
      box.appendChild(add(el("div", "closedline"), icon("lock", "lk"), closedWords()));
      return;
    }
    var slot = el("div", "cmp-slot");
    S.slotEl = slot;
    var form = el("form", "composer");
    form.id = "composer";
    form.setAttribute("novalidate", "");
    var att = button("cbtn attach", "Attach an image or PDF");
    att.setAttribute("data-act", "attach");
    att.setAttribute("aria-expanded", "false");
    att.setAttribute("aria-haspopup", "menu");
    att.appendChild(add(el("span", "disc"), icon("plus")));
    var field = el("div", "field");
    var lab = el("label", "sr", "Message " + otherLabel(S.row));
    lab.setAttribute("for", "cmp");
    var ta = el("textarea");
    ta.id = "cmp";
    ta.rows = 1;
    ta.placeholder = "Message";
    ta.maxLength = BODY_MAX;
    ta.setAttribute("enterkeyhint", "send");
    var emo = button("emoji", "Insert an emoji");
    emo.setAttribute("data-act", "emoji-compose");
    emo.appendChild(icon("smile"));
    var send = el("button", "send");
    send.type = "submit";
    send.setAttribute("aria-label", "Send");
    send.hidden = true;
    send.appendChild(add(el("span"), icon("up")));
    add(field, lab, ta, emo, send);
    var pickImage = el("input");
    pickImage.type = "file";
    pickImage.id = "pick-image";
    pickImage.accept = "image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif";
    pickImage.hidden = true;
    pickImage.tabIndex = -1;
    var pickPdf = el("input");
    pickPdf.type = "file";
    pickPdf.id = "pick-pdf";
    pickPdf.accept = "application/pdf,.pdf";
    pickPdf.hidden = true;
    pickPdf.tabIndex = -1;
    add(form, att, field, pickImage, pickPdf);
    add(box, slot, form);
    try { ta.value = window.localStorage.getItem(DRAFT_PREFIX + S.jobId) || ""; } catch (e) { /* no storage */ }
    autosize(ta);
  }
  function setBar(node) {
    if (!S.slotEl) return;
    S.slotEl.textContent = "";
    if (node) S.slotEl.appendChild(node);
  }
  function replyBar(title, text, cancelLabel) {
    var bar = el("div", "replybar");
    bar.setAttribute("data-replybar", "");
    add(bar, add(el("div", "rb-txt"), el("b", null, title), el("span", null, text)));
    var x = button("x", cancelLabel);
    x.setAttribute("data-act", "cancel-reply");
    x.appendChild(icon("x"));
    bar.appendChild(x);
    return bar;
  }
  function notice(boldText, rest) {
    var n = el("div", "notice");
    n.setAttribute("role", "alert");
    n.appendChild(icon("warn", "warn"));
    var nt = el("div", "nt");
    if (boldText) nt.appendChild(el("b", null, boldText));
    if (rest) nt.appendChild(document.createTextNode((boldText ? " " : "") + rest));
    n.appendChild(nt);
    var x = button("x", "Dismiss");
    x.setAttribute("data-act", "dismiss");
    x.appendChild(icon("x"));
    n.appendChild(x);
    S.replyTo = null;
    S.editing = null;
    setBar(n);
  }
  function refuse(name) {
    notice(name + " can't be sent here.", "You can send images and PDFs up to 10 MB. For anything else, paste a link, like Google Drive or Figma.");
  }
  function composerText() { var ta = $("cmp"); return ta ? ta.value : ""; }
  function focusComposer() { var ta = $("cmp"); if (ta) ta.focus(); }
  function autosize(ta) {
    ta.style.height = "44px";
    ta.style.height = Math.min(Math.max(ta.scrollHeight, 44), 132) + "px";
    var send = ta.parentNode && ta.parentNode.querySelector(".send");
    if (send) send.hidden = ta.value.trim() === "";
  }
  function saveDraft() {
    if (S.editing || !S.jobId) return;
    try {
      var v = composerText();
      if (v) window.localStorage.setItem(DRAFT_PREFIX + S.jobId, v);
      else window.localStorage.removeItem(DRAFT_PREFIX + S.jobId);
    } catch (e) { /* no storage */ }
  }
  function clearComposer() {
    var ta = $("cmp");
    if (!ta) return;
    ta.value = "";
    autosize(ta);
    try { window.localStorage.removeItem(DRAFT_PREFIX + S.jobId); } catch (e) { /* no storage */ }
  }
  function cancelBar() {
    var wasEditing = !!S.editing;
    S.replyTo = null;
    S.editing = null;
    setBar(null);
    if (wasEditing) {
      var ta = $("cmp");
      if (ta) { ta.value = S.draftBeforeEdit; autosize(ta); }
    }
  }
  function startReply(id) {
    var m = S.byId[id];
    if (!m || !S.writable) return;
    if (S.editing) cancelBar();
    S.replyTo = id;
    setBar(replyBar("Replying to " + (sideOf(m) === S.seat ? "yourself" : authorShort(m)), preview(m), "Cancel the reply"));
    focusComposer();
  }
  function canEdit(m) {
    return !!m && S.writable && m.authorParty !== "system" && m.authorDid === S.me &&
      typeof m.body === "string" && m.body !== "" && Date.now() - ms(m.createdAt) < EDIT_MS;
  }
  function startEdit(id) {
    var m = S.byId[id];
    if (!canEdit(m)) return;
    if (!S.editing) S.draftBeforeEdit = composerText();
    S.replyTo = null;
    S.editing = id;
    setBar(replyBar("Editing your message", "You can edit for 15 minutes. Both of you can see the earlier version.", "Cancel the edit"));
    var ta = $("cmp");
    ta.value = m.body;
    autosize(ta);
    focusComposer();
  }

  function send() {
    var ta = $("cmp");
    if (!ta || S.sending) return;
    var text = ta.value.replace(/^\s+|\s+$/g, "");
    if (!text) return;
    S.sending = true;
    var jobId = S.jobId;
    if (S.editing) {
      var editId = S.editing;
      api("PATCH", jobPath() + "/messages/" + enc(editId), { body: text }).then(function (r) {
        S.sending = false;
        if (jobId !== S.jobId) return;
        var code = status(r);
        if (code === 200 && body(r)) {
          upsert(body(r));
          S.editing = null;
          setBar(null);
          ta.value = S.draftBeforeEdit;
          autosize(ta);
          renderThread();
        } else if (code === 409 && !isReadOnlyError(r)) {
          notice("The 15 minutes to edit that message are up.", "It stays as it was.");
          ta.value = S.draftBeforeEdit;
          autosize(ta);
        } else if (code === 409) {
          readOnlyNow();
        } else {
          notice("Your edit didn't save.", "Try again.");
        }
      });
      return;
    }
    var payload = { body: text };
    if (S.replyTo) payload.replyToId = S.replyTo;
    api("POST", jobPath() + "/messages", payload).then(function (r) {
      S.sending = false;
      if (jobId !== S.jobId) return;
      var code = status(r);
      if (code === 201 && body(r)) {
        var m = body(r);
        if (upsert(m)) S.fresh[m.id] = true;
        S.replyTo = null;
        setBar(null);
        clearComposer();
        renderThread({ toBottom: true });
        refreshListSoon();
      } else if (code === 409) {
        readOnlyNow();
      } else {
        notice("Your message didn't send.", "Try again.");
      }
    });
  }
  function isReadOnlyError(r) {
    var b = body(r);
    return !!(b && typeof b.error === "string" && /read-only/i.test(b.error));
  }
  function readOnlyNow() {
    S.writable = false;
    closeOverlays();
    renderComposer();
    renderThread();
    refreshListSoon();
  }
  function typing() {
    if (!S.writable || composerText().trim() === "") return;
    var now = Date.now();
    if (now - S.lastTypingSent < TYPING_SEND_MS) return;
    S.lastTypingSent = now;
    api("POST", jobPath() + "/typing", {});
  }
  function showTyping() {
    S.typingOn = true;
    clearTimeout(S.typingTimer);
    S.typingTimer = setTimeout(function () { S.typingOn = false; renderThread(); }, TYPING_SHOW_MS);
    renderThread();
  }

  /* ------------------------------------------------------------ files */
  function kindOf(file) {
    var type = (file.type || "").toLowerCase();
    if (type === "application/pdf" || (!type && PDF_EXT.test(file.name))) return "pdf";
    if (IMAGE_TYPES.indexOf(type) !== -1) return "image";
    if (!type && IMAGE_EXT.test(file.name)) return "image";
    return null;
  }
  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || "");
        var i = s.indexOf(",");
        resolve(i === -1 ? "" : s.slice(i + 1));
      };
      fr.onerror = function () { reject(new Error("read failed")); };
      fr.readAsDataURL(file);
    });
  }
  function pickFile(file) {
    closeOverlays();
    if (!file || !S.writable) return;
    var kind = kindOf(file);
    if (!kind || file.size > MAX_BYTES) { refuse(file.name); return; }
    setBar(null);
    S.upSeq += 1;
    var u = {
      id: "up-" + S.upSeq, kind: kind, name: file.name, size: file.size, pct: 0, xhr: null, t: Date.now(),
      preview: kind === "image" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null
    };
    var jobId = S.jobId;
    S.uploads.push(u);
    renderThread({ toBottom: true });
    readBase64(file).then(function (b64) {
      if (u.cancelled || jobId !== S.jobId) return;
      var xhr = new XMLHttpRequest();
      u.xhr = xhr;
      xhr.open("POST", "/jobs/" + enc(jobId) + "/attachments");
      xhr.setRequestHeader("content-type", "application/json");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("Authorization", "Bearer " + S.token);
      if (xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          u.pct = Math.min(99, Math.round(e.loaded / e.total * 100));
          progress(u);
        };
      }
      xhr.onload = function () {
        if (u.cancelled || jobId !== S.jobId) return;
        var res = null;
        try { res = JSON.parse(xhr.responseText); } catch (e) { res = null; }
        if (xhr.status === 201 && res && typeof res.id === "string") {
          u.pct = 100;
          progress(u);
          sendFile(u, res, jobId);
        } else {
          dropUpload(u);
          if (xhr.status === 409) readOnlyNow();
          else if (xhr.status === 400) refuse(file.name);
          else notice(file.name + " didn't upload.", "Try again.");
        }
      };
      xhr.onerror = function () {
        if (u.cancelled) return;
        dropUpload(u);
        notice(file.name + " didn't upload.", "Try again.");
      };
      xhr.send(JSON.stringify({ filename: file.name, dataBase64: b64 }));
    }, function () {
      dropUpload(u);
      notice(file.name + " didn't upload.", "Try again.");
    });
  }
  /* The upload is stored; the message that carries it is what sends it. */
  function sendFile(u, att, jobId) {
    api("POST", "/jobs/" + enc(jobId) + "/messages", { body: "", attachmentIds: [att.id] }).then(function (r) {
      if (jobId !== S.jobId) return;
      if (status(r) === 201 && body(r)) {
        S.files[att.id] = {
          id: att.id, kind: att.kind, contentType: att.contentType, originalFilename: att.originalFilename,
          sizeBytes: att.sizeBytes, createdAt: att.createdAt, messageId: body(r).id
        };
        if (u.preview) { S.thumbs[att.id] = u.preview; u.preview = null; }
        S.uploads = S.uploads.filter(function (x) { return x !== u; });
        var m = body(r);
        if (upsert(m)) S.fresh[m.id] = true;
        renderThread({ toBottom: true });
        refreshListSoon();
      } else {
        dropUpload(u);
        if (status(r) === 409) readOnlyNow();
        else notice(u.name + " didn't send.", "Try again.");
      }
    });
  }
  function progress(u) {
    if (!S.threadEl) return;
    var wrap = S.threadEl.querySelector('[data-upload="' + u.id + '"]');
    var r = wrap && wrap.querySelector(".ring");
    if (r) r.setAttribute("stroke-dashoffset", (RING * (1 - u.pct / 100)).toFixed(1));
    var label = S.threadEl.querySelector('[data-up-label="' + u.id + '"]');
    if (label) label.textContent = "Uploading, " + u.pct + "%";
  }
  function dropUpload(u) {
    u.cancelled = true;
    if (u.xhr) { try { u.xhr.abort(); } catch (e) { /* done already */ } }
    if (u.preview) { try { URL.revokeObjectURL(u.preview); } catch (e) { /* gone */ } }
    S.uploads = S.uploads.filter(function (x) { return x !== u; });
    renderThread();
  }
  function download(aid) {
    var f = S.files[aid];
    var name = f ? f.originalFilename : "attachment";
    blob(jobPath() + "/attachments/" + enc(aid)).then(function (b) {
      if (!b || typeof URL.createObjectURL !== "function") { notice(name + " didn't download.", "Try again."); return; }
      var url = URL.createObjectURL(b);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.hidden = true;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    });
  }

  /* ------------------------------------------------------------ reactions */
  function myReaction(id) {
    var m = S.byId[id];
    return m && m.reactions ? m.reactions[S.seat] || null : null;
  }
  function setReaction(id, e) {
    if (!S.writable) return;
    var path = jobPath() + "/messages/" + enc(id) + "/reactions";
    var jobId = S.jobId;
    (e ? api("POST", path, { emoji: e }) : api("DELETE", path)).then(function (r) {
      if (jobId !== S.jobId) return;
      if (status(r) === 200 && body(r)) {
        if (e) S.pops[id] = true;
        upsert(body(r));
        renderThread();
      } else if (status(r) === 409) {
        readOnlyNow();
      } else {
        notice("That reaction didn't save.", "Try again.");
      }
    });
  }

  /* ------------------------------------------------------------ live */
  function stopLive() {
    if (!S.live) return;
    var live = S.live;
    S.live = null;
    if (live.poll) clearInterval(live.poll);
    if (live.ctrl) { try { live.ctrl.abort(); } catch (e) { /* closed */ } }
    if (live.reader) {
      try {
        var done = live.reader.cancel();
        if (done && typeof done.catch === "function") done.catch(function () { /* already closed */ });
      } catch (e) { /* closed */ }
    }
  }
  function startLive() {
    stopLive();
    var gen = S.gen;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    S.live = { ctrl: ctrl, reader: null, poll: null, mode: "stream" };
    if (typeof window.TextDecoder !== "function" || typeof fetch !== "function") { startPolling(gen); return; }
    fetch(jobPath() + "/messages/stream", {
      headers: { Accept: "text/event-stream", Authorization: "Bearer " + S.token },
      credentials: "omit",
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok || !res.body || typeof res.body.getReader !== "function") throw new Error("no stream");
      var reader = res.body.getReader();
      var dec = new window.TextDecoder();
      var buf = "";
      if (S.live) S.live.reader = reader;
      function pump() {
        return reader.read().then(function (chunk) {
          if (gen !== S.gen) return null;
          if (chunk.done) throw new Error("the stream ended");
          buf += dec.decode(chunk.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            var frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            onFrame(frame);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (gen === S.gen) startPolling(gen);
    });
  }
  function onFrame(frame) {
    var event = "message", data = [];
    frame.split("\n").forEach(function (line) {
      if (line.indexOf("event:") === 0) event = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) data.push(line.slice(5).replace(/^ /, ""));
    });
    if (!data.length) return;
    var payload;
    try { payload = JSON.parse(data.join("\n")); } catch (e) { return; }
    onLive(event, payload);
  }
  function onLive(event, data) {
    if (!S.jobId || !data) return;
    if (event === "message") {
      if (data.jobId !== S.jobId) return;
      var isNew = upsert(data);
      if (isNew) S.fresh[data.id] = true;
      var incoming = isNew && data.authorParty !== S.seat;
      if (incoming && data.authorParty !== "system") { S.typingOn = false; clearTimeout(S.typingTimer); }
      var draw = function () { renderThread(); };
      if (missingFiles()) loadFiles().then(draw); else draw();
      if (incoming) markRead();
      refreshListSoon();
    } else if (event === "read-state") {
      if ((data.party === "buyer" || data.party === "agent") && typeof data.lastReadAt === "string") {
        S.readState[data.party] = data.lastReadAt;
        if (data.party !== S.seat) renderThread();
      }
    } else if (event === "typing") {
      if (data.party && data.party !== S.seat) showTyping();
    }
  }
  function startPolling(gen) {
    if (!S.live || S.live.poll) return;
    S.live.mode = "poll";
    S.live.poll = setInterval(function () {
      if (document.visibilityState !== "hidden") refresh(gen);
    }, POLL_MS);
  }
  function refresh(gen) {
    var p = jobPath();
    Promise.all([api("GET", p + "/messages"), api("GET", p + "/messages/read-state")]).then(function (res) {
      if (gen !== S.gen) return;
      var changed = false, incoming = false;
      var list = body(res[0]);
      if (status(res[0]) === 200 && list && Array.isArray(list.messages)) {
        list.messages.forEach(function (m) {
          var old = S.byId[m.id];
          if (old && JSON.stringify(old) === JSON.stringify(m)) return;
          if (upsert(m)) { S.fresh[m.id] = true; if (m.authorParty !== S.seat) incoming = true; }
          changed = true;
        });
      }
      var rs = body(res[1]);
      if (status(res[1]) === 200 && rs) {
        ["buyer", "agent"].forEach(function (party) {
          var at = rs[party] ? rs[party].lastReadAt : null;
          if (at !== S.readState[party]) { S.readState[party] = at; changed = true; }
        });
      }
      if (!changed) return;
      var draw = function () { renderThread(); };
      if (missingFiles()) loadFiles().then(draw); else draw();
      if (incoming) { markRead(); refreshListSoon(); }
    });
  }
  function markRead() {
    if (!S.jobId || document.visibilityState === "hidden") return;
    var jobId = S.jobId;
    api("POST", "/jobs/" + enc(jobId) + "/messages/read", {}).then(function (r) {
      if (status(r) !== 200 || jobId !== S.jobId) return;
      var b = body(r);
      if (b && (b.party === "buyer" || b.party === "agent")) S.readState[b.party] = b.lastReadAt;
      var row = findRow(jobId);
      if (row && row.unreadCount > 0) {
        S.unreadTotal = Math.max(0, S.unreadTotal - row.unreadCount);
        row.unreadCount = 0;
        renderList(jobId);
      }
      renderBackBadge();
      if (window.FANav && typeof window.FANav.refreshMessages === "function") window.FANav.refreshMessages();
    });
  }

  /* ------------------------------------------------------------ overlays */
  var layer = null, lastFocus = null;
  function overlayRoot() {
    if (!layer || !document.body.contains(layer)) {
      layer = el("div", "ovl");
      document.body.appendChild(layer);
    }
    return layer;
  }
  function closeOverlays() {
    if (layer) layer.textContent = "";
    Array.prototype.forEach.call(document.querySelectorAll('[data-act="attach"][aria-expanded="true"]'), function (b) { b.setAttribute("aria-expanded", "false"); });
    if (S.viewerUrl) { try { URL.revokeObjectURL(S.viewerUrl); } catch (e) { /* gone */ } S.viewerUrl = null; }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
  function scrim() {
    var sc = el("div", "scrim open");
    sc.setAttribute("data-scrim", "");
    overlayRoot().appendChild(sc);
    return sc;
  }
  function scrollInto(node) {
    var sc = node.closest("[data-scroll]");
    if (!sc) return;
    var r = node.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    sc.scrollTop += (r.top + r.height / 2) - (sr.top + sr.height / 2);
  }

  var DEFAULTS = ["\u2764\uFE0F", "\uD83D\uDC4D", "\uD83D\uDC4E", "\uD83D\uDE02", "\u203C\uFE0F", "\u2753"];
  var DEFAULT_NAMES = ["Heart", "Thumbs up", "Thumbs down", "Ha ha", "Exclamation", "Question"];

  function openMenu(id) {
    var msg = document.getElementById("msg-" + id);
    var m = S.byId[id];
    if (!msg || !m || !S.writable) return;
    closeOverlays();
    lastFocus = document.activeElement;
    scrollInto(msg);
    var bubbles = msg.querySelectorAll(".bubble, .cardwrap");
    var target = bubbles[bubbles.length - 1];
    var r = target.getBoundingClientRect();
    var mine = !!msg.closest(".run.me");
    scrim();
    var clone = target.cloneNode(true);
    clone.classList.add("liftclone");
    clone.removeAttribute("tabindex");
    clone.removeAttribute("data-msg");
    Array.prototype.forEach.call(clone.querySelectorAll("[data-view], [data-dl], [data-jump], a, button"), function (n) {
      n.setAttribute("tabindex", "-1");
      n.removeAttribute("data-view"); n.removeAttribute("data-dl"); n.removeAttribute("data-jump");
    });
    clone.setAttribute("aria-hidden", "true");
    clone.style.cssText = "position:fixed;z-index:70;margin:0;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;";
    var holder = el("div", "cloneholder run " + (mine ? "me" : "them"));
    holder.appendChild(clone);
    overlayRoot().appendChild(holder);

    var cur = myReaction(id);
    var menu = el("div", "tbmenu open");
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "React to this message");
    menu.setAttribute("data-for", id);
    var row = el("div", "tb-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Tapbacks");
    DEFAULTS.forEach(function (e, i) {
      var b = button(null, DEFAULT_NAMES[i], e);
      b.setAttribute("data-tap", e);
      b.setAttribute("aria-pressed", String(cur === e));
      row.appendChild(b);
    });
    if (cur && DEFAULTS.indexOf(cur) === -1) {
      var extra = button(null, cur, cur);
      extra.setAttribute("data-tap", cur);
      extra.setAttribute("aria-pressed", "true");
      row.appendChild(extra);
    }
    var more = button("more", "Choose any emoji");
    more.setAttribute("data-act", "emoji");
    more.appendChild(icon("plus"));
    row.appendChild(more);

    var acts = el("div", "tb-acts");
    acts.setAttribute("role", "menu");
    var item = function (act, text, ico) {
      var b = el("button", null, text);
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.setAttribute("data-act", act);
      b.setAttribute("data-id", id);
      b.appendChild(icon(ico));
      acts.appendChild(b);
    };
    item("reply", "Reply", "reply");
    if (canEdit(m)) item("edit", "Edit", "pencil");
    if (m.authorParty !== "system" && typeof m.body === "string" && m.body !== "") item("copy", "Copy", "copy");
    if (m.authorParty === S.seat) acts.appendChild(el("p", "tb-foot", "Messages can't be unsent. They are the record of this hire. You can edit one for 15 minutes."));
    add(menu, row, acts);
    menu.style.cssText = "left:0;top:0;right:0;bottom:0;pointer-events:none;";
    overlayRoot().appendChild(menu);
    row.style.cssText = "position:fixed;pointer-events:auto;left:0;top:0";
    acts.style.cssText = "position:fixed;pointer-events:auto;left:0;top:0";
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var mw = row.offsetWidth, mh = row.offsetHeight, aw = acts.offsetWidth, ah = acts.offsetHeight;
    var left = Math.max(4, Math.min(mine ? r.right - mw : r.left, vw - mw - 4));
    var aleft = Math.max(4, Math.min(mine ? r.right - aw : r.left, vw - aw - 4));
    var rowTop = r.top - mh - 10;
    var actTop = r.bottom + 10;
    if (actTop + ah > vh - 8) actTop = Math.max(8, rowTop - ah - 8);
    if (rowTop < 8) rowTop = Math.min(r.bottom + 10, vh - mh - 8);
    row.style.left = left + "px"; row.style.top = rowTop + "px";
    acts.style.left = aleft + "px"; acts.style.top = actTop + "px";
    var first = menu.querySelector('[aria-pressed="true"]') || menu.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }

  function sheet(title, content, cls) {
    closeOverlays();
    lastFocus = document.activeElement;
    scrim();
    var sh = el("div", "sheet open " + (cls || ""));
    sh.setAttribute("role", "dialog");
    sh.setAttribute("aria-modal", "true");
    sh.setAttribute("aria-label", title);
    var grab = el("div", "grab");
    grab.setAttribute("aria-hidden", "true");
    var head = el("div", "sh-head");
    var x = button("x", "Close");
    x.setAttribute("data-act", "close");
    x.appendChild(icon("x"));
    add(head, el("h2", null, title), x);
    add(sh, grab, head, content);
    overlayRoot().appendChild(sh);
    var f = sh.querySelector(".search, .x");
    if (f) f.focus({ preventScroll: true });
    return sh;
  }

  var EMOJI = [
    ["Often used", [["\uD83D\uDC4D", "thumbs up yes"], ["\u2764\uFE0F", "heart love"], ["\uD83E\uDD1D", "handshake deal"], ["\uD83D\uDE4F", "thanks please"], ["\uD83C\uDF89", "party celebrate"], ["\u2705", "check done"], ["\uD83D\uDC40", "eyes look"], ["\uD83D\uDE80", "rocket ship"]]],
    ["Faces", [["\uD83D\uDE00", "grin smile"], ["\uD83D\uDE04", "happy smile"], ["\uD83D\uDE0A", "blush smile"], ["\uD83D\uDE42", "slight smile"], ["\uD83D\uDE09", "wink"], ["\uD83D\uDE0D", "love eyes"], ["\uD83E\uDD14", "thinking"], ["\uD83D\uDE2C", "grimace"], ["\uD83D\uDE05", "sweat smile"], ["\uD83D\uDE2E", "surprised"], ["\uD83D\uDE33", "flushed"], ["\uD83D\uDE22", "sad cry"], ["\uD83D\uDE24", "frustrated"], ["\uD83E\uDD73", "party face"], ["\uD83D\uDE34", "sleep tired"], ["\uD83E\uDEE1", "salute"]]],
    ["Hands", [["\uD83D\uDC4F", "clap"], ["\uD83D\uDE4C", "raised hands hooray"], ["\uD83D\uDC4B", "wave hello"], ["\u270C\uFE0F", "peace victory"], ["\uD83E\uDD1E", "fingers crossed luck"], ["\uD83D\uDC4C", "ok"], ["\uD83D\uDCAA", "strong muscle"], ["\u261D\uFE0F", "point up one"]]],
    ["Objects", [["\uD83D\uDCA1", "idea bulb"], ["\uD83D\uDD25", "fire"], ["\u23F0", "alarm clock time"], ["\uD83D\uDCC5", "calendar date"], ["\uD83D\uDCCE", "paperclip attach"], ["\uD83D\uDD12", "lock"], ["\uD83D\uDEE0\uFE0F", "tools fix"], ["\u2615", "coffee"], ["\uD83C\uDF19", "moon night"], ["\uD83D\uDCC8", "chart up"], ["\uD83D\uDCBE", "save disk"], ["\uD83E\uDDEA", "test tube"]]]
  ];
  var PICTO = null;
  try { PICTO = new RegExp("\\p{Extended_Pictographic}", "u"); } catch (e) { PICTO = null; }
  function emojiSheet(forId) {
    var content = document.createDocumentFragment();
    var lab = el("label", "sr", "Search emoji");
    lab.setAttribute("for", "emq");
    var q = el("input", "search");
    q.id = "emq";
    q.type = "search";
    q.placeholder = "Search emoji";
    q.autocomplete = "off";
    add(content, lab, q);
    var typed = el("div", "emoji-grid emoji-typed");
    typed.hidden = true;
    content.appendChild(typed);
    EMOJI.forEach(function (g) {
      var sub = el("div", "sub", g[0]);
      var grid = el("div", "emoji-grid");
      g[1].forEach(function (pair) {
        var b = button(null, pair[1].split(" ")[0], pair[0]);
        b.setAttribute("data-tap", pair[0]);
        b.setAttribute("data-name", pair[1]);
        grid.appendChild(b);
      });
      var group = el("div", "emoji-group");
      add(group, sub, grid);
      content.appendChild(group);
    });
    var none = el("p", "none", "No emoji match that. You can type one in the search box.");
    none.hidden = true;
    content.appendChild(none);
    content.appendChild(el("p", "sh-note", "On a phone you can also use your keyboard's own emoji."));
    var sh = sheet(forId ? "React with any emoji" : "Insert an emoji", content, "emoji");
    sh.setAttribute("data-for", forId || "");
  }
  function filterEmoji(input) {
    var sh = input.closest(".sheet");
    var q = input.value.trim().toLowerCase();
    var any = false;
    Array.prototype.forEach.call(sh.querySelectorAll(".emoji-group"), function (g) {
      var shown = 0;
      Array.prototype.forEach.call(g.querySelectorAll("[data-name]"), function (b) {
        var hit = q === "" || b.getAttribute("data-name").indexOf(q) !== -1 || b.getAttribute("data-tap") === input.value.trim();
        b.hidden = !hit;
        if (hit) shown += 1;
      });
      g.hidden = shown === 0;
      if (shown) any = true;
    });
    var typed = sh.querySelector(".emoji-typed");
    typed.textContent = "";
    var raw = input.value.trim();
    var own = raw !== "" && PICTO && PICTO.test(raw) && Array.from(raw).length <= 4;
    if (own) {
      var b = button(null, raw, raw);
      b.setAttribute("data-tap", raw);
      typed.appendChild(b);
    }
    typed.hidden = !own;
    sh.querySelector(".none").hidden = any || own;
  }
  function whoSheet(id) {
    var m = S.byId[id];
    if (!m) return;
    var r = m.reactions || {};
    var list = el("ul", "who-list");
    var other = S.seat === "buyer" ? "agent" : "buyer";
    [other, S.seat].forEach(function (party) {
      if (!r[party]) return;
      var mine = party === S.seat;
      var li = el("li");
      var av = el("span", "av");
      add(li, el("span", "e", r[party]), av, el("span", "nm", mine ? "You" : otherLabel(S.row)));
      if (mine && S.writable) {
        var rm = el("button", "btn", "Remove");
        rm.type = "button";
        rm.setAttribute("data-act", "unreact");
        rm.setAttribute("data-id", id);
        li.appendChild(rm);
      }
      list.appendChild(li);
      if (!mine) mountAv(av, S.row.counterpartDid, null, 28);
    });
    var content = document.createDocumentFragment();
    content.appendChild(list);
    var on = m.authorParty === "system" ? "the quote" : "\u201c" + firstLine(preview(m), 120) + "\u201d";
    content.appendChild(el("p", "sh-note", "On " + on));
    sheet("Reactions", content, "who");
  }
  function historySheet(id) {
    var m = S.byId[id];
    if (!m || !m.editHistory || !m.editHistory.length) return;
    var side = m.authorParty === S.seat ? "me" : "them";
    var ol = el("ol", "history");
    var entry = function (label, when, text) {
      var li = el("li");
      var h = el("div", "h-when");
      add(h, el("b", null, label), " " + dayName(when) + " " + clock(when));
      var run = el("div", "run " + side);
      run.appendChild(el("div", "bubble", text));
      add(li, h, run);
      ol.appendChild(li);
    };
    entry("Now, edited", ms(m.editedAt), m.body);
    var h = m.editHistory.slice().reverse();
    h.forEach(function (e, i) {
      entry(i === h.length - 1 ? "First sent" : "Edited", ms(e.editedAt), e.body);
    });
    var content = document.createDocumentFragment();
    content.appendChild(ol);
    content.appendChild(el("p", "history-note", "Both of you can see every version. Messages can't be unsent, because this conversation is the record of the hire."));
    sheet("Edit history", content, "hist");
  }
  function attachMenu(btn) {
    closeOverlays();
    lastFocus = btn;
    btn.setAttribute("aria-expanded", "true");
    scrim();
    var r = btn.getBoundingClientRect();
    var mn = el("div", "attachmenu");
    mn.setAttribute("role", "menu");
    var opt = function (act, ico, title, note) {
      var b = el("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.setAttribute("data-act", act);
      add(b, icon(ico), add(el("span"), title, el("small", null, note)));
      mn.appendChild(b);
    };
    opt("pick-image", "image", "Photo or image", "JPG, PNG, WebP or HEIC, up to 10 MB");
    opt("pick-pdf", "file", "PDF", "Up to 10 MB");
    mn.appendChild(add(el("p", "am-foot"), icon("link", "lk"), "Anything else, paste a link."));
    overlayRoot().appendChild(mn);
    var mr = mn.getBoundingClientRect();
    mn.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mr.width - 8)) + "px";
    mn.style.top = Math.max(8, r.top - mr.height - 8) + "px";
    var first = mn.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }
  function viewer(aid) {
    var f = S.files[aid];
    if (!f) return;
    var m = S.byId[f.messageId];
    closeOverlays();
    lastFocus = document.activeElement;
    var v = el("div", "viewer");
    v.setAttribute("role", "dialog");
    v.setAttribute("aria-modal", "true");
    v.setAttribute("aria-label", f.originalFilename);
    var bar = el("div", "vw-bar");
    var from = m ? (m.authorParty === S.seat ? "From you" : "From " + authorShort(m)) : "";
    var when = m ? dayName(ms(m.createdAt)) + " " + clock(ms(m.createdAt)) : "";
    var t = add(el("div", "t"), f.originalFilename, el("small", null, [from, when, bytes(f.sizeBytes)].filter(Boolean).join(", ")));
    var dl = button(null, "Download " + f.originalFilename);
    dl.setAttribute("data-dl", aid);
    dl.appendChild(icon("download"));
    var x = button(null, "Close");
    x.setAttribute("data-act", "close");
    x.appendChild(icon("x"));
    add(bar, t, dl, x);
    var box = el("div", "vw-img");
    var img = el("img");
    img.alt = f.originalFilename;
    if (S.thumbs[aid]) img.src = S.thumbs[aid];
    box.appendChild(img);
    add(v, bar, box);
    overlayRoot().appendChild(v);
    x.focus({ preventScroll: true });
    if (typeof URL.createObjectURL === "function") {
      blob(jobPath() + "/attachments/" + enc(aid)).then(function (b) {
        if (!b || !document.contains(img)) return;
        S.viewerUrl = URL.createObjectURL(b);
        img.src = S.viewerUrl;
      });
    }
  }

  /* ------------------------------------------------------------ wiring */
  var pressTimer = null;
  function wire() {
    document.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("button, a, [data-scrim]") : null;
      if (!t) return;
      if (t.hasAttribute("data-scrim")) { closeOverlays(); return; }
      if (t.tagName === "A") {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button && e.button !== 0)) return;
        if (t.hasAttribute("data-job")) { e.preventDefault(); go("/messages?job=" + enc(t.getAttribute("data-job"))); return; }
        if (t.hasAttribute("data-list")) { e.preventDefault(); go("/messages"); return; }
        return;
      }
      if (t.disabled) return;
      if (t.hasAttribute("data-menu")) { openMenu(t.getAttribute("data-menu")); return; }
      if (t.hasAttribute("data-tap")) {
        var holder = t.closest(".tbmenu, .sheet");
        var id = holder && holder.getAttribute("data-for");
        var e2 = t.getAttribute("data-tap");
        if (id) {
          setReaction(id, myReaction(id) === e2 ? null : e2);
          closeOverlays();
        } else if (holder && holder.classList.contains("emoji")) {
          closeOverlays();
          insertEmoji(e2);
        }
        return;
      }
      if (t.hasAttribute("data-who")) { whoSheet(t.getAttribute("data-who")); return; }
      if (t.hasAttribute("data-hist")) { historySheet(t.getAttribute("data-hist")); return; }
      if (t.hasAttribute("data-view")) { viewer(t.getAttribute("data-view")); return; }
      if (t.hasAttribute("data-dl")) { download(t.getAttribute("data-dl")); return; }
      if (t.hasAttribute("data-cancel")) {
        var up = S.uploads.filter(function (u) { return u.id === t.getAttribute("data-cancel"); })[0];
        if (up) dropUpload(up);
        return;
      }
      if (t.hasAttribute("data-jump")) {
        var src = document.getElementById("msg-" + t.getAttribute("data-jump"));
        if (src) {
          scrollInto(src);
          src.classList.remove("flash");
          void src.offsetWidth;
          src.classList.add("flash");
          var b = src.querySelector("[data-msg]");
          if (b) b.focus({ preventScroll: true });
        }
        return;
      }
      switch (t.getAttribute("data-act")) {
        case "close": closeOverlays(); break;
        case "emoji": var menu = document.querySelector(".tbmenu"); emojiSheet(menu ? menu.getAttribute("data-for") : ""); break;
        case "emoji-compose": emojiSheet(""); break;
        case "reply": closeOverlays(); startReply(t.getAttribute("data-id")); break;
        case "edit": closeOverlays(); startEdit(t.getAttribute("data-id")); break;
        case "copy":
          var cm = S.byId[t.getAttribute("data-id")];
          if (cm && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cm.body).catch(function () {});
          closeOverlays();
          break;
        case "unreact": setReaction(t.getAttribute("data-id"), null); closeOverlays(); break;
        case "cancel-reply": cancelBar(); focusComposer(); break;
        case "dismiss": setBar(null); break;
        case "attach": attachMenu(t); break;
        case "pick-image": closeOverlays(); if ($("pick-image")) $("pick-image").click(); break;
        case "pick-pdf": closeOverlays(); if ($("pick-pdf")) $("pick-pdf").click(); break;
        default: break;
      }
    });

    /* long press on touch, right click and double click with a mouse */
    document.addEventListener("contextmenu", function (e) {
      var b = e.target.closest ? e.target.closest("[data-msg]") : null;
      if (!b || !S.writable || e.target.closest("a, button.quote")) return;
      e.preventDefault();
      openMenu(b.getAttribute("data-msg"));
    });
    document.addEventListener("dblclick", function (e) {
      var b = e.target.closest ? e.target.closest("[data-msg]") : null;
      if (!b || !S.writable || e.target.closest("a, button")) return;
      openMenu(b.getAttribute("data-msg"));
    });
    document.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch") return;
      var b = e.target.closest ? e.target.closest("[data-msg]") : null;
      if (!b || !S.writable) return;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () { openMenu(b.getAttribute("data-msg")); }, 450);
    });
    ["pointerup", "pointercancel", "pointermove"].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        if (ev !== "pointermove" || Math.abs(e.movementY || 0) > 4) clearTimeout(pressTimer);
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (layer && layer.firstChild) { closeOverlays(); return; }
        if (S.replyTo || S.editing) { cancelBar(); return; }
        return;
      }
      var b = e.target.closest ? e.target.closest("[data-msg]") : null;
      if (b && e.target === b && (e.key === "Enter" || e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
        e.preventDefault();
        openMenu(b.getAttribute("data-msg"));
        return;
      }
      if (e.target.id === "cmp" && e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse()) {
        e.preventDefault();
        send();
      }
    });
    document.addEventListener("input", function (e) {
      if (e.target.id === "cmp") { autosize(e.target); saveDraft(); typing(); return; }
      if (e.target.id === "emq") filterEmoji(e.target);
    });
    document.addEventListener("submit", function (e) {
      if (e.target.id === "composer") { e.preventDefault(); send(); }
    });
    document.addEventListener("change", function (e) {
      if (e.target.id !== "pick-image" && e.target.id !== "pick-pdf") return;
      var file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) pickFile(file);
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && S.jobId) {
        markRead();
        if (S.live && S.live.mode === "poll") refresh(S.gen);
      }
    });
    window.addEventListener("popstate", function () { if (S.me) route(); });
    window.addEventListener("resize", layout);
    window.addEventListener("pagehide", function () { stopLive(); });
  }
  function insertEmoji(e) {
    var ta = $("cmp");
    if (!ta) return;
    var at = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
    var end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : at;
    ta.value = ta.value.slice(0, at) + e + ta.value.slice(end);
    autosize(ta);
    saveDraft();
    ta.focus();
    try { ta.setSelectionRange(at + e.length, at + e.length); } catch (x) { /* not focusable */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
