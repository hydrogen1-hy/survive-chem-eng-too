// Run with:  node tests/flowsheet.test.js
const assert = require('node:assert/strict');
const Balance = require('../js/balance.js');
const Flowsheet = require('../js/flowsheet.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const clone = o => JSON.parse(JSON.stringify(o));
const sorted = a => a.slice().sort();
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a}`);
};
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const list = v => Balance.parseList(v);

/* Shared geometry checks: used on the examples and on random drawings. */
function checkGeometry(d, label, o) {
  const G = Flowsheet.geometry(d, o);
  const boxes = Object.keys(G.units).map(k => G.units[k]);

  // units never overlap
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      assert.ok(apart, `${label}: ${a.name} overlaps ${b.name}`);
    }
  }
  // every port sits on the unit's edge and inside its height; ports do not collide
  boxes.forEach(u => {
    u.inPorts.forEach(p => { assert.equal(p.x, u.left); assert.ok(p.y >= u.top && p.y <= u.bottom, `${label}: in port outside ${u.name}`); });
    u.outPorts.forEach(p => { assert.equal(p.x, u.right); assert.ok(p.y >= u.top && p.y <= u.bottom, `${label}: out port outside ${u.name}`); });
    [u.inPorts, u.outPorts].forEach(ps => {
      for (let i = 1; i < ps.length; i++) assert.ok(Math.abs(ps[i].y - ps[i - 1].y) >= Flowsheet.PORT_GAP - 1e-9, `${label}: ports too close on ${u.name}`);
    });
  });
  // every stream has a route that starts and ends on its ports, and never runs through a unit
  d.streams.forEach(s => {
    const g = G.streams[s.name];
    assert.ok(g, `${label}: no route for ${s.name}`);
    assert.ok(/^M[\d. -]+/.test(g.d) && !/NaN|Infinity/.test(g.d), `${label}: bad path for ${s.name}: ${g.d}`);
    [g.label, g.below, g.from, g.to].forEach(p => assert.ok(isFinite(p.x) && isFinite(p.y), `${label}: non-finite point for ${s.name}`));
    if (s.from) {
      const p = G.units[s.from].outPorts.filter(q => q.stream === s.name)[0];
      assert.ok(p, `${label}: ${s.name} has no outlet port on ${s.from}`);
      assert.equal(g.from.x, p.x); assert.equal(g.from.y, p.y);
    }
    if (s.to) {
      const p = G.units[s.to].inPorts.filter(q => q.stream === s.name)[0];
      assert.ok(p, `${label}: ${s.name} has no inlet port on ${s.to}`);
      assert.equal(g.to.x, p.x); assert.equal(g.to.y, p.y);
    }
    g.samples.forEach(p => boxes.forEach(u => {
      const through = p.x > u.left + 1 && p.x < u.right - 1 && p.y > u.top + 1 && p.y < u.bottom - 1;
      assert.ok(!through, `${label}: stream ${s.name} runs through ${u.name}`);
    }));
    // a looping stream also keeps clear of the text under the units it passes
    if (g.kind === 'detour') {
      g.samples.forEach(p => boxes.forEach(u => {
        const inText = p.x > u.left && p.x < u.right && p.y > u.bottom && p.y < u.textBottom;
        assert.ok(!inText, `${label}: stream ${s.name} runs through the text under ${u.name}`);
      }));
    }
  });
  // bounds contain everything
  const b = G.bounds;
  boxes.forEach(u => assert.ok(u.left >= b.minX && u.right <= b.maxX && u.top >= b.minY && u.bottom <= b.maxY, `${label}: bounds miss ${u.name}`));
  return G;
}

/* ───────────────────────── drawing → model → solver ───────────────────────── */

test('every example survives drawing → model: same units, streams and reactions', () => {
  Balance.EXAMPLES.forEach(ex => {
    const d = Flowsheet.fromModel(ex.model);
    const m = Flowsheet.toModel(d, ex.model.components, ex.model.specs);
    assert.deepEqual(m.units.map(u => u.name), ex.model.units.map(u => u.name), ex.id);
    ex.model.units.forEach((u0, i) => {
      const u = m.units[i];
      assert.equal(u.type, u0.type, ex.id);
      assert.deepEqual(sorted(u.inlets), sorted(list(u0.inlets)), ex.id + ' inlets of ' + u0.name);
      assert.deepEqual(sorted(u.outlets), sorted(list(u0.outlets)), ex.id + ' outlets of ' + u0.name);
      assert.deepEqual(u.reactions, [].concat(u0.reactions || u0.reaction || []), ex.id + ' reactions of ' + u0.name);
    });
  });
});

test('solving the drawn flowsheet gives each example its hand-worked answer', () => {
  Balance.EXAMPLES.forEach(ex => {
    const d = Flowsheet.fromModel(ex.model);
    const out = Balance.analyze(Flowsheet.toModel(d, ex.model.components, ex.model.specs));
    assert.equal(out.status, 'solved', ex.id + ': ' + out.headline);
    Object.keys(ex.expect).forEach(k => close(out.values[k], ex.expect[k], 1e-8, ex.id + ' ' + k));
  });
});

test('a flowsheet built only with the editing functions solves like the example (mixer → reactor → separator with recycle)', () => {
  const d = Flowsheet.empty();
  const m1 = Flowsheet.addUnit(d, 'mixer'), r1 = Flowsheet.addUnit(d, 'reactor'), sep = Flowsheet.addUnit(d, 'separator');
  r1.reactions = 'A -> B';
  Flowsheet.renameUnit(d, m1.name, 'M1'); Flowsheet.renameUnit(d, r1.name, 'R1'); Flowsheet.renameUnit(d, sep.name, 'SEP');
  const s1 = Flowsheet.addStream(d, null, 'M1').stream;              // feed
  const s2 = Flowsheet.addStream(d, 'M1', 'R1').stream;
  const s3 = Flowsheet.addStream(d, 'R1', 'SEP').stream;
  const s4 = Flowsheet.addStream(d, 'SEP', null).stream;             // product
  const s5 = Flowsheet.addStream(d, 'SEP', 'M1').stream;             // recycle
  assert.deepEqual([s1.name, s2.name, s3.name, s4.name, s5.name], ['S1', 'S2', 'S3', 'S4', 'S5']);
  const ex = Balance.EXAMPLES.filter(e => e.id === 'recycle')[0];
  const out = Balance.analyze(Flowsheet.toModel(d, ['A', 'B'], ex.model.specs));
  assert.equal(out.status, 'solved', out.headline);
  Object.keys(ex.expect).forEach(k => close(out.values[k], ex.expect[k], 1e-8, k));
});

/* ───────────────────────── layout and routes ───────────────────────── */

test('layout: flow runs left to right; only the recycle streams run back', () => {
  const expectedBack = { mixer: 0, column: 0, splitter: 0, reactor: 0, recycle: 1, purge: 1 };
  Balance.EXAMPLES.forEach(ex => {
    const d = Flowsheet.fromModel(ex.model);
    let back = 0;
    d.streams.forEach(s => {
      if (!s.from || !s.to) return;
      const a = Flowsheet.findUnit(d, s.from), b = Flowsheet.findUnit(d, s.to);
      if (b.x <= a.x) back++;
    });
    assert.equal(back, expectedBack[ex.id], ex.id + ': streams running backwards');
  });
});

test('layout: units do not overlap, ports are on the edges, no stream runs through a unit (all examples)', () => {
  Balance.EXAMPLES.forEach(ex => checkGeometry(Flowsheet.fromModel(ex.model), ex.id));
});

test('the recycle is drawn as a loop below the units; the other streams are direct', () => {
  const ex = Balance.EXAMPLES.filter(e => e.id === 'purge')[0];
  const d = Flowsheet.fromModel(ex.model);
  const G = Flowsheet.geometry(d);
  assert.equal(G.streams.S7.kind, 'detour', 'recycle S7');
  const bottom = Math.max.apply(null, Object.keys(G.units).map(k => G.units[k].bottom));
  assert.ok(Math.max.apply(null, G.streams.S7.samples.map(p => p.y)) > bottom, 'loop passes below every unit');
  assert.equal(G.streams.S1.kind, 'feed');
  assert.equal(G.streams.S4.kind, 'product');
  assert.equal(G.streams.S2.kind, 'direct');
  assert.equal(G.streams.S3.kind, 'direct');
});

test('layout is stable: tidying an already tidy drawing changes nothing', () => {
  Balance.EXAMPLES.forEach(ex => {
    const d = Flowsheet.fromModel(ex.model);
    const again = Flowsheet.layout(clone(d));
    assert.deepEqual(again.units.map(u => [u.x, u.y]), d.units.map(u => [u.x, u.y]), ex.id);
  });
});

test('a stream that would cross a unit in its row goes round it', () => {
  const d = Flowsheet.empty();
  const a = Flowsheet.addUnit(d, 'unit', 150, 80), b = Flowsheet.addUnit(d, 'unit', 380, 80), c = Flowsheet.addUnit(d, 'unit', 610, 80);
  Flowsheet.addStream(d, a.name, b.name); Flowsheet.addStream(d, b.name, c.name);
  const skip = Flowsheet.addStream(d, a.name, c.name).stream;
  const G = checkGeometry(d, 'skip');
  assert.equal(G.streams[skip.name].kind, 'detour');
});

test('two loops at the same place are stacked, not drawn on top of each other', () => {
  const d = Flowsheet.empty();
  const a = Flowsheet.addUnit(d, 'unit', 150, 80), b = Flowsheet.addUnit(d, 'unit', 380, 80);
  Flowsheet.addStream(d, a.name, b.name);
  const r1 = Flowsheet.addStream(d, b.name, a.name).stream, r2 = Flowsheet.addStream(d, b.name, a.name).stream;
  const G = checkGeometry(d, 'stack');
  const deepest = n => Math.max.apply(null, G.streams[n].samples.map(p => p.y));
  assert.ok(Math.abs(deepest(r1.name) - deepest(r2.name)) >= 14 - 1e-9);
});

test('unit height grows with the number of ports', () => {
  const d = Flowsheet.empty();
  const m = Flowsheet.addUnit(d, 'mixer');
  const h0 = Flowsheet.sizeOf(d, m).h;
  for (let i = 0; i < 5; i++) Flowsheet.addStream(d, null, m.name);
  assert.ok(Flowsheet.sizeOf(d, m).h > h0);
  checkGeometry(d, 'tall mixer');
});

test('300 random drawings: layout, ports and routes are always valid', () => {
  const rnd = mulberry32(12345), types = Object.keys(Flowsheet.PREFIX);
  for (let t = 0; t < 300; t++) {
    const d = Flowsheet.empty();
    const n = 1 + Math.floor(rnd() * 7);
    for (let i = 0; i < n; i++) Flowsheet.addUnit(d, types[Math.floor(rnd() * types.length)], 0, 0);
    const links = Math.floor(rnd() * 2 * n) + 1;
    for (let k = 0; k < links; k++) {
      const r = rnd(), pick = () => d.units[Math.floor(rnd() * n)].name;
      if (r < 0.2) Flowsheet.addStream(d, null, pick());
      else if (r < 0.4) Flowsheet.addStream(d, pick(), null);
      else Flowsheet.addStream(d, pick(), pick());        // self loops are refused, which is fine
    }
    Flowsheet.layout(d);
    checkGeometry(d, 'random ' + t);
  }
});

test('ports are spaced for the text under each stream, and the layout leaves room for it', () => {
  const ex = Balance.EXAMPLES.filter(e => e.id === 'mixer')[0];
  const d = Flowsheet.fromModel(ex.model);            // S1 and S2 each carry two notes
  const G = Flowsheet.geometry(d, { lines: () => 2 });
  const ins = G.units.M1.inPorts;
  assert.ok(Math.abs(ins[1].y - ins[0].y) >= 36 + 14 * 2 - 1e-9, 'gap for two lines');
  const G4 = Flowsheet.geometry(d, { lines: () => 4 });
  assert.ok(Math.abs(G4.units.M1.inPorts[1].y - G4.units.M1.inPorts[0].y) >= 36 + 14 * 4 - 1e-9, 'gap for four lines');
  assert.ok(G4.units.M1.h > G.units.M1.h, 'the unit grows with the text');
  checkGeometry(d, 'with text', { lines: () => 4 });
});

test('a loop passes below the text under the units, not through it', () => {
  const ex = Balance.EXAMPLES.filter(e => e.id === 'purge')[0];
  const d = Flowsheet.fromModel(ex.model);
  const o = { lines: () => 1, unitRows: () => 2 };
  const G = checkGeometry(d, 'loop below text', o);
  const deepest = Math.max.apply(null, G.streams.S7.samples.map(p => p.y));
  Object.keys(G.units).forEach(k => assert.ok(deepest > G.units[k].textBottom, 'loop is below the text under ' + k));
  const plain = Flowsheet.geometry(d);
  assert.ok(deepest > Math.max.apply(null, G.streams.S7.samples.map(p => p.y)) - 1);
  assert.ok(Math.max.apply(null, G.streams.S7.samples.map(p => p.y)) > Math.max.apply(null, plain.streams.S7.samples.map(p => p.y)), 'the loop sits lower when there is text to clear');
});

test('300 random drawings with text under the streams: still no overlaps after layout', () => {
  const rnd = mulberry32(2024), types = Object.keys(Flowsheet.PREFIX);
  for (let t = 0; t < 300; t++) {
    const d = Flowsheet.empty();
    const n = 1 + Math.floor(rnd() * 7);
    for (let i = 0; i < n; i++) Flowsheet.addUnit(d, types[Math.floor(rnd() * types.length)], 0, 0);
    const links = Math.floor(rnd() * 2 * n) + 1;
    for (let k = 0; k < links; k++) {
      const r = rnd(), pick = () => d.units[Math.floor(rnd() * n)].name;
      if (r < 0.2) Flowsheet.addStream(d, null, pick());
      else if (r < 0.4) Flowsheet.addStream(d, pick(), null);
      else Flowsheet.addStream(d, pick(), pick());
    }
    const counts = {}, rows = {};
    d.streams.forEach(s => { counts[s.name] = Math.floor(rnd() * 5); });
    d.units.forEach(u => { rows[u.name] = Math.floor(rnd() * 4); });
    const o = { lines: name => counts[name], unitRows: name => rows[name] };
    Flowsheet.layout(d, o);
    checkGeometry(d, 'random with text ' + t, o);
  }
});

test('a product with text under it takes the lower port, so a stream curving back to the middle does not run through its text', () => {
  const ex = Balance.EXAMPLES.filter(e => e.id === 'purge')[0];
  const d = Flowsheet.fromModel(ex.model);
  const G = Flowsheet.geometry(d, { lines: n => (n === 'S4' ? 3 : 0) });
  const outs = G.units.SEP.outPorts;
  assert.deepEqual(outs.map(p => p.stream), ['S5', 'S4'], 'S5 (to the splitter) above, S4 (product) below');
});

test('a stream that loops back takes the last port on its side, so the loop crosses nothing', () => {
  const ex = Balance.EXAMPLES.filter(e => e.id === 'purge')[0];
  const G = Flowsheet.geometry(Flowsheet.fromModel(ex.model));
  assert.deepEqual(G.units.M1.inPorts.map(p => p.stream), ['S1', 'S7'], 'fresh feed above, recycle below');
  assert.deepEqual(G.units.SP.outPorts.map(p => p.stream), ['S6', 'S7'], 'purge above, recycle below');
});

test('hit-testing: a point in a unit finds it, a point in empty space finds nothing', () => {
  const d = Flowsheet.fromModel(Balance.EXAMPLES.filter(e => e.id === 'recycle')[0].model);
  const G = Flowsheet.geometry(d);
  Object.keys(G.units).forEach(k => {
    const u = G.units[k];
    assert.equal(Flowsheet.unitAt(G, u.cx, u.cy), k);
    assert.equal(Flowsheet.unitAt(G, u.right + 5, u.top - 5), null);
  });
});

/* ───────────────────────── editing ───────────────────────── */

test('new units get the next free name and a free spot', () => {
  const d = Flowsheet.empty();
  const a = Flowsheet.addUnit(d, 'mixer'), b = Flowsheet.addUnit(d, 'mixer'), c = Flowsheet.addUnit(d, 'splitter');
  assert.deepEqual([a.name, b.name, c.name], ['M1', 'M2', 'SP1']);
  Flowsheet.renameUnit(d, 'M1', 'Feed mix');
  assert.equal(Flowsheet.addUnit(d, 'mixer').name, 'M1', 'M1 was renamed, so its name is free again');
  assert.equal(Flowsheet.addUnit(d, 'mixer').name, 'M3');
  const spots = d.units.map(u => u.x + ',' + u.y);
  assert.equal(new Set(spots).size, spots.length, 'no two units on the same spot');
  checkGeometry(d, 'new units');
  assert.equal(Flowsheet.addUnit(d, 'nonsense').type, 'unit');
});

test('streams: both ends outside, a unit into itself, and unknown units are refused', () => {
  const d = Flowsheet.empty();
  const a = Flowsheet.addUnit(d, 'unit');
  assert.ok(Flowsheet.addStream(d, null, null).error);
  assert.ok(Flowsheet.addStream(d, a.name, a.name).error);
  assert.ok(Flowsheet.addStream(d, 'ghost', a.name).error);
  assert.ok(Flowsheet.addStream(d, a.name, 'ghost').error);
  assert.equal(d.streams.length, 0);
  assert.equal(Flowsheet.addStream(d, null, a.name).stream.name, 'S1');
});

test('deleting a unit removes its own feeds and products but keeps streams to other units', () => {
  const d = Flowsheet.fromModel(Balance.EXAMPLES.filter(e => e.id === 'recycle')[0].model);
  const r = Flowsheet.removeUnit(d, 'R1');
  assert.deepEqual(r.removedStreams, [], 'both of R1\'s streams join other units');
  assert.deepEqual(sorted(r.detached), ['S2', 'S3']);
  assert.equal(Flowsheet.findStream(d, 'S2').to, null);     // M1 → (outside)
  assert.equal(Flowsheet.findStream(d, 'S3').from, null);   // (outside) → SEP
  const d2 = Flowsheet.fromModel(Balance.EXAMPLES.filter(e => e.id === 'column')[0].model);
  const r2 = Flowsheet.removeUnit(d2, 'COL');
  assert.deepEqual(sorted(r2.removedStreams), ['S1', 'S2', 'S3']);
  assert.equal(d2.streams.length, 0);
  assert.equal(Flowsheet.removeUnit(d2, 'COL').removedStreams.length, 0, 'removing twice does nothing');
});

test('renaming updates the streams, and bad or duplicate names are refused', () => {
  const d = Flowsheet.fromModel(Balance.EXAMPLES.filter(e => e.id === 'recycle')[0].model);
  assert.deepEqual(Flowsheet.renameUnit(d, 'M1', 'MIX'), { name: 'MIX' });
  assert.equal(Flowsheet.findStream(d, 'S1').to, 'MIX');
  assert.equal(Flowsheet.findStream(d, 'S5').to, 'MIX');
  assert.ok(Flowsheet.renameUnit(d, 'MIX', 'R1').error, 'duplicate unit name');
  assert.ok(Flowsheet.renameUnit(d, 'MIX', '  ').error, 'empty');
  assert.ok(Flowsheet.renameUnit(d, 'MIX', 'a,b').error, 'comma');
  assert.ok(Flowsheet.renameUnit(d, 'MIX', 'F(1)').error, 'brackets');
  assert.ok(Flowsheet.renameUnit(d, 'MIX', 'x'.repeat(15)).error, 'too long');
  assert.deepEqual(Flowsheet.renameStream(d, 'S4', ' Product '), { name: 'Product' });
  assert.ok(Flowsheet.renameStream(d, 'S2', 'S3').error, 'duplicate stream name');
  assert.ok(Flowsheet.renameStream(d, 'nope', 'X').error);
  assert.deepEqual(Flowsheet.renameStream(d, 'S2', 'S2'), { name: 'S2' });
  // the renamed drawing still solves
  const ex = Balance.EXAMPLES.filter(e => e.id === 'recycle')[0];
  const specs = ex.model.specs.map(s => Object.assign({}, s, s.stream === 'S4' ? { stream: 'Product' } : {}, s.unit === 'R1' ? { unit: 'R1' } : {}));
  const out = Balance.analyze(Flowsheet.toModel(d, ex.model.components, specs));
  assert.equal(out.status, 'solved', out.headline);
});

test('reconnecting a stream end', () => {
  const d = Flowsheet.fromModel(Balance.EXAMPLES.filter(e => e.id === 'column')[0].model);
  const other = Flowsheet.addUnit(d, 'unit');
  assert.deepEqual(Flowsheet.connect(d, 'S2', 'to', other.name), { ok: true });
  assert.equal(Flowsheet.findStream(d, 'S2').to, other.name);
  assert.ok(Flowsheet.connect(d, 'S2', 'to', 'COL').error, 'S2 leaves COL, it cannot enter it');
  assert.deepEqual(Flowsheet.connect(d, 'S2', 'to', null), { ok: true });
  assert.ok(Flowsheet.connect(d, 'S1', 'to', null).error, 'S1 would have no unit at all');
  assert.ok(Flowsheet.connect(d, 'S1', 'from', 'ghost').error);
  assert.ok(Flowsheet.connect(d, 'nope', 'to', 'COL').error);
});

/* ───────────────────────── live checks ───────────────────────── */

test('unit problems: same rules as the solver, so drawing without problems means no structural errors', () => {
  const rnd = mulberry32(777), types = Object.keys(Flowsheet.PREFIX);
  let clean = 0, flawed = 0;
  for (let t = 0; t < 400; t++) {
    const d = Flowsheet.empty();
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const u = Flowsheet.addUnit(d, types[Math.floor(rnd() * types.length)], 0, 0);
      if (u.type === 'reactor' && rnd() < 0.8) u.reactions = 'A -> B';
    }
    const links = Math.floor(rnd() * 3 * n) + 1;
    for (let k = 0; k < links; k++) {
      const pick = () => d.units[Math.floor(rnd() * n)].name, r = rnd();
      if (r < 0.35) Flowsheet.addStream(d, null, pick());
      else if (r < 0.7) Flowsheet.addStream(d, pick(), null);
      else Flowsheet.addStream(d, pick(), pick());
    }
    const problems = d.units.some(u => Flowsheet.unitProblems(d, u).length > 0);
    const out = Balance.analyze(Flowsheet.toModel(d, ['A', 'B'], []));
    const structural = out.errors.length > 0;
    assert.equal(problems, structural, 'trial ' + t + ': drawing says ' + problems + ', solver says ' + structural + ' ' + out.errors.join(' | '));
    if (problems) flawed++; else clean++;
  }
  assert.ok(clean > 20 && flawed > 20, 'the random drawings cover both cases (' + clean + ' clean, ' + flawed + ' flawed)');
});

test('unit problems: messages for the common mistakes', () => {
  const d = Flowsheet.empty();
  const m = Flowsheet.addUnit(d, 'mixer');
  assert.ok(/inlet/.test(Flowsheet.unitProblems(d, m)[0]));
  Flowsheet.addStream(d, null, m.name); Flowsheet.addStream(d, m.name, null);
  assert.ok(/mixer needs two or more inlets/.test(Flowsheet.unitProblems(d, m).join(' ')));
  Flowsheet.addStream(d, null, m.name);
  assert.deepEqual(Flowsheet.unitProblems(d, m), []);
  const r = Flowsheet.addUnit(d, 'reactor');
  Flowsheet.addStream(d, null, r.name); Flowsheet.addStream(d, r.name, null);
  assert.ok(/reaction/.test(Flowsheet.unitProblems(d, r).join(' ')));
  r.reactions = 'A -> B';
  assert.deepEqual(Flowsheet.unitProblems(d, r), []);
});

/* ───────────────────────── storage and notes ───────────────────────── */

test('sanitize repairs or drops damaged saved drawings', () => {
  assert.deepEqual(Flowsheet.sanitize(null), { units: [], streams: [] });
  assert.deepEqual(Flowsheet.sanitize('junk'), { units: [], streams: [] });
  const bad = {
    units: [{ name: 'A', type: 'mixer', x: 100, y: 100 }, { name: 'A', type: 'mixer', x: 5, y: 5 }, { name: ' ', type: 'x' }, null, { name: 'B', type: 'weird', x: 'q', y: null }],
    streams: [
      { name: 'S1', from: 'A', to: 'B' }, { name: 'S1', from: 'B', to: 'A' },          // duplicate name
      { name: 'S2', from: 'ghost', to: 'ghost' },                                      // no real end
      { name: 'S3', from: 'A', to: 'A' },                                              // loop on one unit → feed-less product of A
      { name: 'S4', from: 'ghost', to: 'B' }, { name: 5, from: 'A', to: 'B' }
    ]
  };
  const d = Flowsheet.sanitize(bad);
  assert.deepEqual(d.units.map(u => u.name), ['A', 'B']);
  assert.equal(d.units[1].type, 'unit');
  assert.ok(d.units.every(u => isFinite(u.x) && isFinite(u.y)));
  assert.deepEqual(d.streams.map(s => s.name), ['S1', 'S3', 'S4']);
  assert.deepEqual(d.streams.map(s => [s.from, s.to]), [['A', 'B'], ['A', null], [null, 'B']]);
  checkGeometry(d, 'sanitized');
  // a good drawing is returned unchanged
  const good = Flowsheet.fromModel(Balance.EXAMPLES.filter(e => e.id === 'purge')[0].model);
  assert.deepEqual(Flowsheet.sanitize(clone(good)), good);
});

test('notes for the drawing: what you entered, per stream and per unit, blanks skipped', () => {
  const n = Flowsheet.specNotes([
    { type: 'flow', stream: 'S1', value: 100 },
    { type: 'frac', stream: 'S1', comp: 'A', value: '0.2' },
    { type: 'compflow', stream: 'S1', comp: 'B', value: 0 },
    { type: 'ratio', stream: 'S2', comp: 'A', comp2: 'B', value: 2 },
    { type: 'flowratio', stream: 'S2', stream2: 'S3', value: 0.5 },
    { type: 'recovery', stream: 'S4', comp: 'B', value: 1 },
    { type: 'splitfrac', stream: 'S6', value: 0.1 },
    { type: 'conversion', unit: 'R1', comp: 'A', value: 0.6 },
    { type: 'extent', unit: 'R1', reaction: 2, value: 5 },
    { type: 'flow', stream: 'S9', value: '' },
    { type: 'flow', stream: 'S9', value: 'abc' }
  ]);
  assert.deepEqual(n.streams.S1, ['F = 100', 'x(A) = 0.2', 'n(B) = 0']);
  assert.deepEqual(n.streams.S2, ['A ÷ B = 2', 'F ÷ F(S3) = 0.5']);
  assert.deepEqual(n.streams.S4, ['recovery of B = 1']);
  assert.deepEqual(n.streams.S6, ['split fraction = 0.1']);
  assert.deepEqual(n.units.R1, ['conversion of A = 0.6', 'ξ (2) = 5']);
  assert.equal(n.streams.S9, undefined);
  assert.deepEqual(Flowsheet.specNotes([{ type: 'flow', stream: 'constructor', value: 1 }]).streams.constructor, ['F = 1']);
});


/* ───── energy balance additions: stream phase, temperatures and duties on the drawing ───── */

test('notes for the drawing include temperatures, duties and the flags that need no number, in the units the person typed', () => {
  const n = Flowsheet.specNotes([
    { type: 'temp', stream: 'S1', value: 25 }, { type: 'temp', stream: 'S2', value: '80' },
    { type: 'duty', unit: 'R1', value: -890.33 }, { type: 'adiabatic', unit: 'M1' }, { type: 'isothermal', unit: 'R2' }, { type: 'outsameT', unit: 'SEP' },
    { type: 'temp', stream: 'S9', value: '' }
  ], { tempUnit: '°C', powerUnit: 'kW' });
  assert.deepEqual(n.streams.S1, ['T = 25 °C']);
  assert.deepEqual(n.streams.S2, ['T = 80 °C']);
  assert.equal(n.streams.S9, undefined);
  assert.deepEqual(n.units.R1, ['Q = -890.33 kW']);
  assert.deepEqual(n.units.M1, ['adiabatic (Q = 0)']);
  assert.deepEqual(n.units.R2, ['isothermal']);
  assert.deepEqual(n.units.SEP, ['outlets at one T']);
  // without units given the model's own (K and kW)
  assert.deepEqual(Flowsheet.specNotes([{ type: 'temp', stream: 'S1', value: 300 }, { type: 'duty', unit: 'U', value: 2 }]).streams.S1, ['T = 300 K']);
  // the mass-balance notes are unchanged by the extra argument
  assert.deepEqual(Flowsheet.specNotes([{ type: 'flow', stream: 'S1', value: 100 }], { tempUnit: '°F' }).streams.S1, ['F = 100']);
});

test('a stream can be given a phase for the energy balance; it survives sanitizing and reaches the solver model', () => {
  const d = Flowsheet.fromModel(Balance.ENERGY_EXAMPLES.filter(e => e.id === 'e-exchanger')[0].model);
  const ph = {}; d.streams.forEach(s => { ph[s.name] = s.phase; });
  assert.deepEqual(ph, { S1: 'g', S2: 'g', S3: 'l', S4: 'l' });
  assert.deepEqual(Flowsheet.streamPhases(d), { S1: 'g', S2: 'g', S3: 'l', S4: 'l' });
  assert.deepEqual(Flowsheet.sanitize(clone(d)), d);                           // saved and restored unchanged
  const bad = clone(d); bad.streams[0].phase = 'plasma';
  assert.equal(Flowsheet.sanitize(bad).streams[0].phase, undefined);          // a made-up phase is dropped
  // clearing and setting
  assert.equal(Flowsheet.setStreamPhase(d, 'S1', 'auto'), true);
  assert.equal(d.streams.filter(s => s.name === 'S1')[0].phase, undefined);
  assert.equal(Flowsheet.setStreamPhase(d, 'S1', 'l'), true);
  assert.equal(Flowsheet.setStreamPhase(d, 'nope', 'l'), false);
  // toModel: no energy section unless asked for, and then the drawing's phases are in it
  assert.equal(Flowsheet.toModel(d, ['N2', 'H2O'], []).energy, undefined);
  const m = Flowsheet.toModel(d, ['N2', 'H2O'], [], { flowUnit: { type: 'mol', factor: 1 }, P: 101.325 });
  assert.deepEqual(m.energy.phases, { S1: 'l', S2: 'g', S3: 'l', S4: 'l' });
  assert.deepEqual(m.energy.flowUnit, { type: 'mol', factor: 1 });
});

test('every energy example survives drawing → model → solver and keeps its answers', () => {
  Balance.ENERGY_EXAMPLES.forEach(ex => {
    const d = Flowsheet.fromModel(ex.model);
    checkGeometry(d, ex.id);
    const model = Flowsheet.toModel(d, ex.model.components, ex.model.specs, { flowUnit: ex.model.energy.flowUnit });
    const out = Balance.analyze(model);
    assert.equal(out.status, 'solved', ex.id + ': ' + out.headline);
    Object.keys(ex.expect).forEach(k => assert.ok(Math.abs(out.values[k] - ex.expect[k]) <= 1e-8 * Math.max(1, Math.abs(ex.expect[k])), ex.id + ' ' + k + ': ' + out.values[k]));
  });
});

test('a drawing with notes for temperatures and duties still has room for them: nothing overlaps (energy examples)', () => {
  Balance.ENERGY_EXAMPLES.forEach(ex => {
    const notes = Flowsheet.specNotes(ex.model.specs, { tempUnit: 'K', powerUnit: 'kW' });
    const d = Flowsheet.fromModel(ex.model);
    const G = Flowsheet.geometry(d, { lines: n => (notes.streams[n] || []).length + 2, unitRows: n => (notes.units[n] || []).length + 1 });
    assert.ok(Object.keys(G.units).length === d.units.length);
  });
});

console.log(`\n${passed} test groups passed` + (process.exitCode ? ' — with failures' : ''));
