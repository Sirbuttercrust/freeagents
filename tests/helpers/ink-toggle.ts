// The toggle the three diagram contrast walks use to take a bare photograph.
//
// INKLESS_ON hides every glyph, INKLESS_OFF puts them back.
export const INKLESS_ON = `(function () { var s = document.createElement('style'); s.id = 'dg-inkless';
  s.textContent = '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';
  document.head.appendChild(s); return true; })()`;
export const INKLESS_OFF = `(function () { var s = document.getElementById('dg-inkless'); if (s) s.remove(); return true; })()`;
