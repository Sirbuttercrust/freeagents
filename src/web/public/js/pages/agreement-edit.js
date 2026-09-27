/* The owner's editing controls on /agreement (FIX-B40): the draft
   composer, and the one-field editor a row opens to change a line, the
   price or the delivery window. Builders only. Every request goes through
   the send callback agreement.js passes in, so this file never talks to
   the server and never decides what a send carries.

   Every builder resolves a send the same way: the callback returns a
   promise of null on success (agreement.js has already re-rendered the
   page from the response) or of the sentence to show on refusal. A refusal
   leaves every field as typed, so a failed send changes nothing on the
   page but the sentence.

   EVERYTHING THROUGH textContent (api.js rule 3). */
(function () {
  "use strict";

  var PRICE_HINT = "Enter the price in dollars, like 400 or 400.50.";
  var DAYS_HINT = "Enter the window in whole days, like 5.";

  function node(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  }

  function button(className, label, onClick) {
    var b = node("button", className, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function icon(name) {
    var ico = node("span", "ico");
    ico.setAttribute("data-ico", name);
    return ico;
  }

  function padNum(n) { return n < 10 ? "0" + n : String(n); }

  /* Dollars as a person types them ("400", "$1,200.5") into the API's
     two-place string ("400.00"), or null for anything else. The route
     refuses any other shape with a sentence about decimal strings, so the
     page refuses first, in words the owner can act on. */
  function toPriceUsd(raw) {
    var s = String(raw).trim().replace(/^\$/, "").replace(/,/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var parts = s.split(".");
    var whole = parts[0].replace(/^0+(?=\d)/, "");
    var cents = parts.length > 1 ? (parts[1] + "0").slice(0, 2) : "00";
    if (whole === "0" && cents === "00") return null;
    return whole + "." + cents;
  }

  function toDays(raw) {
    var s = String(raw).trim();
    if (!/^\d+$/.test(s)) return null;
    var n = parseInt(s, 10);
    return n > 0 ? n : null;
  }

  /* One field, Save and Cancel. opts: label (the field's accessible name),
     value, inputMode, parse(raw) -> { value } or { error }, send(value) ->
     promise of null or a sentence, onCancel(). */
  function fieldEditor(opts) {
    var box = node("div", "line-edit");
    var input = node("input", "input");
    input.value = opts.value;
    input.setAttribute("aria-label", opts.label);
    input.setAttribute("spellcheck", "false");
    if (opts.inputMode) input.setAttribute("inputmode", opts.inputMode);
    var error = node("p", "edit-error");
    error.hidden = true;
    var save = button("btn btn-sm", "Save", function () {
      var parsed = opts.parse(input.value);
      if (parsed.error) { showError(parsed.error); return; }
      error.hidden = true;
      save.disabled = true;
      opts.send(parsed.value).then(function (refusal) {
        save.disabled = false;
        if (refusal) showError(refusal);
      });
    });
    var cancel = button("btn btn-sm", "Cancel", function () { opts.onCancel(); });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); save.click(); }
      if (ev.key === "Escape") { ev.preventDefault(); cancel.click(); }
    });
    function showError(text) { error.textContent = text; error.hidden = false; }
    var actions = node("div", "row edit-actions");
    actions.appendChild(save);
    actions.appendChild(cancel);
    box.appendChild(input);
    box.appendChild(actions);
    box.appendChild(error);
    box.focusField = function () { input.focus(); };
    return box;
  }

  function lineEditor(label, text, send, onCancel) {
    return fieldEditor({
      label: label,
      value: text,
      parse: function (raw) {
        var t = raw.trim();
        return t === "" ? { error: "Write the line before saving it." } : { value: t };
      },
      send: send,
      onCancel: onCancel,
    });
  }

  function priceEditor(priceUsd, send, onCancel) {
    return fieldEditor({
      label: "Price in dollars",
      value: priceUsd,
      inputMode: "decimal",
      parse: function (raw) { var v = toPriceUsd(raw); return v === null ? { error: PRICE_HINT } : { value: v }; },
      send: send,
      onCancel: onCancel,
    });
  }

  function daysEditor(days, send, onCancel) {
    return fieldEditor({
      label: "Days to deliver",
      value: String(days),
      inputMode: "numeric",
      parse: function (raw) { var v = toDays(raw); return v === null ? { error: DAYS_HINT } : { value: v }; },
      send: send,
      onCancel: onCancel,
    });
  }

  /* The draft composer: the quote before its first send. Lines can be
     added, changed and removed here and only here: once a quote is sent,
     a line can be changed but not removed (a send that omits a line drops
     it at once, while every other line keeps its signatures, so a removal
     could lock an agreement on a set the buyer never saw whole).

     opts: saved ({ lines, price, days } or null), onChange(state) on every
     edit, add and removal (agreement.js keeps it in sessionStorage per
     job), send({ lines, priceUsd, deliveryWindowDays }) -> promise of null
     or a sentence. A saved draft is read back only as far as it holds
     strings, and the composer always shows at least one line, so the last
     line has no remove control. */
  function composer(opts) {
    var saved = opts.saved || {};
    var lines = (Array.isArray(saved.lines) ? saved.lines : []).filter(function (t) { return typeof t === "string"; });
    if (lines.length === 0) lines = [""];
    var box = node("div", "composer pane pane-pad");
    var list = node("ol", "compose-lines");
    var add = button("btn btn-sm", "Add a line", function () {
      lines.push("");
      drawLines();
      changed();
      var inputs = list.querySelectorAll("input");
      if (inputs.length > 0) inputs[inputs.length - 1].focus();
    });
    add.id = "compose-add";

    var terms = node("div", "compose-terms");
    var price = termField("compose-price", "Price in dollars", typeof saved.price === "string" ? saved.price : "", "decimal");
    var days = termField("compose-days", "Days to deliver", typeof saved.days === "string" ? saved.days : "", "numeric");
    terms.appendChild(price.wrap);
    terms.appendChild(days.wrap);

    var error = node("p", "edit-error");
    error.id = "compose-error";
    error.hidden = true;
    var send = button("btn", "Send the quote", function () {
      var written = lines.map(function (t) { return t.trim(); }).filter(function (t) { return t !== ""; });
      if (written.length === 0) { showError("Write at least one line."); return; }
      var priceUsd = toPriceUsd(price.input.value);
      if (priceUsd === null) { showError(PRICE_HINT); return; }
      var windowDays = toDays(days.input.value);
      if (windowDays === null) { showError(DAYS_HINT); return; }
      error.hidden = true;
      send.disabled = true;
      opts.send({ lines: written, priceUsd: priceUsd, deliveryWindowDays: windowDays }).then(function (refusal) {
        send.disabled = false;
        if (refusal) showError(refusal);
      });
    });
    send.id = "compose-send";

    function showError(text) { error.textContent = text; error.hidden = false; }

    function termField(id, label, value, mode) {
      var wrap = node("div", "field");
      var lab = node("label", "", label);
      lab.setAttribute("for", id);
      var input = node("input", "input");
      input.id = id;
      input.value = value;
      input.setAttribute("inputmode", mode);
      input.addEventListener("input", changed);
      wrap.appendChild(lab);
      wrap.appendChild(input);
      return { wrap: wrap, input: input };
    }

    function changed() {
      opts.onChange({ lines: lines.slice(), price: price.input.value, days: days.input.value });
    }

    function drawLines() {
      list.textContent = "";
      lines.forEach(function (text, i) {
        var li = node("li", "compose-line");
        li.appendChild(node("span", "num", padNum(i + 1)));
        var input = node("input", "input");
        input.value = text;
        input.setAttribute("aria-label", "Line " + padNum(i + 1));
        input.setAttribute("spellcheck", "false");
        input.addEventListener("input", function () { lines[i] = input.value; changed(); });
        li.appendChild(input);
        if (lines.length > 1) li.appendChild(removeControl(i));
        list.appendChild(li);
      });
      if (window.FAIcon) window.FAIcon.paint(list);
    }

    function removeControl(i) {
      var rm = button("compose-rm", "", function () {
        lines.splice(i, 1);
        drawLines();
        changed();
      });
      rm.setAttribute("aria-label", "Remove line " + padNum(i + 1));
      rm.setAttribute("title", "Remove line " + padNum(i + 1));
      rm.appendChild(icon("trash"));
      return rm;
    }

    drawLines();
    box.appendChild(list);
    box.appendChild(add);
    box.appendChild(terms);
    var actions = node("div", "row");
    actions.appendChild(send);
    box.appendChild(actions);
    box.appendChild(error);
    return box;
  }

  window.FAAgreementEdit = {
    composer: composer,
    lineEditor: lineEditor,
    priceEditor: priceEditor,
    daysEditor: daysEditor,
  };
})();
