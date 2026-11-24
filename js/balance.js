/*
 * Steady-state material balances on a flowsheet, with degree-of-freedom (DOF) analysis.
 * Plain deterministic code: no AI, no network, no dependencies.
 *
 * Model of the problem
 *   - Every stream s has a flow of each component, n(i,s), and a total flow F(s).
 *   - Every reactor has an extent of reaction, ξ, for each of its reactions.
 *   - Units give equations (component balances; a splitter also gives "same composition").
 *   - You give specifications (flows, fractions, recoveries, conversions, ...), each one more equation.
 *   Everything is linear in these variables except the splitter's "same composition" rule,
 *   which is a product of two unknowns, so a small Newton solver is used for the general case.
 *
 * What analyze() does
 *   1. Counts variables and independent equations (rank of the Jacobian) → degrees of freedom,
 *      for the whole flowsheet and for each unit.
 *   2. Finds redundant or conflicting specifications.
 *   3. Solves the system (Newton, multi-start).
 *   4. Writes out a human-style solution: repeatedly pick an equation with exactly one unknown,
 *      substitute the known values and solve it. Overall balances are included as shortcuts.
 *      Equations that must be solved together are grouped as a simultaneous block.
 *
 * Energy balances (optional). If the model has an `energy` section the problem also gets, for every stream, a temperature
 * T(s) and, for every unit, a heat duty Q(u), plus one energy balance per unit (outlet enthalpy − inlet enthalpy = Q) and
 * the specification types in ENERGY_SPEC_TYPES. Stream enthalpies come from js/energy.js (heat capacities, latent heats,
 * heats of formation). The degrees-of-freedom analysis, the solver and the written solution then cover both kinds of
 * equation. Without an `energy` section nothing about the problem or its solution changes.
 *   model.energy = { species: { Component: 'speciesId' }, flowUnit: { type: 'mol' | 'mass', factor },
 *                    P (kPa), phases: { Stream: 'g' | 'l' | 's' }, db (optional species table) }
 *   flowUnit.factor converts the flow unit of the mass balance to mol/s (type 'mol') or kg/s (type 'mass').
 *   Temperatures are in K and duties in kW inside the model.
 *
 * Works in the browser (window.Balance) and in Node (module.exports).
 */
(function (root, factory) {
  // the energy library is only loaded when a problem asks for energy balances (it needs this file for parseReaction)
  const getEnergy = () => (typeof require === 'function' ? require('./energy.js') : root.Energy);
  if (typeof module === 'object' && module.exports) module.exports = factory(getEnergy);
  else root.Balance = factory(getEnergy);
})(typeof self !== 'undefined' ? self : this, function (getEnergy) {
  'use strict';

  const UNIT_TYPES = {
    mixer:     { label: 'Mixer',      hint: 'two or more feeds, one outlet' },
    splitter:  { label: 'Splitter',   hint: 'one feed, outlets all have the feed composition' },
    separator: { label: 'Separator',  hint: 'one or more feeds, two or more outlets of different composition' },
    reactor:   { label: 'Reactor',    hint: 'needs a reaction such as  A + 2 B -> C' },
    unit:      { label: 'Other unit', hint: 'any unit; only the component balances are used' }
  };

  /* Specification types. "fields" tells the page which inputs to show. */
  const SPEC_TYPES = [
    { id: 'flow',       label: 'Total flow of a stream',                          fields: ['stream'],                 value: 'flow' },
    { id: 'compflow',   label: 'Flow of one component in a stream',               fields: ['stream', 'comp'],         value: 'flow' },
    { id: 'frac',       label: 'Fraction of a component in a stream',             fields: ['stream', 'comp'],         value: 'fraction' },
    { id: 'ratio',      label: 'Ratio of two components in a stream',             fields: ['stream', 'comp', 'comp2'], value: 'ratio (first ÷ second)' },
    { id: 'flowratio',  label: 'Ratio of two stream flows',                       fields: ['stream', 'stream2'],      value: 'ratio (first ÷ second)' },
    { id: 'recovery',   label: 'Fraction of a feed component leaving in a stream', fields: ['stream', 'comp'],        value: 'fraction' },
    { id: 'splitfrac',  label: 'Fraction of a unit’s feed leaving in a stream',   fields: ['stream'],                 value: 'fraction' },
    { id: 'conversion', label: 'Conversion of a component in a reactor',          fields: ['unit', 'comp'],           value: 'fraction' },
    { id: 'extent',     label: 'Extent of reaction in a reactor',                 fields: ['unit'],                   value: 'amount' }
  ];

  /* Extra specification types, only offered (and only accepted) when the energy balance is switched on.
     value: null means the type needs no number. */
  const ENERGY_SPEC_TYPES = [
    { id: 'temp',       label: 'Temperature of a stream',                              fields: ['stream'], value: 'temperature' },
    { id: 'duty',       label: 'Heat added to a unit (heat duty Q)',                   fields: ['unit'],   value: 'heat duty' },
    { id: 'adiabatic',  label: 'A unit is adiabatic (Q = 0)',                          fields: ['unit'],   value: null },
    { id: 'isothermal', label: 'A unit is isothermal (all its streams at one temperature)', fields: ['unit'], value: null },
    { id: 'outsameT',   label: 'All outlets of a unit are at the same temperature',    fields: ['unit'],   value: null }
  ];
  const NO_VALUE = { adiabatic: true, isothermal: true, outsameT: true };

  /* ───────────────────────── small helpers ───────────────────────── */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function num(x) {
    if (typeof x !== 'number' || !isFinite(x)) return String(x);
    if (Math.abs(x) < 1e-12) return '0';
    return String(Number(x.toPrecision(6)));
  }
  const paren = x => (x < 0 ? '(' + num(x) + ')' : num(x));
  // may variable i of P take the value x[i]? Flows must not be negative; extents and heat duties can be; a temperature must be above 0 K.
  const okVar = (P, i, x) => { const k = P.vars[i].kind; return k === 'xi' || k === 'Q' || (k === 'T' ? x[i] > 1 : x[i] > -1e-8 * Math.max(1, P.typ)); };
  const maxAbs = a => { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v !== v) return NaN; if (v > m) m = v; } return m; };

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

  function parseList(s) {
    return String(s === undefined || s === null ? '' : s).split(/[,;\n]+/).map(t => t.trim()).filter(Boolean);
  }

  /* "N2 + 3 H2 -> 2 NH3"  →  { N2: -1, H2: -3, NH3: 2 }  (reactants negative) */
  function parseReaction(str, comps) {
    const s = String(str || '').trim();
    const sides = s.split(/->|→|=>|⇒|=/);
    if (sides.length !== 2 || !sides[0].trim() || !sides[1].trim()) {
      throw new Error('Write the reaction like  A + 2 B -> C  (reactants, an arrow, then products).');
    }
    const nu = {};
    const side = (txt, sign) => {
      txt.split('+').forEach(term => {
        const t = term.trim();
        if (!t) throw new Error('There is an empty term in "' + s + '".');
        let coef = 1, name = t;
        if (comps.indexOf(t) < 0) {
          const m = t.match(/^(\d+(?:\.\d+)?)\s*(.+)$/);
          if (m) { coef = Number(m[1]); name = m[2].trim(); }
        }
        if (comps.indexOf(name) < 0) {
          throw new Error('"' + name + '" in the reaction is not one of the components (' + comps.join(', ') + ').');
        }
        nu[name] = (nu[name] || 0) + sign * coef;
      });
    };
    side(sides[0], -1);
    side(sides[1], +1);
    return nu;
  }

  /* ───────────────────────── linear algebra ───────────────────────── */

  // Solve A x = b by Gaussian elimination with partial pivoting. Returns null if singular.
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    let scale = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(A[i][j]));
    if (scale === 0) return null;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12 * scale) return null;
      if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /* Gram–Schmidt on normalised rows, in order. Returns the indices of a maximal independent subset
     and an orthonormal basis of the row space. */
  function gramSchmidt(rows) {
    const basis = [], chosen = [];
    rows.forEach((row, k) => {
      let nrm = 0;
      for (let i = 0; i < row.length; i++) nrm += row[i] * row[i];
      nrm = Math.sqrt(nrm);
      if (nrm < 1e-12) return;
      const v = Array.prototype.map.call(row, a => a / nrm);
      for (let pass = 0; pass < 2; pass++) {
        basis.forEach(b => {
          let d = 0;
          for (let i = 0; i < v.length; i++) d += v[i] * b[i];
          for (let i = 0; i < v.length; i++) v[i] -= d * b[i];
        });
      }
      let n2 = 0;
      for (let i = 0; i < v.length; i++) n2 += v[i] * v[i];
      n2 = Math.sqrt(n2);
      if (n2 > 1e-7) { basis.push(v.map(a => a / n2)); chosen.push(k); }
    });
    return { chosen, basis };
  }
  const selectIndependent = rows => gramSchmidt(rows).chosen;

  /* ───────────────────────── equations ───────────────────────── */

  // An equation:  Σ c·x[i]  +  Σ c·x[i]·x[j]  −  rhs  =  0
  // (an energy balance has its own evaluator, e.fn(x), and Jacobian row, e.jac(x, nv))
  function evalEq(e, x) {
    if (e.fn) return e.fn(x);
    let s = -e.rhs;
    for (let k = 0; k < e.terms.length; k++) s += e.terms[k][0] * x[e.terms[k][1]];
    for (let k = 0; k < e.prods.length; k++) s += e.prods[k][0] * x[e.prods[k][1]] * x[e.prods[k][2]];
    return s;
  }
  function jacRow(e, x, nv) {
    if (e.jac) return e.jac(x, nv);
    const r = new Array(nv).fill(0);
    e.terms.forEach(t => { r[t[1]] += t[0]; });
    e.prods.forEach(p => { r[p[1]] += p[0] * x[p[2]]; r[p[2]] += p[0] * x[p[1]]; });
    return r;
  }

  /* Newton's method on the given equations for the given unknown variables
     (all other variables keep the values in x0). Damped by step halving. */
  function newton(eqs, unk, x0, scale) {
    const n = unk.length;
    if (eqs.length !== n) return { ok: false, reason: 'not square' };
    let x = Float64Array.from(x0);
    const resid = xx => eqs.map(e => evalEq(e, xx));
    let r = resid(x), rn = maxAbs(r);
    const target = 1e-11 * Math.max(1, scale || 1);
    for (let it = 0; it < 150; it++) {
      if (rn < target) return { ok: true, x, iters: it, resid: rn };
      const J = eqs.map(e => { const full = jacRow(e, x, x.length); return unk.map(v => full[v]); });
      const dx = solveLinear(J, r.map(a => -a));
      if (!dx) return { ok: false, reason: 'singular' };
      let t = 1, xn = null, r2 = null, rn2 = Infinity;
      for (let h = 0; h < 40; h++) {
        xn = x.slice();
        unk.forEach((v, k) => { xn[v] += t * dx[k]; });
        r2 = resid(xn); rn2 = maxAbs(r2);
        if (isFinite(rn2) && rn2 < rn * (1 - 1e-4 * t)) break;
        t /= 2;
      }
      if (!isFinite(rn2) || rn2 >= rn) { if (rn2 < target) { x = xn; r = r2; rn = rn2; continue; } return { ok: false, reason: 'stalled' }; }
      x = xn; r = r2; rn = rn2;
    }
    return { ok: rn < target * 100, x, iters: 150, resid: rn };
  }

  /* ───────────────────────── building the equation set ───────────────────────── */

  function merge(terms) {
    const m = new Map();
    terms.forEach(t => m.set(t[1], (m.get(t[1]) || 0) + t[0]));
    const out = [];
    m.forEach((c, i) => { if (Math.abs(c) > 1e-15) out.push([c, i]); });
    return out;
  }

  function mkEq(kind, label, text, terms, prods, rhs, extra) {
    const t = merge(terms);
    const vs = new Set();
    t.forEach(a => vs.add(a[1]));
    prods.forEach(p => { vs.add(p[1]); vs.add(p[2]); });
    const e = { kind, label, text, terms: t, prods, rhs, vars: Array.from(vs) };
    if (kind === 'spec' && t.length === 1 && !prods.length) {
      e.given = true; e.givenVar = t[0][1]; e.givenValue = rhs / t[0][0];
    }
    return Object.assign(e, extra || {});
  }

  function balText(outs, ins, rx) {
    let rhs = ins.join(' + ');
    rx.forEach(r => {
      const a = Math.abs(r[0]);
      rhs += (r[0] > 0 ? ' + ' : ' − ') + (a === 1 ? '' : num(a) + '·') + r[1];
    });
    return outs.join(' + ') + ' = ' + (rhs || '0');
  }

  function specLabel(sp) {
    const blank = sp.value === '' || sp.value === null || sp.value === undefined || !isFinite(Number(sp.value));
    const v = blank ? '?' : num(Number(sp.value));
    switch (sp.type) {
      case 'flow':       return 'Total flow of ' + sp.stream + ' = ' + v;
      case 'compflow':   return 'Flow of ' + sp.comp + ' in ' + sp.stream + ' = ' + v;
      case 'frac':       return 'Fraction of ' + sp.comp + ' in ' + sp.stream + ' = ' + v;
      case 'ratio':      return sp.comp + ' ÷ ' + sp.comp2 + ' in ' + sp.stream + ' = ' + v;
      case 'flowratio':  return 'Flow of ' + sp.stream + ' ÷ flow of ' + sp.stream2 + ' = ' + v;
      case 'recovery':   return 'Fraction of the ' + sp.comp + ' fed that leaves in ' + sp.stream + ' = ' + v;
      case 'splitfrac':  return 'Fraction of the feed that leaves in ' + sp.stream + ' = ' + v;
      case 'conversion': return 'Conversion of ' + sp.comp + ' in ' + sp.unit + ' = ' + v;
      case 'extent':     return 'Extent of reaction' + (Number(sp.reaction) > 1 ? ' ' + sp.reaction : '') + ' in ' + sp.unit + ' = ' + v;
      case 'temp':       return 'Temperature of ' + sp.stream + ' = ' + v + ' K';
      case 'duty':       return 'Heat added to ' + sp.unit + ' = ' + v + ' kW';
      case 'adiabatic':  return sp.unit + ' is adiabatic (Q = 0)';
      case 'isothermal': return sp.unit + ' is isothermal';
      case 'outsameT':   return 'All outlets of ' + sp.unit + ' at one temperature';
      default:           return String(sp.type);
    }
  }

  /* ───────────────────────── energy: what the problem needs to know ───────────────────────── */

  const T_GUESS = [400, 300, 600, 900, 1400, 2000];      // starting temperatures (K) for the solvers

  /* Reads model.energy. Returns null if the energy balance is not asked for; otherwise the species of every component,
     the factor that turns a flow in the flow unit into mol/s, the pressure, the stream phases and the reference state. */
  function setupEnergy(cfg, comps, units, streams, errors) {
    if (!cfg || cfg.enabled === false) return null;
    const En = getEnergy();
    const db = cfg.db || En.SPECIES;
    const fu = cfg.flowUnit || { type: 'mol', factor: 1 };
    const factor = Number(fu.factor === undefined ? 1 : fu.factor);
    const mass = fu.type === 'mass';
    if (!(factor > 0)) errors.push('Energy balance: the unit of the flows is not valid.');
    const species = [], kc = [];
    comps.forEach(c => {
      const given = cfg.species && cfg.species[c] !== undefined && cfg.species[c] !== '' ? cfg.species[c] : null;
      const id = given || En.findSpecies(db, c) || c;
      const sp = db[id];
      if (!sp) { errors.push('Energy balance: choose the species for the component "' + c + '" ("' + id + '" is not in the data table).'); species.push(null); kc.push(0); return; }
      species.push(sp);
      if (mass) {
        if (!(sp.M > 0)) errors.push('Energy balance: ' + sp.name + ' has no molar mass, which is needed to turn mass flows into moles.');
        kc.push(factor * 1000 / sp.M);                 // kg/s → mol/s
      } else kc.push(factor);                          // mol/s per flow unit
    });
    if (errors.length) return null;
    const P = Number(cfg.P) > 0 ? Number(cfg.P) : En.P0;
    const phases = {};
    streams.forEach(st => { const p = cfg.phases && cfg.phases[st.name]; phases[st.name] = p === 'g' || p === 'l' || p === 's' ? p : 'auto'; });
    const formation = units.some(u => u.reactions.length > 0);
    // Check the data now, so the message is clear. A species is checked in its standard phase (the reference state of its enthalpy);
    // a component may be absent from a stream, so the phase of a stream is only checked when the problem is solved.
    species.forEach(sp => {
      try { En.molarEnthalpy(sp, 298.15, 'auto', P, formation); En.molarCp(sp, 298.15, 'auto', P); }
      catch (err) { if (errors.indexOf('Energy balance: ' + err.message) < 0) errors.push('Energy balance: ' + err.message); }
    });
    if (errors.length) return null;
    return { En, db, species, kc, P, phases, formation, flowUnit: { type: mass ? 'mass' : 'mol', factor } };
  }

  function build(model) {
    const errors = [], warnings = [];
    const fail = m => { errors.push(m); };

    const comps = [];
    (model.components || []).forEach(c => {
      c = String(c).trim();
      if (c && comps.indexOf(c) < 0) comps.push(c);
    });
    if (comps.length < 1) fail('Add at least one component.');

    /* units and streams */
    const units = [];
    const unitsByName = {};
    const streamMap = new Map();
    const getStream = s => {
      if (!streamMap.has(s)) streamMap.set(s, { name: s, from: null, to: null });
      return streamMap.get(s);
    };
    (model.units || []).forEach((u0, k) => {
      const name = String(u0.name || '').trim();
      if (!name) { fail('Unit ' + (k + 1) + ' has no name.'); return; }
      if (unitsByName[name]) { fail('Two units are called "' + name + '".'); return; }
      const type = u0.type || 'unit';
      if (!UNIT_TYPES[type]) { fail('Unit ' + name + ' has an unknown type "' + type + '".'); return; }
      const tidy = a => (Array.isArray(a) ? a : parseList(a)).map(s => String(s).trim()).filter(Boolean);
      const u = { name, type, inlets: tidy(u0.inlets), outlets: tidy(u0.outlets), reactions: [], reactionText: [] };
      const nin = u.inlets.length, nout = u.outlets.length;
      const where = UNIT_TYPES[type].label + ' ' + name;
      if (nin < 1) fail(where + ' needs at least one inlet stream.');
      if (nout < 1) fail(where + ' needs at least one outlet stream.');
      if (type === 'mixer' && (nin < 2 || nout !== 1)) fail(where + ' needs two or more inlets and exactly one outlet.');
      if (type === 'splitter' && (nin !== 1 || nout < 2)) fail(where + ' needs exactly one inlet and two or more outlets.');
      if (type === 'separator' && nout < 2) fail(where + ' needs two or more outlets.');
      const rx = u0.reactions !== undefined ? u0.reactions : u0.reaction;
      const rxList = (Array.isArray(rx) ? rx : [rx]).map(s => String(s === undefined || s === null ? '' : s).trim()).filter(Boolean);
      if (type === 'reactor') {
        if (!rxList.length) fail(where + ' needs a reaction, for example  A + 2 B -> C.');
        rxList.forEach(t => {
          try { u.reactions.push(parseReaction(t, comps)); u.reactionText.push(t); }
          catch (e) { fail(where + ': ' + e.message); }
        });
      } else if (rxList.length) {
        warnings.push(where + ' has a reaction written but is not a reactor, so it is ignored.');
      }
      unitsByName[name] = u;
      units.push(u);
      u.inlets.forEach(s => {
        const st = getStream(s);
        if (st.to) fail('Stream ' + s + ' is the inlet of both ' + st.to + ' and ' + name + '. Use a splitter to divide a stream.');
        st.to = name;
      });
      u.outlets.forEach(s => {
        const st = getStream(s);
        if (st.from) fail('Stream ' + s + ' is the outlet of both ' + st.from + ' and ' + name + '. Use a mixer to combine streams.');
        st.from = name;
      });
    });
    if (!units.length) fail('Add at least one unit.');
    streamMap.forEach(st => {
      if (st.from && st.from === st.to) fail('Stream ' + st.name + ' goes from ' + st.from + ' back into itself.');
    });
    if (errors.length) return { errors, warnings };

    const streams = Array.from(streamMap.values());
    streams.forEach(st => { st.kind = !st.from ? 'feed' : (!st.to ? 'product' : 'internal'); });
    const EN = setupEnergy(model.energy, comps, units, streams, errors);
    if (errors.length) return { errors, warnings };

    /* variables */
    const vars = [], idx = {};
    const addVar = (name, meta) => { idx[name] = vars.length; vars.push(Object.assign({ name }, meta)); };
    const Fn = s => 'F(' + s + ')';
    const Nn = (c, s) => 'n(' + c + ',' + s + ')';
    const Xn = (u, k) => (u.reactions.length > 1 ? 'ξ(' + u.name + ',' + (k + 1) + ')' : 'ξ(' + u.name + ')');
    streams.forEach(st => {
      addVar(Fn(st.name), { kind: 'F', stream: st.name });
      comps.forEach(c => addVar(Nn(c, st.name), { kind: 'n', stream: st.name, comp: c }));
    });
    units.forEach(u => u.reactions.forEach((_, k) => addVar(Xn(u, k), { kind: 'xi', unit: u.name, reaction: k + 1 })));
    if (EN) {
      streams.forEach(st => addVar('T(' + st.name + ')', { kind: 'T', stream: st.name }));
      units.forEach(u => addVar('Q(' + u.name + ')', { kind: 'Q', unit: u.name }));
    }
    const F = s => idx[Fn(s)];
    const N = (c, s) => idx[Nn(c, s)];
    const XI = (u, k) => idx[Xn(u, k)];
    const ulabel = u => UNIT_TYPES[u.type].label + ' ' + u.name;
    const TV = s => idx['T(' + s + ')'], QV = u => idx['Q(' + u + ')'];

    /* Energy balances. Ḣ(s) = Σ ṅ(c,s) ĥ(c, T(s)) in kW. The equation is divided by ESCALE so that its size matches the flows. */
    const ESCALE = EN ? 1000 * Math.max.apply(null, EN.kc.concat([1e-9])) : 1;
    // A species with no data for the phase of a stream is evaluated in its standard phase while the equations are counted and solved
    // (the solver has to try points where, say, nitrogen is in a liquid stream). Once the answer is known, dataProblems() checks that no
    // species that is really present was given a stand-in: that is an error.
    const mode = { strict: false };
    const hmol = (j, T, ph, lenient) => {
      try { return EN.En.molarEnthalpy(EN.species[j], T, ph, EN.P, EN.formation); }
      catch (err) { if (!lenient) return NaN; try { return EN.En.molarEnthalpy(EN.species[j], T, 'auto', EN.P, EN.formation); } catch (e2) { return 0; } }
    };
    const cpmol = (j, T, ph, lenient) => {
      try { return EN.En.molarCp(EN.species[j], T, ph, EN.P) / 1000; }
      catch (err) { if (!lenient) return NaN; try { return EN.En.molarCp(EN.species[j], T, 'auto', EN.P) / 1000; } catch (e2) { return 0; } }
    };
    const sInfo = s => ({ name: s, T: TV(s), n: comps.map(c => N(c, s)), ph: EN ? EN.phases[s] : 'auto' });
    const Hs = (x, si) => {
      const T = Math.max(x[si.T], 1);
      let H = 0;
      for (let j = 0; j < comps.length; j++) { const n = x[si.n[j]]; if (n !== 0 && EN.kc[j] !== 0) H += EN.kc[j] * n * hmol(j, T, si.ph, !mode.strict); }
      return H;
    };
    const isKnownS = (x, si) => !isNaN(x[si.T]) && si.n.every(i => !isNaN(x[i]));

    function energyEq(kind, label, text, outs, ins, qs, extra) {
      const O = outs.map(sInfo), I = ins.map(sInfo), all = O.concat(I);
      const vs = new Set();
      all.forEach(si => { vs.add(si.T); si.n.forEach(i => vs.add(i)); });
      qs.forEach(q => vs.add(QV(q)));
      const raw = x => {
        let H = 0;
        O.forEach(si => { H += Hs(x, si); });
        I.forEach(si => { H -= Hs(x, si); });
        qs.forEach(q => { H -= x[QV(q)]; });
        return H;
      };
      const e = mkEq(kind, label, text, [], [], 0, Object.assign({
        vars: Array.from(vs), fn: x => raw(x) / ESCALE,
        jac: (x, nv) => {
          const r = new Array(nv).fill(0);
          [[O, 1], [I, -1]].forEach(pair => pair[0].forEach(si => {
            const T = Math.max(x[si.T], 1);
            let dT = 0;
            for (let j = 0; j < comps.length; j++) {
              if (!EN.kc[j]) continue;
              r[si.n[j]] += pair[1] * EN.kc[j] * hmol(j, T, si.ph, true) / ESCALE;
              const n = x[si.n[j]];
              if (n !== 0) dT += EN.kc[j] * n * cpmol(j, T, si.ph, true);
            }
            r[si.T] += pair[1] * dT / ESCALE;
          }));
          qs.forEach(q => { r[QV(q)] -= 1 / ESCALE; });
          return r;
        }
      }, extra || {}));
      const sName = si => 'Ḣ(' + si.name + ')';
      const speciesLines = (x, list) => {
        const lines = [];
        list.forEach(si => {
          if (isNaN(x[si.T])) return;
          comps.forEach((c, j) => {
            const n = x[si.n[j]];
            if (isNaN(n) || n === 0 || !EN.kc[j]) return;
            try { lines.push(si.name + ' · ' + EN.En.enthalpyDetail(EN.species[j], x[si.T], si.ph, EN.P, EN.formation).text); } catch (err) { /* reported when the balance is checked */ }
          });
        });
        return lines;
      };
      // Ḣ(s) written out with the numbers that are known; unknown flows stay as symbols
      const streamText = (x, si) => {
        const terms = []; let val = 0, open = false;
        comps.forEach((c, j) => {
          if (!EN.kc[j]) return;
          const n = x[si.n[j]], h = isNaN(x[si.T]) ? NaN : hmol(j, Math.max(x[si.T], 1), si.ph);
          if (isNaN(n)) { open = true; terms.push('ṅ(' + c + ',' + si.name + ') × ' + paren(h)); }
          else if (n !== 0) { terms.push(num(EN.kc[j] * n) + ' × ' + paren(h)); val += EN.kc[j] * n * h; }
        });
        return { text: sName(si) + ' = ' + (terms.join(' + ') || '0') + (open ? '' : ' = ' + num(val) + ' kW'), value: open ? NaN : val };
      };
      const balanceLine = (x, u) => {
        const o = O.map(si => streamText(x, si)), i = I.map(si => streamText(x, si));
        const qT = qs.filter(q => !isNaN(x[QV(q)])).map(q => 'Q(' + q + ') = ' + num(x[QV(q)]) + ' kW');
        return o.concat(i).map(a => a.text).concat(qT).join(';  ');
      };
      e.explain = (x, u) => {
        try {
          const o = O.map(si => streamText(x, si).value), i = I.map(si => streamText(x, si).value);
          const line = balanceLine(x, u);
          if (u >= 0 && vars[u].kind === 'Q') {
            const val = o.reduce((a, b) => a + b, 0) - i.reduce((a, b) => a + b, 0) - qs.filter(q => QV(q) !== u).reduce((a, q) => a + x[QV(q)], 0);
            return line + ';  Q(' + vars[u].unit + ') = Σ Ḣ(out) − Σ Ḣ(in) = ' + o.map(num).join(' + ') + ' − ' + (i.length > 1 ? '(' + i.map(num).join(' + ') + ')' : (i.map(num)[0] || '0')) + ' = ' + num(val) + ' kW';
          }
          return line + ';  Σ Ḣ(out) − Σ Ḣ(in) − Q = 0';
        } catch (err) { return e.text; }
      };
      e.detail = (x, u) => { try { return speciesLines(x, all.filter(si => isKnownS(x, si))); } catch (err) { return []; } };
      // a single unknown temperature: bracket the root and bisect (the enthalpy jumps at a boiling point, so no blind Newton)
      e.solve1 = (known, u) => {
        const v = vars[u];
        if (v.kind !== 'T') return null;
        const target = all.filter(si => si.name === v.stream)[0];
        if (!target) return null;
        for (let a = 0; a < all.length; a++) {
          const si = all[a];
          if (si.n.some(i => isNaN(known[i])) || (si !== target && isNaN(known[si.T]))) return null;
        }
        if (qs.some(q => isNaN(known[QV(q)]))) return null;
        const sign = O.indexOf(target) >= 0 ? 1 : -1;
        const xs = Float64Array.from(known);
        const g = T => { xs[target.T] = T; const r = sign * raw(xs); if (isNaN(r)) throw new Error('missing data'); return r; };
        const others = all.filter(si => si !== target).map(si => known[si.T]);
        const lo = Math.max(60, Math.min.apply(null, others) - 500);
        let sol;
        try { sol = EN.En.solveBracketed(g, lo, 6000, 20); } catch (err) { return { failed: 'the energy balance cannot be evaluated (' + err.message + ')' }; }
        if (sol.below || sol.above) return { failed: 'no temperature between ' + num(lo) + ' K and 6000 K satisfies the energy balance on ' + (v.stream) + '. Check the heat duty and the temperatures.' };
        // a jump (latent heat) holds most of the change of the balance across the 20 K step that was bracketed; a smooth curve almost none of it
        if (Math.abs(sol.fHi - sol.fLo) > 0.5 * Math.abs(g(sol.scanTo) - g(sol.scanFrom))) {
          return { failed: 'the energy balance is met only at the boiling point of a species in ' + v.stream + ' (part of it would be vapour). Split the stream into a vapour stream and a liquid stream and give each its phase.' };
        }
        // the enthalpy the unknown stream must carry, from the balance, then the temperature that gives it
        const x0 = Float64Array.from(known);
        x0[target.T] = 0;
        const others2 = all.filter(si => si !== target);
        const sumOthers = (list) => list.reduce((a, si) => a + Hs(x0, si), 0);
        const qsum = qs.reduce((a, q) => a + x0[QV(q)], 0);
        const need = sign === 1
          ? sumOthers(I) + qsum - sumOthers(O.filter(si => si !== target))
          : sumOthers(O) - sumOthers(I.filter(si => si !== target)) - qsum;
        xs[target.T] = sol.T;
        const line = sign === 1
          ? sName(target) + ' = Σ Ḣ(in) + Q − Σ Ḣ(other outlets) = ' + num(need) + ' kW'
          : sName(target) + ' = Σ Ḣ(out) − Σ Ḣ(other inlets) − Q = ' + num(need) + ' kW';
        const known2 = Float64Array.from(known);
        const lines = speciesLines(known2, others2.filter(si => isKnownS(known2, si)));
        known2[target.T] = sol.T;
        const atT = speciesLines(known2, [target]);
        return {
          value: sol.T, unit: 'K',
          substituted: others2.map(si => streamText(known2, si).text).concat(qs.map(q => 'Q(' + q + ') = ' + num(known[QV(q)]) + ' kW')).join(';  ') + ';  ' + line + ';  find T(' + target.name + ') with Σ ṅ ĥ(T) = ' + num(need) + ' kW (bracketed, then bisected ' + sol.iterations + ' times)',
          lines: lines.concat(['At T(' + target.name + ') = ' + num(sol.T) + ' K (' + num(sol.T - 273.15) + ' °C):']).concat(atT)
        };
      };
      return e;
    }
    const streamHvalue = (x, name) => { const si = sInfo(name); return isKnownS(x, si) ? Hs(x, si) : null; };
    // heat capacity polynomials used outside the range they are given for (an extrapolation: say so)
    const rangeWarnings = (x, typ) => {
      const msgs = [];
      streams.forEach(st => {
        const si = sInfo(st.name), T = x[si.T];
        comps.forEach((c, j) => {
          const n = x[si.n[j]];
          if (!(n > 1e-9 * Math.max(1, typ)) || !EN.kc[j] || isNaN(T)) return;
          try {
            const sp = EN.species[j], ph = EN.En.resolvePhase(sp, si.ph, T, EN.P), cp = sp.Cp[ph];
            if (cp && !EN.En.inRange(cp, T)) {
              const u = cp.Tunit === 'K' ? 'K' : '°C', m = 'Energy: the heat capacity of ' + sp.id + '(' + ph + ') is only given for ' + cp.Tmin + ' to ' + cp.Tmax + ' ' + u + ', but stream ' + st.name + ' is at ' + num(T - 273.15) + ' °C, so its enthalpy there is an extrapolation. Check it against a table.';
              if (msgs.indexOf(m) < 0) msgs.push(m);
            }
          } catch (err) { /* reported by dataProblems */ }
        });
      });
      return msgs;
    };
    // species that are present (flow above zero) in a stream whose phase or temperature has no data for them
    const dataProblems = (x, typ) => {
      const msgs = [];
      streams.forEach(st => {
        const si = sInfo(st.name);
        comps.forEach((c, j) => {
          const n = x[si.n[j]];
          if (!(n > 1e-9 * Math.max(1, typ)) || !EN.kc[j]) return;
          try { EN.En.molarEnthalpy(EN.species[j], Math.max(x[si.T], 1), si.ph, EN.P, EN.formation); EN.En.molarCp(EN.species[j], Math.max(x[si.T], 1), si.ph, EN.P); }
          catch (err) { const m = 'Stream ' + st.name + ' carries ' + c + ' but ' + err.message; if (msgs.indexOf(m) < 0) msgs.push(m); }
        });
      });
      return msgs;
    };

    /* equations from units */
    const unitEqs = [];
    units.forEach(u => {
      comps.forEach(c => {
        const terms = [], outs = [], ins = [], rx = [];
        u.outlets.forEach(s => { terms.push([1, N(c, s)]); outs.push(Nn(c, s)); });
        u.inlets.forEach(s => { terms.push([-1, N(c, s)]); ins.push(Nn(c, s)); });
        u.reactions.forEach((r, k) => {
          const nu = r[c] || 0;
          if (nu) { terms.push([-nu, XI(u, k)]); rx.push([nu, Xn(u, k)]); }
        });
        unitEqs.push(mkEq('unit', ulabel(u) + ' · balance on ' + c, balText(outs, ins, rx), terms, [], 0, { unit: u.name }));
      });
      if (u.type === 'splitter') {
        const inS = u.inlets[0];
        u.outlets.forEach(s => comps.forEach(c => {
          unitEqs.push(mkEq('unit', ulabel(u) + ' · ' + s + ' has the same composition as ' + inS + ' (' + c + ')',
            Nn(c, s) + '/' + Fn(s) + ' = ' + Nn(c, inS) + '/' + Fn(inS),
            [], [[1, N(c, s), F(inS)], [-1, N(c, inS), F(s)]], 0, { unit: u.name }));
        }));
      }
    });

    /* energy balance of every unit (and splitters: same temperature in every outlet) */
    const energyEqs = [];
    if (EN) {
      units.forEach(u => {
        const insText = u.inlets.map(s => 'Ḣ(' + s + ')').join(' + ');
        energyEqs.push(energyEq('energy', ulabel(u) + ' · energy balance',
          u.outlets.map(s => 'Ḣ(' + s + ')').join(' + ') + ' − ' + (u.inlets.length > 1 ? '(' + insText + ')' : insText) + ' = Q(' + u.name + ')',
          u.outlets, u.inlets, [u.name], { unit: u.name }));
        if (u.type === 'splitter') {
          u.outlets.forEach(s => energyEqs.push(mkEq('unit', ulabel(u) + ' · ' + s + ' leaves at the temperature of ' + u.inlets[0],
            'T(' + s + ') = T(' + u.inlets[0] + ')', [[1, TV(s)], [-1, TV(u.inlets[0])]], [], 0, { unit: u.name })));
        }
      });
    }

    /* total = sum of components, for every stream */
    const sumEqs = streams.map(st => mkEq('sum', 'Stream ' + st.name + ' · total flow = sum of the components',
      Fn(st.name) + ' = ' + comps.map(c => Nn(c, st.name)).join(' + '),
      [[1, F(st.name)]].concat(comps.map(c => [-1, N(c, st.name)])), [], 0, { stream: st.name }));

    /* specifications */
    const specEqs = [];
    const derivedEqs = [];       // consequences of specifications, used only to shorten the written solution
    const fracSums = {};
    const specs = model.specs || [];
    let typ = 1;
    specs.forEach((sp, k) => {
      const where = 'Specification ' + (k + 1) + ' (' + specLabel(sp) + ')';
      if (!EN && ENERGY_SPEC_TYPES.some(t => t.id === sp.type)) { fail(where + ': this is an energy specification. Switch on the energy balance to use it.'); return; }
      if (!NO_VALUE[sp.type] && (sp.value === '' || sp.value === null || sp.value === undefined || !isFinite(Number(sp.value)))) {
        fail(where + ': the value is missing or is not a number.'); return;
      }
      const v = NO_VALUE[sp.type] ? 0 : Number(sp.value);
      const needStream = nm => { if (!streamMap.has(nm)) { fail(where + ': "' + (nm || '') + '" is not a stream in the flowsheet.'); return false; } return true; };
      const needComp = nm => { if (comps.indexOf(nm) < 0) { fail(where + ': "' + (nm || '') + '" is not one of the components.'); return false; } return true; };
      const needUnit = (nm, type) => {
        const u = unitsByName[nm];
        if (!u) { fail(where + ': "' + (nm || '') + '" is not a unit in the flowsheet.'); return null; }
        if (type && u.type !== type) { fail(where + ': ' + nm + ' is a ' + UNIT_TYPES[u.type].label.toLowerCase() + ', not a ' + type + '.'); return null; }
        return u;
      };
      const range01 = () => { if (v < 0 || v > 1) { fail(where + ': this must be between 0 and 1.'); return false; } return true; };
      const nonneg = () => { if (v < 0) { fail(where + ': this cannot be negative.'); return false; } return true; };
      const add = (text, terms, rhs) => specEqs.push(mkEq('spec', 'Specification: ' + specLabel(sp), text, terms, [], rhs, { specIndex: k }));
      // the unit whose feed/outlets a recovery or split fraction refers to
      const sourceUnit = () => {
        if (!needStream(sp.stream)) return null;
        const st = streamMap.get(sp.stream);
        if (sp.unit) { const u = needUnit(sp.unit); if (u && u.outlets.indexOf(sp.stream) < 0) { fail(where + ': ' + sp.stream + ' is not an outlet of ' + sp.unit + '.'); return null; } return u; }
        if (!st.from) { fail(where + ': ' + sp.stream + ' is a feed stream, not the outlet of a unit.'); return null; }
        return unitsByName[st.from];
      };

      switch (sp.type) {
        case 'flow':
          if (!needStream(sp.stream) || !nonneg()) return;
          typ = Math.max(typ, Math.abs(v));
          add(Fn(sp.stream) + ' = ' + num(v), [[1, F(sp.stream)]], v); break;
        case 'compflow':
          if (!needStream(sp.stream) || !needComp(sp.comp) || !nonneg()) return;
          typ = Math.max(typ, Math.abs(v));
          add(Nn(sp.comp, sp.stream) + ' = ' + num(v), [[1, N(sp.comp, sp.stream)]], v); break;
        case 'frac':
          if (!needStream(sp.stream) || !needComp(sp.comp) || !range01()) return;
          (fracSums[sp.stream] = fracSums[sp.stream] || {})[sp.comp] = v;
          add(Nn(sp.comp, sp.stream) + ' = ' + num(v) + ' × ' + Fn(sp.stream), [[1, N(sp.comp, sp.stream)], [-v, F(sp.stream)]], 0); break;
        case 'ratio':
          if (!needStream(sp.stream) || !needComp(sp.comp) || !needComp(sp.comp2) || !nonneg()) return;
          if (sp.comp === sp.comp2) { fail(where + ': choose two different components.'); return; }
          add(Nn(sp.comp, sp.stream) + ' = ' + num(v) + ' × ' + Nn(sp.comp2, sp.stream), [[1, N(sp.comp, sp.stream)], [-v, N(sp.comp2, sp.stream)]], 0); break;
        case 'flowratio':
          if (!needStream(sp.stream) || !needStream(sp.stream2) || !nonneg()) return;
          if (sp.stream === sp.stream2) { fail(where + ': choose two different streams.'); return; }
          add(Fn(sp.stream) + ' = ' + num(v) + ' × ' + Fn(sp.stream2), [[1, F(sp.stream)], [-v, F(sp.stream2)]], 0); break;
        case 'recovery': {
          const u = sourceUnit();
          if (!u || !needComp(sp.comp) || !range01()) return;
          const ins = u.inlets.map(s => Nn(sp.comp, s));
          const terms = [[1, N(sp.comp, sp.stream)]].concat(u.inlets.map(s => [-v, N(sp.comp, s)]));
          const insText = ins.length > 1 ? '(' + ins.join(' + ') + ')' : ins[0];
          add(Nn(sp.comp, sp.stream) + ' = ' + num(v) + ' × ' + insText, terms, 0);
          // with only two outlets and no reaction, the rest of that component must leave in the other one
          if (u.outlets.length === 2 && u.type !== 'reactor') {
            const other = u.outlets.find(s => s !== sp.stream);
            derivedEqs.push(mkEq('derived', ulabel(u) + ' · the rest of the ' + sp.comp + ' leaves in ' + other,
              Nn(sp.comp, other) + ' = ' + num(1 - v) + ' × ' + insText,
              [[1, N(sp.comp, other)]].concat(u.inlets.map(s => [-(1 - v), N(sp.comp, s)])), [], 0, {}));
          }
          break;
        }
        case 'splitfrac': {
          const u = sourceUnit();
          if (!u || !range01()) return;
          const ins = u.inlets.map(s => Fn(s));
          const terms = [[1, F(sp.stream)]].concat(u.inlets.map(s => [-v, F(s)]));
          add(Fn(sp.stream) + ' = ' + num(v) + ' × ' + (ins.length > 1 ? '(' + ins.join(' + ') + ')' : ins[0]), terms, 0);
          // a splitter divides every component in the same ratio: a linear shortcut a person would use
          if (u.type === 'splitter') {
            comps.forEach(c => derivedEqs.push(mkEq('derived', ulabel(u) + ' · ' + sp.stream + ' takes ' + num(v) + ' of every component (' + c + ')',
              Nn(c, sp.stream) + ' = ' + num(v) + ' × ' + Nn(c, u.inlets[0]), [[1, N(c, sp.stream)], [-v, N(c, u.inlets[0])]], [], 0, {})));
          }
          break;
        }
        case 'conversion': {
          const u = needUnit(sp.unit, 'reactor');
          if (!u || !needComp(sp.comp) || !range01()) return;
          const ins = u.inlets.map(s => Nn(sp.comp, s)), outs = u.outlets.map(s => Nn(sp.comp, s));
          const I = ins.length > 1 ? '(' + ins.join(' + ') + ')' : ins[0];
          const O = outs.length > 1 ? '(' + outs.join(' + ') + ')' : outs[0];
          const terms = [];
          u.inlets.forEach(s => terms.push([1 - v, N(sp.comp, s)]));
          u.outlets.forEach(s => terms.push([-1, N(sp.comp, s)]));
          add(I + ' − ' + O + ' = ' + num(v) + ' × ' + I, terms, 0); break;
        }
        case 'extent': {
          const u = needUnit(sp.unit, 'reactor');
          if (!u) return;
          const r = Number(sp.reaction || 1);
          if (!(r >= 1 && r <= u.reactions.length)) { fail(where + ': ' + sp.unit + ' has no reaction number ' + r + '.'); return; }
          typ = Math.max(typ, Math.abs(v));
          add(Xn(u, r - 1) + ' = ' + num(v), [[1, XI(u, r - 1)]], v); break;
        }
        case 'temp':
          if (!needStream(sp.stream)) return;
          if (!(v > 0)) { fail(where + ': the temperature must be above absolute zero.'); return; }
          add('T(' + sp.stream + ') = ' + num(v) + ' K', [[1, TV(sp.stream)]], v); break;
        case 'duty': {
          const u = needUnit(sp.unit);
          if (!u) return;
          add('Q(' + u.name + ') = ' + num(v) + ' kW', [[1, QV(u.name)]], v); break;
        }
        case 'adiabatic': {
          const u = needUnit(sp.unit);
          if (!u) return;
          add('Q(' + u.name + ') = 0', [[1, QV(u.name)]], 0); break;
        }
        case 'isothermal': case 'outsameT': {
          const u = needUnit(sp.unit);
          if (!u) return;
          const list = sp.type === 'isothermal' ? u.inlets.concat(u.outlets) : u.outlets;
          if (list.length < 2) { fail(where + ': ' + u.name + ' has only one outlet stream, so there is nothing to equate.'); return; }
          list.slice(1).forEach(sn => add('T(' + sn + ') = T(' + list[0] + ')', [[1, TV(sn)], [-1, TV(list[0])]], 0));
          break;
        }
        default:
          fail(where + ': unknown specification type "' + sp.type + '".');
      }
    });

    // Mole/mass fractions in one stream cannot add to more than 1, and must add to exactly 1 if all are given.
    Object.keys(fracSums).forEach(s => {
      const given = fracSums[s], keys = Object.keys(given);
      const total = keys.reduce((a, c) => a + given[c], 0);
      if (total > 1 + 1e-9) fail('The fractions you gave for stream ' + s + ' add up to ' + num(total) + ', which is more than 1.');
      else if (keys.length === comps.length && Math.abs(total - 1) > 1e-6) fail('You gave a fraction for every component of stream ' + s + ', but they add up to ' + num(total) + ', not 1.');
    });

    /* overall balances: not extra information, but useful shortcuts for the step-by-step solution */
    const overallEqs = [];
    if (units.length >= 2) {
      const feeds = streams.filter(s => s.kind === 'feed'), prods = streams.filter(s => s.kind === 'product');
      comps.forEach(c => {
        const terms = [], outs = [], ins = [], rx = [];
        prods.forEach(s => { terms.push([1, N(c, s.name)]); outs.push(Nn(c, s.name)); });
        feeds.forEach(s => { terms.push([-1, N(c, s.name)]); ins.push(Nn(c, s.name)); });
        units.forEach(u => u.reactions.forEach((r, k) => {
          const nu = r[c] || 0;
          if (nu) { terms.push([-nu, XI(u, k)]); rx.push([nu, Xn(u, k)]); }
        }));
        if (outs.length && ins.length) overallEqs.push(mkEq('overall', 'Overall balance on ' + c + ' (whole flowsheet)', balText(outs, ins, rx), terms, [], 0, {}));
      });
    }

    if (EN && units.length >= 2) {
      const feeds = streams.filter(s => s.kind === 'feed'), prods = streams.filter(s => s.kind === 'product');
      if (feeds.length && prods.length) {
        overallEqs.push(energyEq('overall', 'Overall energy balance (whole flowsheet)', 'Σ Ḣ(products) − Σ Ḣ(feeds) = Σ Q',
          prods.map(s => s.name), feeds.map(s => s.name), units.map(u => u.name), {}));
      }
    }

    // starting temperatures for the solvers: what the person gave, then some typical values
    const tgiven = specs.filter(sp => sp.type === 'temp' && Number(sp.value) > 0).map(sp => Number(sp.value));
    const tGuess = (tgiven.length ? [tgiven.reduce((a, b) => a + b, 0) / tgiven.length, Math.max.apply(null, tgiven) + 400] : []).concat(T_GUESS);

    const core = unitEqs.concat(energyEqs, sumEqs, specEqs);
    return {
      errors, warnings, comps, units, unitsByName, streams, vars, idx, typ, specs, EN, tGuess, streamH: streamHvalue, mode, dataProblems, rangeWarnings,
      eqs: core.concat(overallEqs, derivedEqs), nCore: core.length,
      order: vars.map((_, i) => i).sort((a, b) => vars[b].name.length - vars[a].name.length)
    };
  }

  /* ───────────────────────── analysis ───────────────────────── */

  /* Move x to a nearby point that satisfies the given equations, using minimum-norm Newton steps
     (works even when some equations are dependent). Returns the point; check its residual yourself. */
  function projectOnto(eqs, x, nv) {
    x = Float64Array.from(x);
    const m = eqs.length;
    let r = eqs.map(e => evalEq(e, x)), rn = maxAbs(r);
    for (let it = 0; it < 80 && rn > 1e-12; it++) {
      const J = eqs.map(e => jacRow(e, x, nv));
      const G = [];
      for (let i = 0; i < m; i++) {
        const row = new Array(m);
        for (let j = 0; j < m; j++) {
          let s = 0;
          for (let k = 0; k < nv; k++) s += J[i][k] * J[j][k];
          row[j] = s + (i === j ? 1e-9 : 0);
        }
        G.push(row);
      }
      const y = solveLinear(G, r);
      if (!y) break;
      const dx = new Array(nv).fill(0);
      for (let i = 0; i < m; i++) for (let k = 0; k < nv; k++) dx[k] -= J[i][k] * y[i];
      let t = 1, xn = null, r2 = null, rn2 = Infinity;
      for (let h = 0; h < 30; h++) {
        xn = x.slice();
        for (let k = 0; k < nv; k++) xn[k] += t * dx[k];
        r2 = eqs.map(e => evalEq(e, xn)); rn2 = maxAbs(r2);
        if (isFinite(rn2) && rn2 < rn) break;
        t /= 2;
      }
      if (!isFinite(rn2) || rn2 >= rn) break;
      x = xn; r = r2; rn = rn2;
    }
    return x;
  }

  // A random positive point that satisfies "total = sum of components" for every stream.
  function genericPoint(P, seed) {
    const r = mulberry32(seed || 12345);
    const x = new Float64Array(P.vars.length);
    P.streams.forEach(st => {
      let tot = 0;
      P.comps.forEach(c => { const v = 0.5 + 1.5 * r(); x[P.idx['n(' + c + ',' + st.name + ')']] = v; tot += v; });
      x[P.idx['F(' + st.name + ')']] = tot;
    });
    P.vars.forEach((v, i) => {
      if (v.kind === 'xi') x[i] = 0.2 + r();
      else if (v.kind === 'T') x[i] = 300 + 300 * r();
      else if (v.kind === 'Q') x[i] = 20 * (r() - 0.5);
    });
    return x;
  }

  function substitute(P, text, known, skip) {
    let s = text;
    for (let k = 0; k < P.order.length; k++) {
      const i = P.order[k];
      if (i === skip || isNaN(known[i])) continue;
      const nm = P.vars[i].name;
      if (s.indexOf(nm) >= 0) s = s.split(nm).join(paren(known[i]));
    }
    return s;
  }

  /* Human-style solution: pick an equation with one unknown, substitute, solve. */
  function propagate(P, ref) {
    const nv = P.vars.length, eqs = P.eqs;
    const known = new Float64Array(nv).fill(NaN);
    const done = new Array(eqs.length).fill(false);
    const steps = [], givens = [], conflicts = [];
    const clean = v => (Math.abs(v) < 1e-10 * Math.max(1, P.typ) ? 0 : v);
    const resTol = 1e-8 * Math.max(1, P.typ);

    eqs.forEach((e, k) => {
      if (e.given && isNaN(known[e.givenVar])) {
        known[e.givenVar] = clean(e.givenValue); done[k] = true;
        givens.push(P.vars[e.givenVar].name + ' = ' + num(e.givenValue));
      }
    });

    const cls = { spec: 0, sum: 1, overall: 2, derived: 2, unit: 3, energy: 3 };
    const pool = eqs.map((_, k) => k).sort((a, b) => (cls[eqs[a].kind] - cls[eqs[b].kind]) || (a - b));
    const unknownsOf = e => e.vars.filter(i => isNaN(known[i]));
    const isDerived = k => eqs[k].kind === 'overall' || eqs[k].kind === 'derived';

    /* When no equation has a single unknown left, split what remains into the smallest groups that
       really must be solved together: match every unknown to one equation, then find the strongly
       connected components of "this equation needs the unknown that equation solves"
       (block-triangular form, as in process simulators). Returns the first group that is ready. */
    function firstBlock(cand) {
      const unkOf = k => eqs[k].vars.filter(i => isNaN(known[i]));
      const matchVar = new Map(), matchEq = new Map();
      const augment = (k, seen) => {
        const U = unkOf(k);
        for (let a = 0; a < U.length; a++) {
          const v = U[a];
          if (seen.has(v)) continue;
          seen.add(v);
          if (!matchVar.has(v) || augment(matchVar.get(v), seen)) { matchVar.set(v, k); matchEq.set(k, v); return true; }
        }
        return false;
      };
      cand.forEach(k => augment(k, new Set()));
      const nodes = Array.from(matchEq.keys());
      const blocked = new Set(), adj = new Map();
      nodes.forEach(k => {
        const out = [];
        unkOf(k).forEach(w => {
          if (w === matchEq.get(k)) return;
          if (matchVar.has(w)) out.push(matchVar.get(w)); else blocked.add(k);
        });
        adj.set(k, out);
      });
      const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
      let counter = 0;
      const strong = v => {
        index.set(v, counter); low.set(v, counter); counter++;
        stack.push(v); onStack.add(v);
        adj.get(v).forEach(w => {
          if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
          else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        });
        if (low.get(v) === index.get(v)) {
          const comp = []; let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          sccs.push(comp);
        }
      };
      nodes.forEach(v => { if (!index.has(v)) strong(v); });
      const sccOf = new Map();
      sccs.forEach((c, i) => c.forEach(k => sccOf.set(k, i)));
      const bad = new Array(sccs.length).fill(false);
      for (let i = 0; i < sccs.length; i++) {      // components come out dependencies-first
        sccs[i].forEach(k => {
          if (blocked.has(k)) bad[i] = true;
          adj.get(k).forEach(w => { const j = sccOf.get(w); if (j !== i && bad[j]) bad[i] = true; });
        });
        if (!bad[i]) {
          const list = sccs[i].slice().sort((a, b) => pool.indexOf(a) - pool.indexOf(b));
          return { list, unk: list.map(k => matchEq.get(k)).sort((a, b) => a - b) };
        }
      }
      return null;
    }

    function solveBlock(blk) {
      const sub = blk.list.map(k => eqs[k]);
      let fallback = null;
      for (let s = 0; s < 6; s++) {
        const x0 = Float64Array.from(known);
        const m = [1, 3, 0.3, 10, 0.1, 2][s] * Math.max(1, P.typ);
        blk.unk.forEach(v => { const k = P.vars[v].kind; x0[v] = k === 'T' ? P.tGuess[s % P.tGuess.length] : (k === 'Q' ? 0 : m); });
        const res = newton(sub, blk.unk, x0, P.typ);
        if (!res.ok) continue;
        // equations that are dependent (say the same thing twice) can be "solved" by any starting guess:
        // only accept a block whose unknowns are pinned down uniquely
        const J = sub.map(e => { const row = jacRow(e, res.x, nv); return blk.unk.map(v => row[v]); });
        if (!solveLinear(J, sub.map(() => 0))) return null;
        if (blk.unk.every(v => okVar(P, v, res.x))) return { list: blk.list, unk: blk.unk, x: res.x };
        if (!fallback) fallback = res.x;
      }
      return fallback ? { list: blk.list, unk: blk.unk, x: fallback } : null;
    }

    function findBlock() {
      // keep a numerically independent set of the remaining equations (judged at the reference point,
      // looking only at the unknown variables), preferring the shortcut equations
      const open = pool.filter(k => !done[k] && unknownsOf(eqs[k]).length > 0);
      const ordered = open.filter(isDerived).concat(open.filter(k => !isDerived(k)));
      const rows = ordered.map(k => jacRow(eqs[k], ref, nv).map((v, i) => (isNaN(known[i]) ? v : 0)));
      const keep = selectIndependent(rows).map(i => ordered[i]);
      const blk = firstBlock(keep);
      return blk ? solveBlock(blk) : null;
    }

    for (let guard = 0; guard < 2000; guard++) {
      let progressed = false;
      for (let q = 0; q < pool.length && !progressed; q++) {
        const k = pool[q];
        if (done[k]) continue;
        const e = eqs[k], U = unknownsOf(e);
        if (U.length === 0) {
          done[k] = true;
          const res = evalEq(e, known);
          if (Math.abs(res) > resTol) conflicts.push({ eq: e, residual: res, shown: substitute(P, e.text, known, -1) });
        } else if (U.length === 1) {
          const u = U[0];
          if (e.solve1) {                      // an energy balance with one unknown temperature: solved by bracketing
            const sv = e.solve1(known, u);
            if (sv) {
              done[k] = true;
              if (sv.failed) { if (P.fullyDetermined) conflicts.push({ eq: e, residual: NaN, shown: sv.failed }); continue; }
              const tv = clean(sv.value);
              steps.push({ type: 'single', title: e.label, equation: e.text, substituted: sv.substituted, lines: sv.lines, results: [{ name: P.vars[u].name, value: tv, unit: sv.unit }] });
              known[u] = tv; progressed = true;
              continue;
            }
          }
          const t = Float64Array.from(known);
          t[u] = 0; const r0 = evalEq(e, t);
          t[u] = 1; const r1 = evalEq(e, t);
          t[u] = 2; const r2 = evalEq(e, t);
          const a = r1 - r0;
          if (Math.abs(a) < 1e-12 || Math.abs(r2 - 2 * r1 + r0) > 1e-9 * (1 + Math.abs(r0) + Math.abs(r1))) continue;
          const val = clean(-r0 / a);
          const vk = P.vars[u].kind;
          const stp = {
            type: 'single', title: e.label, equation: e.text,
            substituted: e.explain ? e.explain(known, u) : substitute(P, e.text, known, u),
            results: [{ name: P.vars[u].name, value: val }]
          };
          if (vk === 'T' || vk === 'Q') stp.results[0].unit = vk === 'T' ? 'K' : 'kW';
          if (e.detail) stp.lines = e.detail(known, u);
          steps.push(stp);
          known[u] = val; done[k] = true; progressed = true;
        }
      }
      if (progressed) continue;
      const blk = findBlock();
      if (!blk) break;
      steps.push({
        type: 'block',
        title: blk.list.length === 1 ? 'Solve one equation'
          : 'Solve together' + (blk.list.some(k => eqs[k].kind === 'energy') ? ' (material and energy balances)' : '') + ': ' + blk.list.length + ' equations in ' + blk.unk.length + ' unknowns',
        equations: blk.list.map(k => ({ label: eqs[k].label, equation: eqs[k].text, substituted: eqs[k].explain ? eqs[k].explain(known, -1) : substitute(P, eqs[k].text, known, -1) })),
        results: blk.unk.map(v => ({ name: P.vars[v].name, value: clean(blk.x[v]) }))
      });
      blk.unk.forEach(v => { known[v] = clean(blk.x[v]); });
      blk.list.forEach(k => { done[k] = true; });
    }
    return { known, steps, givens, conflicts };
  }

  function analyze(model) {
    const P = build(model || {});
    const out = {
      status: 'error', headline: '', errors: P.errors.slice(), warnings: P.warnings.slice(),
      dof: null, units: [], streams: [], extents: [], givens: [], steps: [],
      redundant: [], conflicts: [], undetermined: [], free: [], values: {}, comps: P.comps || []
    };
    if (P.errors.length) { out.headline = 'The flowsheet could not be set up.'; return out; }

    const nv = P.vars.length, nS = P.streams.length;
    const coreEqs = P.eqs.slice(0, P.nCore);
    // The rank must be measured at a point where the unit equations hold, not at a random point:
    // for a splitter, the component balances only become dependent once the compositions are equal.
    const manifold = coreEqs.filter(e => e.kind !== 'spec');
    let x0 = genericPoint(P);
    const proj = projectOnto(manifold, x0, nv);
    if (maxAbs(manifold.map(e => evalEq(e, proj))) < 1e-9) x0 = proj;
    const rows = coreEqs.map(e => jacRow(e, x0, nv));
    const chosen = selectIndependent(rows);
    const rank = chosen.length;
    const chosenSet = new Set(chosen);

    out.dof = { variables: nv - nS, equations: rank - nS, dof: nv - rank, streams: nS };
    out.energy = null;
    if (P.EN) {
      // the energy variables are the temperatures and heat duties; an equation belongs to the energy part if it involves one of them
      const isE = e => e.vars.some(i => P.vars[i].kind === 'T' || P.vars[i].kind === 'Q');
      const massRows = [];
      coreEqs.forEach((e, k) => { if (!isE(e)) massRows.push(rows[k]); });
      const rankMass = selectIndependent(massRows).length;
      const nE = P.vars.filter(v => v.kind === 'T' || v.kind === 'Q').length;
      out.energy = {
        enabled: true, formation: P.EN.formation, flowUnit: P.EN.flowUnit, pressure: P.EN.P,
        species: P.comps.map((c, j) => ({ component: c, species: P.EN.species[j].id })),
        variables: nE, equations: rank - rankMass, dof: nE - (rank - rankMass),
        material: { variables: nv - nE - nS, equations: rankMass - nS, dof: nv - nE - rankMass }
      };
    }

    /* quantities the equations do not yet pin down: a value for any one of them is new information */
    out.free = [];
    if (rank < nv) {
      const basis = gramSchmidt(chosen.map(k => rows[k])).basis;
      P.vars.forEach((v, j) => {
        const e = new Array(nv).fill(0);
        e[j] = 1;
        basis.forEach(b => { const d = b[j]; for (let i = 0; i < nv; i++) e[i] -= d * b[i]; });
        let nrm = 0;
        for (let i = 0; i < nv; i++) nrm += e[i] * e[i];
        if (Math.sqrt(nrm) > 1e-6) out.free.push(v);
      });
      out.free.sort((a, b) => naturalCompare(a.stream || a.unit, b.stream || b.unit) || (a.kind === 'F' ? -1 : 0) - (b.kind === 'F' ? -1 : 0));
      out.free = out.free.map(v => v.name);
    }

    /* per-unit DOF: unit balances + sums of its streams + specifications that only involve its streams */
    P.units.forEach(u => {
      const vs = new Set();
      u.inlets.concat(u.outlets).forEach(s => {
        vs.add(P.idx['F(' + s + ')']); P.comps.forEach(c => vs.add(P.idx['n(' + c + ',' + s + ')']));
      });
      P.vars.forEach((v, i) => { if (v.kind === 'xi' && v.unit === u.name) vs.add(i); });
      if (P.EN) {
        u.inlets.concat(u.outlets).forEach(s => vs.add(P.idx['T(' + s + ')']));
        vs.add(P.idx['Q(' + u.name + ')']);
      }
      const sel = [];
      coreEqs.forEach((e, k) => { if (e.vars.every(i => vs.has(i))) sel.push(k); });
      const r = selectIndependent(sel.map(k => rows[k])).length;
      const nStr = u.inlets.length + u.outlets.length;
      out.units.push({
        name: u.name, type: u.type, label: UNIT_TYPES[u.type].label,
        inlets: u.inlets, outlets: u.outlets,
        variables: vs.size - nStr, equations: r - nStr, dof: vs.size - r
      });
    });

    /* redundant specifications: no new information on top of everything before them */
    const dependentSpecs = [];
    coreEqs.forEach((e, k) => { if (e.kind === 'spec' && !chosenSet.has(k)) dependentSpecs.push(e); });

    /* global solve (from here on a species with no data for the phase it is in is an error, not a stand-in) */
    let gx = null, negative = false, solveFailed = false;
    if (rank === nv) {
      const sub = chosen.map(k => coreEqs[k]);
      const unk = P.vars.map((_, i) => i);
      const rngS = mulberry32(777);
      const typ1 = Math.max(1, P.typ), tg = i => P.tGuess[i % P.tGuess.length];
      const starts = [1, 3, 0.3, 10, 0.1].map((m, si) => () => Float64Array.from(P.vars, v => (v.kind === 'T' ? tg(si) : (v.kind === 'Q' ? 0 : m * typ1))));
      for (let t = 0; t < 8; t++) starts.push(() => Float64Array.from(P.vars, v => (v.kind === 'T' ? tg(t) * (0.8 + 0.4 * rngS()) : (v.kind === 'Q' ? 0 : (0.2 + 2 * rngS()) * typ1))));
      // With energy balances: when the material balances alone fix every flow, solve them first, then the temperatures and
      // duties with the flows held fixed (two small, well-behaved systems). Otherwise all the unknowns go into one system.
      const isEn = e => e.vars.some(i => P.vars[i].kind === 'T' || P.vars[i].kind === 'Q');
      const isEnVar = i => P.vars[i].kind === 'T' || P.vars[i].kind === 'Q';
      const unkE = unk.filter(isEnVar), unkM = unk.filter(i => !isEnVar(i));
      const subE = sub.filter(isEn), subM = sub.filter(e => !isEn(e));
      const staged = !!P.EN && subM.length === unkM.length && subE.length === unkE.length;
      let fallback = null;
      for (let s = 0; s < starts.length; s++) {
        let res;
        if (staged) {
          const r1 = newton(subM, unkM, starts[s](), P.typ);
          if (!r1.ok) continue;
          res = null;
          for (let g = 0; g < P.tGuess.length && !res; g++) {
            const x2 = Float64Array.from(r1.x);
            unkE.forEach(i => { x2[i] = P.vars[i].kind === 'T' ? tg(g) : 0; });
            const r2 = newton(subE, unkE, x2, P.typ);
            if (r2.ok) res = r2;
          }
          if (!res) continue;
        } else res = newton(sub, unk, starts[s](), P.typ);
        if (!res.ok) continue;
        const nonneg = unk.every(i => okVar(P, i, res.x));
        if (nonneg) { gx = res.x; break; }
        if (!fallback) fallback = res.x;
      }
      if (!gx && fallback) { gx = fallback; negative = true; }
      if (!gx) solveFailed = true;
    }

    /* conflicts from redundant specs, evaluated at the solution of the rest */
    const conflictList = [];
    if (gx) {
      const tol = 1e-7 * Math.max(1, P.typ);
      dependentSpecs.forEach(e => {
        if (Math.abs(evalEq(e, gx)) > tol) conflictList.push({ spec: P.specs[e.specIndex], label: e.label, shown: substitute(P, e.text, gx, -1) });
      });
    }

    /* an underspecified but purely linear problem can still be contradictory: check it exactly */
    if (!gx && rank < nv && dependentSpecs.length && coreEqs.every(e => !e.prods.length)) {
      const xp = projectOnto(chosen.map(k => coreEqs[k]), x0, nv);
      dependentSpecs.forEach(e => {
        if (Math.abs(evalEq(e, xp)) > 1e-7 * Math.max(1, P.typ)) conflictList.push({ spec: P.specs[e.specIndex], label: e.label, shown: '' });
      });
    }

    /* step-by-step */
    P.fullyDetermined = rank === nv;
    const pr = propagate(P, gx || x0);
    out.givens = pr.givens;
    out.steps = pr.steps;
    pr.conflicts.forEach(c => {
      if (!conflictList.some(k => k.label === c.eq.label)) {
        conflictList.push({ spec: c.eq.specIndex !== undefined ? P.specs[c.eq.specIndex] : null, label: c.eq.label, shown: c.shown });
      }
    });

    let known = pr.known;
    const allKnown = Array.prototype.every.call(known, v => !isNaN(v));
    if (gx && !conflictList.length && !allKnown) {
      // some equations must be solved together; show the remaining ones as one block
      const unk = [], list = [];
      for (let i = 0; i < nv; i++) if (isNaN(known[i])) unk.push(i);
      const eqsLeft = [];
      chosen.forEach(k => { if (coreEqs[k].vars.some(i => isNaN(known[i]))) eqsLeft.push(coreEqs[k]); });
      out.steps.push({
        type: 'block', title: 'Solve together: the remaining ' + unk.length + ' unknowns',
        equations: eqsLeft.map(e => ({ label: e.label, equation: e.text, substituted: substitute(P, e.text, known, -1) })),
        results: unk.map(i => ({ name: P.vars[i].name, value: Math.abs(gx[i]) < 1e-10 * Math.max(1, P.typ) ? 0 : gx[i] }))
      });
      known = Float64Array.from(known);
      unk.forEach(i => { known[i] = Math.abs(gx[i]) < 1e-10 * Math.max(1, P.typ) ? 0 : gx[i]; });
    }
    const finalKnown = (gx && !conflictList.length) ? (gx.map((v, i) => (isNaN(known[i]) ? v : known[i]))) : known;

    /* energy: a species that is present must have data for the phase and temperature it is used at */
    const dataErrors = (P.EN && gx && !conflictList.length && rank === nv) ? P.dataProblems(finalKnown, P.typ) : [];
    if (dataErrors.length) dataErrors.forEach(m => out.errors.push(m));

    /* status */
    if (dataErrors.length) {
      out.status = 'failed';
      out.headline = 'The energy balance needs data that is missing. Add it on the Data tab of the Energy page, or choose another phase for the stream.';
    } else if (conflictList.length) {
      out.status = 'inconsistent';
      out.conflicts = conflictList;
      out.headline = 'The specifications contradict each other.';
    } else if (solveFailed) {
      out.status = 'failed';
      out.headline = 'The problem is fully specified, but no valid solution was found.' + (P.EN ? ' For the energy balance, check that every species has heat capacity (and latent heat) data for the phase it is in at those temperatures.' : '');
    } else if (rank === nv) {
      out.status = 'solved';
      out.headline = 'Fully specified: 0 degrees of freedom. Solved.';
    } else {
      out.status = 'underspecified';
      out.headline = 'Underspecified: ' + (nv - rank) + ' degree' + (nv - rank === 1 ? '' : 's') + ' of freedom. Give ' + (nv - rank) + ' more independent specification' + (nv - rank === 1 ? '' : 's') + '.';
    }
    if (dependentSpecs.length && !conflictList.length) {
      dependentSpecs.forEach(e => out.redundant.push(e.label.replace(/^Specification: /, '')));
      out.warnings.push('Redundant: ' + (dependentSpecs.length === 1 ? 'one specification adds' : dependentSpecs.length + ' specifications add') + ' no new information, so ' + (dependentSpecs.length === 1 ? 'it is' : 'they are') + ' not needed (' + out.redundant.join('; ') + ').');
    }
    if (negative) out.warnings.push('Some flows came out negative. Check the specifications: a flow cannot be negative.');
    if (P.EN && gx && !conflictList.length && !dataErrors.length && rank === nv) P.rangeWarnings(finalKnown, P.typ).forEach(m => out.warnings.push(m));

    /* values */
    const solved = out.status === 'solved';
    const useVals = (solved || out.status === 'underspecified') ? finalKnown : null;
    const val = i => {
      if (!useVals) return null;
      const v = useVals[i];
      return isNaN(v) ? null : (Math.abs(v) < 1e-10 * Math.max(1, P.typ) ? 0 : v);
    };
    P.vars.forEach((v, i) => { out.values[v.name] = val(i); });
    out.streams = P.streams.map(st => {
      const F = out.values['F(' + st.name + ')'];
      const comps = {};
      P.comps.forEach(c => {
        const n = out.values['n(' + c + ',' + st.name + ')'];
        comps[c] = { n, x: (n !== null && F !== null && F > 1e-12) ? n / F : null };
      });
      const rec = { name: st.name, kind: st.kind, from: st.from, to: st.to, F, comps };
      if (P.EN) { rec.T = out.values['T(' + st.name + ')']; rec.H = useVals ? P.streamH(useVals, st.name) : null; rec.phase = P.EN.phases[st.name]; }
      return rec;
    }).sort((a, b) => naturalCompare(a.name, b.name));
    if (P.EN) out.units.forEach(u => { u.Q = out.values['Q(' + u.name + ')']; });
    out.extents = P.vars.filter(v => v.kind === 'xi').map(v => ({ name: v.name, unit: v.unit, value: out.values[v.name] }));
    out.undetermined = P.vars.filter((v, i) => useVals && v.kind !== 'F' && isNaN(useVals[i])).map(v => v.name)
      .concat(P.vars.filter((v, i) => useVals && v.kind === 'F' && isNaN(useVals[i])).map(v => v.name));
    if (solved) {
      P.streams.forEach(st => {
        const F = out.values['F(' + st.name + ')'];
        if (F !== null && F < 1e-9 * Math.max(1, P.typ)) out.warnings.push('Stream ' + st.name + ' has zero flow. Check the specifications.');
      });
    }
    return out;
  }

  /* ───────────────────────── worked examples (also used by the tests) ───────────────────────── */

  const EXAMPLES = [
    {
      id: 'mixer', title: 'Mixing two streams',
      description: 'Stream 1 (100 kg/h, 20% ethanol) is mixed with stream 2 (50 kg/h, 60% ethanol). Find the product.',
      model: {
        components: ['Ethanol', 'Water'],
        units: [{ name: 'M1', type: 'mixer', inlets: 'S1, S2', outlets: 'S3' }],
        specs: [
          { type: 'flow', stream: 'S1', value: 100 }, { type: 'frac', stream: 'S1', comp: 'Ethanol', value: 0.2 },
          { type: 'flow', stream: 'S2', value: 50 },  { type: 'frac', stream: 'S2', comp: 'Ethanol', value: 0.6 }
        ]
      },
      expect: { 'F(S3)': 150, 'n(Ethanol,S3)': 50, 'n(Water,S3)': 100 }
    },
    {
      id: 'column', title: 'Distillation column',
      description: 'A 100 kmol/h feed, 50% benzene, is split into a 95% benzene distillate and a 5% benzene bottoms. Find the two product flows.',
      model: {
        components: ['Benzene', 'Toluene'],
        units: [{ name: 'COL', type: 'separator', inlets: 'S1', outlets: 'S2, S3' }],
        specs: [
          { type: 'flow', stream: 'S1', value: 100 }, { type: 'frac', stream: 'S1', comp: 'Benzene', value: 0.5 },
          { type: 'frac', stream: 'S2', comp: 'Benzene', value: 0.95 }, { type: 'frac', stream: 'S3', comp: 'Benzene', value: 0.05 }
        ]
      },
      expect: { 'F(S2)': 50, 'F(S3)': 50, 'n(Benzene,S2)': 47.5, 'n(Benzene,S3)': 2.5 }
    },
    {
      id: 'splitter', title: 'Splitting a stream',
      description: '100 mol/s of 30% A is divided into two streams. Stream 2 carries 40 mol/s. Both have the feed composition.',
      model: {
        components: ['A', 'B'],
        units: [{ name: 'SP', type: 'splitter', inlets: 'S1', outlets: 'S2, S3' }],
        specs: [
          { type: 'flow', stream: 'S1', value: 100 }, { type: 'frac', stream: 'S1', comp: 'A', value: 0.3 },
          { type: 'flow', stream: 'S2', value: 40 }
        ]
      },
      expect: { 'n(A,S2)': 12, 'n(B,S2)': 28, 'F(S3)': 60, 'n(A,S3)': 18 }
    },
    {
      id: 'reactor', title: 'Reactor with conversion',
      description: 'N₂ + 3 H₂ → 2 NH₃. The feed is 100 mol/min N₂ and 300 mol/min H₂. Conversion of N₂ is 25%.',
      model: {
        components: ['N2', 'H2', 'NH3'],
        units: [{ name: 'R1', type: 'reactor', inlets: 'S1', outlets: 'S2', reaction: 'N2 + 3 H2 -> 2 NH3' }],
        specs: [
          { type: 'compflow', stream: 'S1', comp: 'N2', value: 100 }, { type: 'compflow', stream: 'S1', comp: 'H2', value: 300 },
          { type: 'compflow', stream: 'S1', comp: 'NH3', value: 0 }, { type: 'conversion', unit: 'R1', comp: 'N2', value: 0.25 }
        ]
      },
      expect: { 'ξ(R1)': 25, 'n(NH3,S2)': 50, 'n(N2,S2)': 75, 'n(H2,S2)': 225 }
    },
    {
      id: 'recycle', title: 'Reactor with recycle',
      description: 'A → B. Fresh feed is 100 mol/h of pure A. Conversion in the reactor is 50% per pass. The separator sends all B to product and all unreacted A back to the mixer.',
      model: {
        components: ['A', 'B'],
        units: [
          { name: 'M1', type: 'mixer', inlets: 'S1, S5', outlets: 'S2' },
          { name: 'R1', type: 'reactor', inlets: 'S2', outlets: 'S3', reaction: 'A -> B' },
          { name: 'SEP', type: 'separator', inlets: 'S3', outlets: 'S4, S5' }
        ],
        specs: [
          { type: 'compflow', stream: 'S1', comp: 'A', value: 100 }, { type: 'compflow', stream: 'S1', comp: 'B', value: 0 },
          { type: 'conversion', unit: 'R1', comp: 'A', value: 0.5 },
          { type: 'recovery', stream: 'S4', comp: 'B', value: 1 }, { type: 'compflow', stream: 'S4', comp: 'A', value: 0 }
        ]
      },
      expect: { 'F(S2)': 200, 'n(A,S5)': 100, 'n(B,S4)': 100, 'ξ(R1)': 100, 'F(S3)': 200 }
    },
    {
      id: 'purge', title: 'Recycle with a purge',
      description: 'As above, but the fresh feed has 5 mol/h of inert I. The separator sends all B to product and everything else overhead. A tenth of the overhead is purged and the rest is recycled.',
      model: {
        components: ['A', 'B', 'I'],
        units: [
          { name: 'M1', type: 'mixer', inlets: 'S1, S7', outlets: 'S2' },
          { name: 'R1', type: 'reactor', inlets: 'S2', outlets: 'S3', reaction: 'A -> B' },
          { name: 'SEP', type: 'separator', inlets: 'S3', outlets: 'S4, S5' },
          { name: 'SP', type: 'splitter', inlets: 'S5', outlets: 'S6, S7' }
        ],
        specs: [
          { type: 'compflow', stream: 'S1', comp: 'A', value: 100 }, { type: 'compflow', stream: 'S1', comp: 'B', value: 0 },
          { type: 'compflow', stream: 'S1', comp: 'I', value: 5 },
          { type: 'conversion', unit: 'R1', comp: 'A', value: 0.6 },
          { type: 'recovery', stream: 'S4', comp: 'B', value: 1 },
          { type: 'compflow', stream: 'S4', comp: 'A', value: 0 }, { type: 'compflow', stream: 'S4', comp: 'I', value: 0 },
          { type: 'splitfrac', stream: 'S6', value: 0.1 }
        ]
      },
      expect: { 'n(B,S4)': 93.75, 'n(A,S7)': 56.25, 'n(I,S7)': 45, 'F(S6)': 11.25, 'ξ(R1)': 93.75, 'n(I,S6)': 5 }
    }
  ];

  /* ───────────────────────── worked examples with energy balances (kept apart from EXAMPLES: those are mass balances only) ─────────────────────────
     Temperatures are in K and duties in kW, as in the model. Every answer was worked out by hand (see tests/balance.test.js). */

  const ENERGY_EXAMPLES = [
    {
      id: 'e-heater', title: 'Heating a water stream',
      description: 'Liquid water, 1 mol/s at 25 °C, is heated to 80 °C. How much heat does the heater supply? (Cp of liquid water 75.4 J/(mol·K): Q = 75.4 × 55 = 4147 W.)',
      model: {
        components: ['H2O'],
        units: [{ name: 'H1', type: 'unit', inlets: 'S1', outlets: 'S2' }],
        specs: [{ type: 'flow', stream: 'S1', value: 1 }, { type: 'temp', stream: 'S1', value: 298.15 }, { type: 'temp', stream: 'S2', value: 353.15 }],
        energy: { flowUnit: { type: 'mol', factor: 1 } }
      },
      expect: { 'Q(H1)': 4.147, 'F(S2)': 1 }
    },
    {
      id: 'e-mixer', title: 'Mixing hot and cold water',
      description: '1 mol/s of water at 80 °C is mixed with 3 mol/s at 20 °C in an adiabatic mixer. Find the temperature of the mixture. (The Cp of liquid water is constant here, so T = (1 × 80 + 3 × 20)/4 = 35 °C.)',
      model: {
        components: ['H2O'],
        units: [{ name: 'M1', type: 'mixer', inlets: 'S1, S2', outlets: 'S3' }],
        specs: [
          { type: 'flow', stream: 'S1', value: 1 }, { type: 'flow', stream: 'S2', value: 3 },
          { type: 'temp', stream: 'S1', value: 353.15 }, { type: 'temp', stream: 'S2', value: 293.15 }, { type: 'adiabatic', unit: 'M1' }
        ],
        energy: { flowUnit: { type: 'mol', factor: 1 } }
      },
      expect: { 'T(S3)': 308.15, 'F(S3)': 4, 'Q(M1)': 0 }
    },
    {
      id: 'e-exchanger', title: 'Cooling a gas with water (heat exchanger)',
      description: '10 mol/s of nitrogen is cooled from 200 °C to 50 °C by cooling water that enters at 25 °C and leaves at 45 °C. The exchanger loses no heat. How much water is needed? The water flow is found from the energy balance: 10 × 4.4051 kJ/mol = F × 1.508 kJ/mol, so F = 29.21 mol/s.',
      model: {
        components: ['N2', 'H2O'],
        units: [{ name: 'HX', type: 'unit', inlets: 'S1, S3', outlets: 'S2, S4' }],
        specs: [
          { type: 'compflow', stream: 'S1', comp: 'N2', value: 10 }, { type: 'compflow', stream: 'S1', comp: 'H2O', value: 0 },
          { type: 'compflow', stream: 'S3', comp: 'N2', value: 0 }, { type: 'compflow', stream: 'S2', comp: 'H2O', value: 0 }, { type: 'compflow', stream: 'S4', comp: 'N2', value: 0 },
          { type: 'temp', stream: 'S1', value: 473.15 }, { type: 'temp', stream: 'S2', value: 323.15 },
          { type: 'temp', stream: 'S3', value: 298.15 }, { type: 'temp', stream: 'S4', value: 318.15 }, { type: 'adiabatic', unit: 'HX' }
        ],
        energy: { flowUnit: { type: 'mol', factor: 1 }, phases: { S1: 'g', S2: 'g', S3: 'l', S4: 'l' } }
      },
      expect: { 'F(S3)': 29.211606173325592, 'F(S4)': 29.211606173325592, 'n(H2O,S3)': 29.211606173325592 }
    },
    {
      id: 'e-flame', title: 'Adiabatic flame temperature of methane',
      description: 'Methane burns completely with the theoretical amount of air (21% O₂, 79% N₂), both fed at 25 °C, in an adiabatic reactor. Find the temperature of the product gas. The reference state is the elements at 25 °C, so the heats of formation are included; the water is formed as a liquid at 25 °C and leaves as steam.',
      model: {
        components: ['CH4', 'O2', 'N2', 'CO2', 'H2O'],
        units: [{ name: 'R1', type: 'reactor', inlets: 'S1', outlets: 'S2', reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O' }],
        specs: [
          { type: 'compflow', stream: 'S1', comp: 'CH4', value: 1 }, { type: 'compflow', stream: 'S1', comp: 'O2', value: 2 },
          { type: 'compflow', stream: 'S1', comp: 'N2', value: 7.5238 }, { type: 'compflow', stream: 'S1', comp: 'CO2', value: 0 }, { type: 'compflow', stream: 'S1', comp: 'H2O', value: 0 },
          { type: 'conversion', unit: 'R1', comp: 'CH4', value: 1 }, { type: 'temp', stream: 'S1', value: 298.15 }, { type: 'adiabatic', unit: 'R1' }
        ],
        energy: { flowUnit: { type: 'mol', factor: 1 }, phases: { S2: 'g' } }
      },
      expect: { 'T(S2)': 2346.2540902421465, 'n(H2O,S2)': 2, 'n(CO2,S2)': 1, 'F(S2)': 10.5238 }
    },
    {
      id: 'e-burner', title: 'Methane burner cooled back to 25 °C',
      description: '1 mol/s of methane burns completely in 2 mol/s of oxygen. The feed and the products (liquid water and CO₂) are all at 25 °C. How much heat is removed? It is the heat of reaction: ΔH°rxn = −393.5 + 2(−285.84) − (−74.85) = −890.33 kJ per mole of methane, so Q = −890.33 kW.',
      model: {
        components: ['CH4', 'O2', 'CO2', 'H2O'],
        units: [{ name: 'R1', type: 'reactor', inlets: 'S1', outlets: 'S2', reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O' }],
        specs: [
          { type: 'compflow', stream: 'S1', comp: 'CH4', value: 1 }, { type: 'compflow', stream: 'S1', comp: 'O2', value: 2 },
          { type: 'compflow', stream: 'S1', comp: 'CO2', value: 0 }, { type: 'compflow', stream: 'S1', comp: 'H2O', value: 0 },
          { type: 'conversion', unit: 'R1', comp: 'CH4', value: 1 }, { type: 'temp', stream: 'S1', value: 298.15 }, { type: 'isothermal', unit: 'R1' }
        ],
        energy: { flowUnit: { type: 'mol', factor: 1 } }
      },
      expect: { 'Q(R1)': -890.33, 'T(S2)': 298.15 }
    }
  ];

  return { analyze, parseList, parseReaction, specLabel, UNIT_TYPES, SPEC_TYPES, ENERGY_SPEC_TYPES, EXAMPLES, ENERGY_EXAMPLES, num };
});
