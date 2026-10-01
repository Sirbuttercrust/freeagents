// The toggle the three diagram contrast walks use to take a bare photograph.
//
// Every arrived node on /how, /outcomes and /conduct eases its text colour
// (diagrams.css: transition: color var(--dur-2) ...), 220 ms. A toggle that
// only appends and removes a transparent-ink style starts that ease on every
// word in each direction: the bare photograph, taken 80 ms after the hide,
// can still carry ink, and the read that follows the restore, about 200 ms
// later, can land mid-fade on a busy machine and see words below alpha 0.05.
// The walk needs a bare photograph with no ink and a read after it that sees
// the painted colour, so both halves change the colour with no transition.
//
// INKLESS_ON hides every glyph and turns transitions off in the same style.
// INKLESS_OFF cannot just remove that style: the colour would change in the
// same task that the transitions come back, and the ease would start. So it
// first adds a holder style that turns transitions off, removes the hide
// style, reads every diagram element's computed colour while the holder is
// in (which makes the browser apply the new colour then, with no transition),
// and only then removes the holder.
export const INKLESS_ON = `(function () { var s = document.createElement('style'); s.id = 'dg-inkless';
  s.textContent = '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;transition:none!important}';
  document.head.appendChild(s); return true; })()`;
export const INKLESS_OFF = `(function () {
  var hold = document.createElement('style'); hold.id = 'dg-inkless-hold';
  hold.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(hold);
  var s = document.getElementById('dg-inkless'); if (s) s.remove();
  Array.prototype.forEach.call(document.querySelectorAll('[data-diagram], [data-diagram] *'), function (e) { getComputedStyle(e).color; });
  hold.remove(); return true; })()`;
