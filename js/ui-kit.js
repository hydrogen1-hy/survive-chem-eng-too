/* Small helpers shared by the calculus pages: building elements, number and tick formatting, typeset mathematics, the nested step list.
   Browser only. Everything that comes from the user or from a library goes in with textContent (or through KaTeX, which builds its own nodes). */
window.UIKit = (function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgEl(name, attrs, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmtNum(x) {
    if (typeof x !== 'number' || !isFinite(x)) return String(x);
    var a = Math.abs(x);
    if (a !== 0 && (a < 1e-5 || a >= 1e10)) return x.toExponential(8).replace(/\.?0+e/, 'e');
    return String(Number(x.toPrecision(12)));
  }
  var SUPS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  function supNum(n) { return String(n).split('').map(function (c) { return SUPS[+c]; }).join(''); }

  function niceStep(range, count) {
    var raw = range / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  function ticks(min, max, count) {
    var step = niceStep(max - min, count), out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
    return out;
  }
  function tickText(v) { return Math.abs(v) < 1e-12 ? '0' : fmtNum(v); }

  /* box(cls, title, text, items): a notice box with an optional bold title, a line of text and a bullet list */
  function box(cls, title, text, items) {
    var b = el('div', cls);
    if (title) b.appendChild(el('strong', null, title));
    if (text) b.appendChild(el('div', null, text));
    if (items && items.length) { var ul = el('ul'); items.forEach(function (t) { ul.appendChild(el('li', null, t)); }); b.appendChild(ul); }
    return b;
  }

  /* ── typeset mathematics ──
     The solvers print plain text such as x²/2 or "Let u = x² + 1". rich() cuts that text into words and formulas (Tex.segments)
     and lets KaTeX typeset the formulas; the words stay ordinary text so they wrap normally. Without KaTeX, or for anything
     it refuses, the plain text is shown, so nothing is ever lost. Every typeset formula remembers its plain text (data-plain),
     which is what is copied when the user selects and copies it. */
  function mathReady() { return typeof window.katex !== 'undefined' && typeof window.Tex !== 'undefined'; }
  function mathSpan(tex, plain, display) {
    var s = el('span', 'math');
    s.setAttribute('data-plain', plain);
    try { window.katex.render(display ? '\\displaystyle ' + tex : tex, s, { throwOnError: true, strict: 'ignore', output: 'htmlAndMathml' }); }
    catch (e) { return null; }
    return s;
  }
  function rich(parent, plain, display) {
    plain = String(plain);
    if (!mathReady()) { parent.appendChild(document.createTextNode(plain)); return parent; }
    var segs;
    try { segs = window.Tex.segments(plain); } catch (e) { parent.appendChild(document.createTextNode(plain)); return parent; }
    segs.forEach(function (g) {
      if (g.text !== undefined) { parent.appendChild(document.createTextNode(g.text)); return; }
      var m = mathSpan(g.tex, g.math, display);
      if (m) parent.classList.add('has-math');
      parent.appendChild(m || document.createTextNode(g.math));
    });
    return parent;
  }
  /* a line that is mostly a formula (equation lines, answers) is set in display style: full-size fractions and limits */
  function mathEl(tag, cls, plain) { return rich(el(tag, cls), plain, /(^|\s)(eq|big|int-line|result-line|setup-line)(\s|$)/.test(cls || '')); }

  document.addEventListener('copy', function (ev) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !ev.clipboardData) return;
    var frag = sel.getRangeAt(0).cloneContents();
    if (!frag.querySelector || !frag.querySelector('.math')) return;
    Array.prototype.slice.call(frag.querySelectorAll('.math')).forEach(function (m) { m.replaceWith(document.createTextNode(m.getAttribute('data-plain') || '')); });
    var tmp = el('div');
    tmp.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap';
    tmp.appendChild(frag);
    document.body.appendChild(tmp);
    var text = tmp.innerText;
    document.body.removeChild(tmp);
    ev.clipboardData.setData('text/plain', text);
    ev.preventDefault();
  });

  /* steps: the flat list with depth; rendered as nested numbered lists. "kind: combine" lines close the step with the same id. */
  function renderSteps(container, steps) {
    var root = el('ol', 'csteps'), ols = [root], lis = [];
    container.appendChild(root);
    steps.forEach(function (s) {
      var d = s.depth;
      if (s.kind === 'combine') {
        var host = lis[d];
        if (host) host.appendChild(mathEl('div', 'combine', s.text));
        return;
      }
      ols.length = d + 1;
      if (!ols[d]) { ols[d] = el('ol', 'csteps'); lis[d - 1].appendChild(ols[d]); }
      var li = el('li');
      li.appendChild(el('span', 'title', s.title));
      if (s.integral) li.appendChild(mathEl('div', 'eq int', s.integral));
      if (s.formula) { var f = el('div', 'formula'); f.appendChild(el('span', null, 'Formula: ')); rich(f, s.formula); li.appendChild(f); }
      (s.lines || []).forEach(function (l) { li.appendChild(mathEl('div', 'line', l)); });
      if (s.then) li.appendChild(mathEl('div', 'eq then', s.then));
      if (!s.hasChildren) li.appendChild(mathEl('div', 'eq out', '= ' + s.result));
      ols[d].appendChild(li);
      lis.length = d + 1;
      lis[d] = li;
    });
  }

  return { NS: NS, el: el, svgEl: svgEl, fmtNum: fmtNum, supNum: supNum, niceStep: niceStep, ticks: ticks, tickText: tickText, box: box, rich: rich, mathEl: mathEl, mathReady: mathReady, renderSteps: renderSteps };
})();
