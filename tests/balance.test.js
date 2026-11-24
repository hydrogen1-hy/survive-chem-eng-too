// Run with:  node tests/balance.test.js
const assert = require('node:assert/strict');
const Balance = require('../js/balance.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a}`);
};
const clone = o => JSON.parse(JSON.stringify(o));
function mulberry(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const example = id => clone(Balance.EXAMPLES.find(e => e.id === id));

/* Independent check of a solved flowsheet: every balance, every stream sum and every spec,
   written without using any of the solver's own equation-building code. */
function verify(model, out) {
  assert.equal(out.status, 'solved', 'status was ' + out.status + ': ' + out.headline + ' ' + out.errors.join(' ') + ' ' + out.warnings.join(' '));
  const comps = model.components;
  const flow = (c, s) => out.streams.find(x => x.name === s).comps[c].n;
  const tot = s => out.streams.find(x => x.name === s).F;
  const list = v => Balance.parseList(v);
  const scale = Math.max(1, ...out.streams.map(s => s.F));
  const tol = 1e-8 * scale;
  out.streams.forEach(s => {
    assert.ok(s.F > -tol, `F(${s.name}) negative`);
    close(s.F, comps.reduce((a, c) => a + s.comps[c].n, 0), 1e-9, 'sum of ' + s.name);
    comps.forEach(c => assert.ok(s.comps[c].n > -tol, `n(${c},${s.name}) negative`));
  });
  model.units.forEach(u => {
    const ins = list(u.inlets), outs = list(u.outlets);
    const rxs = (u.type === 'reactor' ? [].concat(u.reactions || u.reaction) : []).map(r => Balance.parseReaction(r, comps));
    comps.forEach(c => {
      let net = 0;
      outs.forEach(s => { net += flow(c, s); });
      ins.forEach(s => { net -= flow(c, s); });
      rxs.forEach((r, k) => {
        const xi = out.values[rxs.length > 1 ? `ξ(${u.name},${k + 1})` : `ξ(${u.name})`];
        net -= (r[c] || 0) * xi;
      });
      assert.ok(Math.abs(net) < tol, `${u.name} balance on ${c} off by ${net}`);
    });
    if (u.type === 'splitter') {
      outs.forEach(s => comps.forEach(c => {
        if (tot(s) > 1e-9) close(flow(c, s) / tot(s), flow(c, ins[0]) / tot(ins[0]), 1e-9, `splitter composition ${c} ${s}`);
      }));
    }
  });
  model.specs.forEach(sp => {
    const unitOfStream = s => model.units.find(u => list(u.outlets).indexOf(s) >= 0);
    let lhs, rhs;
    switch (sp.type) {
      case 'flow': lhs = tot(sp.stream); rhs = sp.value; break;
      case 'compflow': lhs = flow(sp.comp, sp.stream); rhs = sp.value; break;
      case 'frac': lhs = flow(sp.comp, sp.stream); rhs = sp.value * tot(sp.stream); break;
      case 'ratio': lhs = flow(sp.comp, sp.stream); rhs = sp.value * flow(sp.comp2, sp.stream); break;
      case 'flowratio': lhs = tot(sp.stream); rhs = sp.value * tot(sp.stream2); break;
      case 'recovery': lhs = flow(sp.comp, sp.stream); rhs = sp.value * list(unitOfStream(sp.stream).inlets).reduce((a, s) => a + flow(sp.comp, s), 0); break;
      case 'splitfrac': lhs = tot(sp.stream); rhs = sp.value * list(unitOfStream(sp.stream).inlets).reduce((a, s) => a + tot(s), 0); break;
      case 'conversion': {
        const u = model.units.find(x => x.name === sp.unit);
        const fed = list(u.inlets).reduce((a, s) => a + flow(sp.comp, s), 0), left = list(u.outlets).reduce((a, s) => a + flow(sp.comp, s), 0);
        lhs = fed - left; rhs = sp.value * fed; break;
      }
      case 'extent': {
        const u = model.units.find(x => x.name === sp.unit);
        const many = [].concat(u.reactions || u.reaction).length > 1;
        lhs = out.values[many ? `ξ(${sp.unit},${sp.reaction || 1})` : `ξ(${sp.unit})`]; rhs = sp.value; break;
      }
      default: throw new Error('verify: unhandled spec ' + sp.type);
    }
    assert.ok(Math.abs(lhs - rhs) < tol, `spec "${Balance.specLabel(sp)}" violated: ${lhs} vs ${rhs}`);
  });
}

/* ───── reaction parsing ───── */
test('parseReaction: coefficients, arrows and species names', () => {
  const comps = ['N2', 'H2', 'NH3', 'CH4', 'O2', 'CO2', 'H2O'];
  assert.deepEqual(Balance.parseReaction('N2 + 3 H2 -> 2 NH3', comps), { N2: -1, H2: -3, NH3: 2 });
  assert.deepEqual(Balance.parseReaction('N2+3H2→2NH3', comps), { N2: -1, H2: -3, NH3: 2 });
  assert.deepEqual(Balance.parseReaction('CH4 + 2 O2 = CO2 + 2 H2O', comps), { CH4: -1, O2: -2, CO2: 1, H2O: 2 });
  assert.deepEqual(Balance.parseReaction('2H2O -> 2H2 + O2', comps), { H2O: -2, H2: 2, O2: 1 });
  assert.deepEqual(Balance.parseReaction('0.5 O2 + H2 -> H2O', comps), { O2: -0.5, H2: -1, H2O: 1 });
  assert.throws(() => Balance.parseReaction('N2 + H2', comps));
  assert.throws(() => Balance.parseReaction('N2 -> XYZ', comps));
  assert.throws(() => Balance.parseReaction('-> NH3', comps));
});

test('parseList', () => {
  assert.deepEqual(Balance.parseList(' S1, S2 ;S3\nS4 '), ['S1', 'S2', 'S3', 'S4']);
  assert.deepEqual(Balance.parseList(''), []);
});

/* ───── worked examples with hand-derived answers ───── */
Balance.EXAMPLES.forEach(ex => {
  test(`example "${ex.id}": solves, 0 degrees of freedom, matches the hand answer, all balances close`, () => {
    const out = Balance.analyze(ex.model);
    assert.equal(out.status, 'solved', out.headline + ' ' + out.errors.join(' '));
    assert.equal(out.dof.dof, 0);
    assert.equal(out.warnings.length, 0, out.warnings.join(' | '));
    Object.keys(ex.expect).forEach(k => close(out.values[k], ex.expect[k], 1e-9, k));
    verify(ex.model, out);
  });

  test(`example "${ex.id}": the step-by-step solution reproduces every value`, () => {
    const out = Balance.analyze(ex.model);
    const seen = {};
    out.givens.forEach(g => { const m = g.match(/^(.*) = (\S+)$/); seen[m[1]] = Number(m[2]); });
    out.steps.forEach(s => {
      assert.ok(s.results.length >= 1 && s.title);
      s.results.forEach(r => { assert.ok(!(r.name in seen), 'solved twice: ' + r.name); seen[r.name] = r.value; });
      if (s.type === 'single') assert.ok(s.equation && s.substituted && !/undefined|NaN/.test(s.substituted), s.substituted);
    });
    Object.keys(out.values).forEach(k => {
      assert.ok(k in seen, 'step list never finds ' + k);
      close(seen[k], out.values[k], 1e-9, k);
    });
  });

  test(`example "${ex.id}": scaling every flow by 7 scales the whole solution by 7`, () => {
    const m = clone(ex.model);
    m.specs.forEach(s => { if (s.type === 'flow' || s.type === 'compflow' || s.type === 'extent') s.value *= 7; });
    const a = Balance.analyze(ex.model), b = Balance.analyze(m);
    assert.equal(b.status, 'solved');
    Object.keys(a.values).forEach(k => close(b.values[k], 7 * a.values[k], 1e-9, k));
  });
});

test('the written solution only groups equations that really are coupled (small blocks, in the recycle loops)', () => {
  Balance.EXAMPLES.forEach(ex => {
    const out = Balance.analyze(ex.model);
    out.steps.filter(s => s.type === 'block').forEach(s => {
      assert.ok(s.equations.length <= 6, `${ex.id}: a block of ${s.equations.length} equations is too long to read: ${s.title}`);
    });
  });
  // purge: a person would use "the purge takes a tenth of every component", so the loop block is small
  const purge = Balance.analyze(example('purge').model);
  assert.ok(purge.steps.some(s => /takes 0.1 of every component/.test(s.title) || (s.equations || []).some(q => /takes 0.1 of every component/.test(q.label))));
  // and the simple recycle needs no big system at all
  assert.ok(Balance.analyze(example('recycle').model).steps.some(s => /Overall balance/.test(s.title)));
});

/* ───── degrees of freedom ───── */
test('DOF per unit and overall for the recycle flowsheet', () => {
  const out = Balance.analyze(example('recycle').model);
  const by = {}; out.units.forEach(u => { by[u.name] = u; });
  assert.deepEqual([by.M1.variables, by.M1.equations, by.M1.dof], [6, 4, 2]);
  assert.deepEqual([by.R1.variables, by.R1.equations, by.R1.dof], [5, 3, 2]);
  assert.deepEqual([by.SEP.variables, by.SEP.equations, by.SEP.dof], [6, 4, 2]);
  assert.deepEqual([out.dof.variables, out.dof.equations, out.dof.dof], [11, 11, 0]);   // 5 streams × 2 components + ξ
});

test('DOF: a splitter on its own has N + M − 1 degrees of freedom (here 2 + 2 − 1 = 3), and specs reduce it', () => {
  const m = example('splitter').model;
  m.specs = [];
  assert.equal(Balance.analyze(m).units[0].dof, 3);
  assert.equal(Balance.analyze(example('splitter').model).units[0].dof, 0);
});

test('DOF: a column with all four compositions and one flow given is exactly specified', () => {
  const out = Balance.analyze(example('column').model);
  assert.equal(out.units[0].dof, 0);
});

test('underspecified: missing one flow leaves 1 degree of freedom and reports what is still unknown', () => {
  const m = example('mixer').model;
  m.specs = m.specs.filter(s => !(s.type === 'flow' && s.stream === 'S2'));
  const out = Balance.analyze(m);
  assert.equal(out.status, 'underspecified');
  assert.equal(out.dof.dof, 1);
  assert.equal(out.values['F(S3)'], null);
  assert.ok(out.undetermined.indexOf('F(S3)') >= 0);
  close(out.values['n(Ethanol,S1)'], 20, 1e-12);          // what can be found is still found
  close(out.values['n(Water,S1)'], 80, 1e-12);
  assert.ok(/1 degree/.test(out.headline));
});

test('underspecified: the "what to specify next" list is exact — any listed quantity completes the problem, no other does', () => {
  const base = example('mixer').model;
  base.specs = base.specs.filter(s => !(s.type === 'flow' && s.stream === 'S2'));
  const out = Balance.analyze(base);
  assert.ok(out.free.indexOf('F(S2)') >= 0 && out.free.indexOf('F(S3)') >= 0 && out.free.indexOf('n(Ethanol,S3)') >= 0, out.free.join(','));
  assert.ok(out.free.indexOf('F(S1)') < 0 && out.free.indexOf('n(Water,S1)') < 0, 'F(S1) is already known');
  // giving any one listed quantity its true value solves the problem; giving an already-known quantity does not
  const truth = Balance.analyze(example('mixer').model).values;
  out.free.forEach(name => {
    const m = clone(base);
    const mm = name.match(/^n\((.*),(.*)\)$/), ff = name.match(/^F\((.*)\)$/);
    m.specs.push(mm ? { type: 'compflow', stream: mm[2], comp: mm[1], value: truth[name] } : { type: 'flow', stream: ff[1], value: truth[name] });
    assert.equal(Balance.analyze(m).status, 'solved', 'giving ' + name + ' should complete the problem');
  });
  const m2 = clone(base); m2.specs.push({ type: 'flow', stream: 'S1', value: 100 });
  assert.equal(Balance.analyze(m2).status, 'underspecified');
});

test('underspecified: two things missing leaves 2 degrees of freedom', () => {
  const m = example('mixer').model;
  m.specs = m.specs.filter(s => s.stream !== 'S2');
  const out = Balance.analyze(m);
  assert.equal(out.status, 'underspecified');
  assert.equal(out.dof.dof, 2);
});

/* ───── redundant and contradictory specifications ───── */
test('a consistent extra specification is flagged as redundant but the answer is still given', () => {
  const m = example('column').model;
  m.specs.push({ type: 'flow', stream: 'S2', value: 50 });      // agrees with the solution
  const out = Balance.analyze(m);
  assert.equal(out.status, 'solved');
  assert.equal(out.redundant.length, 1);
  assert.ok(/Redundant/.test(out.warnings[0]));
  close(out.values['F(S3)'], 50, 1e-9);
});

test('a contradictory extra specification is reported as inconsistent', () => {
  const m = example('column').model;
  m.specs.push({ type: 'flow', stream: 'S2', value: 60 });      // the other specs force 50
  const out = Balance.analyze(m);
  assert.equal(out.status, 'inconsistent');
  assert.ok(out.conflicts.length >= 1);
  assert.ok(/S2/.test(out.conflicts[0].label));
});

test('inconsistent: mixer product flow that cannot equal the sum of the feeds', () => {
  const m = example('mixer').model;
  m.specs.push({ type: 'flow', stream: 'S3', value: 200 });
  assert.equal(Balance.analyze(m).status, 'inconsistent');
});

test('inconsistent is also found when the problem is underspecified overall', () => {
  const m = example('mixer').model;
  m.specs = m.specs.filter(s => !(s.stream === 'S2' && s.type === 'frac'));
  m.specs.push({ type: 'flow', stream: 'S3', value: 999 });
  assert.equal(Balance.analyze(m).status, 'inconsistent');
});

test('negative flows are warned about', () => {
  const m = { components: ['A', 'B'], units: [{ name: 'U', type: 'separator', inlets: 'S1', outlets: 'S2, S3' }],
    specs: [{ type: 'flow', stream: 'S1', value: 100 }, { type: 'frac', stream: 'S1', comp: 'A', value: 0.5 },
            { type: 'flow', stream: 'S2', value: 60 }, { type: 'frac', stream: 'S2', comp: 'A', value: 0.95 }] };
  const out = Balance.analyze(m);
  assert.ok(out.warnings.some(w => /negative/.test(w)), out.warnings.join('|') + out.status);
  close(out.values['n(A,S3)'], -7, 1e-9);
});

/* ───── input validation gives readable messages ───── */
function errorsFor(mutate) {
  const m = example('mixer').model; mutate(m);
  const out = Balance.analyze(m);
  assert.equal(out.status, 'error');
  return out.errors.join(' | ');
}
test('validation messages', () => {
  assert.ok(/not a stream/.test(errorsFor(m => m.specs.push({ type: 'flow', stream: 'S9', value: 1 }))));
  assert.ok(/not one of the components/.test(errorsFor(m => m.specs.push({ type: 'frac', stream: 'S1', comp: 'Gold', value: 0.1 }))));
  assert.ok(/not a number/.test(errorsFor(m => m.specs.push({ type: 'flow', stream: 'S1', value: '' }))));
  assert.ok(/between 0 and 1/.test(errorsFor(m => m.specs.push({ type: 'frac', stream: 'S1', comp: 'Water', value: 1.5 }))));
  assert.ok(/cannot be negative/.test(errorsFor(m => m.specs.push({ type: 'flow', stream: 'S1', value: -5 }))));
  assert.ok(/at least one component/.test(errorsFor(m => { m.components = []; })));
  assert.ok(/two or more inlets/.test(errorsFor(m => { m.units[0].inlets = 'S1'; })));
  assert.ok(/both M1 and M2/.test(errorsFor(m => m.units.push({ name: 'M2', type: 'mixer', inlets: 'S1, S7', outlets: 'S8' }))));
  assert.ok(/Two units/.test(errorsFor(m => m.units.push({ name: 'M1', type: 'unit', inlets: 'S3', outlets: 'S4' }))));
  assert.ok(/needs a reaction/.test(errorsFor(m => m.units.push({ name: 'R', type: 'reactor', inlets: 'S3', outlets: 'S4' }))));
  assert.ok(/add up to/.test(errorsFor(m => { m.specs.push({ type: 'frac', stream: 'S1', comp: 'Water', value: 0.5 }); })));
  assert.ok(/feed stream/.test(errorsFor(m => m.specs.push({ type: 'recovery', stream: 'S1', comp: 'Water', value: 0.5 }))));
});

/* ───── multiple reactions in one reactor ───── */
test('two reactions in one reactor: A → B, B → C with given extents', () => {
  const m = {
    components: ['A', 'B', 'C'],
    units: [{ name: 'R1', type: 'reactor', inlets: 'S1', outlets: 'S2', reactions: ['A -> B', 'B -> C'] }],
    specs: [
      { type: 'compflow', stream: 'S1', comp: 'A', value: 100 }, { type: 'compflow', stream: 'S1', comp: 'B', value: 0 },
      { type: 'compflow', stream: 'S1', comp: 'C', value: 0 },
      { type: 'extent', unit: 'R1', reaction: 1, value: 60 }, { type: 'extent', unit: 'R1', reaction: 2, value: 20 }
    ]
  };
  const out = Balance.analyze(m);
  verify(m, out);
  close(out.values['n(A,S2)'], 40, 1e-12); close(out.values['n(B,S2)'], 40, 1e-12); close(out.values['n(C,S2)'], 20, 1e-12);
  assert.ok('ξ(R1,1)' in out.values && 'ξ(R1,2)' in out.values);
});

test('reactor with conversion specified instead: A → 2B, two feeds into one reactor', () => {
  const m = {
    components: ['A', 'B'],
    units: [{ name: 'R1', type: 'reactor', inlets: 'S1, S2', outlets: 'S3', reaction: 'A -> 2 B' }],
    specs: [
      { type: 'compflow', stream: 'S1', comp: 'A', value: 30 }, { type: 'compflow', stream: 'S1', comp: 'B', value: 0 },
      { type: 'compflow', stream: 'S2', comp: 'A', value: 70 }, { type: 'compflow', stream: 'S2', comp: 'B', value: 10 },
      { type: 'conversion', unit: 'R1', comp: 'A', value: 0.9 }
    ]
  };
  const out = Balance.analyze(m);
  verify(m, out);
  close(out.values['ξ(R1)'], 90, 1e-12); close(out.values['n(B,S3)'], 190, 1e-12);
});

/* ───── genuinely nonlinear case: splitter with composition unknown until both outlets are known ───── */
test('splitter where only outlet information is given (product of unknowns, solved by Newton)', () => {
  const m = {
    components: ['A', 'B'],
    units: [{ name: 'SP', type: 'splitter', inlets: 'S1', outlets: 'S2, S3' }],
    specs: [
      { type: 'flow', stream: 'S2', value: 40 }, { type: 'compflow', stream: 'S2', comp: 'A', value: 12 },
      { type: 'flow', stream: 'S3', value: 60 }
    ]
  };
  const out = Balance.analyze(m);
  verify(m, out);
  close(out.values['F(S1)'], 100, 1e-9); close(out.values['n(A,S1)'], 30, 1e-9); close(out.values['n(A,S3)'], 18, 1e-9);
});

/* ───── randomised flowsheets: mixer → reactor → separator → splitter ───── */
test('300 random flowsheets: solved, 0 DOF, and every balance and specification independently satisfied', () => {
  let seed = 20240607;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const r = (a, b) => a + (b - a) * rnd();
  for (let t = 0; t < 300; t++) {
    const withSplitter = rnd() < 0.6;
    const m = {
      components: ['A', 'B', 'C'],
      units: [
        { name: 'M', type: 'mixer', inlets: 'F1, F2', outlets: 'X1' },
        { name: 'R', type: 'reactor', inlets: 'X1', outlets: 'X2', reaction: 'A -> 2 B' },
        { name: 'SEP', type: 'separator', inlets: 'X2', outlets: withSplitter ? 'T1, P2' : 'P1, P2' }
      ],
      specs: []
    };
    const feedSpecs = (s) => {
      const a = r(0.1, 0.6), b = r(0.1, 0.9 - a);
      m.specs.push({ type: 'flow', stream: s, value: r(20, 500) }, { type: 'frac', stream: s, comp: 'A', value: a }, { type: 'frac', stream: s, comp: 'B', value: b });
    };
    feedSpecs('F1'); feedSpecs('F2');
    m.specs.push({ type: 'conversion', unit: 'R', comp: 'A', value: r(0.1, 0.95) });
    const top = withSplitter ? 'T1' : 'P1';
    ['A', 'B', 'C'].forEach(c => m.specs.push({ type: 'recovery', stream: top, comp: c, value: r(0.05, 0.95) }));
    if (withSplitter) {
      m.units.push({ name: 'SP', type: 'splitter', inlets: 'T1', outlets: 'P1, RC' });
      m.specs.push({ type: 'splitfrac', stream: 'RC', value: r(0.1, 0.9) });
    }
    const out = Balance.analyze(m);
    assert.equal(out.dof.dof, 0, 'trial ' + t);
    verify(m, out);
  }
});


/* ═════════════════════════ ENERGY BALANCES ON THE FLOWSHEET ═════════════════════════ */
// The energy part is optional: a model without an `energy` section is solved exactly as before (all the tests above).
// Unknowns added by it: T(stream) in K and Q(unit) in kW (heat added). One energy balance per unit: Σ H(out) − Σ H(in) = Q.

const Energy = require('../js/energy.js');
const SPd = Energy.SPECIES;

/* independent arithmetic: Simpson's rule on the raw Cp coefficients (exact for a cubic), no use of the library's own integration */
const cpRaw = (c, T) => { const u = c.Tunit === 'K' ? T : T - 273.15; return c.a + c.b * u + c.c * u * u + c.d * u * u * u; };
function integE(c, T1, T2) {
  const n = 20, h = (T2 - T1) / n;
  let a = cpRaw(c, T1) + cpRaw(c, T2);
  for (let i = 1; i < n; i++) a += cpRaw(c, T1 + i * h) * (i % 2 ? 4 : 2);
  return a * h / 3 / 1000;
}
/* enthalpy of one mole in kJ/mol: from the species at 25 °C in its standard phase (formation = false) or from the elements (true);
   the path from the standard phase to `phase` goes through the normal boiling point */
function hRef(id, T, phase, formation) {
  const sp = SPd[id], ref = sp.std;
  const h0 = formation ? sp.Hf[ref] : 0;
  if (ref === phase) return h0 + integE(sp.Cp[ref], 298.15, T);
  if (ref === 'l' && phase === 'g') return h0 + integE(sp.Cp.l, 298.15, sp.Tb) + sp.Hvap + integE(sp.Cp.g, sp.Tb, T);
  if (ref === 'g' && phase === 'l') return h0 + integE(sp.Cp.g, 298.15, sp.Tb) - sp.Hvap + integE(sp.Cp.l, sp.Tb, T);
  throw new Error('test helper: no path ' + id + ' ' + ref + '→' + phase);
}
const autoPh = (id, T) => (SPd[id].Tb === null ? SPd[id].std : (T >= SPd[id].Tb ? 'g' : 'l'));

/* Independent check of a solved flowsheet with energy: every unit's energy balance and the overall one, written with separate code. */
function verifyEnergy(model, out) {
  assert.equal(out.status, 'solved', out.headline + ' ' + out.errors.join(' '));
  const en = model.energy, comps = model.components;
  const idOf = c => (en.species && en.species[c]) || c;
  const kc = c => (en.flowUnit && en.flowUnit.type === 'mass' ? en.flowUnit.factor * 1000 / SPd[idOf(c)].M : (en.flowUnit ? en.flowUnit.factor : 1));
  const formation = model.units.some(u => [].concat(u.reactions || u.reaction || []).filter(Boolean).length > 0);
  const st = s => out.streams.find(x => x.name === s);
  const H = s => {
    let tot = 0;
    comps.forEach(c => {
      const n = st(s).comps[c].n;
      if (n > 1e-12) tot += kc(c) * n * hRef(idOf(c), st(s).T, (en.phases && en.phases[s]) || autoPh(idOf(c), st(s).T), formation);
    });
    return tot;
  };
  let scale = 1, sumQ = 0;
  model.units.forEach(u => {
    const ins = Balance.parseList(u.inlets), outs = Balance.parseList(u.outlets);
    const dH = outs.reduce((a, s) => a + H(s), 0) - ins.reduce((a, s) => a + H(s), 0);
    const q = out.values['Q(' + u.name + ')'];
    scale = Math.max(scale, Math.abs(dH), Math.abs(q), ...ins.map(s => Math.abs(H(s))));
    assert.ok(Math.abs(dH - q) < 1e-7 * scale, `energy balance on ${u.name}: ΔH = ${dH}, Q = ${q}`);
    sumQ += q;
    if (u.type === 'splitter') outs.forEach(s => near(st(s).T, st(ins[0]).T, 1e-9, 'splitter outlet temperature'));
  });
  const feeds = out.streams.filter(s => s.kind === 'feed').map(s => s.name), prods = out.streams.filter(s => s.kind === 'product').map(s => s.name);
  const overall = prods.reduce((a, s) => a + H(s), 0) - feeds.reduce((a, s) => a + H(s), 0);
  assert.ok(Math.abs(overall - sumQ) < 1e-7 * scale, `overall energy balance: ΔH = ${overall}, ΣQ = ${sumQ}`);
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);
const msgOf = fn => { try { fn(); } catch (e) { return e.message; } return null; };

Balance.ENERGY_EXAMPLES.forEach(ex => {
  test(`energy example "${ex.id}": solves, 0 degrees of freedom, matches the hand answer, every energy balance closes`, () => {
    const out = Balance.analyze(ex.model);
    assert.equal(out.status, 'solved', out.headline + ' ' + out.errors.join(' '));
    assert.equal(out.dof.dof, 0);
    assert.equal(out.energy.dof + out.energy.material.dof, 0, 'energy and material parts add up to the overall DOF');
    // only the flame (2073 °C, beyond the 1500 °C the Cp polynomials are given for) warns, and it says why
    assert.deepEqual(out.warnings.filter(w => !/extrapolation/.test(w)), [], out.warnings.join(' | '));
    assert.equal(out.warnings.length > 0, ex.id === 'e-flame', ex.id + ': ' + out.warnings.join(' | '));
    Object.keys(ex.expect).forEach(k => close(out.values[k], ex.expect[k], 1e-9, k));
    verify(Object.assign({}, ex.model, { specs: ex.model.specs.filter(sp => ['temp', 'duty', 'adiabatic', 'isothermal', 'outsameT'].indexOf(sp.type) < 0) }), out);
    verifyEnergy(ex.model, out);
  });

  test(`energy example "${ex.id}": the written solution finds every value once, and shows the energy steps`, () => {
    const out = Balance.analyze(ex.model);
    const seen = {};
    out.givens.forEach(g => { const m = g.match(/^(.*) = (\S+)$/); seen[m[1]] = Number(m[2]); });
    out.steps.forEach(s => {
      assert.ok(s.results.length >= 1 && s.title);
      s.results.forEach(r => { assert.ok(!(r.name in seen), 'solved twice: ' + r.name); seen[r.name] = r.value; });
      if (s.type === 'single') assert.ok(s.equation && s.substituted && !/undefined|NaN/.test(s.substituted), s.substituted);
      (s.lines || []).forEach(l => assert.ok(!/undefined|NaN/.test(l), l));
    });
    Object.keys(out.values).forEach(k => {
      assert.ok(k in seen, 'step list never finds ' + k);
      close(seen[k], out.values[k], 1e-9, k);
    });
    assert.ok(out.steps.some(s => /energy balance/i.test(s.title) || (s.equations || []).some(q => /energy balance/i.test(q.label))), 'an energy balance step');
  });

  test(`energy example "${ex.id}": scaling every flow by 7 leaves temperatures alone and scales flows and heat duties by 7`, () => {
    const m = clone(ex.model);
    m.specs.forEach(s => { if (s.type === 'flow' || s.type === 'compflow' || s.type === 'extent') s.value *= 7; });
    const a = Balance.analyze(ex.model), b = Balance.analyze(m);
    assert.equal(b.status, 'solved', b.headline);
    Object.keys(a.values).forEach(k => {
      if (k.startsWith('T(')) close(b.values[k], a.values[k], 1e-9, k);
      else close(b.values[k], 7 * a.values[k], 1e-8, k);
    });
  });
});

test('without an energy section nothing changes: no temperatures, no heat duties, no energy fields', () => {
  const out = Balance.analyze(example('recycle').model);
  assert.equal(out.energy, null);
  assert.ok(Object.keys(out.values).every(k => !/^[TQ]\(/.test(k)));
  assert.ok(out.streams.every(s => s.T === undefined && s.H === undefined));
  assert.ok(out.units.every(u => u.Q === undefined));
  // asking for the energy balance is the only thing that adds variables
  const m = example('recycle').model;
  m.energy = { species: { A: 'CO', B: 'CO2' } };
  const e = Balance.analyze(m);
  assert.equal(e.dof.variables - out.dof.variables, 5 + 3, '5 streams + 3 units get a temperature or a duty');
  assert.equal(e.energy.variables, 8);
});

test('energy specifications are refused when the energy balance is not switched on', () => {
  const m = clone(Balance.EXAMPLES[0].model);
  m.specs.push({ type: 'temp', stream: 'S1', value: 300 });
  const out = Balance.analyze(m);
  assert.equal(out.status, 'error');
  assert.ok(/energy specification/.test(out.errors.join(' ')), out.errors.join(' '));
});

test('degrees of freedom with energy: the heater needs a temperature in, a temperature out or a duty, and says what is missing', () => {
  const base = { components: ['H2O'], units: [{ name: 'H1', type: 'unit', inlets: 'S1', outlets: 'S2' }], energy: {} };
  const flow = { type: 'flow', stream: 'S1', value: 1 };
  const T1 = { type: 'temp', stream: 'S1', value: 298.15 }, T2 = { type: 'temp', stream: 'S2', value: 353.15 }, Q = { type: 'duty', unit: 'H1', value: 4.147 };
  const solve = specs => Balance.analyze(Object.assign(clone(base), { specs }));
  // unknowns: F(S1), n(S1), n(S2), F(S2) are mass; T1, T2, Q are energy (one energy balance among them)
  let out = solve([flow, T1, T2]);
  assert.equal(out.status, 'solved'); assert.equal(out.energy.variables, 3); assert.equal(out.energy.equations, 3);
  close(out.values['Q(H1)'], 4.147, 1e-9);
  out = solve([flow, T1]);
  assert.equal(out.status, 'underspecified'); assert.equal(out.dof.dof, 1);
  assert.ok(out.free.indexOf('T(S2)') >= 0 || out.free.indexOf('Q(H1)') >= 0, 'what to specify next names a temperature or a duty: ' + out.free.join(','));
  out = solve([flow, T1, Q]);                                         // duty instead of the outlet temperature
  assert.equal(out.status, 'solved'); close(out.values['T(S2)'], 353.15, 1e-9);
  out = solve([flow, T1, T2, Q]);                                     // one too many, but consistent: redundant
  assert.equal(out.status, 'solved'); assert.ok(out.redundant.length === 1, 'one redundant specification');
  out = solve([flow, T1, T2, { type: 'duty', unit: 'H1', value: 5 }]);   // contradictory
  assert.equal(out.status, 'inconsistent');
  out = solve([flow, T1, T2, { type: 'adiabatic', unit: 'H1' }]);    // a heater that is adiabatic cannot change the temperature
  assert.equal(out.status, 'inconsistent');
  out = solve([flow, T1, { type: 'isothermal', unit: 'H1' }]);       // isothermal: T2 = T1, so Q = 0 for a liquid
  assert.equal(out.status, 'solved'); near(out.values['Q(H1)'], 0, 1e-9); close(out.values['T(S2)'], 298.15, 1e-12);
  // per-unit DOF includes the unit's temperatures and duty
  out = solve([flow]);
  assert.equal(out.units[0].dof, 2, 'T(S1), T(S2) and Q(H1) are free and one energy balance relates them');
});

test('a splitter sends the same temperature to every outlet; an adiabatic mixer, two feeds and a splitter in a row', () => {
  const m = {
    components: ['N2', 'O2'],
    units: [{ name: 'M1', type: 'mixer', inlets: 'S1, S2', outlets: 'S3' }, { name: 'SP', type: 'splitter', inlets: 'S3', outlets: 'S4, S5' }],
    specs: [
      { type: 'compflow', stream: 'S1', comp: 'N2', value: 4 }, { type: 'compflow', stream: 'S1', comp: 'O2', value: 1 },
      { type: 'compflow', stream: 'S2', comp: 'N2', value: 2 }, { type: 'compflow', stream: 'S2', comp: 'O2', value: 3 },
      { type: 'splitfrac', stream: 'S4', value: 0.25 }, { type: 'temp', stream: 'S1', value: 300 }, { type: 'temp', stream: 'S2', value: 700 }, { type: 'adiabatic', unit: 'M1' }
    ],
    energy: { phases: { S1: 'g', S2: 'g', S3: 'g', S4: 'g', S5: 'g' } }
  };
  const out = Balance.analyze(m);
  assert.equal(out.status, 'solved', out.headline);
  const T3 = out.values['T(S3)'];
  near(out.values['T(S4)'], T3, 1e-9); near(out.values['T(S5)'], T3, 1e-9);
  near(out.values['Q(SP)'], 0, 1e-7, 'a splitter does no heat exchange');
  // by hand: 5 mol/s at 300 K and 5 mol/s at 700 K of mixed N2/O2 meet; independent bisection on the mixture enthalpy
  const hmix = (T, nN, nO) => nN * integE(SPd.N2.Cp.g, 298.15, T) + nO * integE(SPd.O2.Cp.g, 298.15, T);
  const target = hmix(300, 4, 1) + hmix(700, 2, 3);
  let lo = 300, hi = 700;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (hmix(mid, 6, 4) < target) lo = mid; else hi = mid; }
  near(T3, lo, 1e-6, 'mixer outlet temperature');
  assert.ok(T3 > 300 && T3 < 700);
  verifyEnergy(m, out);
});

test('the heat exchanger: the cooling-water flow comes from the energy balance (mass and energy solved together)', () => {
  const out = Balance.analyze(Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-exchanger').model);
  // by hand: N2 200 → 50 °C: −(29.00·150 + 2.199e-3/2·(200² − 50²) + 5.723e-6/3·(200³ − 50³) − 2.871e-9/4·(200⁴ − 50⁴)) = −4405.11 J/mol
  //          water 25 → 45 °C: 75.4 · 20 = 1508 J/mol,  F = 10 · 4405.11 / 1508 = 29.2116 mol/s
  const dN2 = 29.00 * 150 + 2.199e-3 / 2 * (200 * 200 - 50 * 50) + 5.723e-6 / 3 * (200 ** 3 - 50 ** 3) - 2.871e-9 / 4 * (200 ** 4 - 50 ** 4);
  close(out.values['F(S3)'], 10 * dN2 / 1508, 1e-9);
  assert.equal(out.dof.dof, 0);
  assert.equal(out.energy.material.dof, 1, 'the mass balance alone leaves the water flow free; the energy balance supplies the last equation');
});

test('mass-based flows: kg/h gives the same temperatures and the same heat duty in kW', () => {
  // 3600 kg/h = 1 kg/s of water at 25 °C heated to 80 °C: Q = 1000 g / 18.015 · 4147 J/mol-flow ... per mole 4.147 kJ → ṁ/M · ΔĤ
  const m = clone(Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-heater').model);
  m.specs[0].value = 3600;                                           // kg/h of water
  m.energy.flowUnit = { type: 'mass', factor: 1 / 3600 };            // kg/h → kg/s
  const out = Balance.analyze(m);
  assert.equal(out.status, 'solved', out.headline);
  close(out.values['Q(H1)'], 1000 / SPd.H2O.M * 4.147, 1e-9);
  // the same stream in kmol/h: 1 kg/s = 55.51 mol/s = 199.8 kmol/h
  const m2 = clone(Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-heater').model);
  m2.specs[0].value = 3.6 / SPd.H2O.M * 1000;                        // kmol/h in 3600 kg/h
  m2.energy.flowUnit = { type: 'mol', factor: 1000 / 3600 };         // kmol/h → mol/s
  close(Balance.analyze(m2).values['Q(H1)'], out.values['Q(H1)'], 1e-9);
});

test('species for the components: names are matched to the data table, or chosen explicitly; unknown ones are reported', () => {
  const m = { components: ['Water'], units: [{ name: 'H1', type: 'unit', inlets: 'S1', outlets: 'S2' }],
    specs: [{ type: 'flow', stream: 'S1', value: 1 }, { type: 'temp', stream: 'S1', value: 298.15 }, { type: 'temp', stream: 'S2', value: 353.15 }], energy: {} };
  close(Balance.analyze(m).values['Q(H1)'], 4.147, 1e-9);                   // "Water" found by its name
  m.components = ['Stuff']; m.specs.forEach(s => { if (s.stream) s.stream = s.stream; });
  let out = Balance.analyze(m);
  assert.equal(out.status, 'error'); assert.ok(/choose the species for the component "Stuff"/.test(out.errors.join(' ')), out.errors.join(' '));
  m.energy = { species: { Stuff: 'H2O' } };
  close(Balance.analyze(m).values['Q(H1)'], 4.147, 1e-9);
  m.energy = { species: { Stuff: 'H2O' }, flowUnit: { type: 'mass', factor: 0 } };
  assert.equal(Balance.analyze(m).status, 'error');
});

test('missing data is reported, not guessed: a species with no heat capacity for the phase of its stream', () => {
  const m = clone(Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-exchanger').model);
  m.energy.phases.S1 = 'l';                                          // liquid nitrogen: the table has no liquid Cp for N2
  const out = Balance.analyze(m);
  assert.equal(out.status, 'failed');
  assert.ok(/N2\(l\)/.test(out.errors.join(' ')) && /Stream S1/.test(out.errors.join(' ')), out.errors.join(' '));
  assert.ok(out.streams.every(s => s.T === null || s.T === undefined), 'no numbers are shown for a failed problem');
});

test('a duty that lands exactly at a boiling point cannot be solved for the temperature: the message tells how to split the stream', () => {
  // 1 mol/s liquid water at 25 °C with Q = 5.655 + 0.5 × 40.656 kW would leave half-evaporated at 100 °C
  const m = { components: ['H2O'], units: [{ name: 'B1', type: 'unit', inlets: 'S1', outlets: 'S2' }],
    specs: [{ type: 'flow', stream: 'S1', value: 1 }, { type: 'temp', stream: 'S1', value: 298.15 }, { type: 'duty', unit: 'B1', value: 5.655 + 0.5 * 40.656 }], energy: {} };
  const out = Balance.analyze(m);
  assert.equal(out.status, 'inconsistent');
  assert.ok(/boiling point/.test(out.conflicts.map(c => c.shown).join(' ')), JSON.stringify(out.conflicts));
  // with enough heat to superheat to 150 °C it is fine (steam, automatic phase)
  m.specs[2].value = 5.655 + 40.656 + 1.72165;
  const ok = Balance.analyze(m);
  assert.equal(ok.status, 'solved'); near(ok.values['T(S2)'], 423.15, 1e-3);
});

test('random chains: adiabatic mixer, a heater and a splitter, 150 cases checked by independent energy arithmetic', () => {
  const rr = mulberry(2024), r = (a, b) => a + (b - a) * rr();
  for (let t = 0; t < 150; t++) {
    const comps = ['N2', 'O2', 'CO2'];
    const f = () => comps.map(() => r(0.2, 5));
    const f1 = f(), f2 = f();
    const T1 = r(280, 600), T2 = r(280, 900), T4 = r(300, 1100), frac = r(0.1, 0.9);
    const m = {
      components: comps,
      units: [
        { name: 'M1', type: 'mixer', inlets: 'S1, S2', outlets: 'S3' },
        { name: 'H1', type: 'unit', inlets: 'S3', outlets: 'S4' },
        { name: 'SP', type: 'splitter', inlets: 'S4', outlets: 'S5, S6' }
      ],
      specs: [],
      energy: { phases: { S1: 'g', S2: 'g', S3: 'g', S4: 'g', S5: 'g', S6: 'g' } }
    };
    comps.forEach((c, j) => m.specs.push({ type: 'compflow', stream: 'S1', comp: c, value: f1[j] }, { type: 'compflow', stream: 'S2', comp: c, value: f2[j] }));
    m.specs.push({ type: 'temp', stream: 'S1', value: T1 }, { type: 'temp', stream: 'S2', value: T2 }, { type: 'adiabatic', unit: 'M1' },
      { type: 'temp', stream: 'S4', value: T4 }, { type: 'splitfrac', stream: 'S5', value: frac });
    const out = Balance.analyze(m);
    assert.equal(out.status, 'solved', 'trial ' + t + ': ' + out.headline + ' ' + out.errors.join(' '));
    assert.equal(out.dof.dof, 0);
    verify(Object.assign({}, m, { specs: m.specs.filter(sp => sp.type !== 'temp' && sp.type !== 'adiabatic') }), out);
    verifyEnergy(m, out);
    // the mixer temperature, by separate bisection
    const H = (T, flows) => flows.reduce((a, n, j) => a + n * integE(SPd[comps[j]].Cp.g, 298.15, T), 0);
    const tot = f1.map((x, j) => x + f2[j]), target = H(T1, f1) + H(T2, f2);
    let lo = Math.min(T1, T2) - 1, hi = Math.max(T1, T2) + 1;
    for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (H(mid, tot) < target) lo = mid; else hi = mid; }
    near(out.values['T(S3)'], lo, 1e-6, 'mixer T, trial ' + t);
    // and the heater duty
    close(out.values['Q(H1)'], H(T4, tot) - H(lo, tot), 1e-6, 'heater Q, trial ' + t);
  }
});

test('random reactors: complete combustion at a random excess of air, outlet temperature against an independent solution (100 cases)', () => {
  const rr = mulberry(99), r = (a, b) => a + (b - a) * rr();
  const FUELS = [['CH4', 'CH4 + 2 O2 -> CO2 + 2 H2O', 2, 1, 2], ['C2H6', 'C2H6 + 3.5 O2 -> 2 CO2 + 3 H2O', 3.5, 2, 3], ['H2', 'H2 + 0.5 O2 -> H2O', 0.5, 0, 1], ['C3H8', 'C3H8 + 5 O2 -> 3 CO2 + 4 H2O', 5, 3, 4], ['CO', 'CO + 0.5 O2 -> CO2', 0.5, 1, 0]];
  for (let t = 0; t < 100; t++) {
    const [fuel, rxn, o2s, co2s, h2os] = FUELS[Math.floor(rr() * FUELS.length)];
    const ex = r(0, 2), conv = r(0.6, 1), Tin = r(290, 500), n = r(0.5, 4);
    const O2 = o2s * (1 + ex) * n, N2 = O2 * 79 / 21;
    const comps = ['CH4', 'C2H6', 'H2', 'C3H8', 'CO', 'O2', 'N2', 'CO2', 'H2O'].filter(c => c === fuel || ['O2', 'N2', 'CO2', 'H2O'].indexOf(c) >= 0);
    const m = {
      components: comps,
      units: [{ name: 'R1', type: 'reactor', inlets: 'S1', outlets: 'S2', reaction: rxn }],
      specs: comps.map(c => ({ type: 'compflow', stream: 'S1', comp: c, value: c === fuel ? n : (c === 'O2' ? O2 : (c === 'N2' ? N2 : 0)) }))
        .concat([{ type: 'conversion', unit: 'R1', comp: fuel, value: conv }, { type: 'temp', stream: 'S1', value: Tin }, { type: 'adiabatic', unit: 'R1' }]),
      energy: { phases: { S2: 'g' } }
    };
    const out = Balance.analyze(m);
    assert.equal(out.status, 'solved', 'trial ' + t + ' ' + fuel + ': ' + out.headline + ' ' + out.errors.join(' '));
    verifyEnergy(m, out);
    // independent: extent-of-reaction energy balance with water leaving as steam but formed from the liquid reference (heat of formation of H2O(l))
    const xi = conv * n, T = out.values['T(S2)'];
    const hf = (id) => SPd[id].Hf[SPd[id].std];
    const Hin = n * (hf(fuel) + integE(SPd[fuel].Cp.g, 298.15, Tin)) + O2 * integE(SPd.O2.Cp.g, 298.15, Tin) + N2 * integE(SPd.N2.Cp.g, 298.15, Tin);
    const Hout = (n - xi) * (hf(fuel) + integE(SPd[fuel].Cp.g, 298.15, T)) + (O2 - o2s * xi) * integE(SPd.O2.Cp.g, 298.15, T) + N2 * integE(SPd.N2.Cp.g, 298.15, T)
      + xi * co2s * (hf('CO2') + integE(SPd.CO2.Cp.g, 298.15, T)) + xi * h2os * hRef('H2O', T, 'g', true);
    assert.ok(Math.abs(Hout - Hin) < 1e-6 * Math.max(1, Math.abs(Hin)), `${fuel}: Hout − Hin = ${Hout - Hin}`);
    assert.ok(T > Tin && T < 4500);
  }
});

test('energy balance with a recycle: ethylene hydrogenation with a recycle of the unreacted gases; the solver closes the loop', () => {
  // C2H4 + H2 → C2H6, 50 % conversion of ethylene per pass, the separator sends all ethane to the product and the rest back to the mixer.
  // The reactor outlet is cooled to 700 K (so the reactor has a duty to find). Overall: 100 mol/s C2H4 and 100 mol/s H2 in, 100 mol/s C2H6 out.
  const m = {
    components: ['C2H4', 'H2', 'C2H6'],
    units: [
      { name: 'M1', type: 'mixer', inlets: 'S1, S6', outlets: 'S2' },
      { name: 'R1', type: 'reactor', inlets: 'S2', outlets: 'S3', reaction: 'C2H4 + H2 -> C2H6' },
      { name: 'SEP', type: 'separator', inlets: 'S3', outlets: 'S4, S5' },
      { name: 'C1', type: 'unit', inlets: 'S5', outlets: 'S6' }
    ],
    specs: [
      { type: 'compflow', stream: 'S1', comp: 'C2H4', value: 100 }, { type: 'compflow', stream: 'S1', comp: 'H2', value: 100 }, { type: 'compflow', stream: 'S1', comp: 'C2H6', value: 0 },
      { type: 'conversion', unit: 'R1', comp: 'C2H4', value: 0.5 },
      { type: 'recovery', stream: 'S4', comp: 'C2H6', value: 1 }, { type: 'compflow', stream: 'S4', comp: 'C2H4', value: 0 }, { type: 'compflow', stream: 'S4', comp: 'H2', value: 0 },
      { type: 'compflow', stream: 'S5', comp: 'H2', value: 100 },                       // the hydrogen recycle (the mass balance cannot find it from the other data)
      { type: 'temp', stream: 'S1', value: 298.15 }, { type: 'adiabatic', unit: 'M1' }, { type: 'temp', stream: 'S3', value: 700 }, { type: 'adiabatic', unit: 'SEP' },
      { type: 'temp', stream: 'S5', value: 400 }, { type: 'duty', unit: 'C1', value: 0 }
    ],
    energy: { phases: { S1: 'g', S2: 'g', S3: 'g', S4: 'g', S5: 'g', S6: 'g' } }
  };
  const out = Balance.analyze(m);
  assert.equal(out.status, 'solved', out.headline + ' ' + out.errors.join(' '));
  assert.equal(out.dof.dof, 0);
  // the temperatures of the recycle: S6 = S5 (a unit with no duty and no composition change: its inlet and outlet have equal enthalpy)
  near(out.values['T(S6)'], 400, 1e-6, 'recycle through a no-duty unit');
  verifyEnergy(m, out);
  // overall: Σ Q = Σ Ḣ(product) − Σ Ḣ(feed)  (checked inside verifyEnergy); mass: 100 mol/s of ethane leaves
  close(out.values['n(C2H6,S4)'], 100, 1e-8);
  assert.ok(out.values['T(S3)'] > 298.15 && out.values['T(S3)'] < 2500);
});

test('the degrees-of-freedom table counts temperatures and duties per unit; the energy part is reported separately', () => {
  const out = Balance.analyze(Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-mixer').model);
  const u = out.units[0];
  // mixer M1: variables = flows of 3 streams (1 comp: 3) + 3 temperatures + 1 duty = 7, equations 7
  assert.deepEqual([u.variables, u.equations, u.dof], [7, 7, 0]);
  assert.deepEqual([out.energy.variables, out.energy.equations, out.energy.dof], [4, 4, 0]);
  assert.deepEqual([out.energy.material.variables, out.energy.material.equations, out.energy.material.dof], [3, 3, 0]);
  const under = clone(Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-mixer').model);
  under.specs = under.specs.filter(sp => sp.type !== 'adiabatic');
  const o2 = Balance.analyze(under);
  assert.equal(o2.status, 'underspecified'); assert.equal(o2.dof.dof, 1); assert.equal(o2.energy.dof, 1);
  assert.ok(o2.free.indexOf('Q(M1)') >= 0 && o2.free.indexOf('T(S3)') >= 0, 'what to specify next: ' + o2.free.join(','));
});

test('energy balances do not change the mass balance: flows are the same with and without them', () => {
  const ex = Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-flame');
  const withE = Balance.analyze(ex.model);
  const m = clone(ex.model);
  delete m.energy; m.specs = m.specs.filter(sp => ['temp', 'adiabatic'].indexOf(sp.type) < 0);
  const without = Balance.analyze(m);
  assert.equal(without.status, 'solved');
  Object.keys(without.values).forEach(k => close(withE.values[k], without.values[k], 1e-9, k));
});

test('water through its boiling point (automatic phase): Q for a given outlet temperature, and the outlet temperature for that Q, 100 random cases', () => {
  const rr = mulberry(555), r = (a, b) => a + (b - a) * rr();
  for (let t = 0; t < 100; t++) {
    const n = r(0.2, 8), T1 = r(278, 372), T2 = r(374, 800);
    const base = { components: ['H2O'], units: [{ name: 'B1', type: 'unit', inlets: 'S1', outlets: 'S2' }], energy: {},
      specs: [{ type: 'flow', stream: 'S1', value: n }, { type: 'temp', stream: 'S1', value: T1 }] };
    const fwd = clone(base); fwd.specs.push({ type: 'temp', stream: 'S2', value: T2 });
    const a = Balance.analyze(fwd);
    assert.equal(a.status, 'solved', a.headline);
    verifyEnergy(fwd, a);
    // by hand: liquid to 100 °C, ΔHvap, steam to T2
    const want = n * (integE(SPd.H2O.Cp.l, T1, 373.15) + 40.656 + integE(SPd.H2O.Cp.g, 373.15, T2));
    close(a.values['Q(B1)'], want, 1e-9, 'Q, trial ' + t);
    // and back: the duty fixes the outlet temperature (the enthalpy jumps at the boiling point, so this is bracketed, not Newton)
    const back = clone(base); back.specs.push({ type: 'duty', unit: 'B1', value: a.values['Q(B1)'] });
    const b = Balance.analyze(back);
    assert.equal(b.status, 'solved', 'trial ' + t + ' ' + b.headline + ' ' + b.errors.join(' '));
    near(b.values['T(S2)'], T2, 1e-6, 'T(S2), trial ' + t);
  }
});

test('an underspecified energy problem is reported as underspecified, never as contradictory', () => {
  const m = clone(Balance.ENERGY_EXAMPLES.find(e => e.id === 'e-flame').model);
  m.specs = m.specs.filter(sp => sp.type !== 'adiabatic');            // no duty and no outlet temperature
  let out = Balance.analyze(m);
  assert.equal(out.status, 'underspecified'); assert.equal(out.dof.dof, 1);
  m.specs.push({ type: 'duty', unit: 'R1', value: -500 });            // 500 kW removed of the 890 kW released: the products leave cooler than the adiabatic flame
  out = Balance.analyze(m);
  assert.equal(out.status, 'solved'); assert.ok(out.values['T(S2)'] < 2000, 'cooled products: ' + out.values['T(S2)']);
  m.specs[m.specs.length - 1].value = -2000;                          // more cooling than the reaction releases: no temperature above 60 K balances it
  assert.equal(Balance.analyze(m).status, 'inconsistent');
  m.specs[m.specs.length - 1].value = 1e7;                            // far more heat than any temperature up to 6000 K can absorb
  out = Balance.analyze(m);
  assert.equal(out.status, 'inconsistent'); assert.ok(/No temperature|no temperature/.test(JSON.stringify(out.conflicts)), JSON.stringify(out.conflicts));
});

test('random recycle flowsheets with energy: mass and energy balances all close (checked by separate code), 200 cases', () => {
  const rr = mulberry(31337), r = (a, b) => a + (b - a) * rr();
  for (let t = 0; t < 200; t++) {
    const withSplitter = rr() < 0.6;
    const m = {
      components: ['A', 'B', 'C'],
      units: [
        { name: 'M', type: 'mixer', inlets: 'F1, F2', outlets: 'X1' },
        { name: 'R', type: 'reactor', inlets: 'X1', outlets: 'X2', reaction: 'A -> 2 B' },
        { name: 'SEP', type: 'separator', inlets: 'X2', outlets: withSplitter ? 'T1, P2' : 'P1, P2' }
      ],
      specs: [],
      energy: { species: { A: 'C2H6', B: 'C2H4', C: 'N2' }, phases: {} }
    };
    const feedSpecs = (s, T) => {
      const a = r(0.1, 0.6), b = r(0.1, 0.9 - a);
      m.specs.push({ type: 'flow', stream: s, value: r(20, 500) }, { type: 'frac', stream: s, comp: 'A', value: a }, { type: 'frac', stream: s, comp: 'B', value: b }, { type: 'temp', stream: s, value: T });
    };
    feedSpecs('F1', r(290, 450)); feedSpecs('F2', r(290, 700));
    m.specs.push({ type: 'conversion', unit: 'R', comp: 'A', value: r(0.1, 0.95) });
    const top = withSplitter ? 'T1' : 'P1';
    ['A', 'B', 'C'].forEach(c => m.specs.push({ type: 'recovery', stream: top, comp: c, value: r(0.05, 0.95) }));
    if (withSplitter) {
      m.units.push({ name: 'SP', type: 'splitter', inlets: 'T1', outlets: 'P1, RC' });
      m.units[0].inlets = 'F1, F2, RC';
      m.specs.push({ type: 'splitfrac', stream: 'RC', value: r(0.1, 0.9) });
    }
    m.specs.push({ type: 'adiabatic', unit: 'M' }, { type: 'temp', stream: 'X2', value: r(400, 900) }, { type: 'adiabatic', unit: 'SEP' }, { type: 'outsameT', unit: 'SEP' });
    Balance.parseList('F1,F2,X1,X2,T1,P1,P2,RC').forEach(s => { m.energy.phases[s] = 'g'; });
    const out = Balance.analyze(m);
    assert.equal(out.status, 'solved', 'trial ' + t + ': ' + out.headline + ' ' + out.errors.join(' '));
    assert.equal(out.dof.dof, 0, 'trial ' + t);
    const massModel = Object.assign({}, m, { specs: m.specs.filter(sp => ['temp', 'adiabatic', 'outsameT', 'duty', 'isothermal'].indexOf(sp.type) < 0) });
    verify(massModel, out);
    verifyEnergy(m, out);
  }
});

console.log(`\n${passed} test groups passed` + (process.exitCode ? ' — with failures' : ''));
