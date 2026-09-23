// A guard for the avatar-mount instrument (t_cf2d9eab).
//
// The conformance gate's "carries the avatars its wireframe draws" check
// used to decide whether a page mounts an avatar with /data-avatar/ over
// RAW file text, and raw text includes prose. Measured on
// task/w-operatorjob-polished at 4dd9c4b: deleting renderWho's real
// setAttribute call and leaving the page's comments (which named the
// attribute three times, correctly explaining why it is not in the markup)
// untouched kept the whole conformance file green. The page could have
// shipped with no mount and the gate would not have noticed.
//
// The per-page fix on that branch was to take the token out of the prose,
// which repairs one page and leaves the gate wrong for the next page whose
// comments mention the attribute. This file is the gate's own fix: it pins
// the properties directly against fixtures, so they hold whatever the tree
// happens to contain. The same reason wireframe-conformance-middot.test.ts
// pins clean() and wireframe-conformance-div-h.test.ts pins headings().
import { describe, expect, it } from 'vitest';

import { avatarMounts, scriptAvatarMounts } from '../helpers/wireframe-conformance-avatar.js';

describe('avatarMounts(): the HTML side counts elements, not strings', () => {
  it('counts a real mount', () => {
    expect(avatarMounts('<span class="av" data-avatar="did:abt:x"></span>')).toBe(1);
  });

  it('counts each mount on a page with several', () => {
    expect(
      avatarMounts('<span data-avatar="did:abt:x"></span><div><span data-avatar="did:abt:y"></span></div>'),
    ).toBe(2);
  });

  // Defect 1, the one this card was filed for.
  it('does not count the attribute named in an HTML comment', () => {
    expect(avatarMounts('<!-- deposit.js sets data-avatar once the DID is known -->')).toBe(0);
  });

  // Defect 2. A <!-- --> strip, the narrow fix, does not reach inside
  // <style>, and two pages in this tree (dashboard, pullrequest) hold their
  // surviving occurrences exactly there.
  it('does not count the attribute named in a CSS comment inside <style>', () => {
    expect(avatarMounts('<style>/* there is no data-avatar attribute on this row */</style>')).toBe(0);
  });

  it('does not count the attribute named in a script string', () => {
    expect(avatarMounts('<script>var s = \'<span data-avatar="x">\';</script>')).toBe(0);
  });

  it('does not count the attribute named in visible text', () => {
    expect(avatarMounts('<p>this page sets data-avatar at render time</p>')).toBe(0);
  });

  // Defect 3. /data-avatar/ is a substring test, so it matches inside
  // data-avatar-size. agent.html and operator.html each ship a mount HOST
  // carrying only the size attribute (the mount itself is set by their
  // scripts), so the HTML half of the raw gate was passing on those two
  // pages for a reason that has nothing to do with an avatar.
  it('does not count a size attribute with no mount attribute', () => {
    expect(avatarMounts('<span class="pav" id="avatar" data-avatar-size="96" data-pending></span>')).toBe(0);
  });

  it('counts a host that carries both the mount and the size', () => {
    expect(avatarMounts('<span data-avatar="did:abt:x" data-avatar-size="96"></span>')).toBe(1);
  });

  // Dead markup is not a mount: <template> content is inert until something
  // clones it, which is the conformance-satisfied-by-dead-markup defect this
  // suite already found and fixed once (Proof round 2 D1, the removed
  // tmpl-verify-prior in agent.html). No page or wireframe in this tree puts
  // the attribute inside a template today, so this pins the rule rather than
  // changing a verdict.
  it('does not count a mount inside a <template> that nothing clones', () => {
    expect(avatarMounts('<template><span data-avatar="did:abt:x"></span></template>')).toBe(0);
  });

  it('counts a real mount on a page that also names the attribute in prose', () => {
    expect(
      avatarMounts('<!-- the mount below is set from the DID -->\n<span data-avatar="did:abt:x"></span>'),
    ).toBe(1);
  });
});

describe('scriptAvatarMounts(): the script side counts mount expressions', () => {
  it('counts the setAttribute shape every mounting page script uses', () => {
    expect(scriptAvatarMounts('host.setAttribute("data-avatar", did);')).toBe(1);
  });

  it('counts it however the attribute name is quoted', () => {
    expect(scriptAvatarMounts("host.setAttribute('data-avatar', did);")).toBe(1);
    expect(scriptAvatarMounts('host.setAttribute(`data-avatar`, did);')).toBe(1);
  });

  it('counts the same write through the dataset API', () => {
    expect(scriptAvatarMounts('host.dataset.avatar = did;')).toBe(1);
  });

  it('counts a script that injects its rows as markup', () => {
    expect(scriptAvatarMounts('row.innerHTML = \'<span class="av" data-avatar="\' + did + \'"></span>\';')).toBe(1);
    expect(scriptAvatarMounts('row.innerHTML = `<span class="av" data-avatar="${did}"></span>`;')).toBe(1);
  });

  // AV2: the call every page now makes. bots.js sets the attribute.
  it('counts a FABots.mount call with a host and a DID, however FABots is reached', () => {
    expect(scriptAvatarMounts('window.FABots.mount(host, did, { size: 32 });')).toBe(1);
    expect(scriptAvatarMounts('FABots.mount(A.el("avatar"), agent.did);')).toBe(1);
  });

  it('does not count a FABots.mount that is not a call, or a call with no DID', () => {
    expect(scriptAvatarMounts('var m = window.FABots.mount;')).toBe(0);
    expect(scriptAvatarMounts('window.FABots.mount(host);')).toBe(0);
    expect(scriptAvatarMounts('// window.FABots.mount(host, did)\nvar x = 1;')).toBe(0);
    expect(scriptAvatarMounts('other.mount(host, did);')).toBe(0);
  });

  // The defect, on the script side. Comments are not AST nodes, so this is
  // structural rather than a filter that could miss a comment style.
  it('does not count the attribute named in a line comment', () => {
    expect(scriptAvatarMounts('// the data-avatar attribute is set once the DID is known\nvar x = 1;')).toBe(0);
  });

  it('does not count the attribute named in a block comment', () => {
    expect(scriptAvatarMounts('/* this row mounts no data-avatar at all */\nvar x = 1;')).toBe(0);
  });

  it('does not count the attribute named in a comment inside a function body', () => {
    expect(scriptAvatarMounts('function renderRow() {\n  // no data-avatar on this row\n  return 1;\n}')).toBe(0);
  });

  // Reading and sweeping consume a mount somebody else made. polish.js:472
  // sweeps every [data-avatar] host on the page; a page whose script only
  // swept would draw nothing, and the raw-text form counted both as mounts.
  it('does not count reading the attribute back off an element', () => {
    expect(scriptAvatarMounts('var did = el.getAttribute("data-avatar");')).toBe(0);
  });

  it('does not count sweeping the page for hosts somebody else mounted', () => {
    expect(scriptAvatarMounts('each($$("[data-avatar]"), function (el) { paint(el); });')).toBe(0);
  });

  it('does not count the attribute named in a message string', () => {
    expect(scriptAvatarMounts('throw new Error("call setAttribute(data-avatar, did) first");')).toBe(0);
  });

  it('counts a real mount in a script that also names the attribute in prose', () => {
    expect(scriptAvatarMounts('// the data-avatar attribute\nhost.setAttribute("data-avatar", did);')).toBe(1);
  });

  it('counts each mount in a script with more than one', () => {
    expect(
      scriptAvatarMounts('a.setAttribute("data-avatar", one);\nfunction f() { b.setAttribute("data-avatar", two); }'),
    ).toBe(2);
  });

  // A script that does not parse must not read as "mounts nothing": that is
  // a silent pass on every page whose wireframe draws no avatar, and a red
  // with a misleading message on every page whose wireframe does. All 32
  // shipped browser scripts parse clean, so this is unreachable on a healthy
  // tree and is here so a broken one says what is wrong.
  it('throws rather than reporting zero when the script does not parse', () => {
    expect(() => scriptAvatarMounts('host.setAttribute("data-avatar", did);\n/* unterminated')).toThrow(
      /does not parse/,
    );
  });

  it('reports zero for a script that genuinely mounts nothing', () => {
    expect(scriptAvatarMounts('function init() { return 1; }')).toBe(0);
  });
});
