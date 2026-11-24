/*
 * I want to survive Chem Eng too — shared calculation core: unit conversion,
 * number parsing/formatting, Antoine vapour pressure, ideal gas.
 * Works in the browser (window.Chem) and in Node (module.exports) so the
 * maths can be unit-tested without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Chem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* R in J/(mol·K). The same number is R in kPa·L/(mol·K), so idealGas()
     works for (Pa, m³) or (kPa, L) as long as you stay consistent. */
  const R = 8.314462618;

  /* ───────────────────────── Units ───────────────────────── */

  // Each unit maps to its size in the category's base unit (Pa, J, W, kg, m, m³, m³/s, kg/s, kg/m³, Pa·s, mol).
  const CATEGORIES = {
    pressure: {
      label: 'Pressure', def: ['psi', 'kPa'],
      units: { Pa: 1, kPa: 1e3, MPa: 1e6, bar: 1e5, atm: 101325, mmHg: 133.322387415, torr: 101325 / 760, psi: 6894.757293168 }
    },
    temperature: {
      label: 'Temperature', def: ['°C', '°F'], special: true,
      units: { '°C': null, K: null, '°F': null, '°R': null }
    },
    energy: {
      label: 'Energy', def: ['kWh', 'MJ'],
      units: { J: 1, kJ: 1e3, MJ: 1e6, cal: 4.184, kcal: 4184, BTU: 1055.05585262, kWh: 3.6e6 }
    },
    power: {
      label: 'Power', def: ['hp', 'kW'],
      units: { W: 1, kW: 1e3, MW: 1e6, hp: 745.69987158, 'BTU/h': 1055.05585262 / 3600, 'kcal/h': 4184 / 3600 }
    },
    mass: {
      label: 'Mass', def: ['lb', 'kg'],
      units: { g: 1e-3, kg: 1, tonne: 1e3, lb: 0.45359237, oz: 0.028349523125 }
    },
    length: {
      label: 'Length', def: ['in', 'mm'],
      units: { mm: 1e-3, cm: 1e-2, m: 1, km: 1e3, in: 0.0254, ft: 0.3048 }
    },
    volume: {
      label: 'Volume', def: ['gal (US)', 'L'],
      units: { mL: 1e-6, L: 1e-3, 'm³': 1, 'gal (US)': 0.003785411784, 'ft³': 0.028316846592, bbl: 0.158987294928 }
    },
    volFlow: {
      label: 'Volumetric flow rate', def: ['gal/min', 'm³/h'],
      units: { 'L/s': 1e-3, 'L/min': 1e-3 / 60, 'm³/s': 1, 'm³/h': 1 / 3600, 'gal/min': 0.003785411784 / 60, 'ft³/min': 0.028316846592 / 60 }
    },
    massFlow: {
      label: 'Mass flow rate', def: ['lb/h', 'kg/h'],
      units: { 'g/s': 1e-3, 'kg/s': 1, 'kg/h': 1 / 3600, 't/h': 1e3 / 3600, 'lb/s': 0.45359237, 'lb/h': 0.45359237 / 3600 }
    },
    density: {
      label: 'Density', def: ['lb/ft³', 'kg/m³'],
      units: { 'kg/m³': 1, 'g/cm³': 1e3, 'kg/L': 1e3, 'lb/ft³': 16.01846337, 'lb/gal': 0.45359237 / 0.003785411784 }
    },
    viscosity: {
      label: 'Dynamic viscosity', def: ['cP', 'Pa·s'],
      units: { 'Pa·s': 1, 'mPa·s': 1e-3, cP: 1e-3, P: 0.1, 'lb/(ft·s)': 1.488163944 }
    },
    amount: {
      label: 'Amount of substance', def: ['kmol', 'mol'],
      units: { mmol: 1e-3, mol: 1, kmol: 1e3, lbmol: 453.59237 }
    },
    time: {
      label: 'Time', def: ['h', 's'],
      units: { s: 1, min: 60, h: 3600, day: 86400 }
    },
    current: {
      label: 'Electric current', def: ['kA', 'A'],
      units: { mA: 1e-3, A: 1, kA: 1e3 }
    },
    charge: {
      label: 'Electric charge', def: ['A·h', 'C'],
      // 1 faraday = elementary charge × Avogadro constant (exact in the 2019 SI)
      units: { C: 1, 'A·h': 3600, 'kA·h': 3.6e6, faraday: 96485.33212 }
    },
    currentDensity: {
      label: 'Current density', def: ['mA/cm²', 'A/m²'],
      units: { 'A/m²': 1, 'kA/m²': 1e3, 'mA/cm²': 10, 'A/cm²': 1e4 }
    }
  };

  const TEMP_TO_K = {
    '°C': v => v + 273.15, K: v => v,
    '°F': v => (v - 32) * 5 / 9 + 273.15, '°R': v => v * 5 / 9
  };
  const TEMP_FROM_K = {
    '°C': k => k - 273.15, K: k => k,
    '°F': k => (k - 273.15) * 9 / 5 + 32, '°R': k => k * 9 / 5
  };

  function convert(cat, value, from, to) {
    const def = CATEGORIES[cat];
    if (!def) throw new Error('Unknown category: ' + cat);
    if (def.special) return TEMP_FROM_K[to](TEMP_TO_K[from](value));
    const f = def.units[from], t = def.units[to];
    if (f === undefined || t === undefined) throw new Error('Unknown unit: ' + from + ' or ' + to);
    return value * f / t;
  }

  /* ───────────────────────── Formatting / parsing ───────────────────────── */

  function fmt(x, sig) {
    sig = sig || 4;
    if (typeof x !== 'number' || !isFinite(x)) return '—';
    if (x === 0) return '0';
    const a = Math.abs(x);
    if (a >= 1e7 || a < 1e-3) return x.toExponential(sig - 1).replace(/\.?0+e/, 'e').replace('e+', 'e');
    return String(Number(x.toPrecision(sig)));
  }

  function parseNumber(s) {
    if (typeof s === 'number') return s;
    let t = String(s).trim().replace(/\s+/g, '').replace(/−/g, '-').replace('×10^', 'e');
    if (t === '') return NaN;
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');   // 1,234.5
    else if (/^[-+]?\d*,\d+$/.test(t)) t = t.replace(',', '.');                // 1,5 → 1.5
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
  }

  /* ───────────────────────── Antoine / vapour pressure ───────────────────────── */

  /* Built-in constants: log10(P / bar) = A − B / (T / K + C).
     Ranges are the stated validity range of each set. */
  const COMPOUNDS = {
    // Water: the common 1–100 °C set, log10(P/mmHg) = 8.07131 − 1730.63/(T/°C + 233.426), converted to bar and K.
    water:    { name: 'Water',    formula: 'H₂O',    A: 5.19621, B: 1730.63,  C: -39.724, Tmin: 274.15, Tmax: 373.15 },
    ethanol:  { name: 'Ethanol',  formula: 'C₂H₅OH', A: 5.24677, B: 1598.673, C: -46.424, Tmin: 292.77, Tmax: 366.63 },
    methanol: { name: 'Methanol', formula: 'CH₃OH',  A: 5.20409, B: 1581.341, C: -33.50,  Tmin: 288.1,  Tmax: 356.83 },
    acetone:  { name: 'Acetone',  formula: 'C₃H₆O',  A: 4.42448, B: 1312.253, C: -32.445, Tmin: 259.16, Tmax: 507.6 },
    benzene:  { name: 'Benzene',  formula: 'C₆H₆',   A: 4.01814, B: 1203.835, C: -53.226, Tmin: 287.7,  Tmax: 354.07 },
    toluene:  { name: 'Toluene',  formula: 'C₇H₈',   A: 4.07827, B: 1343.943, C: -53.773, Tmin: 308.52, Tmax: 384.66 },
    hexane:   { name: 'n-Hexane', formula: 'C₆H₁₄',  A: 4.00266, B: 1171.53,  C: -48.784, Tmin: 286.18, Tmax: 342.69 }
  };

  // Generic Antoine form, any units, log10 or natural log.
  function antoineP(A, B, C, T, useLn) {
    const x = A - B / (T + C);
    return useLn ? Math.exp(x) : Math.pow(10, x);
  }
  function antoineT(A, B, C, P, useLn) {
    const l = useLn ? Math.log(P) : Math.log10(P);
    return B / (A - l) - C;
  }

  const vapourPressureBar = (c, TK) => antoineP(c.A, c.B, c.C, TK, false);
  const boilingPointK = (c, Pbar) => antoineT(c.A, c.B, c.C, Pbar, false);

  /* ───────────────────────── Ideal gas ───────────────────────── */

  // Pass three of {P, V, n, T}; the missing one is solved for.
  function idealGas(s, Rval) {
    Rval = Rval || R;
    const missing = ['P', 'V', 'n', 'T'].filter(k => s[k] === null || s[k] === undefined);
    if (missing.length !== 1) throw new Error('Exactly one of P, V, n, T must be missing');
    const { P, V, n, T } = s;
    switch (missing[0]) {
      case 'P': return { key: 'P', value: n * Rval * T / V };
      case 'V': return { key: 'V', value: n * Rval * T / P };
      case 'n': return { key: 'n', value: P * V / (Rval * T) };
      default:  return { key: 'T', value: P * V / (n * Rval) };
    }
  }

  return {
    R, CATEGORIES, convert, fmt, parseNumber,
    COMPOUNDS, antoineP, antoineT, vapourPressureBar, boilingPointK,
    idealGas
  };
});
