/* Page for calculus.html: forms, step display and plots only. Every result comes from CAS (js/cas.js) and
   Integrate (js/integrate.js). All text that comes from the user or from the libraries goes in with textContent. */
(function () {
  'use strict';

  var S = function (e) { return CAS.toString(e).replace(/theta/g, 'θ'); };
  var $ = function (id) { return document.getElementById(id); };
  var V = function (v) { return v === 'theta' ? 'θ' : v; };       // how a variable name is shown

  var U = UIKit, el = U.el, svgEl = U.svgEl, fmtNum = U.fmtNum, supNum = U.supNum, box = U.box;

  /* ───────────────────────── tabs ───────────────────────── */

  var tabs = [$('tab-int'), $('tab-der')], panels = [$('panel-int'), $('panel-der')];
  function selectTab(i, focus) {
    tabs.forEach(function (t, k) {
      t.setAttribute('aria-selected', k === i ? 'true' : 'false');
      t.tabIndex = k === i ? 0 : -1;
      panels[k].classList.toggle('hidden', k !== i);
    });
    if (focus) tabs[i].focus();
    try { history.replaceState(null, '', i === 1 ? '#derivatives' : '#integrals'); } catch (e) { /* file:// */ }
    redrawPlots();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectTab(i, false); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); selectTab((i + 1) % tabs.length, true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); selectTab((i + tabs.length - 1) % tabs.length, true); }
      else if (e.key === 'Home') { e.preventDefault(); selectTab(0, true); }
      else if (e.key === 'End') { e.preventDefault(); selectTab(tabs.length - 1, true); }
    });
  });

  /* ───────────────────────── reading the typed function ───────────────────────── */

  /* Tidy what was typed: a leading ∫ and a trailing dx are ignored (with a note). */
  function cleanText(raw) {
    var t = raw, notes = [];
    if (/^\s*∫/.test(t)) { t = t.replace(/^\s*∫\s*/, ''); notes.push('The ∫ sign is not needed: just type the function.'); }
    var m = /(\s|\))d([a-zA-Z])\s*$/.exec(t);
    if (m && t.replace(/\s*d[a-zA-Z]\s*$/, '').trim()) {
      t = t.slice(0, m.index) + (m[1] === ')' ? ')' : '');
      notes.push('Leave out the “d' + m[2] + '”: only the function itself is typed. It was ignored.');
    }
    return { text: t, notes: notes };
  }

  /* Reads the input box, shows "Read as ..." or a plain-language error with the position marked. Returns the expression or null. */
  function readInput(input, note, quiet) {
    note.className = 'parse-note';
    note.textContent = '';
    var raw = input.value;
    if (!raw.trim()) { if (!quiet) { note.classList.add('bad'); note.appendChild(el('span', 'msg', 'Type a function first, for example x^2*sin(x).')); } return null; }
    var c = cleanText(raw), parsed;
    try { parsed = CAS.parseWithNotes(c.text); }
    catch (e) {
      if (!(e instanceof CAS.ParseError)) throw e;
      note.classList.add('bad');
      note.appendChild(el('span', 'msg', e.message));
      var p = el('span', 'pointer');
      var s = c.text, a = Math.min(e.pos, s.length), b = Math.min(Math.max(e.end, a + 1), s.length);
      p.appendChild(document.createTextNode(s.slice(0, a)));
      if (a < s.length) p.appendChild(el('mark', null, s.slice(a, b)));
      else p.appendChild(el('mark', null, '␣'));
      p.appendChild(document.createTextNode(s.slice(b)));
      note.appendChild(p);
      return null;
    }
    var line = el('span');
    line.appendChild(document.createTextNode('Read as: '));
    line.appendChild(U.mathEl('span', 'read', S(parsed.expr)));
    note.appendChild(line);
    c.notes.concat(parsed.notes).forEach(function (n) { note.appendChild(el('span', 'hint', n)); });
    return parsed.expr;
  }

  /* Which variable to work with. Returns { v } or { error }. */
  function chooseVariable(input, expr, hintEl) {
    var typed = input.value.trim(), vars = CAS.freeVars(expr), r;
    if (typed) {
      r = CAS.tryParse(typed);
      if (!r.ok || r.expr.t !== 'sym') return { error: 'In “With respect to” type one variable, such as x, t or theta.' };
      var v = r.expr.name;
      if (vars.indexOf(v) < 0 && vars.length === 1) {
        input.value = vars[0];
        return { v: vars[0], note: 'The function has no ' + v + ', so it is worked with respect to ' + vars[0] + ', its only variable.' };
      }
      return { v: v, note: vars.indexOf(v) < 0 ? 'The function does not contain ' + v + ', so it is treated as a constant.' : null };
    }
    var auto = vars.indexOf('x') >= 0 || !vars.length ? 'x' : vars[0];
    input.value = auto;
    return { v: auto, note: null };
  }

  function parseBoundText(text, which) {
    try { return { b: Integrate.parseBound(text) }; }
    catch (e) {
      if (e instanceof CAS.ParseError) return { error: which + ' limit: ' + e.message };
      throw e;
    }
  }

  /* ───────────────────────── step lists ───────────────────────── */

  var renderSteps = U.renderSteps;

  /* ───────────────────────── plots ───────────────────────── */

  var plotCount = 0, plots = {};
  var ticks = U.ticks, tickText = U.tickText;

  /* spec: { series: [{ f(x), name, dashed }], xmin, xmax, area: {a, b} | null, xLabel, yLabel, note } */
  function drawPlot(svg, spec) {
    var W = Math.max(300, Math.round(svg.getBoundingClientRect().width || 640));
    var H = Math.round(Math.max(250, Math.min(380, W * 0.55)));
    var M = W < 480 ? { l: 46, r: 10, t: 14, b: 40 } : { l: 58, r: 16, t: 16, b: 46 };
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.textContent = '';
    var pw = W - M.l - M.r, ph = H - M.t - M.b, N = 700, xs = [], i;
    for (i = 0; i <= N; i++) xs.push(spec.xmin + (spec.xmax - spec.xmin) * i / N);
    var data = spec.series.map(function (s) {
      return xs.map(function (x) { var y; try { y = s.f(x); } catch (e) { y = NaN; } return isFinite(y) ? y : NaN; });
    });
    var all = [];
    data.forEach(function (d) { d.forEach(function (y) { if (y === y) all.push(y); }); });
    if (all.length < 5) {
      svg.appendChild(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', 'class': 'axis-label' }, 'The function has no real values in the plotted window'));
      return;
    }
    all.sort(function (a, b) { return a - b; });
    var lo = all[Math.floor(0.02 * (all.length - 1))], hi = all[Math.ceil(0.98 * (all.length - 1))];
    if (spec.area) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.1, ymin = lo - pad, ymax = hi + pad, yr = ymax - ymin;
    var px = function (x) { return M.l + (x - spec.xmin) / (spec.xmax - spec.xmin) * pw; };
    var clampY = function (y) { return Math.max(ymin - yr, Math.min(ymax + yr, y)); };
    var py = function (y) { return M.t + ph - (clampY(y) - ymin) / yr * ph; };
    var id = 'plotclip' + (++plotCount);
    var defs = svgEl('defs', {}), cp = svgEl('clipPath', { id: id });
    cp.appendChild(svgEl('rect', { x: M.l, y: M.t, width: pw, height: ph }));
    defs.appendChild(cp); svg.appendChild(defs);

    var xt = ticks(spec.xmin, spec.xmax, Math.max(3, Math.min(8, Math.floor(pw / 80)))), yt = ticks(ymin, ymax, 5);
    yt.forEach(function (v) {
      var y = py(v);
      svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, 'class': 'grid-line' }));
      svg.appendChild(svgEl('text', { x: M.l - 7, y: y + 4, 'text-anchor': 'end', 'class': 'tick' }, tickText(v)));
    });
    xt.forEach(function (v) {
      var x = px(v);
      svg.appendChild(svgEl('line', { x1: x, x2: x, y1: M.t, y2: M.t + ph, 'class': 'grid-line' }));
      svg.appendChild(svgEl('text', { x: x, y: M.t + ph + 18, 'text-anchor': 'middle', 'class': 'tick' }, tickText(v)));
    });
    svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: M.t + ph, y2: M.t + ph, 'class': 'axis' }));
    svg.appendChild(svgEl('line', { x1: M.l, x2: M.l, y1: M.t, y2: M.t + ph, 'class': 'axis' }));
    if (ymin < 0 && ymax > 0) svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: py(0), y2: py(0), 'class': 'zero-line' }));
    if (spec.xmin < 0 && spec.xmax > 0) svg.appendChild(svgEl('line', { x1: px(0), x2: px(0), y1: M.t, y2: M.t + ph, 'class': 'zero-line' }));
    svg.appendChild(svgEl('text', { x: M.l + pw / 2, y: H - 6, 'text-anchor': 'middle', 'class': 'axis-label' }, spec.xLabel || ''));
    svg.appendChild(svgEl('text', { x: 13, y: M.t + ph / 2, 'text-anchor': 'middle', 'class': 'axis-label', transform: 'rotate(-90 13 ' + (M.t + ph / 2) + ')' }, spec.yLabel || ''));

    var g = svgEl('g', { 'clip-path': 'url(#' + id + ')' });
    svg.appendChild(g);
    // shaded area between the curve and the x-axis from a to b (first series)
    if (spec.area) {
      var d0 = data[0], run = [], a = spec.area.a, b = spec.area.b, y0 = py(0);
      var flush = function () {
        if (run.length > 1) {
          var pts = 'M' + px(xs[run[0]]).toFixed(1) + ',' + y0.toFixed(1);
          run.forEach(function (k) { pts += ' L' + px(xs[k]).toFixed(1) + ',' + py(d0[k]).toFixed(1); });
          pts += ' L' + px(xs[run[run.length - 1]]).toFixed(1) + ',' + y0.toFixed(1) + ' Z';
          g.appendChild(svgEl('path', { d: pts, 'class': 'area' }));
        }
        run = [];
      };
      for (i = 0; i <= N; i++) {
        if (xs[i] >= a && xs[i] <= b && d0[i] === d0[i]) run.push(i); else flush();
      }
      flush();
      [a, b].forEach(function (x) { if (isFinite(x) && x >= spec.xmin && x <= spec.xmax) g.appendChild(svgEl('line', { x1: px(x), x2: px(x), y1: M.t, y2: M.t + ph, 'class': 'limit-line' })); });
    }
    data.forEach(function (d, si) {
      var path = '', pen = false, prev = NaN;
      for (var k = 0; k <= N; k++) {
        var y = d[k];
        if (y !== y) { pen = false; prev = NaN; continue; }
        if (pen && Math.abs(y - prev) > 2.5 * yr) pen = false;           // an asymptote: lift the pen
        path += (pen ? 'L' : 'M') + px(xs[k]).toFixed(1) + ',' + py(y).toFixed(1) + ' ';
        pen = true; prev = y;
      }
      g.appendChild(svgEl('path', { d: path, 'class': spec.series[si].dashed ? 'line2' : 'line' }));
    });
    // legend
    var lx = M.l + 10, ly = M.t + 14;
    spec.series.forEach(function (s, si) {
      svg.appendChild(svgEl('line', { x1: lx, x2: lx + 24, y1: ly - 4 + si * 18, y2: ly - 4 + si * 18, 'class': 'legend-line' + (s.dashed ? ' dashed' : '') }));
      svg.appendChild(svgEl('text', { x: lx + 30, y: ly + si * 18, 'class': 'legend-text' }, s.name));
    });
    if (spec.note) svg.appendChild(svgEl('text', { x: W - M.r - 6, y: M.t + ph - 8, 'text-anchor': 'end', 'class': 'note-text' }, spec.note));
  }

  function pickWindow(fnum) {                // a window where the function has real values
    var cands = [[-5, 5], [-0.5, 6], [-6, 0.5], [-1.5, 1.5], [-10, 10]];
    var best = cands[0], bestScore = -1;
    for (var c = 0; c < cands.length; c++) {
      var w = cands[c], ok = 0;
      for (var i = 0; i <= 120; i++) { var y = fnum(w[0] + (w[1] - w[0]) * i / 120); if (isFinite(y)) ok++; }
      if (ok / 121 >= 0.9) return w;
      if (ok > bestScore) { bestScore = ok; best = w; }
    }
    return best;
  }

  function makePlotBox(out, key, caption) {
    var wrap = el('div', 'plot-wrap');
    var svg = svgEl('svg', { 'class': 'chart', 'aria-label': caption });
    wrap.appendChild(svg);
    out.appendChild(wrap);
    if (caption) out.appendChild(el('p', 'plot-caption', caption));
    return svg;
  }
  function showPlot(out, key, spec, caption) {
    var svg = makePlotBox(out, key, caption);
    plots[key] = { svg: svg, spec: spec };
    drawPlot(svg, spec);
  }
  function redrawPlots() {
    Object.keys(plots).forEach(function (k) {
      var p = plots[k];
      if (p.svg.isConnected && p.svg.getBoundingClientRect().width > 0) drawPlot(p.svg, p.spec);
    });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawPlots, 120); });

  function compileOrNull(expr, v) {
    try { var vars = CAS.freeVars(expr); if (vars.length > 1 || (vars.length === 1 && vars[0] !== v)) return null; return CAS.compile(expr, [v]); }
    catch (e) { return null; }
  }

  /* ───────────────────────── integrals ───────────────────────── */

  function verifiedLine(ver) {
    if (!ver) return '';
    return 'Checked: differentiating this answer gives back the function you typed' +
      (ver.symbolic ? ' (the two expressions simplify to the same thing' : ' (agreement at ' + ver.valid + ' random points') +
      (ver.symbolic ? ', and also at random points)' : ', and by finite differences of the answer itself)') + '.';
  }

  function renderIndefinite(out, f, v, res, notes) {
    var head = '∫ ' + (f.t === 'add' ? '(' + S(f) + ')' : S(f)) + ' d' + V(v);
    if (res.ok) {
      var r = el('div', 'result answer');
      r.appendChild(el('span', 'kind', 'Answer'));
      r.appendChild(U.mathEl('div', 'big', head + ' = ' + S(res.antiderivative) + ' + C'));
      var fx = res.factored && S(res.factored) !== S(res.antiderivative) ? S(res.factored) : '';
      if (fx) r.appendChild(U.mathEl('div', 'muted', 'Also written: ' + fx + ' + C'));
      r.appendChild(el('div', 'muted', verifiedLine(res.verified)));
      out.appendChild(r);
    } else {
      out.appendChild(box('bad-box', 'No method found', res.message.replace(/^No method found\.\s*/, '') +
        ' No answer is shown, because none can be checked. Things to try: check that you typed what you meant (the line under the input shows how it was read), or rewrite the function (expand a product, split a fraction) and try again.'));
    }
    notes.forEach(function (n) { out.appendChild(box('warn-box', null, n)); });
    // plot: the integrand and one antiderivative
    var fn = compileOrNull(f, v);
    if (fn) {
      var w = pickWindow(fn), series = [{ f: fn, name: 'f(' + V(v) + ')  (the function)' }];
      if (res.ok) { var Fn = compileOrNull(res.antiderivative, v); if (Fn) series.push({ f: Fn, name: 'F(' + V(v) + ')  (one antiderivative, C = 0)', dashed: true }); }
      showPlot(out, 'int', { series: series, xmin: w[0], xmax: w[1], area: null, xLabel: V(v), yLabel: '' },
        'The function' + (res.ok ? ' and one antiderivative (the curve for C = 0; other values of C move it up or down).' : '.'));
    } else if (CAS.freeVars(f).length > 1) {
      out.appendChild(el('p', 'plot-caption', 'No plot: the function contains other variables as well as ' + v + '.'));
    }
    if (res.ok) {
      out.appendChild(el('h2', null, 'Solution, step by step'));
      out.appendChild(el('p', 'steps-note', 'Each step says which rule is used. Where a step leaves a simpler integral, that integral is solved in the steps nested under it, and the result is put back at the end.'));
      renderSteps(out, res.steps);
    }
  }

  function renderDefinite(out, f, v, res, a, b, notes) {
    var tA = res.lower === Infinity ? '∞' : res.lower === -Infinity ? '−∞' : S(res.lower), tB = res.upper === Infinity ? '∞' : res.upper === -Infinity ? '−∞' : S(res.upper);
    var head = '∫ from ' + tA + ' to ' + tB + ' of ' + (f.t === 'add' ? '(' + S(f) + ')' : S(f)) + ' d' + V(v);
    var r = el('div', 'result answer');
    if (res.kind === 'exact') {
      var p1 = el('div', 'row-pair');
      p1.appendChild(el('span', 'kind', 'Exact value'));
      p1.appendChild(U.mathEl('div', 'big', head + ' = ' + S(res.exact)));
      if (res.exactNumber !== null && isFinite(res.exactNumber) && S(res.exact) !== fmtNum(res.exactNumber)) p1.appendChild(el('div', 'muted', '≈ ' + fmtNum(res.exactNumber) + '  (decimal form of the exact value)'));
      r.appendChild(p1);
      var p2 = el('div', 'row-pair');
      p2.appendChild(el('span', 'kind', 'Numeric check'));
      var big2 = el('div', 'big sm', fmtNum(res.numeric));
      big2.appendChild(el('span', 'numeric-tag', 'numeric'));
      p2.appendChild(big2);
      p2.appendChild(el('div', 'muted', res.numericMethod + ', estimated error ' + (res.numericError ? res.numericError.toExponential(1) : '0') + (res.agree ? '. It agrees with the exact value.' : '.')));
      r.appendChild(p2);
    } else if (res.kind === 'numeric') {
      var p3 = el('div', 'row-pair');
      p3.appendChild(el('span', 'kind', 'Numeric value only'));
      var big3 = U.mathEl('div', 'big', head + ' ≈ ' + fmtNum(res.numeric));
      big3.appendChild(el('span', 'numeric-tag', 'numeric'));
      p3.appendChild(big3);
      p3.appendChild(el('div', 'muted', res.message));
      r.appendChild(p3);
    } else if (res.kind === 'diverges') {
      r.appendChild(el('span', 'kind', 'Result'));
      r.appendChild(U.mathEl('div', 'big', head + ' does not have a finite value'));
      r.appendChild(el('div', 'muted', res.message));
    } else {
      out.appendChild(box('bad-box', res.ok ? 'No value' : 'No result', res.message || 'No value could be found.'));
      r = null;
    }
    if (r) out.appendChild(r);
    if (res.kind === 'numeric' && !res.antiderivative) out.appendChild(box('warn-box', 'No method found for the antiderivative', 'None of the rules applies, so there is no exact value. The number above comes from adaptive quadrature and is not checked against an exact one.'));
    if (res.kind === 'numeric' && res.antiderivative && res.exact === null && /disagree/.test(res.message)) out.appendChild(box('warn-box', 'Exact and numeric values disagree', res.message));
    if (res.issues.length && res.kind !== 'none') out.appendChild(box('warn-box', 'Points to note', '', res.issues));
    if (res.warnings.length) out.appendChild(box('warn-box', null, '', res.warnings));
    notes.forEach(function (n) { out.appendChild(box('warn-box', null, n)); });

    // plot with the shaded area
    var fn = compileOrNull(f, v);
    if (fn) {
      var lo = res.lower, hi = res.upper;
      if (typeof lo !== 'number') lo = CAS.evalNum(lo, {});
      if (typeof hi !== 'number') hi = CAS.evalNum(hi, {});
      if (lo > hi) { var tmp = lo; lo = hi; hi = tmp; }
      var xmin, xmax, note = '';
      if (isFinite(lo) && isFinite(hi)) { var pad = Math.max(0.2 * (hi - lo), 0.4); xmin = lo - pad; xmax = hi + pad; }
      else if (isFinite(lo)) { xmin = lo - 1; xmax = lo + 8; note = 'continues to ∞ →'; }
      else if (isFinite(hi)) { xmin = hi - 8; xmax = hi + 1; note = '← continues to −∞'; }
      else { xmin = -6; xmax = 6; note = 'continues in both directions'; }
      showPlot(out, 'int', { series: [{ f: fn, name: 'f(' + V(v) + ')' }], xmin: xmin, xmax: xmax, area: { a: lo, b: hi }, xLabel: V(v), yLabel: '', note: note },
        'The function, with the area between the limits shaded' + (res.improper ? ' (this integral is improper, so the plot only shows part of the region)' : '') + '.');
    } else if (CAS.freeVars(f).length > 1) {
      out.appendChild(el('p', 'plot-caption', 'No plot: the function contains other variables as well as ' + v + '.'));
    }

    if (res.antiderivative || res.steps.length) {
      out.appendChild(el('h2', null, 'Solution, step by step'));
      var n1 = res.steps.length ? 'First an antiderivative is found, then it is evaluated at the limits.' : '';
      out.appendChild(el('p', 'steps-note', n1));
      if (res.steps.length) {
        out.appendChild(el('h3', null, 'Part 1: find an antiderivative'));
        renderSteps(out, res.steps);
      }
      if (res.evaluation && res.evaluation.length) {
        out.appendChild(el('h3', null, 'Part 2: apply the limits'));
        var ev = el('div', 'eval-lines');
        res.evaluation.forEach(function (l) { ev.appendChild(U.mathEl('div', 'eq', l)); });
        out.appendChild(ev);
      }
    }
  }

  function solveIntegral() {
    var out = $('int-out');
    out.textContent = '';
    delete plots.int;
    var f = readInput($('int-f'), $('int-read'), false);
    if (!f) { $('int-f').focus(); return; }
    var vv = chooseVariable($('int-v'), f);
    if (vv.error) { out.appendChild(box('bad-box', null, vv.error)); $('int-v').focus(); return; }
    var notes = vv.note ? [vv.note] : [];
    var aT = $('int-a').value.trim(), bT = $('int-b').value.trim();
    if ((aT && !bT) || (!aT && bT)) { out.appendChild(box('bad-box', null, 'Give both limits for a definite integral, or leave both empty for an indefinite one.')); (aT ? $('int-b') : $('int-a')).focus(); return; }
    var A = null, B = null;
    if (aT) {
      var ra = parseBoundText(aT, 'Lower'), rb = parseBoundText(bT, 'Upper');
      if (ra.error || rb.error) { out.appendChild(box('bad-box', null, ra.error || rb.error)); (ra.error ? $('int-a') : $('int-b')).focus(); return; }
      A = ra.b; B = rb.b;
    }
    out.appendChild(el('p', 'muted', 'Working…'));
    setTimeout(function () {
      out.textContent = '';
      try {
        if (A === null) renderIndefinite(out, f, vv.v, Integrate.integrate(f, vv.v, { maxMs: 6000 }), notes);
        else renderDefinite(out, f, vv.v, Integrate.definite(f, vv.v, A, B, { maxMs: 6000 }), A, B, notes);
      } catch (e) {
        out.textContent = '';
        out.appendChild(box('bad-box', 'Something unexpected went wrong', e.message));
      }
      var top = out.getBoundingClientRect().top;
      if (top > window.innerHeight * 0.75) out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 20);
  }

  /* ───────────────────────── derivatives ───────────────────────── */

  var ORDER_NAMES = ['', 'First', 'Second', 'Third'];
  function derivNotation(v, n, partial) {
    var d = partial ? '∂' : 'd';
    return n === 1 ? d + '/' + d + V(v) : d + supNum(n) + '/' + d + V(v) + supNum(n);
  }

  function solveDerivative() {
    var out = $('der-out');
    out.textContent = '';
    delete plots.der;
    var f = readInput($('der-f'), $('der-read'), false);
    if (!f) { $('der-f').focus(); return; }
    var vv = chooseVariable($('der-v'), f);
    if (vv.error) { out.appendChild(box('bad-box', null, vv.error)); $('der-v').focus(); return; }
    var v = vv.v, n = parseInt($('der-n').value, 10) || 1;
    var vars = CAS.freeVars(f), others = vars.filter(function (x) { return x !== v; }), partial = others.length > 0;
    var sections = [], cur = f, k, final;
    try {
      for (k = 1; k <= n; k++) { var ds = CAS.diffSteps(cur, v); sections.push({ order: k, from: cur, ds: ds }); cur = ds.result; }
    } catch (e) { out.appendChild(box('bad-box', 'Something unexpected went wrong', e.message)); return; }
    final = cur;
    var d = derivNotation(v, n, partial);
    var r = el('div', 'result answer');
    r.appendChild(el('span', 'kind', n === 1 ? (partial ? 'Partial derivative' : 'Derivative') : ORDER_NAMES[n] + (partial ? ' partial derivative' : ' derivative')));
    r.appendChild(U.mathEl('div', 'big', d + ' [' + S(f) + '] = ' + S(final)));
    var fcom = CAS.factorCommon(final);
    if (S(fcom) !== S(final)) r.appendChild(U.mathEl('div', 'muted', 'Also written: ' + S(fcom)));
    if (partial) r.appendChild(el('div', 'muted', 'This is a partial derivative: ' + others.join(', ') + (others.length > 1 ? ' are' : ' is') + ' treated as ' + (others.length > 1 ? 'constants' : 'a constant') + '.'));
    out.appendChild(r);
    if (vv.note) out.appendChild(box('warn-box', null, vv.note));

    if (vars.length > 1) {                    // all first partial derivatives
      out.appendChild(el('h3', null, 'All first partial derivatives'));
      var tw = el('div', 'table-wrap'), tb = el('table', 'grad'), body = el('tbody');
      vars.forEach(function (x) {
        var tr = el('tr');
        var c1 = el('td'), c2 = el('td');
        U.rich(c1, '∂/∂' + V(x)); U.rich(c2, S(CAS.simplify(CAS.diff(f, x))));
        tr.appendChild(c1); tr.appendChild(c2);
        body.appendChild(tr);
      });
      tb.appendChild(body); tw.appendChild(tb); out.appendChild(tw);
    }

    var fn = compileOrNull(f, v), gn = compileOrNull(final, v);
    if (fn && gn) {
      var w = pickWindow(fn);
      showPlot(out, 'der', { series: [{ f: fn, name: 'f(' + V(v) + ')' }, { f: gn, name: (n === 1 ? 'f′' : n === 2 ? 'f″' : 'f‴') + '(' + V(v) + ')', dashed: true }], xmin: w[0], xmax: w[1], area: null, xLabel: V(v), yLabel: '' },
        'The function and its ' + (n === 1 ? 'derivative' : ORDER_NAMES[n].toLowerCase() + ' derivative') + ': where f rises the derivative is positive, and where f has a peak or a trough the derivative crosses zero.');
    }

    out.appendChild(el('h2', null, 'Solution, step by step'));
    out.appendChild(el('p', 'steps-note', 'Each line names the rule. Where a rule needs the derivative of a part (u′, v′, the inner function), that is worked out in the lines nested under it.' + (partial ? ' ' + others.join(', ') + (others.length > 1 ? ' do' : ' does') + ' not depend on ' + v + ', so ' + (others.length > 1 ? 'they are' : (others[0] + ' is')) + ' treated as ' + (others.length > 1 ? 'constants' : 'a constant') + ' and ' + (others.length > 1 ? 'their' : 'its') + ' derivative is 0.' : '')));
    sections.forEach(function (sec) {
      if (n > 1) out.appendChild(U.mathEl('h3', null, ORDER_NAMES[sec.order] + ' derivative of ' + S(sec.from)));
      var steps = sec.ds.steps.map(function (s) {
        return { depth: s.depth, kind: 'rule', title: s.rule, integral: derivNotation(v, 1, partial).replace('/', '/') + ' [' + S(s.expr) + ']', formula: s.formula, lines: [s.text], then: null, result: S(s.result), hasChildren: false };
      });
      var wrap = el('div');
      out.appendChild(wrap);
      renderSteps(wrap, steps);
      var res = U.mathEl('p', 'eq out', '= ' + S(sec.ds.result));
      out.appendChild(res);
    });
    var top = out.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.75) out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ───────────────────────── examples ───────────────────────── */

  var INT_EXAMPLES = [
    ['Indefinite integrals'],
    ['x·e^x', 'x*e^x'], ['x²·sin x', 'x^2*sin(x)'], ['ln x', 'ln(x)'], ['x·e^(x²)', 'x*e^(x^2)'], ['e^x·sin x', 'e^x*sin(x)'], ['arctan x', 'atan(x)'],
    ['1/(x²−1)', '1/(x^2-1)'], ['(3x+2)/(x²+x+1)', '(3x+2)/(x^2+x+1)'], ['sin³x', 'sin(x)^3'], ['sec³x', 'sec(x)^3'], ['√(1−x²)', 'sqrt(1-x^2)'], ['1/(x²·√(x²+1))', '1/(x^2*sqrt(x^2+1))'],
    ['Definite integrals', 'group'],
    ['∫ 0 to π of x·sin x', 'x*sin(x)', '0', 'pi'], ['∫ 0 to 1 of 1/(1+x²)', '1/(1+x^2)', '0', '1'], ['∫ 1 to e of ln x', 'ln(x)', '1', 'e'], ['∫ 0 to 2 of x·e^x', 'x*e^x', '0', '2'],
    ['Improper integrals', 'group'],
    ['∫ 1 to ∞ of 1/x²', '1/x^2', '1', 'inf'], ['∫ 0 to ∞ of x·e^(−x)', 'x*e^(-x)', '0', 'inf'], ['∫ −∞ to ∞ of 1/(1+x²)', '1/(1+x^2)', '-inf', 'inf'], ['∫ 0 to 1 of 1/√x', '1/sqrt(x)', '0', '1'],
    ['∫ 1 to ∞ of 1/x (diverges)', '1/x', '1', 'inf'], ['∫ −1 to 1 of 1/x² (diverges)', '1/x^2', '-1', '1'],
    ['No closed form', 'group'],
    ['e^(x²) (no method)', 'e^(x^2)'], ['sin x / x (no method)', 'sin(x)/x'], ['∫ 0 to ∞ of e^(−x²) (numeric only)', 'e^(-x^2)', '0', 'inf'], ['∫ 0 to 1 of sin x / x (numeric only)', 'sin(x)/x', '0', '1']
  ];
  var DER_EXAMPLES = [
    ['Derivatives'],
    ['x²·sin(3x)', 'x^2*sin(3x)'], ['sin x / x', 'sin(x)/x'], ['ln(x²+1)', 'ln(x^2+1)'], ['e^(x²)', 'e^(x^2)'], ['(x²+1)⁵', '(x^2+1)^5'], ['x^x', 'x^x'], ['√(1−x²)', 'sqrt(1-x^2)'], ['arctan(2x)', 'atan(2x)'],
    ['Second derivative', 'group'],
    ['x⁴ − 3x²', 'x^4-3x^2', 'x', '2'], ['x·e^(−x)', 'x*e^(-x)', 'x', '2'],
    ['Partial derivatives', 'group'],
    ['x²y + sin(xy), ∂/∂x', 'x^2*y+sin(x*y)', 'x', '1'], ['x²y + sin(xy), ∂/∂y', 'x^2*y+sin(x*y)', 'y', '1'], ['r²·sin θ, ∂/∂θ', 'r^2*sin(theta)', 'theta', '1'], ['x²y³ + e^(xz), ∂/∂z', 'x^2*y^3+e^(x*z)', 'z', '1']
  ];

  function buildChips(container, list, onPick) {
    list.forEach(function (ex) {
      if (ex.length === 1 || ex[1] === 'group') { container.appendChild(el('div', 'group', ex[0])); return; }
      var b = el('button', 'secondary', ex[0]);
      b.type = 'button';
      b.addEventListener('click', function () { onPick(ex); });
      container.appendChild(b);
    });
  }
  buildChips($('int-examples'), INT_EXAMPLES, function (ex) {
    $('int-f').value = ex[1];
    $('int-v').value = 'x';
    $('int-a').value = ex[2] || '';
    $('int-b').value = ex[3] || '';
    readInput($('int-f'), $('int-read'), true);
    solveIntegral();
  });
  buildChips($('der-examples'), DER_EXAMPLES, function (ex) {
    $('der-f').value = ex[1];
    $('der-v').value = ex[2] || 'x';
    $('der-n').value = ex[3] || '1';
    readInput($('der-f'), $('der-read'), true);
    solveDerivative();
  });

  /* ───────────────────────── wiring ───────────────────────── */

  $('int-f').addEventListener('input', function () { readInput($('int-f'), $('int-read'), true); });
  $('der-f').addEventListener('input', function () { readInput($('der-f'), $('der-read'), true); });
  ['int-f', 'int-v', 'int-a', 'int-b'].forEach(function (id) { $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') solveIntegral(); }); });
  ['der-f', 'der-v'].forEach(function (id) { $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') solveDerivative(); }); });
  $('int-go').addEventListener('click', solveIntegral);
  $('der-go').addEventListener('click', solveDerivative);
  $('int-clear').addEventListener('click', function () {
    ['int-f', 'int-a', 'int-b'].forEach(function (id) { $(id).value = ''; });
    $('int-v').value = 'x';
    $('int-read').textContent = ''; $('int-read').className = 'parse-note';
    $('int-out').textContent = ''; delete plots.int;
    $('int-f').focus();
  });
  $('der-clear').addEventListener('click', function () {
    $('der-f').value = ''; $('der-v').value = 'x'; $('der-n').value = '1';
    $('der-read').textContent = ''; $('der-read').className = 'parse-note';
    $('der-out').textContent = ''; delete plots.der;
    $('der-f').focus();
  });

  readInput($('int-f'), $('int-read'), true);
  readInput($('der-f'), $('der-read'), true);
  if (location.hash === '#derivatives') selectTab(1, false);
})();
