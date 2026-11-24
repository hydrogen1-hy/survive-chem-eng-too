// Run with:  node tests/energy.test.js
const assert = require('node:assert/strict');
const Chem = require('../js/chem.js');
const Energy = require('../js/energy.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a} (rel err ${(err * 100).toFixed(4)}%)`);
};
const near = (a, b, absTol, msg) => assert.ok(Math.abs(a - b) <= absTol, `${msg || ''} expected ${b} ± ${absTol}, got ${a}`);
const throwsMsg = (fn, re) => {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  assert.ok(msg !== null, 'expected an error');
  if (re) assert.ok(re.test(msg), 'error message was: ' + msg);
};
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SP = Energy.SPECIES;
const K = Energy.toK;

/* ───────── independent helpers, written without using the library's own integration ───────── */

// Cp from the raw coefficients, evaluated term by term
const cpRef = (c, T) => { const u = c.Tunit === 'K' ? T : T - 273.15; return c.a + c.b * u + c.c * u * u + c.d * u * u * u; };
// Simpson's rule (exact for a cubic) in J/mol, returned in kJ/mol
function integ(c, T1, T2) {
  const n = 40, h = (T2 - T1) / n;
  let s = cpRef(c, T1) + cpRef(c, T2);
  for (let i = 1; i < n; i++) s += cpRef(c, T1 + i * h) * (i % 2 ? 4 : 2);
  return s * h / 3 / 1000;
}
const dHgas = (id, T1, T2) => integ(SP[id].Cp.g, T1, T2);

/* ═════════════════════════ DATA, checked against independent sources ═════════════════════════ */

/* NIST-JANAF Thermochemical Tables (janaf.nist.gov), ideal gases: H(T) − H(298.15 K) in kJ/mol, Cp(298.15 K) in J/(mol·K)
   and ΔfH(298.15 K) in kJ/mol, copied from the tables N-023, O-029, H-050, C-093, C-095, C-067, H-083, H-064, C-127, C-128. */
const JANAF_DH = {
  N2: { 400: 2.971, 500: 5.911, 600: 8.894, 800: 15.046, 1000: 21.463, 1200: 28.109 },
  O2: { 400: 3.025, 500: 6.084, 600: 9.244, 800: 15.835, 1000: 22.703, 1200: 29.761 },
  H2: { 400: 2.959, 500: 5.882, 600: 8.811, 800: 14.702, 1000: 20.68, 1200: 26.797 },
  CO: { 400: 2.976, 500: 5.931, 600: 8.942, 800: 15.177, 1000: 21.69, 1200: 28.43 },
  CO2: { 400: 4.003, 500: 8.305, 600: 12.907, 800: 22.806, 1000: 33.397, 1200: 44.473 },
  CH4: { 400: 3.861, 500: 8.2, 600: 13.13, 800: 24.675, 1000: 38.179, 1200: 53.27 },
  NH3: { 400: 3.781, 500: 7.819, 600: 12.188, 800: 21.853, 1000: 32.637, 1200: 44.402 },
  H2O: { 400: 3.452, 500: 6.925, 600: 10.501, 800: 18.002, 1000: 26.0, 1200: 34.506 },
  C2H2: { 400: 4.833, 500: 10.108, 600: 15.771, 800: 27.992, 1000: 41.208, 1200: 55.252 },
  C2H4: { 400: 4.882, 500: 10.668, 600: 17.335, 800: 32.847, 1000: 50.665, 1200: 70.252 }
};
const JANAF_CP298 = { N2: 29.124, O2: 29.376, H2: 28.836, CO: 29.142, CO2: 37.129, CH4: 35.639, NH3: 35.652, H2O: 33.59, C2H2: 44.095, C2H4: 42.886 };
const JANAF_HF = { N2: 0, O2: 0, H2: 0, CO: -110.527, CO2: -393.522, CH4: -74.873, NH3: -45.898, H2O: -241.826, C2H2: 226.731, C2H4: 52.467 };

test('gas Cp polynomials reproduce the NIST-JANAF enthalpy increments from 298 K to 1200 K (within the fit error)', () => {
  // The textbook polynomials are cubic fits over 0–1200 °C or more: allow 2.5 % + 0.01 kJ/mol.
  for (const id of Object.keys(JANAF_DH)) {
    for (const T of Object.keys(JANAF_DH[id])) {
      const ref = JANAF_DH[id][T];
      const got = Energy.sensibleHeat({ species: [{ id, n: 1 }], T1: 298.15, T2: Number(T), phase: 'g' }).dH;
      assert.ok(Math.abs(got - ref) <= 0.025 * ref + 0.01, `${id} 298→${T} K: got ${got.toFixed(3)}, JANAF ${ref}`);
    }
  }
});

test('gas Cp at 298 K agrees with NIST-JANAF within 3 %', () => {
  for (const id of Object.keys(JANAF_CP298)) close(Energy.cpAt(SP[id].Cp.g, 298.15), JANAF_CP298[id], 0.03, id);
});

test('heats of formation agree with NIST-JANAF within 0.5 kJ/mol (the textbook uses slightly older values)', () => {
  for (const id of Object.keys(JANAF_HF)) near(SP[id].Hf.g, JANAF_HF[id], 0.5, id);
  near(SP.H2O.Hf.l, -285.830, 0.1, 'H2O(l) from JANAF table H-063');
  close(Energy.cpAt(SP.H2O.Cp.l, 298.15), 75.351, 0.002, 'liquid water Cp from JANAF table H-063');
});

/* Felder & Rousseau Table B.8 (printed in the book): specific enthalpies of gases in kJ/mol relative to 25 °C. Those values were
   made from the Table B.2 polynomials, so they check that the coefficients here were copied correctly. Columns: air O2 N2 H2 CO CO2 H2O. */
const B8_COLS = ['air', 'O2', 'N2', 'H2', 'CO', 'CO2', 'H2O'];
const B8 = {
  0:    [-0.72, -0.73, -0.73, -0.72, -0.73, -0.92, -0.84],
  100:  [2.19, 2.24, 2.19, 2.16, 2.19, 2.90, 2.54],
  200:  [5.15, 5.31, 5.13, 5.06, 5.16, 7.08, 6.01],
  300:  [8.17, 8.47, 8.12, 7.96, 8.17, 11.58, 9.57],
  400:  [11.24, 11.72, 11.15, 10.89, 11.25, 16.35, 13.23],
  500:  [14.37, 15.03, 14.24, 13.83, 14.38, 21.34, 17.01],
  600:  [17.55, 18.41, 17.39, 16.81, 17.57, 26.53, 20.91],
  700:  [20.80, 21.86, 20.59, 19.81, 20.82, 31.88, 24.92],
  800:  [24.10, 25.35, 23.86, 22.85, 24.13, 37.36, 29.05],
  900:  [27.46, 28.89, 27.19, 25.93, 27.49, 42.94, 33.32],
  1000: [30.86, 32.47, 30.56, 29.04, 30.91, 48.60, 37.69],
  1100: [34.31, 36.07, 33.99, 32.19, 34.37, 54.33, 42.18],
  1200: [37.81, 39.70, 37.46, 35.39, 37.87, 60.14, 46.78],
  1300: [41.34, 43.38, 40.97, 38.62, 41.40, 65.98, 51.47],
  1400: [44.89, 47.07, 44.51, 41.90, 44.95, 71.89, 56.25],
  1500: [48.45, 50.77, 48.06, 45.22, 48.51, 77.84, 61.09]
};
test('enthalpies of air, O2, N2, H2, CO, CO2 and water vapour reproduce Felder Table B.8 (7 gases × 16 temperatures)', () => {
  for (const t of Object.keys(B8)) {
    B8_COLS.forEach((id, i) => {
      const got = Energy.sensibleHeat({ species: [{ id, n: 1 }], T1: 298.15, T2: K(Number(t)), phase: 'g' }).dH;
      near(got, B8[t][i], 0.015, `${id} at ${t} °C`);
    });
  }
});

test('user example: heating N2 from 25 to 100 °C takes about 2.19 kJ/mol', () => {
  const r = Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: 298.15, T2: 373.15, phase: 'g' });
  near(r.dH, 2.19, 0.01);
  // JANAF: H(400 K) − H(298.15 K) = 2.971 and H(373.15 K) from its 350 K row 1.511 plus Cp ≈ 29.2 × 23.15 K ≈ 0.676, so 2.187
  near(r.dH, 1.511 + 29.2 * 23.15 / 1000, 0.01, 'JANAF interpolation');
});

test('air agrees with its 21 % O2 / 79 % N2 mixture within 1 % (a check on three separate rows)', () => {
  for (const T of [373.15, 573.15, 873.15, 1273.15]) {
    const air = Energy.sensibleHeat({ species: [{ id: 'air', n: 1 }], T1: 298.15, T2: T, phase: 'g' }).dH;
    const mix = Energy.sensibleHeat({ species: [{ id: 'O2', n: 0.21 }, { id: 'N2', n: 0.79 }], T1: 298.15, T2: T, phase: 'g' }).dH;
    close(air, mix, 0.01, 'T = ' + T);
  }
});

/* Handbook values (CRC Handbook of Chemistry and Physics, NIST WebBook) for the phase-change data. Tolerances are given per quantity. */
const HVAP_NBP = { H2O: 40.65, C2H5OH: 38.56, CH3OH: 35.21, C6H6: 30.72, C7H8: 33.18, C6H14: 28.85, C3H6O: 29.10, N2: 5.57, O2: 6.82, H2: 0.90, CH4: 8.19, NH3: 23.3, CO: 6.04, C2H6: 14.7, C3H8: 18.8, C4H10: 22.4, C2H4: 13.5 };
const TB_C = { H2O: 100.0, C2H5OH: 78.37, CH3OH: 64.7, C6H6: 80.1, C7H8: 110.6, C6H14: 68.7, C3H6O: 56.05, N2: -195.8, O2: -183.0, CH4: -161.5, NH3: -33.3, C2H6: -88.6, C3H8: -42.1, C4H10: -0.5, C2H4: -103.7, CO: -191.5 };
const TM_C = { H2O: 0.0, C2H5OH: -114.1, CH3OH: -97.6, C6H6: 5.5, C7H8: -95.0, C6H14: -95.3, C3H6O: -94.7, N2: -210.0, O2: -218.8, CH4: -182.5, NH3: -77.7 };
const HFUS = { H2O: 6.01, C2H5OH: 4.93, CH3OH: 3.22, C6H6: 9.87, C7H8: 6.64, C6H14: 13.1, N2: 0.72, O2: 0.44, CH4: 0.94, NH3: 5.66 };
const TC_K = { H2O: 647.1, C2H5OH: 514.0, CH3OH: 512.6, C6H6: 562.0, C7H8: 591.8, C6H14: 507.5, C3H6O: 508.1, N2: 126.2, O2: 154.6, CH4: 190.6, NH3: 405.4, CO2: 304.1 };

test('boiling points, melting points and critical temperatures match handbook values', () => {
  for (const id of Object.keys(TB_C)) near(Energy.toC(SP[id].Tb), TB_C[id], 0.3, 'Tb ' + id);
  for (const id of Object.keys(TM_C)) near(Energy.toC(SP[id].Tm), TM_C[id], 0.6, 'Tm ' + id);
  for (const id of Object.keys(TC_K)) close(SP[id].Tc, TC_K[id], 0.01, 'Tc ' + id);
});

test('heats of vaporisation at the normal boiling point match handbook values (acetone differs by 4 %: Felder 30.2, NIST 29.1)', () => {
  for (const id of Object.keys(HVAP_NBP)) close(SP[id].Hvap, HVAP_NBP[id], id === 'C3H6O' ? 0.05 : 0.02, 'ΔHvap ' + id);
  for (const id of Object.keys(HFUS)) close(SP[id].Hfus, HFUS[id], 0.03, 'ΔHfus ' + id);
});

test('boiling points agree with the Antoine data in chem.js (normal boiling point within 1.5 K)', () => {
  let n = 0;
  for (const sp of Object.values(SP)) {
    if (!sp.antoine) continue;
    const T = Chem.boilingPointK(Chem.COMPOUNDS[sp.antoine], 1.01325);
    assert.ok(Math.abs(T - sp.Tb) < 1.5, `${sp.id}: Antoine ${T.toFixed(2)} K, table ${sp.Tb.toFixed(2)} K`);
    n++;
  }
  assert.ok(n >= 7, 'every solvent should be linked to its Antoine constants');
});

test('Trouton: ΔHvap/Tb is between 65 and 115 J/(mol·K) for every species (hydrogen is a quantum liquid and is left out)', () => {
  for (const sp of Object.values(SP)) {
    if (sp.Hvap === null || sp.id === 'H2') continue;
    const r = sp.Hvap * 1000 / sp.Tb;
    assert.ok(r > 65 && r < 115, `${sp.id}: ${r.toFixed(1)}`);
  }
});

test('Watson correlation: ΔHvap of water at 25 °C by hand, and the other solvents against handbook values at 25 °C', () => {
  // water: 40.656 × [(1 − 298.15/647.4) / (1 − 373.15/647.4)]^0.38 = 40.656 × (0.53946 / 0.42362)^0.38 = 40.656 × 1.27345^0.38 = 40.656 × 1.09623 = 44.57
  const w = Energy.latentHeat({ id: 'H2O', kind: 'vap', T: 298.15 });
  close(w.value, 40.656 * Math.pow((1 - 298.15 / 647.4) / (1 - 373.15 / 647.4), 0.38), 1e-12);
  close(w.value, 44.57, 1e-3);
  close(w.value, 43.99, 0.015, 'against the handbook 43.99 kJ/mol');
  const CRC25 = { C6H6: 33.83, C7H8: 38.01, C6H14: 31.56, CH3OH: 37.43, C2H5OH: 42.32, C3H6O: 30.99 };
  // acetone: the tabulated 30.2 at the boiling point is 4 % above the handbook 29.1, and Watson carries that error to 25 °C
  for (const id of Object.keys(CRC25)) close(Energy.latentHeat({ id, kind: 'vap', T: 298.15 }).value, CRC25[id], id === 'C3H6O' ? 0.05 : 0.035, id);
  // at the normal boiling point it returns the tabulated value, and it falls to zero towards Tc
  close(Energy.latentHeat({ id: 'H2O', kind: 'vap', T: 373.15 }).value, 40.656, 1e-12);
  assert.ok(Energy.watson(40.656, 373.15, 645, 647.4) < 8, 'ΔHvap falls towards zero at the critical point');
  throwsMsg(() => Energy.latentHeat({ id: 'H2O', kind: 'vap', T: 700 }), /critical/);
});

test('gas Cp at 25 °C of the solvents and hydrocarbons is within 4 % of the standard values', () => {
  // NIST WebBook / TRC ideal-gas Cp at 298 K, J/(mol·K)
  const ref = { CH3OH: 44.1, C2H5OH: 65.6, C3H6O: 74.5, C6H6: 82.4, C7H8: 103.6, C6H14: 142.6, C2H6: 52.5, C3H8: 73.6, C4H10: 97.5 };
  for (const id of Object.keys(ref)) close(Energy.cpAt(SP[id].Cp.g, 298.15), ref[id], 0.04, id);
});

test('liquid Cp at 25 °C of the solvents is near handbook values (Felder gives mean values over a range, so the tolerance differs)', () => {
  // CRC, J/(mol·K) at 25 °C. n-hexane's 216.3 is a mean over 20–100 °C and ethanol's is a line through two points, hence the loose limits.
  const ref = { C7H8: [157.3, 0.01], CH3OH: [81.1, 0.03], C3H6O: [125.5, 0.03], C6H6: [136.0, 0.04], C2H5OH: [112.4, 0.05], C6H14: [195.6, 0.12] };
  for (const id of Object.keys(ref)) close(Energy.cpAt(SP[id].Cp.l, 298.15), ref[id][0], ref[id][1], id);
});

test('molar masses from the formulas agree with the tabulated values', () => {
  const felder = { H2O: 18.016, CO2: 44.01, CH4: 16.04, C2H5OH: 46.07, N2: 28.02, O2: 32.00, NH3: 17.03, C6H6: 78.11, C7H8: 92.13, C6H14: 86.17, CH3OH: 32.04, C3H6O: 58.08, C2H6: 30.07, C3H8: 44.09, C4H10: 58.12, H2: 2.016, CO: 28.01, C2H2: 26.04, C2H4: 28.05 };
  for (const id of Object.keys(felder)) near(SP[id].M, felder[id], 0.02, id);
  near(Energy.molarMass('Ca(OH)2'), 74.093, 0.01);
  near(Energy.molarMass('C2H5OH(l)'), 46.069, 0.01);
  assert.deepEqual(Energy.parseFormula('C2H5OH'), { C: 2, H: 6, O: 1 });
  throwsMsg(() => Energy.molarMass('Xx2'), /atomic weight/);
  throwsMsg(() => Energy.parseFormula('H2(O'), /Missing|Unmatched/);
});

/* Heats of combustion (to CO2(g) and H2O(l)) from the CRC Handbook, kJ/mol. The code works them out from heats of formation. */
const HC_CRC = { CH4: [-890.3, 'g'], C2H6: [-1560.7, 'g'], C3H8: [-2219.2, 'g'], C4H10: [-2877.6, 'g'], C2H4: [-1411.2, 'g'], C2H2: [-1301.1, 'g'],
  H2: [-285.8, 'g'], CO: [-283.0, 'g'], CH3OH: [-726.1, 'l'], C2H5OH: [-1366.8, 'l'], C6H6: [-3267.6, 'l'], C7H8: [-3910.3, 'l'], C6H14: [-4163.2, 'l'] };
test('heats of combustion computed from heats of formation match the tabulated ones and the handbook', () => {
  for (const id of Object.keys(HC_CRC)) {
    const [crc, ph] = HC_CRC[id];
    const c = Energy.combustion({ id, phase: ph });
    // Felder's own Table B.1 value: the two columns of that table must agree with each other to 0.5 kJ/mol
    near(-c.hhv, SP[id].Hc[ph], 0.5, id + ' vs Hc in Table B.1');
    close(c.hhv, -crc, 0.005, id + ' vs handbook');
  }
});

test('data records are complete and consistent (ranges, phases, no missing numbers)', () => {
  for (const sp of Object.values(SP)) {
    assert.ok(sp.M > 0, sp.id + ' molar mass');
    assert.ok(['s', 'l', 'g'].indexOf(sp.std) >= 0);
    assert.ok(sp.Hf[sp.std] !== undefined || sp.id === 'air', sp.id + ' needs a heat of formation in its standard phase');
    for (const ph of Object.keys(sp.Cp)) {
      const c = sp.Cp[ph];
      assert.ok(isFinite(c.a) && isFinite(c.b) && isFinite(c.c) && isFinite(c.d), sp.id + ' ' + ph);
      assert.ok(c.Tunit === 'C' || c.Tunit === 'K');
      assert.ok(c.Tmin < c.Tmax);
      // Cp stays positive and below 400 J/(mol·K) everywhere in its stated range
      const lo = c.Tunit === 'C' ? c.Tmin + 273.15 : c.Tmin, hi = c.Tunit === 'C' ? c.Tmax + 273.15 : c.Tmax;
      for (let i = 0; i <= 20; i++) { const v = Energy.cpAt(c, lo + (hi - lo) * i / 20); assert.ok(v > 15 && v < 400, `${sp.id}(${ph}) Cp = ${v}`); }
    }
    if (sp.Tb !== null) assert.ok(sp.Tm === null || sp.Tm < sp.Tb, sp.id + ' Tm < Tb');
    if (sp.Hvap !== null) assert.ok(sp.Tb !== null && sp.Hvap > 0);
  }
});

/* ═════════════════════════ SENSIBLE HEAT ═════════════════════════ */

test('hand-worked: ∫Cp dT for N2 from 25 to 100 °C', () => {
  // Cp = 29.00 + 2.199e-3 T + 5.723e-6 T² − 2.871e-9 T³  [J/(mol·°C)]
  // ∫ = 29.00 (75) + 2.199e-3/2 (100² − 25²) + 5.723e-6/3 (100³ − 25³) − 2.871e-9/4 (100⁴ − 25⁴)
  //   = 2175 + 10.3078 + 1.8779 − 0.0715 = 2187.11 J/mol
  const r = Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: 298.15, T2: 373.15, phase: 'g' });
  close(r.dH, 2.18711, 1e-5);
  close(r.meanCp, 2187.11 / 75, 1e-5);
  assert.equal(r.steps[0].equations[0].equation.indexOf('∫Cp dT') > 0, true);
  assert.ok(/2175/.test(r.steps[0].equations[0].substituted), 'the working shows the first term');
});

test('ΔU of an ideal gas is ΔH − RΔT (Cv = Cp − R)', () => {
  const r = Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: 298.15, T2: 373.15, phase: 'g' });
  close(r.dU, 2.18711 - 8.314462618 * 75 / 1000, 1e-5);   // 2.18711 − 0.62358 = 1.56353 kJ/mol
  close(r.meanCv, r.meanCp - 8.314462618, 1e-12);
  const liquid = Energy.sensibleHeat({ species: [{ id: 'H2O', n: 1 }], T1: 298.15, T2: 323.15, phase: 'l' });
  assert.equal(liquid.dU, undefined, 'no ΔU = ΔH − RΔT for a liquid');
});

test('a polynomial in K and the same polynomial in °C give the same ΔH', () => {
  // Convert Cp(T°C) = a + bT + cT² + dT³ to a polynomial in K by expanding (T − 273.15), with separate code
  const s = 273.15;
  for (const id of ['N2', 'CO2', 'CH4', 'H2O']) {
    const c = SP[id].Cp.g;
    const A = c.a - c.b * s + c.c * s * s - c.d * s * s * s;
    const B = c.b - 2 * c.c * s + 3 * c.d * s * s;
    const C = c.c - 3 * c.d * s;
    const D = c.d;
    const db = Energy.extendDatabase(SP, [{ id, Cp: { g: { a: A, b: B, c: C, d: D, Tunit: 'K', Tmin: 273.15, Tmax: 1500 } } }]);
    for (const T2 of [350, 600, 900]) {
      const a = Energy.sensibleHeat({ species: [{ id, n: 1 }], T1: 298.15, T2, phase: 'g' }).dH;
      const b = Energy.sensibleHeat({ species: [{ id, n: 1 }], T1: 298.15, T2, phase: 'g', db }).dH;
      close(b, a, 1e-9, id + ' ' + T2);
    }
  }
});

test('∫Cp dT is additive over sub-ranges and changes sign when reversed (1000 random cases)', () => {
  const rnd = mulberry32(11), ids = ['N2', 'O2', 'H2', 'CO', 'CO2', 'CH4', 'NH3', 'air', 'C2H6', 'C3H8', 'C6H6', 'CH3OH'];
  for (let i = 0; i < 1000; i++) {
    const id = ids[Math.floor(rnd() * ids.length)], cp = SP[id].Cp.g;
    const lo = cp.Tmin + 273.15, hi = Math.min(cp.Tmax, 1200) + 273.15;
    const [a, b, c] = [lo + rnd() * (hi - lo), lo + rnd() * (hi - lo), lo + rnd() * (hi - lo)];
    const f = (x, y) => Energy.integrateCp(cp, x, y);
    near(f(a, b) + f(b, c), f(a, c), 1e-9, id);
    near(f(a, b), -f(b, a), 1e-12);
    near(f(a, a), 0, 1e-15);
    // against separate code (Simpson's rule on the raw coefficients)
    near(f(a, c), integ(cp, a, c), 1e-9 * Math.max(1, Math.abs(f(a, c))), id + ' vs Simpson');
  }
});

test('mixture: ΔH = Σ yᵢ ΔHᵢ, mean Cp = ΔH/ΔT; fractions and flows give the same answer (300 random mixtures)', () => {
  const rnd = mulberry32(5), ids = ['N2', 'O2', 'CO2', 'H2O', 'CO', 'CH4', 'H2', 'NH3'];
  for (let i = 0; i < 300; i++) {
    const k = 2 + Math.floor(rnd() * 3), pick = [];
    while (pick.length < k) { const id = ids[Math.floor(rnd() * ids.length)]; if (pick.indexOf(id) < 0) pick.push(id); }
    const flows = pick.map(() => 0.1 + rnd() * 5), tot = flows.reduce((a, b) => a + b, 0);
    const T1 = 300 + rnd() * 300, T2 = 400 + rnd() * 800;
    const r = Energy.sensibleHeat({ species: pick.map((id, j) => ({ id, n: flows[j] })), T1, T2, phase: 'g' });
    let want = 0;
    pick.forEach((id, j) => { want += flows[j] / tot * dHgas(id, T1, T2); });
    close(r.dH, want, 1e-9, 'ΔH');
    const f = Energy.sensibleHeat({ species: pick.map((id, j) => ({ id, n: flows[j] / tot })), T1, T2, phase: 'g' });
    close(f.dH, r.dH, 1e-12, 'fractions vs flows');
    close(r.meanCp, r.dH * 1000 / (T2 - T1), 1e-12);
    const q = Energy.sensibleHeat({ species: pick.map((id, j) => ({ id, n: flows[j] })), T1, T2, phase: 'g', flow: 3.5 });
    close(q.Q, 3.5 * r.dH, 1e-12);
  }
});

test('warns when a polynomial is used outside its stated range', () => {
  const ok = Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: 298.15, T2: 1000, phase: 'g' });
  assert.equal(ok.warnings.length, 0);
  const out = Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: 298.15, T2: 2000, phase: 'g' });
  assert.ok(out.warnings.length === 1 && /extrapolation/.test(out.warnings[0]));
});

test('input checks: unknown species, missing data, bad temperatures, empty mixture', () => {
  throwsMsg(() => Energy.sensibleHeat({ species: [{ id: 'XYZ', n: 1 }], T1: 300, T2: 400, phase: 'g' }), /not in the data table/);
  throwsMsg(() => Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: 300, T2: 400, phase: 'l' }), /No heat capacity data/);
  throwsMsg(() => Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: NaN, T2: 400, phase: 'g' }), /temperatures/);
  throwsMsg(() => Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: -5, T2: 400, phase: 'g' }), /absolute zero/);
  throwsMsg(() => Energy.sensibleHeat({ species: [], T1: 300, T2: 400 }), /at least one/);
  throwsMsg(() => Energy.sensibleHeat({ species: [{ id: 'N2', n: 0 }], T1: 300, T2: 400, phase: 'g' }), /add up to zero/);
});

/* ═════════════════════════ PHASE CHANGE ═════════════════════════ */

test('hand-worked: liquid water at 25 °C to steam at 150 °C (1 atm)', () => {
  // 1. heat the liquid 25 → 100 °C: 75.4 × 75 = 5655 J/mol = 5.655 kJ/mol
  // 2. vaporise at 100 °C: 40.656 kJ/mol
  // 3. superheat the vapour 100 → 150 °C: 33.46 (50) + 6.880e-3/2 (150² − 100²) + 7.604e-6/3 (150³ − 100³) − 3.593e-9/4 (150⁴ − 100⁴)
  //    = 1673 + 43.0 + 6.0198 − 0.3649 = 1721.65 J/mol = 1.72165 kJ/mol
  // total = 5.655 + 40.656 + 1.72165 = 48.03265 kJ/mol
  const r = Energy.phaseChange({ id: 'H2O', from: { T: 298.15, phase: 'l' }, to: { T: 423.15, phase: 'g' } });
  assert.equal(r.pieces.length, 3);
  close(r.pieces[0].value, 5.655, 1e-9);
  close(r.pieces[1].value, 40.656, 1e-12);
  close(r.pieces[2].value, 1.72165, 1e-5);
  close(r.dH, 48.03265, 1e-6);
  assert.deepEqual(r.pieces.map(p => p.kind), ['sensible', 'latent', 'sensible']);
  // the page shows each step with its numbers
  assert.ok(r.steps.length >= 5);
  assert.ok(r.steps.every(s => s.title.length > 0));
});

test('phase change: the reverse path is the exact negative, and the automatic phases give the same answer', () => {
  const fwd = Energy.phaseChange({ id: 'H2O', from: { T: 298.15, phase: 'l' }, to: { T: 523.15, phase: 'g' } });
  const back = Energy.phaseChange({ id: 'H2O', from: { T: 523.15, phase: 'g' }, to: { T: 298.15, phase: 'l' } });
  close(back.dH, -fwd.dH, 1e-12);
  const auto = Energy.phaseChange({ id: 'H2O', from: { T: 298.15, phase: 'auto' }, to: { T: 523.15, phase: 'auto' } });
  close(auto.dH, fwd.dH, 1e-12);
  assert.equal(auto.from.phase, 'l');
  assert.equal(auto.to.phase, 'g');
});

test('ice at −10 °C to steam at 150 °C goes through fusion and vaporisation', () => {
  const r = Energy.phaseChange({ id: 'H2O', from: { T: K(-10), phase: 's' }, to: { T: K(150), phase: 'g' } });
  assert.deepEqual(r.pieces.map(p => p.kind), ['sensible', 'latent', 'sensible', 'latent', 'sensible']);
  close(r.pieces[1].value, 6.0095, 1e-12);                 // melting at 0 °C
  close(r.pieces[0].value, 37.8 * 10 / 1000, 1e-9);         // ice 37.8 J/(mol·K) × 10 K (approximate ice Cp)
  const rest = Energy.phaseChange({ id: 'H2O', from: { T: K(0), phase: 'l' }, to: { T: K(150), phase: 'g' } }).dH;
  close(r.dH, 0.378 + 6.0095 + rest, 1e-12);
});

test('phase change: split the path anywhere and the total does not change (benzene, ethanol, water; 200 random cases)', () => {
  const rnd = mulberry32(21);
  for (let i = 0; i < 200; i++) {
    const id = ['C6H6', 'C2H5OH', 'H2O', 'CH3OH', 'C7H8', 'C3H6O'][Math.floor(rnd() * 6)], sp = SP[id];
    const Ta = sp.Tm + 1 + rnd() * (sp.Tb - sp.Tm - 2), Tz = sp.Tb + 5 + rnd() * 100, Tmid = Ta + rnd() * (sp.Tb - Ta);
    const whole = Energy.phaseChange({ id, from: { T: Ta, phase: 'l' }, to: { T: Tz, phase: 'g' } }).dH;
    // separate arithmetic: liquid sensible to Tb, latent, vapour sensible from Tb
    const own = integ(sp.Cp.l, Ta, sp.Tb) + sp.Hvap + integ(sp.Cp.g, sp.Tb, Tz);
    close(whole, own, 1e-9, id);
    const a = Energy.phaseChange({ id, from: { T: Ta, phase: 'l' }, to: { T: Tmid, phase: 'l' } }).dH;
    const b = Energy.phaseChange({ id, from: { T: Tmid, phase: 'l' }, to: { T: Tz, phase: 'g' } }).dH;
    close(a + b, whole, 1e-9, id + ' split');
  }
});

test('boiling point at other pressures: water at 5 bar and 2 atm (steam tables), ΔHvap there by Watson', () => {
  const w = SP.H2O;
  near(Energy.toC(Energy.boilingPoint(w, 500).T), 151.8, 1.5, 'steam table: 5 bar');
  near(Energy.toC(Energy.boilingPoint(w, 202.65).T), 120.2, 1.0, 'steam table: 2 atm');
  assert.equal(Energy.boilingPoint(w, 101.325).T, w.Tb);
  assert.ok(Energy.boilingPoint(w, 50).T < w.Tb);
  const Tb5 = Energy.boilingPoint(w, 500).T;
  const L = Energy.latentHeat({ id: 'H2O', kind: 'vap', T: Tb5 }).value;
  close(L, 2107.4 * 18.015 / 1000, 0.02, 'steam table hfg at 5 bar = 2107.4 kJ/kg');
  const r = Energy.phaseChange({ id: 'H2O', from: { T: 298.15, phase: 'l' }, to: { T: 503.15, phase: 'g' }, P: 500 });
  close(r.pieces[1].value, L, 1e-12);
  assert.ok(r.pieces[0].title.indexOf('151') > 0 || r.pieces[0].title.indexOf('15') > 0);
});

test('a species with no boiling point data cannot be taken through a phase change, and says so', () => {
  throwsMsg(() => Energy.phaseChange({ id: 'CO2', from: { T: 300, phase: 'l' }, to: { T: 400, phase: 'g' } }), /boiling point/);
  throwsMsg(() => Energy.phaseChange({ id: 'N2', from: { T: 300, phase: 'g' }, to: { T: 400, phase: 'l' } }), /No heat capacity data/);
});

/* ═════════════════════════ REACTIONS ═════════════════════════ */

test('hand-worked: ΔH°rxn of CH4 + 2 O2 → CO2 + 2 H2O', () => {
  // liquid water: −393.5 + 2(−285.84) − (−74.85) = −393.5 − 571.68 + 74.85 = −890.33 kJ
  // water vapour: −393.5 + 2(−241.83) + 74.85 = −802.31 kJ
  const l = Energy.heatOfReaction({ reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O' });
  near(l.dH25, -890.33, 1e-9);
  assert.equal(l.reaction.text, 'CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
  assert.equal(l.type, 'exothermic');
  const g = Energy.heatOfReaction({ reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O(g)' });
  near(g.dH25, -802.31, 1e-9);
  near(g.dH25 - l.dH25, 2 * 44.01, 1e-9, 'difference = 2 × latent heat of water at 25 °C (Felder footnote: add 44.01 per mole of water)');
  const arrow = Energy.heatOfReaction({ reaction: 'CH4(g) + 2 O2(g) → CO2(g) + 2 H2O(l)' });
  near(arrow.dH25, -890.33, 1e-9);
  const half = Energy.heatOfReaction({ reaction: 'CO + 1/2 O2 -> CO2' });
  near(half.dH25, -393.5 + 110.52, 1e-9);                                   // −282.98
  const doubled = Energy.heatOfReaction({ reaction: '2 CO + O2 -> 2 CO2' });
  near(doubled.dH25, 2 * half.dH25, 1e-9, 'doubling the reaction doubles ΔH');
  const rev = Energy.heatOfReaction({ reaction: 'CO2 -> CO + 0.5 O2' });
  near(rev.dH25, -half.dH25, 1e-9, 'reversing the reaction flips the sign');
});

test('Hess’s law: ΔH°rxn from heats of formation equals the same ΔH from the tabulated heats of combustion', () => {
  // ΔH°rxn = Σ ΔH°c(reactants) − Σ ΔH°c(products); each Hc is from Felder Table B.1, an independent column of the table.
  const hc = (id, ph) => SP[id].Hc[ph || SP[id].std];
  const cases = [
    ['C2H4 + H2 -> C2H6', hc('C2H4') + hc('H2') - hc('C2H6')],
    ['CO + 0.5 O2 -> CO2', hc('CO') - 0],
    ['C2H2 + 2 H2 -> C2H6', hc('C2H2') + 2 * hc('H2') - hc('C2H6')],
    ['CH3OH(l) + 1.5 O2 -> CO2 + 2 H2O', hc('CH3OH', 'l')],
    ['C2H5OH(l) -> C2H4 + H2O', hc('C2H5OH', 'l') - hc('C2H4') + 0],     // water is a combustion product: Hc = 0
    ['C3H8 + H2 -> C2H6 + CH4', hc('C3H8') + hc('H2') - hc('C2H6') - hc('CH4')],
    ['C6H6(l) + 3 H2 -> C6H12', null]
  ];
  for (const [text, viaHc] of cases) {
    if (viaHc === null) continue;
    near(Energy.heatOfReaction({ reaction: text }).dH25, viaHc, 0.5, text);
  }
});

test('Hess’s law: two steps add up to the one step (C → CO → CO2 against C → CO2)', () => {
  const a = Energy.heatOfReaction({ reaction: 'C + 0.5 O2 -> CO' }).dH25;
  const b = Energy.heatOfReaction({ reaction: 'CO + 0.5 O2 -> CO2' }).dH25;
  const direct = Energy.heatOfReaction({ reaction: 'C + O2 -> CO2' }).dH25;
  near(a + b, direct, 1e-9);
  near(a, -110.52, 1e-9);
  // and through the heat of combustion of graphite in Table B.1 (−393.51)
  near(direct, SP.C.Hc.s, 0.05);
  // ammonia: N2 + 3 H2 → 2 NH3 is twice the formation of NH3, whichever way it is written
  const nh3 = Energy.heatOfReaction({ reaction: '0.5 N2 + 1.5 H2 -> NH3' }).dH25;
  near(Energy.heatOfReaction({ reaction: 'N2 + 3 H2 -> 2 NH3' }).dH25, 2 * nh3, 1e-9);
  near(nh3, -46.19, 1e-9);
});

test('heat of reaction at another temperature against NIST-JANAF heats of formation at 500 K and 1000 K', () => {
  // JANAF ΔfH(500 K): CO −110.003, CO2 −393.666, H2O(g) −243.826, CH4 −80.802
  // CO + ½O2 → CO2 at 500 K: −393.666 + 110.003 = −283.663 kJ
  const co = Energy.heatOfReaction({ reaction: 'CO + 0.5 O2 -> CO2', T: 500 });
  near(co.dH, -283.663, 0.4);
  // CH4 + 2 O2 → CO2 + 2 H2O(g) at 1000 K (JANAF ΔfH(1000 K): CO2 −394.623, H2O −247.857, CH4 −89.849): −800.488 kJ
  const ch4 = Energy.heatOfReaction({ reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O(g)', T: 1000 });
  near(ch4.dH, -394.623 + 2 * -247.857 + 89.849, 1.5);
  // the working has the three parts: reactants to 25 °C, the reaction, products to T
  assert.ok(ch4.steps.some(s => /Reactant/.test(s.title)) && ch4.steps.some(s => /Product/.test(s.title)));
  close(ch4.dH, ch4.reactantsPath + ch4.dH25 + ch4.productsPath, 1e-12);
});

test('heat of reaction at T: separate code (heats of formation plus Simpson integrals), 150 random cases', () => {
  const rnd = mulberry32(31);
  const rxs = [
    ['CH4 + 2 O2 -> CO2 + 2 H2O(g)', { CH4: -1, O2: -2, CO2: 1, H2O: 2 }],
    ['CO + 0.5 O2 -> CO2', { CO: -1, O2: -0.5, CO2: 1 }],
    ['H2 + 0.5 O2 -> H2O(g)', { H2: -1, O2: -0.5, H2O: 1 }],
    ['N2 + 3 H2 -> 2 NH3', { N2: -1, H2: -3, NH3: 2 }],
    ['C2H6 + 3.5 O2 -> 2 CO2 + 3 H2O(g)', { C2H6: -1, O2: -3.5, CO2: 2, H2O: 3 }],
    ['C2H4 + H2 -> C2H6', { C2H4: -1, H2: -1, C2H6: 1 }]
  ];
  for (let i = 0; i < 150; i++) {
    const [text, nu] = rxs[Math.floor(rnd() * rxs.length)], T = 400 + rnd() * 800;
    let want = 0;
    Object.keys(nu).forEach(id => { want += nu[id] * (SP[id].Hf.g + dHgas(id, 298.15, T)); });
    close(Energy.heatOfReaction({ reaction: text, T }).dH, want, 1e-9, text + ' at ' + T.toFixed(1));
  }
});

test('heat of reaction at T through a phase change: liquid water formed at 25 °C but leaving as steam at 150 °C', () => {
  // ΔH(150 °C) with water produced from H2O(l) reference: H2 + ½O2 → H2O: the product path is liquid heating, vaporisation, steam heating
  const lq = Energy.heatOfReaction({ reaction: 'H2 + 0.5 O2 -> H2O', T: K(150) });
  const gs = Energy.heatOfReaction({ reaction: 'H2 + 0.5 O2 -> H2O(g)', T: K(150) });
  // both end at steam: they differ only by data inconsistency between ΔHf(g) and the latent-heat path (< 0.5 kJ/mol)
  near(lq.dH, gs.dH, 0.5);
  const keep = Energy.heatOfReaction({ reaction: 'H2 + 0.5 O2 -> H2O', T: K(150), keepPhase: true });
  assert.ok(keep.dH !== lq.dH, 'keeping the liquid phase changes the answer');
  assert.ok(lq.steps.some(s => s.equations.some(e => /Vaporise|vaporisation/.test(e.label))));
});

test('extent of reaction: Q = ξ ΔHrxn', () => {
  const r = Energy.heatOfReaction({ reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O', extent: 3 });
  near(r.Q, -3 * 890.33, 1e-9);
});

test('reaction text: coefficients, phases, unknown species, malformed input', () => {
  const p = Energy.parseEquation('2H2 + O2 = 2 H2O(g)');
  assert.deepEqual(p.terms.map(t => [t.id, t.phase, t.nu]), [['H2', 'g', -2], ['O2', 'g', -1], ['H2O', 'g', 2]]);
  assert.equal(Energy.parseEquation('C2H5OH + 3O2 -> 2CO2 + 3H2O').terms[0].phase, 'l', 'ethanol is a liquid at 25 °C unless tagged');
  assert.equal(Energy.parseEquation('C2H5OH(g) + 3O2 -> 2CO2 + 3H2O').terms[0].phase, 'g');
  assert.equal(Energy.parseEquation('CO2 + H2 -> CO + H2O(l) + H2').terms.length, 3, 'H2 on both sides cancels');
  throwsMsg(() => Energy.parseEquation('CH4 + 2 O2 -> CO2 + 2 Water'), /"Water" is not in the data table/);
  throwsMsg(() => Energy.parseEquation('CH4 + 2 O2'), /Write the reaction/);
  throwsMsg(() => Energy.parseEquation('CH4 -> CH4'), /Nothing changes/);
  throwsMsg(() => Energy.parseEquation(''), /Write the reaction/);
  throwsMsg(() => Energy.heatOfReaction({ reaction: 'CH4(l) -> C + 2 H2' }), /No heat of formation for CH4\(l\)/);
});

test('combustion: HHV and LHV of the common fuels per mole and per kg', () => {
  const ch4 = Energy.combustion({ id: 'CH4' });
  near(ch4.hhv, 890.33, 1e-9);                         // user value "about 890"
  near(ch4.lhv, 890.33 - 2 * 44.01, 1e-9);             // 802.31
  close(ch4.hhvMass, 890.33 / 16.043, 1e-9);           // 55.5 MJ/kg
  close(ch4.hhvMass, 55.5, 0.01);
  assert.equal(ch4.o2, 2);
  const h2 = Energy.combustion({ id: 'H2' });
  close(h2.hhvMass, 141.8, 0.005); close(h2.lhvMass, 120.0, 0.005);   // known: 141.8 and 120.0 MJ/kg
  const co = Energy.combustion({ id: 'CO' });
  near(co.hhv, co.lhv, 1e-12, 'no hydrogen: HHV = LHV');
  const eth = Energy.combustion({ id: 'C2H5OH' });
  assert.equal(eth.fuelPhase, 'l');
  assert.equal(eth.o2, 3);
  close(eth.hhvMass, 29.7, 0.01);
  close(Energy.combustion({ id: 'C3H8' }).hhvMass, 50.3, 0.01);
  assert.ok(ch4.steps.length >= 4);
  throwsMsg(() => Energy.combustion({ id: 'N2' }), /needs no oxygen/);
});

/* ═════════════════════════ ADIABATIC REACTOR AND FLAME TEMPERATURE ═════════════════════════ */

test('adiabatic mixing of two water streams (closed form): 20 °C + 80 °C, equal flows → 50 °C', () => {
  // constant Cp(l), so the energy balance is linear: T = (n1 T1 + n2 T2)/(n1 + n2)
  const r = Energy.adiabatic({ feeds: [{ id: 'H2O', n: 1, T: K(20) }, { id: 'H2O', n: 1, T: K(80) }] });
  near(r.TC, 50, 1e-6);
  near(r.residual, 0, 1e-8);
  const r2 = Energy.adiabatic({ feeds: [{ id: 'H2O', n: 3, T: K(20) }, { id: 'H2O', n: 1, T: K(80) }] });
  near(r2.TC, 35, 1e-6);                              // (3×20 + 80)/4
  assert.equal(r.formation, false, 'no reaction: enthalpies measured from 25 °C, no heats of formation');
});

test('heater with a given duty: N2 at 25 °C with Q = 2.18711 kW per mol/s leaves at 100 °C', () => {
  const r = Energy.adiabatic({ feeds: [{ id: 'N2', n: 1, T: 298.15 }], Q: 2.18711423 });
  near(r.TC, 100, 1e-4);
  const cool = Energy.adiabatic({ feeds: [{ id: 'N2', n: 2, T: 373.15 }], Q: -2 * 2.18711423 });
  near(cool.TC, 25, 1e-4);
});

test('a duty that does not reach the boiling point leaves a vapour-liquid mixture at the boiling point (the jump in enthalpy)', () => {
  // 1 mol/s liquid water at 25 °C: 5.655 kW heats it to 100 °C, then 0.5 × 40.656 = 20.328 kW vaporises half of it
  const r = Energy.adiabatic({ feeds: [{ id: 'H2O', n: 1, T: 298.15 }], Q: 5.655 + 0.5 * 40.656 });
  near(r.T, 373.15, 1e-6);
  assert.ok(r.twoPhase && r.twoPhase.id === 'H2O');
  close(r.twoPhase.vapour, 0.5, 1e-9);
  // add a bit more than the full latent heat and it superheats
  const sup = Energy.adiabatic({ feeds: [{ id: 'H2O', n: 1, T: 298.15 }], Q: 5.655 + 40.656 + 1.72165 });
  near(sup.TC, 150, 1e-3);
  assert.equal(sup.twoPhase, null);
  // total condensation in reverse
  const cold = Energy.adiabatic({ feeds: [{ id: 'H2O', n: 1, T: K(150) }], Q: -(integ(SP.H2O.Cp.g, 373.15, 423.15) + 0.25 * 40.656) });
  near(cold.T, 373.15, 1e-6);
  close(cold.twoPhase.vapour, 0.75, 1e-9);
});

test('a very large flow does not make a smooth balance look like a phase jump', () => {
  // 1e7 mol/s of N2 heated by Q = 1e7 × 2.18711 kW: the answer is 100 °C, and there is no boiling point on the way
  const r = Energy.adiabatic({ feeds: [{ id: 'N2', n: 1e7, T: 298.15 }], Q: 1e7 * 2.18711423 });
  near(r.TC, 100, 1e-4);
  assert.equal(r.twoPhase, null);
  const small = Energy.adiabatic({ feeds: [{ id: 'CO2', n: 1e-6, T: 298.15 }], Q: 1e-6 * 5 });
  assert.ok(small.T > 298.15 && small.twoPhase === null);
});

test('adiabatic reactor, hand-checked: H2 + ½O2 → H2O(g) with a large N2 diluent', () => {
  // 1 mol/s H2, 0.5 O2, 20 N2, all at 25 °C, complete conversion. The balance: 241.83 = ∫(n_H2O Cp_H2O + 20 Cp_N2) dT.
  // Mean Cp ≈ 33.6 + 20 × 29.2 = 617.6 J/K per second, so ΔT ≈ 241830/617.6 ≈ 392 K, T ≈ 417 °C (Cp rises a little: check below).
  const r = Energy.adiabatic({
    reactions: [{ text: 'H2 + 0.5 O2 -> H2O(g)', conversion: { id: 'H2', x: 1 } }],
    feeds: [{ id: 'H2', n: 1, T: 298.15 }, { id: 'O2', n: 0.5, T: 298.15 }, { id: 'N2', n: 20, T: 298.15 }]
  });
  assert.ok(r.TC > 380 && r.TC < 440, 'T = ' + r.TC);
  // independent check of the balance: 241.83 = ∫ over the outlet species from 25 °C to T (extent-of-reaction method)
  near(integ(SP.H2O.Cp.g, 298.15, r.T) + 20 * integ(SP.N2.Cp.g, 298.15, r.T) + 0.5 * 0, 241.83 + 0.5 * integ(SP.O2.Cp.g, 298.15, 298.15), 1e-6);
  near(r.nOut.H2, 0, 1e-12);
  near(r.nOut.H2O, 1, 1e-12);
  assert.ok(r.steps.some(s => /Solve for the outlet temperature/.test(s.title)));
});

test('flame temperature of methane in a stoichiometric air supply, checked against NIST-JANAF tables', () => {
  // JANAF H(T) − H(298.15 K) in kJ/mol at 2300 / 2400 K: CO2 109.660 / 115.779, H2O 88.421 / 93.741, N2 66.995 / 70.640.
  // Balance (water as vapour): 802.301 = H_CO2 + 2 H_H2O + 7.5238 H_N2; at 2300 K the right side is 790.56, at 2400 K 834.74,
  // so T = 2300 + 100 × (802.301 − 790.56)/(834.74 − 790.56) = 2326.6 K (the textbook value without dissociation is about 2327 K).
  const r = Energy.flameTemperature({ fuel: 'CH4', excess: 0, Tfuel: 298.15, Tair: 298.15 });
  near(r.T, 2326.6, 35, 'JANAF-based T_ad');            // the polynomials are extrapolated past 1500 °C: 0.8 % high
  assert.ok(r.warnings.length > 0 && /extrapolation/.test(r.warnings[0]), 'warns that the Cp polynomials are used beyond their range');
  near(r.residual, 0, 1e-6);
  close(r.air, 2 / 0.21, 1e-12);
  near(r.nOut.N2, 2 * 79 / 21, 1e-9);
  near(r.nOut.CO2, 1, 1e-12);
  near(r.nOut.H2O, 2, 1e-12);
});

test('flame temperature trends: more excess air cools it, preheated air or fuel heats it, partial conversion cools it', () => {
  const T = o => Energy.flameTemperature(Object.assign({ fuel: 'CH4', excess: 0.2, Tfuel: 298.15, Tair: 298.15 }, o)).T;
  const base = T({});
  assert.ok(T({ excess: 0.5 }) < base && T({ excess: 1.0 }) < T({ excess: 0.5 }));
  assert.ok(T({ Tair: 573.15 }) > base && T({ Tfuel: 373.15 }) > base);
  assert.ok(T({ conversion: 0.8 }) < base);
  assert.ok(T({ excess: 0.1 }) > base);
  // acetylene burns hotter than methane in the same air, and every stoichiometric flame is between 2100 and 3300 K
  const f = id => Energy.flameTemperature({ fuel: id, excess: 0, Tfuel: 298.15, Tair: 298.15 }).T;
  assert.ok(f('C2H2') > f('CH4') && f('C2H2') > f('C2H6'));
  ['H2', 'CO', 'CH4', 'C2H6', 'C3H8', 'C2H2'].forEach(id => assert.ok(f(id) > 2100 && f(id) < 3300, id + ' ' + f(id)));
  // lean mixtures (400 % excess air) still leave a sensible temperature
  const lean = T({ excess: 4 });
  assert.ok(lean > 800 && lean < 1300, 'lean flame ' + lean);
});

test('adiabatic reactor, 150 random cases: the energy balance holds when checked by the extent-of-reaction method with separate code', () => {
  // Fuel stoichiometry typed by hand (not taken from the library): moles of O2, CO2 and H2O per mole of fuel.
  const FUEL = { CH4: [2, 1, 2], C2H6: [3.5, 2, 3], C3H8: [5, 3, 4], C4H10: [6.5, 4, 5], H2: [0.5, 0, 1], CO: [0.5, 1, 0], C2H4: [3, 2, 2], C2H5OH: [3, 2, 3] };
  const rnd = mulberry32(77), ids = Object.keys(FUEL);
  for (let i = 0; i < 150; i++) {
    const id = ids[Math.floor(rnd() * ids.length)], [o2s, co2s, h2os] = FUEL[id];
    const ex = rnd() * 3, conv = 0.5 + 0.5 * rnd(), Tf = 280 + rnd() * 100, Ta = 280 + rnd() * 400, n = 0.5 + rnd() * 3;
    const r = Energy.flameTemperature({ fuel: id, excess: ex, Tfuel: Tf, Tair: Ta, conversion: conv, basis: n });
    const fuelPh = SP[id].std;
    // reaction at 25 °C with the reference phases used in the library: fuel in its standard phase, water vapour
    const xi = conv * n;
    const dH25 = co2s * SP.CO2.Hf.g + h2os * SP.H2O.Hf.g - SP[id].Hf[fuelPh];
    const O2in = o2s * (1 + ex) * n, N2in = O2in * 79 / 21;
    const hIn = n * integ(SP[id].Cp[fuelPh], 298.15, Tf) + O2in * integ(SP.O2.Cp.g, 298.15, Ta) + N2in * integ(SP.N2.Cp.g, 298.15, Ta);
    const T = r.T;
    const hOut = (n - xi) * integ(SP[id].Cp[fuelPh], 298.15, T) + (O2in - o2s * xi) * integ(SP.O2.Cp.g, 298.15, T) + N2in * integ(SP.N2.Cp.g, 298.15, T)
      + xi * co2s * integ(SP.CO2.Cp.g, 298.15, T) + xi * h2os * integ(SP.H2O.Cp.g, 298.15, T);
    // extent method:  Q = ξ ΔH°rxn + Σ n_out ∫Cp − Σ n_in ∫Cp = 0 (adiabatic)
    // when the leftover fuel is a liquid it would be vapour at T: the library takes the leftover through its boiling point, so allow for it
    if (fuelPh === 'l') continue;
    near(xi * dH25 + hOut - hIn, 0, 1e-6 * Math.max(1, Math.abs(xi * dH25)), id + ' ex=' + ex.toFixed(2));
    near(r.residual, 0, 1e-6 * Math.max(1, Math.abs(xi * dH25)));
    assert.ok(T > Math.min(Tf, Ta) && T < 4000);
    // H_out is increasing at the answer: unique root
    assert.ok(r.bracket.hi - r.bracket.lo < 1e-6);
  }
});

test('adiabatic reactor with liquid ethanol feed: the library takes the leftover liquid fuel through its boiling point', () => {
  // complete conversion, so no fuel is left and the independent extent-method check applies
  const r = Energy.flameTemperature({ fuel: 'C2H5OH', excess: 0.3, Tfuel: 300, Tair: 300 });
  const n = 1, O2in = 3 * 1.3, N2in = O2in * 79 / 21;
  const dH25 = 2 * SP.CO2.Hf.g + 3 * SP.H2O.Hf.g - SP.C2H5OH.Hf.l;
  const hIn = integ(SP.C2H5OH.Cp.l, 298.15, 300) + (O2in + 0) * integ(SP.O2.Cp.g, 298.15, 300) + N2in * integ(SP.N2.Cp.g, 298.15, 300);
  const T = r.T;
  const hOut = (O2in - 3) * integ(SP.O2.Cp.g, 298.15, T) + N2in * integ(SP.N2.Cp.g, 298.15, T) + 2 * integ(SP.CO2.Cp.g, 298.15, T) + 3 * integ(SP.H2O.Cp.g, 298.15, T);
  near(dH25 + hOut - hIn, 0, 1e-5);
  assert.equal(r.nOut.C2H5OH, 0, 'all the fuel is burnt');
});

test('adiabatic reactor errors: too much conversion, wrong species, nothing to react, impossible duty', () => {
  const feeds = [{ id: 'CH4', n: 1, T: 298.15 }, { id: 'O2', n: 1, T: 298.15 }];
  throwsMsg(() => Energy.adiabatic({ reactions: [{ text: 'CH4 + 2 O2 -> CO2 + 2 H2O(g)', conversion: { id: 'CH4', x: 1 } }], feeds }), /more O2 than is fed/);
  throwsMsg(() => Energy.adiabatic({ reactions: [{ text: 'CH4 + 2 O2 -> CO2 + 2 H2O(g)', conversion: { id: 'CO2', x: 0.5 } }], feeds }), /not a reactant/);
  throwsMsg(() => Energy.adiabatic({ reactions: [{ text: 'CH4 + 2 O2 -> CO2 + 2 H2O(g)', conversion: { id: 'CH4', x: 1.5 } }], feeds }), /between 0 and 1/);
  throwsMsg(() => Energy.adiabatic({ reactions: [{ text: 'CH4 + 2 O2 -> CO2 + 2 H2O(g)' }], feeds }), /Give the extent/);
  throwsMsg(() => Energy.adiabatic({ feeds: [] }), /at least one feed/);
  throwsMsg(() => Energy.adiabatic({ feeds: [{ id: 'N2', n: 1, T: 298.15 }], Q: -1e6 }), /Even at|No temperature/);
  throwsMsg(() => Energy.adiabatic({ feeds: [{ id: 'N2', n: 1, T: 298.15 }], Q: 1e9 }), /No temperature up to/);
});

/* ═════════════════════════ STEADY OPEN SYSTEM ═════════════════════════ */

test('open system, hand-worked: heating 10 mol/s of N2 from 25 to 100 °C needs 10 × 2.18711 = 21.87 kW', () => {
  const r = Energy.openSystem({ inlets: [{ name: 'in', T: 298.15, species: [{ id: 'N2', n: 10 }] }], outlets: [{ name: 'out', T: 373.15, species: [{ id: 'N2', n: 10 }] }] });
  close(r.Q, 21.8711, 1e-5);
  assert.equal(r.formation, false);
  near(r.inlets[0].H, 0, 1e-12, 'enthalpy relative to 25 °C is zero at 25 °C');
  close(r.outlets[0].H, 21.8711, 1e-5);
});

test('open system: 1 mol/s liquid water at 25 °C to steam at 150 °C is 48.03 kW; shaft work and kinetic energy enter the first law', () => {
  const base = { inlets: [{ name: 'in', T: 298.15, species: [{ id: 'H2O', n: 1 }] }], outlets: [{ name: 'out', T: 423.15, species: [{ id: 'H2O', n: 1 }] }] };
  const r = Energy.openSystem(base);
  close(r.Q, 48.03265, 1e-6);
  assert.equal(r.inlets[0].species[0].phase, 'l');
  assert.equal(r.outlets[0].species[0].phase, 'g');
  // Q − Ws = ΔH + ΔEk + ΔEp. A turbine producing 5 kW (Ws = +5) needs 5 kW more heat than the stream absorbs.
  close(Energy.openSystem(Object.assign({ Ws: 5 }, base)).Q, 48.03265 + 5, 1e-6);
  // 1000 mol/s of water is 18.015 kg/s. Speeding it from 0 to 10 m/s: ΔEk = 18.015 × (100 − 0)/2 = 900.75 W = 0.90075 kW
  const ke = Energy.openSystem({ inlets: [{ T: 298.15, species: [{ id: 'H2O', n: 1000 }], u: 0 }], outlets: [{ T: 298.15, species: [{ id: 'H2O', n: 1000 }], u: 10 }] });
  close(ke.dKE, 18.015 * 100 / 2 / 1000, 1e-9);
  near(ke.dH, 0, 1e-9);
  close(ke.Q, ke.dKE, 1e-9);
  // raising it by 20 m: ΔEp = 18.015 × 9.80665 × 20 = 3533.4 W = 3.5334 kW
  const pe = Energy.openSystem({ inlets: [{ T: 298.15, species: [{ id: 'H2O', n: 1000 }], z: 0 }], outlets: [{ T: 298.15, species: [{ id: 'H2O', n: 1000 }], z: 20 }] });
  close(pe.dPE, 18.015 * 9.80665 * 20 / 1000, 1e-9);
});

test('open system with a reaction: methane burnt completely at 25 °C releases 890.33 kW per mol/s (water leaves as liquid at 25 °C)', () => {
  const r = Energy.openSystem({
    inlets: [{ T: 298.15, species: [{ id: 'CH4', n: 1 }, { id: 'O2', n: 2 }] }],
    outlets: [{ T: 298.15, species: [{ id: 'CO2', n: 1 }, { id: 'H2O', n: 2 }] }]
  });
  assert.equal(r.formation, true, 'composition changes, so heats of formation are used');
  near(r.Q, -890.33, 1e-9);
  // the same with the water leaving as steam at 25 °C (hypothetical gas): −802.31
  const g = Energy.openSystem({
    inlets: [{ T: 298.15, species: [{ id: 'CH4', n: 1 }, { id: 'O2', n: 2 }] }],
    outlets: [{ T: 298.15, species: [{ id: 'CO2', n: 1 }, { id: 'H2O', n: 2, phase: 'g' }] }]
  });
  near(g.Q, -802.31 + 2 * (0) - 2 * (44.01 - 44.01) + 0, 0.5);
});

test('open system: a loop returns to zero and the enthalpy of a stream does not depend on how it is split (100 random cases)', () => {
  const rnd = mulberry32(41), ids = ['N2', 'O2', 'CO2', 'H2O', 'CH4', 'H2', 'CO'];
  for (let i = 0; i < 100; i++) {
    const k = 1 + Math.floor(rnd() * 3), sp = [];
    while (sp.length < k) { const id = ids[Math.floor(rnd() * ids.length)]; if (!sp.some(x => x.id === id)) sp.push({ id, n: 0.5 + rnd() * 4, phase: 'g' }); }
    const A = 380 + rnd() * 500, B = 380 + rnd() * 700;
    const mk = T => ({ T, species: sp });
    const ab = Energy.openSystem({ inlets: [mk(A)], outlets: [mk(B)] }).Q, ba = Energy.openSystem({ inlets: [mk(B)], outlets: [mk(A)] }).Q;
    near(ab + ba, 0, 1e-9);
    // splitting one stream into two of the same T and composition changes nothing
    const half = sp.map(c => ({ id: c.id, n: c.n / 2, phase: 'g' }));
    const split = Energy.openSystem({ inlets: [{ T: A, species: half }, { T: A, species: half }], outlets: [mk(B)] }).Q;
    close(split, ab, 1e-9, 'split');
    // separate code: Σ n ∫Cp
    let want = 0;
    sp.forEach(c => { want += c.n * dHgas(c.id, A, B); });
    close(ab, want, 1e-9, 'vs separate code');
  }
});

test('open system errors and the printed working', () => {
  throwsMsg(() => Energy.openSystem({ inlets: [], outlets: [{ T: 300, species: [{ id: 'N2', n: 1 }] }] }), /at least one inlet/);
  throwsMsg(() => Energy.openSystem({ inlets: [{ T: 300, species: [] }], outlets: [{ T: 300, species: [{ id: 'N2', n: 1 }] }] }), /no species/);
  throwsMsg(() => Energy.openSystem({ inlets: [{ T: NaN, species: [{ id: 'N2', n: 1 }] }], outlets: [{ T: 300, species: [{ id: 'N2', n: 1 }] }] }), /temperature/);
  const r = Energy.openSystem({ inlets: [{ name: 'feed', T: 298.15, species: [{ id: 'N2', n: 1 }] }], outlets: [{ name: 'hot', T: 400, species: [{ id: 'N2', n: 1 }] }] });
  assert.ok(r.steps.some(s => /Reference state/.test(s.title)));
  assert.ok(r.steps.some(s => /First law/.test(s.title)));
  const last = r.steps[r.steps.length - 1];
  assert.equal(last.results[0].name, 'Q');
  assert.equal(last.results[0].unit, 'kW');
});

/* ═════════════════════════ THE WORKING ═════════════════════════ */

test('every calculation returns well-formed steps: titles, equations as text, finite numbers, no NaN or undefined in the text', () => {
  const results = [
    Energy.sensibleHeat({ species: [{ id: 'N2', n: 0.79 }, { id: 'O2', n: 0.21 }], T1: 300, T2: 700, phase: 'g', flow: 2 }),
    Energy.phaseChange({ id: 'C6H6', from: { T: 300, phase: 'l' }, to: { T: 400, phase: 'g' }, flow: 1 }),
    Energy.phaseChange({ id: 'H2O', from: { T: 260, phase: 's' }, to: { T: 450, phase: 'g' }, P: 300 }),
    Energy.latentHeat({ id: 'C2H5OH', kind: 'vap', T: 300 }),
    Energy.latentHeat({ id: 'H2O', kind: 'fus' }),
    Energy.heatOfReaction({ reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O', T: 600, extent: 2 }),
    Energy.combustion({ id: 'C2H5OH' }),
    Energy.adiabatic({ reactions: [{ text: 'CO + 0.5 O2 -> CO2', conversion: { id: 'CO', x: 0.9 } }], feeds: [{ id: 'CO', n: 1, T: 300 }, { id: 'O2', n: 1, T: 300 }, { id: 'N2', n: 3.76, T: 300 }] }),
    Energy.flameTemperature({ fuel: 'C3H8', excess: 0.1, Tfuel: 300, Tair: 400 }),
    Energy.openSystem({ inlets: [{ name: 'a', T: 300, species: [{ id: 'H2O', n: 2 }], u: 1, z: 2 }], outlets: [{ name: 'b', T: 500, species: [{ id: 'H2O', n: 2 }], u: 3, z: 5 }], Ws: 1 })
  ];
  const bad = /NaN|undefined|Infinity|\[object|null/;
  for (const r of results) {
    assert.ok(r.steps.length > 0);
    for (const s of r.steps) {
      assert.ok(typeof s.title === 'string' && s.title.length > 0 && !bad.test(s.title), 'title: ' + s.title);
      assert.ok(Array.isArray(s.equations) && Array.isArray(s.results));
      for (const q of s.equations) {
        for (const k of ['label', 'equation', 'substituted']) {
          assert.ok(typeof q[k] === 'string', k + ' is text in ' + s.title);
          assert.ok(!bad.test(q[k]), `"${q[k]}" in step "${s.title}"`);
        }
      }
      for (const v of s.results) {
        assert.ok(typeof v.name === 'string' && v.name.length > 0 && typeof v.unit === 'string');
        assert.ok(typeof v.value === 'number' && isFinite(v.value), v.name + ' in ' + s.title);
      }
    }
    assert.ok(Array.isArray(r.warnings) && Array.isArray(r.notes));
  }
});

/* ═════════════════════════ USER DATA ═════════════════════════ */

test('user-supplied data overrides built-in rows and adds new species', () => {
  // Himmelblau-style row in K: Cp = a + bT with a = 25, b = 0.01 J/(mol·K²) for a made-up gas "X2"; ∫ from 300 to 500 K = 25 × 200 + 0.005 × (500² − 300²) = 5000 + 800 = 5800 J/mol
  const db = Energy.extendDatabase(SP, [{ id: 'X2', name: 'Test gas', formula: 'N2', std: 'g', Hf: { g: -10 }, Cp: { g: { a: 25, b: 0.01, c: 0, d: 0, Tunit: 'K', Tmin: 200, Tmax: 800 } } }]);
  assert.ok(!SP.X2, 'the built-in table is not changed');
  close(Energy.sensibleHeat({ species: [{ id: 'X2', n: 1 }], T1: 300, T2: 500, phase: 'g', db }).dH, 5.8, 1e-12);
  near(db.X2.M, 28.014, 0.001, 'molar mass from the formula');
  // override: a new Cp for N2 replaces the built-in one, other fields stay
  const db2 = Energy.extendDatabase(SP, [{ id: 'N2', Cp: { g: { a: 30, b: 0, c: 0, d: 0, Tunit: 'C', Tmin: 0, Tmax: 1000 } } }]);
  close(Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: 298.15, T2: 373.15, phase: 'g', db: db2 }).dH, 30 * 75 / 1000, 1e-12);
  assert.equal(db2.N2.Hvap, SP.N2.Hvap);
  // override a heat of formation and a latent heat and see them used
  const db3 = Energy.extendDatabase(SP, [{ id: 'CH4', Hf: { g: -75.0 } }, { id: 'H2O', Hvap: 41.0 }]);
  near(Energy.heatOfReaction({ reaction: 'CH4 + 2 O2 -> CO2 + 2 H2O', db: db3 }).dH25, -890.18, 1e-9);
  close(Energy.phaseChange({ id: 'H2O', from: { T: 373.15, phase: 'l' }, to: { T: 373.15, phase: 'g' }, db: db3 }).dH, 41.0, 1e-12);
  // removing a phase with null, and ignoring blank rows
  const db4 = Energy.extendDatabase(SP, [{ id: 'H2O', Cp: { l: null } }, { id: '' }, null]);
  assert.equal(db4.H2O.Cp.l, undefined);
  // a new species used in a reaction
  const db5 = Energy.extendDatabase(SP, [{ id: 'C3H6', formula: 'C3H6', Hf: { g: 20.41 }, Cp: { g: { a: 59.58, b: 0.1771, c: -1.017e-4, d: 2.46e-8, Tunit: 'C', Tmin: 0, Tmax: 1200 } } }]);
  near(Energy.heatOfReaction({ reaction: 'C3H6 + H2 -> C3H8', db: db5 }).dH25, -103.8 - 20.41, 1e-9);
  assert.throws(() => Energy.heatOfReaction({ reaction: 'C3H6 + H2 -> C3H8' }));
});

test('coefficients typed as printed in a table are scaled correctly (a×10³, b×10⁵, c×10⁸, d×10¹² in kJ, as in Felder)', () => {
  const c = Energy.scaleCoefficients({ a: 29.00, b: 0.2199, c: 0.5723, d: -2.871 }, [3, 5, 8, 12], 'kJ');
  close(c.a, 29.00, 1e-12); close(c.b, 0.2199e-2, 1e-12); close(c.c, 0.5723e-5, 1e-12); close(c.d, -2.871e-9, 1e-12);
  const plain = Energy.scaleCoefficients({ a: 28.1, b: '0.002', c: '', d: undefined }, null, 'J');
  assert.deepEqual([plain.a, plain.b, plain.c, plain.d], [28.1, 0.002, 0, 0]);
  const himmelblau = Energy.scaleCoefficients({ a: 29.42, b: -0.2170, c: 0.0569, d: -1.99 }, [0, 2, 5, 9], 'J');   // J/(mol·K), b×10², c×10⁵, d×10⁹
  close(himmelblau.b, -0.2170e-2, 1e-12);
});

test('units: results convert with the existing Chem categories', () => {
  const kJ = Energy.sensibleHeat({ species: [{ id: 'N2', n: 1 }], T1: Chem.convert('temperature', 25, '°C', 'K'), T2: Chem.convert('temperature', 212, '°F', 'K'), phase: 'g' }).dH;
  close(kJ, 2.18711, 1e-5);                                    // 212 °F is 100 °C
  close(Chem.convert('energy', kJ, 'kJ', 'kcal'), kJ / 4.184, 1e-12);
  const kW = Energy.openSystem({ inlets: [{ T: 298.15, species: [{ id: 'N2', n: 10 }] }], outlets: [{ T: 373.15, species: [{ id: 'N2', n: 10 }] }] }).Q;
  close(Chem.convert('power', kW, 'kW', 'hp'), kW * 1000 / 745.69987158, 1e-12);
});

console.log(`\n${passed} test groups passed` + (process.exitCode ? ' — with failures' : ''));
