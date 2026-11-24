/*
 * The flowsheet drawing as plain data, with no DOM code.
 *
 * A drawing is   { units: [{ name, type, x, y, reactions }],  streams: [{ name, from, to }] }
 *   - x, y is the centre of the unit on the canvas.
 *   - A stream goes from a unit (from) to a unit (to). If "from" is null it is a feed coming
 *     from outside; if "to" is null it is a product leaving the flowsheet.
 *
 * This file does everything about the drawing that is not pixels-on-screen:
 *   editing (add / remove / rename / reconnect), conversion to the model that Balance.analyze
 *   solves (toModel) and back (fromModel, used for the examples), automatic layout, the position
 *   of every port and the route of every stream (geometry), hit-testing, and live checks on
 *   each unit. The page only draws what geometry() returns and calls these functions.
 *
 * Works in the browser (window.Flowsheet) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Flowsheet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFIX = { mixer: 'M', splitter: 'SP', separator: 'SEP', reactor: 'R', unit: 'U' };
  const PHASES = ['g', 'l', 's'];                    // a stream may be given a phase for the energy balance; none means "from its temperature"

  const W = 112;          // width of every unit
  const MIN_H = 64;       // height of a unit with one or two ports on a side
  const PORT_GAP = 26;    // vertical distance between neighbouring ports
  const FREE_LEN = 100;   // length of a feed or product arrow
  const LOOP = 22;        // how far a detour leaves a unit before it turns
  const COL_W = 224, ROW_H = 130, X0 = 170, Y0 = 80;   // automatic layout grid
  const MIN_X = W / 2 + FREE_LEN + 4;                  // furthest left a unit may sit, so its feeds stay on the canvas

  const clone = o => JSON.parse(JSON.stringify(o));
  const num = x => String(Number(Number(x).toPrecision(6)));
  const isNum = v => v !== '' && v !== null && v !== undefined && isFinite(Number(v));

  // S2 before S10
  function naturalCompare(a, b) {
    const ra = a.match(/\d+|\D+/g) || [], rb = b.match(/\d+|\D+/g) || [];
    for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
      if (ra[i] === rb[i]) continue;
      if (/^\d/.test(ra[i]) && /^\d/.test(rb[i])) return Number(ra[i]) - Number(rb[i]);
      return ra[i] < rb[i] ? -1 : 1;
    }
    return ra.length - rb.length;
  }
  const parseList = s => (Array.isArray(s) ? s : String(s === undefined || s === null ? '' : s).split(/[,;\n]+/))
    .map(t => String(t).trim()).filter(Boolean);
  const splitReactions = t => String(t === undefined || t === null ? '' : t).split(/[;\n]+/).map(x => x.trim()).filter(Boolean);

  /* ───────────────────────── the drawing ───────────────────────── */

  const empty = () => ({ units: [], streams: [] });
  const findUnit = (d, name) => d.units.filter(u => u.name === name)[0] || null;
  const findStream = (d, name) => d.streams.filter(s => s.name === name)[0] || null;

  function nextName(prefix, taken) {
    let i = 1;
    while (taken.indexOf(prefix + i) >= 0) i++;
    return prefix + i;
  }

  // Names end up inside equations such as F(S1), so keep them simple.
  function checkName(raw) {
    const n = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!n) return { error: 'The name cannot be empty.' };
    if (n.length > 14) return { error: 'Use a name of 14 characters or fewer.' };
    if (/[,;()=\n\t]/.test(n)) return { error: 'A name cannot contain commas, semicolons, brackets or "=".' };
    return { name: n };
  }

  /*
   * Ports on one side of a unit are spaced so the labels under neighbouring streams do not collide.
   * o.lines(streamName) says how many lines of text sit under a stream (besides its name).
   */
  function sideInfo(d, u, side, o) {
    const list = d.streams.filter(s => (side === 'in' ? s.to : s.from) === u.name);
    const lines = o && o.lines ? Math.max.apply(null, [0].concat(list.map(s => o.lines(s.name) || 0))) : 0;
    return { list, gap: Math.max(PORT_GAP, lines ? 36 + 14 * lines : 0) };
  }

  function sizeOf(d, u, o) {
    const a = sideInfo(d, u, 'in', o), b = sideInfo(d, u, 'out', o);
    const span = Math.max((a.list.length - 1) * a.gap, (b.list.length - 1) * b.gap, 0);
    return { w: W, h: Math.max(MIN_H, span + 64) };
  }

  // The first spot on a grid that nothing is sitting on.
  function freeSlot(d) {
    for (let row = 0; row < 60; row++) {
      for (let col = 0; col < 3; col++) {
        const x = X0 + col * COL_W, y = Y0 + row * ROW_H;
        if (!d.units.some(u => Math.abs(u.x - x) < 140 && Math.abs(u.y - y) < 100)) return { x, y };
      }
    }
    return { x: X0, y: Y0 };
  }

  function addUnit(d, type, x, y) {
    if (!PREFIX[type]) type = 'unit';
    const pos = x === undefined || y === undefined ? freeSlot(d) : { x, y };
    const u = { name: nextName(PREFIX[type], d.units.map(v => v.name)), type, x: pos.x, y: pos.y, reactions: '' };
    d.units.push(u);
    return u;
  }

  // from / to are unit names, or null for "outside the flowsheet"
  function addStream(d, from, to) {
    from = from || null; to = to || null;
    if (!from && !to) return { error: 'A stream has to start or end at a unit.' };
    if (from && !findUnit(d, from)) return { error: 'There is no unit called ' + from + '.' };
    if (to && !findUnit(d, to)) return { error: 'There is no unit called ' + to + '.' };
    if (from && from === to) return { error: 'A stream cannot leave a unit and go straight back into it. Send it through another unit.' };
    const s = { name: nextName('S', d.streams.map(v => v.name)), from, to };
    d.streams.push(s);
    return { stream: s };
  }

  // Streams that only touched the unit are removed with it; streams to or from another unit stay,
  // and become a feed or a product of that other unit.
  function removeUnit(d, name) {
    const removedStreams = [], detached = [];
    const i = d.units.findIndex(u => u.name === name);
    if (i < 0) return { removedStreams, detached };
    d.units.splice(i, 1);
    const kept = [];
    d.streams.forEach(s => {
      const touched = s.from === name || s.to === name;
      if (s.from === name) s.from = null;
      if (s.to === name) s.to = null;
      if (touched && !s.from && !s.to) removedStreams.push(s.name);
      else { kept.push(s); if (touched) detached.push(s.name); }
    });
    d.streams = kept;
    return { removedStreams, detached };
  }

  function removeStream(d, name) {
    const n = d.streams.length;
    d.streams = d.streams.filter(s => s.name !== name);
    return d.streams.length < n;
  }

  function renameUnit(d, oldName, raw) {
    const c = checkName(raw);
    if (c.error) return c;
    const u = findUnit(d, oldName);
    if (!u) return { error: 'There is no unit called ' + oldName + '.' };
    if (c.name === oldName) return { name: oldName };
    if (findUnit(d, c.name)) return { error: 'There is already a unit called ' + c.name + '.' };
    u.name = c.name;
    d.streams.forEach(s => { if (s.from === oldName) s.from = c.name; if (s.to === oldName) s.to = c.name; });
    return { name: c.name };
  }

  function renameStream(d, oldName, raw) {
    const c = checkName(raw);
    if (c.error) return c;
    const s = findStream(d, oldName);
    if (!s) return { error: 'There is no stream called ' + oldName + '.' };
    if (c.name === oldName) return { name: oldName };
    if (findStream(d, c.name)) return { error: 'There is already a stream called ' + c.name + '.' };
    s.name = c.name;
    return { name: c.name };
  }

  // Move one end of a stream. end is 'from' or 'to'; unitName null means "outside".
  function connect(d, streamName, end, unitName) {
    const s = findStream(d, streamName);
    if (!s) return { error: 'There is no stream called ' + streamName + '.' };
    if (end !== 'from' && end !== 'to') return { error: 'end must be "from" or "to".' };
    const target = unitName || null;
    const other = end === 'from' ? s.to : s.from;
    if (target && !findUnit(d, target)) return { error: 'There is no unit called ' + target + '.' };
    if (!target && !other) return { error: 'A stream has to start or end at a unit.' };
    if (target && target === other) return { error: 'A stream cannot leave a unit and go straight back into it.' };
    s[end] = target;
    return { ok: true };
  }

  // Anything wrong with a unit that can be seen without solving. The same rules Balance.analyze enforces.
  function unitProblems(d, u) {
    const nIn = d.streams.filter(s => s.to === u.name).length;
    const nOut = d.streams.filter(s => s.from === u.name).length;
    const p = [];
    if (nIn < 1) p.push('Needs at least one inlet stream.');
    if (nOut < 1) p.push('Needs at least one outlet stream.');
    if (!p.length) {
      if (u.type === 'mixer' && (nIn < 2 || nOut !== 1)) p.push('A mixer needs two or more inlets and exactly one outlet.');
      if (u.type === 'splitter' && (nIn !== 1 || nOut < 2)) p.push('A splitter needs exactly one inlet and two or more outlets.');
      if (u.type === 'separator' && nOut < 2) p.push('A separator needs two or more outlets.');
    }
    if (u.type === 'reactor' && !splitReactions(u.reactions).length) p.push('Needs a reaction, for example  A + 2 B -> C.');
    return p;
  }

  // Make a drawing safe to use after reading it back from storage.
  function sanitize(d) {
    const out = empty();
    if (!d || typeof d !== 'object') return out;
    const names = new Set();
    let needLayout = false;
    (Array.isArray(d.units) ? d.units : []).forEach(u => {
      if (!u || typeof u.name !== 'string') return;
      const name = u.name.trim();
      if (!name || names.has(name)) return;
      names.add(name);
      const ok = isNum(u.x) && isNum(u.y);
      if (!ok) needLayout = true;
      out.units.push({
        name, type: PREFIX[u.type] ? u.type : 'unit',
        x: ok ? Number(u.x) : 0, y: ok ? Number(u.y) : 0,
        reactions: typeof u.reactions === 'string' ? u.reactions : ''
      });
    });
    const used = new Set();
    (Array.isArray(d.streams) ? d.streams : []).forEach(s => {
      if (!s || typeof s.name !== 'string') return;
      const name = s.name.trim();
      if (!name || used.has(name)) return;
      const from = typeof s.from === 'string' && names.has(s.from) ? s.from : null;
      let to = typeof s.to === 'string' && names.has(s.to) ? s.to : null;
      if (from && from === to) to = null;
      if (!from && !to) return;
      used.add(name);
      const st = { name, from, to };
      if (PHASES.indexOf(s.phase) >= 0) st.phase = s.phase;          // phase for the energy balance, if one was chosen
      out.streams.push(st);
    });
    if (needLayout) layout(out);
    return out;
  }

  /* ───────────────────────── to and from the solver's model ───────────────────────── */

  // Phases chosen for streams: { S1: 'g', ... } (streams without one are left out)
  function streamPhases(d) {
    const out = {};
    d.streams.forEach(s => { if (PHASES.indexOf(s.phase) >= 0) out[s.name] = s.phase; });
    return out;
  }

  // Set (or clear, with '' or 'auto') the phase of a stream.
  function setStreamPhase(d, name, phase) {
    const s = findStream(d, name);
    if (!s) return false;
    if (PHASES.indexOf(phase) >= 0) s.phase = phase; else delete s.phase;
    return true;
  }

  // energy (optional): the settings for the energy balance; the drawing adds the phase of each stream to them.
  function toModel(d, components, specs, energy) {
    const m = toModelBase(d, components, specs);
    if (energy) m.energy = Object.assign({}, energy, { phases: streamPhases(d) });
    return m;
  }

  function toModelBase(d, components, specs) {
    return {
      components: (components || []).slice(),
      units: d.units.map(u => ({
        name: u.name, type: u.type,
        inlets: d.streams.filter(s => s.to === u.name).map(s => s.name),
        outlets: d.streams.filter(s => s.from === u.name).map(s => s.name),
        reactions: splitReactions(u.reactions)
      })),
      specs: (specs || []).map(s => Object.assign({}, s))
    };
  }

  // Draw a model (such as one of Balance.EXAMPLES) with automatic layout.
  function fromModel(model) {
    const d = empty();
    const streams = new Map();
    const get = n => { if (!streams.has(n)) streams.set(n, { name: n, from: null, to: null }); return streams.get(n); };
    (model.units || []).forEach(u0 => {
      const name = String(u0.name || '').trim();
      if (!name || findUnit(d, name)) return;
      const rx = u0.reactions !== undefined ? u0.reactions : u0.reaction;
      d.units.push({
        name, type: PREFIX[u0.type] ? u0.type : 'unit', x: 0, y: 0,
        reactions: [].concat(rx === undefined || rx === null ? [] : rx).join('; ')
      });
      parseList(u0.inlets).forEach(s => { get(s).to = name; });
      parseList(u0.outlets).forEach(s => { get(s).from = name; });
    });
    d.streams = Array.from(streams.values())
      .filter(s => s.from !== s.to || !s.from)          // a stream cannot loop on one unit
      .filter(s => s.from || s.to)
      .sort((a, b) => naturalCompare(a.name, b.name));
    const ph = model.energy && model.energy.phases;
    if (ph) d.streams.forEach(s => { if (PHASES.indexOf(ph[s.name]) >= 0) s.phase = ph[s.name]; });
    const notes = specNotes(model.specs);
    layout(d, { lines: n => (notes.streams[n] || []).length });
    return d;
  }

  /* ───────────────────────── automatic layout ───────────────────────── */

  // Flow runs left to right. A stream that points back upstream (a recycle) is drawn as a loop.
  function layout(d, o) {
    const n = d.units.length;
    if (!n) return d;
    const index = new Map(d.units.map((u, i) => [u.name, i]));
    const succ = d.units.map(() => []), pred = d.units.map(() => []);
    const hasFeed = d.units.map(() => false);
    d.streams.forEach(s => {
      const a = index.get(s.from), b = index.get(s.to);
      if (a === undefined && b !== undefined) hasFeed[b] = true;
      if (a !== undefined && b !== undefined && a !== b) { succ[a].push(b); pred[b].push(a); }
    });

    // Walk the graph from the units that take feeds first. An edge to a unit still being visited is a recycle.
    const all = d.units.map((_, i) => i);
    const byX = arr => arr.slice().sort((a, b) => (d.units[a].x || 0) - (d.units[b].x || 0) || a - b);
    const starts = byX(all.filter(i => hasFeed[i])).concat(byX(all.filter(i => !pred[i].length)), byX(all));
    const state = new Array(n).fill(0), post = [], back = new Set();
    const visit = a => {
      state[a] = 1;
      succ[a].forEach(b => { if (state[b] === 1) back.add(a + '>' + b); else if (state[b] === 0) visit(b); });
      state[a] = 2;
      post.push(a);
    };
    starts.forEach(i => { if (state[i] === 0) visit(i); });

    const layer = new Array(n).fill(0);
    post.slice().reverse().forEach(a => {
      succ[a].forEach(b => { if (!back.has(a + '>' + b)) layer[b] = Math.max(layer[b], layer[a] + 1); });
    });

    const groups = [];
    for (let l = 0; l <= Math.max.apply(null, layer); l++) groups.push([]);
    all.forEach(i => groups[layer[i]].push(i));
    const maxRows = Math.max.apply(null, groups.map(g => g.length));
    const tall = Math.max.apply(null, d.units.map(u => sizeOf(d, u, o).h));
    const rowH = Math.max(ROW_H, tall + 56);

    // Order inside a column by the average row of the units feeding it, so lines cross as little as possible.
    const row = new Array(n).fill(0);
    groups.forEach((g, l) => {
      const keyed = g.map((i, k) => {
        const ps = pred[i].filter(p => layer[p] < l && !back.has(p + '>' + i));
        return { i, k, key: ps.length ? ps.reduce((s, p) => s + row[p], 0) / ps.length : 0 };
      });
      keyed.sort((a, b) => a.key - b.key || a.k - b.k);
      keyed.forEach((o, r) => { row[o.i] = r + (maxRows - g.length) / 2; });
    });
    d.units.forEach((u, i) => { u.x = X0 + layer[i] * COL_W; u.y = Math.round(Y0 + row[i] * rowH); });
    return d;
  }

  /* ───────────────────────── geometry ───────────────────────── */

  const f1 = v => String(Math.round(v * 10) / 10);

  // A polyline with rounded corners.
  function roundedPath(points, r) {
    const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.01);
    let d = 'M' + f1(pts[0].x) + ' ' + f1(pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
      const rr = Math.min(r, l1 / 2, l2 / 2);
      d += ' L' + f1(b.x + (a.x - b.x) / l1 * rr) + ' ' + f1(b.y + (a.y - b.y) / l1 * rr) +
        ' Q' + f1(b.x) + ' ' + f1(b.y) + ' ' + f1(b.x + (c.x - b.x) / l2 * rr) + ' ' + f1(b.y + (c.y - b.y) / l2 * rr);
    }
    const last = pts[pts.length - 1];
    return d + ' L' + f1(last.x) + ' ' + f1(last.y);
  }

  function polylineSamples(pts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
      for (let k = 0; k < steps; k++) out.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function curve(p1, p2) {
    const k = Math.min(70, (p2.x - p1.x) / 2), samples = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, u = 1 - t;
      samples.push({
        x: u * u * u * p1.x + 3 * u * u * t * (p1.x + k) + 3 * u * t * t * (p2.x - k) + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p2.y
      });
    }
    const d = Math.abs(p1.y - p2.y) < 0.5
      ? 'M' + f1(p1.x) + ' ' + f1(p1.y) + ' L' + f1(p2.x) + ' ' + f1(p2.y)
      : 'M' + f1(p1.x) + ' ' + f1(p1.y) + ' C' + f1(p1.x + k) + ' ' + f1(p1.y) + ' ' + f1(p2.x - k) + ' ' + f1(p2.y) + ' ' + f1(p2.x) + ' ' + f1(p2.y);
    // text sits near the source end when the ends differ in height, so it stays level with its own port
    return { d, samples, mid: samples[Math.abs(p1.y - p2.y) < 0.5 ? 12 : 7], onLine: false };
  }

  /*
   * Where everything goes on the canvas (o.lines(stream) and o.unitRows(unit) say how many rows of text go
   * under each stream and under each unit; streams are routed to keep clear of that text). Returns
   *   units:   name → { cx, cy, w, h, left, right, top, bottom, inPorts, outPorts }   (ports: { stream, x, y })
   *   streams: name → { d (an SVG path), samples (points along it), kind, label, below, from, to }
   *            label is where the name goes; below is where the first line of text under the stream goes
   *            (further lines 14 below each other)
   *   bounds:  { minX, minY, maxX, maxY } of everything drawn
   * Inlets sit on the left edge and outlets on the right edge, in the order that keeps lines from crossing:
   * streams that loop back go last, the rest by the height of the unit at the other end, and a feed or product
   * (no unit at the other end) goes after its equals so the text under it has room.
   * A stream that would run through another unit, or run backwards, goes round it in a channel above or below.
   */
  function geometry(d, o) {
    const byName = new Map(d.units.map(u => [u.name, u]));
    const units = {};
    d.units.forEach(u => {
      const sz = sizeOf(d, u, o);
      const inSide = sideInfo(d, u, 'in', o), outSide = sideInfo(d, u, 'out', o);
      // Top to bottom: streams that loop back go last (so their loop never crosses the others), then by where
      // the other end is; among equals a feed or product, which has text under it, goes below the rest.
      const order = (list, other, backward) => list
        .map((s, i) => {
          const v = other(s) ? byName.get(other(s)) : null;
          return { s, i, back: v && backward(v) ? 1 : 0, k: v ? v.y : u.y, loose: v ? 0 : 1 };
        })
        .sort((a, b) => a.back - b.back || a.k - b.k || a.loose - b.loose || a.i - b.i)
        .map(v => v.s);
      const place = (list, x, gap) => list.map((s, i) => ({ stream: s.name, x, y: u.y + (i - (list.length - 1) / 2) * gap }));
      units[u.name] = {
        name: u.name, type: u.type, cx: u.x, cy: u.y, w: sz.w, h: sz.h,
        left: u.x - sz.w / 2, right: u.x + sz.w / 2, top: u.y - sz.h / 2, bottom: u.y + sz.h / 2,
        textBottom: u.y + sz.h / 2 + (o && o.unitRows && o.unitRows(u.name) ? 10 + 16 * o.unitRows(u.name) : 0),
        inPorts: place(order(inSide.list, s => s.from, v => u.x - v.x < W + 40), u.x - sz.w / 2, inSide.gap),
        outPorts: place(order(outSide.list, s => s.to, v => v.x - u.x < W + 40), u.x + sz.w / 2, outSide.gap)
      };
    });
    const list = Object.keys(units).map(k => units[k]);
    const inside = p => list.some(u => p.x > u.left + 1 && p.x < u.right - 1 && p.y > u.top + 1 && p.y < u.bottom - 1);

    const streams = {};
    const detours = [];
    const labelsFor = (mid, onLine) => onLine
      ? { label: { x: mid.x, y: mid.y + 4 }, below: { x: mid.x, y: mid.y + 20 } }
      : { label: { x: mid.x, y: mid.y - 9 }, below: { x: mid.x, y: mid.y + 17 } };
    const lineCount = name => (o && o.lines ? o.lines(name) || 0 : 0);

    d.streams.forEach(s => {
      const A = s.from ? units[s.from] : null, B = s.to ? units[s.to] : null;
      const p1 = A ? A.outPorts.filter(p => p.stream === s.name)[0] : null;
      const p2 = B ? B.inPorts.filter(p => p.stream === s.name)[0] : null;
      if (!A || !B) {
        const a = p1 || { x: p2.x - FREE_LEN, y: p2.y }, b = p2 || { x: p1.x + FREE_LEN, y: p1.y };
        const mid = { x: (a.x + b.x) / 2, y: a.y };
        const samples = polylineSamples([a, b]);
        streams[s.name] = Object.assign({ d: 'M' + f1(a.x) + ' ' + f1(a.y) + ' L' + f1(b.x) + ' ' + f1(b.y), samples,
          kind: !A ? 'feed' : 'product', from: a, to: b }, labelsFor(mid, false));
        return;
      }
      const forward = p2.x - p1.x >= 40;
      if (forward) {
        const c = curve(p1, p2);
        if (!c.samples.some(inside)) {
          streams[s.name] = Object.assign({ d: c.d, samples: c.samples, kind: 'direct', from: p1, to: p2 }, labelsFor(c.mid, false));
          return;
        }
      }
      detours.push({ s, p1, p2, side: forward ? 'above' : 'below' });
    });

    // Shorter detours first, so a small loop sits inside a bigger one.
    detours.sort((a, b) => Math.abs(a.p2.x - a.p1.x) - Math.abs(b.p2.x - b.p1.x));
    const taken = { above: [], below: [] };
    detours.forEach(t => {
      const xa = t.p1.x + LOOP, xb = t.p2.x - LOOP;
      const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
      const blockers = list.filter(u => u.right > lo && u.left < hi);
      const k = taken[t.side].filter(r => r.lo < hi && r.hi > lo).length;
      taken[t.side].push({ lo, hi });
      const y = t.side === 'below'
        ? Math.max.apply(null, [t.p1.y, t.p2.y].concat(blockers.map(u => u.textBottom))) + 26 + 14 * k
        : Math.min.apply(null, [t.p1.y, t.p2.y].concat(blockers.map(u => u.top))) - 26 - 14 * k;
      const pts = [t.p1, { x: xa, y: t.p1.y }, { x: xa, y }, { x: xb, y }, { x: xb, y: t.p2.y }, t.p2];
      streams[t.s.name] = Object.assign({ d: roundedPath(pts, 10), samples: polylineSamples(pts), kind: 'detour', from: t.p1, to: t.p2 },
        labelsFor({ x: (xa + xb) / 2, y }, true));
    });

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    list.forEach(u => { grow(u.left, u.top); grow(u.right, Math.max(u.bottom + 40, u.textBottom + 10)); });
    Object.keys(streams).forEach(k => {
      const st = streams[k], n = lineCount(k);
      st.samples.forEach(p => grow(p.x, p.y));
      grow(st.label.x - 40, st.label.y - 14); grow(st.label.x + 40, st.label.y + 4);
      if (n) { grow(st.below.x - 70, st.below.y - 12); grow(st.below.x + 70, st.below.y + 14 * n); }
    });
    if (!list.length) { minX = minY = 0; maxX = maxY = 0; }
    return { units, streams, bounds: { minX, minY, maxX, maxY } };
  }

  // The unit under a point (the last one drawn wins), or null.
  function unitAt(G, x, y) {
    const names = Object.keys(G.units);
    for (let i = names.length - 1; i >= 0; i--) {
      const u = G.units[names[i]];
      if (x >= u.left && x <= u.right && y >= u.top && y <= u.bottom) return u.name;
    }
    return null;
  }

  /* ───────────────────────── what you entered, as short labels for the drawing ───────────────────────── */

  // o (optional): { tempUnit, powerUnit } — the units the temperatures and duties were typed in
  function specNotes(specs, o) {
    const streams = Object.create(null), units = Object.create(null);
    const add = (map, key, text) => {
      if (key === undefined || key === null || key === '') return;
      (map[key] = map[key] || []).push(text);
    };
    const tu = o && o.tempUnit ? ' ' + o.tempUnit : ' K', pu = o && o.powerUnit ? ' ' + o.powerUnit : ' kW';
    (specs || []).forEach(sp => {
      // energy specifications that need no number
      if (sp.type === 'adiabatic') { add(units, sp.unit, 'adiabatic (Q = 0)'); return; }
      if (sp.type === 'isothermal') { add(units, sp.unit, 'isothermal'); return; }
      if (sp.type === 'outsameT') { add(units, sp.unit, 'outlets at one T'); return; }
      if (!isNum(sp.value)) return;
      const v = num(Number(sp.value));
      switch (sp.type) {
        case 'flow':       add(streams, sp.stream, 'F = ' + v); break;
        case 'compflow':   add(streams, sp.stream, 'n(' + sp.comp + ') = ' + v); break;
        case 'frac':       add(streams, sp.stream, 'x(' + sp.comp + ') = ' + v); break;
        case 'ratio':      add(streams, sp.stream, sp.comp + ' ÷ ' + sp.comp2 + ' = ' + v); break;
        case 'flowratio':  add(streams, sp.stream, 'F ÷ F(' + sp.stream2 + ') = ' + v); break;
        case 'recovery':   add(streams, sp.stream, 'recovery of ' + sp.comp + ' = ' + v); break;
        case 'splitfrac':  add(streams, sp.stream, 'split fraction = ' + v); break;
        case 'conversion': add(units, sp.unit, 'conversion of ' + sp.comp + ' = ' + v); break;
        case 'extent':     add(units, sp.unit, 'ξ' + (Number(sp.reaction) > 1 ? ' (' + sp.reaction + ')' : '') + ' = ' + v); break;
        case 'temp':       add(streams, sp.stream, 'T = ' + v + tu); break;
        case 'duty':       add(units, sp.unit, 'Q = ' + v + pu); break;
        default: break;
      }
    });
    return { streams, units };
  }

  return {
    PREFIX, W, MIN_H, PORT_GAP, FREE_LEN, MIN_X,
    empty, clone, sanitize, checkName, findUnit, findStream, sizeOf,
    addUnit, addStream, removeUnit, removeStream, renameUnit, renameStream, connect, unitProblems,
    toModel, fromModel, splitReactions, layout, geometry, unitAt, specNotes, streamPhases, setStreamPhase, PHASES
  };
});
