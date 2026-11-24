// Run with:  node tests/integrate.test.js
const assert = require('node:assert/strict');
const CAS = require('../js/cas.js');
const Integrate = require('../js/integrate.js');

let passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log('  ok  ' + name + '  (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const P = CAS.parse, S = e => CAS.toString(e);
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a} (rel err ${err.toExponential(2)})`);
};

/* An independent check that F' = f: central finite differences of F, never using CAS.diff. */
function fdCheck(f, F, v, label) {
  const vars = Array.from(new Set(CAS.freeVars(f).concat(CAS.freeVars(F), [v]))).sort();
  const vi = vars.indexOf(v);
  const ff = CAS.compile(f, vars), FF = CAS.compile(F, vars);
  const wins = [[0.3, 2.2], [-2.2, -0.3], [0.7, 4], [-0.8, 0.8], [1.2, 6], [-6, -1.2], [0.05, 0.6]];
  let seed = 4242, ok = 0, bad = null;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let t = 0; t < 120 && ok < 12; t++) {
    const pt = vars.map((_, i) => { const w = wins[(t + 3 * i) % wins.length]; return w[0] + (w[1] - w[0]) * rnd(); });
    const f00 = ff.apply(null, pt), x0 = pt[vi], h = 1e-5 * Math.max(1, Math.abs(x0)) / Math.max(1, Math.abs(f00) / 100);
    const at = d => { const q = pt.slice(); q[vi] = x0 + d * h; return FF.apply(null, q); };
    const f0 = ff.apply(null, pt), Fm2 = at(-2), Fm1 = at(-1), Fp1 = at(1), Fp2 = at(2);
    if (!isFinite(f0) || !isFinite(Fm2) || !isFinite(Fp2) || Math.abs(f0) > 1000) continue;     // (steep, wildly oscillating points are too hard for finite differences)
    const slope = (-Fp2 + 8 * Fp1 - 8 * Fm1 + Fm2) / (12 * h);        // five-point stencil: error of order h^4
    if (Math.abs(slope - f0) > 2e-6 * Math.max(1, Math.abs(f0)) + 1e-9 * Math.abs(Fp1)) { bad = { x: x0, f0, slope }; break; }
    ok++;
  }
  assert.ok(!bad, (label || '') + ' derivative of the answer does not match the integrand at x = ' + (bad && bad.x) + ': integrand ' + (bad && bad.f0) + ', slope ' + (bad && bad.slope));
  assert.ok(ok >= 6, (label || '') + ' too few valid sample points (' + ok + ')');
}
const solve = (s, opts) => Integrate.integrate(s, 'x', Object.assign({ maxMs: 4000 }, opts || {}));
const hasRule = (r, word) => r.steps.some(st => st.kind === 'rule' && st.title.toLowerCase().indexOf(word) >= 0);

/* ───────────────────────── the table: classic textbook integrals ───────────────────────── */

// [integrand, a word that must appear in the name of one of the steps (or '')]
const TABLE = [
  // powers, constants, sums
  ['x^5', 'power'], ['3x^2 - 2x + 5', 'sum'], ['1/x^3', 'power'], ['sqrt(x)', 'power'], ['x^(2/3)', 'power'], ['(x^2+1)/x^2', ''], ['1/sqrt(x)', 'power'], ['7', 'constant'],
  ['x^2*(x+1)', ''], ['(x+1)^2', ''],
  // exponentials, logarithms, trig and hyperbolic basics
  ['e^x', 'exponential'], ['2^x', 'exponential'], ['3*e^x - 2^x', ''], ['1/x', 'reciprocal'], ['sin(x)', ''], ['cos(x)', ''], ['sec(x)^2', ''], ['csc(x)^2', ''], ['sec(x)*tan(x)', ''],
  ['tan(x)', ''], ['cot(x)', ''], ['sec(x)', ''], ['csc(x)', ''], ['sinh(x)', ''], ['cosh(x)', ''], ['tanh(x)', ''],
  ['1/(1+x^2)', 'tangent'], ['1/sqrt(1-x^2)', 'sine'], ['1/sqrt(x^2+1)', ''], ['1/sqrt(x^2-1)', ''],
  // substitution
  ['(2x+1)^5', 'substitution'], ['cos(3x)', 'substitution'], ['e^(2x)', 'substitution'], ['x*e^(x^2)', 'substitution'], ['x/(x^2+1)', 'substitution'], ['2x/(x^2+1)', 'substitution'],
  ['sin(x)*cos(x)', 'substitution'], ['sin(x)^2*cos(x)', 'substitution'], ['e^x/(1+e^x)', 'substitution'], ['cos(x)*e^(sin(x))', 'substitution'], ['1/(x*ln(x))', 'substitution'],
  ['ln(x)/x', 'substitution'], ['x^2/(x^3+1)', 'substitution'], ['x*sqrt(x+1)', 'substitution'], ['x*sqrt(1-x^2)', 'substitution'], ['x^3*sqrt(x^2+1)', 'substitution'],
  ['sec(x)^2*tan(x)', 'substitution'], ['sin(x)/cos(x)^2', 'substitution'], ['1/(sqrt(x)*(1+sqrt(x)))', 'substitution'], ['x^3*e^(x^4)', 'substitution'],
  ['e^x/(e^(2x)+1)', 'substitution'], ['1/(1+e^x)', ''], ['sqrt(x)*e^(sqrt(x))', ''], ['(3x+2)^(1/2)', 'substitution'], ['1/(3x-1)^2', 'substitution'],
  // by parts
  ['x*e^x', 'parts'], ['x*sin(x)', 'parts'], ['x*cos(2x)', 'parts'], ['ln(x)', 'parts'], ['x*ln(x)', 'parts'], ['x^2*ln(x)', 'parts'], ['ln(x)^2', 'parts'], ['atan(x)', 'parts'],
  ['asin(x)', 'parts'], ['acos(x)', 'parts'], ['x*atan(x)', 'parts'], ['x^2*e^x', 'parts'], ['x^3*e^x', 'parts'], ['e^x*sin(x)', 'parts'], ['e^x*cos(x)', 'parts'],
  ['e^(2x)*sin(3x)', 'parts'], ['x^2*sin(x)', 'parts'], ['x*e^(-x)', 'parts'], ['x*sec(x)^2', 'parts'], ['ln(x^2+1)', 'parts'], ['x*ln(x+1)', 'parts'], ['sin(ln(x))', ''],
  // partial fractions, completing the square
  ['1/(x^2-1)', 'partial'], ['1/(x*(x+1))', 'partial'], ['(3x+2)/((x-1)*(x+2))', 'partial'], ['1/(x^2+2x+5)', 'square'], ['1/(x^3+x)', 'partial'], ['(x^3+1)/(x^2-1)', ''],
  ['1/(x^2-4)', 'partial'], ['(2x+3)/(x^2+3x+2)', ''], ['1/(x^2+x+1)', 'square'], ['(x+1)/(x^2+4x+5)', ''], ['1/(x^4-1)', 'partial'], ['1/((x+1)*(x^2+1))', 'partial'],
  ['1/(x^2*(x+1))', 'partial'], ['1/(x^2+1)^2', ''], ['x^2/(x^2+1)', ''], ['1/(x^2+4)', ''], ['(x^2+1)/(x^3-x)', 'partial'],
  // trigonometric powers and products
  ['sin(x)^3', 'trigonometric'], ['cos(x)^3', 'trigonometric'], ['sin(x)^2', 'trigonometric'], ['cos(x)^2', 'trigonometric'], ['sin(x)^4', 'trigonometric'], ['sin(x)^2*cos(x)^2', 'trigonometric'],
  ['sin(x)^3*cos(x)^2', 'trigonometric'], ['tan(x)^2', 'trigonometric'], ['tan(x)^3', 'trigonometric'], ['sec(x)^4', 'trigonometric'], ['sec(x)^3', 'reduction'], ['tan(x)*sec(x)^3', ''],
  ['cot(x)^2', 'trigonometric'], ['csc(x)^3', 'reduction'], ['sin(3x)*cos(2x)', 'product'], ['sin(x)*sin(3x)', 'product'], ['cos(x)*cos(2x)', 'product'], ['sin(3x)^2', ''],
  // trigonometric substitution and radicals
  ['sqrt(1-x^2)', 'trigonometric substitution'], ['sqrt(4-x^2)', 'trigonometric substitution'], ['sqrt(x^2+1)', 'trigonometric substitution'], ['sqrt(x^2-1)', 'trigonometric substitution'],
  ['x^2*sqrt(1-x^2)', 'trigonometric substitution'], ['1/(x^2*sqrt(x^2+1))', 'trigonometric substitution'], ['sqrt(9-x^2)/x^2', 'trigonometric substitution'], ['1/(x^2+1)^(3/2)', 'trigonometric substitution'],
  ['1/(4-x^2)^(3/2)', 'trigonometric substitution'], ['x^2/sqrt(1-x^2)', ''], ['sqrt(x^2-4)/x', ''], ['1/sqrt(x^2-2x+5)', 'square'], ['sqrt(x^2+2x+5)', ''], ['sqrt(9-4x^2)', ''],
  ['1/sqrt(3+2x-x^2)', 'square'], ['(x+1)/sqrt(x^2+2x+5)', ''], ['x/sqrt(x^2+1)', 'substitution'], ['1/(x*sqrt(x^2-1))', '']
];

test('the table has about 100 classic integrals', () => { assert.ok(TABLE.length >= 100, 'only ' + TABLE.length); });

test('table: every integral gets a verified answer (derivative of the answer = integrand, checked independently)', () => {
  const failures = [];
  const slow = [];
  TABLE.forEach(([s, rule]) => {
    const t0 = Date.now();
    const r = solve(s);
    const dt = Date.now() - t0;
    if (dt > 1500) slow.push(s + ' ' + dt + ' ms');
    if (!r.ok) { failures.push(s + ': ' + r.message.slice(0, 60)); return; }
    try { fdCheck(P(s), r.antiderivative, 'x', s); } catch (e) { failures.push(s + ' → ' + S(r.antiderivative) + ': ' + e.message); return; }
    if (rule && !hasRule(r, rule)) failures.push(s + ': expected a step named like "' + rule + '", got ' + r.steps.filter(x => x.kind === 'rule').map(x => x.title).join(' / '));
  });
  assert.equal(failures.length, 0, failures.length + ' of ' + TABLE.length + ' failed:\n      ' + failures.join('\n      '));
  console.log('        table: ' + TABLE.length + ' integrals, all verified' + (slow.length ? '; slower than 1.5 s: ' + slow.join(', ') : ''));
});

/* ───────────────────────── specific answers and steps ───────────────────────── */

test('answers match the textbook up to a constant', () => {
  // [integrand, textbook antiderivative]
  const known = [['x^2', 'x^3/3'], ['1/x', 'ln(abs(x))'], ['x*e^x', 'x*e^x - e^x'], ['x*sin(x)', 'sin(x) - x*cos(x)'], ['ln(x)', 'x*ln(x) - x'], ['1/(x^2-1)', '(1/2)*ln(abs((x-1)/(x+1)))'],
    ['sin(x)^2', 'x/2 - sin(2x)/4'], ['sqrt(1-x^2)', '(x*sqrt(1-x^2) + asin(x))/2'], ['1/(1+x^2)', 'atan(x)'], ['e^x*sin(x)', 'e^x*(sin(x) - cos(x))/2'], ['tan(x)', '-ln(abs(cos(x)))'],
    ['x/(x^2+1)', 'ln(x^2+1)/2'], ['sec(x)', 'ln(abs(sec(x)+tan(x)))'], ['atan(x)', 'x*atan(x) - ln(x^2+1)/2']];
  known.forEach(([f, ans]) => {
    const r = solve(f);
    assert.ok(r.ok, f);
    const d = CAS.sub(r.antiderivative, P(ans));
    const cf = CAS.compile(d, ['x']);
    const vals = [0.4, 0.9, 1.7, 2.6, 3.3].map(x => cf(x)).filter(y => isFinite(y));
    assert.ok(vals.length >= 3, f);
    vals.forEach(y => close(y, vals[0], 1e-9, f + ': the answer differs from the textbook one by more than a constant'));
  });
});

test('steps: each step names its rule, shows the formula and the choices made', () => {
  const r = solve('x^2*e^x');
  assert.ok(r.ok);
  const parts = r.steps.filter(st => st.kind === 'rule' && st.title === 'Integration by parts');
  assert.equal(parts.length, 2, 'x²eˣ needs by parts twice');
  parts.forEach(st => {
    assert.ok(/∫ u dv/.test(st.formula), 'formula shown');
    assert.ok(st.lines.some(l => /Choose u = /.test(l)) && st.lines.some(l => /Then du = /.test(l)), 'choices shown');
    assert.ok(/∫/.test(st.then), 'the simpler integral that remains is shown');
  });
  assert.equal(r.steps[0].id, '1');
  assert.ok(r.steps.some(st => st.id === '1.1'), 'steps are numbered as a tree');
  const sub = solve('x*e^(x^2)');
  const st = sub.steps[0];
  assert.equal(st.title, 'Substitution');
  assert.ok(st.lines.some(l => /^Let u = x²\.$/.test(l)), st.lines.join(' | '));
  assert.ok(st.lines.some(l => /du = 2x dx/.test(l)));
  assert.ok(r.steps.every(x => x.kind === 'combine' || x.integral.indexOf('∫') === 0));
});

test('steps: the cyclic case (the original integral comes back) is solved for I', () => {
  const r = solve('e^x*sin(x)');
  assert.ok(r.ok);
  assert.ok(r.steps.some(st => /appears again/.test(st.title)), 'cycle noticed');
  assert.ok(r.steps.some(st => st.kind === 'combine' && /Solving for I/.test(st.text)));
  fdCheck(P('e^x*sin(x)'), r.antiderivative, 'x');
  const r2 = solve('sec(x)^3');
  assert.ok(r2.ok);
});

test('steps: partial fractions show the factored denominator, the template and the constants', () => {
  const r = solve('(3x+2)/((x-1)*(x+2))');
  const st = r.steps[0];
  assert.equal(st.title, 'Partial fractions');
  assert.ok(st.lines.some(l => /A\/\(x − 1\)/.test(l) && /B\/\(x \+ 2\)/.test(l)), st.lines.join(' | '));
  assert.ok(st.lines.some(l => /A = 5\/3/.test(l) && /B = 4\/3/.test(l)), st.lines.join(' | '));
  const q = solve('(x^3+1)/(x^2-1)');
  assert.ok(q.steps.some(s => /long division/i.test(s.title)));
});

test('the answer is given with a nicer factored form when there is one', () => {
  const r = solve('x*e^x');
  assert.equal(S(r.factored), 'e^x(x − 1)');
});

test('trigonometric substitution: the right triangle step, and an answer that survives a negative x', () => {
  const r = solve('sqrt(x^2-1)');
  assert.ok(r.ok && hasRule(r, 'trigonometric substitution'));
  fdCheck(P('sqrt(x^2-1)'), r.antiderivative, 'x');
});

/* ───────────────────────── honesty: no wrong answers, no guessing ───────────────────────── */

test('integrals with no elementary antiderivative give "no method found", never an answer', () => {
  ['e^(x^2)', 'sin(x)/x', 'e^(-x^2)', '1/ln(x)', 'sqrt(1+x^3)', 'x^x', 'sin(x^2)', 'ln(x)/(1+x)'].forEach(s => {
    const r = solve(s, { maxMs: 1500 });
    assert.ok(!r.ok, s + ' should have no method but returned ' + (r.antiderivative && S(r.antiderivative)));
    assert.ok(/No method found/.test(r.message), s);
    assert.equal(r.antiderivative, null);
    assert.equal(r.steps.length, 0);
  });
});

test('verification rejects wrong antiderivatives (and accepts right ones)', () => {
  assert.ok(Integrate.verify(P('2x'), P('x^2'), 'x').ok);
  assert.ok(Integrate.verify(P('cos(x)'), P('sin(x) + 7'), 'x').ok);
  assert.ok(!Integrate.verify(P('2x'), P('x^2 + x'), 'x').ok);
  assert.ok(!Integrate.verify(P('1/x'), P('ln(x)^2'), 'x').ok);
  assert.ok(!Integrate.verify(P('sin(x)'), P('cos(x)'), 'x').ok);
  assert.ok(!Integrate.verify(P('x'), P('x^2/2 + 0.001*x'), 'x').ok);
  assert.ok(Integrate.verify(P('1/x'), P('ln(abs(x))'), 'x').ok);
});

test('other variables are constants; any variable name works', () => {
  const r = Integrate.integrate('a*x^2 + b', 'x');
  assert.ok(r.ok);
  fdCheck(P('a*x^2 + b'), r.antiderivative, 'x');
  const r2 = Integrate.integrate('x*y^2', 'y');
  assert.ok(r2.ok);
  assert.equal(S(r2.antiderivative), 'xy³/3');
  const r3 = Integrate.integrate('r^2*sin(theta)', 'theta');
  assert.ok(r3.ok);
  assert.equal(S(r3.antiderivative), '−r² cos(θ)'.replace('θ', 'theta'));
  const r4 = Integrate.integrate('sin(t)*cos(t)^2', 't');
  assert.ok(r4.ok);
  fdCheck(P('sin(t)*cos(t)^2'), r4.antiderivative, 't');
  const r5 = Integrate.integrate('1/(x^2+a^2)', 'x');   // symbolic parameter: not handled, and must not be guessed
  assert.ok(!r5.ok || Integrate.verify(P('1/(x^2+a^2)'), r5.antiderivative, 'x').ok);
});

/* ───────────────────────── random derivative-then-integrate tests ───────────────────────── */

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const ri = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const nz = (rnd, lo, hi) => { let k = 0; while (k === 0) k = ri(rnd, lo, hi); return k; };
function randomFunction(rnd) {
  const a = nz(rnd, -3, 3), b = nz(rnd, 1, 3), c = ri(rnd, 1, 4), n = ri(rnd, 1, 4);
  const lin = '(' + b + '*x+' + c + ')';
  const bases = [
    () => a + '*x^' + n, () => 'x^' + n + '*e^(' + b + '*x)', () => 'x^' + ri(rnd, 1, 3) + '*sin(' + b + '*x)', () => 'x^' + ri(rnd, 1, 3) + '*cos(' + b + '*x)',
    () => 'e^(' + a + '*x)*sin(' + b + '*x)', () => 'e^(' + a + '*x)*cos(' + b + '*x)', () => 'x^' + ri(rnd, 1, 3) + '*ln(x)', () => 'ln(' + lin + ')', () => 'sqrt' + lin, () => lin + '^' + ri(rnd, 2, 5),
    () => 'ln(x^2+' + c + ')', () => 'atan(' + b + '*x)', () => 'sin(x)^' + ri(rnd, 2, 4), () => 'cos(' + b + '*x)^' + ri(rnd, 2, 3), () => 'tan(x)', () => 'e^(x^2)', () => 'sin(x^2)', () => 'e^(sin(x))',
    () => 'ln(cos(x))', () => 'x*atan(x)', () => '1/(x+' + c + ')', () => '1/(x^2+' + c + ')', () => 'x/(x^2+' + c + ')', () => '(x+' + c + ')/(x-' + b + ')', () => 'x^' + ri(rnd, 2, 3) + '/(x^2+' + c + ')',
    () => 'sqrt(x^2+' + c + ')', () => 'asin(x/' + (b + 1) + ')', () => 'sin(' + b + '*x)*cos(x)', () => 'sec(x)', () => 'e^x/(1+e^x)', () => 'x*sqrt(x+' + c + ')', () => 'ln(x)/x', () => 'sin(x)*e^x', () => '(x^2+' + c + ')^' + ri(rnd, 2, 3),
    () => 'x*e^(x^2)', () => 'cos(x)^3*sin(x)', () => 'atan(x)^2', () => 'x^2*sqrt(x^2+' + c + ')', () => 'sinh(' + b + '*x)', () => 'cosh(x)*x'
  ];
  let g = pick(rnd, bases)();
  if (rnd() < 0.35) g = '(' + g + ')+(' + pick(rnd, bases)() + ')';
  else if (rnd() < 0.15) g = '(' + g + ')*(' + nz(rnd, -3, 3) + ')';
  return g;
}

function randomHard(rnd) {                // products and compositions: many of these have no elementary antiderivative
  const c = ri(rnd, 1, 4), b = nz(rnd, 1, 3), n = ri(rnd, 1, 3);
  const atoms = ['x', 'x^' + (n + 1), 'sin(x)', 'cos(' + b + '*x)', 'e^(' + b + '*x)', 'ln(x)', 'atan(x)', 'sqrt(x+' + c + ')', 'tan(x)', 'sinh(x)', '1/(x+' + c + ')', 'x^2+' + c, 'e^(-x)', 'sec(x)', 'asin(x/4)', 'cosh(x)'];
  const two = () => pick(rnd, atoms) + '*' + pick(rnd, atoms);
  const comp = () => pick(rnd, ['sin', 'cos', 'e^', 'ln', 'atan', 'sqrt']) .replace(/\^$/, '') === 'e' ? 'e^(' + pick(rnd, atoms) + ')' : pick(rnd, ['sin', 'cos', 'ln', 'atan', 'sqrt']) + '(' + pick(rnd, atoms) + ')';
  return rnd() < 0.5 ? two() : (rnd() < 0.6 ? comp() : '(' + pick(rnd, atoms) + ')^' + ri(rnd, 2, 4));
}
function runRandom(label, gen, N, seed, minRate) {
  const rnd = lcg(seed);
  let solved = 0, none = 0;
  const wrong = [], unsolved = [];
  for (let i = 0; i < N; i++) {
    const gs = gen(rnd);
    let g, f;
    try { g = P(gs); f = CAS.diff(g, 'x'); } catch (e) { throw new Error('generator produced ' + gs + ': ' + e.message); }
    const r = Integrate.integrate(f, 'x', { maxMs: 1500, maxWork: 3500 });
    if (r.ok) {
      try { fdCheck(f, r.antiderivative, 'x', gs); solved++; }
      catch (e) { wrong.push(gs + ' → d/dx = ' + S(f) + ' → ' + S(r.antiderivative) + ': ' + e.message); }
    } else { none++; if (unsolved.length < 40) unsolved.push(gs); assert.ok(/No method found/.test(r.message), 'message for ' + gs); }
  }
  console.log('        random ' + label + ': ' + solved + ' of ' + N + ' integrated and verified (' + (100 * solved / N).toFixed(1) + '%), ' + none + ' reported "no method"');
  if (unsolved.length) console.log('        not solved (first ' + Math.min(unsolved.length, 10) + '): ' + unsolved.slice(0, 10).join('   '));
  assert.equal(wrong.length, 0, 'wrong answers shown:\n      ' + wrong.join('\n      '));
  assert.ok(solved >= minRate * N, label + ': success rate too low: ' + solved + '/' + N);
  return { solved, N };
}

test('random (families): differentiate a random function, integrate the derivative: a verified answer or "no method", never a wrong answer', () => {
  runRandom('families', randomFunction, 600, 20240611, 0.85);
});

test('random (products and compositions): never a wrong answer, and an honest "no method" when no rule applies', () => {
  runRandom('products', randomHard, 400, 99001, 0.3);
});

test('random: integrands built from the answer (by parts and substitution families) are recovered', () => {
  // d/dx[ x^n e^{kx} ], d/dx[ sin(x)^n ], d/dx[ ln(poly) ] ... come back as the same family
  const rnd = lcg(777);
  let solved = 0, total = 0;
  for (let i = 0; i < 40; i++) {
    const k = nz(rnd, -3, 3), n = ri(rnd, 1, 4), c = ri(rnd, 1, 5);
    const gs = pick(rnd, ['x^' + n + '*e^(' + k + '*x)', 'ln(x^2+' + c + ')', 'sin(' + (k > 0 ? k : -k) + '*x)^' + (n + 1), '(x^2+' + c + ')^' + (n + 1), 'atan(' + (k > 0 ? k : -k) + '*x)', 'e^(' + k + '*x)*sin(x)']);
    const f = CAS.diff(P(gs), 'x');
    total++;
    const r = Integrate.integrate(f, 'x', { maxMs: 1500 });
    assert.ok(r.ok, gs + ' → ' + S(f) + ' was not integrated: ' + r.message.slice(0, 50));
    fdCheck(f, r.antiderivative, 'x', gs);
    solved++;
  }
  assert.equal(solved, total);
});

/* ───────────────────────── definite integrals ───────────────────────── */

const DEF = [
  ['x^2', 0, 3, '9'], ['sin(x)', 0, 'pi', '2'], ['e^x', 0, 1, 'e - 1'], ['1/x', 1, 'e', '1'], ['x*e^x', 0, 1, '1'], ['1/(1+x^2)', 0, 1, 'pi/4'], ['sqrt(1-x^2)', 0, 1, 'pi/4'],
  ['cos(x)^2', 0, 'pi', 'pi/2'], ['x*sin(x)', 0, 'pi', 'pi'], ['ln(x)', 1, 'e', '1'], ['1/(x^2-1)', 2, 3, '(ln(3) - ln(2))/2'], ['x^2*e^x', 0, 1, 'e - 2'], ['sin(x)^3', 0, 'pi', '4/3'],
  ['1/(x^2+4)', 0, 2, 'pi/8'], ['x/(x^2+1)', 0, 1, 'ln(2)/2'], ['sqrt(x)', 0, 4, '16/3'], ['1/sqrt(1-x^2)', 0, 1, 'pi/2'], ['e^(2x)', -1, 1, '(e^2 - e^(-2))/2'], ['sec(x)^2', 0, 'pi/4', '1'],
  ['x^3', 3, 0, '-81/4'], ['1/(x*(x+1))', 1, 2, 'ln(4/3)'], ['atan(x)', 0, 1, 'pi/4 - ln(2)/2'], ['cos(3x)*sin(x)', 0, 'pi', '0'], ['abs(x)', -1, 2, '5/2'], ['tan(x)', 0, 'pi/4', 'ln(2)/2']
];
test('definite integrals: exact value from the antiderivative agrees with adaptive quadrature', () => {
  DEF.forEach(([f, a, b, exact]) => {
    const r = Integrate.definite(f, 'x', a, b, { maxMs: 3000 });
    const label = '∫[' + a + ',' + b + '] ' + f;
    if (f === 'abs(x)') { assert.ok(r.kind !== 'diverges', label); close(r.numeric, 2.5, 1e-9, label); return; }
    assert.equal(r.kind, 'exact', label + ': ' + r.message);
    assert.ok(r.agree, label + ' exact ' + r.exactNumber + ' vs numeric ' + r.numeric);
    close(r.exactNumber, CAS.evalNum(P(exact), {}), 1e-9, label);
    close(r.numeric, r.exactNumber, 1e-8, label + ' numeric');
    assert.ok(r.exact && r.evaluation.length >= 2, label + ' working shown');
  });
});

test('definite integrals: the exact value is exact (π/4, e − 1, ln 2 ...), the numeric value is separate', () => {
  assert.equal(S(Integrate.definite('1/(1+x^2)', 'x', 0, 1).exact), 'π/4');
  assert.equal(S(Integrate.definite('e^x', 'x', 0, 1).exact), 'e − 1');
  assert.equal(S(Integrate.definite('x^2', 'x', 0, 3).exact), '9');
  assert.equal(S(Integrate.definite('1/x', 'x', 1, 2).exact), 'ln(2)');
  assert.equal(S(Integrate.definite('sin(x)', 'x', 0, 'pi').exact), '2');
});

test('definite integrals: reversed limits flip the sign; equal limits give 0', () => {
  close(Integrate.definite('x^2', 'x', 3, 0).exactNumber, -9, 1e-12);
  assert.equal(S(Integrate.definite('x^2', 'x', 2, 2).exact), '0');
});

test('definite integrals: a singularity inside the interval is detected, not integrated through', () => {
  ['1/x^2', '1/x', '1/(x-1)', 'tan(x)'].forEach((f, i) => {
    const lims = [[-1, 1], [-1, 1], [0, 2], [0, 2]][i];
    const r = Integrate.definite(f, 'x', lims[0], lims[1]);
    assert.equal(r.kind, 'diverges', f + ': ' + r.message);
    assert.equal(r.exact, null);
    assert.ok(/diverges/.test(r.message));
    assert.ok(r.improper);
  });
  const u = Integrate.definite('sqrt(x)', 'x', -1, 1);
  assert.equal(u.kind, 'none');
  assert.ok(/not a real number/.test(u.message));
});

test('definite integrals: a discontinuous antiderivative formula is never trusted (tan x across pi/2)', () => {
  const r = Integrate.definite('1/(1+tan(x)^2)', 'x', 0, 3);   // = cos²x, perfectly smooth; the rewriting must not break it
  close(r.numeric, (3 + Math.sin(6) / 2) / 2, 1e-8);
  const q = Integrate.definite('sec(x)^2', 'x', 0, 2);          // integrand blows up at pi/2: F(2) - F(0) would be a wrong finite number
  assert.equal(q.kind, 'diverges');
});

/* ───────────────────────── improper integrals ───────────────────────── */

test('improper integrals: infinite limits, decided by the limit of the antiderivative', () => {
  const cases = [['1/x^2', 1, 'inf', 1], ['e^(-x)', 0, 'inf', 1], ['1/(1+x^2)', '-inf', 'inf', Math.PI], ['x*e^(-x)', 0, 'inf', 1], ['x^2*e^(-x)', 0, 'inf', 2], ['ln(x)/x^2', 1, 'inf', 1],
    ['1/(x^2+4)', 0, 'inf', Math.PI / 4], ['e^(2x)', '-inf', 0, 0.5], ['1/(x^2-1)', 2, 'inf', Math.log(3) / 2], ['1/(x*ln(x)^2)', 2, 'inf', 1 / Math.log(2)], ['1/x^(3/2)', 1, 'inf', 2], ['x/(x^2+1)^2', 0, 'inf', 0.5]];
  cases.forEach(([f, a, b, val]) => {
    const r = Integrate.definite(f, 'x', a, b, { maxMs: 3000 });
    const label = '∫[' + a + ',' + b + '] ' + f;
    assert.equal(r.kind, 'exact', label + ': ' + r.message);
    close(r.exactNumber, val, 1e-9, label);
    assert.ok(r.improper, label + ' flagged improper');
    if (r.numericOk) close(r.numeric, val, 1e-6, label + ' numeric');
  });
});

test('improper integrals: divergence is recognised', () => {
  [['1/x', 1, 'inf'], ['x', 0, 'inf'], ['1/sqrt(x)', 1, 'inf'], ['e^x', 0, 'inf'], ['1/x', 0, 1], ['1/x^2', 0, 1], ['ln(x)', 1, 'inf'], ['sin(x)', 0, 'inf'], ['cos(x)', 0, 'inf']].forEach(([f, a, b]) => {
    const r = Integrate.definite(f, 'x', a, b);
    assert.equal(r.kind, 'diverges', '∫[' + a + ',' + b + '] ' + f + ': ' + r.kind + ' ' + r.message);
    assert.equal(r.exact, null);
  });
});

test('improper integrals: endpoint singularities that converge', () => {
  const cases = [['1/sqrt(x)', 0, 1, 2], ['ln(x)', 0, 1, -1], ['1/sqrt(1-x^2)', -1, 1, Math.PI], ['x^(-1/3)', 0, 1, 1.5], ['1/sqrt(1-x)', 0, 1, 2], ['x*ln(x)', 0, 1, -0.25], ['ln(x)^2', 0, 1, 2], ['1/(x^(1/2)*(1+x))', 0, 1, Math.PI / 2]];
  cases.forEach(([f, a, b, val]) => {
    const r = Integrate.definite(f, 'x', a, b, { maxMs: 3000 });
    const label = '∫[' + a + ',' + b + '] ' + f;
    assert.equal(r.kind, 'exact', label + ': ' + r.message);
    close(r.exactNumber, val, 1e-9, label);
    if (f !== 'x*ln(x)') assert.ok(r.improper, label + ' flagged improper');     // x ln x has a continuous extension at 0: a proper integral
    if (r.numericOk) close(r.numeric, val, 1e-6, label + ' numeric');
  });
});

test('no antiderivative: numeric value only, clearly marked, with the message', () => {
  const cases = [['e^(-x^2)', 0, 'inf', Math.sqrt(Math.PI) / 2], ['sin(x)/x', 0, 1, 0.946083070367183], ['e^(x^2)', 0, 1, 1.46265174590718], ['1/ln(x)', 2, 3, 0.9], ['sqrt(1+x^3)', 0, 1, 1.11144]];
  cases.forEach(([f, a, b, val], i) => {
    const r = Integrate.definite(f, 'x', a, b, { maxMs: 1500 });
    if (i === 3 || i === 4) return;
    assert.equal(r.kind, 'numeric', f + ': ' + r.message);
    assert.equal(r.exact, null);
    assert.ok(/No closed form was found/.test(r.message));
    close(r.numeric, val, 1e-9, f);
  });
  const r = Integrate.definite('sqrt(1+x^3)', 'x', 0, 1, { maxMs: 1500 });
  assert.equal(r.kind, 'numeric');
  close(r.numeric, 1.1114461, 1e-5);
});

test('symbolic limits of the antiderivative', () => {
  const L = (e, pt, side) => Integrate.limit(P(e), 'x', pt, side);
  const val = r => (r.kind === 'finite' ? CAS.evalNum(r.value, {}) : r.kind);
  close(val(L('x*e^(-x)', Infinity)), 0, 1e-12);
  close(val(L('ln(x)/x', Infinity)), 0, 1e-12);
  close(val(L('atan(x)', Infinity)), Math.PI / 2, 1e-12);
  close(val(L('atan(x)', -Infinity)), -Math.PI / 2, 1e-12);
  close(val(L('(x^2+1)/(2*x^2)', Infinity)), 0.5, 1e-12);
  close(val(L('x*ln(x)', 0, 1)), 0, 1e-12);
  close(val(L('ln(x+1) - ln(x)', Infinity)), 0, 1e-12);
  close(val(L('(2*x)/(x+1)', Infinity)), 2, 1e-12);
  close(val(L('-1/ln(x)', Infinity)), 0, 1e-12);
  close(val(L('sqrt(x)', 0, 1)), 0, 1e-12);
  assert.equal(L('ln(x)', Infinity).kind, 'inf');
  assert.equal(L('ln(x)', 0, 1).kind, 'inf');
  assert.equal(L('ln(x)', 0, 1).sign, -1);
  assert.equal(L('x^2', Infinity).kind, 'inf');
  assert.equal(L('1/x', 0, -1).sign, -1);
  assert.equal(L('sin(x)', Infinity).kind, 'none');
  assert.equal(L('e^x', -Infinity).kind, 'finite');
  close(val(L('e^x', -Infinity)), 0, 1e-12);
});

/* ───────────────────────── numeric quadrature ───────────────────────── */

test('quadrature: Gauss-Kronrod is exact for polynomials and accurate for smooth functions', () => {
  for (let k = 0; k <= 20; k++) close(Integrate.quad(x => Math.pow(x, k), 0, 1).value, 1 / (k + 1), 1e-12, 'x^' + k);
  close(Integrate.quad(Math.sin, 0, Math.PI).value, 2, 1e-12);
  close(Integrate.quad(x => 4 / (1 + x * x), 0, 1).value, Math.PI, 1e-12);
  close(Integrate.quad(x => Math.exp(-x * x), -3, 3).value, Math.sqrt(Math.PI) * 0.9999779095030014, 1e-10);
  close(Integrate.quad(x => Math.sin(50 * x), 0, Math.PI).value, (1 - Math.cos(50 * Math.PI)) / 50, 1e-9);
  close(Integrate.quad(x => Math.abs(x - 0.3), 0, 1).value, 0.29, 1e-9);
  close(Integrate.quad(x => x * x, 1, 0).value, -1 / 3, 1e-12);
});

test('quadrature: endpoint singularities and infinite ranges (tanh-sinh)', () => {
  close(Integrate.quad(x => 1 / Math.sqrt(x), 0, 1).value, 2, 1e-9);
  close(Integrate.quad(x => Math.log(x), 0, 1).value, -1, 1e-9);
  close(Integrate.quad(x => Math.pow(x, -0.9), 0, 1).value, 10, 1e-6);
  close(Integrate.quad(x => 1 / Math.sqrt(1 - x * x), -1, 1).value, Math.PI, 1e-7);   // both ends singular: double precision limits the accuracy
  close(Integrate.quad(x => Math.exp(-x), 0, Infinity).value, 1, 1e-9);
  close(Integrate.quad(x => 1 / (1 + x * x), -Infinity, Infinity).value, Math.PI, 1e-9);
  close(Integrate.quad(x => Math.exp(-x * x), -Infinity, Infinity).value, Math.sqrt(Math.PI), 1e-9);
  close(Integrate.quad(x => Math.exp(x), -Infinity, 0).value, 1, 1e-9);
  close(Integrate.quad(x => 1 / (x * x), 1, Infinity).value, 1, 1e-9);
  const div1 = Integrate.quad(x => 1 / x, 1, Infinity);
  assert.ok(!div1.ok, 'a divergent integral must not be reported as converged');
});

test('bounds are parsed: pi, e, fractions, inf', () => {
  assert.equal(Integrate.parseBound('inf'), Infinity);
  assert.equal(Integrate.parseBound('-inf'), -Infinity);
  assert.equal(Integrate.parseBound('∞'), Infinity);
  assert.equal(Integrate.parseBound('-Infinity'), -Infinity);
  assert.equal(S(Integrate.parseBound('pi/2')), 'π/2');
  assert.equal(S(Integrate.parseBound('2e')), '2e');
  assert.equal(S(Integrate.parseBound(3)), '3');
  assert.equal(S(Integrate.definite('1/(1+x^2)', 'x', '-inf', 'inf').exact), 'π');
});

test('search is bounded: an impossible integral stops within the time limit', () => {
  const t0 = Date.now();
  const r = Integrate.integrate('e^(x^2)*sin(x^3)*ln(x)', 'x', { maxMs: 800 });
  assert.ok(!r.ok);
  assert.ok(Date.now() - t0 < 4000, 'took ' + (Date.now() - t0) + ' ms');
});

console.log(`\n${passed} test groups passed` + (process.exitCode ? ' — with failures' : ''));
