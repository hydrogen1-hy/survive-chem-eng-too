/*
 * Double and triple integrals, built on CAS (js/cas.js) and Integrate (js/integrate.js).
 * Plain deterministic code: no AI, no network, no lookup of answers, no DOM. Works in the browser (window.Multi) and in Node.
 *
 * WHAT IT DOES
 *   You give the integrand f and the limits of every variable, innermost first, exactly as you would write the iterated
 *   integral on paper. The integral is done one variable at a time with Integrate.definite, so every step has its own
 *   rule-by-rule working. Four coordinate systems are supported:
 *       cartesian    x, y (and z)                 dA = dy dx, dV = dz dy dx (any order)
 *       polar        r, theta                     x = r cos(theta), y = r sin(theta)                    dA = r dr dtheta
 *       cylindrical  r, theta, z                  x = r cos(theta), y = r sin(theta), z = z             dV = r dz dr dtheta
 *       spherical    rho, phi, theta              x = rho sin(phi) cos(theta), y = rho sin(phi) sin(theta), z = rho cos(phi)
 *                                                                                                       dV = rho^2 sin(phi) drho dphi dtheta
 *   In the other systems f may be typed in x, y, z (it is converted, and the factor r or rho^2 sin(phi) is added) or in
 *   the new variables. f is always the function being integrated over the area or volume: the Jacobian is added by this
 *   library, you never type it.
 *
 * HOW AN ANSWER IS CHECKED
 *   The exact value comes from the antiderivatives. It is then compared with a completely separate number: the same
 *   iterated integral done by nested adaptive quadrature of the ORIGINAL f (in x, y, z), composed with the coordinate
 *   map and multiplied by the Jacobian, so a mistake in the conversion, the tidying or the integration shows up as a
 *   disagreement. If they disagree only the numeric value is shown. Symbols other than the coordinates (a radius R, say)
 *   are treated as positive constants and the check is made at two sample values of them.
 *
 * API
 *   Multi.solve(spec, opts) -> { ok, kind:'exact'|'numeric'|'none', exact (Expr)|null, exactNumber, numeric, numericError,
 *        agree (true|false|null), system, dim, order[], setup[], integrand (Expr, as typed), converted (Expr)|null,
 *        conversion {map[], jacobian, element, converted, typedInNew}|null, levels[], params[], notes[], warnings[],
 *        problems[] ({field, message, pos?, end?}), message }
 *     spec: { system:'cartesian'|'polar'|'cylindrical'|'spherical', dim:2|3 (cartesian only), f: text|Expr,
 *             order: [{v, lower, upper}, ...]  innermost first; limits are text, numbers or Exprs ('inf' allowed) }
 *     Each level: { v, role:'inner'|'middle'|'outer', lower, upper, integrand (Expr), ok, kind, result (Expr)|null,
 *                   steps[] (Integrate's step list), evaluation[], issues[], warnings[], message }
 *   Multi.geometry(spec, opts) -> { dim, kind:'region'|'solid', runs[] | lines[], bbox, clipped, problems[] }  (for plots)
 *        region: runs[] of { ok, lower[], upper[], polygon[], sweeps[] }  (ok:false where the lower limit is above the upper)
 *        solid:  lines[] of { kind:'lo'|'hi'|'side', pts:[[x,y,z],...] }, bbox { lo[], hi[] }
 *   Multi.reverse(spec) -> { ok, pieces:[{order:[inner, outer]}], message }   the same region with the order swapped (Cartesian, two variables)
 *   Multi.solveReversed(spec) -> { ok, kind, exact, exactNumber, pieces:[{order, result}], agree, message }
 *   Multi.applications(spec, wanted[]) -> { size, average, centroid } results (each a solve() result or derived values)
 *   Multi.defaultOrder(system, dim), Multi.EXAMPLES, Multi.SYSTEMS, Multi.tidy(expr), Multi.toXYZ(system, values)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var mod = module, cas = typeof require === 'function' ? require('./cas.js') : root.CAS;
    module = mod;                           // the stand-in test runner swaps the global `module` while it loads a dependency
    var integ = typeof require === 'function' ? require('./integrate.js') : root.Integrate;
    module = mod;
    mod.exports = factory(cas, integ);
  } else root.Multi = factory(root.CAS, root.Integrate);
})(typeof self !== 'undefined' ? self : this, function (CAS, Integrate) {
  'use strict';

  const { add, mul, pow, fn, sym, num } = CAS;
  const GREEK = { theta: 'θ', rho: 'ρ', phi: 'φ' };
  const S = e => CAS.toString(e).replace(/\b(theta|rho|phi)\b/g, m => GREEK[m]);
  const nice = v => GREEK[v] || v;
  const boundText = b => (b === Infinity ? '∞' : b === -Infinity ? '−∞' : S(b));
  const cos = a => fn('cos', a), sin = a => fn('sin', a);
  const TH = sym('theta'), R = sym('r'), RHO = sym('rho'), PHI = sym('phi'), Z = sym('z');

  /* ═════════════════════ coordinate systems ═════════════════════ */

  const SYSTEM_NAMES = ['cartesian', 'polar', 'cylindrical', 'spherical'];
  const DEFAULT_ORDER = { polar: ['r', 'theta'], cylindrical: ['z', 'r', 'theta'], spherical: ['rho', 'phi', 'theta'] };
  function defaultOrder(system, dim) { return system === 'cartesian' ? (dim === 3 ? ['z', 'y', 'x'] : ['y', 'x']) : DEFAULT_ORDER[system].slice(); }

  function coords(name, dim) {
    switch (name) {
      case 'polar':
        return { name, dim: 2, vars: ['r', 'theta'], map: { x: mul(R, cos(TH)), y: mul(R, sin(TH)) }, jac: R, jacText: 'r',
          mapText: ['x = r cos θ', 'y = r sin θ'], element: 'dA = r dr dθ' };
      case 'cylindrical':
        return { name, dim: 3, vars: ['r', 'theta', 'z'], map: { x: mul(R, cos(TH)), y: mul(R, sin(TH)), z: Z }, jac: R, jacText: 'r',
          mapText: ['x = r cos θ', 'y = r sin θ', 'z = z'], element: 'dV = r dz dr dθ' };
      case 'spherical':
        return { name, dim: 3, vars: ['rho', 'phi', 'theta'],
          map: { x: mul(RHO, sin(PHI), cos(TH)), y: mul(RHO, sin(PHI), sin(TH)), z: mul(RHO, cos(PHI)) },
          jac: mul(pow(RHO, num(2)), sin(PHI)), jacText: 'ρ² sin φ',
          mapText: ['x = ρ sin φ cos θ', 'y = ρ sin φ sin θ', 'z = ρ cos φ'], element: 'dV = ρ² sin φ dρ dφ dθ' };
      default:
        return { name: 'cartesian', dim, vars: dim === 3 ? ['x', 'y', 'z'] : ['x', 'y'], map: null, jac: null, jacText: '', mapText: [], element: '' };
    }
  }

  /* a point of the region in Cartesian coordinates, from the values of the coordinates (an object name -> number) */
  function toXYZ(system, v) {
    switch (system) {
      case 'polar': return [v.r * Math.cos(v.theta), v.r * Math.sin(v.theta), 0];
      case 'cylindrical': return [v.r * Math.cos(v.theta), v.r * Math.sin(v.theta), v.z];
      case 'spherical': return [v.rho * Math.sin(v.phi) * Math.cos(v.theta), v.rho * Math.sin(v.phi) * Math.sin(v.theta), v.rho * Math.cos(v.phi)];
      default: return [v.x, v.y, v.z === undefined ? 0 : v.z];
    }
  }
  function jacobianNumber(system, v) {
    switch (system) {
      case 'polar': case 'cylindrical': return v.r;
      case 'spherical': return v.rho * v.rho * Math.sin(v.phi);
      default: return 1;
    }
  }

  /* ═════════════════════ tidying converted integrands ═════════════════════ */

  const size = e => { switch (e.t) { case 'add': case 'mul': { let s = 1; for (const a of e.args) s += size(a); return s; } case 'pow': return 1 + size(e.b) + size(e.e); case 'fn': return 1 + size(e.a); default: return 1; } };
  function mapTree(e, f) {
    switch (e.t) {
      case 'add': return f(add(...e.args.map(a => mapTree(a, f))));
      case 'mul': return f(mul(...e.args.map(a => mapTree(a, f))));
      case 'pow': return f(pow(mapTree(e.b, f), mapTree(e.e, f)));
      case 'fn': return f(fn(e.name, mapTree(e.a, f)));
      default: return f(e);
    }
  }
  /* In a sum, merge pairs of terms that collapse with the Pythagorean identity once their common factor is taken out:
     r²cos²θ + r²sin²θ → r², and then ρ² sin²φ + ρ² cos²φ → ρ². */
  function mergePairs(node) {
    if (node.t !== 'add') return node;
    let terms = node.args.slice(), again = true;
    while (again && terms.length > 1) {
      again = false;
      for (let i = 0; i < terms.length && !again; i++) {
        for (let j = i + 1; j < terms.length && !again; j++) {
          const pair = add(terms[i], terms[j]);
          const m = CAS.simplify(CAS.factorCommon(pair));
          if (size(m) < size(terms[i]) + size(terms[j])) {
            terms = terms.filter((_, k) => k !== i && k !== j); terms.push(m); again = true;
          }
        }
      }
    }
    return add(...terms);
  }
  /* The radius r, rho and sin(phi) (phi between 0 and pi) are never negative, so |r| is r. */
  function dropAbs(node) {
    if (node.t === 'fn' && node.name === 'abs') {
      const a = node.a;
      if (a.t === 'sym' && (a.name === 'r' || a.name === 'rho')) return a;
      if (a.t === 'fn' && a.name === 'sin' && a.a.t === 'sym' && a.a.name === 'phi') return a;
    }
    return node;
  }
  function tidy(e) {
    let t = CAS.simplify(e);
    for (let i = 0; i < 3; i++) {
      const u = CAS.simplify(mapTree(mapTree(t, mergePairs), dropAbs));
      if (u.k === t.k) break;
      t = u;
    }
    return t;
  }

  /* ═════════════════════ reading and checking the specification ═════════════════════ */

  function prepare(spec) {
    spec = spec || {};
    const problems = [];
    const sysName = SYSTEM_NAMES.indexOf(spec.system) >= 0 ? spec.system : 'cartesian';
    const dim = sysName === 'cartesian' ? (spec.dim === 3 ? 3 : 2) : sysName === 'polar' ? 2 : 3;
    const sys = coords(sysName, dim);
    const notes = [];

    const readExpr = (text, field, what) => {
      if (text !== null && typeof text === 'object') return text;
      if (text === undefined || text === null || !String(text).trim()) { problems.push({ field, message: 'Give ' + what + '.' }); return null; }
      try { return CAS.parse(String(text)); }
      catch (e) { if (e instanceof CAS.ParseError) { problems.push({ field, message: e.message, pos: e.pos, end: e.end }); return null; } throw e; }
    };
    const readBound = (text, field, what) => {
      if (typeof text === 'number') return isFinite(text) ? num(text) : text;
      if (text !== null && typeof text === 'object') return text;
      if (text === undefined || text === null || !String(text).trim()) { problems.push({ field, message: 'Give ' + what + '.' }); return null; }
      try { return Integrate.parseBound(String(text)); }
      catch (e) { if (e instanceof CAS.ParseError) { problems.push({ field, message: e.message, pos: e.pos, end: e.end }); return null; } throw e; }
    };

    /* the order */
    const given = Array.isArray(spec.order) ? spec.order : [];
    const names = given.map(o => String(o.v));
    const sorted = names.slice().sort().join(','), want = sys.vars.slice().sort().join(',');
    if (sorted !== want) problems.push({ field: 'order', message: 'The variables to integrate over are ' + sys.vars.map(nice).join(', ') + ', each once.' });

    const f = readExpr(spec.f, 'f', 'the function to integrate');
    const order = given.map((o, k) => {
      const v = String(o.v), outer = names.slice(k + 1);
      const lower = readBound(o.lower, 'lower:' + v, 'the lower limit of ' + nice(v));
      const upper = readBound(o.upper, 'upper:' + v, 'the upper limit of ' + nice(v));
      [['lower', lower], ['upper', upper]].forEach(p => {
        if (p[1] === null || typeof p[1] === 'number') return;
        const bad = CAS.freeVars(p[1]).filter(n => sys.vars.indexOf(n) >= 0 && outer.indexOf(n) < 0);
        if (bad.length) {
          problems.push({ field: p[0] + ':' + v, message: 'The ' + p[0] + ' limit of ' + nice(v) + ' contains ' + bad.map(nice).join(', ') +
            (outer.length ? '. A limit can only use the variables that are integrated after it (' + outer.map(nice).join(', ') + ').' : '. The outermost limits must be numbers.') });
        }
      });
      return { v, lower, upper };
    });
    if (problems.length) return { problems };

    /* conversion */
    let fConv = f, conversion = null;
    if (sys.map) {
      const used = CAS.freeVars(f), oldNames = Object.keys(sys.map).filter(n => !(n === 'z' && sys.name === 'cylindrical'));
      const typedInOld = used.some(n => oldNames.indexOf(n) >= 0);
      const typedInNew = used.some(n => sys.vars.indexOf(n) >= 0 && !(n === 'z' && sys.name === 'cylindrical'));
      const sub = CAS.subst(f, sys.map);
      fConv = tidy(mul(sub, sys.jac));
      conversion = { map: sys.mapText, jacobian: sys.jacText, element: sys.element, converted: fConv, typedInOld, typedInNew,
        substituted: typedInOld ? tidy(sub) : null };
      if (typedInOld && typedInNew) notes.push('The function uses both x, y, z and ' + sys.vars.map(nice).join(', ') + '. x, y, z are converted and the others are kept as they are.');
    } else fConv = CAS.simplify(f);

    const coordSet = sys.vars;
    const all = {};
    CAS.freeVars(fConv).forEach(n => { all[n] = 1; });
    order.forEach(o => [o.lower, o.upper].forEach(b => { if (b !== null && typeof b === 'object' && b.t) CAS.freeVars(b).forEach(n => { all[n] = 1; }); }));
    const params = Object.keys(all).filter(n => coordSet.indexOf(n) < 0).sort();
    const many = params.length > 1;
    if (params.length) notes.push((many ? 'The symbols ' : 'The symbol ') + params.join(', ') + (many ? ' are not coordinates, so they are treated as positive constants' : ' is not a coordinate, so it is treated as a positive constant') + '. The answer is a formula in ' + (many ? 'them' : 'it') + ', and the numeric check is made at sample values.');

    return { problems, ctx: { sys, sysName, dim, order, f, fConv, conversion, params, notes } };
  }

  /* ═════════════════════ numerics: nested quadrature and scans ═════════════════════ */

  const PARAM_SETS = [[3 / 2, 7 / 4, 5 / 3, 9 / 5, 11 / 7, 13 / 8], [5 / 4, 8 / 3, 7 / 5, 13 / 6, 3 / 2, 17 / 9]];
  const ratio = x => { for (let q = 1; q <= 20; q++) { const p = Math.round(x * q); if (Math.abs(p / q - x) < 1e-12) return num(p, q); } return num(x); };
  function paramValues(params, setIndex) {
    const pv = {};
    params.forEach((n, i) => { pv[n] = ratio(PARAM_SETS[setIndex % PARAM_SETS.length][i % 6]); });
    return pv;
  }

  /* compiled bounds and integrand of the ORIGINAL problem, with the parameters fixed */
  function numerics(ctx, pv) {
    const names = ctx.order.map(o => o.v);
    const fix = e => (ctx.params.length ? CAS.subst(e, pv) : e);
    const bound = b => { if (typeof b === 'number') return () => b; const g = fix(b); const c = CAS.compile(g, names); return c; };
    const lof = ctx.order.map(o => bound(o.lower)), hif = ctx.order.map(o => bound(o.upper));
    const sys = ctx.sys, mapNames = sys.map ? Object.keys(sys.map) : [];
    const fo = CAS.compile(fix(ctx.f), names.concat(mapNames));
    const n = names.length;
    const F = vals => {
      const d = {};
      for (let i = 0; i < n; i++) d[names[i]] = vals[i];
      if (!sys.map) return fo.apply(null, vals);
      const p = toXYZ(ctx.sysName, d);
      const args = vals.slice(0, n);
      for (let i = 0; i < mapNames.length; i++) args.push(p['xyz'.indexOf(mapNames[i])]);
      return fo.apply(null, args) * jacobianNumber(ctx.sysName, d);
    };
    return { F, lof, hif, n, names };
  }

  const BAD = { bad: true }, TIMEOUT = { timeout: true };
  /* soft: a limit that is NaN counts as an empty interval. That is only right for rounding at the very ends of a region
     (1 - x^2 - y^2 = -1e-17), so it is used only when the scan of the limits found no real hole. */
  function nested(nm, maxMs, soft) {
    const vals = new Array(nm.n).fill(NaN), t0 = Date.now();
    let allOk = true, evals = 0;
    const level = k => {
      const lo = nm.lof[k].apply(null, vals), hi = nm.hif[k].apply(null, vals);
      if (lo !== lo || hi !== hi) { if (soft) return { value: 0, error: 0 }; throw BAD; }
      if (lo === hi) return { value: 0, error: 0 };
      const q = Integrate.quad(t => {
        vals[k] = t;
        if ((++evals & 255) === 0 && Date.now() - t0 > maxMs) throw TIMEOUT;
        return k === 0 ? nm.F(vals) : level(k - 1).value;
      }, lo, hi, { tol: 1e-9 });
      if (!q.ok) allOk = false;
      return q;
    };
    try { const q = level(nm.n - 1); return { value: q.value, error: q.error, ok: allOk && isFinite(q.value) }; }
    catch (e) {
      if (e === TIMEOUT) return { value: NaN, error: Infinity, ok: false, why: 'the numerical check took too long' };
      if (e === BAD) return { value: NaN, error: Infinity, ok: false, why: 'a limit is not a real number somewhere in the region' };
      throw e;
    }
  }

  /* Look for places inside the region where a lower limit is above its upper limit, or a limit is undefined.
     Only interior points are sampled, so rounding at the edges of the region is not mistaken for a hole.
     Returns { texts, undefinedInside }. */
  function scanLimits(ctx, nm) {
    const out = [], n = nm.n, vals = new Array(n).fill(NaN), M = n === 3 ? 8 : 40;
    const inverted = {}, undef = {};
    const walk = k => {
      const lo = nm.lof[k].apply(null, vals), hi = nm.hif[k].apply(null, vals), top = n - 1;
      const where = k === top ? null : vals[top];
      if (lo !== lo || hi !== hi) { (undef[k] = undef[k] || []).push(where); return; }
      if (lo > hi + 1e-12 * Math.max(1, Math.abs(lo), Math.abs(hi))) (inverted[k] = inverted[k] || []).push(where);
      if (k === 0 || !isFinite(lo) || !isFinite(hi)) return;
      for (let j = 0; j < M; j++) { vals[k] = lo + (hi - lo) * (j + 0.5) / M; walk(k - 1); }
    };
    try { walk(n - 1); } catch (e) { return { texts: out, undefinedInside: false }; }
    const range = a => { const xs = a.filter(x => x !== null && isFinite(x)); return xs.length ? [Math.min.apply(null, xs), Math.max.apply(null, xs)] : null; };
    const fmt = x => String(Number(x.toPrecision(4)));
    ctx.order.forEach((o, k) => {
      const topName = nice(ctx.order[n - 1].v);
      if (inverted[k]) {
        const r = range(inverted[k]);
        out.push('For ' + (r ? topName + (r[0] === r[1] ? ' = ' + fmt(r[0]) : ' from about ' + fmt(r[0]) + ' to ' + fmt(r[1])) : 'some values') + ' the lower limit of ' + nice(o.v) +
          ' is above its upper limit, so that part of the integral counts with a negative sign. If you meant the region between the curves, the limits are in the wrong order or the region is not what you intended (compare with the picture).');
      }
      if (undef[k]) {
        const r = range(undef[k]);
        out.push('A limit of ' + nice(o.v) + ' is not a real number for ' + (r ? topName + ' from about ' + fmt(r[0]) + ' to ' + fmt(r[1]) : 'some values') + ' (for example a square root of a negative number). The integral is not defined there.');
      }
    });
    return { texts: out, undefinedInside: Object.keys(undef).length > 0 };
  }

  /* ═════════════════════ solving ═════════════════════ */

  const ROLE = ['inner', 'middle', 'outer'];
  const roleOf = (k, n) => (n === 2 ? ['inner', 'outer'][k] : ROLE[k]);
  const GENERIC = /contain other variables/;

  function solve(spec, opts) {
    opts = opts || {};
    const P = prepare(spec);
    const base = { ok: false, kind: 'none', exact: null, exactNumber: null, numeric: null, numericError: null, agree: null, levels: [], notes: [], warnings: [], problems: [], message: '', params: [] };
    if (P.problems.length) return Object.assign(base, { problems: P.problems, message: P.problems[0].message });
    const ctx = P.ctx, n = ctx.order.length;
    const res = Object.assign(base, {
      system: ctx.sysName, dim: ctx.dim, order: ctx.order.map(o => o.v), params: ctx.params, notes: ctx.notes.slice(),
      integrand: ctx.f, converted: ctx.sys.map ? ctx.fConv : null, conversion: ctx.conversion,
      setup: ctx.order.map(o => ({ v: o.v, lower: boundText(o.lower), upper: boundText(o.upper) })).reverse()
    });

    /* exact: one variable at a time, innermost first */
    let cur = ctx.fConv, exactOk = true, failed = null;
    for (let k = 0; k < n; k++) {
      const o = ctx.order[k];
      const level = { v: o.v, role: roleOf(k, n), lower: o.lower, upper: o.upper, integrand: cur, ok: false, kind: 'none', result: null, steps: [], evaluation: [], issues: [], warnings: [], message: '' };
      res.levels.push(level);
      let d;
      try { d = Integrate.definite(cur, o.v, o.lower, o.upper, { maxMs: opts.maxMs || 5000 }); }
      catch (e) { level.message = 'This step could not be carried out (' + e.message + ').'; exactOk = false; failed = level; break; }
      level.steps = d.steps || []; level.evaluation = d.evaluation || []; level.issues = d.issues || [];
      level.warnings = (d.warnings || []).filter(w => !GENERIC.test(w));
      level.improper = !!d.improper;
      if (d.kind === 'diverges') { level.kind = 'diverges'; level.message = d.message; exactOk = false; failed = level; res.diverges = true; break; }
      if (!d.ok || d.kind !== 'exact' || !d.exact) {
        level.message = d.message || 'No exact value was found for this step.';
        exactOk = false; failed = level; break;
      }
      level.ok = true; level.kind = 'exact'; level.result = d.exact; cur = d.exact;
    }
    if (exactOk) {
      res.exact = CAS.simplify(cur);
      res.exactNumber = ctx.params.length ? null : CAS.evalNum(res.exact, {});
    }

    /* the separate numeric value, and the scan of the limits */
    let numericSets = [], scan = { texts: [], undefinedInside: false };
    try {
      const sets = ctx.params.length ? [0, 1] : [0];
      sets.forEach(si => {
        const pv = ctx.params.length ? paramValues(ctx.params, si) : {};
        const nm = numerics(ctx, pv);
        if (si === 0) scan = scanLimits(ctx, nm);
        const q = nested(nm, opts.checkMs || 4000, !scan.undefinedInside);
        let exactAt = null;
        if (exactOk) { const g = ctx.params.length ? CAS.subst(res.exact, pv) : res.exact; exactAt = CAS.evalNum(g, {}); }
        numericSets.push({ q, exactAt, pv });
      });
    } catch (e) { numericSets = []; res.warnings.push('The numerical cross-check could not be set up (' + e.message + ').'); }
    res.warnings.push.apply(res.warnings, scan.texts);
    const first = numericSets[0];
    if (first) { res.numeric = first.q.value; res.numericError = first.q.error; res.numericOk = first.q.ok; res.numericWhy = first.q.why || null; }

    if (exactOk) {
      const checked = numericSets.filter(s => s.q.ok && isFinite(s.exactAt));
      if (!checked.length) { res.agree = null; res.kind = 'exact'; res.ok = true; res.warnings.push('The numerical cross-check ' + (first && first.q.why ? 'was not possible: ' + first.q.why : 'did not converge') + ', so this value rests on the antiderivatives alone.'); }
      else {
        const bad = checked.filter(s => Math.abs(s.exactAt - s.q.value) > 1e-6 * Math.max(1, Math.abs(s.exactAt)) + 10 * s.q.error);
        res.agree = bad.length === 0;
        if (res.agree) { res.kind = 'exact'; res.ok = true; }
        else {
          const b = bad[0];
          res.kind = ctx.params.length ? 'none' : 'numeric'; res.ok = !ctx.params.length; res.exact = null;
          res.message = 'The exact value from the antiderivatives (' + b.exactAt + ') and the numerical value (' + b.q.value + ') disagree, so the exact value is not shown. This usually means an antiderivative is not valid across the whole interval (for example a limit passes through a singularity). ' +
            (ctx.params.length ? 'No value is given, because a formula in ' + ctx.params.join(', ') + ' cannot be shown without being checked.' : 'Only the numerical value is shown.');
          res.exactNumber = null;
        }
      }
    } else if (failed) {
      const sp = ctx.params.length;
      const stepName = nice(failed.v);
      const why = failed.message.replace(/^(No method found[.:]?\s*)+/, '');
      const noMethod = /^None of the rules/.test(why) || /No method found/.test(failed.message);
      res.message = failed.kind === 'diverges' ? 'The integral diverges at the ' + failed.role + ' step (' + nice(failed.v) + '). ' + failed.message
        : noMethod ? 'No method found for the ' + failed.role + ' integral (with respect to ' + stepName + '): ' + why + ' A different order of integration' + (ctx.sysName === 'cartesian' ? ' or a different coordinate system (polar, cylindrical, spherical)' : '') + ' can turn an integral with no closed form into an easy one.'
        : 'The ' + failed.role + ' integral (with respect to ' + stepName + ') could not be done exactly: ' + why;
      if (!sp && first && first.q.ok && failed.kind !== 'diverges' && !scan.undefinedInside) {
        res.kind = 'numeric'; res.ok = true;
        res.warnings.push('Only a numeric value is shown, from nested adaptive quadrature (estimated error ' + first.q.error.toExponential(1) + '). No working can be shown for it.');
      }
    }
    if (res.ok && res.kind === 'exact' && failed === null) res.message = '';
    return res;
  }

  /* ═════════════════════ geometry for the plots ═════════════════════ */

  function geometry(spec, opts) {
    opts = opts || {};
    const P = prepare(spec);
    if (P.problems.length) return { problems: P.problems, kind: 'none' };
    const ctx = P.ctx, pv = ctx.params.length ? paramValues(ctx.params, 0) : {};
    let nm;
    try { nm = numerics(ctx, pv); } catch (e) { return { problems: [{ field: 'f', message: e.message }], kind: 'none' }; }
    return ctx.order.length === 2 ? region2D(ctx, nm, opts) : solid3D(ctx, nm, opts);
  }
  const dictOf = (names, vals) => { const d = {}; names.forEach((nme, i) => { d[nme] = vals[i]; }); return d; };
  function finiteRange(a, b, span) {
    let clipped = false;
    if (!isFinite(a) && !isFinite(b)) { a = -span; b = span; clipped = true; }
    else if (!isFinite(a)) { a = b - span; clipped = true; }
    else if (!isFinite(b)) { b = a + span; clipped = true; }
    return { a, b, clipped };
  }
  function bboxOf(points, dimN) {
    const lo = new Array(dimN).fill(Infinity), hi = new Array(dimN).fill(-Infinity);
    points.forEach(p => { for (let i = 0; i < dimN; i++) if (isFinite(p[i])) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i]; } });
    return { lo, hi };
  }

  /* two variables: for each value of the outer one, a segment of the inner one */
  function region2D(ctx, nm, opts) {
    const N = opts.samples || 200, names = nm.names, vals = [NaN, NaN];
    const outer = finiteRange(nm.lof[1](vals), nm.hif[1](vals), 6);
    let clipped = outer.clipped;
    const span = Math.max(6, 3 * Math.abs(outer.b - outer.a));
    const pts = [], CAP = 48;
    for (let i = 0; i <= N; i++) {
      const u = outer.a + (outer.b - outer.a) * i / N;
      vals[1] = u; vals[0] = NaN;
      let g1 = nm.lof[0].apply(null, vals), g2 = nm.hif[0].apply(null, vals);
      if (g1 !== g1 || g2 !== g2) { pts.push(null); continue; }
      if (!isFinite(g1) || !isFinite(g2)) { const c = isFinite(g1) ? g1 : isFinite(g2) ? g2 : 0; if (!isFinite(g1)) g1 = c - span; if (!isFinite(g2)) g2 = c + span; clipped = true; }
      const mk = v => { const p = toXYZ(ctx.sysName, dictOf(names, [v, u])); return [p[0], p[1]]; };
      const cap = [];                            // the whole segment of the inner variable at this u (an arc when the inner variable is an angle)
      for (let k = 0; k <= CAP; k++) cap.push(mk(g1 + (g2 - g1) * k / CAP));
      pts.push({ ok: g1 <= g2, lower: cap[0], upper: cap[CAP], cap });
    }
    /* contiguous runs of samples with the same validity; the sample where the validity changes belongs to both runs */
    const runs = [];
    let cur = null;
    const push = (run, p) => { run.lower.push(p.lower); run.upper.push(p.upper); run.caps.push(p.cap); };
    pts.forEach((p, i) => {
      if (!p) { cur = null; return; }
      if (cur && cur.ok === p.ok) push(cur, p);
      else {
        const prev = cur;
        cur = { ok: p.ok, lower: [], upper: [], caps: [] };
        if (prev && pts[i - 1]) push(cur, pts[i - 1]);
        push(cur, p);
        runs.push(cur);
      }
    });
    /* the outline of each run: along the lower curve, across the far end, back along the upper curve, across the near end */
    runs.forEach(r => {
      const last = r.caps[r.caps.length - 1], first = r.caps[0];
      r.polygon = r.lower.concat(last.slice(1), r.upper.slice(0, -1).reverse(), first.slice(0, -1).reverse());
      r.capStart = first; r.capEnd = last;
      r.sweeps = [];                              // a few of the inner segments, to show the direction of the inner integral
      for (let j = 0; j < 7; j++) r.sweeps.push(r.caps[Math.min(r.caps.length - 1, Math.floor((j + 0.5) / 7 * r.caps.length))]);
      delete r.caps;
    });
    const all = [];
    runs.forEach(r => { r.polygon.forEach(p => all.push(p)); });
    return { kind: 'region', dim: 2, system: ctx.sysName, runs, bbox: bboxOf(all, 2), clipped, vars: names.slice() };
  }

  /* three variables: the lower and upper surfaces of the innermost variable over the region of the other two, as wire lines */
  function solid3D(ctx, nm, opts) {
    const NU = opts.lines || 12, NS = opts.lines || 10, NP = opts.samples || 28, names = nm.names, vals = [NaN, NaN, NaN];
    const outer = finiteRange(nm.lof[2](vals), nm.hif[2](vals), 6);
    let clipped = outer.clipped;
    const lines = [];
    const span = Math.max(6, 3 * Math.abs(outer.b - outer.a));
    const middle = u => {
      vals[2] = u; vals[1] = NaN; vals[0] = NaN;
      const r = finiteRange(nm.lof[1].apply(null, vals), nm.hif[1].apply(null, vals), span);
      if (r.clipped) clipped = true;
      return r;
    };
    const point = (u, v, w) => toXYZ(ctx.sysName, dictOf(names, [w, v, u]));
    const surface = (u, v, which) => {
      vals[2] = u; vals[1] = v; vals[0] = NaN;
      let g = (which === 'lo' ? nm.lof[0] : nm.hif[0]).apply(null, vals);
      if (g !== g) return null;
      if (!isFinite(g)) { const o = (which === 'lo' ? nm.hif[0] : nm.lof[0]).apply(null, vals); g = isFinite(o) ? o + (which === 'lo' ? -span : span) : (which === 'lo' ? -span : span); clipped = true; }
      return g;
    };
    const curve = (kind, fnOfT, count) => {
      const pts = [];
      for (let i = 0; i <= count; i++) { const p = fnOfT(i / count); if (p) pts.push(p); else if (pts.length > 1) { lines.push({ kind, pts: pts.slice() }); pts.length = 0; } else pts.length = 0; }
      if (pts.length > 1) lines.push({ kind, pts });
    };
    const surfPoint = (u, v, which) => { const g = surface(u, v, which); return g === null ? null : point(u, v, g); };
    ['lo', 'hi'].forEach(which => {
      for (let i = 0; i <= NU; i++) {                          // a line for each fixed value of the outer variable
        const u = outer.a + (outer.b - outer.a) * i / NU, m = middle(u);
        curve(which, t => surfPoint(u, m.a + (m.b - m.a) * t, which), NP);
      }
      for (let j = 0; j <= NS; j++) {                          // a line for each fixed fraction of the middle variable
        const s = j / NS;
        curve(which, t => { const u = outer.a + (outer.b - outer.a) * t, m = middle(u); return surfPoint(u, m.a + (m.b - m.a) * s, which); }, NP);
      }
    });
    /* vertical connectors along the edge of the base region */
    const edge = (u, v) => { const a = surface(u, v, 'lo'), b = surface(u, v, 'hi'); if (a === null || b === null) return; lines.push({ kind: 'side', pts: [point(u, v, a), point(u, v, b)] }); };
    for (let i = 0; i <= 8; i++) { const u = outer.a + (outer.b - outer.a) * i / 8, m = middle(u); edge(u, m.a); edge(u, m.b); }
    [outer.a, outer.b].forEach(u => { const m = middle(u); for (let j = 1; j < 6; j++) edge(u, m.a + (m.b - m.a) * j / 6); });
    const all = [];
    lines.forEach(l => l.pts.forEach(p => all.push(p)));
    return { kind: 'solid', dim: 3, system: ctx.sysName, lines, bbox: bboxOf(all, 3), clipped, vars: names.slice() };
  }

  /* ═════════════════════ changing the order of integration (two variables, Cartesian) ═════════════════════ */

  /* An exact form for a number that is a simple fraction or a simple multiple of pi, or null. */
  function snapNumber(x, tol) {
    tol = tol || 1e-9;
    for (let q = 1; q <= 24; q++) { const p = Math.round(x * q); if (Math.abs(x - p / q) < tol) return num(p, q); }
    for (let q = 1; q <= 12; q++) { const p = Math.round(x * q / Math.PI); if (p !== 0 && Math.abs(x - p * Math.PI / q) < tol) return mul(num(p, q), CAS.PI); }
    return null;
  }

  /* Solve g(u) = w for u by undoing one operation at a time. u must occur exactly once in g. Returns a list of candidate
     expressions in w (more than one when a branch has to be chosen: ± for an even power, two angles for a sine), or null. */
  const INVERSE = {
    ln: w => [CAS.exp(w)], sin: w => [fn('asin', w), CAS.sub(CAS.PI, fn('asin', w))], cos: w => [fn('acos', w), CAS.neg(fn('acos', w))],
    tan: w => [fn('atan', w)], asin: w => [sin(w)], acos: w => [cos(w)], atan: w => [fn('tan', w)],
    sinh: w => [fn('asinh', w)], cosh: w => [fn('acosh', w), CAS.neg(fn('acosh', w))], tanh: w => [fn('atanh', w)],
    abs: w => [w, CAS.neg(w)]
  };
  function solveFor(g, u, w) {
    if (g.t === 'sym') return g.name === u ? [w] : null;
    if (!CAS.dependsOn(g, u)) return null;
    const flat = list => [].concat.apply([], list.map(c => c || []));
    switch (g.t) {
      case 'add': {
        const dep = g.args.filter(a => CAS.dependsOn(a, u)), rest = g.args.filter(a => !CAS.dependsOn(a, u));
        return dep.length === 1 ? solveFor(dep[0], u, CAS.sub(w, rest.length ? add(...rest) : CAS.ZERO)) : null;
      }
      case 'mul': {
        const dep = g.args.filter(a => CAS.dependsOn(a, u)), rest = g.args.filter(a => !CAS.dependsOn(a, u));
        return dep.length === 1 ? solveFor(dep[0], u, CAS.div(w, rest.length ? mul(...rest) : CAS.ONE)) : null;
      }
      case 'pow': {
        const bd = CAS.dependsOn(g.b, u), ed = CAS.dependsOn(g.e, u);
        if (bd && !ed) {
          const inv = pow(w, CAS.div(CAS.ONE, g.e));
          const cands = [inv];
          if (g.e.t === 'num' && g.e.n % 2n === 0n) cands.push(CAS.neg(inv));
          return flat(cands.map(c => solveFor(g.b, u, c)));
        }
        if (!bd && ed) return solveFor(g.e, u, g.b.t === 'const' && g.b.name === 'e' ? CAS.ln(w) : CAS.div(CAS.ln(w), CAS.ln(g.b)));
        return null;
      }
      case 'fn': return INVERSE[g.name] ? flat(INVERSE[g.name](w).map(c => solveFor(g.a, u, c))) : null;
      default: return null;
    }
  }

  /* The separate pieces of the same region when the order is swapped. spec is a Cartesian double integral; the inner
     variable's limits are curves in the outer variable and the outer limits are numbers. Returns
     { ok, pieces:[{ order:[{v,lower,upper} inner, {v,lower,upper} outer], note }], message } */
  function reverse(spec) {
    const P = prepare(spec);
    if (P.problems.length) return { ok: false, pieces: [], message: P.problems[0].message };
    const ctx = P.ctx;
    const fail = message => ({ ok: false, pieces: [], message });
    if (ctx.sysName !== 'cartesian' || ctx.dim !== 2) return fail('Changing the order is offered for double integrals in x and y.');
    if (ctx.params.length) return fail('Changing the order does not work with extra symbols (' + ctx.params.join(', ') + '). Use numbers.');
    const inner = ctx.order[0], outerV = ctx.order[1], w = inner.v, u = outerV.v;
    const A = outerV.lower, B = outerV.upper;
    if (typeof A !== 'object' || typeof B !== 'object' || !A.t || !B.t) return fail('Changing the order needs finite limits on the outer variable.');
    const an = CAS.evalNum(A, {}), bn = CAS.evalNum(B, {});
    if (!(isFinite(an) && isFinite(bn))) return fail('Changing the order needs finite limits on the outer variable.');
    if (!(an < bn)) return fail('Changing the order needs the outer limits in increasing order (' + S(A) + ' < ' + S(B) + ').');
    for (const b of [inner.lower, inner.upper]) if (typeof b === 'number' || (b && !b.t)) return fail('Changing the order needs finite curves as the inner limits.');
    const g1 = CAS.compile(inner.lower, [u]), g2 = CAS.compile(inner.upper, [u]);
    const NS = 1600, xs = [];
    for (let i = 0; i <= NS; i++) xs.push(an + (bn - an) * i / NS);
    const v1 = xs.map(g1), v2 = xs.map(g2);
    if (v1.some(x => !isFinite(x)) || v2.some(x => !isFinite(x))) return fail('The limits of ' + nice(w) + ' are not finite real numbers everywhere between ' + S(A) + ' and ' + S(B) + ' (a square root of a negative number, or a division by zero), so the region cannot be turned around.');
    if (v1.some((x, i) => x > v2[i] + 1e-9)) return fail('Somewhere the lower limit of ' + nice(w) + ' is above its upper limit, so this is not a region between two curves. Fix the limits first (compare with the picture).');

    /* the heights where the shape of a horizontal slice can change: ends, turning points, and where the two curves touch */
    const crit = [];   // { w: number, exact: Expr }
    const exactAt = (g, ue) => CAS.simplify(CAS.subst(g, u, ue));
    const addCrit = (expr, val) => crit.push({ w: val, exact: expr });
    [[inner.lower, g1, A, an], [inner.lower, g1, B, bn], [inner.upper, g2, A, an], [inner.upper, g2, B, bn]].forEach(c => addCrit(exactAt(c[0], c[2]), c[1](c[3])));
    const turning = (gE, gN, vals, tag) => {
      const scale = 1 + Math.max.apply(null, vals.map(Math.abs)), thr = 1e-7 * scale;
      const dN = x => { const h = 1e-6 * Math.max(1, Math.abs(x)); return (gN(x + h) - gN(x - h)) / (2 * h); };
      const sgn = d => (d > thr ? 1 : d < -thr ? -1 : 0);
      let prev = 0, prevAt = 0;                       // the last sample where the slope was clearly up or down
      for (let i = 0; i <= NS; i++) {
        const sg = sgn(dN(xs[i]));
        if (sg === 0) continue;
        if (prev !== 0 && sg !== prev) {
          let a = xs[prevAt], b = xs[i], us = null;
          for (let k = 0; k < 80 && us === null; k++) {
            const m = (a + b) / 2, sm = sgn(dN(m));
            if (sm === 0) us = m; else if (sm === prev) a = m; else b = m;
          }
          if (us === null) us = (a + b) / 2;
          let ue = snapNumber(us, 1e-6);
          if (ue && Math.abs(CAS.evalNum(CAS.subst(CAS.diff(gE, u), u, ue), {})) > 1e-8) ue = null;   // a real turning point: the slope is exactly zero there
          if (!ue) return 'The ' + tag + ' limit of ' + nice(w) + ' has a turning point near ' + nice(u) + ' = ' + us.toPrecision(6) + ' that is not a simple number, so the exact limits for the other order cannot be written down.';
          addCrit(exactAt(gE, ue), gN(us));
        }
        prev = sg; prevAt = i;
      }
      return null;
    };
    let err = turning(inner.lower, g1, v1, 'lower') || turning(inner.upper, g2, v2, 'upper');
    if (err) return fail(err);
    /* places where the two curves touch (the region pinches to a point) */
    for (let i = 1; i < NS; i++) {
      const d = v2[i] - v1[i];
      if (d < 1e-9 && d <= v2[i - 1] - v1[i - 1] && d <= v2[i + 1] - v1[i + 1]) { const ue = snapNumber(xs[i]); if (ue) addCrit(exactAt(inner.lower, ue), v1[i]); }
    }
    crit.sort((p, q) => p.w - q.w);
    const levels = [];
    crit.forEach(c => { if (!levels.length || c.w - levels[levels.length - 1].w > 1e-9 * Math.max(1, Math.abs(c.w))) levels.push(c); });

    /* a horizontal slice of the region at height h: runs of the outer variable with the kind of boundary at each end */
    const slice = h => {
      const inside = x => { const a = g1(x), b = g2(x); return a <= h + 1e-12 && h <= b + 1e-12; };
      const ins = xs.map(inside), runs = [];
      const edge = (x0, x1) => {           // x0 is outside, x1 inside (or the other way): bisect to the boundary
        let a = x0, b = x1;
        for (let k = 0; k < 70; k++) { const m = (a + b) / 2; if (inside(m) === inside(x1)) b = m; else a = m; }
        const x = (a + b) / 2;
        return { x, kind: Math.abs(g1(x) - h) <= Math.abs(g2(x) - h) ? 'g1' : 'g2' };
      };
      for (let i = 0; i <= NS; i++) {
        if (!ins[i] || (i > 0 && ins[i - 1])) continue;
        let j = i; while (j < NS && ins[j + 1]) j++;
        const L = i === 0 ? { x: an, kind: 'A' } : edge(xs[i - 1], xs[i]);
        const Rr = j === NS ? { x: bn, kind: 'B' } : edge(xs[j + 1], xs[j]);
        runs.push({ left: L, right: Rr });
      }
      return runs;
    };
    const wSym = sym(w);
    const boundExpr = (kind, g, x, h) => {            // an expression in w for the boundary of the slice, checked against x
      if (kind === 'A') return A;
      if (kind === 'B') return B;
      const cands = solveFor(kind === 'g1' ? inner.lower : inner.upper, u, wSym);
      if (!cands) return null;
      for (const c of cands) {
        let val; try { val = CAS.compile(c, [w])(h); } catch (e) { continue; }
        if (isFinite(val) && Math.abs(val - x) < 1e-6 * Math.max(1, Math.abs(x))) return CAS.simplify(c);
      }
      return null;
    };
    const pieces = [];
    for (let i = 0; i + 1 < levels.length; i++) {
      const lo = levels[i], hi = levels[i + 1];
      const hs = [0.5, 0.25, 0.75].map(t => lo.w + (hi.w - lo.w) * t);
      const sl = hs.map(slice);
      if (!sl[0].length) continue;
      if (sl.some(s => s.length !== sl[0].length)) return fail('The region changes shape between ' + w + ' = ' + lo.w.toPrecision(5) + ' and ' + hi.w.toPrecision(5) + ' in a way this page cannot describe automatically. Describe it in pieces yourself.');
      for (let r = 0; r < sl[0].length; r++) {
        if (sl.some(s => s[r].left.kind !== sl[0][r].left.kind || s[r].right.kind !== sl[0][r].right.kind)) return fail('The boundary of the region changes between ' + w + ' = ' + lo.w.toPrecision(5) + ' and ' + hi.w.toPrecision(5) + ', which this page cannot describe automatically.');
        const lowerE = boundExpr(sl[0][r].left.kind, null, sl[0][r].left.x, hs[0]), upperE = boundExpr(sl[0][r].right.kind, null, sl[0][r].right.x, hs[0]);
        if (!lowerE || !upperE) return fail('The page could not solve the boundary curve for ' + nice(u) + ' (it can undo sums, products, powers, roots, exponentials, logarithms and the basic trigonometric functions, when ' + nice(u) + ' appears once).');
        /* the same expressions must also hit the boundary at the other two heights */
        for (let t = 1; t < 3; t++) {
          const chk = (e, x) => { const val = CAS.compile(e, [w])(hs[t]); return isFinite(val) && Math.abs(val - x) < 1e-6 * Math.max(1, Math.abs(x)); };
          if (!chk(lowerE, sl[t][r].left.x) || !chk(upperE, sl[t][r].right.x)) return fail('The boundary curves could not be matched consistently while turning the region around.');
        }
        pieces.push({ lowerU: lowerE, upperU: upperE, lowerW: lo.exact, upperW: hi.exact });
      }
    }
    if (!pieces.length) return fail('The region has no area, so there is nothing to turn around.');
    /* join neighbouring pieces that have the same limits */
    const merged = [];
    pieces.forEach(p => {
      const last = merged[merged.length - 1];
      if (last && last.lowerU.k === p.lowerU.k && last.upperU.k === p.upperU.k && last.upperW.k === p.lowerW.k) last.upperW = p.upperW;
      else merged.push(Object.assign({}, p));
    });
    return {
      ok: true, message: '',
      pieces: merged.map(p => ({ order: [{ v: u, lower: p.lowerU, upper: p.upperU }, { v: w, lower: p.lowerW, upper: p.upperW }] }))
    };
  }

  /* Solve the same integral with the order swapped: the sum of the integrals over the pieces. */
  function solveReversed(spec, opts) {
    const rv = reverse(spec);
    if (!rv.ok) return { ok: false, message: rv.message, pieces: [] };
    const out = { ok: true, pieces: [], exact: null, exactNumber: null, numeric: null, kind: 'exact', message: '', agree: null };
    let total = CAS.ZERO, allExact = true, numTotal = 0, numOk = true;
    rv.pieces.forEach(p => {
      const sub = solve(Object.assign({}, spec, { order: p.order }), opts);
      out.pieces.push({ order: p.order, result: sub });
      if (sub.kind === 'exact') { total = add(total, sub.exact); numTotal += sub.exactNumber; }
      else { allExact = false; if (sub.ok && isFinite(sub.numeric)) numTotal += sub.numeric; else numOk = false; }
    });
    if (allExact) { out.exact = CAS.simplify(total); out.exactNumber = CAS.evalNum(out.exact, {}); }
    else if (numOk) { out.kind = 'numeric'; out.numeric = numTotal; }
    else { out.ok = false; out.kind = 'none'; out.message = 'The integral could not be done in the other order either.'; }
    /* the original order, numerically, as the independent check that the region was turned around correctly */
    const P = prepare(spec);
    if (out.ok && !P.problems.length) {
      try {
        const q = nested(numerics(P.ctx, {}), (opts && opts.checkMs) || 4000, true);
        const val = allExact ? out.exactNumber : out.numeric;
        if (q.ok) {
          out.originalNumeric = q.value;
          out.agree = Math.abs(val - q.value) <= 1e-6 * Math.max(1, Math.abs(val)) + 10 * q.error;
          if (!out.agree) { out.ok = false; out.kind = 'none'; out.message = 'The two orders gave different numbers (' + val + ' and ' + q.value + '), so the turned-around region does not match the original. No answer is shown.'; }
        }
      } catch (e) { /* no check possible */ }
    }
    return out;
  }

  /* ═════════════════════ applications ═════════════════════ */

  /* size = ∫ 1, average = ∫ f / size, centroid = (∫ x, ∫ y, [∫ z]) / size; each as {exact, number} or null with a reason */
  function applications(spec, wanted, opts) {
    wanted = wanted || ['size'];
    const out = {};
    const run = f => solve(Object.assign({}, spec, { f }), opts);
    const pack = r => (r.ok && r.kind === 'exact' ? { exact: r.exact, number: r.exactNumber, result: r } : r.ok ? { exact: null, number: r.numeric, result: r } : { exact: null, number: null, result: r, message: r.message });
    const needSize = wanted.some(w => w === 'size' || w === 'average' || w === 'centroid');
    const size = needSize ? run('1') : null;
    if (wanted.indexOf('size') >= 0) out.size = pack(size);
    const ratio = (num, den) => {
      if (!num.ok || !den.ok || !num.exact || !den.exact) return { exact: null, number: num.ok && den.ok && isFinite(num.numeric / den.numeric) ? num.numeric / den.numeric : null, message: 'the ratio is numeric only' };
      const q = CAS.simplify(CAS.div(num.exact, den.exact));
      return { exact: q, number: CAS.evalNum(q, {}) };
    };
    if (wanted.indexOf('average') >= 0) out.average = ratio(run(spec.f), size);
    if (wanted.indexOf('centroid') >= 0) {
      const P = prepare(spec);
      const axes = P.problems.length ? [] : (P.ctx.dim === 3 ? ['x', 'y', 'z'] : ['x', 'y']);
      out.centroid = axes.map(a => Object.assign({ axis: a }, ratio(run(a), size)));
    }
    return out;
  }

  /* ═════════════════════ worked examples (each is checked against a hand-worked value in the tests) ═════════════════════ */

  const O = (v, lower, upper) => ({ v, lower, upper });
  const EXAMPLES = [
    { id: 'rect', group: 'double', title: 'Rectangle', system: 'cartesian', dim: 2, f: 'x*y^2', order: [O('y', '0', '3'), O('x', '0', '2')], value: 18, desc: '∫₀² ∫₀³ x y² dy dx: the limits are constants, so the integral splits into ∫x dx × ∫y² dy = 2 × 9.' },
    { id: 'triangle', group: 'double', title: 'Triangle', system: 'cartesian', dim: 2, f: 'x+y', order: [O('y', '0', 'x'), O('x', '0', '1')], value: 0.5, desc: 'The triangle with corners (0,0), (1,0), (1,1): y from 0 to x, x from 0 to 1.' },
    { id: 'between', group: 'double', title: 'Between two curves', system: 'cartesian', dim: 2, f: '1', order: [O('y', 'x^2', 'x'), O('x', '0', '1')], value: 1 / 6, desc: 'The area between y = x² and y = x.' },
    { id: 'quarter', group: 'double', title: 'Quarter disc', system: 'cartesian', dim: 2, f: 'x*y', order: [O('y', '0', 'sqrt(1-x^2)'), O('x', '0', '1')], value: 0.125, desc: 'x y over the quarter of the unit disc in the first quadrant, in Cartesian coordinates.' },
    { id: 'swapped', group: 'double', title: 'The other order', system: 'cartesian', dim: 2, f: 'e^(y^2)', order: [O('x', '0', 'y'), O('y', '0', '1')], value: (Math.E - 1) / 2, desc: 'e^(y²) cannot be integrated in y, but in this order x comes first. (The same region as x from 0 to 1, y from x to 1.)' },
    { id: 'reverse-demo', group: 'double', title: 'No closed form until you swap', system: 'cartesian', dim: 2, f: 'e^(y^2)', order: [O('y', 'x', '1'), O('x', '0', '1')], value: (Math.E - 1) / 2, needsReverse: true, desc: 'e^(y²) has no antiderivative in y, so this order cannot be done exactly. Press “Show the other order” to turn the region around (x from 0 to y, y from 0 to 1) and it becomes easy.' },
    { id: 'polar-disc', group: 'double', title: 'Disc in polar coordinates', system: 'polar', dim: 2, f: 'x^2+y^2', order: [O('r', '0', '1'), O('theta', '0', '2*pi')], value: Math.PI / 2, desc: '∫∫ (x² + y²) dA over the unit disc. Typed in x and y; it is converted to r and θ and the factor r is added.' },
    { id: 'polar-gauss', group: 'double', title: 'Gaussian over the plane', system: 'polar', dim: 2, f: 'e^(-(x^2+y^2))', order: [O('r', '0', 'inf'), O('theta', '0', '2*pi')], value: Math.PI, desc: '∫∫ e^(−x²−y²) dA over the whole plane = π. Hard in x and y, easy in polar coordinates.' },
    { id: 'polar-cardioid', group: 'double', title: 'Area of a cardioid', system: 'polar', dim: 2, f: '1', order: [O('r', '0', '1+cos(theta)'), O('theta', '0', '2*pi')], value: 3 * Math.PI / 2, desc: 'The region inside r = 1 + cos θ.' },
    { id: 'polar-circle', group: 'double', title: 'Disc offset from the origin', system: 'polar', dim: 2, f: '1', order: [O('r', '0', '2*cos(theta)'), O('theta', '-pi/2', 'pi/2')], value: Math.PI, desc: 'The disc inside the circle r = 2 cos θ, which passes through the origin. Its area is π.' },
    { id: 'box', group: 'triple', title: 'Box', system: 'cartesian', dim: 3, f: 'x+y+z', order: [O('z', '0', '3'), O('y', '0', '2'), O('x', '0', '1')], value: 18, desc: '∫₀¹ ∫₀² ∫₀³ (x + y + z) dz dy dx.' },
    { id: 'tetra', group: 'triple', title: 'Tetrahedron: volume', system: 'cartesian', dim: 3, f: '1', order: [O('z', '0', '1-x-y'), O('y', '0', '1-x'), O('x', '0', '1')], value: 1 / 6, desc: 'The solid under the plane x + y + z = 1 in the first octant.' },
    { id: 'tetra-xyz', group: 'triple', title: 'Tetrahedron: x y z', system: 'cartesian', dim: 3, f: 'x*y*z', order: [O('z', '0', '1-x-y'), O('y', '0', '1-x'), O('x', '0', '1')], value: 1 / 720, desc: '∫∫∫ x y z over the same tetrahedron.' },
    { id: 'cyl', group: 'triple', title: 'Cylinder', system: 'cylindrical', dim: 3, f: '1', order: [O('z', '0', '3'), O('r', '0', '2'), O('theta', '0', '2*pi')], value: 12 * Math.PI, desc: 'Volume of a cylinder of radius 2 and height 3: π r² h.' },
    { id: 'paraboloid', group: 'triple', title: 'Under a paraboloid', system: 'cylindrical', dim: 3, f: '1', order: [O('z', 'r^2', '4'), O('r', '0', '2'), O('theta', '0', '2*pi')], value: 8 * Math.PI, desc: 'The solid between the paraboloid z = x² + y² = r² and the plane z = 4.' },
    { id: 'cyl-moment', group: 'triple', title: 'Moment of inertia of a cylinder', system: 'cylindrical', dim: 3, f: 'x^2+y^2', order: [O('z', '0', '3'), O('r', '0', '2'), O('theta', '0', '2*pi')], value: 24 * Math.PI, desc: '∫∫∫ (x² + y²) dV over the cylinder of radius 2 and height 3 (the moment of inertia about the axis for unit density).' },
    { id: 'ball', group: 'triple', title: 'Ball', system: 'spherical', dim: 3, f: '1', order: [O('rho', '0', '2'), O('phi', '0', 'pi'), O('theta', '0', '2*pi')], value: 32 * Math.PI / 3, desc: 'Volume of a ball of radius 2: 4π r³/3.' },
    { id: 'ball-r2', group: 'triple', title: 'Ball: x² + y² + z²', system: 'spherical', dim: 3, f: 'x^2+y^2+z^2', order: [O('rho', '0', '1'), O('phi', '0', 'pi'), O('theta', '0', '2*pi')], value: 4 * Math.PI / 5, desc: '∫∫∫ (x² + y² + z²) dV over the unit ball. Converted to ρ² and multiplied by ρ² sin φ.' },
    { id: 'cone', group: 'triple', title: 'Ice-cream cone', system: 'spherical', dim: 3, f: '1', order: [O('rho', '0', '1'), O('phi', '0', 'pi/4'), O('theta', '0', '2*pi')], value: Math.PI * (2 - Math.SQRT2) / 3, desc: 'The part of the unit ball inside the cone φ ≤ π/4.' }
  ];

  const api = { solve, geometry, applications, reverse, solveReversed, tidy, toXYZ, defaultOrder, coords, EXAMPLES, SYSTEMS: SYSTEM_NAMES, prepare, numerics, nested, S, nice, boundText };
  /*__PUBLIC__*/
  return api;
});
