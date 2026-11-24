// Run with:  node tests/cas.test.js
const assert = require('node:assert/strict');
const CAS = require('../js/cas.js');

let passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log('  ok  ' + name + '  (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const P = CAS.parse, S = e => CAS.toString(e), A = e => CAS.toString(e, { ascii: true });
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a} (rel err ${err.toExponential(2)})`);
};
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const ri = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/* A random expression made as text and, at the same time, as a plain JavaScript function. The function is the
   independent reference: it uses Math directly and shares no code with CAS. */
function genExpr(rnd, depth, vars) {
  if (depth <= 0 || rnd() < 0.18) {
    const r = rnd();
    if (r < 0.5) { const v = pick(rnd, vars); return { s: v, f: env => env[v] }; }
    if (r < 0.8) { const n = ri(rnd, 1, 5); return { s: String(n), f: () => n }; }
    const a = ri(rnd, 1, 5), b = ri(rnd, 2, 6);
    return { s: '(' + a + '/' + b + ')', f: () => a / b };
  }
  const k = Math.floor(rnd() * 12), a = genExpr(rnd, depth - 1, vars);
  switch (k) {
    case 0: case 1: { const b = genExpr(rnd, depth - 1, vars); return { s: '(' + a.s + '+' + b.s + ')', f: e => a.f(e) + b.f(e) }; }
    case 2: { const b = genExpr(rnd, depth - 1, vars); return { s: '(' + a.s + '-' + b.s + ')', f: e => a.f(e) - b.f(e) }; }
    case 3: case 4: { const b = genExpr(rnd, depth - 1, vars); return { s: '(' + a.s + '*' + b.s + ')', f: e => a.f(e) * b.f(e) }; }
    case 5: { const b = genExpr(rnd, depth - 1, vars); if (CAS.tryParse(b.s).ok && CAS.isZero(CAS.parse(b.s))) return a; return { s: '(' + a.s + '/' + b.s + ')', f: e => a.f(e) / b.f(e) }; }
    case 6: { const n = ri(rnd, 2, 4); return { s: '(' + a.s + ')^' + n, f: e => Math.pow(a.f(e), n) }; }
    case 7: return { s: 'sin(' + a.s + ')', f: e => Math.sin(a.f(e)) };
    case 8: return { s: 'cos(' + a.s + ')', f: e => Math.cos(a.f(e)) };
    case 9: return { s: 'e^(' + a.s + ')', f: e => Math.exp(a.f(e)) };
    case 10: return { s: 'ln(' + a.s + ')', f: e => Math.log(a.f(e)) };
    default: return { s: 'sqrt(' + a.s + ')', f: e => Math.sqrt(a.f(e)) };
  }
}
function randomPoint(rnd, vars) { const env = {}; vars.forEach(v => { env[v] = (rnd() < 0.7 ? 0.2 + 2.3 * rnd() : -2.5 + 2.3 * rnd()); }); return env; }

/* ───────────────────────── parser ───────────────────────── */

test('parser: typed input and implicit multiplication', () => {
  const same = (a, b) => assert.equal(P(a).k, P(b).k, a + ' vs ' + b);
  same('2x', '2*x'); same('3sin(x)', '3*sin(x)'); same('x(x+1)', 'x*(x+1)'); same('(x+1)(x-1)', '(x+1)*(x-1)'); same('2x^2', '2*(x^2)'); same('x^2*sin(x)', 'x^2 sin(x)');
  same('sin x cos x', 'sin(x)*cos(x)'); same('sin 2x', 'sin(2*x)'); same('sin^2(x)', 'sin(x)^2'); same('sin²x', 'sin(x)^2'); same('e^-x', 'e^(-x)'); same('-x^2', '-(x^2)');
  same('xy', 'x*y'); same('2pi', '2*pi'); same('pi r^2', 'pi*r^2'); same('sqrt(x)', 'x^(1/2)'); same('√x', 'sqrt(x)'); same('√(x+1)', 'sqrt(x+1)'); same('abs(x)', 'abs(x)'); same('ln(x)', 'log(x)');
  same('exp(2x)', 'e^(2x)'); same('1/2x', 'x/2'); same('x^1/2', 'x/2'); same('arctan(x)', 'atan(x)'); same('x**2', 'x^2'); same('x²', 'x^2'); same('x³y', 'x^3*y'); same('−x', '-x'); same('2·x', '2*x');
  same('x^y^z', 'x^(y^z)'); same('2^3^2', '2^9'); same('(x+1)^2', '(x+1)*(x+1)'); same('0.5x', 'x/2'); same('1e-2', '1/100'); same('theta r', 'r*theta'); same('log10(x)', 'ln(x)/ln(10)'); same('cbrt(x)', 'x^(1/3)');
  same('3(x+1)(x-1)', '3*(x+1)*(x-1)'); same('x sin x', 'x*sin(x)'); same('tan x^2', 'tan(x^2)'); same('2sin x cos x', '2*sin(x)*cos(x)'); same('sinh 2x', 'sinh(2*x)'); same('x^2y^3', 'x^2*y^3'); same('[x+1]', '(x+1)');
});

test('parser: exact numbers', () => {
  assert.equal(S(P('0.1 + 0.2')), '3/10');
  assert.equal(S(P('1/3 + 1/6')), '1/2');
  assert.equal(S(P('2/4')), '1/2');
  assert.equal(S(P('12345678901234567890 * 98765432109876543210')), '1219326311370217952237463801111263526900');
  assert.equal(S(P('2^100')), '1267650600228229401496703205376');
  assert.equal(S(P('(2/3)^3')), '8/27');
  assert.equal(S(P('1.5e3')), '1500');
  assert.equal(S(P('7/0.25')), '28');
});

test('parser: radicals stay exact and are put in lowest form', () => {
  assert.equal(S(P('sqrt(12)')), '2√3');
  assert.equal(S(P('sqrt(8)')), '2√2');
  assert.equal(S(P('1/sqrt(3)')), '√3/3');
  assert.equal(S(P('sqrt(2)*sqrt(2)')), '2');
  assert.equal(S(P('sqrt(2)*sqrt(3)')), '√2·√3');
  assert.equal(S(P('sqrt(18)/sqrt(2)')), '3');
  assert.equal(S(P('sqrt(1/4)')), '1/2');
  assert.equal(S(P('8^(1/3)')), '2');
  assert.equal(S(P('(-8)^(1/3)')), '−2');
  assert.equal(S(P('(3/4)^(1/2)')), '√3/2');
  assert.equal(S(P('4^(3/2)')), '8');
  assert.equal(S(P('(2^(1/2))^2')), '2');
  assert.equal(S(P('2^(1/2)^2')), '2^(1/4)', '^ groups from the right');
});

test('parser: plain-language errors say what is wrong and where', () => {
  const err = (text, ...frags) => {
    const r = CAS.tryParse(text);
    assert.ok(!r.ok, 'should not parse: ' + text);
    frags.forEach(f => assert.ok(r.error.message.indexOf(f) >= 0, '"' + text + '" → ' + r.error.message + ' (missing "' + f + '")'));
    assert.ok(r.error.pos >= 0 && r.error.end >= r.error.pos);
    return r.error;
  };
  err('', 'Type an expression');
  err('   ', 'Type an expression');
  err('x+', 'stops after the "+"', 'character 2');
  err('*x', 'cannot start with "*"', 'character 1');
  err('2 +* 3', 'Two operators in a row', 'character 3', 'character 4');
  err('(x+1', 'never closed', 'character 1');
  err('x+1)', 'no opening bracket', 'character 4');
  err('()', 'nothing between the brackets');
  err('x^', 'stops after the "^"');
  err('foo(x)', '"foo"', 'not a function I know', 'character 1');
  err('x2', 'ambiguous', 'x^2');
  err('x = 3', 'equation');
  err('sin^-1(x)', 'ambiguous', 'asin');
  err('x, y', 'comma');
  err('x!', 'Factorials');
  err('|x|', 'abs(x)');
  err('1.2.3', 'two decimal points');
  err('sin()', 'nothing between the brackets');
  err('3 $ 4', 'I do not understand the character "$"', 'character 3');
  err('1/0', 'divides by zero');
  err('sin', 'needs an argument');
  err('((x)', 'never closed');
  err('x + (y * )', 'Something is missing');
  const e = err('x+*', 'Two operators');
  assert.equal(e.pos, 1);
  assert.throws(() => CAS.parse('x+'));
  const w = CAS.parseWithNotes('1/2x');
  assert.equal(S(w.expr), 'x/2');
  assert.ok(w.notes.length === 1 && /divides by 2 only/.test(w.notes[0]), w.notes.join('|'));
  assert.ok(CAS.parseWithNotes('x^1/2').notes[0].indexOf('^(1/2)') >= 0);
  assert.ok(CAS.parseWithNotes('log(x)').notes[0].indexOf('natural logarithm') >= 0);
  assert.ok(CAS.parseWithNotes('e^2x').notes[0].indexOf('e^(') >= 0);
  assert.equal(CAS.parseWithNotes('x^2 + 3x').notes.length, 0);
});

test('printing: readable text, and ascii text that reads back as the same expression', () => {
  const cases = { 'x^2*sin(x)': 'x² sin(x)', '1/(x^2+1)': '1/(x² + 1)', 'x/2': 'x/2', '3x^2/4': '3x²/4', 'sqrt(x^2+1)': '√(x² + 1)', 'pi*r^2': 'π r²', 'e^(2x)': 'e^(2x)', '-x': '−x',
    'x - 1': 'x − 1', '1 - x^2': '1 − x²', 'sin(x)^2': 'sin(x)²', 'atan(x)': 'arctan(x)', '2/(3x)': '2/(3x)', 'x^(3/2)': 'x^(3/2)', '1/sqrt(x)': '1/√x', '(x+1)^3': '(x + 1)³', 'x^y': 'x^y', '2^x': '2^x',
    '1/(x(x+1))': '1/(x(x + 1))', '(x+1)/(x-1)': '(x + 1)/(x − 1)', 'x*e^x': 'x e^x', 'ln(abs(x))': 'ln(abs(x))', '2*pi': '2π', 'x*y*z': 'xyz' };
  Object.keys(cases).forEach(k => assert.equal(S(P(k)), cases[k], k));
  assert.equal(A(P('x^2*sin(x)')), 'x^2*sin(x)');
  assert.equal(A(P('sqrt(x^2+1)')), 'sqrt(x^2 + 1)');
  assert.equal(A(P('1/(x^2+1)')), '1/(x^2 + 1)');
  assert.equal(A(P('pi*x')), 'pi*x');
});

test('printing: parse(print(e)) is e again (readable form and ascii form), on 400 random expressions', () => {
  const rnd = lcg(12345);
  const bad = [];
  for (let i = 0; i < 400; i++) {
    const g = genExpr(rnd, 4, ['x', 'y']);
    const e = P(g.s);
    for (const [name, txt] of [['text', S(e)], ['ascii', A(e)]]) {
      let back;
      try { back = P(txt); } catch (er) { bad.push(name + ': ' + g.s + ' printed as ' + txt + ' fails: ' + er.message); continue; }
      if (back.k !== e.k) bad.push(name + ': ' + g.s + ' printed as ' + txt + ' reads back as ' + S(back));
    }
  }
  assert.equal(bad.length, 0, bad.slice(0, 5).join('\n      '));
});

/* ───────────────────────── canonical form and exact arithmetic ───────────────────────── */

test('simplification: like terms, constants, powers and ordering', () => {
  const eq = (a, b) => assert.equal(P(a).k, P(b).k, a + ' vs ' + b);
  eq('x + x', '2x'); eq('2x + 3x', '5x'); eq('x - x', '0'); eq('x*x', 'x^2'); eq('x^2*x^3', 'x^5'); eq('x^2/x', 'x'); eq('x/x', '1'); eq('(x+1)^2/(x+1)', 'x+1'); eq('2*3 + 4', '10');
  eq('1/2 + 1/3', '5/6'); eq('x*0', '0'); eq('x*1', 'x'); eq('x^0', '1'); eq('x^1', 'x'); eq('0^2', '0'); eq('(x^2)^3', 'x^6'); eq('(2x)^3', '8x^3'); eq('sqrt(x)*sqrt(x)', 'x'); eq('e^x*e^(2x)', 'e^(3x)');
  eq('e^x/e^x', '1'); eq('2^x*2^(-x)', '1'); eq('y*x', 'x*y'); eq('x+y', 'y+x'); eq('3 + x + 2', 'x + 5'); eq('sin(x)+sin(x)', '2sin(x)'); eq('sin(x)*sin(x)', 'sin(x)^2');
  eq('sin(-x)', '-sin(x)'); eq('cos(-x)', 'cos(x)'); eq('tan(-2x)', '-tan(2x)'); eq('abs(-x)', 'abs(x)'); eq('abs(x^2)', 'x^2'); eq('abs(-3)', '3'); eq('sqrt(x^2)', 'abs(x)'); eq('(x^3)^(1/3)', 'x');
  eq('ln(e)', '1'); eq('ln(1)', '0'); eq('ln(e^x)', 'x'); eq('e^ln(x)', 'x'); eq('e^(2ln(x))', 'x^2'); eq('ln(4)', '2ln(2)'); eq('ln(2/3)', 'ln(2) - ln(3)'); eq('sin(0)', '0'); eq('cos(0)', '1'); eq('atan(0)', '0');
  eq('sin(asin(x))', 'x'); eq('cos(pi)', '-1'); eq('sin(pi)', '0'); eq('sin(pi/6)', '1/2'); eq('cos(pi/3)', '1/2'); eq('sin(pi/4)', 'sqrt(2)/2'); eq('tan(pi/4)', '1'); eq('cos(2pi)', '1'); eq('sin(pi/3)', 'sqrt(3)/2');
  eq('sec(pi)', '-1'); eq('atan(1)', 'pi/4'); eq('asin(1)', 'pi/2'); eq('asin(1/2)', 'pi/6'); eq('acos(0)', 'pi/2'); eq('acos(1/2)', 'pi/3'); eq('atan(sqrt(3))', 'pi/3'); eq('atan(-1)', '-pi/4');
  eq('2(x+1)', '2x+2'); eq('-(x+1)', '-x-1'); eq('(x+1)*3 - 3x', '3'); eq('x^2 + 2x + 1 - (x+1)^2', 'x^2 + 2x + 1 - (x+1)^2');
  // ordering: descending powers, constants last, numeric coefficient first
  assert.equal(S(P('1 + x + x^3 + 2x^2')), 'x³ + 2x² + x + 1');
  assert.equal(S(P('y + x')), 'x + y');
  assert.equal(S(P('x*3')), '3x');
});

test('simplification: Pythagorean identities', () => {
  const sx = s => S(CAS.simplify(P(s)));
  assert.equal(sx('sin(x)^2 + cos(x)^2'), '1');
  assert.equal(sx('3sin(2x)^2 + 3cos(2x)^2'), '3');
  assert.equal(sx('1 - sin(x)^2'), 'cos(x)²');
  assert.equal(sx('1 - cos(x)^2'), 'sin(x)²');
  assert.equal(sx('sec(x)^2 - 1'), 'tan(x)²');
  assert.equal(sx('1 + tan(x)^2'), 'sec(x)²');
  assert.equal(sx('cosh(x)^2 - sinh(x)^2'), '1');
  assert.equal(sx('x*sin(x)^2 + x*cos(x)^2'), 'x');
  assert.equal(sx('sin(x)^2 + cos(x)^2 + y'), 'y + 1');
  assert.equal(CAS.canon(P('sin(x)^2 + cos(x)^2')).k, P('sin(x)^2 + cos(x)^2').k, 'canon alone leaves identities alone');
});

/* ───────────────────────── exact arithmetic never loses digits ───────────────────────── */

test('exact arithmetic: fractions never become floats', () => {
  let e = P('0');
  for (let k = 1; k <= 30; k++) e = CAS.add(e, CAS.num(1, k * (k + 1)));
  assert.equal(S(e), '30/31');                      // telescoping sum 1/(k(k+1)) = 1 - 1/31
  const big = CAS.pow(P('3/7'), P('40'));
  assert.equal(CAS.mul(big, CAS.pow(P('7/3'), P('40'))).k, CAS.ONE.k);
  assert.equal(S(P('x/3 + x/6')), 'x/2');
  assert.equal(S(CAS.diff(P('x^(1/3)'), 'x')), '1/(3x^(2/3))');
});

/* ───────────────────────── differentiation ───────────────────────── */

const DTABLE = [
  ['x^3', '3x^2'], ['5', '0'], ['x', '1'], ['sin(x)', 'cos(x)'], ['cos(x)', '-sin(x)'], ['tan(x)', 'sec(x)^2'], ['cot(x)', '-csc(x)^2'], ['sec(x)', 'sec(x)*tan(x)'], ['csc(x)', '-csc(x)*cot(x)'],
  ['e^x', 'e^x'], ['2^x', '2^x*ln(2)'], ['ln(x)', '1/x'], ['ln(abs(x))', '1/x'], ['sqrt(x)', '1/(2*sqrt(x))'], ['1/x', '-1/x^2'], ['asin(x)', '1/sqrt(1-x^2)'], ['acos(x)', '-1/sqrt(1-x^2)'], ['atan(x)', '1/(1+x^2)'],
  ['sinh(x)', 'cosh(x)'], ['cosh(x)', 'sinh(x)'], ['tanh(x)', '1/cosh(x)^2'], ['asinh(x)', '1/sqrt(x^2+1)'], ['acosh(x)', '1/sqrt(x^2-1)'], ['atanh(x)', '1/(1-x^2)'],
  ['x^2*sin(x)', '2x*sin(x) + x^2*cos(x)'], ['sin(x)/x', '(x*cos(x) - sin(x))/x^2'], ['(x^2+1)^5', '10x*(x^2+1)^4'], ['sin(x^2)', '2x*cos(x^2)'], ['e^(2x)', '2e^(2x)'], ['x^x', 'x^x*(ln(x)+1)'],
  ['ln(x^2+1)', '2x/(x^2+1)'], ['sqrt(x^2+1)', 'x/sqrt(x^2+1)'], ['x*e^x', 'e^x + x*e^x'], ['sin(x)^2', '2sin(x)cos(x)'], ['atan(2x)', '2/(1+4x^2)'], ['x^(-1/2)', '-1/(2x^(3/2))'], ['(x+1)/(x-1)', '-2/(x-1)^2'],
  ['e^x*sin(x)', 'e^x*sin(x) + e^x*cos(x)'], ['ln(sin(x))', 'cos(x)/sin(x)'], ['tan(x)^2', '2tan(x)sec(x)^2'], ['abs(x)', 'sign(x)'], ['x^2*y^3', '2x*y^3'], ['cos(x*y)', '-y*sin(x*y)'], ['a*x^2 + b*x + c', '2a*x + b'],
  ['1/(1+x^2)', '-2x/(1+x^2)^2'], ['x^n', 'n*x^(n-1)'], ['e^(x^2)', '2x*e^(x^2)'], ['ln(x)/x', '(1 - ln(x))/x^2'], ['acos(2x)', '-2/sqrt(1-4x^2)'], ['sqrt(1-x^2)', '-x/sqrt(1-x^2)'], ['2^(x^2)', '2x*2^(x^2)*ln(2)']
];
test('derivatives: a table of known results', () => {
  const bad = [];
  DTABLE.forEach(([f, df]) => { const d = CAS.diff(P(f), 'x'); if (!CAS.equal(d, P(df))) bad.push(f + ' → ' + S(d) + ' but expected ' + df); });
  assert.equal(bad.length, 0, bad.join('\n      '));
});

test('derivatives: partial derivatives treat the other variables as constants', () => {
  assert.equal(S(CAS.diff(P('x^2*y + y^3'), 'y')), 'x² + 3y²');
  assert.equal(S(P('y^2 + x*y + x^2 + y + x')), 'x² + xy + y² + x + y');
  assert.equal(S(CAS.diff(P('x^2*y + y^3'), 'x')), '2xy');
  assert.equal(S(CAS.diff(P('sin(x*y)'), 'y')), 'x cos(xy)');
  assert.equal(S(CAS.diff(P('r^2*sin(theta)'), 'r')), '2r sin(theta)');
  assert.equal(S(CAS.diff(CAS.diff(P('x^3*y^2'), 'x'), 'y')), '6x²y');
  assert.equal(S(CAS.diff(P('z'), 'x')), '0');
  const st = CAS.diffSteps(P('x^2*y'), 'x');
  assert.deepEqual(st.others, ['y']);
  assert.ok(st.steps.some(s => /y is treated as a constant|does not depend|treated as a constant/.test(s.text)), 'steps say y is a constant');
});

test('derivatives: the steps name the rule at each stage', () => {
  const rules = e => CAS.diffSteps(P(e), 'x').steps.map(s => s.rule);
  assert.ok(rules('x^2*sin(x)').indexOf('Product rule') === 0);
  assert.ok(rules('sin(x)/x').indexOf('Quotient rule') === 0);
  assert.ok(rules('sin(x^2)').indexOf('Chain rule') === 0);
  assert.ok(rules('(x^2+1)^5').indexOf('Power rule with the chain rule') === 0);
  assert.ok(rules('x^3 + x').indexOf('Sum rule') === 0);
  assert.ok(rules('5*x^2').indexOf('Constant multiple rule') === 0);
  assert.ok(rules('e^(2x)').indexOf('Exponential rule') === 0);
  assert.ok(rules('x^x').some(r => /General power rule/.test(r)));
  assert.ok(rules('x^4').indexOf('Power rule') === 0);
  assert.ok(rules('ln(abs(x))')[0] === 'Logarithm of an absolute value');
  const st = CAS.diffSteps(P('x^2*sin(3x)'), 'x');
  assert.equal(S(st.result), '3x² cos(3x) + 2x sin(3x)');
  assert.equal(st.steps[0].depth, 0);
  assert.ok(st.steps.some(s => s.depth === 1) && st.steps.some(s => s.depth === 2), 'nested steps have depths');
  st.steps.forEach(s => { assert.ok(s.rule && s.text && s.formula !== undefined && s.result, 'each step has a rule, a sentence, a formula and a result'); });
});

test('derivatives: agree with central finite differences on 300 random expressions', () => {
  const rnd = lcg(777);
  let checked = 0;
  const bad = [];
  for (let i = 0; i < 300; i++) {
    const g = genExpr(rnd, 3, ['x', 'y']);
    const e = P(g.s), d = CAS.diff(e, 'x');
    const df = CAS.compile(d, ['x', 'y']);
    for (let t = 0; t < 4; t++) {
      const env = randomPoint(rnd, ['x', 'y']);
      const h = 1e-5, f0 = g.f(env);
      const a = g.f({ x: env.x + 2 * h, y: env.y }), b = g.f({ x: env.x + h, y: env.y }), c = g.f({ x: env.x - h, y: env.y }), dd = g.f({ x: env.x - 2 * h, y: env.y });
      const fd = (-a + 8 * b - 8 * c + dd) / (12 * h), sym = df(env.x, env.y);
      const h2 = 4 * h, fd2 = (-g.f({ x: env.x + 2 * h2, y: env.y }) + 8 * g.f({ x: env.x + h2, y: env.y }) - 8 * g.f({ x: env.x - h2, y: env.y }) + g.f({ x: env.x - 2 * h2, y: env.y })) / (12 * h2);
      if (!(Math.abs(fd - fd2) <= 1e-5 * Math.max(1, Math.abs(fd)))) continue;       // too wild for finite differences to be a fair judge
      if (!isFinite(f0) || !isFinite(fd) || !isFinite(sym) || Math.abs(fd) > 1e3 || Math.abs(sym) > 1e3 || Math.abs(f0) > 1e6) continue;
      checked++;
      if (Math.abs(fd - sym) > 1e-5 * Math.max(1, Math.abs(fd))) bad.push(g.s + ' at x=' + env.x.toFixed(3) + ', y=' + env.y.toFixed(3) + ': finite difference ' + fd + ', symbolic ' + sym + ' (' + S(d) + ')');
    }
  }
  assert.ok(checked > 400, 'only ' + checked + ' valid sample points');
  assert.equal(bad.length, 0, bad.slice(0, 4).join('\n      '));
});

/* ───────────────────────── the value never changes ───────────────────────── */

test('simplification never changes the value: 600 random expressions against an independent evaluator', () => {
  const rnd = lcg(31337);
  let checked = 0;
  const bad = [];
  for (let i = 0; i < 600; i++) {
    const g = genExpr(rnd, 4, ['x', 'y']);
    const e = P(g.s), fe = CAS.compile(e, ['x', 'y']);
    const fx = CAS.compile(CAS.expand(e), ['x', 'y']), fs = CAS.compile(CAS.simplify(e), ['x', 'y']);
    for (let t = 0; t < 4; t++) {
      const env = randomPoint(rnd, ['x', 'y']);
      const ref = g.f(env);
      if (!isFinite(ref) || Math.abs(ref) > 1e7) continue;
      const vals = [fe(env.x, env.y), fx(env.x, env.y), fs(env.x, env.y)];
      checked++;
      vals.forEach((v, k) => { if (!(Math.abs(v - ref) <= 1e-7 * Math.max(1, Math.abs(ref)))) bad.push(['parsed', 'expanded', 'simplified'][k] + ' ' + g.s + ' at ' + JSON.stringify(env) + ': ' + v + ' vs reference ' + ref); });
    }
  }
  assert.ok(checked > 900, 'only ' + checked + ' valid points');
  assert.equal(bad.length, 0, bad.slice(0, 4).join('\n      '));
});

test('together, factorCommon and replace keep the value', () => {
  const rnd = lcg(99);
  let checked = 0;
  for (let i = 0; i < 150; i++) {
    const g = genExpr(rnd, 3, ['x', 'y']);
    const e = P(g.s);
    const T = CAS.together(e), fT = CAS.compile(CAS.div(T.n, T.d), ['x', 'y']), fF = CAS.compile(CAS.factorCommon(e), ['x', 'y']);
    for (let t = 0; t < 3; t++) {
      const env = randomPoint(rnd, ['x', 'y']), ref = g.f(env);
      if (!isFinite(ref) || Math.abs(ref) > 1e6) continue;
      checked++;
      close(fT(env.x, env.y), ref, 1e-7, 'together ' + g.s);
      close(fF(env.x, env.y), ref, 1e-7, 'factorCommon ' + g.s);
    }
  }
  assert.ok(checked > 200);
  assert.equal(S(CAS.factorCommon(P('x*e^x - e^x'))), 'e^x(x − 1)');
  assert.equal(S(CAS.factorCommon(P('2x^3 + 4x^2'))), '2x²(x + 2)');
  assert.equal(S(CAS.subst(P('x^2 + y'), { x: P('t+1'), y: 3 })), '(t + 1)² + 3');
  assert.equal(S(CAS.replace(P('sin(x^2) + x^2*cos(x^2)'), P('x^2'), P('u'))), 'u cos(u) + sin(u)');
});

test('equality: simplification first, then random sampling', () => {
  assert.ok(CAS.equal(P('(x+1)^2'), P('x^2+2x+1')));
  assert.ok(CAS.equal(P('sin(2x)'), P('2sin(x)cos(x)')));
  assert.ok(CAS.equal(P('tan(x)'), P('sin(x)/cos(x)')));
  assert.ok(CAS.equal(P('ln(x^2)'), P('2ln(x)')));            // true where both are defined (x > 0)
  assert.ok(CAS.equal(P('cos(2x)'), P('1 - 2sin(x)^2')));
  assert.ok(CAS.equal(P('(x^2-1)/(x-1)'), P('x+1')));
  assert.ok(CAS.equal(P('e^(x+y)'), P('e^x*e^y')));
  assert.ok(!CAS.equal(P('sin(x)'), P('cos(x)')));
  assert.ok(!CAS.equal(P('x^2'), P('x^2 + 0.0001')));
  assert.ok(!CAS.equal(P('x'), P('y')));
  assert.ok(!CAS.equal(P('e^x'), P('x+1')));
  assert.ok(CAS.equalSymbolic(P('(x+1)^2 - x^2 - 2x'), P('1')));
  assert.ok(!CAS.equalSymbolic(P('sin(2x)'), P('2sin(x)cos(x)')), 'symbolic alone cannot see this one; sampling can');
  const f = CAS.compile(P('x^2+1'), ['x']), g = CAS.compile(P('x*x+1'), ['x']);
  assert.ok(CAS.sampleCompare(f, g, 1).ok);
  assert.ok(!CAS.sampleCompare(f, CAS.compile(P('x^2+1.01'), ['x']), 1).ok);
});

test('evaluation: functions, real odd roots, undefined values are NaN', () => {
  close(CAS.evalNum(P('x^2 + sin(y)'), { x: 3, y: 0.5 }), 9 + Math.sin(0.5), 1e-14);
  close(CAS.evalNum(P('(-8)^(1/3)'), {}), -2, 1e-14);
  close(CAS.evalNum(P('x^(2/3)'), { x: -8 }), 4, 1e-12);
  close(CAS.evalNum(P('x^(1/3)'), { x: -27 }), -3, 1e-12);
  assert.ok(isNaN(CAS.evalNum(P('sqrt(x)'), { x: -1 })));
  assert.ok(isNaN(CAS.evalNum(P('ln(x)'), { x: -1 })));
  assert.equal(CAS.evalNum(P('1/x'), { x: 0 }), Infinity);
  close(CAS.evalNum(P('pi + e'), {}), Math.PI + Math.E, 1e-15);
  close(CAS.evalNum(P('atan(1)*4'), {}), Math.PI, 1e-15);
  close(CAS.evalNum(P('sinh(1) + cosh(1) - e'), {}), 0, 1e-14);
  close(CAS.evalNum(P('sec(0.3) - 1/cos(0.3)'), {}), 0, 1e-14);
  assert.throws(() => CAS.evalNum(P('x + y'), { x: 1 }));
});

/* ───────────────────────── polynomials ───────────────────────── */

test('polynomials: coefficients, division and gcd', () => {
  const co = (s, v) => CAS.polyCoeffs(P(s), v || 'x').map(S).join(' | ');
  assert.equal(co('3x^2 - 2x + 5'), '5 | −2 | 3');
  assert.equal(co('(x+1)^3'), '1 | 3 | 3 | 1');
  assert.equal(co('a*x^2 + b*x + c'), 'c | b | a');
  assert.equal(CAS.polyCoeffs(P('sin(x) + 1'), 'x'), null);
  assert.equal(CAS.polyCoeffs(P('1/x'), 'x'), null);
  assert.equal(S(CAS.polyFromCoeffs([P('1'), P('2'), P('3')], 'x')), '3x² + 2x + 1');
  const d = CAS.polyDivide(P('x^3 + 2x^2 - x + 5'), P('x - 1'), 'x');
  assert.equal(S(d.q), 'x² + 3x + 2');
  assert.equal(S(d.r), '7');
  assert.equal(S(CAS.polyGcd(P('x^2 - 1'), P('x^2 - 2x + 1'), 'x')), 'x − 1');
  assert.equal(S(CAS.polyGcd(P('x^2 + 1'), P('x + 1'), 'x')), '1');
  assert.equal(CAS.polyDivide(P('sin(x)'), P('x'), 'x'), null);
});

test('polynomials: factoring over the rationals', () => {
  const fac = s => { const f = CAS.factorPoly(P(s), 'x'); return S(f.content) + ' · ' + f.factors.map(q => '[' + S(q.poly) + ']' + (q.mult > 1 ? '^' + q.mult : '')).join(' '); };
  assert.equal(fac('x^2-1'), '1 · [x − 1] [x + 1]');
  assert.equal(fac('x^3-x'), '1 · [x] [x − 1] [x + 1]');
  assert.equal(fac('2x^2+x-1'), '1 · [x + 1] [2x − 1]');
  assert.equal(fac('x^4-1'), '1 · [x − 1] [x + 1] [x² + 1]');
  assert.equal(fac('x^4+4'), '1 · [x² − 2x + 2] [x² + 2x + 2]');
  assert.equal(fac('x^4+x^2+1'), '1 · [x² − x + 1] [x² + x + 1]');
  assert.equal(fac('x^3-1'), '1 · [x − 1] [x² + x + 1]');
  assert.equal(fac('(x+1)^2*(x-2)'), '1 · [x + 1]^2 [x − 2]');
  assert.equal(fac('x^4+2x^2+1'), '1 · [x² + 1]^2');
  assert.equal(fac('6x^2+5x+1'), '1 · [2x + 1] [3x + 1]');
  assert.equal(fac('x^2+1'), '1 · [x² + 1]');
  assert.equal(fac('-4x^3+4x'), '−4 · [x] [x − 1] [x + 1]');
  assert.equal(fac('x^2/2 - 1/2'), '1/2 · [x − 1] [x + 1]');
  assert.equal(fac('x^6-1'), '1 · [x − 1] [x + 1] [x² − x + 1] [x² + x + 1]');
});

test('polynomials: random products of small factors are recovered exactly (200 cases)', () => {
  const rnd = lcg(2024);
  for (let i = 0; i < 200; i++) {
    const parts = [];
    const nl = ri(rnd, 0, 3), nq = ri(rnd, 0, 2);
    for (let k = 0; k < nl; k++) parts.push('(' + ri(rnd, 1, 3) + '*x' + (rnd() < 0.5 ? '+' : '-') + ri(rnd, 1, 6) + ')');
    for (let k = 0; k < nq; k++) parts.push('(x^2' + (rnd() < 0.5 ? '+' : '-') + ri(rnd, 0, 4) + '*x+' + ri(rnd, 5, 9) + ')');   // irreducible: discriminant < 0
    if (!parts.length) continue;
    const prod = parts.join('*');
    const f = CAS.factorPoly(P(prod), 'x');
    assert.ok(f.complete, prod);
    const back = CAS.mul(f.content, ...f.factors.map(q => CAS.pow(q.poly, CAS.num(q.mult))));
    assert.equal(CAS.expand(back).k, CAS.expand(P(prod)).k, prod + ' → ' + S(back));
    f.factors.forEach(q => assert.ok(q.degree <= 2, prod + ' left a factor of degree ' + q.degree));
  }
});

test('partial fractions: the pieces add back up to the fraction (150 random cases) and the unknowns are exact', () => {
  const rnd = lcg(8675309);
  let n = 0;
  for (let i = 0; i < 150; i++) {
    const dparts = [];
    const nl = ri(rnd, 1, 3), nq = ri(rnd, 0, 1);
    for (let k = 0; k < nl; k++) dparts.push('(x' + (rnd() < 0.5 ? '+' : '-') + ri(rnd, 1, 5) + ')' + (rnd() < 0.25 ? '^2' : ''));
    if (nq) dparts.push('(x^2+' + ri(rnd, 1, 5) + ')');
    const den = dparts.join('*');
    const numr = [0, 1, 2, 3, 4].slice(0, ri(rnd, 1, 4)).map(k => ri(rnd, -4, 4) + '*x^' + k).join('+');
    const pf = CAS.partialFractions(P(numr), P(den), 'x');
    if (!pf) continue;
    n++;
    const sum = CAS.add(pf.poly, ...pf.terms.map(t => t.expr));
    assert.ok(CAS.equal(sum, CAS.div(P(numr), P(den))), '(' + numr + ')/(' + den + ') → ' + S(sum));
    pf.terms.forEach(t => { assert.ok(t.degree <= 2); });
    assert.ok(pf.unknownNames.every(nm => pf.values[nm].t === 'num'), 'constants are exact fractions');
  }
  assert.ok(n > 100, 'only ' + n);
  const pf = CAS.partialFractions(P('1'), P('x^2-1'), 'x');
  assert.deepEqual(pf.unknownNames, ['A', 'B']);
  assert.equal(S(pf.values.A), '1/2');
  assert.equal(S(pf.values.B), '−1/2');
});

test('the API is small and stable: the documented names exist', () => {
  ['parse', 'tryParse', 'parseWithNotes', 'ParseError', 'toString', 'num', 'sym', 'add', 'mul', 'pow', 'neg', 'sub', 'div', 'fn', 'sqrt', 'exp', 'ln', 'PI', 'E', 'ZERO', 'ONE', 'simplify', 'canon', 'expand', 'together',
    'factorCommon', 'diff', 'diffSteps', 'evalNum', 'compile', 'subst', 'replace', 'freeVars', 'dependsOn', 'equal', 'equalSymbolic', 'sampleCompare', 'polyCoeffs', 'polyFromCoeffs', 'polyDivide', 'polyGcd',
    'factorPoly', 'partialFractions', 'Q'].forEach(k => assert.ok(CAS[k] !== undefined, 'CAS.' + k));
  assert.deepEqual(CAS.freeVars(P('x*y + sin(z)')), ['x', 'y', 'z']);
  assert.ok(CAS.dependsOn(P('x*y'), 'y') && !CAS.dependsOn(P('x*y'), 'z'));
  const r = CAS.tryParse('2x +');
  assert.ok(!r.ok && typeof r.error.message === 'string' && typeof r.error.pos === 'number');
  assert.equal(CAS.num(1, 3).k, P('1/3').k);
});

console.log(`\n${passed} test groups passed` + (process.exitCode ? ' — with failures' : ''));
