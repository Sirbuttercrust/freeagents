// The avatar-mount instrument for tests/web/wireframe-conformance.test.ts.
//
// Its own file rather than an addition to wireframe-conformance-clean.ts,
// because it imports jsdom and typescript at module scope. clean.ts is
// imported by wireframe-conformance-middot.test.ts and
// wireframe-conformance-div-h.test.ts, neither of which needs a parser, and
// a cold `require` of the two costs 105ms and 60ms on this machine.
//
// WHY A PARSER AND NOT A REGEX
//
// The conformance gate's avatar check used to be
// `/data-avatar/.test(built) || /data-avatar/.test(script)` over raw file
// text, and its own sentence says an avatar "is a data-avatar element". A
// string in a file is not an element, and the gap between those two is not
// theoretical. Three separate ways the raw form passed with no mount behind
// it, all measured on this tree at e9dc408:
//
//  1. COMMENT PROSE. A page or script comment that names the attribute
//     satisfies the regex. Measured on task/w-operatorjob-polished at
//     4dd9c4b: deleting renderWho's real setAttribute call and leaving the
//     comments untouched kept the conformance file green, so the page could
//     have shipped with no mount at all (card t_cf2d9eab).
//  2. CSS COMMENTS, which an HTML-comment strip does not reach. On
//     dashboard.html and pullrequest.html the surviving occurrences sit in
//     block comments inside <style>, so the narrow repair of stripping
//     `<!-- -->` first leaves both pages passing on prose.
//  3. A SUBSTRING OF A DIFFERENT ATTRIBUTE. agent.html and operator.html
//     carry `<span class="pav" id="avatar" data-avatar-size="96">` with no
//     mount attribute at all, and `/data-avatar/` matches inside
//     `data-avatar-size`. Both pages are honest (their real mount is in
//     their script), but the HTML half of the gate was passing for a reason
//     unrelated to any avatar.
//
// A DOM query answers the question the sentence asks, and is immune to all
// three by construction rather than by filtering: comments, <style> text,
// <script> text and text content are not elements, and an attribute
// selector does not match a prefix of a longer attribute name.
//
// Rerun the evidence for any of the three with the census in this card's
// workspace, or directly:
//
//   node -e 'const {JSDOM}=require("jsdom");const f=require("fs");
//     for (const p of ["agent","operator","dashboard","pullrequest"])
//       console.log(p,
//         (f.readFileSync(`src/web/pages/${p}.html`,"utf8").match(/data-avatar/g)||[]).length,
//         new JSDOM(f.readFileSync(`src/web/pages/${p}.html`,"utf8"))
//           .window.document.querySelectorAll("[data-avatar]").length);'
//
// prints `agent 3 0`, `operator 3 0`, `dashboard 2 0`, `pullrequest 3 0`.
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Elements carrying the mount attribute, in a parsed document.
//
// <template> content is deliberately NOT counted. jsdom keeps it in a
// separate DocumentFragment, so document.querySelectorAll never reaches it,
// and that is the behaviour this gate wants: markup inside a template that
// nothing clones is the conformance-satisfied-by-dead-markup defect this
// suite already found and fixed once (Proof round 2 D1, the removed
// tmpl-verify-prior in agent.html, still described in ALLOWED_ABSENT's
// "gist proof" entry). A page that builds rows at runtime satisfies this
// gate through its script instead, which is the honest route.
//
// No page or wireframe in this tree currently puts the attribute inside a
// template, so this choice changes no verdict today:
//   awk '/<template/{t=1} /<\/template>/{t=0} t&&/data-avatar/{print FILENAME":"FNR}' \
//     spec/wireframe/*.html src/web/pages/*.html
// returns nothing. Pinned against a fixture by
// tests/web/wireframe-conformance-avatar-mount.test.ts.
export function avatarMounts(htmlText: string): number {
  return new JSDOM(htmlText).window.document.querySelectorAll('[data-avatar]').length;
}

// Mount expressions in a browser script.
//
// Comments are not AST nodes, so the prose hazard above is absent here by
// construction rather than stripped. Three shapes count as a mount, which
// is every shape this tree uses or plausibly would:
//
//   el.setAttribute("data-avatar", did)   the shape every mounting page
//                                         script in this tree uses today:
//                                         grep -l 'setAttribute("data-avatar"' \
//                                           src/web/public/js/pages/*.js
//   el.dataset.avatar = did               the same write through the
//                                         dataset API
//   '<span data-avatar="' + did + '">'    a script that injects its rows as
//                                         markup rather than building nodes
//
// Reading the attribute (getAttribute) and sweeping for it
// (querySelectorAll("[data-avatar]"), which is what polish.js:472 does to
// every host it finds) are deliberately NOT mounts: they consume a mount
// somebody else made. A page whose script only swept would draw no avatar,
// and the raw-text form counted both.
export function scriptAvatarMounts(source: string): number {
  const diagnostics =
    ts.transpileModule(source, {
      compilerOptions: { allowJs: true, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    }).diagnostics ?? [];
  if (diagnostics.length > 0) {
    // A script that does not parse must not read as "mounts nothing", which
    // is a silent pass whenever the wireframe draws no avatar and a silent,
    // correct-looking red when it does. All 32 shipped browser scripts parse
    // clean at e9dc408, so this throw is unreachable on a healthy tree.
    throw new Error(
      `script does not parse, so its mounts cannot be counted: ${ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText, ' ')}`,
    );
  }

  const sourceFile = ts.createSourceFile('page.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let mounts = 0;

  const namesTheAttribute = (node: ts.Node): boolean =>
    (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'data-avatar';

  // A string the script injects as markup: the attribute followed by its
  // `=`, which a mention in a message or an error string does not carry.
  const injectsMountMarkup = (node: ts.Node): boolean => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text.includes('data-avatar=');
    }
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].some((t) => t.includes('data-avatar='));
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    const isSetAttribute =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setAttribute' &&
      node.arguments.length > 0 &&
      node.arguments[0] !== undefined &&
      namesTheAttribute(node.arguments[0]);

    const isDatasetWrite =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'avatar' &&
      ts.isPropertyAccessExpression(node.left.expression) &&
      node.left.expression.name.text === 'dataset';

    if (isSetAttribute || isDatasetWrite || injectsMountMarkup(node)) mounts += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mounts;
}
