/*
 * Rule-based, step-by-step integration (and numeric quadrature) built on CAS (js/cas.js).
 * Plain deterministic code: no AI, no network, no lookup of answers. Works in the browser (window.Integrate) and in Node.
 *
 * HOW IT WORKS
 *   An integrand is passed through an ordered list of rules (the way a student would try them):
 *   constant, table of basic integrals, constant multiple, sum, u-substitution, trigonometric powers and products,
 *   partial fractions (with completing the square), trigonometric substitution, integration by parts (LIATE, repeated,
 *   and the cyclic case where the original integral comes back), and finally expanding the integrand.
 *   Every rule that applies records a step: its name, the formula, the choices made (u, dv, ...) and the simpler integral
 *   that remains. The remaining integral is solved by the same rules, so the steps form a tree.
 *   Every answer is VERIFIED before it is shown: the result is differentiated with CAS and compared with the integrand
 *   by simplification and at many random points (and by a finite-difference check on the antiderivative itself).
 *   If verification fails, or no rule applies, the result is "no method found". Nothing is guessed or looked up.
 *
 * API
 *   Integrate.integrate(expr, v, opts)  expr: Expr or text, v: variable name (default 'x')
 *     -> { ok, integrand, variable, antiderivative (Expr, without + C) | null, steps[], tree, verified, message }
 *        steps[] is the tree flattened for display; each step is { id:'1.2', depth, kind:'rule'|'combine', title, formula,
 *        lines:[text], integral:text, then:text, result:text, text }.  opts: { maxWork, maxMs, maxDepth }
 *   Integrate.definite(expr, v, lower, upper, opts)  bounds are Expr, text, or numbers; 'inf' and '-inf' are allowed
 *     -> { ok, kind:'exact'|'numeric'|'diverges'|'none', exact (Expr) | null, exactNumber, numeric, numericError,
 *          agree, improper, antiderivative, steps[], evaluation[], issues[], warnings[], message }
 *   Integrate.quad(f, a, b)            adaptive Gauss-Kronrod / tanh-sinh quadrature of a JS function, infinite ends allowed
 *                                      -> { value, error, ok }
 *   Integrate.verify(f, F, v)          is dF/dv = f?  -> { ok, symbolic, valid, maxErr }
 *   Integrate.limit(expr, v, point, side)  symbolic limit where simple enough -> { kind:'finite'|'inf'|'none'|'unknown', value, sign }
 *   Integrate.parseBound(text)         -> Expr | Infinity | -Infinity
 *   Integrate.flatten(tree)            tree -> steps[]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var mod = module, cas = typeof require === 'function' ? require('./cas.js') : root.CAS;
    module = mod;                           // the stand-in test runner swaps the global `module` while it loads a dependency
    mod.exports = factory(cas);
  } else root.Integrate = factory(root.CAS);
})(typeof self !== 'undefined' ? self : this, function (CAS) {
  'use strict';

  const { add, mul, pow, neg, sub, div, fn, sym, num, ln, exp, sqrt, PI, E, ZERO, ONE, MINUS_ONE } = CAS;
  const S = e => CAS.toString(e).replace(/theta/g, 'θ');
  const Q = CAS.Q;
  const dependsOn = CAS.dependsOn;
  const simplify = CAS.canon;               // canonical form only: the rules rewrite with identities themselves, so no identities here
  const isNum = CAS.isNum;
  const TWO = num(2), HALF = num(1, 2);
  const sup = n => String(n).replace(/[0-9-]/g, c => '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'['0123456789-'.indexOf(c)]);

  class Budget extends Error { constructor() { super('search limit reached'); this.budget = true; } }
  class Soft extends Error { constructor() { super('attempt abandoned'); this.soft = true; } }

  /* ═════════════════════ small helpers ═════════════════════ */

  const SIZE = new WeakMap();
  function size(e) {
    let s = SIZE.get(e);
    if (s !== undefined) return s;
    switch (e.t) {
      case 'add': case 'mul': s = 1; for (const a of e.args) s += size(a); break;
      case 'pow': s = 1 + size(e.b) + size(e.e); break;
      case 'fn': s = 1 + size(e.a); break;
      default: s = 1;
    }
    SIZE.set(e, s);
    return s;
  }
  const toE = x => (typeof x === 'object' ? x : CAS.parse(x));
  const isConstIn = (e, v) => !dependsOn(e, v);
  const X = sym('ξ');                  // the variable used by the table of basic integrals
  const sy = name => sym(name);
  function freshVar(f, v) {
    const used = CAS.freeVars(f);
    for (const n of ['u', 'w', 'z', 's', 'p', 'q', 'a', 'b']) if (n !== v && used.indexOf(n) < 0) return n;
    return 'u1';
  }
  const dv = v => (v === 'theta' ? 'θ' : v);
  const intText = (f, v) => '∫ ' + (f.t === 'add' ? '(' + S(f) + ')' : S(f)) + ' d' + dv(v);
  const ratioConst = (a, b, v) => {         // a = c*b with c free of v (and not zero)?
    const c = simplify(div(a, b));
    return !CAS.isZero(c) && !dependsOn(c, v) ? c : null;
  };
  const posInt = (e) => e.t === 'num' && e.d === 1n && e.n > 0n ? Number(e.n) : null;
  const asInt = (e) => e.t === 'num' && e.d === 1n ? Number(e.n) : null;
  const numQ = e => ({ n: e.n, d: e.d });

  /* split a sum into (number, sum) so that sum has content 1: 2x + 2 -> 2, x + 1 */
  function splitContent(e) {
    if (e.t !== 'add') return { c: ONE, rest: e };
    let gn = 0n, ld = 1n;
    const parts = e.args.map(t => (t.t === 'num' ? t : t.t === 'mul' && t.args[0].t === 'num' ? t.args[0] : ONE));
    const g = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { const r = a % b; a = b; b = r; } return a; };
    for (const p of parts) { gn = g(gn, p.n); ld = ld / g(ld, p.d) * p.d; }
    if (gn === 0n) return { c: ONE, rest: e };
    const c = CAS.num(Number(gn), Number(ld));
    // keep the sign of the leading term positive in "rest"
    return { c, rest: add(...e.args.map(t => mul(t, pow(c, MINUS_ONE)))) };
  }

  /* ═════════════════════ verification ═════════════════════ */

  /* Is dF/dv equal to f?  symbolic: simplification alone proves it. Otherwise numeric: the derivative of F (from CAS.diff)
     against f at random points where both are finite, and a finite-difference derivative of F itself (independent of diff). */
  function verify(f, F, v, opts) {
    opts = opts || {};
    f = toE(f); F = toE(F);
    let dF;
    try { dF = CAS.diff(F, v); } catch (e) { return { ok: false, symbolic: false, valid: 0, maxErr: Infinity }; }
    const symbolic = CAS.equalSymbolic(dF, f);
    const vars = Array.from(new Set(CAS.freeVars(f).concat(CAS.freeVars(F), [v]))).sort();
    const vi = vars.indexOf(v);
    let ff, fd, Ff;
    try { ff = CAS.compile(f, vars); fd = CAS.compile(dF, vars); Ff = CAS.compile(F, vars); } catch (e) { return { ok: false, symbolic, valid: 0, maxErr: Infinity }; }
    const n = opts.points || 40;
    const r = CAS.sampleCompare(ff, fd, vars.length, { points: n, tol: 2e-8, minValid: opts.minValid || 10, seed: opts.seed || 7 });
    if (!r.ok) return { ok: false, symbolic, valid: r.valid, maxErr: r.maxErr, point: r.point };
    let fdOk = true;
    if (!opts.skipFiniteDifference) {
      // central differences of F at a few points
      const wins = [[0.3, 2.2], [-2.2, -0.3], [0.7, 4], [-0.8, 0.8], [1.2, 6]];
      let seed = 99, checked = 0;
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      for (let t = 0; t < 80 && checked < 8; t++) {
        const pt = vars.map((_, i) => { const w = wins[(t + 2 * i) % wins.length]; return w[0] + (w[1] - w[0]) * rnd(); });
        const f0 = ff.apply(null, pt);
        const x0 = pt[vi], h = 1e-5 * Math.max(1, Math.abs(x0)) / Math.max(1, Math.abs(f0) / 100);
        const at = d => { const q = pt.slice(); q[vi] = x0 + d * h; return Ff.apply(null, q); };
        const Fm2 = at(-2), Fm1 = at(-1), Fp1 = at(1), Fp2 = at(2);
        if (!isFinite(f0) || !isFinite(Fm2) || !isFinite(Fp2) || Math.abs(f0) > 1000) continue;
        const slope = (-Fp2 + 8 * Fp1 - 8 * Fm1 + Fm2) / (12 * h);       // five-point stencil
        checked++;
        if (Math.abs(slope - f0) > 1e-5 * Math.max(1, Math.abs(f0)) + 1e-8 * Math.abs(Fp1)) { fdOk = false; break; }
      }
    }
    return { ok: fdOk, symbolic, valid: r.valid, maxErr: r.maxErr };
  }

  /* ═════════════════════ search context ═════════════════════ */

  function makeContext(opts) {
    opts = opts || {};
    return {
      work: 0, maxWork: opts.maxWork || 6000, deadline: Date.now() + (opts.maxMs || 6000), maxDepth: opts.maxDepth || 12,
      depth: 0, soft: null, path: new Set(), memo: new Map(), fail: new Map(), chain: [], trace: opts.trace || null
    };
  }
  function tick(ctx) {
    ctx.work++;
    if (ctx.work > ctx.maxWork || ((ctx.work & 15) === 0 && Date.now() > ctx.deadline)) throw new Budget();
    if (ctx.soft !== null && ctx.work > ctx.soft) throw new Soft();
  }
  /* run a speculative attempt with its own allowance of work; if it uses it all up the attempt just fails */
  function limited(ctx, cap, run) {
    const prev = ctx.soft, lim = ctx.work + cap;
    ctx.soft = prev === null ? lim : Math.min(prev, lim);
    try { return run(); }
    catch (e) { if (e.soft && (prev === null || ctx.work <= prev)) return null; throw e; }
    finally { ctx.soft = prev; }
  }

  /* A solution node: { title, formula, lines[], integral, v, then, children[], result, combine, leaf } */
  function mkNode(title, f, v, extra) {
    return Object.assign({ title, formula: null, lines: [], integral: f, v, then: null, children: [], result: null, combine: null, leaf: false }, extra || {});
  }
  const sol = (result, node, ph) => ({ result, node: (node.result = result, node), ph: ph || null });

  /* leaf (or constant-multiple-of-leaf) nodes are folded into one line when they appear inside a sum */
  function leafish(n) { return n.leaf || (n.title === 'Constant multiple rule' && n.children.length === 1 && n.children[0].leaf); }
  function leafLine(n) {
    const kind = n.leaf ? n.title.toLowerCase() : 'constant multiple, ' + n.children[0].title.toLowerCase();
    return intText(n.integral, n.v) + ' = ' + S(n.result) + '   (' + kind + ')';
  }

  /* ═════════════════════ the solve loop ═════════════════════ */

  const RULES = [];                         // filled below, in the order a student would try them
  const PH_NAMES = ['I', 'J', 'K', 'L'];

  function chainCheck(f, v, ctx) {          // the integrand is a constant multiple of an integral we are in the middle of solving
    for (const ent of ctx.chain) {
      if (ent.v !== v) continue;
      const c = ratioConst(f, ent.f, v);
      if (c) {
        ent.used = true;
        const nd = mkNode('The original integral appears again', f, v, { leaf: false });
        nd.lines.push('This is ' + (CAS.isOne(c) ? 'the same as' : S(c) + ' times') + ' the integral ' + ent.ph.name + ' we started from, so it is written as ' + (CAS.isOne(c) ? '' : S(c) + '·') + ent.ph.name + ' and dealt with at the end.');
        return sol(simplify(mul(c, ent.ph)), nd, [ent.ph.name]);
      }
    }
    return null;
  }

  function solveRec(f, v, ctx) {
    tick(ctx);
    const key = v + '|' + f.k;
    if (ctx.depth >= ctx.maxDepth) return null;
    const hit = chainCheck(f, v, ctx);
    if (hit) return hit;
    if (ctx.path.has(key)) return null;
    const cacheable = ctx.chain.length === 0;
    if (cacheable) {
      const m = ctx.memo.get(key);
      if (m) return m;
      const fd = ctx.fail.get(key);
      if (fd !== undefined && fd <= ctx.depth) return null;
    }
    ctx.path.add(key); ctx.depth++;
    let res = null;
    try {
      for (const rule of RULES) {
        const r = rule(f, v, ctx);
        if (ctx.trace) ctx.trace.push('  '.repeat(ctx.depth) + rule.name + ': ' + S(f) + ' d' + v + (r ? ' -> ' + S(r.result) : ' -> none'));
        if (!r) continue;
        if (!r.ph && !r.node.leaf && !quickVerify(f, r.result, v)) { if (ctx.trace) ctx.trace.push('  '.repeat(ctx.depth) + '   (rejected by the check)'); continue; }
        res = r;
        break;
      }
    } finally { ctx.path.delete(key); ctx.depth--; }
    if (cacheable) { if (res) ctx.memo.set(key, res); else ctx.fail.set(key, ctx.depth); }
    return res;
  }
  function quickVerify(f, F, v) { return verify(f, F, v, { points: 14, minValid: 5, skipFiniteDifference: true }).ok; }

  /* ═════════════════════ rule: constants and the table of basic integrals ═════════════════════ */

  const TABLE = new Map();
  (function buildTable() {
    const P = s => CAS.subst(CAS.parse(s), 'x', X);
    const row = (integrand, result, title, formula) => TABLE.set(P(integrand).k, { result: P(result), title, formula });
    row('1/x', 'ln(abs(x))', 'Reciprocal rule', '∫ 1/§ d§ = ln|§|');
    row('e^x', 'e^x', 'Exponential rule', '∫ e^§ d§ = e^§');
    row('sin(x)', '-cos(x)', 'Sine', '∫ sin § d§ = −cos §');
    row('cos(x)', 'sin(x)', 'Cosine', '∫ cos § d§ = sin §');
    row('sec(x)^2', 'tan(x)', 'Secant squared', '∫ sec²§ d§ = tan §');
    row('csc(x)^2', '-cot(x)', 'Cosecant squared', '∫ csc²§ d§ = −cot §');
    row('sec(x)*tan(x)', 'sec(x)', 'Secant times tangent', '∫ sec § tan § d§ = sec §');
    row('csc(x)*cot(x)', '-csc(x)', 'Cosecant times cotangent', '∫ csc § cot § d§ = −csc §');
    row('tan(x)', '-ln(abs(cos(x)))', 'Tangent', '∫ tan § d§ = −ln|cos §|');
    row('cot(x)', 'ln(abs(sin(x)))', 'Cotangent', '∫ cot § d§ = ln|sin §|');
    row('sec(x)', 'ln(abs(sec(x)+tan(x)))', 'Secant', '∫ sec § d§ = ln|sec § + tan §|');
    row('csc(x)', '-ln(abs(csc(x)+cot(x)))', 'Cosecant', '∫ csc § d§ = −ln|csc § + cot §|');
    row('sinh(x)', 'cosh(x)', 'Hyperbolic sine', '∫ sinh § d§ = cosh §');
    row('cosh(x)', 'sinh(x)', 'Hyperbolic cosine', '∫ cosh § d§ = sinh §');
    row('cosh(x)^-2', 'tanh(x)', 'Hyperbolic secant squared', '∫ sech²§ d§ = tanh §');
    row('sinh(x)^-2', '-coth(x)', 'Hyperbolic cosecant squared', '∫ csch²§ d§ = −coth §');
    row('tanh(x)', 'ln(cosh(x))', 'Hyperbolic tangent', '∫ tanh § d§ = ln cosh §');
    row('coth(x)', 'ln(abs(sinh(x)))', 'Hyperbolic cotangent', '∫ coth § d§ = ln|sinh §|');
    row('1/(x^2+1)', 'atan(x)', 'Inverse tangent', '∫ 1/(§² + 1) d§ = arctan §');
    row('1/sqrt(1-x^2)', 'asin(x)', 'Inverse sine', '∫ 1/√(1 − §²) d§ = arcsin §');
    row('1/sqrt(x^2+1)', 'ln(x+sqrt(x^2+1))', 'Inverse hyperbolic sine', '∫ 1/√(§² + 1) d§ = ln(§ + √(§² + 1))');
    row('1/sqrt(x^2-1)', 'ln(abs(x+sqrt(x^2-1)))', 'Inverse hyperbolic cosine', '∫ 1/√(§² − 1) d§ = ln|§ + √(§² − 1)|');
  })();
  const XN = 'ξ';
  const fillVar = (text, v) => text.replace(/§/g, v);

  function ruleConstant(f, v, ctx) {
    if (!isConstIn(f, v)) return null;
    const nd = mkNode('Constant rule', f, v, { formula: '∫ k d' + v + ' = k·' + v, leaf: true });
    return sol(CAS.isZero(f) ? ZERO : simplify(mul(f, sy(v))), nd);
  }

  function ruleTable(f, v, ctx) {
    const fv = CAS.subst(f, v, X);
    const ent = TABLE.get(fv.k);
    if (ent && CAS.freeVars(fv).indexOf(XN) >= 0) {
      const nd = mkNode(ent.title, f, v, { formula: fillVar(ent.formula, v), leaf: true });
      return sol(CAS.subst(ent.result, XN, sy(v)), nd);
    }
    // power rule: v^n
    let n = null;
    if (f.t === 'sym' && f.name === v) n = ONE;
    else if (f.t === 'pow' && f.b.t === 'sym' && f.b.name === v && f.e.t === 'num') n = f.e;
    if (n && !(n.n === -1n && n.d === 1n)) {
      const n1 = simplify(add(n, ONE));
      const nd = mkNode('Power rule', f, v, { formula: '∫ ' + v + 'ⁿ d' + v + ' = ' + v + 'ⁿ⁺¹ / (n + 1)   (n ≠ −1)', leaf: true });
      nd.lines.push('Here n = ' + S(n) + ', so n + 1 = ' + S(n1) + '.');
      return sol(simplify(div(pow(sy(v), n1), n1)), nd);
    }
    // a^v with a constant
    if (f.t === 'pow' && f.e.t === 'sym' && f.e.name === v && isConstIn(f.b, v) && !CAS.isOne(f.b) && !(f.b.t === 'const' && f.b.name === 'e')) {
      const nd = mkNode('Exponential rule (any base)', f, v, { formula: '∫ a^' + v + ' d' + v + ' = a^' + v + ' / ln a', leaf: true });
      nd.lines.push('Here a = ' + S(f.b) + '.');
      return sol(simplify(div(f, ln(f.b))), nd);
    }
    return null;
  }

  /* ═════════════════════ rule: constant multiple ═════════════════════ */

  function ruleConstMultiple(f, v, ctx) {
    if (f.t !== 'mul') return null;
    const consts = f.args.filter(a => isConstIn(a, v)), vary = f.args.filter(a => dependsOn(a, v));
    if (!consts.length || !vary.length) return null;
    const c = mul(...consts), rest = mul(...vary);
    const nd = mkNode('Constant multiple rule', f, v, { formula: '∫ c·f(' + v + ') d' + v + ' = c·∫ f(' + v + ') d' + v });
    nd.lines.push('Take the constant ' + S(c) + ' outside the integral.');
    nd.then = '= ' + (c.t === 'add' ? '(' + S(c) + ')' : S(c)) + ' · ' + intText(rest, v);
    const ch = solveRec(rest, v, ctx);
    if (!ch) return null;
    nd.children.push(ch.node);
    return sol(simplify(mul(c, ch.result)), nd, ch.ph);
  }

  /* ═════════════════════ rule: sum ═════════════════════ */

  function ruleSum(f, v, ctx) {
    if (f.t !== 'add') return null;
    const nd = mkNode('Sum rule', f, v, { formula: '∫ (f + g) d' + v + ' = ∫ f d' + v + ' + ∫ g d' + v });
    nd.lines.push('Integrate the terms one at a time.');
    const parts = [];
    let ph = null;
    for (const t of f.args) {
      const r = solveRec(t, v, ctx);
      if (!r) return null;
      parts.push(r);
      if (r.ph) ph = (ph || []).concat(r.ph);
    }
    parts.forEach(r => { if (leafish(r.node)) nd.lines.push(leafLine(r.node)); else nd.children.push(r.node); });
    nd.then = '= ' + parts.map((r, i) => (leafish(r.node) ? S(r.result) : '[' + intText(r.node.integral, v) + ']')).join(' + ').replace(/\+ -/g, '− ');
    return sol(simplify(add(...parts.map(r => r.result))), nd, ph);
  }

  /* ═════════════════════ rule: substitution ═════════════════════ */

  function replaceS(e, Sx, us, v) {         // replace S (and powers / multiples of S) by u
    const go = x => {
      if (x.k === Sx.k) return us;
      if (x.t === 'pow') {
        if (Sx.t === 'pow' && x.b.k === Sx.b.k && Sx.e.t === 'num' && x.e.t === 'num' && Sx.e.n !== 0n)
          return pow(us, num(0).t === 'num' ? CAS.simplify(div(x.e, Sx.e)) : ONE);
        if (Sx.t === 'pow' && x.b.k === Sx.b.k && !dependsOn(Sx.b, v) && dependsOn(Sx.e, v)) {
          const r = simplify(div(x.e, Sx.e));
          if (r.t === 'num') return pow(us, r);
        }
      }
      if (x.t === 'num' || x.t === 'sym' || x.t === 'const') return x;
      return rebuildWith(x, go);
    };
    return go(e);
  }
  function rebuildWith(e, f) {
    switch (e.t) {
      case 'add': return add(...e.args.map(f));
      case 'mul': return mul(...e.args.map(f));
      case 'pow': return pow(f(e.b), f(e.e));
      case 'fn': return fn(e.name, f(e.a));
      default: return e;
    }
  }
  const sgn0 = e => Q.qsign(e);
  function invertSub(Sx, v, us, late) {           // x as a function of u = S(x), when that is easy
    const lin = e => { const cs = CAS.polyCoeffs(e, v); return cs && cs.length === 2 && !dependsOn(cs[1], v) && !CAS.isZero(cs[1]) ? cs : null; };
    let cs = lin(Sx);
    if (cs) return simplify(div(sub(us, cs[0]), cs[1]));
    if (Sx.t === 'pow' && Sx.e.t === 'num' && !(Sx.e.d === 1n && Sx.e.n % 2n === 0n) && (cs = lin(Sx.b)))
      return simplify(div(sub(pow(us, simplify(div(ONE, Sx.e))), cs[0]), cs[1]));
    cs = CAS.polyCoeffs(Sx, v);             // a x² + b: the x left over is √((u − b)/a)
    if (cs && cs.length === 3 && CAS.isZero(cs[1]) && cs.every(isNum) && sgn0(cs[2]) > 0)
      return pow(simplify(div(sub(us, cs[0]), cs[2])), HALF);
    if (late) {                             // last resort: x from c^(linear) or ln(linear)
      if (Sx.t === 'pow' && isConstIn(Sx.b, v) && (cs = lin(Sx.e))) return simplify(div(sub(div(ln(us), ln(Sx.b)), cs[0]), cs[1]));
      if (Sx.t === 'fn' && Sx.name === 'ln' && (cs = lin(Sx.a))) return simplify(div(sub(exp(us), cs[0]), cs[1]));
    }
    return null;
  }
  function uCandidates(f, v) {
    const seen = new Map();
    const addC = (e, inner) => {            // inner: the argument or base of something, which students try first
      if (e.k === f.k || e.t === 'sym' || e.t === 'num' || !dependsOn(e, v)) return;
      const old = seen.get(e.k);
      if (!old) seen.set(e.k, { e, inner });
      else if (inner) old.inner = true;
    };
    const walk = e => {
      switch (e.t) {
        case 'fn': addC(e.a, true); addC(e, false); walk(e.a); break;
        case 'pow':
          addC(e.b, true);
          if (dependsOn(e.e, v)) { addC(e.e, true); addC(e, false); } else if (e.e.t === 'num' && e.e.d !== 1n) addC(e, false);
          walk(e.b); walk(e.e); break;
        case 'add': case 'mul': e.args.forEach(walk); break;
        default:
      }
    };
    walk(f);
    return Array.from(seen.values()).slice(0, 18);
  }
  function substituteInto(f, Sx, dS, v, us, g) {
    const attempts = [simplify(div(f, dS))];
    const sc = splitContent(dS);
    if (!CAS.isOne(sc.c) && sc.rest.k !== dS.k) attempts.push(simplify(mul(f, pow(sc.rest, MINUS_ONE), pow(sc.c, MINUS_ONE))));
    for (const q0 of attempts) {
      let R = replaceS(q0, Sx, us, v);
      if (dependsOn(R, v)) { if (!g) continue; R = simplify(CAS.subst(R, v, g)); }
      if (dependsOn(R, v)) continue;
      return R;
    }
    return null;
  }

  function uSubPass(f, v, ctx, mode) {      // mode 0: no solving for x; 1: x from a linear / radical / even-power u; 2: also through ln and exp
    if (f.t === 'sym') return null;
    const options = [];
    for (const { e: Sx, inner } of uCandidates(f, v)) {
      tick(ctx);
      const dS = CAS.diff(Sx, v);
      if (CAS.isZero(dS)) continue;
      const u = freshVar(f, v), us = sy(u), g = mode ? invertSub(Sx, v, us, mode === 2) : null;
      if (mode && !g) continue;
      const R = substituteInto(f, Sx, dS, v, us, g);
      if (R && R.k !== f.k) options.push({ Sx, dS, u, us, R, g, inner });
    }
    options.sort((a, b) => (a.inner ? 0 : 1) - (b.inner ? 0 : 1) || size(a.R) - size(b.R) || size(b.Sx) - size(a.Sx));
    let tried = 0;
    for (const o of options) {
      if (tried++ >= 3) break;
      const nd = mkNode('Substitution', f, v, { formula: '∫ f(g(' + v + '))·g′(' + v + ') d' + v + ' = ∫ f(' + o.u + ') d' + o.u + '   with ' + o.u + ' = g(' + v + ')' });
      nd.lines.push('Let ' + o.u + ' = ' + S(o.Sx) + '.');
      nd.lines.push('Then d' + o.u + ' = ' + (CAS.isOne(o.dS) ? '' : (o.dS.t === 'add' ? '(' + S(o.dS) + ')' : S(o.dS)) + ' ') + 'd' + v + '.');
      if (o.g) nd.lines.push('Also ' + v + ' = ' + S(o.g) + ', so every ' + v + ' left in the integrand can be written with ' + o.u + '.');
      nd.lines.push('The integral becomes ∫ ' + (o.R.t === 'add' ? '(' + S(o.R) + ')' : S(o.R)) + ' d' + o.u + '.');
      nd.then = '= ' + intText(o.R, o.u);
      const ch = limited(ctx, mode ? 300 : 700, () => solveRec(o.R, o.u, ctx));
      if (!ch) continue;
      nd.children.push(ch.node);
      const back = simplify(CAS.subst(ch.result, o.u, o.Sx));
      nd.combine = 'Replace ' + o.u + ' by ' + S(o.Sx) + ':  ' + intText(f, v) + ' = ' + S(back);
      return sol(back, nd, ch.ph);
    }
    return null;
  }
  const ruleUSubDirect = (f, v, ctx) => uSubPass(f, v, ctx, 0);
  const ruleUSubInvert = (f, v, ctx) => uSubPass(f, v, ctx, 1);
  const ruleUSubInvertLate = (f, v, ctx) => uSubPass(f, v, ctx, 2);

  /* ═════════════════════ rule: integration by parts ═════════════════════ */

  const INV_TRIG = ['asin', 'acos', 'atan', 'acot', 'asinh', 'acosh', 'atanh'];
  const TRIGISH = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'sech', 'csch'];
  const LIATE_NAMES = ['logarithm', 'inverse trigonometric', 'algebraic', 'trigonometric', 'exponential'];
  function liate(x, v) {
    let b = x;
    if (x.t === 'pow' && x.e.t === 'num' && x.e.d === 1n && x.b.t === 'fn') b = x.b;
    if (b.t === 'fn') { if (b.name === 'ln') return 0; if (INV_TRIG.indexOf(b.name) >= 0) return 1; if (TRIGISH.indexOf(b.name) >= 0) return 3; }
    if (x.t === 'pow' && dependsOn(x.e, v)) return 4;
    return 2;
  }
  function partsChoices(f, v) {
    const out = [];
    if (f.t !== 'mul') {
      const c = liate(f, v);
      if (c <= 1) out.push({ u: f, dv: ONE, why: 'no other factor, so take dv = d' + v + ' (' + LIATE_NAMES[c] + ' function)' });
      return out;
    }
    const fs = f.args.filter(a => dependsOn(a, v));
    const consts = f.args.filter(a => !dependsOn(a, v));
    const cst = mul(...consts);
    const groups = [[], [], [], [], []];
    fs.forEach(a => groups[liate(a, v)].push(a));
    const present = groups.map((g, i) => (g.length ? i : -1)).filter(i => i >= 0);
    for (const c of present) {
      if (present.length === 1 && groups[c].length < 2) continue;
      if (present.length > 1) {
        const u = mul(...groups[c]);
        const rest = mul(cst, ...fs.filter(a => groups[c].indexOf(a) < 0));
        out.push({ u, dv: rest, why: 'LIATE: ' + LIATE_NAMES[c] + ' functions come first' });
      }
    }
    if (present.length === 1) fs.forEach(a => { out.push({ u: a, dv: mul(cst, ...fs.filter(b => b !== a)), why: 'one factor has to be u, the rest is dv' }); });
    return out;
  }

  function ruleParts(f, v, ctx) {
    if (ctx.depth > ctx.maxDepth - 3) return null;
    const choices = partsChoices(f, v);
    let tries = 0;
    for (const ch of choices) {
      if (tries++ >= 4) break;
      tick(ctx);
      const uX = simplify(ch.u), dvX = simplify(ch.dv);
      const vs = limited(ctx, 300, () => solveRec(dvX, v, ctx));
      if (!vs || vs.ph) continue;
      const du = CAS.diff(uX, v);
      const G = simplify(mul(vs.result, du));
      if (G.k === f.k) continue;
      const used = CAS.freeVars(f).concat(CAS.freeVars(G));
      const phName = PH_NAMES.filter(n => used.indexOf(n) < 0 && !ctx.chain.some(e => e.ph.name === n))[0] || 'I1';
      const ent = { f, v, ph: sym(phName), used: false };
      ctx.chain.push(ent);
      let g;
      try { g = limited(ctx, 900, () => solveRec(G, v, ctx)); } finally { ctx.chain.pop(); }
      if (!g) continue;
      const uv = simplify(mul(uX, vs.result));
      let total = simplify(sub(uv, g.result));
      const nd = mkNode('Integration by parts', f, v, { formula: '∫ u dv = u·v − ∫ v du' });
      nd.lines.push('Choose u = ' + S(uX) + ' and dv = ' + (CAS.isOne(dvX) ? 'd' + v : S(dvX) + ' d' + v) + '   (' + ch.why + ').');
      nd.lines.push('Then du = ' + (CAS.isOne(du) ? 'd' + v : S(du) + ' d' + v) + ' and v = ∫ dv = ' + S(vs.result) + '.');
      nd.then = '= ' + (CAS.isZero(uv) ? '' : (uv.t === 'add' ? '(' + S(uv) + ')' : S(uv)) + ' − ') + intText(G, v);
      if (!leafish(vs.node)) { vs.node.title = 'Finding v: ' + vs.node.title; nd.children.push(vs.node); }
      nd.children.push(g.node);
      let ph = g.ph ? g.ph.filter(n => n !== phName) : null;
      if (ph && !ph.length) ph = null;
      if (ent.used) {
        const cs = CAS.polyCoeffs(total, phName);
        if (!cs || cs.length > 2 || (cs[1] && dependsOn(cs[1], v))) continue;
        const A1 = cs[1] || ZERO, A0 = cs[0];
        const den = simplify(sub(ONE, A1));
        if (CAS.isZero(den) || dependsOn(den, v)) continue;
        const resultV = simplify(div(A0, den));
        nd.combine = 'The original integral ' + phName + ' has come back: ' + phName + ' = ' + S(A0) + (CAS.isZero(A1) ? '' : ' + (' + S(A1) + ')·' + phName) +
          '. Solving for ' + phName + ' gives ' + phName + ' = ' + S(resultV) + '.';
        return sol(resultV, nd, ph);
      }
      nd.combine = intText(f, v) + ' = ' + S(total);
      return sol(total, nd, ph);
    }
    return null;
  }

  /* ═════════════════════ rule: expand the integrand ═════════════════════ */

  function ruleExpand(f, v, ctx) {
    if (f.t !== 'mul' && f.t !== 'pow') return null;
    const ex = CAS.expand(f);
    if (ex.k === f.k || ex.t !== 'add' || ex.args.length > 40) return null;
    const nd = mkNode('Expand', f, v, { formula: null });
    nd.lines.push('Multiply out the brackets so that each term can be integrated on its own.');
    nd.then = '= ' + intText(ex, v);
    const ch = solveRec(ex, v, ctx);
    if (!ch) return null;
    nd.children.push(ch.node);
    return sol(ch.result, nd, ch.ph);
  }

  /* ═════════════════════ rule: standard forms with a constant, reduction, completing the square ═════════════════════ */

  const numQuad = (Q, v) => {               // a2 v² + a0 with numeric coefficients -> {a0, a1, a2} (as number nodes) or null
    if (!dependsOn(Q, v)) return null;
    const cs = CAS.polyCoeffs(Q, v);
    if (!cs || cs.length !== 3 || !cs.every(isNum)) return null;
    return { a0: cs[0], a1: cs[1], a2: cs[2] };
  };
  const sgn = e => Q.qsign(e);

  function ruleStandardForms(f, v, ctx) {
    if (f.t !== 'pow' || f.e.t !== 'num') return null;
    const recip = f.e.n === -1n && f.e.d === 1n, root = f.e.n === -1n && f.e.d === 2n;
    if (!recip && !root) return null;
    const q = numQuad(f.b, v);
    if (!q || !CAS.isZero(q.a1)) return null;
    const x = sy(v), a0 = q.a0, a2 = q.a2;
    const Qs = S(f.b);
    if (recip && sgn(a2) > 0 && sgn(a0) > 0) {
      const a = sqrt(simplify(div(a0, a2)));
      const nd = mkNode('Inverse tangent form', f, v, { formula: '∫ 1/(' + v + '² + a²) d' + v + ' = (1/a)·arctan(' + v + '/a)', leaf: true });
      nd.lines.push('Write ' + Qs + ' = ' + (CAS.isOne(a2) ? '' : S(a2) + '·') + '(' + v + '² + a²) with a² = ' + S(simplify(div(a0, a2))) + ', so a = ' + S(a) + '.');
      return sol(simplify(div(fn('atan', div(x, a)), mul(a2, a))), nd);
    }
    if (root && sgn(a2) < 0 && sgn(a0) > 0) {
      const k = sqrt(neg(a2));
      const nd = mkNode('Inverse sine form', f, v, { formula: '∫ 1/√(a² − ' + v + '²) d' + v + ' = arcsin(' + v + '/a)', leaf: true });
      nd.lines.push('Write ' + Qs + ' = ' + S(a0) + ' − ' + S(neg(a2)) + v + '²: with ' + S(k) + '·' + v + ' = t this is 1/' + S(k) + ' times ∫ dt/√(' + S(a0) + ' − t²).');
      return sol(simplify(div(fn('asin', mul(x, div(k, sqrt(a0)))), k)), nd);
    }
    if (root && sgn(a2) > 0 && sgn(a0) !== 0) {
      const k = sqrt(a2), r = f.b.t === 'pow' ? f.b : f.b;
      const arg = add(mul(k, x), sqrt(f.b));
      const nd = mkNode('Inverse hyperbolic sine form', f, v, { formula: '∫ 1/√(' + v + '² ± a²) d' + v + ' = ln|' + v + ' + √(' + v + '² ± a²)|', leaf: true });
      nd.lines.push('Write ' + Qs + ' in the form ' + S(a2) + '·(' + v + '² ' + (sgn(a0) > 0 ? '+' : '−') + ' a²) and use the formula with the factor 1/' + S(k) + '.');
      return sol(simplify(div(sgn(a0) > 0 ? ln(arg) : ln(fn('abs', arg)), k)), nd);
    }
    return null;
  }

  function ruleQuadReduction(f, v, ctx) {   // ∫ dx / (a x² + c)^k
    if (f.t !== 'pow' || f.e.t !== 'num' || f.e.d !== 1n || f.e.n > -2n) return null;
    const q = numQuad(f.b, v);
    if (!q || !CAS.isZero(q.a1) || CAS.isZero(q.a0) || CAS.isZero(q.a2)) return null;
    const k = -Number(f.e.n), x = sy(v);
    const lower = pow(f.b, num(-(k - 1)));
    const nd = mkNode('Reduction formula', f, v, { formula: '∫ dx/(a x² + c)ⁿ = [ x/(a x² + c)ⁿ⁻¹ + (2n − 3)·∫ dx/(a x² + c)ⁿ⁻¹ ] / (2(n − 1)·c)' });
    nd.lines.push('Here n = ' + k + ', a = ' + S(q.a2) + ' and c = ' + S(q.a0) + '.');
    nd.then = '= [ ' + S(mul(x, lower)) + ' + ' + (2 * k - 3) + '·' + intText(lower, v) + ' ] / ' + S(simplify(mul(num(2 * (k - 1)), q.a0)));
    const ch = solveRec(lower, v, ctx);
    if (!ch) return null;
    nd.children.push(ch.node);
    return sol(simplify(div(add(mul(x, lower), mul(num(2 * k - 3), ch.result)), mul(num(2 * (k - 1)), q.a0))), nd, ch.ph);
  }

  function ruleCompleteSquare(f, v, ctx) {
    let found = null;
    const walk = e => {
      if (found) return;
      if (e.t === 'pow' && e.e.t === 'num' && !(e.e.d === 1n && e.e.n > 0n)) {
        const q = numQuad(e.b, v);
        if (q && !CAS.isZero(q.a1) && !CAS.isZero(q.a2)) { found = { Q: e.b, q }; return; }
      }
      if (e.t === 'add' || e.t === 'mul') e.args.forEach(walk);
      else if (e.t === 'pow') { walk(e.b); walk(e.e); } else if (e.t === 'fn') walk(e.a);
    };
    walk(f);
    if (!found) return null;
    const { Q: Qx, q } = found;
    const w = freshVar(f, v), ws = sy(w);
    const h = simplify(div(q.a1, mul(TWO, q.a2)));
    const beta = simplify(sub(q.a0, div(mul(q.a1, q.a1), mul(num(4), q.a2))));
    const Qw = add(mul(q.a2, pow(ws, TWO)), beta);
    const rep = x => (x.k === Qx.k ? Qw : x.t === 'num' || x.t === 'sym' || x.t === 'const' ? x : rebuildWith(x, rep));
    const fw = simplify(CAS.subst(rep(f), v, sub(ws, h)));
    if (dependsOn(fw, v)) return null;
    const nd = mkNode('Complete the square', f, v, { formula: 'a·x² + b·x + c = a·(x + b/(2a))² + (c − b²/(4a))' });
    nd.lines.push(S(Qx) + ' = ' + S(Qw.t === 'add' && false ? Qw : mul(q.a2, pow(add(sy(v), h), TWO))) + ' + ' + S(beta) + ' = ' + S(mul(q.a2, pow(add(sy(v), h), TWO))) + (sgn(beta) < 0 ? ' − ' + S(neg(beta)) : ' + ' + S(beta)) + '.');
    nd.lines.push('Let ' + w + ' = ' + S(add(sy(v), h)) + ', so ' + v + ' = ' + S(sub(ws, h)) + ' and d' + w + ' = d' + v + '.');
    nd.then = '= ' + intText(fw, w);
    const ch = solveRec(fw, w, ctx);
    if (!ch) return null;
    nd.children.push(ch.node);
    const back = simplify(CAS.subst(ch.result, w, add(sy(v), h)));
    nd.combine = 'Replace ' + w + ' by ' + S(add(sy(v), h)) + ':  ' + intText(f, v) + ' = ' + S(back);
    return sol(back, nd, ch.ph);
  }

  /* ═════════════════════ rule: rational functions (partial fractions) ═════════════════════ */

  function ruleRational(f, v, ctx) {
    if (CAS.freeVars(f).some(n => n !== v)) return null;
    if (f.t === 'sym') return null;
    const T = CAS.together(f);
    const cn = CAS.polyCoeffs(T.n, v), cd = CAS.polyCoeffs(T.d, v);
    if (!cn || !cd || !cn.every(isNum) || !cd.every(isNum) || cd.length < 2) return null;
    const x = sy(v);
    const dN = cn.length - 1, dD = cd.length - 1;
    // 1. cancel a common factor
    const g = CAS.polyGcd(T.n, T.d, v);
    const gd = g ? CAS.polyCoeffs(g, v).length - 1 : 0;
    if (gd >= 1) {
      const nq = CAS.polyDivide(T.n, g, v).q, dq = CAS.polyDivide(T.d, g, v).q;
      const f2 = simplify(div(nq, dq));
      if (f2.k === f.k) return null;
      const nd = mkNode('Cancel the common factor', f, v, { formula: null });
      nd.lines.push('The numerator and denominator share the factor ' + S(g) + '. Cancel it.');
      nd.then = '= ' + intText(f2, v);
      const ch = solveRec(f2, v, ctx);
      if (!ch) return null;
      nd.children.push(ch.node);
      return sol(ch.result, nd, ch.ph);
    }
    // 2. improper fraction: divide first
    if (dN >= dD) {
      const dv = CAS.polyDivide(T.n, T.d, v);
      const f2 = simplify(add(dv.q, div(dv.r, T.d)));
      const nd = mkNode('Polynomial long division', f, v, { formula: 'N/D = quotient + remainder/D' });
      nd.lines.push('The numerator has degree ' + dN + ', which is not less than the degree ' + dD + ' of the denominator, so divide first.');
      nd.lines.push(S(T.n) + ' = (' + S(T.d) + ')·(' + S(dv.q) + ')' + (CAS.isZero(dv.r) ? '' : ' + (' + S(dv.r) + ')') + '.');
      nd.then = '= ' + intText(f2, v);
      const ch = solveRec(f2, v, ctx);
      if (!ch) return null;
      nd.children.push(ch.node);
      return sol(ch.result, nd, ch.ph);
    }
    // 3. proper fraction: partial fractions
    const pf = CAS.partialFractions(T.n, T.d, v);
    if (!pf) return null;
    if (pf.terms.length === 1 && pf.terms[0].degree === 2) {   // one irreducible quadratic: split the numerator, then complete the square
      const t = pf.terms[0], Qp = CAS.polyCoeffs(t.factor, v), Np = CAS.polyCoeffs(t.num, v);
      const B = Np[1] || ZERO, C = Np[0], a = Qp[2], b = Qp[1];
      if (CAS.isZero(B)) return null;
      const dQ = add(mul(TWO, a, x), b);
      const D0 = simplify(sub(C, div(mul(B, b), mul(TWO, a))));
      const Qk = pow(t.factor, num(-t.power));
      const f2 = simplify(add(mul(div(B, mul(TWO, a)), dQ, Qk), mul(D0, Qk)));
      if (f2.k === f.k) return null;
      const nd = mkNode('Split the numerator', f, v, { formula: 'B·x + C = (B/(2a))·(2a·x + b) + (C − B·b/(2a))' });
      nd.lines.push('The denominator ' + S(t.factor) + ' has derivative ' + S(dQ) + '. Write the numerator ' + S(t.num) + ' as ' + S(simplify(div(B, mul(TWO, a)))) + '·(' + S(dQ) + ') + ' + S(D0) + '.');
      nd.then = '= ' + intText(f2, v);
      const ch = solveRec(f2, v, ctx);
      if (!ch) return null;
      nd.children.push(ch.node);
      return sol(ch.result, nd, ch.ph);
    }
    if (pf.terms.length === 1 && pf.terms[0].degree === 1 && CAS.isZero(pf.poly)) return null;
    const f2 = simplify(add(pf.poly, ...pf.terms.map(t => t.expr)));
    if (f2.k === f.k) return null;
    const nd = mkNode('Partial fractions', f, v, { formula: 'N/D = A/(x − r) + … + (Bx + C)/(x² + px + q) + …' });
    const facText = pf.factors.map(q => '(' + S(q.poly) + ')' + (q.mult > 1 ? sup(q.mult) : '')).join('');
    const facFull = (CAS.isOne(pf.content) ? '' : S(pf.content) + '·') + facText, dExp = S(CAS.expand(T.d));
    nd.lines.push(dExp === facFull || S(T.d) === facFull ? 'The denominator is already factored: ' + facFull + '.' : 'Factor the denominator: ' + dExp + ' = ' + facFull + '.');
    const tmpl = pf.template.map(t => (t.unknowns.length === 1 ? S(t.template) : '(' + S(t.template) + ')') + '/' + (t.power > 1 || t.factor.t === 'add' ? '(' + S(t.factor) + ')' + (t.power > 1 ? sup(t.power) : '') : S(t.factor))).join(' + ');
    nd.lines.push('Write ' + S(simplify(div(T.n, T.d))) + ' = ' + tmpl + '.');
    const Dp = mul(...pf.factors.map(q => pow(q.poly, num(q.mult))));
    const rhs = add(...pf.template.map(t => mul(t.template, pow(Dp, ONE), pow(pow(t.factor, num(t.power)), MINUS_ONE))));
    nd.lines.push('Multiply both sides by the denominator: ' + S(simplify(div(T.n, pf.content))) + ' = ' + S(rhs) + '.');
    nd.lines.push('Equate coefficients of like powers of ' + v + ' (or put in convenient values of ' + v + ') and solve: ' + pf.unknownNames.map(nm => nm + ' = ' + S(pf.values[nm])).join(', ') + '.');
    nd.then = '= ' + intText(f2, v);
    const ch = solveRec(f2, v, ctx);
    if (!ch) return null;
    nd.children.push(ch.node);
    return sol(ch.result, nd, ch.ph);
  }

  /* ═════════════════════ rule: trigonometric powers, products, reduction ═════════════════════ */

  const TRIG6 = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc'];
  function trigDecompose(f, v) {
    const fs = f.t === 'mul' ? f.args : [f];
    const consts = [], exps = {};
    let A = null;
    for (const t of fs) {
      if (!dependsOn(t, v)) { consts.push(t); continue; }
      let base = t, e = 1;
      if (t.t === 'pow' && t.e.t === 'num' && t.e.d === 1n) { base = t.b; e = Number(t.e.n); }
      if (base.t !== 'fn' || TRIG6.indexOf(base.name) < 0) return null;
      if (A === null) A = base.a; else if (A.k !== base.a.k) return null;
      exps[base.name] = (exps[base.name] || 0) + e;
    }
    if (!A) return null;
    const cs = CAS.polyCoeffs(A, v);
    if (!cs || cs.length !== 2 || dependsOn(cs[1], v)) return null;
    return { c: mul(...consts), A, exps };
  }
  function trigRewrite(f, v, ctx, title, formula, lines, f2) {
    f2 = simplify(f2);
    if (f2.k === f.k) return null;
    const nd = mkNode(title, f, v, { formula });
    nd.lines = lines;
    nd.then = '= ' + intText(f2, v);
    const ch = solveRec(f2, v, ctx);
    if (!ch) return null;
    nd.children.push(ch.node);
    return sol(ch.result, nd, ch.ph);
  }
  const P2 = (e, n) => pow(e, num(n));

  function sinCosRule(f, v, ctx, d, a, b) {
    const A = d.A, s = fn('sin', A), c = fn('cos', A), K = d.c;
    const nm = (b2) => 'sin' + (b2 ? '' : '');
    if (b > 0 && b % 2 === 1)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', 'cos²θ = 1 − sin²θ',
        ['The power of cosine is odd (' + b + '). Keep one cosine for the substitution u = ' + S(s) + ' and write the other cosines with cos² = 1 − sin².'],
        mul(K, pow(s, num(a)), P2(sub(ONE, P2(s, 2)), (b - 1) / 2), c));
    if (a > 0 && a % 2 === 1)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', 'sin²θ = 1 − cos²θ',
        ['The power of sine is odd (' + a + '). Keep one sine for the substitution u = ' + S(c) + ' and write the other sines with sin² = 1 − cos².'],
        mul(K, pow(c, num(b)), P2(sub(ONE, P2(c, 2)), (a - 1) / 2), s));
    if (a >= 0 && b >= 0 && a % 2 === 0 && b % 2 === 0) {
      const A2 = mul(TWO, A);
      if (a === b && a >= 2)
        return trigRewrite(f, v, ctx, 'Trigonometric identity', 'sin θ cos θ = ½ sin 2θ',
          ['Both powers are even and equal: use sin ' + S(A) + ' cos ' + S(A) + ' = ½ sin(' + S(A2) + ').'],
          CAS.expand(mul(K, pow(mul(HALF, fn('sin', A2)), num(a)))));
      return trigRewrite(f, v, ctx, 'Trigonometric identity (power reduction)', 'sin²θ = (1 − cos 2θ)/2,   cos²θ = (1 + cos 2θ)/2',
        ['Both powers are even, so lower them with the half-angle formulas.'],
        CAS.expand(mul(K, P2(mul(HALF, sub(ONE, fn('cos', A2))), a / 2), P2(mul(HALF, add(ONE, fn('cos', A2))), b / 2))));
    }
    if (a < 0 && b >= 0 && b % 2 === 0)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', 'cos²θ = 1 − sin²θ',
        ['Write cos' + (b > 2 ? sup(b) : '²') + ' with cos² = 1 − sin², so only powers of sine remain.'],
        CAS.expand(mul(K, pow(s, num(a)), P2(sub(ONE, P2(s, 2)), b / 2))));
    if (b < 0 && a >= 0 && a % 2 === 0)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', 'sin²θ = 1 − cos²θ',
        ['Write sin' + (a > 2 ? sup(a) : '²') + ' with sin² = 1 − cos², so only powers of cosine remain.'],
        CAS.expand(mul(K, pow(c, num(b)), P2(sub(ONE, P2(c, 2)), a / 2))));
    if (a < 0 && b < 0)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', 'sin²θ + cos²θ = 1',
        ['Multiply by 1 = sin² + cos² to raise the exponents.'],
        CAS.expand(mul(K, add(P2(s, 2), P2(c, 2)), pow(s, num(a)), pow(c, num(b)))));
    return null;
  }

  function tanSecRule(f, v, ctx, d, m, n, co) {   // co: false = tan/sec, true = cot/csc
    const A = d.A, K = d.c;
    const t = fn(co ? 'cot' : 'tan', A), sc = fn(co ? 'csc' : 'sec', A);
    const T = co ? 'cot' : 'tan', Sx = co ? 'csc' : 'sec';
    const id = co ? 'cot²θ = csc²θ − 1' : 'tan²θ = sec²θ − 1';
    const id2 = co ? 'csc²θ = 1 + cot²θ' : 'sec²θ = 1 + tan²θ';
    if (n >= 2 && n % 2 === 0)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', id2,
        ['The power of ' + Sx + ' is even. Keep ' + Sx + '² for the substitution u = ' + S(t) + ' and write the rest with ' + Sx + '² = 1 + ' + T + '².'],
        mul(K, pow(t, num(m)), P2(add(ONE, P2(t, 2)), (n - 2) / 2), P2(sc, 2)));
    if (m % 2 === 1 && n >= 1)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', id,
        ['The power of ' + T + ' is odd. Keep one ' + Sx + '·' + T + ' for the substitution u = ' + S(sc) + ' and write the other ' + T + 's with ' + T + '² = ' + Sx + '² − 1.'],
        mul(K, P2(sub(P2(sc, 2), ONE), (m - 1) / 2), pow(sc, num(n - 1)), sc, t));
    if (n === 0 && m >= 2)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', id,
        ['Split off ' + T + '² = ' + Sx + '² − 1 to lower the power.'],
        mul(K, sub(mul(pow(t, num(m - 2)), P2(sc, 2)), pow(t, num(m - 2)))));
    if (n % 2 === 1 && m % 2 === 0 && n >= 1)
      return trigRewrite(f, v, ctx, 'Trigonometric identity', id,
        ['The power of ' + Sx + ' is odd and the power of ' + T + ' is even: write ' + T + '² = ' + Sx + '² − 1 so only powers of ' + Sx + ' remain.'],
        CAS.expand(mul(K, P2(sub(P2(sc, 2), ONE), m / 2), pow(sc, num(n)))));
    return null;
  }

  function secCscReduction(f, v, ctx, d, n, co) {
    if (d.A.k !== v || n < 3 || n % 2 === 0) return null;
    const x = sy(v), nm = co ? 'csc' : 'sec', other = co ? 'cot' : 'tan';
    const lower = pow(fn(nm, x), num(n - 2));
    const nd = mkNode('Reduction formula for ' + nm + ' powers', f, v, { formula: co ? '∫ cscⁿ x dx = −cscⁿ⁻² x·cot x/(n − 1) + (n − 2)/(n − 1)·∫ cscⁿ⁻² x dx' : '∫ secⁿ x dx = secⁿ⁻² x·tan x/(n − 1) + (n − 2)/(n − 1)·∫ secⁿ⁻² x dx' });
    nd.lines.push('Here n = ' + n + '.');
    nd.then = '= ' + S(simplify(div(mul(co ? MINUS_ONE : ONE, lower, fn(other, x)), num(n - 1)))) + ' + ' + S(num(n - 2, n - 1)) + '·' + intText(lower, v);
    const ch = solveRec(lower, v, ctx);
    if (!ch) return null;
    nd.children.push(ch.node);
    return sol(simplify(add(div(mul(co ? MINUS_ONE : ONE, lower, fn(other, x)), num(n - 1)), mul(num(n - 2, n - 1), ch.result))), nd, ch.ph);
  }

  function trigProduct(f, v, ctx) {           // sin(P)cos(Q), sin(P)sin(Q), cos(P)cos(Q) with different arguments
    if (f.t !== 'mul') return null;
    const vary = f.args.filter(a => dependsOn(a, v)), consts = f.args.filter(a => !dependsOn(a, v));
    if (vary.length !== 2 || !vary.every(a => a.t === 'fn' && (a.name === 'sin' || a.name === 'cos'))) return null;
    const lin = e => { const cs = CAS.polyCoeffs(e, v); return cs && cs.length === 2 && !dependsOn(cs[1], v); };
    if (!lin(vary[0].a) || !lin(vary[1].a) || vary[0].a.k === vary[1].a.k) return null;
    let [p, q] = vary;
    if (p.name === 'cos' && q.name === 'sin') [p, q] = [q, p];       // put sin first when there is one
    const P = p.a, Qa = q.a, K = mul(...consts);
    let f2, id;
    if (p.name === 'sin' && q.name === 'cos') { f2 = mul(HALF, add(fn('sin', add(P, Qa)), fn('sin', sub(P, Qa)))); id = 'sin P cos Q = ½[sin(P + Q) + sin(P − Q)]'; }
    else if (p.name === 'sin' && q.name === 'sin') { f2 = mul(HALF, sub(fn('cos', sub(P, Qa)), fn('cos', add(P, Qa)))); id = 'sin P sin Q = ½[cos(P − Q) − cos(P + Q)]'; }
    else { f2 = mul(HALF, add(fn('cos', sub(P, Qa)), fn('cos', add(P, Qa)))); id = 'cos P cos Q = ½[cos(P − Q) + cos(P + Q)]'; }
    return trigRewrite(f, v, ctx, 'Product-to-sum identity', id, ['Turn the product into a sum so that each term can be integrated.'], mul(K, f2));
  }

  function ruleTrig(f, v, ctx) {
    const d = trigDecompose(f, v);
    if (!d) return trigProduct(f, v, ctx);
    const e = k => d.exps[k] || 0;
    const names = Object.keys(d.exps).filter(k => d.exps[k] !== 0);
    if (!names.length) return null;
    // 1/cos^n is sec^n, 1/sin^n is csc^n, sin^n/cos^n is tan^n, cos^n/sin^n is cot^n
    const sA = e('sin'), cA = e('cos');
    if (names.every(k => k === 'sin' || k === 'cos')) {
      let f2 = null, note = '';
      if (sA === 0 && cA < 0) { f2 = pow(fn('sec', d.A), num(-cA)); note = '1/cos = sec'; }
      else if (cA === 0 && sA < 0) { f2 = pow(fn('csc', d.A), num(-sA)); note = '1/sin = csc'; }
      else if (sA > 0 && cA === -sA) { f2 = pow(fn('tan', d.A), num(sA)); note = 'sin/cos = tan'; }
      else if (sA < 0 && cA === -sA) { f2 = pow(fn('cot', d.A), num(cA)); note = 'cos/sin = cot'; }
      if (f2) return trigRewrite(f, v, ctx, 'Name the reciprocal functions', 'sec = 1/cos,  csc = 1/sin,  tan = sin/cos,  cot = cos/sin', ['Write the quotient with its own name: ' + note + '.'], mul(d.c, f2));
    }
    if (names.every(k => k === 'sin' || k === 'cos')) return sinCosRule(f, v, ctx, d, e('sin'), e('cos'));
    if (names.every(k => (k === 'tan' || k === 'sec') && e(k) > 0)) {
      if (names.length === 1 && names[0] === 'sec') { const r = secCscReduction(f, v, ctx, d, e('sec'), false); if (r) return r; }
      return tanSecRule(f, v, ctx, d, e('tan'), e('sec'), false);
    }
    if (names.every(k => (k === 'cot' || k === 'csc') && e(k) > 0)) {
      if (names.length === 1 && names[0] === 'csc') { const r = secCscReduction(f, v, ctx, d, e('csc'), true); if (r) return r; }
      return tanSecRule(f, v, ctx, d, e('cot'), e('csc'), true);
    }
    // anything else: write everything with sine and cosine
    const a = e('sin') + e('tan') - e('csc') - e('cot'), b = e('cos') - e('tan') - e('sec') + e('cot');
    const f2 = mul(d.c, pow(fn('sin', d.A), num(a)), pow(fn('cos', d.A), num(b)));
    return trigRewrite(f, v, ctx, 'Rewrite with sine and cosine', 'tan = sin/cos,  sec = 1/cos,  cot = cos/sin,  csc = 1/sin', ['Write every trigonometric function in terms of sine and cosine.'], f2);
  }

  /* ═════════════════════ rule: trigonometric substitution ═════════════════════ */

  function multipleAngle(G, th) {            // sin(mθ), cos(mθ) for integers m in 2..8 -> polynomials in sin θ and cos θ
    const s = fn('sin', th), c = fn('cos', th);
    const tab = { 1: [s, c] };
    for (let m = 2; m <= 8; m++) {
      const [sp, cp] = tab[m - 1];
      tab[m] = [CAS.expand(add(mul(sp, c), mul(cp, s))), CAS.expand(sub(mul(cp, c), mul(sp, s)))];
    }
    const go = x => {
      if (x.t === 'fn' && (x.name === 'sin' || x.name === 'cos') && x.a.t === 'mul' && x.a.args.length === 2 && x.a.args[0].t === 'num' && x.a.args[1].k === th.k && x.a.args[0].d === 1n) {
        const m = Number(x.a.args[0].n);
        if (m >= 2 && m <= 8) return tab[m][x.name === 'sin' ? 0 : 1];
      }
      return x.t === 'num' || x.t === 'sym' || x.t === 'const' ? x : rebuildWith(x, go);
    };
    return go(G);
  }

  function ruleTrigSub(f, v, ctx) {
    let found = null;
    const walk = e => {
      if (found) return;
      if (e.t === 'pow' && e.e.t === 'num' && e.e.d === 2n) {
        const q = numQuad(e.b, v);
        if (q && CAS.isZero(q.a1) && !CAS.isZero(q.a2)) { found = { Q: e.b, q }; return; }
      }
      if (e.t === 'add' || e.t === 'mul') e.args.forEach(walk);
      else if (e.t === 'pow') { walk(e.b); walk(e.e); } else if (e.t === 'fn') walk(e.a);
    };
    walk(f);
    if (!found) return null;
    const { Q: Qx, q } = found, alpha = q.a2, beta = q.a0;
    const th = sy('theta'), x = sy(v);
    let kind, kappa, gx, Rq, Qth;
    if (sgn(alpha) > 0 && sgn(beta) > 0) { kind = 'tan'; kappa = sqrt(simplify(div(beta, alpha))); gx = mul(kappa, fn('tan', th)); Rq = mul(sqrt(beta), fn('sec', th)); Qth = mul(beta, P2(fn('sec', th), 2)); }
    else if (sgn(alpha) < 0 && sgn(beta) > 0) { kind = 'sin'; kappa = sqrt(simplify(div(beta, neg(alpha)))); gx = mul(kappa, fn('sin', th)); Rq = mul(sqrt(beta), fn('cos', th)); Qth = mul(beta, P2(fn('cos', th), 2)); }
    else if (sgn(alpha) > 0 && sgn(beta) < 0) { kind = 'sec'; kappa = sqrt(simplify(div(neg(beta), alpha))); gx = mul(kappa, fn('sec', th)); Rq = mul(sqrt(neg(beta)), fn('tan', th)); Qth = mul(neg(beta), P2(fn('tan', th), 2)); }
    else return null;
    // rewrite the integrand
    const rep = e => {
      if (e.t === 'pow' && e.b.k === Qx.k && e.e.t === 'num') {
        if (e.e.d === 2n) return pow(Rq, num(Number(e.e.n)));
        if (e.e.d === 1n) return pow(Qth, e.e);
      }
      if (e.k === Qx.k) return Qth;
      return e.t === 'num' || e.t === 'sym' || e.t === 'const' ? e : rebuildWith(e, rep);
    };
    const dg = CAS.diff(gx, 'theta');
    let F = simplify(mul(CAS.subst(rep(f), v, gx), dg));
    if (dependsOn(F, v)) return null;
    const nd = mkNode('Trigonometric substitution', f, v, {
      formula: kind === 'sin' ? '√(a² − u²):  u = a sin θ,  √(a² − u²) = a cos θ' : kind === 'tan' ? '√(a² + u²):  u = a tan θ,  √(a² + u²) = a sec θ' : '√(u² − a²):  u = a sec θ,  √(u² − a²) = a tan θ'
    });
    nd.lines.push('The integrand contains √(' + S(Qx) + '), which has the form ' + (kind === 'sin' ? '√(a² − u²)' : kind === 'tan' ? '√(a² + u²)' : '√(u² − a²)') + ' with a² = ' + S(kind === 'sec' ? neg(beta) : beta) + (CAS.isOne(alpha) || CAS.isOne(neg(alpha)) ? '' : ' and the coefficient ' + S(alpha) + ' of ' + v + '²') + '.');
    nd.lines.push('Let ' + v + ' = ' + S(gx) + '. Then d' + v + ' = ' + S(dg) + ' dθ and √(' + S(Qx) + ') = ' + S(Rq) + '.');
    nd.then = '= ' + intText(F, 'theta').replace(/theta/g, 'θ');
    const ch = limited(ctx, 1500, () => solveRec(F, 'theta', ctx));
    if (!ch) return null;
    nd.children.push(ch.node);
    // back-substitute with the right triangle
    const rq = sqrt(Qx);                      // √Q in x
    const sqb = sqrt(kind === 'sec' ? neg(beta) : beta), kap = kappa;
    let map, thx;
    if (kind === 'sin') { map = { sin: div(x, kap), cos: div(rq, sqb) }; thx = fn('asin', div(x, kap)); }
    else if (kind === 'tan') { map = { sin: mul(div(x, kap), div(sqb, rq)), cos: div(sqb, rq) }; thx = fn('atan', div(x, kap)); }
    else { map = { cos: div(kap, x), sin: div(rq, mul(alpha.t === 'num' ? sqrt(alpha) : ONE, x)) }; thx = fn('atan', div(rq, sqb)); }
    if (kind === 'sec') map.sin = simplify(mul(div(rq, sqrt(alpha)), pow(x, MINUS_ONE)));
    map.tan = simplify(div(map.sin, map.cos)); map.sec = simplify(pow(map.cos, MINUS_ONE)); map.csc = simplify(pow(map.sin, MINUS_ONE)); map.cot = simplify(pow(map.tan, MINUS_ONE));
    const sub1 = e => {
      if (e.t === 'fn' && map[e.name] && e.a.k === th.k) return map[e.name];
      if (e.k === th.k) return thx;
      return e.t === 'num' || e.t === 'sym' || e.t === 'const' ? e : rebuildWith(e, sub1);
    };
    const back = simplify(sub1(multipleAngle(ch.result, th)));
    nd.combine = 'Go back to ' + v + ' with a right triangle (' + (kind === 'sin' ? 'sin θ = ' + S(map.sin) : kind === 'tan' ? 'tan θ = ' + S(map.tan) : 'sec θ = ' + S(map.sec)) + '):  ' + intText(f, v) + ' = ' + S(back);
    return sol(back, nd, ch.ph);
  }

  RULES.push(ruleConstant, ruleTable, ruleStandardForms, ruleQuadReduction, ruleConstMultiple, ruleSum, ruleUSubDirect, ruleTrig, ruleRational, ruleCompleteSquare, ruleExpand, ruleUSubInvert, ruleTrigSub, ruleParts, ruleUSubInvertLate);

  /* present nicely: spread out the radicands and arguments, e.g. √((x + 1)² + 4) -> √(x² + 2x + 5) */
  function tidy(e) {
    if (e.t === 'num' || e.t === 'sym' || e.t === 'const') return e;
    if (e.t === 'pow') {
      const b = tidy(e.b);
      return pow(e.e.t === 'num' && !(e.e.d === 1n) && b.t === 'add' ? CAS.expand(b) : b, tidy(e.e));
    }
    if (e.t === 'fn') return fn(e.name, CAS.expand(tidy(e.a)));
    return rebuildWith(e, tidy);
  }

  /* ═════════════════════ numeric quadrature ═════════════════════ */

  const XGK = [0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926,
    0.741531185599394439863864773280788, 0.586087235467691130294144838258730, 0.405845151377397166906606412076961,
    0.207784955007898467600689403773245, 0.0];
  const WGK = [0.022935322010529224963732008058970, 0.063092092629978553290700663189204, 0.104790010322250183839876322541518,
    0.140653259715525918745189590510238, 0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
    0.204432940075298892414161999234649, 0.209482141084727828012999174891714];
  const WG = [0.129484966168869693270611432679082, 0.279705391489276667901467771423780, 0.381830050505118944950369775488975, 0.417959183673469387755102040816327];

  function gk15(f, a, b) {                  // one Gauss-Kronrod (7, 15) panel: value and an error estimate
    const c = 0.5 * (a + b), h = 0.5 * (b - a), fc = f(c);
    let resK = fc * WGK[7], resG = fc * WG[3], resAbs = Math.abs(resK);
    const fv = [];
    for (let j = 0; j < 7; j++) {
      const dx = h * XGK[j], f1 = f(c - dx), f2 = f(c + dx);
      fv.push(f1, f2);
      resK += WGK[j] * (f1 + f2);
      resAbs += WGK[j] * (Math.abs(f1) + Math.abs(f2));
      if (j % 2 === 1) resG += WG[(j - 1) / 2] * (f1 + f2);
    }
    const mean = resK * 0.5;
    let asc = WGK[7] * Math.abs(fc - mean);
    for (let j = 0; j < 7; j++) asc += WGK[j] * (Math.abs(fv[2 * j] - mean) + Math.abs(fv[2 * j + 1] - mean));
    resAbs *= Math.abs(h); asc *= Math.abs(h);
    let err = Math.abs((resK - resG) * h);
    if (asc !== 0 && err !== 0) err = asc * Math.min(1, Math.pow(200 * err / asc, 1.5));
    if (resAbs > 2.2e-308 / (50 * 2.2e-16)) err = Math.max(50 * 2.2e-16 * resAbs, err);
    return { val: resK * h, err };
  }
  function adaptiveGK(f, a, b, tol, maxPanels) {
    if (a === b) return { value: 0, error: 0, ok: true };
    let first = gk15(f, a, b);
    if (!isFinite(first.val)) return { value: NaN, error: Infinity, ok: false };
    let panels = [{ a, b, val: first.val, err: first.err }];
    let total = first.val, err = first.err;
    for (let n = 0; n < (maxPanels || 400); n++) {
      if (err <= Math.max(1e-13, tol * Math.abs(total))) return { value: total, error: err, ok: true };
      let worst = 0;
      for (let i = 1; i < panels.length; i++) if (panels[i].err > panels[worst].err) worst = i;
      const p = panels[worst], m = 0.5 * (p.a + p.b);
      const l = gk15(f, p.a, m), r = gk15(f, m, p.b);
      if (!isFinite(l.val) || !isFinite(r.val)) return { value: NaN, error: Infinity, ok: false };
      panels.splice(worst, 1, { a: p.a, b: m, val: l.val, err: l.err }, { a: m, b: p.b, val: r.val, err: r.err });
      total = 0; err = 0;
      for (const q of panels) { total += q.val; err += q.err; }
      if (Math.abs(p.b - p.a) < 1e-14 * (1 + Math.abs(p.a))) break;
    }
    return { value: total, error: err, ok: err <= 1e-6 * Math.max(1, Math.abs(total)) };
  }

  /* tanh-sinh on a finite interval; g(x, dl, dr) gets the point and its exact distances from the two ends */
  function tanhSinhCore(g, a, b, tol) {
    const h2 = 0.5 * (b - a), c = 0.5 * (a + b), T = 5.2;
    const term = t => {
      const u = 0.5 * Math.PI * Math.sinh(t), e2 = Math.exp(-2 * Math.abs(u));
      const d = 2 * h2 * e2 / (1 + e2);                 // distance of the point from the nearer end
      const w = h2 * 0.5 * Math.PI * Math.cosh(t) * 4 * e2 / ((1 + e2) * (1 + e2));
      let x, dl, dr;
      if (t < 0) { x = a + d; dl = d; dr = (b - a) - d; } else { x = b - d; dr = d; dl = (b - a) - d; }
      if (!(d > 0) || w === 0) return 0;
      const y = g(x, dl, dr);
      return isFinite(y) ? w * y : (y !== y ? NaN : 0);
    };
    let h = 1, S = 0;
    for (let k = -Math.floor(T / h); k <= Math.floor(T / h); k++) { const y = term(k * h); if (y !== y) return { value: NaN, error: Infinity, ok: false }; S += y; }
    let I = h * S, prev = I, err = Infinity;
    for (let level = 1; level <= 7; level++) {
      h /= 2;
      let odd = 0;
      for (let k = 1; k <= Math.floor(T / h); k += 2) { const y1 = term(k * h), y2 = term(-k * h); if (y1 !== y1 || y2 !== y2) return { value: NaN, error: Infinity, ok: false }; odd += y1 + y2; }
      S += odd;                                  // S is the plain sum of the terms at this spacing
      I = h * S;
      err = Math.abs(I - prev);
      prev = I;
      if (level >= 3 && err <= tol * Math.max(1, Math.abs(I))) return { value: I, error: err, ok: true };
    }
    return { value: I, error: err, ok: err <= 1e-6 * Math.max(1, Math.abs(I)) };
  }
  function tanhSinh(f, a, b, tol) { return tanhSinhCore(x => f(x), a, b, tol || 1e-12); }

  /* a and b may be infinite; f is a JS function of one number. Returns { value, error, ok, method } */
  function quad(f, a, b, opts) {
    opts = opts || {};
    const tol = opts.tol || 1e-11;
    if (a === b) return { value: 0, error: 0, ok: true, method: 'none' };
    if (a > b) { const r = quad(f, b, a, opts); return { value: -r.value, error: r.error, ok: r.ok, method: r.method }; }
    const fa = isFinite(a) ? f(a) : 0, fb = isFinite(b) ? f(b) : 0;
    const proper = isFinite(a) && isFinite(b) && isFinite(fa) && isFinite(fb) && !opts.singular;
    if (proper) {
      const r = adaptiveGK(f, a, b, tol);
      if (r.ok) return { value: r.value, error: r.error, ok: true, method: 'adaptive Gauss–Kronrod' };
      const t = tanhSinh(f, a, b);
      if (t.ok) return { value: t.value, error: t.error, ok: true, method: 'tanh-sinh' };
      return { value: r.value, error: r.error, ok: false, method: 'adaptive Gauss–Kronrod' };
    }
    if (isFinite(a) && isFinite(b)) { const r = tanhSinh(f, a, b); return { value: r.value, error: r.error, ok: r.ok, method: 'tanh-sinh' }; }
    // infinite ends: x = a + s/(1 - s) on (0, 1), split at a finite point for a doubly infinite range
    const half = (lo, sign) => tanhSinhCore((s, dl, dr) => f(lo + sign * dl / dr) / (dr * dr), 0, 1, 1e-12);
    if (isFinite(a) && b === Infinity) { const r = half(a, 1); return { value: r.value, error: r.error, ok: r.ok, method: 'tanh-sinh (infinite range)' }; }
    if (a === -Infinity && isFinite(b)) { const r = half(b, -1); return { value: r.value, error: r.error, ok: r.ok, method: 'tanh-sinh (infinite range)' }; }
    if (a === -Infinity && b === Infinity) {
      const l = half(0, -1), r = half(0, 1);
      return { value: l.value + r.value, error: l.error + r.error, ok: l.ok && r.ok, method: 'tanh-sinh (infinite range)' };
    }
    return { value: NaN, error: Infinity, ok: false, method: 'none' };
  }

  /* ═════════════════════ symbolic limits (simple cases) ═════════════════════ */

  const FIN = (v, side) => ({ kind: 'finite', value: v, side: side || 0 });
  const INF = s => ({ kind: 'inf', sign: s });
  const NONE = { kind: 'none' }, UNK = { kind: 'unknown' };
  const signOf = e => { const x = CAS.evalNum(e, {}); return isFinite(x) ? Math.sign(x) : 0; };

  function limInf(e, t, d) {                // limit as t -> +infinity
    if (d > 14) return UNK;
    if (!dependsOn(e, t)) return FIN(e, 0);
    switch (e.t) {
      case 'sym': return INF(1);
      case 'fn': return limFn(e, t, d);
      case 'add': return limAdd(e, t, d);
      case 'mul': return limMul(e, t, d);
      case 'pow': return limPow(e, t, d);
      default: return UNK;
    }
  }
  function limFn(e, t, d) {
    const a = limInf(e.a, t, d + 1);
    if (a.kind === 'unknown') return UNK;
    if (a.kind === 'none') return NONE;
    const name = e.name;
    if (a.kind === 'finite') {
      const c = a.value, sc = signOf(c);
      if (name === 'ln') {
        if (CAS.isZero(c)) return a.side > 0 ? INF(-1) : UNK;
        return sc > 0 ? FIN(ln(c), 0) : NONE;
      }
      if (['sin', 'cos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'abs', 'sign', 'acot'].indexOf(name) >= 0) {
        const v = fn(name, c);
        return FIN(v, CAS.isZero(v) ? (name === 'abs' || name === 'cosh' ? 1 : name === 'sin' || name === 'sinh' || name === 'tanh' || name === 'atan' || name === 'asinh' ? a.side : 0) : 0);
      }
      const x = CAS.evalNum(fn(name, c), {});
      return isFinite(x) ? FIN(fn(name, c), 0) : UNK;
    }
    const s = a.sign;
    switch (name) {
      case 'atan': return FIN(mul(num(s, 2), PI), 0);
      case 'acot': return FIN(s > 0 ? ZERO : PI, s > 0 ? 1 : 0);
      case 'tanh': case 'sign': case 'coth': return FIN(num(s), 0);
      case 'sinh': case 'asinh': return INF(s);
      case 'cosh': case 'abs': return INF(1);
      case 'sech': return FIN(ZERO, 1);
      case 'csch': return FIN(ZERO, s);
      case 'ln': return s > 0 ? INF(1) : NONE;
      case 'acosh': return s > 0 ? INF(1) : NONE;
      default: return NONE;                 // sin, cos, tan, ...: no limit
    }
  }
  function combineLogs(e) {                 // c ln|f| + (-c) ln|g| -> c ln|f/g|  (for limits only)
    if (e.t !== 'add') return e;
    const logs = [], rest = [];
    for (const tm of e.args) {
      let co = ONE, body = tm;
      if (tm.t === 'mul' && tm.args[0].t === 'num') { co = tm.args[0]; body = tm.args.length === 2 ? tm.args[1] : mul(...tm.args.slice(1)); }
      if (body.t === 'fn' && body.name === 'ln') logs.push({ co, arg: body.a.t === 'fn' && body.a.name === 'abs' ? body.a.a : body.a, abs: body.a.t === 'fn' && body.a.name === 'abs' });
      else rest.push(tm);
    }
    if (logs.length < 2) return e;
    const byCo = new Map();
    for (const l of logs) { const k = Q.qstr({ n: l.co.n, d: l.co.d }); (byCo.get(k) || byCo.set(k, []).get(k)).push(l); }
    // pair coefficient c with -c
    let acc = rest.slice(), used = new Set();
    for (const l of logs) {
      if (used.has(l)) continue;
      const mate = logs.find(m => !used.has(m) && m !== l && m.co.n === -l.co.n && m.co.d === l.co.d);
      if (mate) { used.add(l); used.add(mate); acc.push(mul(l.co, ln(fn('abs', div(l.arg, mate.arg))))); }
    }
    logs.forEach(l => { if (!used.has(l)) acc.push(mul(l.co, ln(l.abs ? fn('abs', l.arg) : l.arg))); });
    return add(...acc);
  }
  function limAdd(e, t, d) {
    const rs = e.args.map(a => limInf(a, t, d + 1));
    if (rs.some(r => r.kind === 'unknown')) return UNK;
    const infs = rs.filter(r => r.kind === 'inf'), nones = rs.filter(r => r.kind === 'none');
    if (infs.length) {
      if (infs.every(r => r.sign === infs[0].sign)) return INF(infs[0].sign);
      // inf - inf: try to combine logs, or a common denominator
      const c = combineLogs(e);
      if (c.k !== e.k) { const r = limInf(c, t, d + 1); if (r.kind !== 'unknown') return r; }
      const T = CAS.together(e);
      if (!CAS.isOne(T.d)) { const r = limInf(mul(T.n, pow(T.d, MINUS_ONE)), t, d + 1); if (r.kind !== 'unknown') return r; }
      const ex = CAS.expand(e);
      if (ex.k !== e.k) { const r = limInf(ex, t, d + 1); if (r.kind !== 'unknown') return r; }
      return UNK;
    }
    if (nones.length) return NONE;
    const sides = rs.map(r => r.side);
    const val = add(...rs.map(r => r.value));
    const sd = CAS.isZero(val) ? (sides.every(s => s === sides[0]) ? sides[0] : 0) : 0;
    return FIN(val, sd);
  }
  function limMul(e, t, d) {
    const rs = e.args.map(a => ({ a, r: limInf(a, t, d + 1) }));
    if (rs.some(x => x.r.kind === 'unknown')) return UNK;
    const zero = rs.filter(x => x.r.kind === 'finite' && CAS.isZero(x.r.value)), inf = rs.filter(x => x.r.kind === 'inf'),
      none = rs.filter(x => x.r.kind === 'none'), fin = rs.filter(x => x.r.kind === 'finite' && !CAS.isZero(x.r.value));
    if (none.length) return zero.length && !inf.length ? FIN(ZERO, 0) : NONE;
    const finProd = mul(...fin.map(x => x.r.value));
    if (zero.length && inf.length) {         // 0 · ∞: l'Hôpital on B / (1/A)
      const A = mul(...inf.map(x => x.a)), B = mul(...zero.map(x => x.a)), rest = mul(...fin.map(x => x.a));
      const tries = [[B, pow(A, MINUS_ONE)], [A, pow(B, MINUS_ONE)]];
      for (const [N, Dn] of tries) {
        let n = N, dd = Dn, res = UNK;
        for (let it = 0; it < 6; it++) {
          n = CAS.diff(n, t); dd = CAS.diff(dd, t);
          if (CAS.isZero(dd)) break;
          const ratio = simplify(div(n, dd));
          res = limInf(ratio, t, d + 3);
          if (res.kind !== 'unknown') break;
          const T = CAS.together(ratio);
          if (!CAS.isOne(T.d)) { n = T.n; dd = T.d; }
        }
        if (res.kind !== 'unknown') {
          if (res.kind === 'none') return NONE;
          if (!fin.length) return res;
          const fl = limInf(rest, t, d + 1);
          return mulLimits(res, fl);
        }
      }
      return UNK;
    }
    if (inf.length) {
      let s = inf.reduce((p, x) => p * x.r.sign, 1);
      for (const x of fin) { const sg = signOf(x.r.value); if (sg === 0) return UNK; s *= sg; }
      return INF(s);
    }
    if (zero.length) {
      let side = zero.reduce((p, x) => p * (x.r.side || 0), 1);
      for (const x of fin) side *= signOf(x.r.value);
      return FIN(ZERO, side);
    }
    return FIN(finProd, 0);
  }
  function mulLimits(a, b) {
    if (a.kind === 'finite' && b.kind === 'finite') return FIN(mul(a.value, b.value), 0);
    if (a.kind === 'inf' && b.kind === 'finite') { const sg = signOf(b.value); return sg === 0 ? UNK : INF(a.sign * sg); }
    if (b.kind === 'inf' && a.kind === 'finite') return mulLimits(b, a);
    return UNK;
  }
  function limPow(e, t, d) {
    const bd = dependsOn(e.b, t), ed = dependsOn(e.e, t);
    if (!ed && e.e.t === 'num') {
      const b = limInf(e.b, t, d + 1), n = e.e, nn = Number(n.n) / Number(n.d), oddInt = n.d === 1n && n.n % 2n !== 0n, evenInt = n.d === 1n && n.n % 2n === 0n;
      if (b.kind === 'unknown') return UNK;
      if (b.kind === 'none') return NONE;
      if (b.kind === 'finite') {
        const c = b.value;
        if (CAS.isZero(c)) {
          if (nn > 0) return FIN(ZERO, b.side > 0 || evenInt ? 1 : (oddInt ? b.side : 0));
          if (b.side > 0 || evenInt) return b.side === 0 && !evenInt ? UNK : INF(1);
          return b.side < 0 ? (oddInt ? INF(-1) : NONE) : UNK;
        }
        const sc = signOf(c);
        if (sc < 0 && n.d !== 1n && n.d % 2n === 0n) return NONE;
        return FIN(pow(c, n), 0);
      }
      const s = b.sign;
      if (nn > 0) return s < 0 && n.d !== 1n && n.d % 2n === 0n ? NONE : INF(s < 0 && oddInt ? -1 : 1);
      return FIN(ZERO, s < 0 && oddInt ? -1 : 1);
    }
    if (!bd) {                              // c^g(t)
      const g = limInf(e.e, t, d + 1);
      if (g.kind === 'unknown') return UNK;
      if (g.kind === 'none') return NONE;
      const cv = CAS.evalNum(e.b, {});
      if (!(cv > 0)) return UNK;
      if (g.kind === 'finite') return FIN(pow(e.b, g.value), 0);
      const grows = (cv > 1) === (g.sign > 0);
      if (cv === 1) return FIN(ONE, 0);
      return grows ? INF(1) : FIN(ZERO, 1);
    }
    // general: b^g = e^(g ln b)
    if (e.b.t === 'const' && e.b.name === 'e') {
      const g = limInf(e.e, t, d + 1);
      if (g.kind === 'inf') return g.sign > 0 ? INF(1) : FIN(ZERO, 1);
      if (g.kind === 'finite') return FIN(exp(g.value), 0);
      return g.kind === 'none' ? NONE : UNK;
    }
    return limInf(exp(mul(e.e, ln(e.b))), t, d + 1);
  }

  /* numeric look at a limit, to confirm (or replace) the symbolic answer */
  function limitSequence(F, v, point, side) {
    const g = CAS.compile(F, [v]);
    const seq = point === Infinity ? [1e2, 1e3, 1e4, 1e5, 1e6] : point === -Infinity ? [-1e2, -1e3, -1e4, -1e5, -1e6] : [1e-2, 1e-3, 1e-4, 1e-5, 1e-6].map(dx => point + side * dx);
    return seq.map(x => g(x));
  }
  function numericLimit(F, v, point, side) {
    const vals = limitSequence(F, v, point, side), n = vals.length;
    if (vals.some(y => y !== y)) return { kind: 'none' };
    const last = vals[n - 1], prev = vals[n - 2], prev2 = vals[n - 3];
    if (!isFinite(last)) return { kind: 'inf', sign: Math.sign(last) };
    const inc = Math.abs(last - prev), inc2 = Math.abs(prev - prev2);
    if (Math.abs(last) > 1e4 && Math.abs(last) > 2 * Math.abs(prev2)) return { kind: 'inf', sign: Math.sign(last) };
    if (inc <= 1e-3 * Math.max(1, Math.abs(last)) && inc2 <= 1e-2 * Math.max(1, Math.abs(prev))) return { kind: 'finite', value: last };
    const mono = vals.every((y, i) => i === 0 || (vals[1] > vals[0] ? y > vals[i - 1] : y < vals[i - 1]));
    if (mono && inc >= 0.5 * inc2 && Math.abs(last) > Math.abs(vals[0])) return { kind: 'inf', sign: Math.sign(last - vals[0]) };
    return { kind: 'none' };
  }
  function checkLimit(F, v, point, side, r) {   // does the numeric trend agree with a symbolic limit r?
    let vals;
    try { vals = limitSequence(F, v, point, side); } catch (e) { return false; }
    if (vals.some(y => y !== y)) return false;
    const last = vals[vals.length - 1];
    if (r.kind === 'inf') return Math.abs(last) > Math.abs(vals[0]) && Math.abs(last) > 3 && Math.sign(last) === r.sign;
    if (r.kind === 'finite') {
      const sv = CAS.evalNum(r.value, {});
      if (!isFinite(sv) || !isFinite(last)) return false;
      const e0 = Math.abs(vals[0] - sv), e1 = Math.abs(last - sv);
      return e1 <= 1e-6 * Math.max(1, Math.abs(sv)) || e1 < e0 * 0.9;
    }
    return false;
  }

  /* limit of expr as v -> point (Infinity, -Infinity, or an Expr) from side +1 (right) or -1 (left). */
  function limit(expr, v, point, side) {
    const e = toE(expr);
    let g;
    if (point === Infinity) g = e;
    else if (point === -Infinity) g = CAS.subst(e, v, neg(sy(v)));
    else { const p = toE(point); g = CAS.subst(e, v, add(p, mul(num(side >= 0 ? 1 : -1), pow(sy(v), MINUS_ONE)))); }
    let r;
    try { r = limInf(simplify(g), v, 0); } catch (err) { r = UNK; }
    return r;
  }

  /* ═════════════════════ singularities of an integrand on an interval ═════════════════════ */

  function dangerFunctions(f, v) {          // expressions whose zeros are suspect points (poles, log singularities)
    const out = new Map();
    const addD = e => { if (dependsOn(e, v) && !out.has(e.k)) out.set(e.k, e); };
    const walk = e => {
      switch (e.t) {
        case 'pow': if (e.e.t === 'num' && e.e.n < 0n) addD(e.b); walk(e.b); walk(e.e); break;
        case 'fn':
          if (e.name === 'tan' || e.name === 'sec') addD(fn('cos', e.a));
          else if (e.name === 'cot' || e.name === 'csc') addD(fn('sin', e.a));
          else if (e.name === 'coth' || e.name === 'csch') addD(fn('sinh', e.a));
          else if (e.name === 'ln') addD(e.a);
          else if (e.name === 'atanh') { addD(sub(ONE, e.a)); addD(add(ONE, e.a)); }
          walk(e.a); break;
        case 'add': case 'mul': e.args.forEach(walk); break;
        default:
      }
    };
    walk(f);
    return Array.from(out.values());
  }
  function findZeros(g, lo, hi, N) {        // sign changes (and exact zeros) of a JS function on [lo, hi], refined by bisection
    const xs = [], ys = [];
    for (let i = 0; i <= N; i++) { const x = lo + (hi - lo) * i / N; xs.push(x); ys.push(g(x)); }
    const out = [];
    for (let i = 0; i < N; i++) {
      const y0 = ys[i], y1 = ys[i + 1];
      if (y0 !== y0 || y1 !== y1) continue;
      if (y0 === 0) { out.push(xs[i]); continue; }
      if (y0 * y1 < 0) {
        let a = xs[i], b = xs[i + 1], fa = y0;
        for (let k = 0; k < 80; k++) { const m = 0.5 * (a + b), fm = g(m); if (fm === 0) { a = b = m; break; } if (fa * fm < 0) b = m; else { a = m; fa = fm; } }
        out.push(0.5 * (a + b));
      }
    }
    if (ys[N] === 0) out.push(xs[N]);
    return out;
  }
  /* Returns { points: [{x, side...}], undefinedSomewhere, singularAt: [x...] } for a finite interval [lo, hi]. */
  function analyse(f, v, lo, hi, params) {
    const vars = [v].concat(params ? Object.keys(params) : []);
    const g = CAS.compile(f, vars);
    const pv = params ? Object.keys(params).map(k => params[k]) : [];
    const fnum = x => g.apply(null, [x].concat(pv));
    // domain: sample the interior
    let undefinedSomewhere = false;
    const N = 400;
    for (let i = 1; i < N; i++) { const y = fnum(lo + (hi - lo) * i / N); if (y !== y) { undefinedSomewhere = true; break; } }
    // suspects from denominators, logs, tan, ...
    const sus = [];
    for (const D of dangerFunctions(f, v)) {
      let Dg; try { Dg = CAS.compile(D, vars); } catch (e) { continue; }
      for (const z of findZeros(x => Dg.apply(null, [x].concat(pv)), lo, hi, 800)) sus.push(z);
    }
    const singular = [];
    const span = hi - lo;
    for (const z of sus) {
      if (singular.some(s => Math.abs(s - z) < 1e-9 * Math.max(1, Math.abs(z)))) continue;
      let blows = false;
      for (const side of [-1, 1]) {
        const ys = [1e-3, 1e-5, 1e-7, 1e-9].map(dx => { const x = z + side * dx * Math.max(1, span); return (x >= lo && x <= hi) ? Math.abs(fnum(x)) : NaN; });
        if (ys.every(y => y === y) && ys[3] > 10 && ys[3] > 1.4 * ys[1] && ys[2] > ys[1] && ys[1] > ys[0]) blows = true;
      }
      if (blows) singular.push(z);
    }
    singular.sort((a, b) => a - b);
    return { undefinedSomewhere, singular, fnum };
  }

  /* ═════════════════════ steps: flatten the tree ═════════════════════ */

  function flatten(root) {
    const out = [];
    const walk = (nd, depth, id) => {
      out.push({
        id, depth, kind: 'rule', title: nd.title, formula: nd.formula, lines: nd.lines.slice(), integral: intText(nd.integral, nd.v),
        then: nd.then, result: S(nd.result), text: nd.title, leaf: nd.leaf, hasChildren: nd.children.length > 0
      });
      nd.children.forEach((c, i) => walk(c, depth + 1, id + '.' + (i + 1)));
      if (nd.combine) out.push({ id, depth, kind: 'combine', text: nd.combine, result: S(nd.result), title: '', formula: null, lines: [], integral: '', then: null });
    };
    walk(root, 0, '1');
    return out;
  }

  /* ═════════════════════ public: indefinite integral ═════════════════════ */

  function integrate(expr, v, opts) {
    v = v || 'x';
    const f = simplify(toE(expr));
    const ctx = makeContext(opts);
    let r = null, why = '';
    try { r = solveRec(f, v, ctx); } catch (e) { if (e.budget) why = 'The search for a method was stopped because it was taking too long.'; else throw e; }
    let ver = null;
    if (r && r.ph) r = null;
    if (r) {
      ver = verify(f, r.result, v);
      if (!ver.ok) { r = null; why = 'A candidate answer failed the check (its derivative did not match), so it is not shown.'; }
    }
    if (!r) return { ok: false, integrand: f, variable: v, antiderivative: null, tree: null, steps: [], verified: ver, message: 'No method found. ' + (why || 'None of the rules in this calculator (basic table, substitution, by parts, partial fractions, trigonometric methods, trigonometric substitution) gives an antiderivative of this function. That does not prove there is none in closed form.') };
    const A = CAS.simplify(tidy(r.result));
    return { ok: true, integrand: f, variable: v, antiderivative: A, factored: CAS.factorCommon(A), tree: r.node, steps: flatten(r.node), verified: ver, message: '' };
  }

  /* ═════════════════════ public: definite and improper integrals ═════════════════════ */

  function parseBound(t) {
    if (typeof t === 'number') return isFinite(t) ? num(t) : t;
    if (typeof t === 'object') return t;
    const s = String(t).trim();
    if (/^\+?(inf|infinity|∞|oo)$/i.test(s)) return Infinity;
    if (/^[-−](inf|infinity|∞|oo)$/i.test(s)) return -Infinity;
    return CAS.parse(s);
  }
  const boundNumber = b => (typeof b === 'number' ? b : (CAS.freeVars(b).length ? NaN : CAS.evalNum(b, {})));
  const boundText = b => (b === Infinity ? '∞' : b === -Infinity ? '−∞' : S(b));
  function snap(x) {                        // a nice exact form for a numeric breakpoint, or null
    for (let q = 1; q <= 60; q++) { const p = Math.round(x * q); if (Math.abs(x - p / q) < 1e-9) return num(p, q); }
    for (let q = 1; q <= 12; q++) { const p = Math.round(x * q / Math.PI); if (p !== 0 && Math.abs(x - p * Math.PI / q) < 1e-9) return mul(num(p, q), PI); }
    return null;
  }

  function definite(expr, v, lower, upper, opts) {
    v = v || 'x';
    opts = opts || {};
    const f = simplify(toE(expr));
    const A = parseBound(lower), B = parseBound(upper);
    const aN = boundNumber(A), bN = boundNumber(B);
    const res = {
      ok: false, kind: 'none', integrand: f, variable: v, lower: A, upper: B, antiderivative: null, steps: [], tree: null, evaluation: [], issues: [], warnings: [],
      exact: null, exactNumber: null, numeric: null, numericError: null, numericMethod: null, agree: null, improper: false, message: ''
    };
    const anti = integrate(f, v, opts);
    res.antiderivative = anti.antiderivative; res.steps = anti.steps; res.tree = anti.tree; res.factored = anti.factored;
    const F = anti.ok ? anti.antiderivative : null;
    const Ftxt = F ? S(F) : '';
    const at = p => simplify(CAS.subst(F, v, p));
    const params = CAS.freeVars(f).filter(n => n !== v);

    /* ----- symbolic bounds or parameters: substitute only ----- */
    if (!(isFinite(aN) || aN === -Infinity || aN === Infinity) || !(isFinite(bN) || bN === Infinity || bN === -Infinity) || params.length) {
      if (!F) { res.message = 'No method found: ' + anti.message; return res; }
      if (A === Infinity || A === -Infinity || B === Infinity || B === -Infinity) { res.message = 'Infinite limits together with other variables are not handled here.'; return res; }
      const val = CAS.simplify(sub(at(B), at(A)));
      res.exact = val; res.kind = 'exact'; res.ok = true;
      res.evaluation = ['F(' + v + ') = ' + Ftxt, 'F(' + S(B) + ') − F(' + S(A) + ') = ' + S(at(B)) + ' − (' + S(at(A)) + ') = ' + S(val)];
      res.warnings.push('The limits or the integrand contain other variables, so the result is symbolic. Singularities and the numerical cross-check were not examined.');
      return res;
    }
    if (aN === bN) { res.exact = ZERO; res.exactNumber = 0; res.numeric = 0; res.kind = 'exact'; res.ok = true; res.agree = true; res.evaluation = ['The limits are equal, so the integral is 0.']; return res; }

    /* ----- numeric bounds ----- */
    const flip = aN > bN, lo = flip ? bN : aN, hi = flip ? aN : bN;
    const loE = flip ? B : A, hiE = flip ? A : B;
    if (flip) res.warnings.push('The lower limit is above the upper limit, so the sign is reversed.');
    const scanLo = isFinite(lo) ? lo : (isFinite(hi) ? hi - 1000 : -1000), scanHi = isFinite(hi) ? hi : (isFinite(lo) ? lo + 1000 : 1000);
    let an;
    try { an = analyse(f, v, scanLo, scanHi, null); } catch (e) { an = { undefinedSomewhere: false, singular: [], fnum: CAS.compile(f, [v]) }; }
    const fnum = an.fnum;
    if (an.undefinedSomewhere) {
      res.kind = 'none'; res.message = 'The integrand is not a real number for part of the interval from ' + boundText(A) + ' to ' + boundText(B) + ' (for example a logarithm or square root of a negative number), so the integral is not defined there.';
      res.issues.push('integrand undefined on part of the interval');
      return res;
    }
    const tolEnd = 1e-9 * Math.max(1, Math.abs(scanHi - scanLo));
    const interior = an.singular.filter(x => x > scanLo + tolEnd && x < scanHi - tolEnd && x > lo && x < hi);
    const loSing = an.singular.some(x => isFinite(lo) && Math.abs(x - lo) <= tolEnd);
    const hiSing = an.singular.some(x => isFinite(hi) && Math.abs(x - hi) <= tolEnd);
    res.improper = !isFinite(lo) || !isFinite(hi) || loSing || hiSing || interior.length > 0;
    const pts = [lo].concat(interior, [hi]);
    const ptE = pts.map((p, i) => (i === 0 ? loE : i === pts.length - 1 ? hiE : snap(p)));
    const singAt = pts.map((p, i) => (i === 0 ? loSing : i === pts.length - 1 ? hiSing : true));
    if (interior.length) res.issues.push('The integrand is unbounded at x = ' + interior.map(x => (snap(x) ? S(snap(x)) : x.toPrecision(8))).join(', ') + ' inside the interval; the integral is improper there.');
    if (loSing) res.issues.push('The integrand is unbounded at the lower limit.');
    if (hiSing) res.issues.push('The integrand is unbounded at the upper limit.');
    if (!isFinite(lo) || !isFinite(hi)) res.issues.push('One or both limits are infinite.');

    /* numeric value (always) */
    let numTotal = 0, numErr = 0, numOk = true, method = '';
    for (let i = 0; i + 1 < pts.length; i++) {
      const q = quad(fnum, pts[i], pts[i + 1], { singular: singAt[i] || singAt[i + 1] });
      numTotal += q.value; numErr += q.error; numOk = numOk && q.ok; method = q.method;
    }
    if (flip) numTotal = -numTotal;
    res.numeric = numTotal; res.numericError = numErr; res.numericMethod = method; res.numericOk = numOk;

    /* exact value from the antiderivative */
    if (!F) {
      res.ok = numOk && isFinite(numTotal);
      res.kind = res.ok ? 'numeric' : 'none';
      res.message = res.ok
        ? 'No closed form was found by these methods, so only a numeric value is given (adaptive quadrature, estimated error ' + numErr.toExponential(1) + ').' + (res.improper ? ' This integral is improper; convergence was judged numerically only.' : '')
        : 'No closed form was found by these methods, and the numerical integration did not converge, so the integral may diverge.';
      if (res.ok && res.improper) res.warnings.push('Convergence of this improper integral could only be judged numerically.');
      return res;
    }
    let total = ZERO, diverges = null, numericLimits = false;
    const lines = ['F(' + v + ') = ' + Ftxt];
    const endVal = (i, isUpper) => {
      const p = pts[i], pe = ptE[i], side = isUpper ? -1 : 1;
      const label = boundText(pe || p);
      if (!isFinite(p)) {
        const r = limit(F, v, p, 0);
        return { r, label: 'lim F(' + v + ') as ' + v + ' → ' + boundText(p), numeric: () => numericLimit(F, v, p, 0), check: rr => checkLimit(F, v, p, 0, rr) };
      }
      let direct = null;
      if (!singAt[i] && pe) { direct = at(pe); const x = CAS.evalNum(direct, {}); if (!isFinite(x) || !isFinite(fnum(p))) direct = null; }
      if (direct) return { r: FIN(direct), label: 'F(' + label + ')', numeric: null, check: null };
      if (!pe) return { r: UNK, label, numeric: () => numericLimit(F, v, p, side), check: null };
      return { r: limit(F, v, pe, side), label: 'lim F(' + v + ') as ' + v + ' → ' + label + (side > 0 ? '⁺' : '⁻'), numeric: () => numericLimit(F, v, p, side), check: rr => checkLimit(F, v, p, side, rr) };
    };
    const vals = [];
    for (let i = 0; i + 1 < pts.length && !diverges; i++) {
      const lowEnd = endVal(i, false), upEnd = endVal(i + 1, true);
      const got = [lowEnd, upEnd].map(e => {
        let r = e.r;
        if ((r.kind === 'finite' || r.kind === 'inf') && e.check && !e.check(r)) r = UNK;
        if (r.kind === 'unknown' || r.kind === 'none') {
          if (e.numeric) {
            const nl = e.numeric();
            if (nl.kind === 'finite') { numericLimits = true; return { label: e.label, kind: 'finite', value: num(nl.value), numericOnly: nl.value }; }
            if (nl.kind === 'inf') return { label: e.label, kind: 'inf', sign: nl.sign };
            if (e.r.kind === 'none' && nl.kind === 'none') return { label: e.label, kind: 'osc' };
          }
        }
        return Object.assign({ label: e.label }, r);
      });
      const [lw, up] = got;
      for (const g of got) if (g.kind === 'inf' || g.kind === 'osc') diverges = g;
      if (diverges) { vals.push(null); break; }
      if (lw.kind !== 'finite' || up.kind !== 'finite') { numericLimits = true; vals.push(null); continue; }
      lines.push(up.label + ' = ' + S(up.value) + ',   ' + lw.label + ' = ' + S(lw.value));
      vals.push(sub(up.value, lw.value));
    }
    if (diverges) {
      res.kind = 'diverges'; res.ok = true;
      res.message = diverges.kind === 'osc'
        ? 'The integral does not converge: ' + diverges.label + ' does not settle on a value (the antiderivative keeps oscillating), so there is no finite value.'
        : 'The integral diverges: ' + diverges.label + ' is ' + (diverges.sign > 0 ? '+∞' : '−∞') + ', so there is no finite value.';
      res.evaluation = lines;
      return res;
    }
    if (vals.some(x => x === null)) {
      res.evaluation = lines;
      res.kind = numOk && isFinite(numTotal) ? 'numeric' : 'none'; res.ok = res.kind === 'numeric';
      res.message = 'The antiderivative was found but its limits could not be worked out exactly here. ' + (res.ok ? 'The numeric value is shown (adaptive quadrature).' : '');
      return res;
    }
    total = CAS.simplify(add(...vals));
    if (flip) total = CAS.simplify(neg(total));
    const exNum = CAS.evalNum(total, {});
    res.exact = total; res.exactNumber = exNum;
    lines.push('∫ from ' + boundText(A) + ' to ' + boundText(B) + ' = ' + S(total));
    res.evaluation = lines;
    const tolAgree = 1e-6 * Math.max(1, Math.abs(exNum)) + 3 * numErr;
    res.agree = isFinite(exNum) && isFinite(numTotal) && Math.abs(exNum - numTotal) <= tolAgree;
    if (res.agree) { res.kind = 'exact'; res.ok = true; }
    else if (numOk && isFinite(numTotal)) {
      res.kind = 'numeric'; res.ok = true; res.exact = null;
      res.issues.push('The antiderivative gives ' + exNum + ' but numerical integration gives ' + numTotal + '.');
      res.message = 'The exact value from the antiderivative and the numerical value disagree, which means the antiderivative formula is not valid across the whole interval. Only the numerical value is shown.';
    } else {
      res.kind = 'exact'; res.ok = isFinite(exNum);
      res.warnings.push('The numerical cross-check did not converge, so this value rests on the antiderivative alone.');
    }
    if (numericLimits && res.kind === 'exact') { res.warnings.push('Some limits were found numerically, not symbolically, so the exact form is a decimal.'); }
    return res;
  }

  const api = { integrate, definite, quad, limit, parseBound, verify, flatten, size, splitContent, _solveRec: solveRec, _ctx: makeContext, RULES, mkNode, sol, leafish, leafLine, intText, solveRec, freshVar, replaceS, invertSub, ratioConst };
  /*__PUBLIC__*/
  return api;
});
