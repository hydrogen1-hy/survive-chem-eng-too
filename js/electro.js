/*
 * Electrochemistry for process engineering: Faraday's law with current efficiency,
 * cell potentials (Nernst), free energy, equilibrium constant, and energy consumption.
 * Plain deterministic code. Works in the browser (window.Electro) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Electro = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const F = 96485.33212;        // C/mol, Faraday constant (e × N_A, exact in the 2019 SI)
  const R = 8.314462618;        // J/(mol·K)

  /* ───────── Faraday's law ─────────
       m = I · t · η · M / (z · F)
     m in g, I in A, t in s, η as a fraction (current efficiency), M in g/mol,
     z = electrons per mole of product. Pass the four of {m, I, t, eff} you know and null for the one to find. */
  function faraday(s) {
    const missing = ['m', 'I', 't', 'eff'].filter(k => s[k] === null || s[k] === undefined);
    if (missing.length !== 1) throw new Error('Exactly one of m, I, t, eff must be missing');
    const { m, I, t, eff, M, z } = s;
    if (!(M > 0) || !(z > 0)) throw new Error('M and z must be positive');
    switch (missing[0]) {
      case 'm':   return { key: 'm',   value: I * t * eff * M / (z * F) };
      case 'I':   return { key: 'I',   value: m * z * F / (t * eff * M) };
      case 't':   return { key: 't',   value: m * z * F / (I * eff * M) };
      default:    return { key: 'eff', value: m * z * F / (I * t * M) };
    }
  }

  /* Gas volume from moles at T (K) and P (Pa): m³ */
  const gasVolume = (nmol, T, P) => nmol * R * T / P;

  /* ───────── Cells ───────── */

  const cellStandard = (Ecathode, Eanode) => Ecathode - Eanode;           // E°cell = E°(reduction at cathode) − E°(reduction at anode)
  const nernst = (E0, z, Q, T) => E0 - (R * T / (z * F)) * Math.log(Q);   // V
  const deltaG = (z, E) => -z * F * E;                                    // J per mole of reaction as written
  function equilibriumK(z, E0, T) {                                       // ln K = zFE°/RT
    const lnK = z * F * E0 / (R * T);
    return { K: Math.exp(lnK), log10K: lnK / Math.LN10 };
  }
  const gcd = (a, b) => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const lcm = (a, b) => Math.abs(a * b) / gcd(a, b);

  /* Electrical energy per kg of product: kWh/kg = z·F·V / (3600 · M · η), M in g/mol, V in volts. */
  const specificEnergy = (z, V, M, eff) => z * F * V / (3600 * M * eff);

  /* ───────── Data ───────── */

  /* Products made by electrolysis. M in g/mol (IUPAC standard atomic weights), z = electrons per mole of product. */
  const PRODUCTS = [
    { id: 'Cu',   label: 'Copper, Cu²⁺ + 2e⁻ → Cu',            M: 63.546,  z: 2, gas: false },
    { id: 'Zn',   label: 'Zinc, Zn²⁺ + 2e⁻ → Zn',             M: 65.38,   z: 2, gas: false },
    { id: 'Ni',   label: 'Nickel, Ni²⁺ + 2e⁻ → Ni',           M: 58.693,  z: 2, gas: false },
    { id: 'Fe',   label: 'Iron, Fe²⁺ + 2e⁻ → Fe',             M: 55.845,  z: 2, gas: false },
    { id: 'Ag',   label: 'Silver, Ag⁺ + e⁻ → Ag',             M: 107.868, z: 1, gas: false },
    { id: 'Au',   label: 'Gold, Au³⁺ + 3e⁻ → Au',             M: 196.967, z: 3, gas: false },
    { id: 'Al',   label: 'Aluminium, Al³⁺ + 3e⁻ → Al',        M: 26.982,  z: 3, gas: false },
    { id: 'Mg',   label: 'Magnesium, Mg²⁺ + 2e⁻ → Mg',        M: 24.305,  z: 2, gas: false },
    { id: 'Na',   label: 'Sodium, Na⁺ + e⁻ → Na',             M: 22.990,  z: 1, gas: false },
    { id: 'Cl2',  label: 'Chlorine, 2Cl⁻ → Cl₂ + 2e⁻',        M: 70.90,   z: 2, gas: true },
    { id: 'H2',   label: 'Hydrogen, 2H⁺ + 2e⁻ → H₂',          M: 2.016,   z: 2, gas: true },
    { id: 'O2',   label: 'Oxygen, 2H₂O → O₂ + 4H⁺ + 4e⁻',     M: 31.998,  z: 4, gas: true },
    { id: 'NaOH', label: 'NaOH (chlor-alkali, 1 OH⁻ per e⁻)',  M: 39.997,  z: 1, gas: false }
  ];

  /* Standard reduction potentials at 25 °C in volts versus the standard hydrogen electrode.
     Typical textbook values: your course table may differ in the last digit, so check it, or type your own. */
  const HALF_REACTIONS = [
    { id: 'Li',   label: 'Li⁺ + e⁻ → Li',                          E: -3.040, z: 1 },
    { id: 'Ca',   label: 'Ca²⁺ + 2e⁻ → Ca',                        E: -2.868, z: 2 },
    { id: 'Na',   label: 'Na⁺ + e⁻ → Na',                          E: -2.71,  z: 1 },
    { id: 'Mg',   label: 'Mg²⁺ + 2e⁻ → Mg',                        E: -2.372, z: 2 },
    { id: 'Al',   label: 'Al³⁺ + 3e⁻ → Al',                        E: -1.662, z: 3 },
    { id: 'Zn',   label: 'Zn²⁺ + 2e⁻ → Zn',                        E: -0.762, z: 2 },
    { id: 'Cr',   label: 'Cr³⁺ + 3e⁻ → Cr',                        E: -0.744, z: 3 },
    { id: 'Fe',   label: 'Fe²⁺ + 2e⁻ → Fe',                        E: -0.447, z: 2 },
    { id: 'Cd',   label: 'Cd²⁺ + 2e⁻ → Cd',                        E: -0.403, z: 2 },
    { id: 'Ni',   label: 'Ni²⁺ + 2e⁻ → Ni',                        E: -0.257, z: 2 },
    { id: 'Sn',   label: 'Sn²⁺ + 2e⁻ → Sn',                        E: -0.138, z: 2 },
    { id: 'Pb',   label: 'Pb²⁺ + 2e⁻ → Pb',                        E: -0.126, z: 2 },
    { id: 'H2',   label: '2H⁺ + 2e⁻ → H₂',                         E: 0,      z: 2 },
    { id: 'Cu',   label: 'Cu²⁺ + 2e⁻ → Cu',                        E: 0.342,  z: 2 },
    { id: 'I2',   label: 'I₂ + 2e⁻ → 2I⁻',                         E: 0.536,  z: 2 },
    { id: 'Fe3',  label: 'Fe³⁺ + e⁻ → Fe²⁺',                       E: 0.771,  z: 1 },
    { id: 'Ag',   label: 'Ag⁺ + e⁻ → Ag',                          E: 0.800,  z: 1 },
    { id: 'Br2',  label: 'Br₂ + 2e⁻ → 2Br⁻',                       E: 1.066,  z: 2 },
    { id: 'O2',   label: 'O₂ + 4H⁺ + 4e⁻ → 2H₂O',                  E: 1.229,  z: 4 },
    { id: 'Cl2',  label: 'Cl₂ + 2e⁻ → 2Cl⁻',                       E: 1.358,  z: 2 },
    { id: 'Au',   label: 'Au³⁺ + 3e⁻ → Au',                        E: 1.498,  z: 3 },
    { id: 'MnO4', label: 'MnO₄⁻ + 8H⁺ + 5e⁻ → Mn²⁺ + 4H₂O',       E: 1.507,  z: 5 },
    { id: 'F2',   label: 'F₂ + 2e⁻ → 2F⁻',                         E: 2.866,  z: 2 },
    { id: 'H2Oa', label: '2H₂O + 2e⁻ → H₂ + 2OH⁻  (alkaline)',     E: -0.828, z: 2 },
    { id: 'O2a',  label: 'O₂ + 2H₂O + 4e⁻ → 4OH⁻  (alkaline)',     E: 0.401,  z: 4 }
  ];

  return { F, R, faraday, gasVolume, cellStandard, nernst, deltaG, equilibriumK, lcm, specificEnergy, PRODUCTS, HALF_REACTIONS };
});
