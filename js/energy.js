/*
 * Energy balances for process engineering: heat capacity and sensible heat, phase change, heats of
 * formation / reaction / combustion, adiabatic reactor and flame temperature, steady open-system balance.
 * Plain deterministic code: no AI, no network, no dependencies other than js/chem.js (units, Antoine data)
 * and parseReaction from js/balance.js. Works in the browser (window.Energy) and in Node (module.exports).
 *
 * Conventions
 *   - Temperatures are in K inside the library (Energy.toK / Energy.toC convert). The pages convert with Chem.convert.
 *   - Amounts are in mol and flows in mol/s, energies in kJ and powers in kW (kJ/mol × mol/s = kW).
 *   - Heat capacity is Cp = a + b·T + c·T² + d·T³ in J/(mol·K). The polynomial's T is in °C or in K: each
 *     data record says which (Tunit). Coefficients are stored as plain numbers, in these units.
 *   - Every calculation returns its working as steps: { title, equations: [{ label, equation, substituted }],
 *     results: [{ name, value, unit }] }, like the "Solution, step by step" of the mass balance page.
 *   - Reference states. For a species on its own the enthalpy is measured from the species as it exists at
 *     25 °C and 1 atm (its standard phase). For a reacting system it is measured from the elements at 25 °C,
 *     so the enthalpy of a species is its heat of formation plus the path from 25 °C to the stream state.
 *   - Pressure only matters for the boiling point (Antoine data shifts it). Enthalpy changes with pressure
 *     are neglected (ideal gas, incompressible liquid), as in a first course.
 *
 * Data. Everything in SPECIES comes from the tables in Felder & Rousseau, "Elementary Principles of Chemical
 * Processes", Appendix B (Table B.1 physical properties, Table B.2 heat capacities), and is cross-checked in
 * tests/energy.test.js against NIST-JANAF tables and standard handbook values. They are typical published
 * values: textbooks differ in the last digit, so check them against your course table, or type your own.
 */
(function (root, factory) {
  const getBalance = () => (typeof require === 'function' ? require('./balance.js') : root.Balance);
  if (typeof module === 'object' && module.exports) {
    const mod = module;                  // the JXA test runner swaps the global `module` while it loads a dependency
    const Chem = require('./chem.js');
    module = mod;
    mod.exports = factory(Chem, getBalance);
  } else root.Energy = factory(root.Chem, getBalance);
})(typeof self !== 'undefined' ? self : this, function (Chem, getBalance) {
  'use strict';

  const R = 8.314462618;        // J/(mol·K)
  const T0 = 298.15;            // K, the reference temperature, 25 °C
  const P0 = 101.325;           // kPa, 1 atm
  const GRAV = 9.80665;         // m/s²
  const toK = c => c + 273.15;
  const toC = k => k - 273.15;
  const PHASES = ['s', 'l', 'g'];
  const PHASE_NAME = { s: 'solid', l: 'liquid', g: 'gas' };

  /* ───────────────────────── formatting ───────────────────────── */

  const fmt = (x, n) => Chem.fmt(x, n || 5);
  const par = (x, n) => (x < 0 ? '(' + fmt(x, n) + ')' : fmt(x, n));
  const sup = k => ['', '', '²', '³', '⁴'][k];
  const tText = K => fmt(toC(K), 6) + ' °C';
  const label = (sp, ph) => sp.id + '(' + ph + ')';
  const step = (title, equations, results) => ({ title, equations: equations || [], results: results || [] });
  const newCtx = () => ({ warnings: [], notes: [] });
  const addWarn = (ctx, msg) => { if (ctx.warnings.indexOf(msg) < 0) ctx.warnings.push(msg); };
  const addNote = (ctx, msg) => { if (ctx.notes.indexOf(msg) < 0) ctx.notes.push(msg); };

  /* ───────────────────────── formulas and molar masses ───────────────────────── */

  // IUPAC standard atomic weights, rounded to the precision used in handbooks.
  const ATOMIC_WEIGHT = {
    H: 1.008, He: 4.0026, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Ne: 20.180, Na: 22.990, Mg: 24.305,
    Al: 26.982, Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, Ar: 39.948, K: 39.098, Ca: 40.078, Fe: 55.845,
    Cu: 63.546, Zn: 65.38, Br: 79.904, I: 126.904
  };

  /* "C2H5OH" → { C: 2, H: 6, O: 1 };  "Ca(OH)2" → { Ca: 1, O: 2, H: 2 }.  A trailing (g)/(l)/(s) is ignored. */
  function parseFormula(formula) {
    const s = String(formula).trim().replace(/\((g|l|s|c)\)$/, '');
    if (!s) throw new Error('Enter a formula such as CH4 or C2H5OH.');
    let i = 0;
    const mult = () => {
      let j = i;
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
      const m = j > i ? Number(s.slice(i, j)) : 1;
      i = j;
      return m;
    };
    function group(closing) {
      const out = {};
      while (i < s.length) {
        const ch = s[i];
        if (ch === '(') {
          i++;
          const sub = group(true), m = mult();
          Object.keys(sub).forEach(k => { out[k] = (out[k] || 0) + sub[k] * m; });
        } else if (ch === ')') {
          if (!closing) throw new Error('Unmatched ) in "' + s + '".');
          i++;
          return out;
        } else if (ch >= 'A' && ch <= 'Z') {
          let el = ch; i++;
          if (i < s.length && s[i] >= 'a' && s[i] <= 'z') { el += s[i]; i++; }
          out[el] = (out[el] || 0) + mult();
        } else throw new Error('Cannot read the formula "' + s + '" (unexpected "' + ch + '").');
      }
      if (closing) throw new Error('Missing ) in "' + s + '".');
      return out;
    }
    return group(false);
  }

  function molarMass(formula) {
    const atoms = parseFormula(formula);
    let M = 0;
    Object.keys(atoms).forEach(el => {
      if (ATOMIC_WEIGHT[el] === undefined) throw new Error('No atomic weight for ' + el + '. Type the molar mass M instead.');
      M += ATOMIC_WEIGHT[el] * atoms[el];
    });
    return M;
  }

  /* ───────────────────────── heat capacity polynomials ───────────────────────── */

  /* Coefficients as printed in a table → plain coefficients in J/(mol·K).
     Tables print "a × 10^3, b × 10^5, ..." so the number to type is  actual × 10^exp.  exps = [3, 5, 8, 12] and
     energy 'kJ' is the layout of Felder's Table B.2:  Cp in kJ/(mol·°C) = a + bT + cT² + dT³. */
  function scaleCoefficients(printed, exps, energy) {
    const k = energy === 'kJ' ? 1000 : 1;
    const e = exps || [0, 0, 0, 0];
    const out = {};
    ['a', 'b', 'c', 'd'].forEach((key, i) => {
      const v = printed[key];
      out[key] = (v === undefined || v === null || v === '' || !isFinite(v)) ? 0 : Number(v) * Math.pow(10, -e[i]) * k;
    });
    return out;
  }

  const FELDER = [3, 5, 8, 12];
  /* Felder Table B.2, gases: Cp [kJ/(mol·°C)], a·10³, b·10⁵, c·10⁸, d·10¹², T in °C. Range in °C. */
  const gasCp = (a, b, c, d, Tmin, Tmax) =>
    Object.assign(scaleCoefficients({ a, b, c, d }, FELDER, 'kJ'), { Tunit: 'C', Tmin, Tmax });
  /* Liquids: Cp = a + b·T, with a in J/(mol·°C) and b in J/(mol·°C²) written as printed in Table B.2 (a·10³, b·10⁵ in kJ). */
  const liqCp = (a, b, Tmin, Tmax) =>
    Object.assign(scaleCoefficients({ a, b }, FELDER, 'kJ'), { Tunit: 'C', Tmin, Tmax });

  function cpAt(cp, T) {
    const u = cp.Tunit === 'K' ? T : T - 273.15;
    return cp.a + (cp.b || 0) * u + (cp.c || 0) * u * u + (cp.d || 0) * u * u * u;
  }
  /* ∫Cp dT from Ta to Tb (K), in kJ/mol. */
  function integrateCp(cp, Ta, Tb) {
    const shift = cp.Tunit === 'K' ? 0 : 273.15;
    const ua = Ta - shift, ub = Tb - shift;
    const co = [cp.a, cp.b || 0, cp.c || 0, cp.d || 0];
    let J = 0;
    for (let k = 0; k < 4; k++) J += co[k] / (k + 1) * (Math.pow(ub, k + 1) - Math.pow(ua, k + 1));
    return J / 1000;
  }
  const inRange = (cp, T) => {
    const u = cp.Tunit === 'K' ? T : T - 273.15;
    return !((cp.Tmin !== undefined && cp.Tmin !== null && u < cp.Tmin - 1e-9) ||
             (cp.Tmax !== undefined && cp.Tmax !== null && u > cp.Tmax + 1e-9));
  };

  /* ───────────────────────── built-in data ───────────────────────── */

  const SPECIES = {};
  /* Adds a species. Temperatures in the arguments are in °C as printed in the table; stored in K.
     Hf / Hc: heat of formation / combustion at 25 °C and 1 atm, kJ/mol, by phase.
     Hc is Felder's tabulated heat of combustion (CO2(g), H2O(l) as products); the code computes its own from Hf
     and the tests compare the two. */
  function add(id, name, o) {
    SPECIES[id] = {
      id, name, formula: o.formula || id, M: o.M !== undefined ? o.M : molarMass(o.formula || id),
      std: o.std || 'g',
      Tm: o.Tm === undefined || o.Tm === null ? null : toK(o.Tm), Hfus: o.Hfus === undefined ? null : o.Hfus,
      Tb: o.Tb === undefined || o.Tb === null ? null : toK(o.Tb), Hvap: o.Hvap === undefined ? null : o.Hvap,
      Tc: o.Tc === undefined ? null : o.Tc,
      antoine: o.antoine || null,
      Hf: o.Hf || {}, Hc: o.Hc || {}, Cp: o.Cp || {}, note: o.note || ''
    };
  }

  // Source of every row below: Felder & Rousseau, Elementary Principles of Chemical Processes, 3rd ed.,
  // Appendix B: Table B.1 (Tm, ΔHm, Tb, ΔHv, Tc, ΔHf°, ΔHc°) and Table B.2 (Cp polynomials, T in °C).
  // Critical temperatures Tc in K, as printed.

  // Permanent gases and air
  add('N2', 'Nitrogen', { Tm: -210.0, Hfus: 0.720, Tb: -195.8, Hvap: 5.577, Tc: 126.20, Hf: { g: 0 },
    Cp: { g: gasCp(29.00, 0.2199, 0.5723, -2.871, 0, 1500) } });
  add('O2', 'Oxygen', { Tm: -218.75, Hfus: 0.444, Tb: -182.97, Hvap: 6.82, Tc: 154.4, Hf: { g: 0 },
    Cp: { g: gasCp(29.10, 1.158, -0.6076, 1.311, 0, 1500) } });
  add('H2', 'Hydrogen', { Tm: -259.19, Hfus: 0.12, Tb: -252.76, Hvap: 0.904, Tc: 33.3, Hf: { g: 0 }, Hc: { g: -285.84 },
    Cp: { g: gasCp(28.84, 0.00765, 0.3288, -0.8698, 0, 1500) } });
  add('CO', 'Carbon monoxide', { Tm: -205.1, Hfus: 0.837, Tb: -191.5, Hvap: 6.042, Tc: 133.0, Hf: { g: -110.52 }, Hc: { g: -282.99 },
    Cp: { g: gasCp(28.95, 0.4110, 0.3548, -2.220, 0, 1500) } });
  // CO2 sublimes at 1 atm (no normal boiling point): it is treated as a gas at every temperature.
  add('CO2', 'Carbon dioxide', { Tc: 304.2, Hf: { g: -393.5 },
    Cp: { g: gasCp(36.11, 4.233, -2.887, 7.464, 0, 1500) } });
  // Dry air as one species. M = 28.96 g/mol (standard dry air); Cp from Table B.2.
  add('air', 'Air (dry)', { formula: 'air', M: 28.96, Cp: { g: gasCp(28.94, 0.4147, 0.3191, -1.965, 0, 1500) } });
  // Graphite: heat of formation and combustion only (no Cp in the built-in table; add one if you need to heat it).
  add('C', 'Carbon (graphite)', { std: 's', Tm: 3600, Hfus: 46.0, Hf: { s: 0 }, Hc: { s: -393.51 } });

  // Water. Table B.1 gives ΔHf = −285.84 (l), −241.83 (g), ΔHv = 40.656 kJ/mol at 100 °C, ΔHm = 6.0095 at 0 °C.
  // Table B.2: liquid Cp = 75.4 J/(mol·°C) (0–100 °C). The ice Cp is NOT from Table B.2: 37.8 J/(mol·K) is an
  // approximate value near 0 °C (about 2.10 J/(g·K), IAPWS ice release); replace it with your own table value.
  add('H2O', 'Water', { std: 'l', Tm: 0.00, Hfus: 6.0095, Tb: 100.00, Hvap: 40.656, Tc: 647.4, antoine: 'water',
    Hf: { l: -285.84, g: -241.83 },
    Cp: { s: { a: 37.8, b: 0, c: 0, d: 0, Tunit: 'C', Tmin: -20, Tmax: 0 }, l: liqCp(75.4, 0, 0, 100),
           g: gasCp(33.46, 0.6880, 0.7604, -3.593, 0, 1500) },
    note: 'Ice Cp is approximate (not from Table B.2).' });

  // Fuels and hydrocarbons (gases at 25 °C unless noted)
  add('CH4', 'Methane', { Tm: -182.5, Hfus: 0.94, Tb: -161.5, Hvap: 8.179, Tc: 190.70, Hf: { g: -74.85 }, Hc: { g: -890.36 },
    Cp: { g: gasCp(34.31, 5.469, 0.3661, -11.00, 0, 1200) } });
  add('NH3', 'Ammonia', { Tm: -77.8, Hfus: 5.653, Tb: -33.43, Hvap: 23.351, Tc: 405.5, Hf: { l: -67.20, g: -46.19 }, Hc: { g: -382.58 },
    Cp: { g: gasCp(35.15, 2.954, 0.4421, -6.686, 0, 1200) } });
  add('C2H6', 'Ethane', { Tm: -183.3, Hfus: 2.859, Tb: -88.6, Hvap: 14.72, Tc: 305.4, Hf: { g: -84.67 }, Hc: { g: -1559.9 },
    Cp: { g: gasCp(49.37, 13.92, -5.816, 7.280, 0, 1200) } });
  add('C3H8', 'Propane', { Tm: -187.69, Hfus: 3.52, Tb: -42.07, Hvap: 18.77, Tc: 369.9, Hf: { l: -119.8, g: -103.8 }, Hc: { l: -2204.0, g: -2220.0 },
    Cp: { g: gasCp(68.032, 22.59, -13.11, 31.71, 0, 1200) } });
  add('C4H10', 'n-Butane', { Tm: -138.3, Hfus: 4.661, Tb: -0.6, Hvap: 22.305, Tc: 425.17, Hf: { l: -147.0, g: -124.7 }, Hc: { l: -2855.6, g: -2878.5 },
    Cp: { g: gasCp(92.30, 27.88, -15.47, 34.98, 0, 1200) } });
  add('C2H4', 'Ethylene', { Tm: -169.2, Hfus: 3.350, Tb: -103.7, Hvap: 13.54, Tc: 283.1, Hf: { g: 52.28 }, Hc: { g: -1410.99 },
    Cp: { g: gasCp(40.75, 11.47, -6.891, 17.66, 0, 1200) } });
  // Acetylene sublimes near its normal "boiling point": no phase change data, treated as a gas.
  add('C2H2', 'Acetylene', { Tc: 309.5, Hf: { g: 226.75 }, Hc: { g: -1299.6 },
    Cp: { g: gasCp(42.43, 6.053, -5.033, 18.20, 0, 1200) } });

  // Common solvents. Liquid Cp from Table B.2 (a + b·T over the stated range; the n-hexane value is a mean over
  // 20–100 °C; ethanol is a straight line through Felder's two values, 103.1 J/(mol·°C) at 0 °C and 158.8 at 100 °C).
  // Antoine keys refer to Chem.COMPOUNDS and only shift the boiling point with pressure.
  add('CH3OH', 'Methanol', { std: 'l', Tm: -97.9, Hfus: 3.167, Tb: 64.7, Hvap: 35.27, Tc: 513.20, antoine: 'methanol',
    Hf: { l: -238.6, g: -201.2 }, Hc: { l: -726.6, g: -764.0 },
    Cp: { l: liqCp(75.86, 16.83, 0, 65), g: gasCp(42.93, 8.301, -1.87, -8.03, 0, 700) } });
  add('C2H5OH', 'Ethanol', { std: 'l', Tm: -114.6, Hfus: 5.021, Tb: 78.5, Hvap: 38.58, Tc: 516.3, antoine: 'ethanol',
    Hf: { l: -277.63, g: -235.31 }, Hc: { l: -1366.91, g: -1409.25 },
    Cp: { l: { a: 103.1, b: (158.8 - 103.1) / 100, c: 0, d: 0, Tunit: 'C', Tmin: 0, Tmax: 100 }, g: gasCp(61.34, 15.72, -8.749, 19.83, 0, 1200) },
    note: 'Liquid Cp is a straight line through two tabulated values.' });
  add('C3H6O', 'Acetone', { std: 'l', Tm: -95.0, Hfus: 5.69, Tb: 56.0, Hvap: 30.2, Tc: 508.0, antoine: 'acetone',
    Hf: { l: -248.2, g: -216.7 }, Hc: { l: -1785.7, g: -1821.4 },
    Cp: { l: liqCp(123.0, 18.6, -30, 60), g: gasCp(71.96, 20.10, -12.78, 34.76, 0, 1200) } });
  add('C6H6', 'Benzene', { std: 'l', Tm: 5.53, Hfus: 9.837, Tb: 80.10, Hvap: 30.765, Tc: 562.6, antoine: 'benzene',
    Hf: { l: 48.66, g: 82.93 }, Hc: { l: -3267.6, g: -3301.5 },
    Cp: { l: liqCp(126.5, 23.4, 6, 67), g: gasCp(74.06, 32.95, -25.20, 77.57, 0, 1200) } });
  add('C7H8', 'Toluene', { std: 'l', Tm: -94.99, Hfus: 6.619, Tb: 110.62, Hvap: 33.47, Tc: 593.9, antoine: 'toluene',
    Hf: { l: 12.00, g: 50.00 }, Hc: { l: -3909.9, g: -3947.9 },
    Cp: { l: liqCp(148.8, 32.4, 0, 110), g: gasCp(94.18, 38.00, -27.86, 80.33, 0, 1200) } });
  add('C6H14', 'n-Hexane', { std: 'l', Tm: -95.32, Hfus: 13.03, Tb: 68.74, Hvap: 28.85, Tc: 507.9, antoine: 'hexane',
    Hf: { l: -198.8, g: -167.2 }, Hc: { l: -4163.1, g: -4194.8 },
    Cp: { l: liqCp(216.3, 0, 20, 100), g: gasCp(137.44, 40.85, -23.92, 57.66, 0, 1200) } });

  /* ───────────────────────── editing the data ───────────────────────── */

  const clone = o => JSON.parse(JSON.stringify(o));
  const hasVal = v => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && !isFinite(v));

  /* A copy of `base` with the user's records merged in. Each edit is a partial record: its id, and any of
     name, formula, M, std, Tm, Hfus, Tb, Hvap, Tc (K), antoine, and per-phase Cp / Hf / Hc maps ({ g: ..., l: ... }).
     A phase listed in an edit replaces that phase of the species; a null removes it. A new id adds a species. */
  function extendDatabase(base, edits) {
    const db = {};
    Object.keys(base || SPECIES).forEach(k => { db[k] = clone((base || SPECIES)[k]); });
    (edits || []).forEach(e => {
      if (!e || !hasVal(e.id)) return;
      const id = String(e.id).trim();
      if (!id) return;
      const sp = db[id] || (db[id] = { id, name: e.name || id, formula: e.formula || id, M: null, std: 'g', Tm: null, Hfus: null, Tb: null, Hvap: null, Tc: null, antoine: null, Hf: {}, Hc: {}, Cp: {}, note: '', custom: true });
      ['name', 'formula', 'std', 'antoine', 'note'].forEach(k => { if (hasVal(e[k])) sp[k] = e[k]; });
      ['M', 'Tm', 'Hfus', 'Tb', 'Hvap', 'Tc'].forEach(k => { if (e[k] !== undefined) sp[k] = hasVal(e[k]) ? Number(e[k]) : null; });
      ['Hf', 'Hc', 'Cp'].forEach(group => {
        if (!e[group]) return;
        Object.keys(e[group]).forEach(ph => {
          const v = e[group][ph];
          if (v === null) delete sp[group][ph];
          else sp[group][ph] = group === 'Cp' ? clone(v) : Number(v);
        });
      });
      if (!hasVal(sp.M)) { try { sp.M = molarMass(sp.formula); } catch (err) { sp.M = null; } }
      sp.edited = true;
    });
    return db;
  }

  /* The species a name refers to: its id or its name, in any case ("water" and "Water" both give H2O). null if there is none. */
  function findSpecies(db, text) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    const d = db || SPECIES;
    if (!t) return null;
    if (d[t]) return t;
    const low = t.toLowerCase(), ids = Object.keys(d);
    const plain = n => n.toLowerCase().replace(/^n-/, '');
    return ids.filter(id => id.toLowerCase() === low)[0] || ids.filter(id => plain(d[id].name) === plain(t))[0] || null;
  }

  function getSpecies(db, id) {
    const sp = (db || SPECIES)[id];
    if (!sp) throw new Error('"' + id + '" is not in the data table. Use a formula such as CH4, H2O or C2H5OH, or add it to the table.');
    return sp;
  }

  /* ───────────────────────── boiling point, latent heats, phase ───────────────────────── */

  /* Watson: ΔHv(T2) = ΔHv(T1) · [(1 − T2/Tc) / (1 − T1/Tc)]^0.38, temperatures in K. */
  function watson(Hv1, T1, T2, Tc, n) {
    if (!(T2 < Tc) || !(T1 < Tc)) throw new Error('The Watson correlation needs temperatures below the critical temperature (' + fmt(Tc, 5) + ' K).');
    return Hv1 * Math.pow((1 - T2 / Tc) / (1 - T1 / Tc), n === undefined ? 0.38 : n);
  }

  /* Boiling point at pressure P (kPa). At 1 atm it is the tabulated normal boiling point. At other pressures the
     Antoine equation (Chem.COMPOUNDS, or your own constants) supplies the shift, anchored to the tabulated value. */
  function boilingPoint(sp, P, ctx) {
    if (sp.Tb === null || sp.Tb === undefined) return { T: null, normal: true };
    const pr = P === undefined || P === null ? P0 : P;
    if (Math.abs(pr - P0) < 1e-6 * P0) return { T: sp.Tb, normal: true };
    const c = typeof sp.antoine === 'string' ? Chem.COMPOUNDS[sp.antoine] : sp.antoine;
    if (!c) {
      if (ctx) addNote(ctx, 'No vapour pressure data for ' + sp.id + ': its boiling point at ' + fmt(pr, 5) + ' kPa is taken as the normal boiling point.');
      return { T: sp.Tb, normal: true, ignored: true };
    }
    const Tant = Chem.boilingPointK(c, pr / 100), Tant0 = Chem.boilingPointK(c, P0 / 100);
    if (ctx && c.Tmin !== undefined && (Tant < c.Tmin - 1e-9 || Tant > c.Tmax + 1e-9)) {
      addWarn(ctx, 'The Antoine constants for ' + sp.id + ' are stated for ' + fmt(toC(c.Tmin), 4) + ' to ' + fmt(toC(c.Tmax), 4) + ' °C; the boiling point at ' + fmt(pr, 5) + ' kPa is outside that range, so it is an extrapolation.');
    }
    return { T: sp.Tb + (Tant - Tant0), normal: false, Tant, Tant0 };
  }

  /* ΔHvap at temperature T (K): the tabulated value at the normal boiling point, moved by Watson if needed. */
  function vapHeat(sp, T, ctx) {
    if (!hasVal(sp.Hvap) || !hasVal(sp.Tb)) throw new Error('No heat of vaporisation (or boiling point) for ' + sp.id + '. Add it in the data table.');
    if (Math.abs(T - sp.Tb) < 1e-9) return { value: sp.Hvap, watson: false };
    if (!hasVal(sp.Tc)) {
      if (ctx) addWarn(ctx, 'No critical temperature for ' + sp.id + ', so ΔHvap was not corrected to ' + tText(T) + '; the value at the normal boiling point was used.');
      return { value: sp.Hvap, watson: false };
    }
    return { value: watson(sp.Hvap, sp.Tb, T, sp.Tc), watson: true };
  }

  function fusHeat(sp) {
    if (!hasVal(sp.Hfus) || !hasVal(sp.Tm)) throw new Error('No heat of fusion (or melting point) for ' + sp.id + '. Add it in the data table.');
    return sp.Hfus;
  }

  /* The phase a species has at T (K) and P (kPa): below the melting point solid, up to the boiling point liquid,
     above gas. A species with only one phase in the table, or with no melting/boiling data, keeps its standard phase. */
  function phasesAvailable(sp) {
    return PHASES.filter(p => (sp.Cp && sp.Cp[p]) || (sp.Hf && hasVal(sp.Hf[p])));
  }
  function autoPhase(sp, T, P) {
    const avail = phasesAvailable(sp);
    if (avail.length === 1) return avail[0];
    const hasB = hasVal(sp.Tb), hasM = hasVal(sp.Tm);
    if (!hasB && !hasM) return sp.std;
    const Tb = hasB ? boilingPoint(sp, P).T : Infinity, Tm = hasM ? sp.Tm : -Infinity;
    if (T >= Tb) return 'g';
    if (T < Tm) return 's';
    return 'l';
  }
  const resolvePhase = (sp, spec, T, P) => (PHASES.indexOf(spec) >= 0 ? spec : autoPhase(sp, T, P));

  /* ───────────────────────── enthalpy along a path ───────────────────────── */

  function checkRange(cp, sp, phase, Ta, Tb, ctx) {
    if (!ctx) return;
    if (!inRange(cp, Ta) || !inRange(cp, Tb)) {
      const u = cp.Tunit === 'K' ? 'K' : '°C';
      addWarn(ctx, 'The Cp of ' + label(sp, phase) + ' is only given for ' + fmt(cp.Tmin, 5) + ' to ' + fmt(cp.Tmax, 5) + ' ' + u +
        '; it is used outside that range (' + tText(Math.min(Ta, Tb)) + ' to ' + tText(Math.max(Ta, Tb)) + '), so the result is an extrapolation.');
    }
  }

  function cpPolyText(cp) {
    let s = fmt(cp.a, 5);
    [[cp.b, 'T'], [cp.c, 'T²'], [cp.d, 'T³']].forEach(p => {
      if (p[0]) s += (p[0] < 0 ? ' − ' : ' + ') + fmt(Math.abs(p[0]), 5) + '·' + p[1];
    });
    return s;
  }

  /* One sensible-heat piece in a single phase: ΔH = ∫Cp dT from Ta to Tb (K). Returns kJ/mol and, if asked, the working. */
  function sensiblePiece(sp, phase, Ta, Tb, ctx, wantText) {
    const cp = sp.Cp && sp.Cp[phase];
    if (!cp) throw new Error('No heat capacity data for ' + label(sp, phase) + ' (' + PHASE_NAME[phase] + '). Add a Cp row for it in the data table.');
    checkRange(cp, sp, phase, Ta, Tb, ctx);
    const dH = integrateCp(cp, Ta, Tb);
    if (!wantText) return { dH };
    const shift = cp.Tunit === 'K' ? 0 : 273.15, uA = Ta - shift, uB = Tb - shift, U = cp.Tunit === 'K' ? 'K' : '°C';
    const co = [cp.a, cp.b || 0, cp.c || 0, cp.d || 0], names = ['a', 'b', 'c', 'd'];
    const eqT = [], subT = [], valT = [];
    co.forEach((c, k) => {
      if (k > 0 && c === 0) return;
      const val = c / (k + 1) * (Math.pow(uB, k + 1) - Math.pow(uA, k + 1));
      const div = k === 0 ? '' : '/' + (k + 1);
      eqT.push(names[k] + div + (k === 0 ? '' : ' ') + '(T₂' + sup(k + 1) + ' − T₁' + sup(k + 1) + ')');
      const head = k === 0 ? fmt(uB, 6) + ' − ' + par(uA, 6) : par(uB, 6) + sup(k + 1) + ' − ' + par(uA, 6) + sup(k + 1);
      subT.push(par(c, 5) + div + ' × (' + head + ')');
      valT.push(par(val, 6));
    });
    const eq = {
      label: 'Cp(' + label(sp, phase) + ') = ' + cpPolyText(cp) + '   [J/(mol·K), T in ' + U + ']',
      equation: 'ΔH = ∫Cp dT = ' + eqT.join(' + '),
      substituted: subT.join(' + ') + '  =  ' + valT.join(' + ') + '  =  ' + fmt(dH * 1000, 6) + ' J/mol'
    };
    return { dH, equation: eq, mean: Math.abs(Tb - Ta) > 1e-12 ? dH * 1000 / (Tb - Ta) : cpAt(cp, Ta) };
  }

  /* The change of enthalpy of one mole of a species from state `from` to state `to`, each { T (K), phase }.
     If the phases differ the path goes through the melting / boiling point(s): heat to the transition, latent
     heat, then on. Returns { dH (kJ/mol), pieces: [{ kind, title, value, equation }] }. */
  function pathCalc(sp, from, to, P, ctx, wantText) {
    const pieces = [];
    let total = 0;
    const push = (kind, title, value, eq) => { total += value; pieces.push({ kind, title, value, equation: eq }); };
    let ph = from.phase, T = from.T;
    const i0 = PHASES.indexOf(from.phase), i1 = PHASES.indexOf(to.phase);
    if (i0 < 0 || i1 < 0) throw new Error('Phase must be s, l or g.');
    const dir = i1 >= i0 ? 1 : -1;
    while (ph !== to.phase) {
      const next = PHASES[PHASES.indexOf(ph) + dir];
      const fusion = ph === 's' || next === 's';
      let Tt;
      if (fusion) {
        if (!hasVal(sp.Tm)) throw new Error('No melting point for ' + sp.id + '. Add it in the data table.');
        Tt = sp.Tm;
      } else {
        Tt = boilingPoint(sp, P, ctx).T;
        if (Tt === null) throw new Error(sp.id + ' has no boiling point in the data table (it does not condense here). Add one, or keep it in one phase.');
      }
      if (Math.abs(Tt - T) > 1e-9) {
        const sp1 = sensiblePiece(sp, ph, T, Tt, ctx, wantText);
        push('sensible', (dir > 0 ? 'Heat ' : 'Cool ') + label(sp, ph) + ' from ' + tText(T) + ' to ' + tText(Tt), sp1.dH, sp1.equation);
      }
      let L, eq = null;
      if (fusion) {
        L = fusHeat(sp);
        if (wantText) eq = { label: 'Heat of fusion of ' + sp.id + ' at its melting point ' + tText(Tt), equation: 'ΔHfus (tabulated at the melting point)', substituted: fmt(L, 6) + ' kJ/mol' };
      } else {
        const v = vapHeat(sp, Tt, ctx);
        L = v.value;
        if (wantText) {
          eq = v.watson
            ? { label: 'Heat of vaporisation of ' + sp.id + ' at ' + tText(Tt) + ' (Watson: ΔHv at the normal boiling point moved to this temperature)',
                equation: 'ΔHv(T) = ΔHv(Tb) · [(1 − T/Tc) / (1 − Tb/Tc)]^0.38',
                substituted: fmt(sp.Hvap, 6) + ' × [(1 − ' + fmt(Tt, 6) + '/' + fmt(sp.Tc, 5) + ') / (1 − ' + fmt(sp.Tb, 6) + '/' + fmt(sp.Tc, 5) + ')]^0.38 = ' + fmt(L, 6) + ' kJ/mol' }
            : { label: 'Heat of vaporisation of ' + sp.id + ' at its boiling point ' + tText(Tt), equation: 'ΔHv (tabulated at the boiling point)', substituted: fmt(L, 6) + ' kJ/mol' };
        }
      }
      const signed = dir > 0 ? L : -L;
      const nameOf = fusion ? (dir > 0 ? 'Melt ' : 'Freeze ') : (dir > 0 ? 'Vaporise ' : 'Condense ');
      push('latent', nameOf + sp.id + ' at ' + tText(Tt), signed, eq);
      T = Tt; ph = next;
    }
    if (Math.abs(to.T - T) > 1e-9) {
      const s1 = sensiblePiece(sp, ph, T, to.T, ctx, wantText);
      push('sensible', (to.T >= T ? 'Heat ' : 'Cool ') + label(sp, ph) + ' from ' + tText(T) + ' to ' + tText(to.T), s1.dH, s1.equation);
    }
    return { dH: total, pieces };
  }

  const piecesText = pieces => pieces.map(p => par(p.value, 6)).join(' + ');
  /* The working of each piece of a path, as equations for a step: a title, the equation and the numbers put in. */
  const pieceEqs = pieces => (pieces.length
    ? pieces.map(p => ({
        label: p.title + (p.equation && p.equation.label ? '   —   ' + p.equation.label : ''),
        equation: p.equation ? p.equation.equation : '', substituted: p.equation ? p.equation.substituted : '' }))
    : [{ label: '', equation: 'no change of state or temperature', substituted: '0' }]);

  /* Enthalpy of one mole of a species in state { T (K), phase }, relative to the reference:
     formation = false:  the species at 25 °C in its reference phase (default: its standard phase), so h = 0 there.
     formation = true:   the elements at 25 °C, so h = ΔHf(reference phase, 25 °C) + path. kJ/mol. */
  function enthalpyOf(sp, T, phase, P, o, ctx, wantText) {
    const refPhase = (o && o.refPhase) || sp.std;
    const formation = !!(o && o.formation);
    let hf = 0;
    if (formation) {
      hf = sp.Hf && sp.Hf[refPhase];
      if (!hasVal(hf)) throw new Error('No heat of formation for ' + label(sp, refPhase) + '. Add it in the data table.');
    }
    const path = pathCalc(sp, { T: T0, phase: refPhase }, { T, phase }, P, ctx, wantText);
    const h = hf + path.dH;
    return { h, hf, path, refPhase, phase };
  }

  /* Numbers for one species at a time, used by the flowsheet solver (js/balance.js).
     phaseSpec is 'auto' (the phase it has at T and P) or 'g', 'l', 's'. */
  function molarEnthalpy(sp, T, phaseSpec, P, formation) {
    const pr = P || P0, ph = resolvePhase(sp, phaseSpec || 'auto', T, pr);
    return enthalpyOf(sp, T, ph, pr, { formation: !!formation }, null, false).h;
  }
  /* Heat capacity (J/(mol·K)) in the phase the species has there; the slope of enthalpy with temperature, ×1000. */
  function molarCp(sp, T, phaseSpec, P) {
    const pr = P || P0, ph = resolvePhase(sp, phaseSpec || 'auto', T, pr);
    const cp = sp.Cp && sp.Cp[ph];
    if (!cp) throw new Error('No heat capacity data for ' + label(sp, ph) + ' (' + PHASE_NAME[ph] + '). Add a Cp row for it in the data table.');
    return cpAt(cp, T);
  }
  /* The same enthalpy with its working written out: ĥ = ΔH°f (if formation) + the sensible and latent heats from 25 °C. */
  function enthalpyDetail(sp, T, phaseSpec, P, formation, ctx) {
    const pr = P || P0, ph = resolvePhase(sp, phaseSpec || 'auto', T, pr);
    const e = enthalpyOf(sp, T, ph, pr, { formation: !!formation }, ctx || null, true);
    const parts = [];
    if (formation) parts.push(par(e.hf, 6) + ' [ΔH°f ' + label(sp, e.refPhase) + ']');
    e.path.pieces.forEach(p => parts.push(par(p.value, 6) + ' [' + p.title + ']'));
    if (!parts.length) parts.push('0');
    return { h: e.h, phase: ph, text: 'ĥ(' + label(sp, ph) + ' at ' + tText(T) + ') = ' + parts.join(' + ') + ' = ' + fmt(e.h, 6) + ' kJ/mol' };
  }

  /* ───────────────────────── 1. sensible heat ───────────────────────── */

  function normaliseAmounts(list, what) {
    const out = (list || []).filter(c => c && hasVal(c.id)).map(c => ({ id: String(c.id).trim(), n: Number(c.n === undefined || c.n === '' ? 1 : c.n) }));
    if (!out.length) throw new Error('Choose at least one species.');
    out.forEach(c => { if (!(c.n >= 0) || !isFinite(c.n)) throw new Error('The amount of ' + c.id + ' must be a number (zero or above).'); });
    const tot = out.reduce((a, c) => a + c.n, 0);
    if (!(tot > 0)) throw new Error('The amounts or fractions of the ' + (what || 'species') + ' add up to zero.');
    return { list: out, total: tot };
  }

  /* o: { species: [{id, n}], T1, T2 (K), phase: 'g'|'l'|'s'|'auto' (or phase1, phase2), P (kPa), flow (mol/s), db }
     n are mole fractions or any amounts (they are normalised). */
  function sensibleHeat(o) {
    const db = o.db || SPECIES, P = o.P || P0, ctx = newCtx();
    if (!isFinite(o.T1) || !isFinite(o.T2)) throw new Error('Enter both temperatures.');
    if (o.T1 <= 0 || o.T2 <= 0) throw new Error('Temperatures must be above absolute zero.');
    const am = normaliseAmounts(o.species, 'species');
    const steps = [], rows = [];
    let dH = 0, dHrel = 0;
    am.list.forEach(c => {
      const sp = getSpecies(db, c.id);
      const p1 = resolvePhase(sp, o.phase1 || o.phase || 'auto', o.T1, P), p2 = resolvePhase(sp, o.phase2 || o.phase || 'auto', o.T2, P);
      const path = pathCalc(sp, { T: o.T1, phase: p1 }, { T: o.T2, phase: p2 }, P, ctx, true);
      const y = c.n / am.total;
      rows.push({ id: c.id, y, phase1: p1, phase2: p2, dH: path.dH, path });
      dH += y * path.dH;
      steps.push(step((am.list.length > 1 ? c.id + ': ' : '') + 'Enthalpy change of ' + sp.name.toLowerCase() + ' from ' + tText(o.T1) + ' to ' + tText(o.T2),
        pieceEqs(path.pieces), [{ name: 'ΔH(' + c.id + ')', value: path.dH, unit: 'kJ/mol' }]));
      if (path.pieces.length > 1) {
        steps[steps.length - 1].equations.push({ label: 'Sum of the steps', equation: 'ΔH = Σ steps', substituted: piecesText(path.pieces) + ' = ' + fmt(path.dH, 6) + ' kJ/mol' });
      }
    });
    const dT = o.T2 - o.T1;
    if (am.list.length > 1) {
      steps.push(step('Mixture: weight each species by its mole fraction', [{
        label: 'ΔH(mixture) per mole of mixture',
        equation: 'ΔH = Σ yᵢ ΔHᵢ',
        substituted: rows.map(r => fmt(r.y, 5) + ' × ' + par(r.dH, 6)).join(' + ') + ' = ' + fmt(dH, 6) + ' kJ/mol'
      }], [{ name: 'ΔH(mixture)', value: dH, unit: 'kJ/mol' }]));
    }
    const result = { dH, rows, steps, warnings: ctx.warnings, notes: ctx.notes, mixture: am.list.length > 1 };
    if (Math.abs(dT) > 1e-12) {
      result.meanCp = dH * 1000 / dT;
      steps.push(step('Mean heat capacity over the range', [{ label: '', equation: 'Cp,mean = ΔH / (T₂ − T₁)',
        substituted: fmt(dH * 1000, 6) + ' J/mol / ' + par(dT, 6) + ' K = ' + fmt(result.meanCp, 6) + ' J/(mol·K)' }],
        [{ name: 'Cp,mean', value: result.meanCp, unit: 'J/(mol·K)' }]));
    }
    // ΔU for ideal gases: Cv = Cp − R, ΔU = ΔH − R ΔT
    if (rows.every(r => r.phase1 === 'g' && r.phase2 === 'g')) {
      result.dU = dH - R * dT / 1000;
      steps.push(step('Internal energy change (ideal gas)', [{ label: 'Cv = Cp − R, so ΔU = ΔH − R·ΔT',
        equation: 'ΔU = ΔH − R (T₂ − T₁)',
        substituted: fmt(dH, 6) + ' kJ/mol − ' + fmt(R / 1000, 7) + ' kJ/(mol·K) × ' + par(dT, 6) + ' K = ' + fmt(result.dU, 6) + ' kJ/mol' }],
        [{ name: 'ΔU', value: result.dU, unit: 'kJ/mol' }]));
      if (result.meanCp !== undefined) result.meanCv = result.meanCp - R;
    }
    if (hasVal(o.flow) && Number(o.flow) > 0) {
      result.Q = Number(o.flow) * dH;
      steps.push(step('Heat for the given flow', [{ label: 'Steady flow, no work: Q = ṅ ΔH', equation: 'Q = ṅ · ΔH',
        substituted: fmt(Number(o.flow), 6) + ' mol/s × ' + par(dH, 6) + ' kJ/mol = ' + fmt(result.Q, 6) + ' kW' }],
        [{ name: 'Q', value: result.Q, unit: 'kW' }]));
    }
    return result;
  }

  /* ───────────────────────── 2. phase change ───────────────────────── */

  /* o: { id, from: { T, phase }, to: { T, phase }, P, flow, db }.  Phase 'auto' = the phase the species has at that T. */
  function phaseChange(o) {
    const db = o.db || SPECIES, P = o.P || P0, ctx = newCtx();
    const sp = getSpecies(db, o.id);
    if (!isFinite(o.from.T) || !isFinite(o.to.T) || o.from.T <= 0 || o.to.T <= 0) throw new Error('Enter both temperatures (above absolute zero).');
    const from = { T: o.from.T, phase: resolvePhase(sp, o.from.phase || 'auto', o.from.T, P) };
    const to = { T: o.to.T, phase: resolvePhase(sp, o.to.phase || 'auto', o.to.T, P) };
    const path = pathCalc(sp, from, to, P, ctx, true);
    const steps = [];
    const tb = boilingPoint(sp, P, ctx);
    const info = [];
    if (hasVal(sp.Tm)) info.push('melting point ' + tText(sp.Tm));
    if (tb.T !== null) info.push('boiling point at ' + fmt(P, 6) + ' kPa: ' + tText(tb.T));
    steps.push(step('The path from ' + label(sp, from.phase) + ' at ' + tText(from.T) + ' to ' + label(sp, to.phase) + ' at ' + tText(to.T),
      [{ label: 'Enthalpy is a state function, so any path between the two states gives the same ΔH. Use one that heats each phase up to its transition temperature, changes phase there, then heats on.',
         equation: 'ΔH = Σ (sensible heat of each phase) + Σ (latent heats)', substituted: info.join(';  ') || 'no phase change on this path' }], []));
    path.pieces.forEach((p, i) => {
      steps.push(step('Step ' + (i + 1) + ': ' + p.title,
        pieceEqs([p]), [{ name: 'ΔH' + (i + 1), value: p.value, unit: 'kJ/mol' }]));
    });
    steps.push(step('Total', [{ label: '', equation: 'ΔH = ΔH₁ + ΔH₂ + ...', substituted: path.pieces.length ? piecesText(path.pieces) + ' = ' + fmt(path.dH, 6) + ' kJ/mol' : '0' }],
      [{ name: 'ΔH', value: path.dH, unit: 'kJ/mol' }]));
    const out = { dH: path.dH, from, to, pieces: path.pieces, steps, warnings: ctx.warnings, notes: ctx.notes };
    if (hasVal(o.flow) && Number(o.flow) > 0) {
      out.Q = Number(o.flow) * path.dH;
      steps.push(step('Heat for the given flow', [{ label: 'Q = ṅ ΔH', equation: 'Q = ṅ · ΔH', substituted: fmt(Number(o.flow), 6) + ' mol/s × ' + par(path.dH, 6) + ' kJ/mol = ' + fmt(out.Q, 6) + ' kW' }],
        [{ name: 'Q', value: out.Q, unit: 'kW' }]));
    }
    return out;
  }

  /* Latent heat on its own: o: { id, kind: 'vap' | 'fus', T (K, for vap), P, db }. */
  function latentHeat(o) {
    const db = o.db || SPECIES, P = o.P || P0, ctx = newCtx();
    const sp = getSpecies(db, o.id);
    if (o.kind === 'fus') {
      const L = fusHeat(sp);
      return { value: L, T: sp.Tm, steps: [step('Heat of fusion of ' + sp.name.toLowerCase(), [{ label: '', equation: 'ΔHfus at the melting point ' + tText(sp.Tm), substituted: fmt(L, 6) + ' kJ/mol (tabulated)' }], [{ name: 'ΔHfus', value: L, unit: 'kJ/mol' }])], warnings: ctx.warnings, notes: ctx.notes };
    }
    const T = hasVal(o.T) ? o.T : boilingPoint(sp, P, ctx).T;
    if (!(T > 0)) throw new Error('Enter a temperature.');
    if (hasVal(sp.Tc) && T >= sp.Tc) throw new Error('That temperature is at or above the critical temperature of ' + sp.id + ' (' + fmt(sp.Tc, 5) + ' K).');
    const v = vapHeat(sp, T, ctx);
    const eq = v.watson
      ? { label: 'Watson correlation', equation: 'ΔHv(T) = ΔHv(Tb) · [(1 − T/Tc) / (1 − Tb/Tc)]^0.38',
          substituted: fmt(sp.Hvap, 6) + ' × [(1 − ' + fmt(T, 6) + '/' + fmt(sp.Tc, 5) + ') / (1 − ' + fmt(sp.Tb, 6) + '/' + fmt(sp.Tc, 5) + ')]^0.38 = ' + fmt(v.value, 6) + ' kJ/mol' }
      : { label: '', equation: 'ΔHv at the normal boiling point ' + tText(sp.Tb), substituted: fmt(v.value, 6) + ' kJ/mol (tabulated)' };
    return { value: v.value, T, steps: [step('Heat of vaporisation of ' + sp.name.toLowerCase() + ' at ' + tText(T), [eq], [{ name: 'ΔHvap', value: v.value, unit: 'kJ/mol' }])], warnings: ctx.warnings, notes: ctx.notes };
  }

  /* ───────────────────────── 3. reactions ───────────────────────── */

  /* "CH4 + 2 O2 -> CO2 + 2 H2O(g)"  →  { terms: [{ id, phase, tagged, nu }], text }  (reactants have negative nu).
     A phase tag (g), (l), (s) fixes the phase of that species for its heat of formation; without one the species
     is taken in its standard phase at 25 °C (liquid water, gaseous methane, ...). */
  function parseEquation(text, db) {
    db = db || SPECIES;
    let s = String(text || '').trim();
    if (!s) throw new Error('Write the reaction like  CH4 + 2 O2 -> CO2 + 2 H2O');
    s = s.replace(/(\d+)\s*\/\s*(\d+)/g, (m, a, b) => String(Number(a) / Number(b)));
    const known = {};
    Object.keys(db).forEach(id => { known[id] = true; ['g', 'l', 's', 'c'].forEach(p => { known[id + '(' + p + ')'] = true; }); });
    // check every species name before handing the text to parseReaction, so the error names the culprit
    s.split(/->|→|=>|⇒|=/).forEach(side => side.split('+').forEach(term => {
      const t = term.trim();
      if (!t || known[t]) return;
      const m = t.match(/^(\d+(?:\.\d+)?)\s*(.+)$/);
      const name = m ? m[2].trim() : t;
      if (!known[name]) throw new Error('"' + name + '" is not in the data table. Check the spelling (use formulas: CH4, O2, H2O, C2H5OH), or add it to the table.');
    }));
    const nu = getBalance().parseReaction(s, Object.keys(known));
    const terms = [];
    Object.keys(nu).forEach(tok => {
      if (Math.abs(nu[tok]) < 1e-12) return;
      const m = tok.match(/^(.*)\((g|l|s|c)\)$/);
      let id = tok, tag = null;
      if (m && db[m[1]]) { id = m[1]; tag = m[2] === 'c' ? 's' : m[2]; }
      const sp = db[id];
      terms.push({ id, phase: tag || sp.std, tagged: !!tag, nu: nu[tok] });
    });
    if (!terms.length) throw new Error('Nothing changes in that reaction.');
    if (!terms.some(t => t.nu < 0) || !terms.some(t => t.nu > 0)) throw new Error('The reaction needs reactants on the left and products on the right.');
    const side = list => list.map(t => (Math.abs(t.nu) === 1 ? '' : fmt(Math.abs(t.nu), 6) + ' ') + t.id + '(' + t.phase + ')').join(' + ');
    return { terms, text: side(terms.filter(t => t.nu < 0)) + ' -> ' + side(terms.filter(t => t.nu > 0)) };
  }

  function formationOf(sp, phase) {
    const v = sp.Hf && sp.Hf[phase];
    if (!hasVal(v)) throw new Error('No heat of formation for ' + label(sp, phase) + ' in the data table. Add it, or write the reaction with a phase it has (for example ' + sp.id + '(' + (phasesAvailable(sp).filter(p => sp.Hf && hasVal(sp.Hf[p]))[0] || 'g') + ')).');
    return v;
  }

  /* ΔH°rxn at 25 °C = Σ ν ΔHf(products) − Σ |ν| ΔHf(reactants), per mole of reaction as written. */
  function standardReaction(rx, db) {
    let total = 0;
    const eqs = [], sumT = [];
    rx.terms.forEach(t => {
      const sp = getSpecies(db, t.id), hf = formationOf(sp, t.phase);
      total += t.nu * hf;
      sumT.push((t.nu < 0 ? '−' : '+') + ' ' + fmt(Math.abs(t.nu), 6) + ' × ' + par(hf, 6));
    });
    const val = sumT.join(' ').replace(/^\+ /, '');
    return { dH: total, text: val };
  }

  /* o: { reaction, T (K, optional: the temperature of the reaction), P, extent (mol, optional), keepPhase, db }
     ΔH°rxn(25 °C) from heats of formation; at another T by the path
       reactants T → 25 °C,  react at 25 °C,  products 25 °C → T. */
  function heatOfReaction(o) {
    const db = o.db || SPECIES, P = o.P || P0, ctx = newCtx();
    const rx = parseEquation(o.reaction, db);
    const steps = [];
    steps.push(step('The reaction, with the phase of each species', [{ label: 'Reactants have negative ν, products positive. Species without a phase written are taken in their standard phase at 25 °C.',
      equation: rx.text, substituted: rx.terms.map(t => 'ν(' + t.id + '(' + t.phase + ')) = ' + par(t.nu, 6)).join(',  ') }], []));
    const std = standardReaction(rx, db);
    steps.push(step('Standard heat of reaction at 25 °C from heats of formation', [{ label: 'ΔH°f of an element in its standard state is zero.',
      equation: 'ΔH°rxn = Σ νᵢ ΔH°f,ᵢ  (products positive, reactants negative)',
      substituted: std.text + ' = ' + fmt(std.dH, 6) + ' kJ' }], [{ name: 'ΔH°rxn (25 °C)', value: std.dH, unit: 'kJ per mole of reaction as written' }]));
    const out = { reaction: rx, dH25: std.dH, dH: std.dH, T: T0, steps, warnings: ctx.warnings, notes: ctx.notes };
    out.type = std.dH < 0 ? 'exothermic' : (std.dH > 0 ? 'endothermic' : 'thermoneutral');
    if (hasVal(o.T) && Math.abs(o.T - T0) > 1e-9) {
      const T = o.T;
      let react = 0, prod = 0;
      const rSteps = [], pSteps = [];
      rx.terms.forEach(t => {
        const sp = getSpecies(db, t.id);
        const phT = o.keepPhase ? t.phase : autoPhase(sp, T, P);
        const dir = t.nu < 0 ? { from: { T, phase: phT }, to: { T: T0, phase: t.phase } } : { from: { T: T0, phase: t.phase }, to: { T, phase: phT } };
        const path = pathCalc(sp, dir.from, dir.to, P, ctx, true);
        // reactants: |ν| × ΔH(T → 25 °C), products: |ν| × ΔH(25 °C → T)
        const value = Math.abs(t.nu) * path.dH;
        const st = step((t.nu < 0 ? 'Reactant ' : 'Product ') + t.id + ': ' + (t.nu < 0 ? 'bring ' + label(sp, phT) + ' from ' + tText(T) + ' to 25 °C' : 'take ' + label(sp, t.phase) + ' from 25 °C to ' + label(sp, phT) + ' at ' + tText(T)),
          pieceEqs(path.pieces), [{ name: fmt(Math.abs(t.nu), 6) + ' × ΔH', value, unit: 'kJ' }]);
        if (t.nu < 0) { react += value; rSteps.push(st); } else { prod += value; pSteps.push(st); }
      });
      out.reactantsPath = react; out.productsPath = prod;
      steps.push(step('Path for the heat of reaction at ' + tText(T), [{ label: 'Enthalpy is a state function: take the reactants from ' + tText(T) + ' down to 25 °C, react at 25 °C, then heat the products from 25 °C up to ' + tText(T) + '.',
        equation: 'ΔHrxn(T) = Σ|ν|·ΔH(reactants, T→25 °C) + ΔH°rxn(25 °C) + Σν·ΔH(products, 25 °C→T)', substituted: '' }], []));
      rSteps.forEach(s => steps.push(s));
      steps.push(step('Standard reaction at 25 °C', [], [{ name: 'ΔH°rxn', value: std.dH, unit: 'kJ' }]));
      pSteps.forEach(s => steps.push(s));
      out.dH = react + std.dH + prod;
      out.T = T;
      steps.push(step('Heat of reaction at ' + tText(T), [{ label: '', equation: 'ΔHrxn(T) = (reactants to 25 °C) + ΔH°rxn + (products to T)',
        substituted: par(react, 6) + ' + ' + par(std.dH, 6) + ' + ' + par(prod, 6) + ' = ' + fmt(out.dH, 6) + ' kJ' }], [{ name: 'ΔHrxn(' + tText(T) + ')', value: out.dH, unit: 'kJ per mole of reaction as written' }]));
    }
    if (hasVal(o.extent) && Number(o.extent) !== 0) {
      out.extent = Number(o.extent);
      out.Q = out.extent * out.dH;
      steps.push(step('Heat for the extent of reaction given', [{ label: 'Reactants enter and products leave at the same temperature (' + tText(out.T) + '); Q is the heat that must be added (negative = released).',
        equation: 'Q = ξ · ΔHrxn', substituted: fmt(out.extent, 6) + ' × ' + par(out.dH, 6) + ' kJ = ' + fmt(out.Q, 6) + ' kJ' }], [{ name: 'Q', value: out.Q, unit: 'kJ (per the unit of ξ, kmol → MJ)' }]));
    }
    return out;
  }

  /* Complete combustion of a fuel made of C, H, O (and N, S): the balanced reaction as text. */
  function combustionReaction(id, db, fuelPhase) {
    db = db || SPECIES;
    const sp = getSpecies(db, id);
    const at = parseFormula(sp.formula);
    Object.keys(at).forEach(el => { if (['C', 'H', 'O', 'N', 'S'].indexOf(el) < 0) throw new Error('Combustion is set up for fuels containing only C, H, O, N and S (not ' + el + ').'); });
    const x = at.C || 0, y = at.H || 0, z = at.O || 0, w = at.N || 0, v = at.S || 0;
    const o2 = x + y / 4 + v - z / 2;
    if (!(o2 > 0)) throw new Error(id + ' needs no oxygen to burn, or cannot burn completely to CO2, H2O, N2 and SO2.');
    const part = (c, name) => (c === 0 ? null : (c === 1 ? '' : fmt(c, 6) + ' ') + name);
    const fp = fuelPhase || sp.std;
    const left = [part(1, id + '(' + fp + ')'), part(o2, 'O2')].filter(Boolean);
    return { fuelPhase: fp, o2, text: left.join(' + ') };
  }

  /* HHV and LHV of a fuel from heats of formation, per mole and per kg. o: { id, phase, db }. */
  function combustion(o) {
    const db = o.db || SPECIES, ctx = newCtx();
    const sp = getSpecies(db, o.id);
    const base = combustionReaction(o.id, db, o.phase);
    const at = parseFormula(sp.formula);
    const x = at.C || 0, y = at.H || 0, w = at.N || 0, v = at.S || 0;
    const prods = (water) => [x ? (x === 1 ? '' : fmt(x, 6) + ' ') + 'CO2(g)' : null, y ? (y / 2 === 1 ? '' : fmt(y / 2, 6) + ' ') + 'H2O(' + water + ')' : null,
      w ? (w / 2 === 1 ? '' : fmt(w / 2, 6) + ' ') + 'N2(g)' : null, v ? (v === 1 ? '' : fmt(v, 6) + ' ') + 'SO2(g)' : null].filter(Boolean).join(' + ');
    const left = base.text.replace(/ O2$/, ' O2(g)');
    const rxL = left + ' -> ' + prods('l'), rxG = left + ' -> ' + prods('g');
    const steps = [];
    steps.push(step('Complete combustion of ' + sp.name.toLowerCase() + ' (' + sp.formula + ')', [{
      label: 'Carbon goes to CO2, hydrogen to H2O' + (w ? ', nitrogen to N2' : '') + (v ? ', sulfur to SO2' : '') + '. O2 needed per mole of fuel = C + H/4' + (v ? ' + S' : '') + ' − O/2.',
      equation: 'O2 = ' + fmt(x, 6) + ' + ' + fmt(y, 6) + '/4' + (v ? ' + ' + fmt(v, 6) : '') + ' − ' + fmt(at.O || 0, 6) + '/2 = ' + fmt(base.o2, 6) + ' mol per mol of fuel',
      substituted: rxL }], []));
    const hs = heatOfReaction({ reaction: rxL, db });
    const ls = y > 0 ? heatOfReaction({ reaction: rxG, db }) : hs;
    steps.push(step('Higher heating value: the water leaves as a liquid (all the heat of condensation is recovered)', [{ label: 'ΔH°c = Σ ν ΔH°f', equation: rxL, substituted: hs.steps[1].equations[0].substituted + ' = ' + fmt(hs.dH25, 6) + ' kJ/mol' }],
      [{ name: 'ΔH°c (H2O liquid)', value: hs.dH25, unit: 'kJ/mol' }, { name: 'HHV = −ΔH°c', value: -hs.dH25, unit: 'kJ/mol' }]));
    if (y > 0) {
      steps.push(step('Lower heating value: the water leaves as vapour', [{ label: 'ΔH°c = Σ ν ΔH°f', equation: rxG, substituted: ls.steps[1].equations[0].substituted + ' = ' + fmt(ls.dH25, 6) + ' kJ/mol' }],
        [{ name: 'ΔH°c (H2O vapour)', value: ls.dH25, unit: 'kJ/mol' }, { name: 'LHV = −ΔH°c', value: -ls.dH25, unit: 'kJ/mol' }]));
    }
    const out = { id: o.id, name: sp.name, M: sp.M, fuelPhase: base.fuelPhase, o2: base.o2, reactionHHV: hs.reaction.text, reactionLHV: ls.reaction.text,
      hhv: -hs.dH25, lhv: -ls.dH25, tabulated: hasVal(sp.Hc && sp.Hc[base.fuelPhase]) ? -sp.Hc[base.fuelPhase] : null, steps, warnings: ctx.warnings, notes: ctx.notes };
    if (hasVal(sp.M) && sp.M > 0) {
      out.hhvMass = out.hhv / sp.M; out.lhvMass = out.lhv / sp.M;   // kJ/mol ÷ g/mol = MJ/kg
      steps.push(step('Per kilogram', [{ label: 'kJ/mol ÷ g/mol = kJ/g = MJ/kg', equation: 'HHV (MJ/kg) = HHV (kJ/mol) / M', substituted: fmt(out.hhv, 6) + ' / ' + fmt(sp.M, 6) + ' = ' + fmt(out.hhvMass, 5) + ' MJ/kg;  LHV = ' + fmt(out.lhv, 6) + ' / ' + fmt(sp.M, 6) + ' = ' + fmt(out.lhvMass, 5) + ' MJ/kg' }],
        [{ name: 'HHV', value: out.hhvMass, unit: 'MJ/kg' }, { name: 'LHV', value: out.lhvMass, unit: 'MJ/kg' }]));
    }
    return out;
  }

  /* ───────────────────────── 4. adiabatic reactor ───────────────────────── */

  /* A bracketed root finder for an increasing function with jumps (phase changes): scan upward for the first sign
     change of f, then bisect. Points where f cannot be evaluated (a species lacks data there) are skipped. */
  function solveBracketed(f, lo, hi, stepK) {
    const ptsErr = [];
    let a = null, fa = null, firstErr = null;
    for (let T = lo; T <= hi + 1e-9; T += stepK) {
      let v;
      try { v = f(T); } catch (e) { if (!firstErr) firstErr = e; a = null; continue; }
      if (a !== null && fa < 0 && v >= 0) {
        let l = a, h = T, fl = fa, fh = v, it = 0;
        while (h - l > 1e-10 * Math.max(1, h) && it < 300) {
          const m = 0.5 * (l + h), fm = f(m);
          it++;
          if (fm < 0) { l = m; fl = fm; } else { h = m; fh = fm; }
        }
        return { T: 0.5 * (l + h), lo: l, hi: h, fLo: fl, fHi: fh, iterations: it, scanFrom: a, scanTo: T };
      }
      if (a === null && v >= 0 && T === lo) return { below: true, T };
      a = T; fa = v;
    }
    if (firstErr) throw firstErr;
    return { above: true };
  }

  /* o: {
       reactions: [{ text, extent | conversion: { id, x } }],   (none: just heating or cooling)
       feeds: [{ id, n (mol/s), T (K), phase }],  P (kPa),  Q (kW, default 0 = adiabatic, positive = heat added),
       Tmin, Tmax (search window, K), db }
     Solves  Σ nᵢ,out ĥᵢ(T) = Σ nᵢ,in ĥᵢ(Tᵢ) + Q  for the outlet temperature T, with ĥ measured from the elements at 25 °C
     when there is a reaction, and from the species at 25 °C otherwise. */
  function adiabatic(o) {
    const db = o.db || SPECIES, P = o.P || P0, ctx = newCtx();
    const Q = hasVal(o.Q) ? Number(o.Q) : 0;
    const feeds = (o.feeds || []).filter(f => f && hasVal(f.id) && Number(f.n) > 0).map(f => ({ id: String(f.id).trim(), n: Number(f.n), T: Number(f.T), phase: f.phase || 'auto' }));
    if (!feeds.length) throw new Error('Enter at least one feed species with a flow above zero.');
    feeds.forEach(f => { if (!(f.T > 0)) throw new Error('Enter the temperature of ' + f.id + ' in the feed.'); getSpecies(db, f.id); });
    const rxs = (o.reactions || []).filter(r => r && hasVal(r.text)).map(r => Object.assign({}, r, { rx: parseEquation(r.text, db) }));
    const formation = rxs.length > 0;
    const steps = [];

    // reference phase of each species: the phase it is written with in a reaction, else its standard phase
    const tagged = {};
    rxs.forEach(r => r.rx.terms.forEach(t => {
      if (!t.tagged) return;
      if (tagged[t.id] && tagged[t.id] !== t.phase) throw new Error(t.id + ' is written with two different phases in the reactions. Use one phase for the reference state.');
      tagged[t.id] = t.phase;
    }));
    const refPhase = {};
    feeds.forEach(f => { refPhase[f.id] = tagged[f.id] || getSpecies(db, f.id).std; });
    rxs.forEach(r => r.rx.terms.forEach(t => { refPhase[t.id] = tagged[t.id] || getSpecies(db, t.id).std; }));

    // 1. amounts: feed, extent of each reaction, outlet
    const nIn = {};
    feeds.forEach(f => { nIn[f.id] = (nIn[f.id] || 0) + f.n; });
    const avail = Object.assign({}, nIn);
    const scale = Object.keys(nIn).reduce((a, k) => a + nIn[k], 0);
    const extents = [];
    rxs.forEach((r, k) => {
      let xi, how;
      if (r.conversion && hasVal(r.conversion.id)) {
        const t = r.rx.terms.filter(q => q.id === r.conversion.id && q.nu < 0)[0];
        if (!t) throw new Error(r.conversion.id + ' is not a reactant of reaction ' + (k + 1) + '.');
        const x = Number(r.conversion.x);
        if (!(x >= 0 && x <= 1 + 1e-12)) throw new Error('A conversion must be between 0 and 1 (0 to 100%).');
        const have = avail[t.id] || 0;
        xi = x * have / Math.abs(t.nu);
        how = 'ξ = X · n(' + t.id + ') / |ν| = ' + fmt(x, 6) + ' × ' + fmt(have, 6) + ' / ' + fmt(Math.abs(t.nu), 6) + ' = ' + fmt(xi, 6) + ' mol/s';
      } else if (hasVal(r.extent)) {
        xi = Number(r.extent);
        how = 'ξ = ' + fmt(xi, 6) + ' mol/s (given)';
      } else throw new Error('Give the extent of reaction ' + (k + 1) + ', or the conversion of one reactant.');
      r.rx.terms.forEach(t => { avail[t.id] = (avail[t.id] || 0) + t.nu * xi; });
      Object.keys(avail).forEach(id => {
        if (avail[id] < -1e-9 * Math.max(1, scale)) throw new Error('That extent of reaction would use up more ' + id + ' than is fed (it would go negative). Lower the extent or conversion.');
        if (Math.abs(avail[id]) < 1e-12 * Math.max(1, scale)) avail[id] = 0;
      });
      extents.push({ xi, how, text: r.rx.text });
    });
    const nOut = avail;
    const outIds = Object.keys(nOut).filter(id => nOut[id] > 0);
    if (!outIds.length) throw new Error('Nothing leaves the reactor.');
    if (rxs.length) {
      steps.push(step('Amounts leaving: n(out) = n(in) + Σ ν ξ', rxs.map((r, k) => ({ label: 'Reaction ' + (k + 1) + ':  ' + extents[k].text, equation: 'extent of reaction', substituted: extents[k].how })).concat([{
        label: '', equation: 'n(i, out) = n(i, in) + Σ νᵢ ξ',
        substituted: Object.keys(nOut).map(id => id + ': ' + fmt(nIn[id] || 0, 6) + ' + ' + par(nOut[id] - (nIn[id] || 0), 6) + ' = ' + fmt(nOut[id], 6)).join(';  ') + '  (mol/s)' }]),
        Object.keys(nOut).map(id => ({ name: 'n(' + id + ', out)', value: nOut[id], unit: 'mol/s' }))));
    }

    // 2. enthalpy in
    const hOpts = id => ({ formation, refPhase: refPhase[id] });
    let Hin = 0;
    const inRows = [];
    feeds.forEach(f => {
      const sp = getSpecies(db, f.id), ph = resolvePhase(sp, f.phase, f.T, P);
      const e = enthalpyOf(sp, f.T, ph, P, hOpts(f.id), ctx, true);
      Hin += f.n * e.h;
      inRows.push({ f, sp, ph, e });
    });
    const enthalpyEq = (sp, e, T) => {
      const parts = [];
      if (formation) parts.push(par(e.hf, 6) + ' [ΔH°f ' + label(sp, e.refPhase) + ']');
      e.path.pieces.forEach(p => parts.push(par(p.value, 6) + ' [' + p.title.replace(/^(Heat|Cool) /, '').replace(' ' + sp.id, '') + ']'));
      if (!parts.length) parts.push('0');
      return parts.join(' + ');
    };
    steps.push(step('Enthalpy of the feed', inRows.map(r => ({
      label: 'ĥ(' + label(r.sp, r.ph) + ' at ' + tText(r.f.T) + ') = ' + (formation ? 'ΔH°f + ' : '') + 'path from 25 °C',
      equation: 'ĥ = ' + (formation ? 'ΔH°f + ' : '') + 'Σ (sensible + latent)',
      substituted: enthalpyEq(r.sp, r.e) + ' = ' + fmt(r.e.h, 6) + ' kJ/mol' })).concat([{
      label: '', equation: 'Ḣin = Σ ṅ ĥ',
      substituted: inRows.map(r => fmt(r.f.n, 6) + ' × ' + par(r.e.h, 6)).join(' + ') + ' = ' + fmt(Hin, 6) + ' kW' }]),
      [{ name: 'Ḣin', value: Hin, unit: 'kW' }]));

    // 3. solve for T
    const target = Hin + Q;
    const f = T => {
      let H = 0;
      outIds.forEach(id => {
        const sp = getSpecies(db, id);
        H += nOut[id] * enthalpyOf(sp, T, resolvePhase(sp, (o.outPhase && o.outPhase[id]) || 'auto', T, P), P, hOpts(id), null, false).h;
      });
      return H - target;
    };
    const Tin = Math.min.apply(null, feeds.map(x => x.T));
    const lo = hasVal(o.Tmin) ? Number(o.Tmin) : Math.max(60, Tin - 400), hi = hasVal(o.Tmax) ? Number(o.Tmax) : 6000;
    const sol = solveBracketed(f, lo, hi, 20);
    if (sol.below) throw new Error('Even at ' + tText(lo) + ' the leaving streams have more enthalpy than the energy balance allows: the heat removed is larger than the stream can give up. Check the sign of Q.');
    if (sol.above) throw new Error('No temperature up to ' + tText(hi) + ' balances the energy: the leaving streams cannot absorb that much energy. Check the numbers (is the heat too large, or the reaction too exothermic?).');
    let T = sol.T;
    // two-phase outlet: the balance is met by part of a species changing phase at its boiling point (f jumps there)
    let two = null;
    // a jump (latent heat) holds most of the change of the balance across the 20 K step that was bracketed; a smooth curve almost none of it
    if (Math.abs(sol.fHi - sol.fLo) > 0.5 * Math.abs(f(sol.scanTo) - f(sol.scanFrom))) {
      const jump = sol.fHi - sol.fLo;
      outIds.forEach(id => {
        const sp = getSpecies(db, id);
        const tb = hasVal(sp.Tb) ? boilingPoint(sp, P).T : null;
        if (tb !== null && Math.abs(tb - T) < 1e-6) {
          const Lj = nOut[id] * vapHeat(sp, tb, null).value;
          if (Math.abs(Lj - jump) < 1e-6 * Math.max(1, Math.abs(Lj))) two = { id, T: tb, latent: Lj };
        }
      });
      if (!two) throw new Error('The energy balance jumps across a phase change and has no exact solution. Check the data (a species may be missing a heat of vaporisation or fusion).');
      // exact: at the boiling point with all of species j liquid the balance is short by fLiq, which is the vapour fraction × latent heat
      T = two.T;
      let Hliq = 0;
      outIds.forEach(id => {
        const sp = getSpecies(db, id);
        const ph = id === two.id ? 'l' : resolvePhase(sp, (o.outPhase && o.outPhase[id]) || 'auto', T, P);
        Hliq += nOut[id] * enthalpyOf(sp, T, ph, P, hOpts(id), null, false).h;
      });
      two.vapour = (target - Hliq) / two.latent;
    }

    const outRows = [];
    let Hout = 0;
    outIds.forEach(id => {
      const sp = getSpecies(db, id);
      let ph = resolvePhase(sp, (o.outPhase && o.outPhase[id]) || 'auto', T, P);
      if (two && two.id === id) ph = 'g';
      const e = enthalpyOf(sp, T, ph, P, hOpts(id), ctx, true);
      let H = nOut[id] * e.h;
      if (two && two.id === id) {
        // part is liquid: replace the vapour enthalpy by the mixture
        const liq = enthalpyOf(sp, T, 'l', P, hOpts(id), ctx, false).h;
        H = nOut[id] * (two.vapour * e.h + (1 - two.vapour) * liq);
      }
      Hout += H;
      outRows.push({ id, sp, ph, e, H, n: nOut[id] });
    });
    steps.push(step('Energy balance for the reactor (steady flow, no shaft work)', [{
      label: Q === 0 ? 'Adiabatic: Q = 0.' : 'Heat added Q = ' + fmt(Q, 6) + ' kW (negative = heat removed).',
      equation: 'Q = Ḣout − Ḣin     so     Σ ṅᵢ,out ĥᵢ(T) = Ḣin + Q',
      substituted: 'Σ ṅᵢ,out ĥᵢ(T) = ' + fmt(Hin, 6) + ' + ' + par(Q, 6) + ' = ' + fmt(target, 6) + ' kW' }], [{ name: 'target Ḣout', value: target, unit: 'kW' }]));
    steps.push(step('Solve for the outlet temperature', [{
      label: 'Ḣout(T) rises with T, but it jumps at a boiling or melting point, so the root is bracketed and found by bisection (no guessing a starting value).',
      equation: 'f(T) = Σ ṅᵢ,out ĥᵢ(T) − target = 0',
      substituted: 'f(' + tText(sol.scanFrom) + ') = ' + fmt(f(sol.scanFrom), 5) + ' kW < 0 ;  f(' + tText(sol.scanTo) + ') = ' + fmt(f(sol.scanTo), 5) + ' kW ≥ 0 ;  halved ' + sol.iterations + ' times' }],
      [{ name: 'T(out)', value: T, unit: 'K' }, { name: 'T(out)', value: toC(T), unit: '°C' }]));
    steps.push(step('Enthalpy of the products at ' + tText(T) + ' (check)', outRows.map(r => ({
      label: 'ĥ(' + label(r.sp, r.ph) + ' at ' + tText(T) + ')', equation: 'ĥ = ' + (formation ? 'ΔH°f + ' : '') + 'Σ (sensible + latent)',
      substituted: enthalpyEq(r.sp, r.e) + ' = ' + fmt(r.e.h, 6) + ' kJ/mol' })).concat([{
      label: '', equation: 'Ḣout = Σ ṅ ĥ', substituted: outRows.map(r => fmt(r.n, 6) + ' × ' + par(r.H / r.n, 6)).join(' + ') + ' = ' + fmt(Hout, 6) + ' kW;  target ' + fmt(target, 6) + ' kW;  difference ' + fmt(Hout - target, 3) + ' kW' }]),
      [{ name: 'Ḣout', value: Hout, unit: 'kW' }]));
    if (two) {
      steps.push(step('The outlet is at the boiling point of ' + two.id, [{ label: 'The energy available is not enough to vaporise all of it (or too much to keep it liquid), so ' + two.id + ' leaves as a vapour-liquid mixture at its boiling point.',
        equation: 'vapour fraction = (target − Ḣ(all liquid)) / (ṅ ΔHvap)', substituted: fmt(two.vapour * 100, 5) + ' % of the ' + two.id + ' is vapour' }], [{ name: 'vapour fraction of ' + two.id, value: two.vapour, unit: '' }]));
    }
    return { T, TC: toC(T), Hin, Hout, Q, target, residual: Hout - target, extents, nOut, nIn, outlet: outRows.map(r => ({ id: r.id, n: r.n, phase: r.ph, h: r.e.h })), twoPhase: two,
      formation, steps, warnings: ctx.warnings, notes: ctx.notes, bracket: { lo: sol.lo, hi: sol.hi, iterations: sol.iterations } };
  }

  const AIR = { O2: 0.21, N2: 0.79 };   // mole fractions of dry air used for the flame calculation

  /* Adiabatic flame temperature. o: { fuel, excess (fraction, 0.2 = 20 % excess air), Tfuel, Tair (K), conversion (0–1, default 1),
     basis (mol/s of fuel, default 1), fuelPhase, waterPhase ('l' or 'g' reference for the H2O formed, default 'g'), P, db } */
  function flameTemperature(o) {
    const db = o.db || SPECIES;
    const sp = getSpecies(db, o.fuel);
    const c = combustionReaction(o.fuel, db, o.fuelPhase);
    const at = parseFormula(sp.formula);
    const x = at.C || 0, y = at.H || 0, w = at.N || 0, v = at.S || 0;
    const ex = hasVal(o.excess) ? Number(o.excess) : 0;
    if (!(ex > -1)) throw new Error('Excess air must be above −100 %.');
    const n = hasVal(o.basis) && Number(o.basis) > 0 ? Number(o.basis) : 1;
    const conv = hasVal(o.conversion) ? Number(o.conversion) : 1;
    const O2 = c.o2 * (1 + ex) * n;
    const wp = o.waterPhase || 'g';
    const prods = [x ? (x === 1 ? '' : fmt(x, 6) + ' ') + 'CO2(g)' : null, y ? (y / 2 === 1 ? '' : fmt(y / 2, 6) + ' ') + 'H2O(' + wp + ')' : null,
      w ? (w / 2 === 1 ? '' : fmt(w / 2, 6) + ' ') + 'N2(g)' : null, v ? (v === 1 ? '' : fmt(v, 6) + ' ') + 'SO2(g)' : null].filter(Boolean).join(' + ');
    const text = c.text.replace(/ O2$/, ' O2(g)') + ' -> ' + prods;
    if (v) getSpecies(db, 'SO2');
    const feeds = [{ id: o.fuel, n, T: o.Tfuel, phase: c.fuelPhase }, { id: 'O2', n: O2, T: o.Tair }, { id: 'N2', n: O2 * AIR.N2 / AIR.O2, T: o.Tair }];
    const res = adiabatic({ reactions: [{ text, conversion: { id: o.fuel, x: conv } }], feeds, P: o.P, Q: 0, db, Tmin: o.Tmin, Tmax: o.Tmax });
    res.steps.unshift(step('Basis and air supply', [{
      label: 'Air is taken as 21 mol % O2 and 79 mol % N2. Theoretical O2 = ' + fmt(c.o2, 6) + ' mol per mol of fuel (complete combustion).',
      equation: 'O2 fed = (theoretical O2) × (1 + excess air) × (fuel flow);  N2 fed = O2 × 79/21',
      substituted: 'O2 = ' + fmt(c.o2, 6) + ' × ' + fmt(1 + ex, 6) + ' × ' + fmt(n, 6) + ' = ' + fmt(O2, 6) + ' mol/s;  N2 = ' + fmt(O2, 6) + ' × 79/21 = ' + fmt(O2 * AIR.N2 / AIR.O2, 6) + ' mol/s' }],
      [{ name: 'air fed', value: O2 / AIR.O2, unit: 'mol/s' }]));
    res.fuel = o.fuel; res.reaction = text; res.excess = ex; res.air = O2 / AIR.O2; res.O2fed = O2;
    return res;
  }

  /* ───────────────────────── 5. steady open-system balance ───────────────────────── */

  /* o: { inlets: [stream], outlets: [stream], Ws (kW, work done by the system, default 0), formation (default: automatic), P, db }
     stream: { name, T (K), P (kPa, optional), species: [{ id, n (mol/s), phase }], u (m/s, optional), z (m, optional) }
     First law for steady flow:  Q − Ws = ΔḢ + ΔĖk + ΔĖp,  with Q positive when heat is added to the system and Ws positive when
     the system does work on its surroundings. */
  function openSystem(o) {
    const db = o.db || SPECIES, ctx = newCtx();
    const mk = (list, kind) => (list || []).map((s, i) => {
      const species = (s.species || []).filter(c => c && hasVal(c.id) && Number(c.n) > 0).map(c => ({ id: String(c.id).trim(), n: Number(c.n), phase: c.phase || 'auto' }));
      if (!species.length) throw new Error('The ' + kind + ' stream ' + (s.name || (i + 1)) + ' has no species with a flow above zero.');
      if (!(Number(s.T) > 0)) throw new Error('Enter the temperature of the ' + kind + ' stream ' + (s.name || (i + 1)) + '.');
      return { name: s.name || (kind === 'inlet' ? 'In ' : 'Out ') + (i + 1), T: Number(s.T), P: hasVal(s.P) ? Number(s.P) : (o.P || P0), species, u: hasVal(s.u) ? Number(s.u) : 0, z: hasVal(s.z) ? Number(s.z) : 0 };
    });
    const ins = mk(o.inlets, 'inlet'), outs = mk(o.outlets, 'outlet');
    if (!ins.length || !outs.length) throw new Error('Give at least one inlet stream and one outlet stream.');
    const tot = list => { const t = {}; list.forEach(s => s.species.forEach(c => { t[c.id] = (t[c.id] || 0) + c.n; })); return t; };
    const tin = tot(ins), tout = tot(outs);
    const ids = Object.keys(Object.assign({}, tin, tout));
    const scale = Math.max(1, ids.reduce((a, k) => a + (tin[k] || 0), 0));
    const changed = ids.some(k => Math.abs((tin[k] || 0) - (tout[k] || 0)) > 1e-8 * scale);
    const formation = changed ? true : !!o.formation;
    const steps = [];
    steps.push(step('Reference state', [{
      label: formation ? 'The amounts of species change between inlet and outlet (a reaction), so enthalpies are measured from the elements at 25 °C: ĥ = ΔH°f + path from 25 °C. Heats of formation are needed for every species.'
                       : 'No species is made or used up, so enthalpies are measured from each species at 25 °C and 1 atm in its standard phase: ĥ = 0 there.',
      equation: formation ? 'ĥ(T) = ΔH°f(25 °C) + ∫Cp dT (+ latent heats)' : 'ĥ(T) = ∫Cp dT from 25 °C (+ latent heats)',
      substituted: 'Pressure effects on ĥ are neglected (ideal gases, incompressible liquids).' }], []));
    const calc = s => {
      let H = 0, mass = 0;
      const rows = s.species.map(c => {
        const sp = getSpecies(db, c.id), ph = resolvePhase(sp, c.phase, s.T, s.P);
        const e = enthalpyOf(sp, s.T, ph, s.P, { formation }, ctx, true);
        H += c.n * e.h; mass += c.n * (sp.M || 0) / 1000;
        return { id: c.id, sp, n: c.n, phase: ph, e, H: c.n * e.h };
      });
      return { s, rows, H, mass };
    };
    const describe = (cs, kind) => {
      cs.forEach(r => {
        steps.push(step('Enthalpy of ' + kind + ' stream "' + r.s.name + '" at ' + tText(r.s.T), r.rows.map(q => {
          const parts = [];
          if (formation) parts.push(par(q.e.hf, 6) + ' [ΔH°f ' + label(q.sp, q.e.refPhase) + ']');
          q.e.path.pieces.forEach(p => parts.push(par(p.value, 6) + ' [' + p.title + ']'));
          if (!parts.length) parts.push('0');
          return { label: 'ĥ(' + label(q.sp, q.phase) + ')', equation: 'ĥ = ' + (formation ? 'ΔH°f + ' : '') + 'Σ (sensible + latent)', substituted: parts.join(' + ') + ' = ' + fmt(q.e.h, 6) + ' kJ/mol' };
        }).concat([{ label: '', equation: 'Ḣ = Σ ṅ ĥ', substituted: r.rows.map(q => fmt(q.n, 6) + ' × ' + par(q.e.h, 6)).join(' + ') + ' = ' + fmt(r.H, 6) + ' kW' }]),
          [{ name: 'Ḣ(' + r.s.name + ')', value: r.H, unit: 'kW' }]));
      });
    };
    const cin = ins.map(calc), cout = outs.map(calc);
    describe(cin, 'inlet'); describe(cout, 'outlet');
    const Hin = cin.reduce((a, r) => a + r.H, 0), Hout = cout.reduce((a, r) => a + r.H, 0), dH = Hout - Hin;
    const ke = list => list.reduce((a, r) => a + r.mass * r.s.u * r.s.u / 2 / 1000, 0);
    const pe = list => list.reduce((a, r) => a + r.mass * GRAV * r.s.z / 1000, 0);
    const dKE = ke(cout) - ke(cin), dPE = pe(cout) - pe(cin);
    const Ws = hasVal(o.Ws) ? Number(o.Ws) : 0;
    const Q = dH + dKE + dPE + Ws;
    steps.push(step('Change of enthalpy', [{ label: '', equation: 'ΔḢ = Σ Ḣout − Σ Ḣin', substituted: fmt(Hout, 6) + ' − ' + par(Hin, 6) + ' = ' + fmt(dH, 6) + ' kW' }], [{ name: 'ΔḢ', value: dH, unit: 'kW' }]));
    const anyKE = [].concat(ins, outs).some(s => s.u !== 0 || s.z !== 0);
    if (anyKE) {
      steps.push(step('Kinetic and potential energy', [
        { label: 'Mass flow ṁ = Σ ṅ M (kg/s)', equation: 'ΔĖk = Σ ṁ u²/2 (out) − Σ ṁ u²/2 (in)', substituted: fmt(dKE, 6) + ' kW' },
        { label: '', equation: 'ΔĖp = Σ ṁ g z (out) − Σ ṁ g z (in),  g = 9.80665 m/s²', substituted: fmt(dPE, 6) + ' kW' }],
        [{ name: 'ΔĖk', value: dKE, unit: 'kW' }, { name: 'ΔĖp', value: dPE, unit: 'kW' }]));
    }
    steps.push(step('First law for steady flow', [{ label: 'Q is the heat added to the system, Ws the shaft work done by the system on its surroundings.',
      equation: 'Q − Ws = ΔḢ + ΔĖk + ΔĖp',
      substituted: 'Q = ' + fmt(dH, 6) + ' + ' + par(dKE, 6) + ' + ' + par(dPE, 6) + ' + ' + par(Ws, 6) + ' = ' + fmt(Q, 6) + ' kW' }],
      [{ name: 'Q', value: Q, unit: 'kW' }]));
    const view = r => ({ name: r.s.name, T: r.s.T, H: r.H, mass: r.mass, species: r.rows.map(q => ({ id: q.id, n: q.n, phase: q.phase, h: q.e.h, H: q.H })) });
    return { Q, dH, Hin, Hout, dKE, dPE, Ws, formation, inlets: cin.map(view), outlets: cout.map(view), steps, warnings: ctx.warnings, notes: ctx.notes };
  }

  /* Enthalpy of a stream at once (numbers only): { T (K), P, species: [{ id, n, phase }] , formation } → kW. Handy for checks. */
  function streamEnthalpy(s, db, formation) {
    db = db || SPECIES;
    let H = 0;
    s.species.forEach(c => {
      const sp = getSpecies(db, c.id);
      const ph = resolvePhase(sp, c.phase || 'auto', s.T, s.P || P0);
      H += c.n * enthalpyOf(sp, s.T, ph, s.P || P0, { formation: !!formation }, null, false).h;
    });
    return H;
  }

  return {
    R, T0, P0, toK, toC, SPECIES, PHASES, PHASE_NAME, AIR, ATOMIC_WEIGHT,
    parseFormula, molarMass, scaleCoefficients, extendDatabase, getSpecies, findSpecies,
    cpAt, integrateCp, inRange, watson, boilingPoint, autoPhase, resolvePhase,
    pathCalc, enthalpyOf, streamEnthalpy, molarEnthalpy, molarCp, enthalpyDetail, solveBracketed,
    sensibleHeat, phaseChange, latentHeat,
    parseEquation, standardReaction, heatOfReaction, combustionReaction, combustion,
    adiabatic, flameTemperature, openSystem
  };
});
