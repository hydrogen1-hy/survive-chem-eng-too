/*
 * A small computer-algebra core for the calculus pages: parse, simplify, differentiate, evaluate, print.
 * Plain deterministic code: no AI, no network, no dependencies, no DOM. Works in the browser (window.CAS) and in Node.
 *
 * EXPRESSIONS are immutable plain objects. Every node has t (its type) and k (a canonical key string:
 * two expressions are structurally identical exactly when their k are equal).
 *     { t:'num',   n, d }          exact fraction n/d, n and d are BigInt, d > 0, lowest terms
 *     { t:'sym',   name }          a variable: x, y, z, t, r, theta, u, ...
 *     { t:'const', name }          'pi' or 'e'
 *     { t:'add',   args }          sum of 2 or more terms, collected and sorted
 *     { t:'mul',   args }          product of 2 or more factors, numeric coefficient first
 *     { t:'pow',   b, e }          b to the power e. A square root is pow(x, 1/2); e^x is pow(const e, x)
 *     { t:'fn',    name, a }       sin cos tan cot sec csc asin acos atan acot sinh cosh tanh coth sech csch
 *                                  asinh acosh atanh ln abs sign
 *   Subtraction is adding (-1)*b and division is multiplying by b^-1. All the constructors below keep this canonical
 *   form (like terms collected, constants folded, equal bases merged), so a result is already "simplified".
 *   Square roots of integers are kept in lowest radical form: sqrt(12) is 2*sqrt(3), 1/sqrt(3) is sqrt(3)/3.
 *   Powers with a fractional exponent use the real root, so (-8)^(1/3) is -2 when evaluated.
 *
 * API (all functions are pure)
 *   Building:    CAS.parse(text) -> Expr (throws CAS.ParseError with .message, .pos, .end)    CAS.tryParse(text) -> {ok, expr | error}
 *                CAS.parseWithNotes(text) -> {expr, notes[]}   plain-language hints about how the text was read
 *                CAS.num(n, d), CAS.sym(name), CAS.add(a,b,...), CAS.mul(a,b,...), CAS.pow(b,e), CAS.neg(a), CAS.sub(a,b),
 *                CAS.div(a,b), CAS.fn(name, a), CAS.sqrt(a), CAS.exp(a), CAS.ln(a), CAS.PI, CAS.E, CAS.ZERO, CAS.ONE
 *   Printing:    CAS.toString(expr, {ascii:true})  readable text, e.g. x²·sin(x), √(x² + 1), 1/(x + 1); ascii:true gives
 *                text that CAS.parse reads back without any special symbols (x^2*sin(x), sqrt(x^2+1))
 *   Algebra:     CAS.simplify(e) canonical form plus Pythagorean identities (sin² + cos² = 1, sec² − tan² = 1, ...);
 *                CAS.canon(e) canonical form only;  CAS.expand(e);  CAS.together(e) -> {n, d};  CAS.factorCommon(e)
 *   Calculus:    CAS.diff(e, v)            derivative with respect to the variable named v (so partial derivatives too)
 *                CAS.diffSteps(e, v)       -> {result, steps[]}; each step {depth, rule, expr, text, formula, result}
 *   Numbers:     CAS.evalNum(e, {x:1.5}) -> number (NaN where undefined);   CAS.compile(e, ['x','y']) -> function(x, y)
 *   Substitute:  CAS.subst(e, 'x', replacementExpr) or CAS.subst(e, {x: a, y: b});  CAS.replace(e, target, replacement)
 *   Inspect:     CAS.freeVars(e) -> sorted names;  CAS.dependsOn(e, v);  CAS.isNum / isZero / isOne / isInteger
 *   Equality:    CAS.equal(a, b) true if they simplify to the same thing OR agree at many random points;
 *                CAS.equalSymbolic(a, b) the first part only;  CAS.sampleCompare(f, g, vars, opts) for compiled functions
 *   Polynomials: CAS.polyCoeffs(e, v) -> [c0, c1, ...] Exprs (low to high) or null if e is not a polynomial in v
 *                CAS.polyFromCoeffs(cs, v), CAS.polyDivide(num, den, v) -> {q, r} or null,
 *                CAS.polyGcd(a, b, v), CAS.factorPoly(e, v) -> {content, factors:[{poly, mult}]} over the rationals,
 *                CAS.partialFractions(num, den, v) -> {poly, terms:[{factor, power, num}], ...} or null
 *   Rationals:   CAS.Q is the exact fraction toolkit (BigInt based) used inside.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CAS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ═════════════════════ exact fractions (BigInt) ═════════════════════ */

  const babs = a => (a < 0n ? -a : a);
  function bgcd(a, b) { a = babs(a); b = babs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
  function mkq(n, d) {
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) { n = -n; d = -d; }
    const g = bgcd(n, d);
    return g > 1n ? { n: n / g, d: d / g } : { n, d };
  }
  const ONEQ = { n: 1n, d: 1n }, ZEROQ = { n: 0n, d: 1n };
  const qadd = (a, b) => mkq(a.n * b.d + b.n * a.d, a.d * b.d);
  const qsub = (a, b) => mkq(a.n * b.d - b.n * a.d, a.d * b.d);
  const qmul = (a, b) => mkq(a.n * b.n, a.d * b.d);
  const qdiv = (a, b) => mkq(a.n * b.d, a.d * b.n);
  const qneg = a => ({ n: -a.n, d: a.d });
  const qinv = a => mkq(a.d, a.n);
  const qsign = a => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0);
  const qcmp = (a, b) => { const l = a.n * b.d, r = b.n * a.d; return l < r ? -1 : l > r ? 1 : 0; };
  const qeq = (a, b) => a.n === b.n && a.d === b.d;
  const qIsInt = a => a.d === 1n;
  const qInt = n => ({ n: BigInt(n), d: 1n });
  function qpow(a, k) {                     // k: JS integer
    if (k < 0) return qpow(qinv(a), -k);
    let r = ONEQ, b = a;
    while (k > 0) { if (k & 1) r = qmul(r, b); b = qmul(b, b); k = Math.floor(k / 2); }
    return r;
  }
  function qnum(a) {
    const x = Number(a.n), y = Number(a.d);
    if (isFinite(x) && isFinite(y)) return x / y;
    const sh = BigInt(Math.max(a.n.toString(2).length, a.d.toString(2).length) - 900);
    return Number(a.n >> sh) / Number(a.d >> sh);
  }
  function qstr(a) { return a.d === 1n ? String(a.n) : a.n + '/' + a.d; }
  function parseDecimal(s) {                // '12.5e-3' -> exact fraction
    const m = /^([+-]?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m || (m[2] === '' && m[3] === '')) throw new Error('bad number ' + s);
    let n = BigInt((m[2] || '0') + (m[3] || '')), d = 10n ** BigInt((m[3] || '').length);
    const ex = m[4] ? parseInt(m[4], 10) : 0;
    if (Math.abs(ex) > 400) throw new Error('number too large');
    if (ex >= 0) n *= 10n ** BigInt(ex); else d *= 10n ** BigInt(-ex);
    if (m[1] === '-') n = -n;
    return mkq(n, d);
  }
  function fromNumber(x) {
    if (typeof x === 'bigint') return { n: x, d: 1n };
    if (!isFinite(x)) throw new Error('not a finite number');
    if (Number.isInteger(x)) return { n: BigInt(x), d: 1n };
    return parseDecimal(String(x));
  }
  function iroot(n, k) {                    // floor of the k-th root of a non-negative BigInt
    if (n < 2n) return n;
    const bk = BigInt(k);
    let lo = 1n, hi = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
    while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid ** bk <= n) lo = mid; else hi = mid - 1n; }
    return lo;
  }
  function extractRoot(m, k) {              // m = c^k * r with r as small as we can make it (c, r BigInt)
    if (m <= 9007199254740991n) {
      let x = Number(m), c = 1, rest = 1;
      for (let p = 2; p <= 200000 && Math.pow(p, k) <= x; p++) {
        let cnt = 0;
        while (x % p === 0) { x /= p; cnt++; }
        if (cnt) { c *= Math.pow(p, Math.floor(cnt / k)); rest *= Math.pow(p, cnt % k); }
      }
      rest *= x;                            // what is left has no prime factor that could repeat k times
      return { c: BigInt(c), r: BigInt(rest) };
    }
    const r = iroot(m, k);
    return r ** BigInt(k) === m ? { c: r, r: 1n } : { c: 1n, r: m };
  }

  /* ═════════════════════ expression nodes ═════════════════════ */

  const numCache = new Map();
  function NUM(v) {
    const k = '#' + v.n + (v.d === 1n ? '' : '/' + v.d);
    let r = numCache.get(k);
    if (!r) { r = { t: 'num', n: v.n, d: v.d, k }; if (numCache.size < 5000) numCache.set(k, r); }
    return r;
  }
  const SYM = name => ({ t: 'sym', name, k: name });
  const PI = { t: 'const', name: 'pi', k: '@pi' }, E = { t: 'const', name: 'e', k: '@e' };
  const mkAdd = args => ({ t: 'add', args, k: '+(' + args.map(a => a.k).join(',') + ')' });
  const mkMul = args => ({ t: 'mul', args, k: '*(' + args.map(a => a.k).join(',') + ')' });
  const mkPow = (b, e) => ({ t: 'pow', b, e, k: '^(' + b.k + ',' + e.k + ')' });
  const mkFn = (name, a) => ({ t: 'fn', name, a, k: name + '(' + a.k + ')' });

  const ZERO = NUM(ZEROQ), ONE = NUM(ONEQ), MINUS_ONE = NUM(qInt(-1)), TWO = NUM(qInt(2)), HALF = NUM(mkq(1n, 2n));
  const isNum = e => e.t === 'num';
  const isZero = e => e.t === 'num' && e.n === 0n;
  const isOne = e => e.t === 'num' && e.n === 1n && e.d === 1n;
  const isInteger = e => e.t === 'num' && e.d === 1n;
  const isNegNum = e => e.t === 'num' && e.n < 0n;

  const KNOWN_FN = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'asin', 'acos', 'atan', 'acot', 'sinh', 'cosh', 'tanh', 'coth',
    'sech', 'csch', 'asinh', 'acosh', 'atanh', 'ln', 'abs', 'sign'];

  /* ═════════════════════ canonical constructors ═════════════════════ */

  function degOf(e) {
    switch (e.t) {
      case 'sym': return 1;
      case 'pow': return (e.e.t === 'num' && e.b.t !== 'num') ? qnum(e.e) * degOf(e.b) : 0;
      case 'mul': { let s = 0; for (const a of e.args) s += degOf(a); return s; }
      case 'add': { let m = -Infinity; for (const a of e.args) m = Math.max(m, degOf(a)); return m; }
      default: return 0;
    }
  }
  function monoOf(t) {                      // {variable name: numeric power} of the variable powers in a term
    const m = {};
    for (const f of (t.t === 'mul' ? t.args : [t])) {
      if (f.t === 'sym') m[f.name] = (m[f.name] || 0) + 1;
      else if (f.t === 'pow' && f.b.t === 'sym' && f.e.t === 'num') m[f.b.name] = (m[f.b.name] || 0) + qnum(f.e);
    }
    return m;
  }
  function cmpMono(a, b) {                  // x² before xy before y²: variables alphabetically, higher power first
    const names = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
    for (const n of names) { const d = (b[n] || 0) - (a[n] || 0); if (d) return d; }
    return 0;
  }
  function rankOf(f) {
    switch (f.t) {
      case 'const': return 1;
      case 'sym': return 2;
      case 'fn': return 4;
      case 'add': return 6;
      case 'pow': {
        const b = f.b;
        if (b.t === 'sym') return 2;
        if (b.t === 'num') return f.e.t === 'num' ? 1 : 3;
        if (b.t === 'const') return f.e.t === 'num' ? 1 : 3;
        if (b.t === 'fn') return 4;
        return b.t === 'add' ? 6 : 5;
      }
      default: return 5;
    }
  }
  function sortKeyOf(f) {
    if (f.t === 'pow') return sortKeyOf(f.b) + '^' + f.e.k;
    return f.t === 'sym' ? f.name : f.k;
  }
  function cmpFactor(a, b) {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    const ka = sortKeyOf(a), kb = sortKeyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  function add(...args) { return addArr(args); }
  function addArr(args) {
    let c = ZEROQ;
    const map = new Map(), order = [];
    const visit = a => {
      if (a.t === 'num') c = qadd(c, a);
      else if (a.t === 'add') a.args.forEach(visit);
      else {
        let co = ONEQ, rest = a;
        if (a.t === 'mul' && a.args[0].t === 'num') { co = a.args[0]; rest = a.args.length === 2 ? a.args[1] : mkMul(a.args.slice(1)); }
        const ent = map.get(rest.k);
        if (ent) ent.c = qadd(ent.c, co); else { map.set(rest.k, { c: co, rest }); order.push(rest.k); }
      }
    };
    args.forEach(visit);
    const terms = [];
    for (const k of order) {
      const { c: co, rest } = map.get(k);
      if (co.n === 0n) continue;
      if (co.n === 1n && co.d === 1n) terms.push(rest);
      else terms.push(mkMul(rest.t === 'mul' ? [NUM(co)].concat(rest.args) : [NUM(co), rest]));
    }
    if (terms.some(t => t.t === 'add')) return addArr(terms.concat(c.n === 0n ? [] : [NUM(c)]));
    const dec = terms.map(t => ({ t, d: degOf(t), m: monoOf(t) }));
    dec.sort((a, b) => (b.d - a.d) || cmpMono(a.m, b.m) || (a.t.k < b.t.k ? -1 : a.t.k > b.t.k ? 1 : 0));
    const out = dec.map(x => x.t);
    if (c.n !== 0n) out.push(NUM(c));
    if (out.length === 0) return ZERO;
    return out.length === 1 ? out[0] : mkAdd(out);
  }

  function mul(...args) { return mulArr(args, 0); }
  function mulArr(args, depth) {
    let c = ONEQ;
    const groups = new Map(), order = [];
    const visit = a => {
      if (a.t === 'num') c = qmul(c, a);
      else if (a.t === 'mul') a.args.forEach(visit);
      else {
        const b = a.t === 'pow' ? a.b : a, ex = a.t === 'pow' ? a.e : ONE;
        let g = groups.get(b.k);
        if (!g) { g = { b, es: [], orig: a }; groups.set(b.k, g); order.push(b.k); }
        g.es.push(ex);
      }
    };
    args.forEach(visit);
    if (c.n === 0n) return ZERO;
    let facs = [], again = false;
    for (const k of order) {
      const g = groups.get(k);
      let p;
      if (g.es.length === 1) p = g.orig;
      else { p = pow(g.b, addArr(g.es)); again = true; }
      if (p.t === 'num') { c = qmul(c, p); again = true; }
      else if (p.t === 'mul') { facs = facs.concat(p.args); again = true; }
      else facs.push(p);
    }
    if (again && depth < 6) return mulArr(facs.concat([NUM(c)]), depth + 1);
    if (c.n === 0n) return ZERO;
    facs.sort(cmpFactor);
    if (facs.length === 0) return NUM(c);
    if (c.n === 1n && c.d === 1n) return facs.length === 1 ? facs[0] : mkMul(facs);
    // a number times a lone sum is spread over it: 2(x + 1) is 2x + 2 (this is what makes equal sums look identical)
    if (facs.length === 1 && facs[0].t === 'add') { const k = NUM(c); return addArr(facs[0].args.map(t => mulArr([k, t], 0))); }
    return mkMul([NUM(c)].concat(facs));
  }

  const neg = a => mulArr([MINUS_ONE, a], 0);
  const sub = (a, b) => addArr([a, neg(b)]);
  const div = (a, b) => mulArr([a, pow(b, MINUS_ONE)], 0);

  function isPositive(e) {                  // known to be > 0 for every value of the variables
    switch (e.t) {
      case 'num': return e.n > 0n;
      case 'const': return true;
      case 'pow': return isPositive(e.b);
      case 'mul': return e.args.every(isPositive);
      case 'add': return e.args.every(isPositive);
      case 'fn': return e.name === 'cosh' || e.name === 'sech';
      default: return false;
    }
  }

  function numPow(b, e) {                   // b, e both numbers. Returns an Expr or null (leave unevaluated)
    if (b.n === 0n) return qsign(e) > 0 ? ZERO : null;
    if (e.d === 1n) {
      const k = Number(e.n);
      if (!Number.isSafeInteger(k)) return null;
      const bits = (babs(b.n) > babs(b.d) ? babs(b.n) : babs(b.d)).toString(2).length;
      if (Math.abs(k) * bits > 20000) return null;
      return NUM(qpow(b, k));
    }
    // rational, non-integer exponent p/k
    const p = Number(e.n), k = Number(e.d);
    if (!Number.isSafeInteger(p) || k > 12) return null;
    let sign = 1n, base = b;
    if (b.n < 0n) {
      if (k % 2 === 0) return null;         // even root of a negative number: not real
      base = qneg(b); if (p % 2 !== 0) sign = -1n;
    }
    const bits = (babs(base.n) > base.d ? babs(base.n) : base.d).toString(2).length;
    if (Math.abs(p) * bits > 4000) return null;
    const s = qpow(base, p);                // exact: s = A/B
    const A = s.n, B = s.d;
    const m = A * (B ** BigInt(k - 1));     // s^(1/k) = (A * B^(k-1))^(1/k) / B
    const { c, r } = extractRoot(m, k);
    const coef = mkq(sign * c, B);
    if (r === 1n) return NUM(coef);
    return mulArr([NUM(coef), mkPow(NUM(qInt(r)), NUM(mkq(1n, BigInt(k))))], 0);
  }

  function pow(b, e) {
    if (e.t === 'num') {
      if (e.n === 0n) return ONE;
      if (e.n === 1n && e.d === 1n) return b;
      if (b.t === 'num') { const r = numPow(b, e); if (r) return r; }
      else if (b.t === 'pow') {
        const e2 = b.e;
        if (e.d === 1n) return pow(b.b, mulArr([e2, e], 0));
        if (e2.t === 'num') {
          if (e2.d !== 1n) return pow(b.b, mulArr([e2, e], 0));            // (b^(1/2))^(1/3): b is already non-negative
          if (e.d % 2n === 1n) return pow(b.b, mulArr([e2, e], 0));           // real roots: (x^3)^(1/3) = x
          if (e2.n % 2n === 0n) return pow(fn('abs', b.b), mulArr([e2, e], 0));
        } else if (isPositive(b.b)) return pow(b.b, mulArr([e2, e], 0));
      } else if (b.t === 'mul') {
        if (e.d === 1n) return mulArr(b.args.map(f => pow(f, e)), 0);
        const f0 = b.args[0];
        if (f0.t === 'num' && f0.n > 0n) {
          const rest = b.args.length === 2 ? b.args[1] : mkMul(b.args.slice(1));
          return mulArr([pow(f0, e), pow(rest, e)], 0);
        }
      } else if (b.t === 'fn' && b.name === 'abs' && e.d === 1n && e.n % 2n === 0n) return pow(b.a, e);
      else if (b.t === 'add') {
        // a sum with a common numeric factor: (2x + 2)^-1 is (x + 1)^-1 / 2, so equal things are written one way
        let gn = 0n, ld = 1n;
        for (const t of b.args) { const c0 = t.t === 'num' ? t : (t.t === 'mul' && t.args[0].t === 'num' ? t.args[0] : ONE); gn = bgcd(gn, c0.n); ld = ld / bgcd(ld, c0.d) * c0.d; }
        if (gn !== 0n && !(gn === 1n && ld === 1n)) {
          const ct = mkq(gn, ld), inv = NUM(qinv(ct));
          return mulArr([pow(NUM(ct), e), pow(addArr(b.args.map(t => mulArr([inv, t], 0))), e)], 0);
        }
      }
    } else if (b.t === 'const' && b.name === 'e') {
      if (e.t === 'fn' && e.name === 'ln') return e.a;
      if (e.t === 'mul' && e.args.length === 2 && e.args[0].t === 'num' && e.args[1].t === 'fn' && e.args[1].name === 'ln') return pow(e.args[1].a, e.args[0]);
    }
    if (b.t === 'num' && b.n === 1n && b.d === 1n) return ONE;
    return mkPow(b, e);
  }

  /* exact trig values at multiples of pi/12 that are rational combinations of 1, sqrt2, sqrt3 */
  function sinRef(k) {                      // sin(k*15 degrees), k in {0,2,3,4,6}
    switch (k) {
      case 0: return ZERO;
      case 2: return HALF;
      case 3: return mulArr([HALF, mkPow(TWO, HALF)], 0);
      case 4: return mulArr([HALF, mkPow(NUM(qInt(3)), HALF)], 0);
      case 6: return ONE;
      default: return null;
    }
  }
  function sinTwelfths(k) {                 // k integer mod 24
    k = ((k % 24) + 24) % 24;
    let s = 1, r;
    if (k <= 6) r = k; else if (k <= 12) r = 12 - k; else if (k <= 18) { r = k - 12; s = -1; } else { r = 24 - k; s = -1; }
    const v = sinRef(r);
    return v === null ? null : (s < 0 ? neg(v) : v);
  }
  function piTwelfths(a) {                  // a = m*pi with 12*m an integer -> that integer, else null
    let m = null;
    if (a.t === 'const' && a.name === 'pi') m = ONEQ;
    else if (a.t === 'mul' && a.args.length === 2 && a.args[0].t === 'num' && a.args[1].t === 'const' && a.args[1].name === 'pi') m = a.args[0];
    if (m === null) return null;
    const t = qmul(m, qInt(12));
    return qIsInt(t) ? Number(t.n % 24n) : null;
  }
  let INV_TABLES = null;
  function invTables() {                    // key of an exact value -> angle in twelfths of pi
    if (INV_TABLES) return INV_TABLES;
    const asin = new Map(), atan = new Map();
    for (let k = -6; k <= 6; k++) {
      const s = sinTwelfths(k);
      if (s !== null) asin.set(s.k, k);
      const c = sinTwelfths(k + 6);
      if (s !== null && c !== null && !isZero(c)) atan.set(div(s, c).k, k);
    }
    INV_TABLES = { asin, atan };
    return INV_TABLES;
  }
  const twelfthsToExpr = k => mulArr([NUM(mkq(BigInt(k), 12n)), PI], 0);

  function negLead(a) {                     // -a is "simpler" than a (negative number or negative leading coefficient)
    if (a.t === 'num') return a.n < 0n;
    return a.t === 'mul' && a.args[0].t === 'num' && a.args[0].n < 0n;
  }

  function fn(name, a) {
    if (KNOWN_FN.indexOf(name) < 0) throw new Error('unknown function ' + name);
    const odd = { sin: 1, tan: 1, cot: 1, csc: 1, asin: 1, atan: 1, acot: 1, sinh: 1, tanh: 1, coth: 1, csch: 1, asinh: 1, atanh: 1, sign: 1 };
    const even = { cos: 1, sec: 1, cosh: 1, sech: 1, abs: 1 };
    if (a.t === 'num') {
      const z = isZero(a), one = isOne(a);
      switch (name) {
        case 'sin': case 'tan': case 'asin': case 'atan': case 'sinh': case 'tanh': case 'asinh': case 'atanh': if (z) return ZERO; break;
        case 'cos': case 'cosh': case 'sec': case 'sech': if (z) return ONE; break;
        case 'ln': if (one) return ZERO; break;
        case 'acos': if (one) return ZERO; break;
        case 'abs': return a.n < 0n ? NUM(qneg(a)) : a;
        case 'sign': return NUM(qInt(qsign(a)));
      }
    }
    if (odd[name] && negLead(a)) return neg(fn(name, neg(a)));
    if (even[name] && negLead(a)) return fn(name, neg(a));
    if (name === 'ln') {
      if (a.t === 'num' && a.n > 0n && !(a.n === 1n && a.d === 1n)) {          // ln(4) = 2 ln 2, ln(2/3) = ln 2 - ln 3
        if (a.d !== 1n) return addArr([fn('ln', NUM({ n: a.n, d: 1n })), neg(fn('ln', NUM({ n: a.d, d: 1n })))]);
        for (let k = Math.min(60, a.n.toString(2).length); k >= 2; k--) { const r = iroot(a.n, k); if (r > 1n && r ** BigInt(k) === a.n) return mulArr([NUM(qInt(k)), mkFn('ln', NUM({ n: r, d: 1n }))], 0); }
      }
      if (a.t === 'const' && a.name === 'e') return ONE;
      if (a.t === 'pow' && a.b.t === 'const' && a.b.name === 'e') return a.e;
    }
    if (name === 'abs') {
      if (a.t === 'fn' && (a.name === 'abs' || a.name === 'cosh' || a.name === 'sech')) return a;
      if (isPositive(a)) return a;
      if (a.t === 'mul' && a.args[0].t === 'num') { const rest = a.args.length === 2 ? a.args[1] : mkMul(a.args.slice(1)); return mulArr([NUM(a.args[0].n < 0n ? qneg(a.args[0]) : a.args[0]), fn('abs', rest)], 0); }
      if (a.t === 'pow' && a.e.t === 'num' && a.e.d === 1n && a.e.n % 2n === 0n) return a;
    }
    if (name === 'sign' && isPositive(a)) return ONE;
    // exact trig values at multiples of pi/6 and pi/4
    const tw = piTwelfths(a);
    if (tw !== null && (name === 'sin' || name === 'cos' || name === 'tan' || name === 'sec' || name === 'csc' || name === 'cot')) {
      const s = sinTwelfths(tw), c = sinTwelfths(tw + 6);
      if (s !== null && c !== null) {
        switch (name) {
          case 'sin': return s;
          case 'cos': return c;
          case 'tan': if (!isZero(c)) return div(s, c); break;
          case 'sec': if (!isZero(c)) return pow(c, MINUS_ONE); break;
          case 'csc': if (!isZero(s)) return pow(s, MINUS_ONE); break;
          case 'cot': if (!isZero(s)) return div(c, s); break;
        }
      }
    }
    if (name === 'asin' || name === 'acos' || name === 'atan') {
      const T = invTables();
      const lookup = name === 'atan' ? T.atan : T.asin;
      if (name === 'acos') { const k = T.asin.get(a.k); if (k !== undefined) return twelfthsToExpr(6 - k); }
      else { const k = lookup.get(a.k); if (k !== undefined) return twelfthsToExpr(k); }
    }
    // inverse pairs
    if (a.t === 'fn') {
      if ((name === 'sin' && a.name === 'asin') || (name === 'cos' && a.name === 'acos') || (name === 'tan' && a.name === 'atan') ||
          (name === 'sinh' && a.name === 'asinh') || (name === 'cosh' && a.name === 'acosh') || (name === 'tanh' && a.name === 'atanh')) return a.a;
    }
    return mkFn(name, a);
  }
  const sqrt = a => pow(a, HALF);
  const exp = a => pow(E, a);
  const ln = a => fn('ln', a);
  const num = (n, d) => NUM(d === undefined ? fromNumber(n) : mkq(BigInt(n), BigInt(d)));
  const sym = name => SYM(name);

  /* ═════════════════════ printing ═════════════════════ */

  const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
  const SUP_REV = {}; Object.keys(SUP).forEach(k => { SUP_REV[SUP[k]] = k; });
  const toSup = s => s.replace(/[0-9-]/g, c => SUP[c]);
  const SHOWN_FN = { asin: 'arcsin', acos: 'arccos', atan: 'arctan', acot: 'arccot', asinh: 'arsinh', acosh: 'arcosh', atanh: 'artanh' };
  const WORDS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'exp', 'log', 'abs', 'ln', 'pi', 'sinh', 'cosh', 'tanh', 'sqrt'];

  function prec(e) {
    switch (e.t) {
      case 'num': return e.d !== 1n ? 2 : (e.n < 0n ? 1 : 5);
      case 'sym': case 'const': case 'fn': return 5;
      case 'add': return 1;
      case 'mul': return (e.args[0].t === 'num' && e.args[0].n < 0n) ? 1 : 2;
      case 'pow':
        if (e.e.t === 'num') {
          if (e.e.n < 0n) return 2;
          if (e.e.n === 1n && e.e.d === 2n) return 4;
        }
        return 4;
      default: return 5;
    }
  }

  function toString(e, opts) {
    const A = !!(opts && opts.ascii);
    const par = (x, min) => prec(x) >= min ? f(x) : '(' + f(x) + ')';
    const sepOk = (a, b) => {               // may a and b be written side by side with no symbol in between?
      const run = (a.s.match(/[A-Za-z]+$/) || [''])[0] + (b.s.match(/^[A-Za-z]+/) || [''])[0];
      for (const w of WORDS) if (run.indexOf(w) >= 0) return false;
      return true;
    };
    function joinFactors(items) {           // items: [{s, coef, rad}]
      let out = items[0].s;
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1], b = items[i];
        let sep;
        if (A) sep = '*';
        else if (/^[0-9]/.test(b.s) || a.rad) sep = '·';
        else if (b.rad) sep = a.coef ? '' : '·';
        else if (b.s[0] === '(' || (a.coef && /^[A-Za-zα-ωπ]/.test(b.s))) sep = '';
        else if (/^[A-Za-z]²*$/.test(a.s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, '²')) && /^[A-Za-z]²*$/.test(b.s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, '²')) && sepOk(a, b)) sep = '';
        else sep = ' ';
        out += sep + b.s;
      }
      return out;
    }
    function item(x) {
      const s = par(x, 2);
      return { s, coef: false, rad: !A && /^√/.test(s) && x.t === 'pow' };
    }
    function fmtMul(m) {
      let c = ONE; const nu = [], de = [];
      for (const x of m.args) {
        if (x.t === 'num') c = x;
        else if (x.t === 'pow' && x.e.t === 'num' && x.e.n < 0n) de.push(pow(x.b, NUM(qneg(x.e))));
        else nu.push(x);
      }
      const sign = c.n < 0n ? (A ? '-' : '−') : '';
      const cn = babs(c.n);
      const numItems = [];
      if (cn !== 1n || nu.length === 0) numItems.push({ s: String(cn), coef: true, rad: false });
      nu.forEach(x => numItems.push(item(x)));
      const denItems = [];
      if (c.d !== 1n) denItems.push({ s: String(c.d), coef: true, rad: false });
      de.forEach(x => denItems.push(item(x)));
      let s = joinFactors(numItems);
      if (denItems.length === 1) {
        s += '/' + denItems[0].s;
      } else if (denItems.length > 1) s += '/(' + joinFactors(denItems) + ')';
      return sign + s;
    }
    function fmtPow(p) {
      const b = p.b, x = p.e;
      if (x.t === 'num') {
        if (x.n < 0n) {
          const inv = pow(b, NUM(qneg(x)));
          return '1/' + (prec(inv) >= 4 && inv.t !== 'num' ? f(inv) : '(' + f(inv) + ')');
        }
        if (x.n === 1n && x.d === 2n) {
          const atom = b.t === 'sym' || b.t === 'const' || (b.t === 'num' && b.d === 1n && b.n >= 0n);
          return A ? 'sqrt(' + f(b) + ')' : '√' + (atom ? f(b) : '(' + f(b) + ')');
        }
        if (x.d === 1n) {
          const bs = prec(b) >= 5 ? f(b) : '(' + f(b) + ')';
          const ns = String(x.n);
          return A || ns.length > 4 ? bs + '^' + ns : bs + toSup(ns);
        }
        return (prec(b) >= 5 ? f(b) : '(' + f(b) + ')') + '^(' + (A ? qstr(x) : qstr(x).replace('-', '−')) + ')';
      }
      const bs = prec(b) >= 5 ? f(b) : '(' + f(b) + ')';
      const atomExp = x.t === 'sym' || x.t === 'const' || (x.t === 'num' && x.d === 1n && x.n >= 0n);
      return bs + '^' + (atomExp ? f(x) : '(' + f(x) + ')');
    }
    function f(x) {
      switch (x.t) {
        case 'num': return A ? qstr(x) : qstr(x).replace('-', '−');
        case 'sym': return x.name;
        case 'const': return x.name === 'pi' ? (A ? 'pi' : 'π') : 'e';
        case 'fn': return (A ? x.name : (SHOWN_FN[x.name] || x.name)) + '(' + f(x.a) + ')';
        case 'pow': return fmtPow(x);
        case 'mul': return fmtMul(x);
        case 'add': {
          let s = '';
          let terms = x.args;
          if (terms.length === 2 && negLead(terms[0]) && terms[1].t === 'num' && terms[1].n > 0n) terms = [terms[1], terms[0]];   // 1 − x², not −x² + 1
          terms.forEach((t, i) => {
            const isNeg = negLead(t);
            const body = isNeg ? f(neg(t)) : f(t);
            if (i === 0) s = isNeg ? (A ? '-' : '−') + (prec(neg(t)) < 2 ? '(' + body + ')' : body) : body;
            else s += (isNeg ? (A ? ' - ' : ' − ') : ' + ') + body;
          });
          return s;
        }
        default: return '?';
      }
    }
    return f(e);
  }

  /* ═════════════════════ parser ═════════════════════ */

  class ParseError extends Error {
    constructor(message, pos, end) { super(message); this.name = 'ParseError'; this.pos = pos; this.end = end === undefined ? pos + 1 : end; }
  }

  const FN_ALIAS = { arcsin: 'asin', arccos: 'acos', arctan: 'atan', arccot: 'acot', arsinh: 'asinh', arcsinh: 'asinh', arcosh: 'acosh',
    arccosh: 'acosh', artanh: 'atanh', arctanh: 'atanh', log: 'ln', ctg: 'cot', tg: 'tan' };
  const FN_EXTRA = ['sqrt', 'cbrt', 'exp', 'log10', 'log2'];
  const FN_WORDS = KNOWN_FN.concat(FN_EXTRA, Object.keys(FN_ALIAS));
  const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi',
    'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];
  const GREEK_CHARS = { 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'θ': 'theta', 'λ': 'lambda', 'μ': 'mu', 'ρ': 'rho',
    'σ': 'sigma', 'τ': 'tau', 'φ': 'phi', 'ψ': 'psi', 'ω': 'omega', 'π': 'pi' };
  const ALL_WORDS = FN_WORDS.concat(GREEK, ['pi']).sort((a, b) => b.length - a.length);
  const SHOW_FUNCS = 'sin, cos, tan, sec, csc, cot, asin, acos, atan, sinh, cosh, tanh, ln, log, sqrt, abs, exp';

  function tokenize(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    const fail = (m, a, b) => { throw new ParseError(m, a, b); };
    while (i < n) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/[0-9.]/.test(ch)) {
        const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
        if (!m) fail('A lone decimal point at character ' + (i + 1) + '. Write the digits on both sides, like 0.5.', i);
        if (src[i + m[0].length] === '.') fail('This number has two decimal points (character ' + (i + 1) + ').', i, i + m[0].length + 1);
        let v;
        try { v = parseDecimal(m[0]); } catch (e) { fail('The number "' + m[0] + '" at character ' + (i + 1) + ' is too large.', i, i + m[0].length); }
        toks.push({ t: 'num', v, s: m[0], pos: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        const m = /^[A-Za-z]+/.exec(src.slice(i));
        let run = m[0], len = run.length;
        const dm = /^\d+/.exec(src.slice(i + len));
        if (dm) {
          if ((run === 'log' && (dm[0] === '10' || dm[0] === '2'))) { run = run + dm[0]; len += dm[0].length; }
          else fail('"' + run + dm[0] + '" at character ' + (i + 1) + ' is ambiguous. Write ' + run + '^' + dm[0] + ' for a power, or ' + run + '*' + dm[0] + ' for a product.', i, i + len + dm[0].length);
        }
        const words = [];
        let p = 0, anyWord = false;
        while (p < run.length) {
          let w = null;
          for (const cand of ALL_WORDS) if (run.startsWith(cand, p)) { w = cand; break; }
          if (w) anyWord = true; else w = run[p];
          words.push({ w, off: p });
          p += w.length;
        }
        if (!anyWord && run.length >= 3 && src[i + len] === '(')
          fail('"' + run + '" at character ' + (i + 1) + ' is not a function I know. The functions are: ' + SHOW_FUNCS + '. To multiply variables, put * between them.', i, i + len);
        for (const { w, off } of words) toks.push({ t: 'id', v: w, pos: i + off, end: i + off + w.length });
        i += len;
        continue;
      }
      if (GREEK_CHARS[ch]) { toks.push({ t: 'id', v: GREEK_CHARS[ch], pos: i, end: i + 1 }); i++; continue; }
      if (SUP_REV[ch] !== undefined) {
        let j = i, s = '';
        while (j < n && SUP_REV[src[j]] !== undefined) { s += SUP_REV[src[j]]; j++; }
        toks.push({ t: 'sup', v: s, pos: i, end: j });
        i = j;
        continue;
      }
      if (ch === '√') { toks.push({ t: 'sqrt', pos: i, end: i + 1 }); i++; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { toks.push({ t: 'lp', v: ch, pos: i, end: i + 1 }); i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { toks.push({ t: 'rp', v: ch, pos: i, end: i + 1 }); i++; continue; }
      if (ch === '*' && src[i + 1] === '*') { toks.push({ t: 'op', v: '^', s: '**', pos: i, end: i + 2 }); i += 2; continue; }
      if ('+-*/^'.indexOf(ch) >= 0) { toks.push({ t: 'op', v: ch, pos: i, end: i + 1 }); i++; continue; }
      if (ch === '−' || ch === '–' || ch === '‒') { toks.push({ t: 'op', v: '-', pos: i, end: i + 1 }); i++; continue; }
      if (ch === '·' || ch === '×' || ch === '⋅') { toks.push({ t: 'op', v: '*', pos: i, end: i + 1 }); i++; continue; }
      if (ch === '÷') { toks.push({ t: 'op', v: '/', pos: i, end: i + 1 }); i++; continue; }
      if (ch === '=') fail('There is an "=" at character ' + (i + 1) + '. Type just the expression, not an equation.', i);
      if (ch === ',') fail('There is a comma at character ' + (i + 1) + '. Use a full stop for decimals (0.5), and * between factors.', i);
      if (ch === '|') fail('The bar "|" at character ' + (i + 1) + ' is not supported. Write abs(x) for the absolute value of x.', i);
      if (ch === '!') fail('Factorials are not supported (character ' + (i + 1) + ').', i);
      if (ch === '∞') fail('Infinity is only allowed in the limits of a definite integral.', i);
      fail('I do not understand the character "' + ch + '" at character ' + (i + 1) + '.', i);
    }
    return toks;
  }

  function parseTokens(toks, src) {
    let i = 0;
    const peek = () => toks[i];
    const isOp = (t, c) => !!t && t.t === 'op' && t.v === c;
    const startsOperand = t => !!t && (t.t === 'num' || t.t === 'id' || t.t === 'lp' || t.t === 'sqrt');
    const ch1 = t => (t.pos + 1);
    const showTok = t => t.t === 'op' || t.t === 'lp' || t.t === 'rp' ? '"' + (t.s || t.v) + '"' : t.t === 'num' ? '"' + t.s + '"' : t.t === 'sup' ? 'the power' : '"' + (t.v || '√') + '"';

    function operandError(tok) {            // something was needed here but tok is not it
      const prev = toks[i - 1];
      if (!tok) {
        if (!prev) return new ParseError('Type an expression, for example x^2*sin(x).', 0, 0);
        if (prev.t === 'op') return new ParseError('The expression stops after the "' + (prev.s || prev.v) + '" at character ' + ch1(prev) + '. Something is missing after it.', prev.pos, prev.end);
        if (prev.t === 'lp') return new ParseError('The bracket at character ' + ch1(prev) + ' is never closed.', prev.pos, prev.end);
        return new ParseError('The expression stops too early after ' + showTok(prev) + ' (character ' + ch1(prev) + ').', prev.pos, prev.end);
      }
      if (tok.t === 'rp') {
        if (prev && prev.t === 'lp') return new ParseError('There is nothing between the brackets at character ' + ch1(prev) + '.', prev.pos, tok.end);
        if (prev && prev.t === 'op') return new ParseError('Something is missing between the "' + (prev.s || prev.v) + '" at character ' + ch1(prev) + ' and the "' + (tok.s || tok.v) + '" at character ' + ch1(tok) + '.', prev.pos, tok.end);
        return new ParseError('The "' + (tok.s || tok.v) + '" at character ' + ch1(tok) + ' has no matching opening bracket.', tok.pos, tok.end);
      }
      if (tok.t === 'op') {
        if (!prev) return new ParseError('An expression cannot start with "' + (tok.s || tok.v) + '" (character ' + ch1(tok) + ').', tok.pos, tok.end);
        if (prev.t === 'op') return new ParseError('Two operators in a row: "' + (prev.s || prev.v) + '" at character ' + ch1(prev) + ' and "' + (tok.s || tok.v) + '" at character ' + ch1(tok) + '. Something is missing between them.', prev.pos, tok.end);
        return new ParseError('The "' + (tok.s || tok.v) + '" at character ' + ch1(tok) + ' needs something in front of it.', tok.pos, tok.end);
      }
      return new ParseError('I did not expect ' + showTok(tok) + ' at character ' + ch1(tok) + '.', tok.pos, tok.end);
    }

    function parseSum() {
      let left = parseTerm();
      for (;;) {
        const t = peek();
        if (isOp(t, '+')) { i++; left = add(left, parseTerm()); }
        else if (isOp(t, '-')) { i++; left = sub(left, parseTerm()); }
        else return left;
      }
    }
    function parseTerm() {
      let left = parseUnary();
      for (;;) {
        const t = peek();
        if (isOp(t, '*')) { i++; left = mul(left, parseUnary()); }
        else if (isOp(t, '/')) {
          i++;
          const r = parseUnary();
          if (isZero(r)) throw new ParseError('This divides by zero (the "/" at character ' + ch1(t) + ').', t.pos, t.end);
          left = div(left, r);
        }
        else if (startsOperand(t)) left = mul(left, parsePower());
        else return left;
      }
    }
    function parseUnary() {
      const t = peek();
      if (isOp(t, '-')) { i++; return neg(parseUnary()); }
      if (isOp(t, '+')) { i++; return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      const base = parsePostfix();
      if (isOp(peek(), '^')) {
        i++;
        return pow(base, parseExponent());
      }
      return base;
    }
    function parseExponent() {
      const t = peek();
      if (isOp(t, '-')) { i++; return neg(parseExponent()); }
      if (isOp(t, '+')) { i++; return parseExponent(); }
      return parsePower();
    }
    function supValue(t) {
      if (!/^-?\d+$/.test(t.v)) throw new ParseError('I cannot read the power at character ' + ch1(t) + '.', t.pos, t.end);
      return NUM(mkq(BigInt(t.v), 1n));
    }
    function parsePostfix() {
      let a = parsePrimary();
      while (peek() && peek().t === 'sup') a = pow(a, supValue(toks[i++]));
      return a;
    }
    function parseGroup(open) {
      const inner = peek();
      if (!inner || inner.t === 'rp') throw operandError(inner);
      const e = parseSum();
      const close = peek();
      if (!close || close.t !== 'rp') {
        if (!close) throw new ParseError('The bracket "' + open.v + '" at character ' + ch1(open) + ' is never closed. Add a ")" at the end.', open.pos, open.end);
        throw new ParseError('I did not expect ' + showTok(close) + ' at character ' + ch1(close) + ' inside the bracket opened at character ' + ch1(open) + '.', close.pos, close.end);
      }
      i++;
      return e;
    }
    function parsePrimary() {
      const t = peek();
      if (!t) throw operandError(t);
      if (t.t === 'num') { i++; return NUM(t.v); }
      if (t.t === 'lp') { i++; return parseGroup(t); }
      if (t.t === 'sqrt') {
        i++;
        if (!peek() || !startsOperand(peek())) throw new ParseError('The "√" at character ' + ch1(t) + ' needs something after it, like √x or √(x+1).', t.pos, t.end);
        return sqrt(parsePostfix());
      }
      if (t.t === 'id') {
        i++;
        const w = t.v;
        if (w === 'pi') return PI;
        if (w === 'e') return E;
        if (FN_WORDS.indexOf(w) >= 0) return parseFunction(t);
        return SYM(w);
      }
      throw operandError(t);
    }
    function parseFunction(t) {
      const name = t.v;
      let expo = null;
      if (isOp(peek(), '^')) { i++; expo = parseExponent(); }
      else if (peek() && peek().t === 'sup') expo = supValue(toks[i++]);
      if (expo && isNum(expo) && expo.d === 1n && expo.n === -1n)
        throw new ParseError(name + '^(-1) at character ' + ch1(t) + ' is ambiguous. Write 1/' + name + '(x) for the reciprocal, or the inverse function with its own name (like asin(x) or atan(x)).', t.pos, toks[i - 1].end);
      let arg;
      const p = peek();
      if (p && p.t === 'lp') { i++; arg = parseGroup(p); }
      else {
        if (!p || !(startsOperand(p) || isOp(p, '-')))
          throw new ParseError(name + ' at character ' + ch1(t) + ' needs an argument, like ' + name + '(x).', t.pos, t.end);
        arg = parseFuncArg();
      }
      let r = applyFn(name, arg, t);
      return expo ? pow(r, expo) : r;
    }
    function parseFuncArg() {               // sin 2x, ln x, sqrt x: no brackets
      if (isOp(peek(), '-')) { i++; return neg(parseFuncArg()); }
      let a = parsePower();
      while (startsOperand(peek()) && !(peek().t === 'id' && FN_WORDS.indexOf(peek().v) >= 0)) a = mul(a, parsePower());
      return a;
    }
    function applyFn(name, arg, t) {
      switch (name) {
        case 'sqrt': return sqrt(arg);
        case 'cbrt': return pow(arg, NUM(mkq(1n, 3n)));
        case 'exp': return exp(arg);
        case 'log10': return div(ln(arg), ln(NUM(qInt(10))));
        case 'log2': return div(ln(arg), ln(TWO));
        default: return fn(FN_ALIAS[name] || name, arg);
      }
    }

    const result = parseSum();
    if (i < toks.length) {
      const t = toks[i];
      if (t.t === 'rp') throw new ParseError('There is a "' + t.v + '" at character ' + ch1(t) + ' with no opening bracket to match it.', t.pos, t.end);
      throw new ParseError('I did not expect ' + showTok(t) + ' at character ' + ch1(t) + '.', t.pos, t.end);
    }
    return result;
  }

  function parse(text) {
    if (typeof text !== 'string') return typeof text === 'number' || typeof text === 'bigint' ? NUM(fromNumber(text)) : text;
    if (!text.trim()) throw new ParseError('Type an expression, for example x^2*sin(x).', 0, 0);
    return parseTokens(tokenize(text), text);
  }
  function tryParse(text) {
    try { return { ok: true, expr: parse(text) }; }
    catch (e) {
      if (e instanceof ParseError) return { ok: false, error: { message: e.message, pos: e.pos, end: e.end } };
      throw e;
    }
  }
  /* parse, plus plain-language notes about readings the writer might not have intended */
  function parseWithNotes(text) {
    const expr = parse(text);
    const notes = [];
    let m;
    if (/\blog\s*\(/i.test(text) && !/log(10|2)/i.test(text)) notes.push('log(x) is read as the natural logarithm ln(x). Use log10(x) for base 10.');
    if ((m = /\^\s*(\d+)\s*\/\s*(\d+)/.exec(text))) notes.push('"^' + m[1] + '/' + m[2] + '" is read as a power of ' + m[1] + ' divided by ' + m[2] + '. For a fractional power put the exponent in brackets: ^(' + m[1] + '/' + m[2] + ').');
    if ((m = /\be\s*\^\s*(\d+|[a-z])(?=[a-z0-9(])/i.exec(text)) && !/^\s*sin|cos|tan|ln|log|exp|sqrt/i.test(text.slice(m.index + m[0].length)))
      notes.push('In "' + m[0] + '…" the power applies only to "' + m[1] + '". If the whole product is the exponent, use brackets: e^(…).');
    if ((m = /\/\s*(\d+)(?=\s*[a-z(])/i.exec(text)))
      notes.push('"/' + m[1] + '" divides by ' + m[1] + ' only; whatever follows is multiplied afterwards. Use brackets, /(' + m[1] + '…), if the denominator is longer.');
    return { expr, notes };
  }

  /* ═════════════════════ inspection, substitution, evaluation ═════════════════════ */

  const VCACHE = new WeakMap();
  function unionNames(lists) {
    const s = new Set();
    for (const l of lists) for (const n of l) s.add(n);
    return Array.from(s).sort();
  }
  function varSet(e) {
    let r = VCACHE.get(e);
    if (r) return r;
    switch (e.t) {
      case 'sym': r = [e.name]; break;
      case 'fn': r = varSet(e.a); break;
      case 'pow': r = unionNames([varSet(e.b), varSet(e.e)]); break;
      case 'add': case 'mul': r = unionNames(e.args.map(varSet)); break;
      default: r = [];
    }
    VCACHE.set(e, r);
    return r;
  }
  const freeVars = e => varSet(parse(e)).slice();
  const dependsOn = (e, v) => varSet(e).indexOf(v) >= 0;
  const toExpr = x => (typeof x === 'object' ? x : parse(x));

  function rebuildWith(e, f) {              // rebuild e through the constructors, applying f to each child
    switch (e.t) {
      case 'add': return addArr(e.args.map(f));
      case 'mul': return mulArr(e.args.map(f), 0);
      case 'pow': return pow(f(e.b), f(e.e));
      case 'fn': return fn(e.name, f(e.a));
      default: return e;
    }
  }
  function subst(e, a, b) {
    e = toExpr(e);
    const map = {};
    if (typeof a === 'string') map[a] = toExpr(b); else Object.keys(a).forEach(k => { map[k] = toExpr(a[k]); });
    const names = Object.keys(map);
    const go = x => {
      if (!varSet(x).some(n => names.indexOf(n) >= 0)) return x;
      if (x.t === 'sym') return map[x.name];
      return rebuildWith(x, go);
    };
    return go(e);
  }
  function replace(e, target, repl) {       // structural: every sub-expression equal to target
    const go = x => (x.k === target.k ? repl : rebuildWith(x, go));
    return go(e);
  }

  const FN_NUM = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, cot: x => 1 / Math.tan(x), sec: x => 1 / Math.cos(x), csc: x => 1 / Math.sin(x),
    asin: Math.asin, acos: Math.acos, atan: Math.atan, acot: x => Math.PI / 2 - Math.atan(x),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, coth: x => 1 / Math.tanh(x), sech: x => 1 / Math.cosh(x), csch: x => 1 / Math.sinh(x),
    asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh, ln: Math.log, abs: Math.abs, sign: Math.sign
  };
  function compile(e, vars) {
    e = toExpr(e);
    vars = vars || varSet(e);
    const idx = {};
    vars.forEach((v, i) => { idx[v] = i; });
    const build = x => {
      switch (x.t) {
        case 'num': { const val = qnum(x); return () => val; }
        case 'const': { const val = x.name === 'pi' ? Math.PI : Math.E; return () => val; }
        case 'sym': {
          const i = idx[x.name];
          if (i === undefined) throw new Error('no value given for the variable ' + x.name);
          return a => a[i];
        }
        case 'add': { const fs = x.args.map(build), n = fs.length; return a => { let s = 0; for (let i = 0; i < n; i++) s += fs[i](a); return s; }; }
        case 'mul': { const fs = x.args.map(build), n = fs.length; return a => { let s = 1; for (let i = 0; i < n; i++) s *= fs[i](a); return s; }; }
        case 'fn': { const f = build(x.a), g = FN_NUM[x.name]; return a => g(f(a)); }
        case 'pow': {
          const bf = build(x.b);
          if (x.e.t === 'num') {
            const n = qnum(x.e);
            if (x.e.d === 1n) {
              if (n === 2) return a => { const t = bf(a); return t * t; };
              if (n === -1) return a => 1 / bf(a);
              return a => Math.pow(bf(a), n);
            }
            if (x.e.d % 2n === 1n) {        // odd root: real value for negative bases
              const sgn = x.e.n % 2n !== 0n ? -1 : 1;
              return a => { const t = bf(a); return t < 0 ? sgn * Math.pow(-t, n) : Math.pow(t, n); };
            }
            return a => Math.pow(bf(a), n);
          }
          const ef = build(x.e);
          if (x.b.t === 'const' && x.b.name === 'e') return a => Math.exp(ef(a));
          return a => Math.pow(bf(a), ef(a));
        }
        default: throw new Error('cannot evaluate');
      }
    };
    const f = build(e);
    return function () { return f(arguments); };
  }
  function evalNum(e, env) {
    e = toExpr(e);
    env = env || {};
    const names = Object.keys(env);
    return compile(e, names).apply(null, names.map(n => env[n]));
  }

  /* ═════════════════════ differentiation ═════════════════════ */

  const DFN = {
    sin: u => fn('cos', u), cos: u => neg(fn('sin', u)),
    tan: u => pow(fn('sec', u), TWO), cot: u => neg(pow(fn('csc', u), TWO)),
    sec: u => mul(fn('sec', u), fn('tan', u)), csc: u => neg(mul(fn('csc', u), fn('cot', u))),
    asin: u => pow(sub(ONE, pow(u, TWO)), NUM(mkq(-1n, 2n))), acos: u => neg(pow(sub(ONE, pow(u, TWO)), NUM(mkq(-1n, 2n)))),
    atan: u => pow(add(ONE, pow(u, TWO)), MINUS_ONE), acot: u => neg(pow(add(ONE, pow(u, TWO)), MINUS_ONE)),
    sinh: u => fn('cosh', u), cosh: u => fn('sinh', u),
    tanh: u => pow(fn('cosh', u), NUM(qInt(-2))), coth: u => neg(pow(fn('sinh', u), NUM(qInt(-2)))),
    sech: u => neg(mul(fn('sech', u), fn('tanh', u))), csch: u => neg(mul(fn('csch', u), fn('coth', u))),
    asinh: u => pow(add(pow(u, TWO), ONE), NUM(mkq(-1n, 2n))), acosh: u => pow(sub(pow(u, TWO), ONE), NUM(mkq(-1n, 2n))),
    atanh: u => pow(sub(ONE, pow(u, TWO)), MINUS_ONE),
    ln: u => pow(u, MINUS_ONE), abs: u => fn('sign', u), sign: () => ZERO
  };
  const FN_LABEL = { sin: 'sine', cos: 'cosine', tan: 'tangent', cot: 'cotangent', sec: 'secant', csc: 'cosecant', asin: 'inverse sine',
    acos: 'inverse cosine', atan: 'inverse tangent', acot: 'inverse cotangent', sinh: 'hyperbolic sine', cosh: 'hyperbolic cosine',
    tanh: 'hyperbolic tangent', coth: 'hyperbolic cotangent', sech: 'hyperbolic secant', csch: 'hyperbolic cosecant',
    asinh: 'inverse hyperbolic sine', acosh: 'inverse hyperbolic cosine', atanh: 'inverse hyperbolic tangent',
    ln: 'natural logarithm', abs: 'absolute value', sign: 'sign function' };

  function D(e, v, rec) {
    const T = x => toString(x);
    const dv = 'd/d' + v;
    const begin = (rule, text, formula) => {
      if (!rec) return null;
      const s = { depth: rec.depth, rule, expr: e, text, formula, result: null };
      rec.steps.push(s);
      return s;
    };
    const child = x => {
      if (rec) rec.depth++;
      const r = D(x, v, rec);
      if (rec) rec.depth--;
      return r;
    };
    const done = (st, r) => { if (st) st.result = r; return r; };

    if (!dependsOn(e, v)) {
      if (rec && !(isNum(e) && rec.depth > 0)) {
        const others = varSet(e);
        const st = begin('Constant rule', isNum(e) ? T(e) + ' is a constant, so its derivative is 0.'
          : T(e) + ' does not contain ' + v + ', so ' + (others.length > 1 ? 'the variables ' + others.join(', ') + ' are' : others.length === 1 ? others[0] + ' is' : 'it is') +
            ' treated as a constant here. Its derivative with respect to ' + v + ' is 0.', dv + '[c] = 0');
        return done(st, ZERO);
      }
      return ZERO;
    }
    switch (e.t) {
      case 'sym': return done(begin('Derivative of the variable', dv + '[' + v + '] = 1.', dv + '[' + v + '] = 1'), ONE);
      case 'add': {
        const st = begin('Sum rule', 'Differentiate the terms one at a time and add the results.', dv + '[f + g] = f′ + g′');
        return done(st, addArr(e.args.map(t => (isNum(t) && rec ? ZERO : child(t)))));
      }
      case 'mul': {
        const consts = e.args.filter(a => !dependsOn(a, v)), vary = e.args.filter(a => dependsOn(a, v));
        if (consts.length) {
          const c = mulArr(consts, 0), rest = mulArr(vary, 0);
          const st = begin('Constant multiple rule', T(c) + ' does not depend on ' + v + ', so it stays in front: ' + dv + '[c·f] = c·' + dv + '[f]. Here f = ' + T(rest) + '.', dv + '[c·f] = c·f′');
          return done(st, mulArr([c, child(rest)], 0));
        }
        const den = vary.filter(f => f.t === 'pow' && f.e.t === 'num' && f.e.n < 0n), nu = vary.filter(f => !(f.t === 'pow' && f.e.t === 'num' && f.e.n < 0n));
        if (den.length && nu.length) {
          const u = mulArr(nu, 0), w = mulArr(den.map(f => pow(f.b, NUM(qneg(f.e)))), 0);
          const st = begin('Quotient rule', 'Write it as u/v with u = ' + T(u) + ' and v = ' + T(w) + '.', dv + '[u/v] = (u′·v − u·v′) / v²');
          const du = child(u), dw = child(w);
          return done(st, div(sub(mul(du, w), mul(u, dw)), pow(w, TWO)));
        }
        const st = begin('Product rule', vary.length === 2 ? 'u = ' + T(vary[0]) + ' and v = ' + T(vary[1]) + '.' : 'Differentiate each factor in turn while the others stay as they are, and add the results.',
          vary.length === 2 ? dv + '[u·v] = u′·v + u·v′' : dv + '[f₁·f₂·…·fₙ] = f₁′·f₂·…·fₙ + f₁·f₂′·…·fₙ + …');
        const ds = vary.map(child);
        const terms = vary.map((f, i) => mulArr(vary.map((g, j) => (j === i ? ds[i] : g)), 0));
        return done(st, addArr(terms));
      }
      case 'pow': {
        const b = e.b, ex = e.e, bd = dependsOn(b, v), ed = dependsOn(ex, v);
        if (!ed) {
          if (b.t === 'sym') {
            const st = begin('Power rule', 'Bring the exponent ' + T(ex) + ' down in front and lower the exponent by one.', dv + '[' + v + 'ⁿ] = n·' + v + 'ⁿ⁻¹');
            return done(st, mulArr([ex, pow(b, sub(ex, ONE))], 0));
          }
          const st = begin('Power rule with the chain rule', 'The base u = ' + T(b) + ' is not just ' + v + ', so the chain rule applies: bring the exponent ' + T(ex) + ' down, lower it by one, and multiply by u′.', dv + '[uⁿ] = n·uⁿ⁻¹·u′');
          const du = child(b);
          return done(st, mulArr([ex, pow(b, sub(ex, ONE)), du], 0));
        }
        if (!bd) {
          const isE = b.t === 'const' && b.name === 'e';
          const st = begin(isE ? 'Exponential rule' : 'Exponential rule (base ' + T(b) + ')',
            (isE ? 'The derivative of e to the power u is e^u times u′' : 'The derivative of ' + T(b) + ' to the power u is ' + T(b) + '^u · ln(' + T(b) + ') times u′') + ', with u = ' + T(ex) + '.',
            isE ? dv + '[eᵘ] = eᵘ·u′' : dv + '[aᵘ] = aᵘ·ln(a)·u′');
          const du = ex.t === 'sym' ? ONE : child(ex);
          return done(st, mulArr([e, ln(b), du], 0));
        }
        const st = begin('General power rule (logarithmic differentiation)', 'Both the base u = ' + T(b) + ' and the exponent w = ' + T(ex) + ' contain ' + v + '.', dv + '[uʷ] = uʷ·(w′·ln u + w·u′/u)');
        const db = child(b), dex = child(ex);
        return done(st, mulArr([e, addArr([mulArr([dex, ln(b)], 0), mulArr([ex, db, pow(b, MINUS_ONE)], 0)])], 0));
      }
      case 'fn': {
        const u = e.a, label = FN_LABEL[e.name];
        if (e.name === 'ln' && u.t === 'fn' && u.name === 'abs') {
          const st = begin('Logarithm of an absolute value', 'The derivative of ln|u| is u′/u, with u = ' + T(u.a) + '.', dv + '[ln|u|] = u′/u');
          const dw = u.a.t === 'sym' ? ONE : child(u.a);
          return done(st, div(dw, u.a));
        }
        const f1 = DFN[e.name](u);
        const tableForm = 'd/du[' + toString(fn(e.name, SYM('u'))) + '] = ' + toString(DFN[e.name](SYM('u')));
        if (u.t === 'sym') return done(begin('Derivative of the ' + label, tableForm.replace(/u/g, v) + '.', tableForm.replace(/u/g, v)), f1);
        const st = begin('Chain rule', 'Outer function: the ' + label + '. Inner function: u = ' + T(u) + '. ' + tableForm + ', so differentiate the outer function, keep u inside it, and multiply by u′.', dv + '[f(u)] = f′(u)·u′');
        const du = child(u);
        return done(st, mulArr([f1, du], 0));
      }
      default: return ZERO;
    }
  }

  function diff(e, v) { return D(toExpr(e), v, null); }
  function diffSteps(e, v) {
    e = toExpr(e);
    const rec = { steps: [], depth: 0 };
    const result = simplify(D(e, v, rec));
    const others = varSet(e).filter(n => n !== v);
    return { variable: v, expr: e, result, steps: rec.steps, others };
  }

  /* ═════════════════════ simplify, expand, together, factorCommon ═════════════════════ */

  const SQ_NAMES = ['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'sinh', 'cosh'];
  function sqParts(t) {                     // K * f(u)^2 -> {name, u, K}
    const test = f => f.t === 'pow' && f.e.t === 'num' && f.e.n === 2n && f.e.d === 1n && f.b.t === 'fn' && SQ_NAMES.indexOf(f.b.name) >= 0;
    if (test(t)) return { name: t.b.name, u: t.b.a, K: ONE };
    if (t.t === 'mul') {
      const i = t.args.findIndex(test);
      if (i >= 0) {
        const f = t.args[i], rest = t.args.filter((_, j) => j !== i);
        return { name: f.b.name, u: f.b.a, K: rest.length === 1 ? rest[0] : mulArr(rest, 0) };
      }
    }
    return null;
  }
  function combinePair(a, b) {              // Pythagorean identities between two terms of a sum, or null
    for (const [x, y] of [[a, b], [b, a]]) {
      const sy = sqParts(y);
      if (!sy) continue;
      const sx = sqParts(x);
      if (sx && sx.u.k === sy.u.k) {
        const same = sx.K.k === sy.K.k, opp = sx.K.k === neg(sy.K).k, pair = sx.name + ',' + sy.name;
        if (same && pair === 'sin,cos') return sx.K;
        if (opp && (pair === 'sec,tan' || pair === 'csc,cot' || pair === 'cosh,sinh')) return sx.K;
      }
      const plus = sy.K.k === x.k, minus = sy.K.k === neg(x).k, u = sy.u;     // y = +x f² or −x f², x the "unit" term
      if (minus && sy.name === 'sin') return mulArr([x, pow(fn('cos', u), TWO)], 0);
      if (minus && sy.name === 'cos') return mulArr([x, pow(fn('sin', u), TWO)], 0);
      if (plus && sy.name === 'tan') return mulArr([x, pow(fn('sec', u), TWO)], 0);
      if (plus && sy.name === 'cot') return mulArr([x, pow(fn('csc', u), TWO)], 0);
      if (plus && sy.name === 'sinh') return mulArr([x, pow(fn('cosh', u), TWO)], 0);
      if (minus && sy.name === 'sec') return mulArr([neg(x), pow(fn('tan', u), TWO)], 0);
      if (minus && sy.name === 'csc') return mulArr([neg(x), pow(fn('cot', u), TWO)], 0);
      if (minus && sy.name === 'cosh') return mulArr([neg(x), pow(fn('sinh', u), TWO)], 0);
    }
    return null;
  }
  function canon(e) {                       // rebuild through the constructors only (no trigonometric identities)
    e = toExpr(e);
    return e.t === 'num' || e.t === 'sym' || e.t === 'const' ? e : rebuildWith(e, canon);
  }
  function simplify(e) {
    e = toExpr(e);
    switch (e.t) {
      case 'add': {
        const r = addArr(e.args.map(simplify));
        if (r.t !== 'add') return r;
        let terms = r.args.slice();
        for (let iter = 0; iter < 30; iter++) {
          let hit = null;
          for (let i = 0; i < terms.length && !hit; i++) for (let j = i + 1; j < terms.length && !hit; j++) {
            const c = combinePair(terms[i], terms[j]);
            if (c !== null) hit = { i, j, c };
          }
          if (!hit) break;
          terms = terms.filter((_, k) => k !== hit.i && k !== hit.j).concat([hit.c]);
        }
        return addArr(terms);
      }
      case 'mul': case 'pow': case 'fn': return rebuildWith(e, simplify);
      default: return e;
    }
  }

  function distribute(a, b) {
    const ta = a.t === 'add' ? a.args : [a], tb = b.t === 'add' ? b.args : [b];
    if (ta.length * tb.length > 4000) return mulArr([a, b], 0);
    const out = [];
    for (const x of ta) for (const y of tb) out.push(mulArr([x, y], 0));
    return addArr(out);
  }
  function expand(e) {
    e = toExpr(e);
    switch (e.t) {
      case 'add': return addArr(e.args.map(expand));
      case 'mul': { let acc = ONE; for (const f of e.args) acc = distribute(acc, expand(f)); return acc; }
      case 'pow': {
        const b = expand(e.b);
        if (e.e.t === 'num' && e.e.d === 1n && e.e.n > 1n && e.e.n <= 40n && b.t === 'add') {
          let acc = b;
          for (let i = 1; i < Number(e.e.n); i++) acc = distribute(acc, b);
          return acc;
        }
        return pow(b, expand(e.e));
      }
      case 'fn': return fn(e.name, expand(e.a));
      default: return e;
    }
  }

  function together(e) {                    // e = n/d with d a product of powers; n, d not expanded
    e = toExpr(e);
    const one = { n: ONE, d: ONE };
    switch (e.t) {
      case 'num': return { n: NUM({ n: e.n, d: 1n }), d: NUM({ n: e.d, d: 1n }) };
      case 'mul': {
        let n = [], d = [];
        for (const f of e.args) { const t = together(f); n.push(t.n); d.push(t.d); }
        return { n: mulArr(n, 0), d: mulArr(d, 0) };
      }
      case 'pow': {
        if (e.e.t === 'num' && e.e.d === 1n) {
          const t = together(e.b), k = e.e;
          if (k.n > 0n) return { n: pow(t.n, k), d: pow(t.d, k) };
          const m = NUM(qneg(k));
          return { n: pow(t.d, m), d: pow(t.n, m) };
        }
        return { n: e, d: ONE };
      }
      case 'add': {
        const ts = e.args.map(together);
        const dens = ts.map(t => t.d);
        if (dens.every(isOne)) return { n: e, d: ONE };
        // common denominator: product of the distinct bases at their highest powers, times the lcm of the numeric parts
        const bases = new Map();
        let numLcm = 1n;
        for (const d of dens) {
          const fs = d.t === 'mul' ? d.args : [d];
          for (const f of fs) {
            if (f.t === 'num') { const q0 = f.n < 0n ? -f.n : f.n; numLcm = numLcm / bgcd(numLcm, q0) * q0; continue; }
            const b = f.t === 'pow' ? f.b : f, ex = f.t === 'pow' && f.e.t === 'num' ? f.e : ONE;
            const cur = bases.get(b.k);
            if (!cur || qcmp(ex, cur.ex) > 0) bases.set(b.k, { b, ex });
          }
        }
        const parts = [NUM({ n: numLcm, d: 1n })];
        bases.forEach(({ b, ex }) => parts.push(pow(b, ex)));
        const Dn = mulArr(parts, 0);
        const N = addArr(ts.map(t => mulArr([t.n, Dn, pow(t.d, MINUS_ONE)], 0)));
        return { n: N, d: Dn };
      }
      default: return { n: e, d: ONE };
    }
  }

  function factorCommon(e) {                // c·f·g + c·f·h  ->  c·f·(g + h)
    e = toExpr(e);
    if (e.t !== 'add') return e;
    const terms = e.args;
    const parts = terms.map(t => {
      if (t.t === 'num') return { c: t, fs: [] };
      const fs = t.t === 'mul' ? t.args : [t];
      return fs[0].t === 'num' ? { c: fs[0], fs: fs.slice(1) } : { c: ONEQ, fs };
    });
    let gn = 0n, ld = 1n;
    for (const p of parts) { gn = bgcd(gn, p.c.n); ld = ld / bgcd(ld, p.c.d) * p.c.d; }
    if (gn === 0n) return e;
    const picked = [];
    for (const f of parts[0].fs) {
      const b = f.t === 'pow' ? f.b : f;
      if (picked.some(p => p.b.k === b.k)) continue;
      let minEx = null, ok = true;
      for (const p of parts) {
        const m = p.fs.find(g => (g.t === 'pow' ? g.b : g).k === b.k);
        if (!m) { ok = false; break; }
        const ee = m.t === 'pow' ? m.e : ONE;
        if (minEx === null) minEx = ee;
        else if (ee.t === 'num' && minEx.t === 'num') { if (qcmp(ee, minEx) < 0) minEx = ee; }
        else if (ee.k !== minEx.k) { ok = false; break; }
      }
      if (ok) picked.push({ b, ex: minEx });
    }
    const factor = mulArr([NUM(mkq(gn, ld))].concat(picked.map(p => pow(p.b, p.ex))), 0);
    if (isOne(factor)) return e;
    const inv = pow(factor, MINUS_ONE);
    return mulArr([factor, addArr(terms.map(t => mulArr([t, inv], 0)))], 0);
  }

  /* ═════════════════════ equality by simplification and sampling ═════════════════════ */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const DEFAULT_WINDOWS = [[0.15, 2.5], [-2.5, -0.15], [0.6, 5], [-0.9, 0.9], [-5, 5], [1.1, 8], [-8, -1.1]];
  /* f and g take nvars numbers. Compares them at random points where both are finite.
     opts: { points (default 30), minValid (8), tol (1e-8 relative), seed, windows } */
  function sampleCompare(f, g, nvars, opts) {
    opts = opts || {};
    const want = opts.points || 30, tol = opts.tol || 1e-8, rnd = mulberry32(opts.seed || 20240607), wins = opts.windows || DEFAULT_WINDOWS;
    const minValid = nvars === 0 ? 1 : (opts.minValid || 8);
    let valid = 0, tried = 0, maxErr = 0;
    const maxTries = nvars === 0 ? 1 : want * 12;
    while (valid < want && tried < maxTries) {
      const pt = [];
      for (let i = 0; i < nvars; i++) { const w = wins[(tried + 3 * i) % wins.length]; pt.push(w[0] + (w[1] - w[0]) * rnd()); }
      tried++;
      const a = f.apply(null, pt), b = g.apply(null, pt);
      if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 1e12 || Math.abs(b) > 1e12) continue;
      valid++;
      const err = Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
      if (err > maxErr) maxErr = err;
      if (err > tol) return { ok: false, valid, tried, maxErr, point: pt };
    }
    return { ok: valid >= minValid, valid, tried, maxErr };
  }
  function equalSymbolic(a, b) {
    a = toExpr(a); b = toExpr(b);
    if (a.k === b.k) return true;
    const d = sub(a, b);
    if (isZero(d)) return true;
    const x = expand(d);
    return isZero(x) || isZero(simplify(x));
  }
  function equal(a, b, opts) {
    a = toExpr(a); b = toExpr(b);
    if (equalSymbolic(a, b)) return true;
    const vars = unionNames([varSet(a), varSet(b)]);
    let fa, fb;
    try { fa = compile(a, vars); fb = compile(b, vars); } catch (err) { return false; }
    return sampleCompare(fa, fb, vars.length, opts).ok;
  }

  /* ═════════════════════ polynomials ═════════════════════ */

  function polyCoeffs(e, v) {               // [c0, c1, ...] of Exprs not containing v, or null
    e = expand(toExpr(e));
    const terms = e.t === 'add' ? e.args : [e];
    const by = [];
    for (const t of terms) {
      let k = 0;
      const cf = [];
      for (const f of (t.t === 'mul' ? t.args : [t])) {
        if (f.t === 'sym' && f.name === v) k += 1;
        else if (f.t === 'pow' && f.b.t === 'sym' && f.b.name === v && f.e.t === 'num' && f.e.d === 1n && f.e.n > 0n) k += Number(f.e.n);
        else if (dependsOn(f, v)) return null;
        else cf.push(f);
      }
      (by[k] = by[k] || []).push(mulArr(cf, 0));
    }
    const out = [];
    for (let i = 0; i < by.length; i++) out.push(by[i] ? addArr(by[i]) : ZERO);
    while (out.length > 1 && isZero(out[out.length - 1])) out.pop();
    return out.length ? out : [ZERO];
  }
  function polyFromCoeffs(cs, v) {
    const x = SYM(v);
    return addArr(cs.map((c, i) => mulArr([toExpr(c), pow(x, NUM(qInt(i)))], 0)));
  }

  const pTrim = p => { let n = p.length; while (n > 1 && p[n - 1].n === 0n) n--; return n === p.length ? p : p.slice(0, n); };
  const pDeg = p => (p.length === 1 && p[0].n === 0n ? -1 : p.length - 1);
  function pAdd(a, b) { const n = Math.max(a.length, b.length), r = []; for (let i = 0; i < n; i++) r.push(qadd(a[i] || ZEROQ, b[i] || ZEROQ)); return pTrim(r); }
  function pSub(a, b) { const n = Math.max(a.length, b.length), r = []; for (let i = 0; i < n; i++) r.push(qsub(a[i] || ZEROQ, b[i] || ZEROQ)); return pTrim(r); }
  function pMul(a, b) {
    if (pDeg(a) < 0 || pDeg(b) < 0) return [ZEROQ];
    const r = new Array(a.length + b.length - 1).fill(ZEROQ);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] = qadd(r[i + j], qmul(a[i], b[j]));
    return pTrim(r);
  }
  const pScale = (a, c) => pTrim(a.map(x => qmul(x, c)));
  function pDivMod(a, b) {
    const db = pDeg(b);
    if (db < 0) throw new Error('division by the zero polynomial');
    let r = a.slice(), q = new Array(Math.max(a.length - b.length + 1, 1)).fill(ZEROQ);
    while (pDeg(r) >= db) {
      const k = pDeg(r) - db, c = qdiv(r[r.length - 1], b[b.length - 1]);
      q[k] = c;
      const sh = new Array(k).fill(ZEROQ).concat(b.map(x => qmul(x, c)));
      r = pSub(r, sh);
      if (pDeg(r) < 0) break;
    }
    return { q: pTrim(q), r: pTrim(r) };
  }
  function pMonic(a) { return pDeg(a) < 0 ? a : pScale(a, qinv(a[a.length - 1])); }
  function pGcd(a, b) {
    a = pTrim(a); b = pTrim(b);
    while (pDeg(b) >= 0) { const r = pDivMod(a, b).r; a = b; b = r; }
    return pMonic(a);
  }
  const pDeriv = a => (a.length <= 1 ? [ZEROQ] : pTrim(a.slice(1).map((c, i) => qmul(c, qInt(i + 1)))));
  function pToExpr(p, v) { return polyFromCoeffs(p.map(NUM), v); }
  function polyQ(e, v) {
    const cs = polyCoeffs(e, v);
    if (!cs || !cs.every(isNum)) return null;
    return cs.map(c => ({ n: c.n, d: c.d }));
  }
  function toPrimitive(p) {                 // p = content * prim, prim has integer coefficients, gcd 1, positive leading coefficient
    let L = 1n;
    for (const c of p) L = L / bgcd(L, c.d) * c.d;
    const ints = p.map(c => c.n * (L / c.d));
    let g = 0n;
    for (const c of ints) g = bgcd(g, c);
    if (g === 0n) return { prim: [ZEROQ], content: ZEROQ };
    const sign = ints[ints.length - 1] < 0n ? -1n : 1n;
    return { prim: ints.map(c => ({ n: sign * c / g, d: 1n })), content: mkq(sign * g, L) };
  }

  function divisorsOf(n) {                  // all positive divisors of a positive BigInt, or null if n is too large to factor quickly
    if (n > 4000000000000n) return null;
    const x = Number(n), out = [];
    for (let i = 1; i * i <= x; i++) if (x % i === 0) { out.push(BigInt(i)); if (i * i !== x) out.push(BigInt(x / i)); }
    return out;
  }
  function evalInt(p, num, den) {           // p integer polynomial at num/den, scaled: sum a_i num^i den^(n-i)
    let s = 0n;
    const n = p.length - 1;
    for (let i = 0; i <= n; i++) s += p[i].n * num ** BigInt(i) * den ** BigInt(n - i);
    return s;
  }
  function findRationalRoot(p) {
    const a0 = babs(p[0].n), an = babs(p[p.length - 1].n);
    const dp = divisorsOf(a0), dq = divisorsOf(an);
    if (!dp || !dq || dp.length * dq.length > 20000) return null;
    dp.sort((a, b) => (a < b ? -1 : 1)); dq.sort((a, b) => (a < b ? -1 : 1));
    for (const q0 of dq) for (const p0 of dp) {
      if (bgcd(p0, q0) !== 1n) continue;
      if (evalInt(p, p0, q0) === 0n) return { num: p0, den: q0 };
      if (evalInt(p, -p0, q0) === 0n) return { num: -p0, den: q0 };
    }
    return null;
  }
  function kroneckerQuad(R) {               // an integer quadratic divisor of R, or null
    const at = x => { let s = 0n; for (let i = R.length - 1; i >= 0; i--) s = s * x + R[i].n; return s; };
    const v0 = at(0n), v1 = at(1n), vm = at(-1n);
    if (v0 === 0n || v1 === 0n || vm === 0n) return null;
    const d0 = divisorsOf(babs(v0)), d1 = divisorsOf(babs(v1)), dm = divisorsOf(babs(vm));
    if (!d0 || !d1 || !dm || d0.length * d1.length * dm.length > 60000) return null;
    const sg = l => l.concat(l.map(x => -x));
    for (const c of sg(d0)) for (const s of sg(d1)) for (const t of sg(dm)) {
      if ((s + t) % 2n !== 0n) continue;
      const a = (s + t) / 2n - c, b = (s - t) / 2n;
      if (a === 0n) continue;
      let g = [qInt(0), qInt(0), qInt(0)];
      g = [{ n: c, d: 1n }, { n: b, d: 1n }, { n: a, d: 1n }];
      const { prim } = toPrimitive(g);
      if (pDeg(prim) !== 2) continue;
      if (pDivMod(R, prim).r.every(x => x.n === 0n)) return prim;
    }
    return null;
  }
  function factorQ(p) {                     // over the rationals: p = content * prod(factor^mult), factors primitive integer polynomials
    p = pTrim(p);
    const { prim, content } = toPrimitive(p);
    let R = prim, complete = true;
    const factors = [];
    const push = (f, m) => { if (m > 0) factors.push({ p: f, mult: m }); };
    if (pDeg(R) < 1) return { content: qmul(content, R[0]), factors, complete };
    let zeros = 0;
    while (R.length > 1 && R[0].n === 0n) { R = R.slice(1); zeros++; }
    push([ZEROQ, ONEQ], zeros);
    while (pDeg(R) >= 1) {
      const root = findRationalRoot(R);
      if (!root) break;
      const f = [{ n: -root.num, d: 1n }, { n: root.den, d: 1n }];
      let m = 0;
      for (;;) { const dm = pDivMod(R, f); if (!dm.r.every(x => x.n === 0n)) break; R = toPrimitive(dm.q).prim; m++; }
      push(f, m);
    }
    while (pDeg(R) >= 4) {
      const g = kroneckerQuad(R);
      if (!g) break;
      let m = 0;
      for (;;) { const dm = pDivMod(R, g); if (!dm.r.every(x => x.n === 0n)) break; R = toPrimitive(dm.q).prim; m++; }
      push(g, m);
    }
    if (pDeg(R) >= 1) { push(R, 1); if (pDeg(R) >= 6) complete = false; }
    factors.sort((a, b) => pDeg(a.p) - pDeg(b.p));
    return { content, factors, complete };
  }
  function factorPoly(e, v) {
    const p = polyQ(e, v);
    if (!p || pDeg(p) < 0) return null;
    const r = factorQ(p);
    return { content: NUM(r.content), complete: r.complete, factors: r.factors.map(f => ({ poly: pToExpr(f.p, v), mult: f.mult, degree: pDeg(f.p) })) };
  }
  function polyDivide(num, den, v) {
    const a = polyQ(toExpr(num), v), b = polyQ(toExpr(den), v);
    if (!a || !b || pDeg(b) < 0) return null;
    const r = pDivMod(a, b);
    return { q: pToExpr(r.q, v), r: pToExpr(r.r, v) };
  }
  function polyGcd(a, b, v) {
    const pa = polyQ(toExpr(a), v), pb = polyQ(toExpr(b), v);
    if (!pa || !pb) return null;
    return pToExpr(pGcd(pa, pb), v);
  }

  function solveLinear(rows, nvars) {       // rows: arrays of nvars+1 fractions (augmented). Returns the solution or null.
    const m = rows.map(r => r.slice());
    let rank = 0;
    const piv = [];
    for (let c = 0; c < nvars && rank < m.length; c++) {
      let p = -1;
      for (let r = rank; r < m.length; r++) if (m[r][c].n !== 0n) { p = r; break; }
      if (p < 0) continue;
      [m[rank], m[p]] = [m[p], m[rank]];
      const inv = qinv(m[rank][c]);
      m[rank] = m[rank].map(x => qmul(x, inv));
      for (let r = 0; r < m.length; r++) if (r !== rank && m[r][c].n !== 0n) {
        const f = m[r][c];
        m[r] = m[r].map((x, j) => qsub(x, qmul(f, m[rank][j])));
      }
      piv.push(c); rank++;
    }
    if (rank < nvars) return null;
    for (let r = rank; r < m.length; r++) if (m[r][nvars].n !== 0n) return null;
    const sol = new Array(nvars).fill(ZEROQ);
    piv.forEach((c, i) => { sol[c] = m[i][nvars]; });
    return sol;
  }

  /* num/den as polynomials in v with rational coefficients -> polynomial part + sum of A/(f^j) pieces.
     Each term is {factor, power, num, degree, name(s)}; template and values let a page show the working. */
  function partialFractions(num, den, v) {
    const N = polyQ(toExpr(num), v), Dp = polyQ(toExpr(den), v);
    if (!N || !Dp || pDeg(Dp) < 1) return null;
    const dm = pDivMod(N, Dp);
    const fac = factorQ(Dp);
    if (!fac.complete) return null;
    let Dprime = [ONEQ];
    fac.factors.forEach(f => { for (let i = 0; i < f.mult; i++) Dprime = pMul(Dprime, f.p); });
    const R = pScale(dm.r, qinv(fac.content));        // r/D = R/D'
    const basis = [];                       // {fi, j, s, poly}
    fac.factors.forEach((f, fi) => {
      for (let j = 1; j <= f.mult; j++) {
        let other = [ONEQ];
        fac.factors.forEach((g, gi) => { const m = gi === fi ? g.mult - j : g.mult; for (let i = 0; i < m; i++) other = pMul(other, g.p); });
        for (let s = 0; s < pDeg(f.p); s++) basis.push({ fi, j, s, poly: pMul(other, new Array(s).fill(ZEROQ).concat([ONEQ])) });
      }
    });
    const nv = basis.length, deg = pDeg(Dprime);
    if (nv !== deg) return null;
    const rows = [];
    for (let i = 0; i < deg; i++) rows.push(basis.map(b => b.poly[i] || ZEROQ).concat([R[i] || ZEROQ]));
    const sol = solveLinear(rows, nv);
    if (!sol) return null;
    const used = new Set(varSet(toExpr(num)).concat(varSet(toExpr(den)), [v]));
    const names = [];
    for (let c = 65; names.length < nv && c < 91; c++) if (!used.has(String.fromCharCode(c))) names.push(String.fromCharCode(c));
    const terms = [], tmpl = [];
    fac.factors.forEach((f, fi) => {
      for (let j = 1; j <= f.mult; j++) {
        const cs = [], nm = [];
        for (let s = 0; s < pDeg(f.p); s++) { const bi = basis.findIndex(b => b.fi === fi && b.j === j && b.s === s); cs.push(sol[bi]); nm.push(SYM(names[bi] || '?')); }
        const fe = pToExpr(f.p, v), fp = pow(fe, NUM(qInt(j)));
        tmpl.push({ factor: fe, power: j, template: polyFromCoeffs(nm, v), unknowns: nm.map(x => x.name) });
        if (cs.every(c => c.n === 0n)) continue;
        terms.push({ factor: fe, power: j, num: pToExpr(cs, v), degree: pDeg(f.p), expr: div(pToExpr(cs, v), fp) });
      }
    });
    const values = {};
    names.forEach((nme, i) => { values[nme] = NUM(sol[i]); });
    return { poly: pToExpr(dm.q, v), remainder: pToExpr(dm.r, v), content: NUM(fac.content), factors: fac.factors.map(f => ({ poly: pToExpr(f.p, v), mult: f.mult, degree: pDeg(f.p) })),
             terms, template: tmpl, values, unknownNames: names, Dprime: pToExpr(Dprime, v) };
  }


  return {
    parse, tryParse, parseWithNotes, ParseError, toString, str: toString,
    num, sym, add, mul, pow, neg, sub, div, fn, sqrt, exp, ln, PI, E, ZERO, ONE, MINUS_ONE,
    isNum, isZero, isOne, isInteger, isNegNum,
    simplify, canon, expand, together, factorCommon, diff, diffSteps, evalNum, compile, subst, replace,
    freeVars, dependsOn, equal, equalSymbolic, sampleCompare,
    polyCoeffs, polyFromCoeffs, polyDivide, polyGcd, factorPoly, partialFractions,
    Q: { mkq, qadd, qsub, qmul, qdiv, qneg, qinv, qcmp, qeq, qsign, qnum, qstr, qpow, qInt, ONEQ, ZEROQ },
    FN_LABEL, KNOWN_FN
  };
});
