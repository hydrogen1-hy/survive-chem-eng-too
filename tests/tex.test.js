'use strict';
// Tests for js/tex.js: the text-to-LaTeX reader.
//  1. fixed cases (what each kind of notation becomes)
//  2. every expression the algebra core can print is read back to the same expression (round trip through LaTeX)
//  3. every line the integrator, the derivative rules and the multiple-integral solver produce can be typeset,
//     and KaTeX accepts all of the LaTeX that comes out
const assert = require('node:assert/strict');
const CAS = require('../js/cas.js');
const Integrate = require('../js/integrate.js');
const Multi = require('../js/multi.js');
const Tex = require('../js/tex.js');
const katexLib = require('../vendor/katex/katex.min.js');
const katex = katexLib && katexLib.renderToString ? katexLib : globalThis.katex;

const P = CAS.parse, S = e => CAS.toString(e);
let passed = 0, failed = 0;
function group(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); process.exitCode = 1; }
}
const segText = segs => segs.map(g => g.text !== undefined ? '[' + g.text + ']' : '{' + g.tex + '}').join('');
// the grouping braces around brackets ({\left( ... \right)}) are not what these tests are about
const flat = s => s === null ? null : s.replace(/\{(\\left)/g, '$1').replace(/(\\right(?:[)\]|]|\\\}))\}/g, '$1');
const kx = tex => { try { katex.renderToString(tex, { throwOnError: true, strict: 'ignore' }); return null; } catch (e) { return e.message; } };

/* ───────────────────────── 1. fixed cases ───────────────────────── */

group('tex: fractions bind the way the calculators print them', () => {
  const cases = {
    '3x³y²/2 + y³/3 + y/x': '\\frac{3x^{3}y^{2}}{2}+\\frac{y^{3}}{3}+\\frac{y}{x}',
    '(x + 1)/x': '\\frac{x+1}{x}',
    '1/(x + 1)': '\\frac{1}{x+1}',
    '1/(x + 1)²': '\\frac{1}{\\left(x+1\\right)^{2}}',
    'x/(2·y)': '\\frac{x}{2\\cdot y}',
    '−x²/2 + 1': '-\\frac{x^{2}}{2}+1',
    '3x³(x + 1)²/2': '\\frac{3x^{3}\\left(x+1\\right)^{2}}{2}',
    '2π/3': '\\frac{2\\pi}{3}',
    'x^(1/2)': 'x^{\\frac{1}{2}}',
    'vⁿ⁺¹ / (n + 1)': '\\frac{v^{n+1}}{n+1}'
  };
  Object.keys(cases).forEach(k => assert.equal(flat(Tex.math(k)).replace(/\\pi /g, '\\pi'), cases[k].replace(/\\pi /g, '\\pi'), k));
});

group('tex: a bracket is one letter to TeX, so f(x) and 3(x + 1) get no stray gaps', () => {
  assert.equal(Tex.math('F(x)'), 'F{\\left(x\\right)}');
  assert.equal(Tex.math('3(x + 1)'), '3{\\left(x+1\\right)}');
  assert.equal(Tex.math('|x|'), '{\\left|x\\right|}');
});

group('tex: roots, powers, functions, constants', () => {
  assert.equal(flat(Tex.math('√(x² + 1)')), '\\sqrt{x^{2}+1}');
  assert.equal(flat(Tex.math('√2')), '\\sqrt{2}');
  assert.equal(flat(Tex.math('x·e^(−x²)')), 'x\\cdot \\mathrm{e}^{-x^{2}}');
  assert.equal(flat(Tex.math('sin(x)²')), '\\sin \\left(x\\right)^{2}');
  assert.equal(flat(Tex.math('arctan(x/2)')), '\\arctan \\left(\\frac{x}{2}\\right)');
  assert.equal(flat(Tex.math('ln|x|')), '\\ln \\left|x\\right|');
  assert.equal(flat(Tex.math('ln(abs(x))')), '\\ln \\left(\\left|x\\right|\\right)');
  assert.equal(flat(Tex.math('sec x')), '\\sec x');
  assert.equal(flat(Tex.math('1.5e-7')), '1.5\\times 10^{-7}');
  assert.equal(flat(Tex.math('30°')), '30^{\\circ}');
  assert.equal(flat(Tex.math('∞')), '\\infty');
  assert.equal(flat(Tex.math('−∞')), '-\\infty');
});

group('tex: integrals, differentials and derivative notation', () => {
  assert.equal(flat(Tex.math('∫ x² dx')), '\\int x^{2}\\,\\mathrm{d}x');
  assert.equal(flat(Tex.math('∫ (x + 1) dx = x²/2 + x')), '\\int \\left(x+1\\right)\\,\\mathrm{d}x=\\frac{x^{2}}{2}+x');
  assert.equal(flat(Tex.math('r dr dθ')), 'r\\,\\mathrm{d}r\\,\\mathrm{d}\\theta');
  assert.equal(flat(Tex.math('r dr dtheta')), 'r\\,\\mathrm{d}r\\,\\mathrm{d}\\theta');
  assert.equal(flat(Tex.math('∫ from 0 to 4 of x dx'.replace(/^∫ from (.*) to (.*) of /, '∫\uE000$1\uE001$2\uE002'))), '\\int_{0}^{4}x\\,\\mathrm{d}x');
  assert.equal(flat(Tex.math('d/dx [x² sin(3x)]')), '\\frac{\\mathrm{d}}{\\mathrm{d}x}\\left[x^{2}\\sin \\left(3x\\right)\\right]');
  assert.equal(flat(Tex.math('∂²/∂x² [x y]')), '\\frac{\\partial ^{2}}{\\partial x^{2}}\\left[xy\\right]');
  assert.equal(flat(Tex.math('f′(x)')), 'f\'\\left(x\\right)');
  // the integral sign is not part of a numerator
  assert.equal(flat(Tex.math('∫ 1/u du = ln|u|')), '\\int \\frac{1}{u}\\,\\mathrm{d}u=\\ln \\left|u\\right|');
  assert.equal(flat(Tex.math('∫ dx/(a x² + c)ⁿ')), '\\int \\frac{\\mathrm{d}x}{\\left(ax^{2}+c\\right)^{n}}');
  assert.equal(flat(Tex.math('B/(2a)·x')), '\\frac{B}{2a}\\cdot x');
});

group('tex: relations, gaps, Greek, things it must refuse', () => {
  assert.equal(flat(Tex.math('n ≠ −1')), 'n\\neq -1');
  assert.equal(flat(Tex.math('F(4) = 2,   F(0) = 0')), 'F\\left(4\\right)=2,\\ \\quad F\\left(0\\right)=0');
  assert.equal(flat(Tex.math('theta + π')), '\\theta +\\pi');
  assert.equal(flat(Tex.math('ρ² sin φ')), '\\rho ^{2}\\sin \\varphi');
  assert.equal(flat(Tex.math('quotient + remainder')), null);       // words are not mathematics
  assert.equal(flat(Tex.math('(x + 1')), null);                      // unbalanced
  assert.equal(flat(Tex.math('x + ')), null);                        // nothing after the sign
  assert.equal(flat(Tex.math('')), null);
});

group('tex: lines of prose with mathematics in them are cut into words and formulas', () => {
  const cases = {
    'Let u = x² + 1.': '[Let ]{u=x^{2}+1}[.]',
    'Then du = 2x dx.': '[Then ]{\\,\\mathrm{d}u=2x\\,\\mathrm{d}x}[.]'.replace('\\,', ''),
    'Take the constant 3 outside the integral.': '[Take the constant ]{3}[ outside the integral.]',
    'Here n = 2, so n + 1 = 3.': '[Here ]{n=2}[, so ]{n+1=3}[.]',
    'Choose u = x and dv = e^x dx   (the algebraic part goes first).': '[Choose ]{u=x}[ and ]{\\mathrm{d}v=\\mathrm{e}^{x}\\,\\mathrm{d}x}[   (the algebraic part goes first).]',
    'Equate coefficients of like powers of x (or put in convenient values of x) and solve: A = 1, B = −1.': '[Equate coefficients of like powers of ]{x}[ (or put in convenient values of ]{x}[) and solve: ]{A=1}[, ]{B=-1}[.]',
    'Write a sum as a fraction.': '[Write a sum as a fraction.]',
    'Here a = 2, so a² = 4.': '[Here ]{a=2}[, so ]{a^{2}=4}[.]'
  };
  Object.keys(cases).forEach(k => assert.equal(flat(segText(Tex.segments(k))), cases[k], k));
  // "∫ from A to B of ..." is one integral with limits
  const t = Tex.segments('∫ from 0 to x + 1 of (3x³y + y² + 1/x) dy = 5/2');
  assert.equal(t.length, 1);
  assert.equal(flat(t[0].tex), '\\int_{0}^{x+1}\\left(3x^{3}y+y^{2}+\\frac{1}{x}\\right)\\,\\mathrm{d}y=\\frac{5}{2}');
  assert.equal(t[0].math, '∫ from 0 to x + 1 of (3x³y + y² + 1/x) dy = 5/2');   // the original text is kept for copying
  // nested limits
  const n = Tex.segments('∫ from 0 to 1 of ∫ from 0 to x of (x + y) dy dx');
  assert.equal(n.length, 1);
  assert.equal(flat(n[0].tex), '\\int_{0}^{1}\\int_{0}^{x}\\left(x+y\\right)\\,\\mathrm{d}y\\,\\mathrm{d}x');
  // a formula that contains words has its own LaTeX
  assert.equal(Tex.segments('N/D = quotient + remainder/D')[0].tex, '\\frac{N}{D} = \\text{quotient} + \\frac{\\text{remainder}}{D}');
  // text that is not mathematics is left alone
  assert.equal(segText(Tex.segments('No method found.')), '[No method found.]');
  assert.equal(segText(Tex.segments('')), '');
});

/* ───────────────────────── 2. round trip through LaTeX ───────────────────────── */

// turn the LaTeX that Tex makes back into text the algebra core can read (only the commands Tex uses)
function braced(s, at) {                    // s[at] is '{': returns [content, indexAfter]
  let d = 0, k = at;
  for (; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}') { d--; if (d === 0) break; } }
  return [s.slice(at + 1, k), k + 1];
}
function back(tex) {
  let s = tex.replace(/\\left|\\right/g, '').replace(/\\quad|\\,|\\ /g, ' ').replace(/\\cdot/g, '*').replace(/\\times/g, '*')
    .replace(/\\mathrm\{e\}/g, ' e ').replace(/\\pi/g, 'pi').replace(/\\operatorname\{(\w+)\}/g, '$1')
    .replace(/\\(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|log|exp)/g, '$1');
  for (let guard = 0; guard < 200; guard++) {
    const f = s.indexOf('\\frac{');
    if (f >= 0) {
      const [a, e1] = braced(s, f + 5), [b, e2] = braced(s, e1);
      s = s.slice(0, f) + '((' + a + ')/(' + b + '))' + s.slice(e2);
      continue;
    }
    const q = s.indexOf('\\sqrt{');
    if (q >= 0) { const [a, e1] = braced(s, q + 5); s = s.slice(0, q) + 'sqrt(' + a + ')' + s.slice(e1); continue; }
    const c = s.indexOf('^{');
    if (c >= 0) { const [a, e1] = braced(s, c + 1); s = s.slice(0, c) + '^(' + a + ')' + s.slice(e1); continue; }
    break;
  }
  return s.replace(/\|([^|]*)\|/g, 'abs($1)').replace(/[{}]/g, '');
}

let seed = 20261124;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
function randExpr(d) {
  if (d <= 0 || rnd() < 0.18) {
    const r = rnd();
    if (r < 0.4) return CAS.sym(pick(['x', 'y', 'z']));
    if (r < 0.75) return CAS.num(Math.floor(rnd() * 11) - 3);
    if (r < 0.85) return CAS.num(Math.floor(rnd() * 7) + 1, Math.floor(rnd() * 6) + 2);
    return pick([CAS.PI, CAS.E]);
  }
  const k = rnd();
  const a = randExpr(d - 1), b = randExpr(d - 1);
  if (k < 0.22) return CAS.add(a, b);
  if (k < 0.34) return CAS.add(a, b, randExpr(d - 1));
  if (k < 0.52) return CAS.mul(a, b);
  if (k < 0.6) return CAS.mul(a, b, randExpr(d - 1));
  if (k < 0.7) return CAS.div(a, b);
  if (k < 0.8) return CAS.pow(a, CAS.num(pick([2, 3, 4, -1, -2])));
  if (k < 0.85) return CAS.sqrt(a);
  if (k < 0.88) return CAS.exp(a);
  if (k < 0.9) return CAS.pow(a, b);
  if (k < 0.94) return CAS.neg(a);
  return CAS.fn(pick(['sin', 'cos', 'tan', 'ln', 'atan', 'sinh', 'cosh', 'abs']), a);
}

group('tex: anything the algebra core prints reads back as the same expression (400 random expressions)', () => {
  let n = 0, hard = 0;
  for (let k = 0; k < 400; k++) {
    const e = randExpr(1 + (k % 4));
    const plain = S(e);
    if (/\/0(?![.\d])/.test(plain)) continue;                // the random builder can divide by zero; that is not a notation test
    const tex = Tex.math(plain);
    assert.ok(tex !== null, 'not read: ' + plain);
    assert.equal(kx(tex), null, 'KaTeX refuses ' + tex + ' (from ' + plain + ')');
    let e2;
    try { e2 = CAS.parse(back(tex)); } catch (err) { if (/divides by zero/.test(err.message)) continue; throw new Error('cannot read back ' + back(tex) + ' (' + plain + ' -> ' + tex + '): ' + err.message); }
    if (!CAS.equal(e, e2)) throw new Error('changed meaning: ' + plain + ' -> ' + tex + ' -> ' + back(tex) + ' = ' + S(e2));
    n++;
    if (plain.indexOf('/') >= 0) hard++;
  }
  assert.ok(n > 350 && hard > 40, 'expressions checked: ' + n + ', with fractions: ' + hard);
});

/* ───────────────────────── 3. real lines from the solvers ───────────────────────── */

const INTEGRANDS = ['x*e^x', 'x^2*sin(x)', 'ln(x)', 'x*e^(x^2)', 'e^x*sin(x)', 'atan(x)', '1/(x^2-1)', '(3x+2)/(x^2+x+1)', 'sin(x)^3', 'sec(x)^3',
  'sqrt(1-x^2)', '1/(x^2*sqrt(x^2+1))', '1/(x^2+4)', '(x^3+1)/(x^2-1)', 'x^2/(x^2+1)^2', 'cos(x)^2', 'tan(x)^2', '1/(x*(x+1))', 'x^3*e^(2x)',
  'sqrt(x^2+4)', '3x^3*y+y^2+1/x', 'x^5', '2^x', '1/x', 'sin(3x)', '(2x+1)^5', 'x/(x^2+1)', 'x*sqrt(x+1)', 'cosh(x)*sin(x)'];
const DEFINITE = [['x*sin(x)', '0', 'pi'], ['1/(1+x^2)', '0', '1'], ['ln(x)', '1', 'e'], ['x*e^(-x)', '0', 'inf'], ['1/sqrt(x)', '0', '1'], ['1/x', '1', 'inf'], ['1/x^2', '-1', '1'], ['e^(-x^2)', '0', 'inf']];
const DERIVATIVES = ['x^2*sin(3x)', 'sin(x)/x', 'ln(x^2+1)', 'e^(x^2)', '(x^2+1)^5', 'x^x', 'sqrt(1-x^2)', 'atan(2x)', 'x^2*y', 'tan(x)*sec(x)', 'x^3/(x^2+1)'];

const lines = { pure: [], prose: [], formula: [] };
function collectSteps(steps) {
  steps.forEach(st => {
    if (st.integral) lines.pure.push(st.integral);
    if (st.then) lines.pure.push(st.then);
    if (st.result !== undefined && st.result !== null && st.kind === 'rule') lines.pure.push('= ' + st.result);
    if (st.formula) lines.formula.push(st.formula);
    (st.lines || []).forEach(l => lines.prose.push(l));
    if (st.kind === 'combine' && st.text) lines.prose.push(st.text);
  });
}
INTEGRANDS.forEach(src => {
  try { const r = Integrate.integrate(P(src), 'x', { maxMs: 3000 }); if (r.steps) collectSteps(r.steps); } catch (e) { /* a problem the integrator gives up on has no lines */ }
});
DEFINITE.forEach(d => {
  try {
    const r = Integrate.definite(P(d[0]), 'x', Integrate.parseBound(d[1]), Integrate.parseBound(d[2]), { maxMs: 3000 });
    if (r.steps) collectSteps(r.steps);
    (r.evaluation || []).forEach(l => lines.prose.push(l));
  } catch (e) { /* skip */ }
});
DERIVATIVES.forEach(src => {
  const vars = CAS.freeVars(P(src));
  const ds = CAS.diffSteps(P(src), vars.indexOf('x') >= 0 ? 'x' : vars[0]);
  ds.steps.forEach(s => {
    lines.pure.push('d/dx [' + S(s.expr) + ']'); lines.pure.push('= ' + S(s.result));
    if (s.formula) lines.formula.push(s.formula);
    if (s.text) lines.prose.push(s.text);
  });
});
Multi.EXAMPLES.forEach(ex => {
  const r = Multi.solve({ system: ex.system, dim: ex.dim, f: ex.f, order: ex.order }, { maxMs: 4000 });
  (r.levels || []).forEach(l => {
    collectSteps(l.steps || []);
    (l.evaluation || []).forEach(t => lines.prose.push(t));
    if (l.ok) lines.pure.push('= ' + S(l.result));
    lines.pure.push('∫ from ' + Multi.boundText(l.lower) + ' to ' + Multi.boundText(l.upper) + ' of (' + S(l.integrand) + ') d' + l.v);
  });
  if (r.conversion) {
    const c = r.conversion;
    (c.map || []).forEach(t => lines.prose.push(t));
    lines.prose.push(c.element + '    (the factor ' + c.jacobian + ' is the Jacobian)');
    lines.prose.push('f · ' + c.jacobian + ' = ' + S(r.converted) + '     ← this is integrated');
  }
});

group('tex: collected real lines (counts)', () => {
  console.log('     lines: ' + lines.pure.length + ' pure math, ' + lines.prose.length + ' prose, ' + lines.formula.length + ' formulas');
  assert.ok(lines.pure.length > 150 && lines.prose.length > 100, 'too few lines were collected');
});

group('tex: every pure-math line (integral, "then", result) becomes one formula', () => {
  const seen = new Set(), bad = [];
  lines.pure.forEach(l => {
    if (seen.has(l)) return; seen.add(l);
    const s = l.replace(/^= /, '');
    const segs = Tex.segments(s.replace(/theta/g, 'θ'));
    if (!(segs.length === 1 && segs[0].tex)) bad.push(l + '   =>   ' + segText(segs));
  });
  assert.ok(bad.length === 0, bad.length + ' lines left partly as text:\n     ' + bad.slice(0, 12).join('\n     '));
});

group('tex: KaTeX accepts every piece of LaTeX that comes out', () => {
  const seen = new Set(), bad = [];
  [].concat(lines.pure, lines.prose, lines.formula).forEach(l => {
    if (seen.has(l)) return; seen.add(l);
    Tex.segments(l).forEach(g => { if (g.tex) { const m = kx(g.tex); if (m) bad.push(g.tex + '   (' + m + ')'); } });
  });
  assert.ok(bad.length === 0, bad.length + ' refused:\n     ' + bad.slice(0, 8).join('\n     '));
});

group('tex: review of prose and formulas (printed for reading, not asserted)', () => {
  const seen = new Set();
  const suspicious = [];
  [].concat(lines.formula, lines.prose).forEach(l => {
    if (seen.has(l)) return; seen.add(l);
    const segs = Tex.segments(l);
    // text pieces that still contain digits or operators mean a stretch of mathematics was not typeset
    const left = segs.filter(g => g.text !== undefined && /[0-9=+−*/^√∫²³]/.test(g.text.replace(/\.\s*$/, '')));
    if (left.length) suspicious.push(l + '\n        ' + segText(segs));
  });
  const asMath = new Set();
  seen.forEach(l => Tex.segments(l).forEach(g => { if (g.math && /^[A-Za-z]{2,}$/.test(g.math)) asMath.add(g.math); }));
  console.log('     letter-only words typeset as mathematics: ' + Array.from(asMath).sort().join(' '));
  console.log('     ' + suspicious.length + ' of ' + seen.size + ' distinct lines keep some mathematics as text');
  suspicious.slice(0, 40).forEach(s => console.log('     ? ' + s));
});

console.log('\ntex: ' + passed + ' groups passed, ' + failed + ' failed');
