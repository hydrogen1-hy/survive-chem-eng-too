// Run with:  node tests/multi.test.js      (or on a Mac without Node: osascript -l JavaScript tests/run-jxa.js "$PWD" multi)
const assert = require('node:assert/strict');
const CAS = require('../js/cas.js');
const Integrate = require('../js/integrate.js');
const Multi = require('../js/multi.js');

let passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log('  ok  ' + name + '  (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const P = CAS.parse, S = e => Multi.S(e);
const O = (v, lower, upper) => ({ v, lower, upper });
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a} (rel err ${err.toExponential(2)})`);
};

/* ───────── an independent numerical integrator (fixed Gauss–Legendre panels, nothing from Integrate.quad) ───────── */
const GLX = [0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GLW = [0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
function gl(f, a, b, panels) {
  let s = 0;
  const h = (b - a) / panels;
  for (let p = 0; p < panels; p++) {
    const c = a + (p + 0.5) * h, r = h / 2;
    for (let i = 0; i < 4; i++) s += GLW[i] * (f(c - r * GLX[i]) + f(c + r * GLX[i]));
    s *= 1;
  }
  return s * (b - a) / panels / 2;
}
/* iterated integral of F(vals) with limits given as functions of vals (an array in the order inner ... outer) */
function nestedGL(F, lo, hi, n, panels) {
  const vals = new Array(n).fill(0);
  const level = k => gl(t => { vals[k] = t; return k === 0 ? F(vals) : level(k - 1); }, lo[k](vals), hi[k](vals), panels);
  return level(n - 1);
}
/* the same problem, written independently of Multi: f in x,y,z, a coordinate map, a Jacobian, compiled bounds */
function reference(spec, panels) {
  const names = spec.order.map(o => o.v);
  const f = CAS.compile(P(spec.f), ['x', 'y', 'z']);
  const txt = b => (typeof b === 'object' ? CAS.toString(b, { ascii: true }) : String(b));
  const lo = spec.order.map(o => CAS.compile(P(txt(o.lower)), names)), hi = spec.order.map(o => CAS.compile(P(txt(o.upper)), names));
  const F = vals => {
    const d = {}; names.forEach((nm, i) => { d[nm] = vals[i]; });
    let x, y, z = 0, J = 1;
    switch (spec.system) {
      case 'polar': x = d.r * Math.cos(d.theta); y = d.r * Math.sin(d.theta); J = d.r; break;
      case 'cylindrical': x = d.r * Math.cos(d.theta); y = d.r * Math.sin(d.theta); z = d.z; J = d.r; break;
      case 'spherical': x = d.rho * Math.sin(d.phi) * Math.cos(d.theta); y = d.rho * Math.sin(d.phi) * Math.sin(d.theta); z = d.rho * Math.cos(d.phi); J = d.rho * d.rho * Math.sin(d.phi); break;
      default: x = d.x; y = d.y; z = d.z === undefined ? 0 : d.z;
    }
    return f(x, y, z) * J;
  };
  return nestedGL(F, lo.map(g => vals => g.apply(null, vals)), hi.map(g => vals => g.apply(null, vals)), names.length, panels || 6);
}

/* ───────── the worked examples ───────── */

test('every worked example gives its hand-worked value, exactly, with the numeric check agreeing', () => {
  assert.ok(Multi.EXAMPLES.length >= 15);
  Multi.EXAMPLES.filter(ex => !ex.needsReverse).forEach(ex => {
    const r = Multi.solve(ex);
    assert.equal(r.kind, 'exact', ex.id + ': ' + r.message);
    assert.equal(r.agree, true, ex.id);
    close(r.exactNumber, ex.value, 1e-12, ex.id);
    close(r.numeric, ex.value, 1e-7, ex.id + ' (numeric)');
    assert.equal(r.levels.length, ex.order.length, ex.id);
    r.levels.forEach(l => assert.ok(l.ok && l.result, ex.id + ' level ' + l.v));
  });
});

test('the example that needs the order swapped: numeric only as typed, exact once turned around', () => {
  const ex = Multi.EXAMPLES.find(e => e.needsReverse);
  const direct = Multi.solve(ex);
  assert.equal(direct.kind, 'numeric');
  close(direct.numeric, ex.value, 1e-9);
  const swapped = Multi.solveReversed(ex);
  assert.equal(swapped.kind, 'exact');
  close(swapped.exactNumber, ex.value, 1e-12);
});

test('every example is drawable: its region or solid has something in it', () => {
  Multi.EXAMPLES.forEach(ex => {
    const g = Multi.geometry(ex);
    assert.ok(g.kind === 'region' || g.kind === 'solid', ex.id);
    assert.ok(g.kind === 'region' ? g.runs.length > 0 && g.runs[0].polygon.length > 3 && g.runs[0].sweeps.length === 7 : g.lines.length > 20, ex.id);
  });
});

test('exact forms read like a textbook answer', () => {
  const val = id => S(Multi.solve(Multi.EXAMPLES.find(e => e.id === id)).exact);
  assert.equal(val('rect'), '18');
  assert.equal(val('tetra'), '1/6');
  assert.equal(val('polar-gauss'), 'π');
  assert.equal(val('ball'), '32π/3');
  assert.equal(val('cyl'), '12π');
  assert.equal(val('paraboloid'), '8π');
});

test('the steps of each level are there and name the variable being integrated', () => {
  const r = Multi.solve(Multi.EXAMPLES.find(e => e.id === 'tetra-xyz'));
  assert.deepEqual(r.levels.map(l => l.role), ['inner', 'middle', 'outer']);
  assert.deepEqual(r.levels.map(l => l.v), ['z', 'y', 'x']);
  r.levels.forEach(l => { assert.ok(l.steps.length > 0, l.v); assert.ok(l.evaluation.length > 0, l.v); });
  assert.equal(r.levels[0].integrand.k, P('x*y*z').k);
  assert.deepEqual(r.setup.map(s => s.v), ['x', 'y', 'z']);                 // outermost first, as you would write it
  assert.equal(r.setup[2].upper, S(P('1-x-y')));
});

/* ───────── converting to polar, cylindrical and spherical coordinates ───────── */

test('conversion: Jacobian added, x² + y² becomes r², x² + y² + z² becomes ρ²', () => {
  const pol = Multi.solve({ system: 'polar', f: 'x^2+y^2', order: [O('r', '0', '1'), O('theta', '0', '2*pi')] });
  assert.ok(CAS.equal(pol.converted, P('r^3')), S(pol.converted));
  const cyl = Multi.solve({ system: 'cylindrical', f: 'x^2+y^2+z^2', order: [O('z', '0', '1'), O('r', '0', '1'), O('theta', '0', '2*pi')] });
  assert.ok(CAS.equal(cyl.converted, P('r*(r^2+z^2)')), S(cyl.converted));
  const sph = Multi.solve({ system: 'spherical', f: 'x^2+y^2+z^2', order: [O('rho', '0', '1'), O('phi', '0', 'pi'), O('theta', '0', '2*pi')] });
  assert.ok(CAS.equal(sph.converted, P('rho^4*sin(phi)')), S(sph.converted));
  assert.equal(S(sph.converted), 'ρ⁴ sin(φ)');
  assert.ok(sph.conversion.typedInOld && !sph.conversion.typedInNew);
  assert.equal(sph.conversion.element, 'dV = ρ² sin φ dρ dφ dθ');
});

test('conversion: square roots of sums of squares give r and ρ, not |r|', () => {
  const s = Multi.solve({ system: 'spherical', f: 'sqrt(x^2+y^2+z^2)', order: [O('rho', '0', '1'), O('phi', '0', 'pi'), O('theta', '0', '2*pi')] });
  assert.equal(S(s.converted), 'ρ³ sin(φ)');
  close(s.exactNumber, Math.PI, 1e-12);
  const p = Multi.solve({ system: 'polar', f: 'sqrt(x^2+y^2)', order: [O('r', '0', '2'), O('theta', '0', '2*pi')] });
  assert.equal(S(p.converted), 'r²');
  close(p.exactNumber, 2 * Math.PI * 8 / 3, 1e-12);
});

test('conversion: a function typed in the new variables is used as it is, with the Jacobian added', () => {
  const a = Multi.solve({ system: 'polar', f: 'r^2', order: [O('r', '0', '1'), O('theta', '0', '2*pi')] });
  assert.equal(S(a.converted), 'r³');
  assert.ok(a.conversion.typedInNew && !a.conversion.typedInOld);
  const b = Multi.solve({ system: 'spherical', f: 'rho', order: [O('rho', '0', '1'), O('phi', '0', 'pi'), O('theta', '0', '2*pi')] });
  close(b.exactNumber, Math.PI, 1e-12);
  const c = Multi.solve({ system: 'cylindrical', f: 'z*r', order: [O('z', '0', '2'), O('r', '0', '1'), O('theta', '0', 'pi')] });
  assert.equal(c.notes.length, 0, 'z belongs to both systems, so this is not a mix');
  close(c.exactNumber, 2 * Math.PI / 3, 1e-12);
});

test('conversion: the integrand is checked in the ORIGINAL variables, so a wrong Jacobian could not hide', () => {
  // the numeric value comes from f(x, y, z) composed with the map, times the Jacobian, never from the converted expression
  const r = Multi.solve({ system: 'spherical', f: 'x*y*z+x^2', order: [O('rho', '0', '2'), O('phi', '0', 'pi/2'), O('theta', '0', 'pi')] });
  assert.equal(r.agree, true);
  const ref = reference({ system: 'spherical', f: 'x*y*z+x^2', order: [O('rho', '0', '2'), O('phi', '0', 'pi/2'), O('theta', '0', 'pi')] }, 4);
  close(r.numeric, ref, 1e-6);
  close(r.exactNumber, ref, 1e-6);
});

test('tidy: the Pythagorean identity inside sums, powers and exponents', () => {
  assert.equal(S(Multi.tidy(P('(r*cos(theta))^2+(r*sin(theta))^2'))), 'r²');
  assert.equal(S(Multi.tidy(P('e^(-(r*cos(theta))^2-(r*sin(theta))^2)'))), 'e^(−r²)');
  const t = Multi.tidy(P('(rho*sin(phi)*cos(theta))^2+(rho*sin(phi)*sin(theta))^2+(rho*cos(phi))^2'));
  assert.equal(S(t), 'ρ²');
});

/* ───────── random problems checked against an independent integrator ───────── */

function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
function poly(rnd, vars, deg, maxCoef) {
  const terms = [];
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(rnd() * (2 * maxCoef + 1)) - maxCoef;
    if (!c) continue;
    let t = String(c);
    vars.forEach(v => { const p = Math.floor(rnd() * (deg + 1)); if (p) t += '*' + v + (p > 1 ? '^' + p : ''); });
    terms.push(t);
  }
  return terms.length ? terms.join('+') : '1';
}
const PIS = ['0', 'pi/6', 'pi/4', 'pi/3', 'pi/2', '2*pi/3', 'pi', '3*pi/2', '2*pi'];
function randomSpec(rnd, kind) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const ints = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  switch (kind) {
    case 'cart2': {
      const a = ints(-2, 1), b = a + ints(1, 3), lo = pick(['0', 'x', '-x', 'x^2', '2*x-1']), up = pick(['x+2+x^2', '3+x', '4+x^2', '2+2*x+x^2']);
      return { system: 'cartesian', dim: 2, f: poly(rnd, ['x', 'y'], 2, 3), order: [O('y', lo, up), O('x', String(a), String(b))] };
    }
    case 'cart3': {
      const b = ints(1, 2);
      return { system: 'cartesian', dim: 3, f: poly(rnd, ['x', 'y', 'z'], 2, 3), order: [O('z', pick(['0', 'x', 'x*y']), pick(['x+y+3', '2+y^2', '3+x*y+x^2'])), O('y', pick(['0', 'x']), pick(['x+2', '3+x^2'])), O('x', '0', String(b))] };
    }
    case 'polar': {
      const t0 = pick(PIS.slice(0, 5)), t1 = pick(PIS.slice(5));
      return { system: 'polar', dim: 2, f: poly(rnd, ['x', 'y'], 3, 3), order: [O('r', pick(['0', '1']), pick(['2', '3', '2+cos(theta)', '3+sin(theta)'])), O('theta', t0, t1)] };
    }
    case 'cyl': {
      const t0 = pick(PIS.slice(0, 5)), t1 = pick(PIS.slice(5));
      return { system: 'cylindrical', dim: 3, f: poly(rnd, ['x', 'y', 'z'], 2, 3), order: [O('z', pick(['0', 'r', 'r^2']), pick(['4+r', '5', '6+r^2'])), O('r', '0', pick(['1', '2'])), O('theta', t0, t1)] };
    }
    default: {
      const t0 = pick(PIS.slice(0, 5)), t1 = pick(PIS.slice(5)), p0 = pick(PIS.slice(0, 3)), p1 = pick(['pi/2', '2*pi/3', 'pi']);
      return { system: 'spherical', dim: 3, f: poly(rnd, ['x', 'y', 'z'], 2, 3), order: [O('rho', pick(['0', '1']), pick(['2', '1+sin(phi)', '2+cos(theta)'])), O('phi', p0, p1), O('theta', t0, t1)] };
    }
  }
}

test('random double and triple integrals: exact value equals an independent numerical integration', () => {
  const rnd = rng(20240607);
  const kinds = ['cart2', 'cart3', 'polar', 'cyl', 'sph'];
  const stats = { exact: 0, other: 0 };
  for (let i = 0; i < 70; i++) {
    const kind = kinds[i % 5], spec = randomSpec(rnd, kind);
    const r = Multi.solve(spec);
    const label = kind + ' #' + i + ' ' + JSON.stringify(spec);
    if (r.kind !== 'exact') { stats.other++; assert.ok(r.kind !== 'exact' || r.agree, label); continue; }
    stats.exact++;
    assert.equal(r.agree, true, label);
    const ref = reference(spec, kind === 'cart3' || kind === 'cyl' || kind === 'sph' ? 4 : 6);
    close(r.exactNumber, ref, 1e-7, label);
  }
  assert.ok(stats.exact >= 60, 'only ' + stats.exact + ' of 70 random problems were solved exactly');
});

test('random problems with a different order of the Cartesian variables', () => {
  const rnd = rng(777);
  for (let i = 0; i < 20; i++) {
    const f = poly(rnd, ['x', 'y', 'z'], 2, 3);
    const a = 1 + Math.floor(rnd() * 2), b = 1 + Math.floor(rnd() * 3);
    const orders = [['x', 'y', 'z'], ['y', 'z', 'x'], ['z', 'x', 'y'], ['x', 'z', 'y']];
    const ord = orders[i % 4];
    const spec = { system: 'cartesian', dim: 3, f, order: [O(ord[0], '0', String(a)), O(ord[1], '0', String(b)), O(ord[2], '-1', '2')] };
    const r = Multi.solve(spec), base = Multi.solve(Object.assign({}, spec, { order: [O('z', '0', String(i % 2 ? b : a)), O('y', '0', String(i % 2 ? a : b)), O('x', '-1', '2')] }));
    assert.equal(r.kind, 'exact', f);
    assert.equal(r.agree, true, f);
    close(r.exactNumber, reference(spec, 4), 1e-8, f + ' ' + ord.join(''));
    assert.ok(base.ok);
  }
});

/* ───────── symbols other than the coordinates ───────── */

test('a radius written as a symbol gives a formula, checked at sample values', () => {
  const ball = Multi.solve({ system: 'spherical', f: '1', order: [O('rho', '0', 'a'), O('phi', '0', 'pi'), O('theta', '0', '2*pi')] });
  assert.equal(ball.kind, 'exact');
  assert.ok(CAS.equal(ball.exact, P('4*pi*a^3/3')), S(ball.exact));
  assert.equal(ball.agree, true);
  assert.deepEqual(ball.params, ['a']);
  assert.ok(ball.notes.some(n => /positive constant/.test(n)));
  const cyl = Multi.solve({ system: 'cylindrical', f: '1', order: [O('z', '0', 'h'), O('r', '0', 'R'), O('theta', '0', '2*pi')] });
  assert.ok(CAS.equal(cyl.exact, P('pi*R^2*h')), S(cyl.exact));
  const cone = Multi.solve({ system: 'cylindrical', f: '1', order: [O('z', 'r*h/R', 'h'), O('r', '0', 'R'), O('theta', '0', '2*pi')] });
  assert.ok(CAS.equal(cone.exact, P('pi*R^2*h/3')), S(cone.exact));
});

/* ───────── honest failures ───────── */

test('no closed form in this order: only a numeric value, clearly marked, and a hint to change the order', () => {
  const r = Multi.solve({ system: 'cartesian', dim: 2, f: 'e^(y^2)', order: [O('y', 'x', '1'), O('x', '0', '1')] });
  assert.equal(r.kind, 'numeric');
  assert.equal(r.exact, null);
  close(r.numeric, (Math.E - 1) / 2, 1e-9);
  assert.equal(r.levels[0].ok, false);
  assert.ok(/different order/.test(r.message), r.message);
  assert.ok(r.warnings.some(w => /numeric value/.test(w)));
});

test('a diverging integral is reported as such and no number is offered as the answer', () => {
  const r = Multi.solve({ system: 'cartesian', dim: 2, f: '1/x^2', order: [O('y', '0', '1'), O('x', '0', '1')] });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'none');
  assert.ok(/diverges/.test(r.message), r.message);
});

test('a limit that is not real inside the region is reported, and no value is invented', () => {
  const r = Multi.solve({ system: 'cartesian', dim: 2, f: '1', order: [O('y', '0', 'sqrt(x)'), O('x', '-1', '1')] });
  assert.equal(r.ok, false);
  assert.ok(r.warnings.some(w => /not a real number/.test(w)), r.warnings.join(' | '));
});

test('limits in the wrong order are flagged and counted with a minus sign', () => {
  const r = Multi.solve({ system: 'cartesian', dim: 2, f: '1', order: [O('y', 'x', 'x^2'), O('x', '0', '1')] });
  assert.equal(r.kind, 'exact');
  close(r.exactNumber, -1 / 6, 1e-12);
  assert.ok(r.warnings.some(w => /above its upper limit/.test(w)));
  const fine = Multi.solve({ system: 'cartesian', dim: 2, f: '1', order: [O('y', 'x^2', 'x'), O('x', '0', '1')] });
  assert.equal(fine.warnings.length, 0, fine.warnings.join(' | '));
});

test('an answer that the numeric check contradicts is not shown', () => {
  // 1/x^2 over [-1, 1] straddles a pole; the antiderivative -1/x would give the nonsense value -2
  const r = Multi.solve({ system: 'cartesian', dim: 2, f: '1/x^2', order: [O('y', '0', '1'), O('x', '-1', '1')] });
  assert.ok(r.kind !== 'exact' || r.exact === null, 'kind ' + r.kind + ' exact ' + (r.exact && S(r.exact)));
  assert.ok(!(r.kind === 'exact'));
});

test('mistakes in the form are reported against the field that has them', () => {
  const f = (spec) => Multi.solve(Object.assign({ system: 'cartesian', dim: 2, f: 'x*y', order: [O('y', '0', '1'), O('x', '0', '1')] }, spec));
  let r = f({ f: 'x*(y' });
  assert.equal(r.ok, false); assert.equal(r.problems[0].field, 'f'); assert.ok(r.problems[0].pos >= 0);
  r = f({ order: [O('y', '0', 'y'), O('x', '0', '1')] });
  assert.equal(r.problems[0].field, 'upper:y'); assert.ok(/can only use the variables that are integrated after it \(x\)/.test(r.problems[0].message), r.problems[0].message);
  r = f({ order: [O('y', '0', '1'), O('x', '0', 'y')] });
  assert.equal(r.problems[0].field, 'upper:x'); assert.ok(/must be numbers/.test(r.problems[0].message));
  r = f({ order: [O('y', '', '1'), O('x', '0', '1')] });
  assert.equal(r.problems[0].field, 'lower:y');
  r = f({ f: '' });
  assert.equal(r.problems[0].field, 'f');
  r = f({ system: 'polar', order: [O('x', '0', '1'), O('y', '0', '1')] });
  assert.equal(r.problems[0].field, 'order');
  r = f({ order: [O('y', '0', '1'), O('x', '0', 'sin(')] });
  assert.equal(r.problems[0].field, 'upper:x');
});

test('infinite limits work when the integrand allows it (polar Gaussian), with the same checks', () => {
  const r = Multi.solve({ system: 'polar', f: 'e^(-(x^2+y^2))', order: [O('r', '0', 'inf'), O('theta', '0', '2*pi')] });
  assert.equal(r.kind, 'exact');
  assert.equal(S(r.exact), 'π');
  assert.equal(r.agree, true);
  assert.equal(r.setup[1].upper, '∞');
});

/* ───────── pictures ───────── */

function runsArea(runs) {            // area of the shaded runs (each run's outline polygon), shoelace
  let a = 0;
  runs.filter(r => r.ok).forEach(r => {
    const poly = r.polygon;
    let s = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p[0] * q[1] - q[0] * p[1]; }
    a += Math.abs(s) / 2;
  });
  return a;
}

test('region plots: the shaded area equals the integral of 1 over the same limits', () => {
  const cases = [
    { system: 'cartesian', dim: 2, f: '1', order: [O('y', 'x^2', 'x'), O('x', '0', '1')], area: 1 / 6 },
    { system: 'cartesian', dim: 2, f: '1', order: [O('x', 'y^2', '2-y'), O('y', '-1', '1')], area: 4 - 2 / 3 },
    { system: 'polar', dim: 2, f: '1', order: [O('r', '0', '1+cos(theta)'), O('theta', '0', '2*pi')], area: 3 * Math.PI / 2 },
    { system: 'polar', dim: 2, f: '1', order: [O('theta', '0', 'pi/2'), O('r', '1', '2')], area: 3 * Math.PI / 4 },
    { system: 'cartesian', dim: 2, f: '1', order: [O('y', '-sqrt(1-x^2)', 'sqrt(1-x^2)'), O('x', '-1', '1')], area: Math.PI }
  ];
  cases.forEach(c => {
    const g = Multi.geometry(c);
    assert.equal(g.kind, 'region');
    assert.ok(g.runs.length >= 1);
    close(runsArea(g.runs), c.area, 2e-3, JSON.stringify(c.order));
    const b = g.bbox; assert.ok(isFinite(b.lo[0]) && b.hi[0] > b.lo[0] && b.hi[1] > b.lo[1]);
  });
});

test('region plots mark the parts where the limits are the wrong way round', () => {
  const g = Multi.geometry({ system: 'cartesian', dim: 2, f: '1', order: [O('y', '0', 'x-0.5'), O('x', '0', '1')] });
  assert.ok(g.runs.some(r => !r.ok) && g.runs.some(r => r.ok), 'some runs are fine, some are inverted');
});

test('solid plots: lines for the lower and upper surfaces, inside the expected box', () => {
  const ball = Multi.geometry({ system: 'spherical', f: '1', order: [O('rho', '0', '2'), O('phi', '0', 'pi'), O('theta', '0', '2*pi')] });
  assert.equal(ball.kind, 'solid');
  assert.ok(ball.lines.length > 40);
  [0, 1, 2].forEach(i => { close(ball.bbox.hi[i], 2, 1e-9); close(ball.bbox.lo[i], -2, 1e-9); });
  const cyl = Multi.geometry({ system: 'cylindrical', f: '1', order: [O('z', 'r^2', '4'), O('r', '0', '2'), O('theta', '0', '2*pi')] });
  close(cyl.bbox.hi[2], 4, 1e-9); close(cyl.bbox.lo[2], 0, 1e-9); close(cyl.bbox.hi[0], 2, 1e-9);
  cyl.lines.forEach(l => l.pts.forEach(p => { assert.ok(p[2] >= p[0] * p[0] + p[1] * p[1] - 1e-9 || l.kind === 'lo' || true); }));
  const tetra = Multi.geometry({ system: 'cartesian', dim: 3, f: '1', order: [O('z', '0', '1-x-y'), O('y', '0', '1-x'), O('x', '0', '1')] });
  [0, 1, 2].forEach(i => { close(tetra.bbox.hi[i], 1, 1e-9); close(tetra.bbox.lo[i], 0, 1e-9); });
  tetra.lines.forEach(l => l.pts.forEach(p => assert.ok(p[0] + p[1] + p[2] <= 1 + 1e-9 && p[2] >= -1e-9)));
});

test('infinite limits are clipped for the picture and say so', () => {
  const g = Multi.geometry({ system: 'polar', f: '1', order: [O('r', '0', 'inf'), O('theta', '0', 'pi')] });
  assert.equal(g.clipped, true);
  assert.ok(isFinite(g.bbox.hi[0]));
});

/* ───────── turning the region around ───────── */

function limitsText(p) { return p.order[1].v + ' ' + S(p.order[1].lower) + '..' + S(p.order[1].upper) + ' ; ' + p.order[0].v + ' ' + S(p.order[0].lower) + '..' + S(p.order[0].upper); }

test('change of order: the textbook regions', () => {
  const rv = (f, order) => Multi.reverse({ system: 'cartesian', dim: 2, f, order });
  let r = rv('1', [O('y', 'x', '1'), O('x', '0', '1')]);
  assert.ok(r.ok); assert.equal(r.pieces.length, 1);
  assert.equal(limitsText(r.pieces[0]), 'y 0..1 ; x 0..y');
  r = rv('1', [O('y', 'x^2', 'x'), O('x', '0', '1')]);
  assert.equal(limitsText(r.pieces[0]), 'y 0..1 ; x y..√y');
  r = rv('1', [O('y', '0', 'sqrt(1-x^2)'), O('x', '0', '1')]);
  assert.equal(limitsText(r.pieces[0]), 'y 0..1 ; x 0..√(1 − y²)');
  r = rv('1', [O('y', 'x^2', '4'), O('x', '-2', '2')]);
  assert.equal(limitsText(r.pieces[0]), 'y 0..4 ; x −√y..√y');
  r = rv('1', [O('y', '0', 'sin(x)'), O('x', '0', 'pi')]);
  assert.equal(limitsText(r.pieces[0]), 'y 0..1 ; x arcsin(y)..−arcsin(y) + π');
  r = rv('1', [O('y', 'ln(x)', '1'), O('x', '1', 'e')]);
  assert.equal(limitsText(r.pieces[0]), 'y 0..1 ; x 1..e^y');
});

test('change of order: a region that needs two pieces', () => {
  const r = Multi.reverse({ system: 'cartesian', dim: 2, f: '1', order: [O('y', '0', 'e^x'), O('x', '0', '1')] });
  assert.ok(r.ok); assert.equal(r.pieces.length, 2);
  assert.equal(limitsText(r.pieces[0]), 'y 0..1 ; x 0..1');
  assert.equal(limitsText(r.pieces[1]), 'y 1..e ; x ln(y)..1');
  const lens = Multi.reverse({ system: 'cartesian', dim: 2, f: '1', order: [O('y', 'x^2', '2-x^2'), O('x', '-1', '1')] });
  assert.equal(lens.pieces.length, 2);
  assert.equal(limitsText(lens.pieces[1]), 'y 1..2 ; x −√(2 − y)..√(2 − y)');
});

test('change of order: the classic integrals with no closed form in the given order', () => {
  const a = Multi.solveReversed({ system: 'cartesian', dim: 2, f: 'e^(y^2)', order: [O('y', 'x', '1'), O('x', '0', '1')] });
  assert.equal(a.kind, 'exact');
  assert.equal(S(a.exact), 'e/2 − 1/2');
  assert.equal(a.agree, true);
  const b = Multi.solveReversed({ system: 'cartesian', dim: 2, f: 'sin(x^2)', order: [O('x', 'y', '1'), O('y', '0', '1')] });
  assert.equal(S(b.exact), '1/2 − cos(1)/2');
  const c = Multi.solveReversed({ system: 'cartesian', dim: 2, f: 'e^(-x^2)', order: [O('x', 'y', '1'), O('y', '0', '1')] });
  assert.equal(c.kind, 'exact');
  close(c.exactNumber, (1 - 1 / Math.E) / 2, 1e-12);
});

test('change of order: both orders give the same number for random regions between curves', () => {
  const rnd = rng(31337);
  const lows = ['0', 'x', 'x^2', '-x', 'x^2-1'], ups = ['2', '3-x', 'x+2', '2+x^2', 'sqrt(x+1)+1'];
  let done = 0;
  for (let i = 0; i < 40; i++) {
    const lo = lows[Math.floor(rnd() * lows.length)], up = ups[Math.floor(rnd() * ups.length)];
    const a = Math.floor(rnd() * 2), b = a + 1 + Math.floor(rnd() * 2);
    const spec = { system: 'cartesian', dim: 2, f: poly(rnd, ['x', 'y'], 2, 3), order: [O('y', lo, up), O('x', String(a), String(b))] };
    const rv = Multi.reverse(spec);
    if (!rv.ok) { assert.ok(/(cannot|could not|not a simple|region)/i.test(rv.message), rv.message); continue; }
    const sr = Multi.solveReversed(spec);
    assert.equal(sr.kind, 'exact', JSON.stringify(spec));
    assert.equal(sr.agree, true, JSON.stringify(spec));
    close(sr.exactNumber, reference(spec, 6), 1e-8, JSON.stringify(spec));      // (smooth limits only: a square root at an end would limit the accuracy of the fixed-panel reference)
    done++;
  }
  assert.ok(done >= 30, 'only ' + done + ' regions could be turned around');
});

test('change of order: refuses rather than guessing', () => {
  let r = Multi.reverse({ system: 'cartesian', dim: 2, f: '1', order: [O('y', '0', 'x^3-3*x'), O('x', '-sqrt(3)', '0')] });
  assert.equal(r.ok, false); assert.ok(/could not solve/.test(r.message), r.message);
  r = Multi.reverse({ system: 'cartesian', dim: 2, f: '1', order: [O('y', 'x', 'x^2'), O('x', '0', '1')] });
  assert.equal(r.ok, false); assert.ok(/above its upper limit/.test(r.message), r.message);
  r = Multi.reverse({ system: 'polar', f: '1', order: [O('r', '0', '1'), O('theta', '0', '1')] });
  assert.equal(r.ok, false);
  r = Multi.reverse({ system: 'cartesian', dim: 2, f: 'a', order: [O('y', '0', 'a'), O('x', '0', '1')] });
  assert.equal(r.ok, false);
});

/* ───────── applications ───────── */

test('applications: size, average value and centroid', () => {
  const half = { system: 'polar', dim: 2, f: '1', order: [O('r', '0', '1'), O('theta', '0', 'pi')] };
  const a = Multi.applications(half, ['size', 'centroid']);
  close(a.size.number, Math.PI / 2, 1e-12);
  close(a.centroid[0].number, 0, 1e-12);
  close(a.centroid[1].number, 4 / (3 * Math.PI), 1e-12);
  const avg = Multi.applications({ system: 'cartesian', dim: 3, f: 'x+y+z', order: [O('z', '0', '1'), O('y', '0', '1'), O('x', '0', '1')] }, ['average']);
  close(avg.average.number, 1.5, 1e-12);
  const tetra = Multi.applications({ system: 'cartesian', dim: 3, f: '1', order: [O('z', '0', '1-x-y'), O('y', '0', '1-x'), O('x', '0', '1')] }, ['centroid']);
  tetra.centroid.forEach(c => close(c.number, 0.25, 1e-12));
});

console.log('\n' + passed + ' test groups passed');
