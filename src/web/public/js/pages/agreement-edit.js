/* The owner's editing controls on /agreement (FIX-B40): the one-field
   editor a row opens to change a line, the price or the delivery window.
   Builders only. Every request goes through the send callback
   agreement.js passes in, so this file never talks to the server and
   never decides what a send carries.

   Every builder resolves a send the same way: the callback returns a
   promise of null on success (agreement.js has already re-rendered the
   page from the response) or of the sentence to show on refusal. A refusal
   leaves the field as typed, so a failed send changes nothing on the page
   but the sentence.

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

  window.FAAgreementEdit = {
    lineEditor: lineEditor,
    priceEditor: priceEditor,
    daysEditor: daysEditor,
  };
})();
