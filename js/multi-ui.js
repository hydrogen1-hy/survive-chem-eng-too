/* Page for multi.html: forms, pictures and the step display only. Every result comes from Multi (js/multi.js), which uses
   CAS (js/cas.js) and Integrate (js/integrate.js). All text that comes from the user or from the libraries goes in with textContent. */
(function () {
  'use strict';

  var U = UIKit, el = U.el, svgEl = U.svgEl, fmtNum = U.fmtNum, box = U.box;
  var S = Multi.S, nice = Multi.nice, BT = Multi.boundText;
  var $ = function (id) { return document.getElementById(id); };
  var mode = 'double';
  var typed = {};                        // what is in the limit boxes, kept when the order or the coordinates change
  var plots = [];                        // pictures that are redrawn when the window is resized

  /* ───────────────────────── small helpers ───────────────────────── */

  function paren(t) { return /[+−]|\s-\s/.test(t) && !/^\(.*\)$/.test(t) ? '(' + t + ')' : t; }
  function perms(a) {
    if (a.length <= 1) return [a.slice()];
    var out = [];
    a.forEach(function (x, i) { perms(a.slice(0, i).concat(a.slice(i + 1))).forEach(function (p) { out.push([x].concat(p)); }); });
    return out;
  }
  function dim() { return mode === 'triple' ? 3 : 2; }
  function sysName() { return $('sys').value; }
  function orderNames() { return $('ord').value.split(','); }          // innermost first
  function numText(x) { return x === null || x === undefined || !isFinite(x) ? '' : fmtNum(x); }
  function exactLine(exact, number) {
    var t = S(exact);
    return number !== null && number !== undefined && isFinite(number) && t !== fmtNum(number) ? t + '  ≈ ' + fmtNum(number) : t;
  }

  /* ───────────────────────── tabs ───────────────────────── */

  var tabs = [$('tab-double'), $('tab-triple')], MODES = ['double', 'triple'];
  function selectTab(i, focus) {
    tabs.forEach(function (t, k) { t.setAttribute('aria-selected', k === i ? 'true' : 'false'); t.tabIndex = k === i ? 0 : -1; });
    $('panel').setAttribute('aria-labelledby', tabs[i].id);
    if (focus) tabs[i].focus();
    setMode(MODES[i]);
    try { history.replaceState(null, '', '#' + MODES[i]); } catch (e) { /* file:// */ }
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectTab(i, false); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); selectTab((i + 1) % tabs.length, true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); selectTab((i + tabs.length - 1) % tabs.length, true); }
    });
  });

  var SYSTEMS = {
    double: [['cartesian', 'Cartesian (x, y)'], ['polar', 'Polar (r, θ)']],
    triple: [['cartesian', 'Cartesian (x, y, z)'], ['cylindrical', 'Cylindrical (r, θ, z)'], ['spherical', 'Spherical (ρ, φ, θ)']]
  };

  function setMode(m) {
    if (m === mode && $('sys').options.length) return;
    mode = m;
    $('form-title').textContent = m === 'triple' ? 'Triple integral' : 'Double integral';
    $('also-size-label').textContent = m === 'triple' ? 'the volume of the region' : 'the area of the region';
    var sys = $('sys');
    sys.textContent = '';
    SYSTEMS[m].forEach(function (s) { var o = el('option', null, s[1]); o.value = s[0]; sys.appendChild(o); });
    typed = {};
    fillOrders();
    buildLimits();
    buildExamples();
    $('out').textContent = '';
    $('ex-desc').textContent = '';
    updateFHelp();
    updateSetup();
  }

  function fillOrders(keep) {
    var d = dim(), vars = Multi.coords(sysName(), d).vars, sel = $('ord');
    sel.textContent = '';
    var def = Multi.defaultOrder(sysName(), d), list = perms(vars.slice());
    list.sort(function (a, b) { return (a.join() === def.join() ? 0 : 1) - (b.join() === def.join() ? 0 : 1); });
    list.forEach(function (p) {
      var o = el('option', null, p.map(function (v) { return 'd' + nice(v); }).join(' ') + '   (' + p.map(nice).join(', then ') + ')');
      o.value = p.join(',');
      sel.appendChild(o);
    });
    if (keep && list.some(function (p) { return p.join() === keep; })) sel.value = keep;
  }

  function updateFHelp() {
    var sn = sysName(), t;
    if (sn === 'polar') t = 'You can type the function in x and y (it is converted to r and θ) or directly in r and θ. The factor r is added for you.';
    else if (sn === 'cylindrical') t = 'Type the function in x, y, z or in r, θ, z. The factor r is added for you.';
    else if (sn === 'spherical') t = 'Type the function in x, y, z or in ρ, φ, θ (write rho, phi, theta). The factor ρ² sin φ is added for you.';
    else t = 'The function of ' + (dim() === 3 ? 'x, y and z' : 'x and y') + ' to integrate over the region.';
    $('f-help').textContent = t;
    var lh = 'Give the limits of each variable, outermost first. The outermost limits are numbers; each inner limit may use the variables written above it.';
    if (sn !== 'cartesian') lh += ' Angles are in radians: use pi, for example 2*pi or pi/2.';
    $('lim-help').textContent = lh;
  }

  /* ───────────────────────── the limits form ───────────────────────── */

  function buildLimits() {
    var host = $('limits'), order = orderNames(), n = order.length;
    host.textContent = '';
    for (var k = n - 1; k >= 0; k--) {
      (function (k) {
        var v = order[k], outerNames = order.slice(k + 1);
        var row = el('div', 'limit-row');
        var nm = el('div', 'vname', nice(v));
        nm.appendChild(el('small', null, k === n - 1 ? 'outermost: numbers' : 'may use ' + outerNames.map(nice).join(', ')));
        row.appendChild(nm);
        [['lo', 'lower limit', 'from', '0'], ['hi', 'upper limit', 'to', k === n - 1 ? '1' : outerNames[0]]].forEach(function (p) {
          var cell = el('div');
          var lab = el('label', 'lab', p[2]);
          lab.htmlFor = p[0] + '-' + v;
          var inp = el('input');
          inp.type = 'text'; inp.id = p[0] + '-' + v; inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'off');
          inp.placeholder = 'e.g. ' + p[3];
          inp.setAttribute('aria-label', nice(v) + ' ' + p[1]);
          inp.value = typed[inp.id] || '';
          inp.addEventListener('input', function () { typed[inp.id] = inp.value; inp.classList.remove('invalid'); var m = row.querySelector('.field-msg'); if (m) m.remove(); updateSetup(); });
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') solve(); });
          cell.appendChild(lab); cell.appendChild(inp);
          row.appendChild(cell);
        });
        host.appendChild(row);
      })(k);
    }
  }

  function updateSetup() {
    var order = orderNames(), parts = [];
    for (var k = order.length - 1; k >= 0; k--) {
      var v = order[k];
      parts.push('∫ ' + nice(v) + ': ' + (typed['lo-' + v] || '?') + ' → ' + (typed['hi-' + v] || '?'));
    }
    var ft = $('f').value.trim() || 'f';
    $('setup').textContent = parts.join('   ') + '   ' + paren(ft) + '  ' + order.map(function (v) { return 'd' + nice(v); }).join(' ');
  }

  /* ───────────────────────── reading the function ───────────────────────── */

  /* A leading ∫ and trailing differentials (dy dx, dz dr dθ) are ignored, with a note. */
  var DIFF = '(?:d(?:x|y|z|r|theta|rho|phi|θ|ρ|φ))';
  function cleanText(raw) {
    var t = raw, notes = [];
    if (/^\s*[∫]+/.test(t)) { t = t.replace(/^\s*[∫]+\s*/, ''); notes.push('The ∫ signs are not needed: type only the function.'); }
    var m = new RegExp('(?:^|[\\s)])(' + DIFF + '(?:\\s*' + DIFF + ')*)\\s*$').exec(t);
    if (m && t.slice(0, m.index + (m[0].length - m[0].replace(/^[\s)]/, '').length)).trim()) {
      var head = m[0].charAt(0) === ')' ? ')' : '';
      t = t.slice(0, m.index) + head;
      notes.push('Leave out the “' + m[1] + '”: the order is chosen above. It was ignored.');
    }
    return { text: t, notes: notes };
  }

  function showReadNote(note, text, parsed, error, c) {
    note.className = 'parse-note';
    note.textContent = '';
    if (error) {
      note.classList.add('bad');
      note.appendChild(el('span', 'msg', error.message));
      var p = el('span', 'pointer'), s = text, a = Math.min(error.pos || 0, s.length), b = Math.min(Math.max(error.end || a + 1, a + 1), s.length);
      p.appendChild(document.createTextNode(s.slice(0, a)));
      p.appendChild(el('mark', null, a < s.length ? s.slice(a, b) : '␣'));
      p.appendChild(document.createTextNode(s.slice(b)));
      note.appendChild(p);
      return;
    }
    var line = el('span');
    line.appendChild(document.createTextNode('Read as: '));
    line.appendChild(el('span', 'read', S(parsed.expr)));
    note.appendChild(line);
    c.notes.concat(parsed.notes || []).forEach(function (n) { note.appendChild(el('span', 'hint', n)); });
  }

  function readF(quiet) {
    var note = $('f-read'), raw = $('f').value;
    if (!raw.trim()) { note.className = 'parse-note'; note.textContent = ''; if (!quiet) { note.classList.add('bad'); note.appendChild(el('span', 'msg', 'Type the function first, for example x^2 + y^2.')); } return null; }
    var c = cleanText(raw), parsed;
    try { parsed = CAS.parseWithNotes(c.text); }
    catch (e) { if (!(e instanceof CAS.ParseError)) throw e; showReadNote(note, c.text, null, e, c); return null; }
    showReadNote(note, c.text, parsed, null, c);
    return c.text;
  }

  /* ───────────────────────── pictures ───────────────────────── */

  var arrowCount = 0;
  function newSvg(label) { return svgEl('svg', { 'class': 'chart', role: 'img', 'aria-label': label }); }

  function drawRegion(svg, geom) {
    var W = Math.max(300, Math.round(svg.getBoundingClientRect().width || 640)), b = geom.bbox;
    svg.textContent = '';
    if (!(isFinite(b.lo[0]) && isFinite(b.hi[0]) && isFinite(b.lo[1]) && isFinite(b.hi[1]))) {
      svg.setAttribute('viewBox', '0 0 ' + W + ' 80');
      svg.appendChild(svgEl('text', { x: W / 2, y: 40, 'text-anchor': 'middle', 'class': 'axis-label' }, 'The region is empty or not defined'));
      return;
    }
    var x0 = b.lo[0], x1 = b.hi[0], y0 = b.lo[1], y1 = b.hi[1];
    var dx = Math.max(x1 - x0, 1e-9), dy = Math.max(y1 - y0, 1e-9);
    x0 -= dx * 0.08; x1 += dx * 0.08; y0 -= dy * 0.08; y1 += dy * 0.08; dx = x1 - x0; dy = y1 - y0;
    var M = W < 480 ? { l: 40, r: 10, t: 12, b: 34 } : { l: 52, r: 16, t: 14, b: 40 };
    var scale = (W - M.l - M.r) / dx;
    if (dy * scale > 420) scale = 420 / dy;
    var pw = dx * scale, ph = dy * scale, H = Math.round(ph + M.t + M.b), offX = M.l + (W - M.l - M.r - pw) / 2;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var px = function (x) { return offX + (x - x0) * scale; }, py = function (y) { return M.t + (y1 - y) * scale; };
    var id = 'arrow' + (++arrowCount);
    var defs = svgEl('defs', {}), mk = svgEl('marker', { id: id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    mk.appendChild(svgEl('path', { d: 'M0,1 L10,5 L0,9 z', 'class': 'arrow-head' }));
    defs.appendChild(mk); svg.appendChild(defs);
    U.ticks(x0, x1, Math.max(3, Math.min(9, Math.floor(pw / 70)))).forEach(function (v) {
      svg.appendChild(svgEl('line', { x1: px(v), x2: px(v), y1: M.t, y2: M.t + ph, 'class': 'grid-line' }));
      svg.appendChild(svgEl('text', { x: px(v), y: M.t + ph + 16, 'text-anchor': 'middle', 'class': 'tick' }, U.tickText(v)));
    });
    U.ticks(y0, y1, Math.max(3, Math.min(8, Math.floor(ph / 55)))).forEach(function (v) {
      svg.appendChild(svgEl('line', { x1: offX, x2: offX + pw, y1: py(v), y2: py(v), 'class': 'grid-line' }));
      svg.appendChild(svgEl('text', { x: offX - 6, y: py(v) + 4, 'text-anchor': 'end', 'class': 'tick' }, U.tickText(v)));
    });
    svg.appendChild(svgEl('rect', { x: offX, y: M.t, width: pw, height: ph, fill: 'none', 'class': 'axis' }));
    if (y0 < 0 && y1 > 0) svg.appendChild(svgEl('line', { x1: offX, x2: offX + pw, y1: py(0), y2: py(0), 'class': 'zero-line' }));
    if (x0 < 0 && x1 > 0) svg.appendChild(svgEl('line', { x1: px(0), x2: px(0), y1: M.t, y2: M.t + ph, 'class': 'zero-line' }));
    svg.appendChild(svgEl('text', { x: offX + pw - 4, y: M.t + ph - 6, 'text-anchor': 'end', 'class': 'axis-label' }, 'x'));
    svg.appendChild(svgEl('text', { x: offX + 6, y: M.t + 14, 'class': 'axis-label' }, 'y'));
    var path = function (pts, close) { return 'M' + pts.map(function (p) { return px(p[0]).toFixed(1) + ',' + py(p[1]).toFixed(1); }).join(' L') + (close ? ' Z' : ''); };
    geom.runs.forEach(function (r) {
      svg.appendChild(svgEl('path', { d: path(r.polygon, true), 'class': r.ok ? 'region-fill' : 'region-bad' }));
    });
    geom.runs.forEach(function (r) { svg.appendChild(svgEl('path', { d: path(r.polygon, true), 'class': 'region-edge' })); });
    geom.runs.forEach(function (r) {
      if (!r.ok) return;
      r.sweeps.forEach(function (sw) { svg.appendChild(svgEl('path', { d: path(sw, false), 'class': 'sweep', 'marker-end': 'url(#' + id + ')' })); });
    });
  }

  function draw3D(svg, geom, view) {
    var W = Math.max(300, Math.round(svg.getBoundingClientRect().width || 640)), H = Math.round(Math.max(280, Math.min(460, W * 0.7)));
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.textContent = '';
    var az = view.az * Math.PI / 180, ev = view.el * Math.PI / 180, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(ev), se = Math.sin(ev);
    var proj = function (p) { var x1 = p[0] * ca - p[1] * sa, y1 = p[0] * sa + p[1] * ca; return [x1, p[2] * ce + y1 * se]; };
    var b = geom.bbox, ext = [0, 1, 2].map(function (i) { return Math.max(Math.abs(b.lo[i]), Math.abs(b.hi[i]), 1e-9); });
    var axes = [[[0, 0, 0], [ext[0] * 1.15, 0, 0], 'x'], [[0, 0, 0], [0, ext[1] * 1.15, 0], 'y'], [[0, 0, 0], [0, 0, ext[2] * 1.15], 'z']];
    var all = [];
    var lines = geom.lines.map(function (l) { var q = l.pts.map(proj); q.forEach(function (p) { all.push(p); }); return { kind: l.kind, pts: q }; });
    axes.forEach(function (a) { all.push(proj(a[1])); });
    all.push([0, 0]);
    var xs = all.map(function (p) { return p[0]; }), ys = all.map(function (p) { return p[1]; });
    var xa = Math.min.apply(null, xs), xb = Math.max.apply(null, xs), ya = Math.min.apply(null, ys), yb = Math.max.apply(null, ys);
    var m = 22, scale = Math.min((W - 2 * m) / Math.max(xb - xa, 1e-9), (H - 2 * m) / Math.max(yb - ya, 1e-9));
    var ox = (W - (xb - xa) * scale) / 2, oy = (H - (yb - ya) * scale) / 2;
    var px = function (p) { return (ox + (p[0] - xa) * scale).toFixed(1) + ',' + (H - oy - (p[1] - ya) * scale).toFixed(1); };
    ['lo', 'side', 'hi'].forEach(function (kind) {
      var d = '';
      lines.forEach(function (l) { if (l.kind === kind) d += 'M' + l.pts.map(px).join(' L') + ' '; });
      if (d) svg.appendChild(svgEl('path', { d: d, 'class': 's3-' + kind }));
    });
    axes.forEach(function (a) {
      var p0 = proj(a[0]), p1 = proj(a[1]);
      svg.appendChild(svgEl('line', { x1: px(p0).split(',')[0], y1: px(p0).split(',')[1], x2: px(p1).split(',')[0], y2: px(p1).split(',')[1], 'class': 'axis3' }));
      var q = px(p1).split(',');
      svg.appendChild(svgEl('text', { x: +q[0] + 5, y: +q[1] + 4, 'class': 'axis-label' }, a[2]));
    });
  }

  function addRegionPlot(out, geom) {
    var wrap = el('div', 'plot-box'), svg = newSvg('The region of integration in the x y plane');
    wrap.appendChild(svg); out.appendChild(wrap);
    var draw = function () { drawRegion(svg, geom); };
    plots.push({ svg: svg, draw: draw }); draw();
    var cap = 'The shaded region is what your limits describe. The arrows show the direction of the inner integral.';
    if (geom.runs.some(function (r) { return !r.ok; })) cap += ' Red marks places where the lower limit is above the upper limit.';
    if (geom.clipped) cap += ' A limit is infinite, so the picture is cut off.';
    out.appendChild(el('p', 'plot-caption', cap));
  }

  function addSolidPlot(out, geom) {
    var view = { az: -55, el: 22 };
    var wrap = el('div', 'plot-box'), svg = newSvg('The solid, as a wire frame');
    svg.classList.add('draggable');
    wrap.appendChild(svg); out.appendChild(wrap);
    var draw = function () { draw3D(svg, geom, view); };
    plots.push({ svg: svg, draw: draw }); draw();
    var ctl = el('div', 'view-controls');
    var mkSlider = function (label, key, min, max) {
      var l = el('label'), s = el('input');
      s.type = 'range'; s.min = min; s.max = max; s.value = view[key]; s.setAttribute('aria-label', label);
      l.appendChild(document.createTextNode(label)); l.appendChild(s);
      s.addEventListener('input', function () { view[key] = +s.value; draw(); });
      return { label: l, input: s };
    };
    var sa = mkSlider('Turn', 'az', -180, 180), se = mkSlider('Tilt', 'el', -85, 85);
    ctl.appendChild(sa.label); ctl.appendChild(se.label); out.appendChild(ctl);
    var drag = null;
    svg.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, az: view.az, el: view.el }; try { svg.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    svg.addEventListener('pointermove', function (e) {
      if (!drag) return;
      view.az = Math.max(-180, Math.min(180, drag.az + (e.clientX - drag.x) * 0.5));
      view.el = Math.max(-85, Math.min(85, drag.el + (e.clientY - drag.y) * 0.5));
      sa.input.value = view.az; se.input.value = view.el; draw();
    });
    var end = function () { drag = null; };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    var cap = 'A wire frame of the solid: the grey lines are the surface the innermost variable starts on, the blue lines the surface it ends on, and the dashed lines join them at the edge. Drag the picture or use the sliders to turn it.';
    if (geom.clipped) cap += ' A limit is infinite, so the picture is cut off.';
    out.appendChild(el('p', 'plot-caption', cap));
  }

  function redrawPlots() {
    plots = plots.filter(function (p) { return p.svg.isConnected; });
    plots.forEach(function (p) { if (p.svg.getBoundingClientRect().width > 0) p.draw(); });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawPlots, 120); });

  /* ───────────────────────── showing the result ───────────────────────── */

  var ROLE_TITLE = { inner: 'the inner integral', middle: 'the middle integral', outer: 'the outer integral' };

  function levelHead(l) { return '∫ from ' + BT(l.lower) + ' to ' + BT(l.upper) + ' of ' + paren(S(l.integrand)) + ' d' + nice(l.v); }

  function renderLevels(parent, res) {
    res.levels.forEach(function (l, k) {
      var d = el('div', 'work-level');
      d.appendChild(el('h3', null, 'Step ' + (k + 1) + ': ' + ROLE_TITLE[l.role] + ', with respect to ' + nice(l.v)));
      d.appendChild(el('div', 'int-line', levelHead(l)));
      if (l.steps.length) {
        var det = el('details'), sum = el('summary', null, 'Show how the antiderivative is found, rule by rule (' + l.steps.length + ' step' + (l.steps.length > 1 ? 's' : '') + ')');
        det.appendChild(sum);
        U.renderSteps(det, l.steps);
        d.appendChild(det);
      }
      if (l.evaluation && l.evaluation.length) { var ev = el('div', 'eval-lines'); l.evaluation.forEach(function (t) { ev.appendChild(el('div', 'eq', t.replace(/theta/g, 'θ').replace(/\brho\b/g, 'ρ').replace(/\bphi\b/g, 'φ'))); }); d.appendChild(ev); }
      if (l.ok) {
        d.appendChild(el('div', 'result-line', '= ' + S(l.result)));
        if (k < res.levels.length - 1) d.appendChild(el('div', 'muted small', 'This is the function to integrate in the next step.'));
      } else d.appendChild(box('bad-box', 'This step could not be completed', l.message));
      (l.issues || []).concat(l.warnings || []).forEach(function (t) { d.appendChild(box('warn-box', null, t)); });
      parent.appendChild(d);
    });
  }

  function renderConversion(parent, res) {
    var c = res.conversion;
    if (!c) return;
    var b = el('div', 'convert-box');
    b.appendChild(el('strong', null, 'Change of variables'));
    c.map.forEach(function (t) { b.appendChild(el('div', 'eq', t)); });
    b.appendChild(el('div', 'eq', c.element + '    (the factor ' + c.jacobian + ' is the Jacobian)'));
    b.appendChild(el('div', 'eq', 'f = ' + S(res.integrand)));
    if (c.substituted) b.appendChild(el('div', 'eq', 'in the new variables: ' + S(c.substituted)));
    b.appendChild(el('div', 'eq', 'f · ' + c.jacobian + ' = ' + S(res.converted) + '     ← this is integrated'));
    parent.appendChild(b);
  }

  function setupLine(res) {
    return res.setup.map(function (s) { return '∫ ' + nice(s.v) + ': ' + s.lower + ' → ' + s.upper; }).join('   ') + '   ' + paren(S(res.integrand)) + '  ' + res.order.map(function (v) { return 'd' + nice(v); }).join(' ');
  }

  function checkedLine(res) {
    if (res.numeric === null || !isFinite(res.numeric)) return '';
    var t = 'Check: nested numerical integration of the original function gives ' + fmtNum(res.numeric) + (res.numericError ? ' (estimated error ' + res.numericError.toExponential(1) + ')' : '');
    if (res.params.length) t += ', at sample values of ' + res.params.join(', ');
    return t + (res.agree ? '. It agrees with the exact value.' : '.');
  }

  function renderAnswer(out, res) {
    var r = el('div', 'result answer');
    r.appendChild(el('div', 'setup-line', setupLine(res)));
    if (res.kind === 'exact') {
      r.appendChild(el('span', 'kind', 'Result'));
      r.appendChild(el('div', 'big', exactLine(res.exact, res.exactNumber)));
      var c = checkedLine(res);
      if (c) r.appendChild(el('div', 'checked', c));
      out.appendChild(r);
    } else if (res.kind === 'numeric') {
      r.appendChild(el('span', 'kind', 'Numeric value only'));
      var big = el('div', 'big', '≈ ' + fmtNum(res.numeric));
      big.appendChild(el('span', 'numeric-tag', 'numeric'));
      r.appendChild(big);
      if (res.message) r.appendChild(el('div', 'muted', res.message));
      out.appendChild(r);
    } else {
      out.appendChild(box('bad-box', res.diverges ? 'No finite value' : 'No result', res.message || 'No value could be found.'));
    }
    if (res.kind !== 'none' && res.kind !== 'numeric' && res.message) out.appendChild(box('warn-box', null, res.message));
    res.notes.forEach(function (n) { out.appendChild(box('warn-box', null, n)); });
    if (res.warnings.length) out.appendChild(box('warn-box', null, '', res.warnings));
  }

  function renderApplications(out, spec, res) {
    var wanted = [];
    if ($('also-size').checked) wanted.push('size');
    if ($('also-average').checked) wanted.push('average');
    if ($('also-centroid').checked) wanted.push('centroid');
    if (!wanted.length || res.params.length) { if (wanted.length) out.appendChild(box('warn-box', null, 'The extra quantities are not worked out when the limits contain symbols other than the coordinates.')); return; }
    var a = Multi.applications(spec, wanted, { maxMs: 4000 });
    var wrap = el('div', 'apps'), tw = el('div', 'table-wrap'), tb = el('table'), body = el('tbody');
    var row = function (name, text) { var tr = el('tr'); tr.appendChild(el('td', null, name)); tr.appendChild(el('td', null, text)); body.appendChild(tr); };
    var show = function (x) { return x && x.exact ? exactLine(x.exact, x.number) : x && x.number !== null && x.number !== undefined ? '≈ ' + fmtNum(x.number) + '  (numeric)' : 'not found' + (x && x.message ? ': ' + x.message : ''); };
    if (a.size) row(dim() === 3 ? 'Volume' : 'Area', show(a.size));
    if (a.average) row('Average value of f', show(a.average));
    if (a.centroid) row('Centroid', a.centroid.map(function (c) { return c.axis + '̄ = ' + show(c); }).join(';   '));
    tb.appendChild(body); tw.appendChild(tb); wrap.appendChild(el('h3', null, 'Also worked out')); wrap.appendChild(tw);
    out.appendChild(wrap);
  }

  /* the same integral with the order swapped */
  function renderReversed(host, spec, auto) {
    host.textContent = '';
    var rv = Multi.solveReversed(spec, { maxMs: 5000 });
    if (!rv.ok) {
      host.appendChild(box(auto ? 'warn-box' : 'bad-box', auto ? 'The other order does not help' : 'Cannot swap the order', rv.message));
      return;
    }
    var r = el('div', 'result answer');
    r.appendChild(el('span', 'kind', auto ? 'In the other order it works' : 'The other order'));
    var pieceLine = function (p) {
      var o = p.order;
      return '∫ ' + nice(o[1].v) + ': ' + BT(o[1].lower) + ' → ' + BT(o[1].upper) + '   ∫ ' + nice(o[0].v) + ': ' + BT(o[0].lower) + ' → ' + BT(o[0].upper) + '   ' + paren(S(CAS.parse(spec.f))) + '  d' + nice(o[0].v) + ' d' + nice(o[1].v);
    };
    rv.pieces.forEach(function (p, i) {
      r.appendChild(el('div', 'setup-line', (rv.pieces.length > 1 ? 'Piece ' + (i + 1) + ':  ' : '') + pieceLine(p)));
    });
    if (rv.pieces.length > 1) r.appendChild(el('div', 'muted small', 'The region needs ' + rv.pieces.length + ' pieces in this order; the integral is the sum of the pieces.'));
    if (rv.kind === 'exact') { r.appendChild(el('div', 'big', exactLine(rv.exact, rv.exactNumber))); }
    else { var big = el('div', 'big', '≈ ' + fmtNum(rv.numeric)); big.appendChild(el('span', 'numeric-tag', 'numeric')); r.appendChild(big); }
    if (rv.originalNumeric !== undefined) r.appendChild(el('div', 'checked', 'Check: the original order, integrated numerically, gives ' + fmtNum(rv.originalNumeric) + (rv.agree ? '. It agrees.' : '.')));
    host.appendChild(r);
    host.appendChild(el('h3', null, 'Working in the other order'));
    rv.pieces.forEach(function (p, i) {
      var pc = el('div', 'piece');
      if (rv.pieces.length > 1) pc.appendChild(el('strong', null, 'Piece ' + (i + 1)));
      pc.appendChild(el('div', 'eq', pieceLine(p)));
      renderLevels(pc, p.result);
      host.appendChild(pc);
    });
  }

  function render(out, spec, res) {
    if (res.problems.length) {
      showProblems(res.problems);
      out.appendChild(box('bad-box', 'Check the form', res.problems[0].message));
      return;
    }
    renderAnswer(out, res);

    var cartesian2 = res.system === 'cartesian' && res.dim === 2 && !res.params.length;
    var alt = el('div', 'alt');
    if (cartesian2 && res.kind !== 'exact' && !res.diverges && res.levels.some(function (l) { return !l.ok; })) renderReversed(alt, spec, true);
    else if (cartesian2 && res.kind === 'exact') {
      var p = el('p', 'alt-actions'), btn = el('button', 'secondary', 'Show the other order');
      btn.type = 'button';
      btn.addEventListener('click', function () { p.remove(); renderReversed(alt, spec, false); });
      p.appendChild(btn); alt.appendChild(p);
    }
    out.appendChild(alt);

    renderApplications(out, spec, res);

    var g = Multi.geometry(spec);
    if (g.kind === 'region' || g.kind === 'solid') {
      out.appendChild(el('h2', null, g.kind === 'region' ? 'The region' : 'The solid'));
      if (g.kind === 'region') addRegionPlot(out, g); else addSolidPlot(out, g);
    }

    out.appendChild(el('h2', null, 'Solution, step by step'));
    out.appendChild(el('p', 'steps-note', 'The integral is done one variable at a time, innermost first. Each step integrates with respect to one variable, with the other variables treated as constants, and the result becomes the function for the next step.'));
    renderConversion(out, res);
    renderLevels(out, res);
  }

  /* ───────────────────────── errors in the form ───────────────────────── */

  function clearProblems() {
    document.querySelectorAll('.field-msg').forEach(function (n) { n.remove(); });
    document.querySelectorAll('input.invalid, select.invalid').forEach(function (n) { n.classList.remove('invalid'); n.removeAttribute('aria-invalid'); });
  }
  function showProblems(problems) {
    var first = null;
    problems.forEach(function (p) {
      var target = null, m = /^(lower|upper):(.+)$/.exec(p.field);
      if (m) target = $((m[1] === 'lower' ? 'lo-' : 'hi-') + m[2]);
      else if (p.field === 'f') target = $('f');
      else if (p.field === 'order') target = $('ord');
      if (!target) return;
      target.classList.add('invalid'); target.setAttribute('aria-invalid', 'true');
      if (!first) first = target;
      if (p.field === 'f') { var c = cleanText($('f').value); showReadNote($('f-read'), c.text, null, { message: p.message, pos: p.pos, end: p.end }, c); return; }
      var host = target.closest('.limit-row') || target.parentNode;
      if (!host.querySelector('.field-msg')) host.appendChild(el('div', 'field-msg', p.message));
    });
    if (first) first.focus();
  }

  /* ───────────────────────── solving ───────────────────────── */

  function readSpec() {
    var f = readF(true);
    return {
      system: sysName(), dim: dim(), f: f === null ? $('f').value : f,
      order: orderNames().map(function (v) { return { v: v, lower: ($('lo-' + v).value || ''), upper: ($('hi-' + v).value || '') }; })
    };
  }

  function solve() {
    clearProblems();
    var out = $('out');
    out.textContent = '';
    plots = [];
    var spec = readSpec();
    out.appendChild(el('p', 'muted', 'Working…'));
    setTimeout(function () {
      out.textContent = '';
      try { render(out, spec, Multi.solve(spec, { maxMs: 5000 })); }
      catch (e) { out.textContent = ''; out.appendChild(box('bad-box', 'Something unexpected went wrong', e.message)); }
      var top = out.getBoundingClientRect().top;
      if (top > window.innerHeight * 0.75) out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 20);
  }

  /* ───────────────────────── examples ───────────────────────── */

  function buildExamples() {
    var host = $('examples');
    host.textContent = '';
    var group = null;
    Multi.EXAMPLES.filter(function (e) { return e.group === mode; }).forEach(function (ex) {
      var g = ex.system === 'cartesian' ? 'Cartesian' : ex.system === 'polar' ? 'Polar' : ex.system === 'cylindrical' ? 'Cylindrical' : 'Spherical';
      if (g !== group) { host.appendChild(el('div', 'group', g)); group = g; }
      var b = el('button', 'secondary', ex.title);
      b.type = 'button';
      b.addEventListener('click', function () { applySpec(ex); solve(); });
      host.appendChild(b);
    });
  }

  function applySpec(ex) {
    var wantMode = ex.dim === 3 ? 'triple' : 'double';
    if (wantMode !== mode) selectTab(MODES.indexOf(wantMode), false);
    $('sys').value = ex.system;
    fillOrders(ex.order.map(function (o) { return o.v; }).join(','));
    $('ord').value = ex.order.map(function (o) { return o.v; }).join(',');
    typed = {};
    ex.order.forEach(function (o) { typed['lo-' + o.v] = String(o.lower); typed['hi-' + o.v] = String(o.upper); });
    buildLimits();
    $('f').value = ex.f;
    readF(true); updateFHelp(); updateSetup();
    $('ex-desc').textContent = ex.desc || '';
    ['also-size', 'also-average', 'also-centroid'].forEach(function (id) { $(id).checked = false; });
  }

  /* ───────────────────────── wiring ───────────────────────── */

  $('sys').addEventListener('change', function () { fillOrders(); buildLimits(); updateFHelp(); updateSetup(); $('out').textContent = ''; });
  $('ord').addEventListener('change', function () { buildLimits(); updateSetup(); $('out').textContent = ''; });
  $('f').addEventListener('input', function () { $('f').classList.remove('invalid'); readF(true); updateSetup(); });
  $('f').addEventListener('keydown', function (e) { if (e.key === 'Enter') solve(); });
  $('go').addEventListener('click', solve);
  $('clear').addEventListener('click', function () {
    typed = {}; $('f').value = ''; $('f-read').textContent = ''; $('f-read').className = 'parse-note';
    buildLimits(); updateSetup(); clearProblems(); plots = [];
    $('out').textContent = ''; $('ex-desc').textContent = '';
    ['also-size', 'also-average', 'also-centroid'].forEach(function (id) { $(id).checked = false; });
    $('f').focus();
  });

  setMode('double');
  applySpec(Multi.EXAMPLES.filter(function (e) { return e.id === 'triangle'; })[0]);
  if (location.hash === '#triple') selectTab(1, false);
})();
