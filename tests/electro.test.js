// Run with:  node tests/electro.test.js
const assert = require('node:assert/strict');
const Electro = require('../js/electro.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a} (rel err ${(err * 100).toFixed(4)}%)`);
};
const P = id => Electro.PRODUCTS.find(p => p.id === id);
const H = id => Electro.HALF_REACTIONS.find(h => h.id === id);

test('Faraday constant = elementary charge × Avogadro constant', () => {
  close(Electro.F, 1.602176634e-19 * 6.02214076e23, 1e-9);
});

/* Electrochemical equivalents in g per ampere-hour are quoted in every handbook. */
test('mass per ampere-hour matches the handbook values (100% efficiency)', () => {
  const gPerAh = id => Electro.faraday({ m: null, I: 1, t: 3600, eff: 1, M: P(id).M, z: P(id).z }).value;
  close(gPerAh('Cu'), 1.186, 2e-3);
  close(gPerAh('Zn'), 1.220, 2e-3);
  close(gPerAh('Ag'), 4.025, 2e-3);
  close(gPerAh('Al'), 0.3356, 2e-3);
  close(gPerAh('Cl2'), 1.323, 2e-3);
  close(gPerAh('H2'), 0.0376, 2e-3);
  close(gPerAh('O2'), 0.2985, 2e-3);
});

test('26.8 A·h of charge deposits one mole of electrons; 1 mol of a z = 2 metal needs two', () => {
  const m = Electro.faraday({ m: null, I: 26.80148, t: 3600, eff: 1, M: 63.546, z: 2 }).value;
  close(m, 63.546 / 2, 1e-6);
});

test('current efficiency scales the mass linearly', () => {
  const full = Electro.faraday({ m: null, I: 50, t: 7200, eff: 1, M: 65.38, z: 2 }).value;
  const part = Electro.faraday({ m: null, I: 50, t: 7200, eff: 0.92, M: 65.38, z: 2 }).value;
  close(part, 0.92 * full, 1e-12);
});

test('worked example: zinc plating at 300 A for 8 h, 92% efficient', () => {
  // m = 300 × 28800 × 0.92 × 65.38 / (2 × 96485.33212) = 2.693 kg
  const m = Electro.faraday({ m: null, I: 300, t: 8 * 3600, eff: 0.92, M: 65.38, z: 2 }).value;
  close(m, 300 * 28800 * 0.92 * 65.38 / (2 * 96485.33212), 1e-12);
  close(m / 1000, 2.693, 2e-3);
});

test('each unknown solves consistently (m, I, t, eff round-trip)', () => {
  const base = { I: 120, t: 5400, eff: 0.88, M: 58.693, z: 2 };
  const m = Electro.faraday({ ...base, m: null }).value;
  close(Electro.faraday({ m, I: null, t: base.t, eff: base.eff, M: base.M, z: base.z }).value, base.I, 1e-12);
  close(Electro.faraday({ m, I: base.I, t: null, eff: base.eff, M: base.M, z: base.z }).value, base.t, 1e-12);
  close(Electro.faraday({ m, I: base.I, t: base.t, eff: null, M: base.M, z: base.z }).value, base.eff, 1e-12);
  assert.throws(() => Electro.faraday({ m, I: 1, t: 1, eff: 1, M: 1, z: 1 }));
  assert.throws(() => Electro.faraday({ m: null, I: null, t: 1, eff: 1, M: 1, z: 1 }));
  assert.throws(() => Electro.faraday({ m: null, I: 1, t: 1, eff: 1, M: 0, z: 1 }));
});

test('gas volume: 1 mol at 0 °C and 1 atm is 22.414 L', () => {
  close(Electro.gasVolume(1, 273.15, 101325) * 1000, 22.414, 1e-4);
});

test('electrolysing water: H₂ volume is twice the O₂ volume (same current and time)', () => {
  const nH2 = 5 * 1800 * 1 / (2 * Electro.F), nO2 = 5 * 1800 * 1 / (4 * Electro.F);
  close(Electro.gasVolume(nH2, 298.15, 101325) / Electro.gasVolume(nO2, 298.15, 101325), 2, 1e-12);
});

/* ───── cells ───── */
test('Nernst: one decade of Q shifts the potential by 59.16 mV / z at 25 °C', () => {
  close(Electro.nernst(0, 1, 10, 298.15), -0.0591596, 1e-4);
  close(Electro.nernst(0, 2, 100, 298.15), -0.0591596, 1e-4);
  close(Electro.nernst(1.1, 2, 1, 298.15), 1.1, 1e-12);                 // Q = 1 gives E°
});

test('Daniell cell (Zn | Cu): E° ≈ 1.10 V, ΔG° ≈ −213 kJ/mol, K ≈ 10^37', () => {
  const E0 = Electro.cellStandard(H('Cu').E, H('Zn').E);
  close(E0, 1.104, 2e-3);
  close(Electro.deltaG(2, E0) / 1000, -213.0, 5e-3);
  const k = Electro.equilibriumK(2, E0, 298.15);
  assert.ok(Math.abs(k.log10K - 37.3) < 0.3, 'log10 K = ' + k.log10K);
  close(k.K, Math.pow(10, k.log10K), 1e-9);
});

test('ΔG = −nFE and ΔG = −RT ln K agree', () => {
  const E0 = 0.76, z = 3, T = 310;
  const dG = Electro.deltaG(z, E0), K = Electro.equilibriumK(z, E0, T);
  close(dG, -Electro.R * T * Math.log(K.K), 1e-12);
});

test('electron count for a balanced overall reaction is the least common multiple', () => {
  assert.equal(Electro.lcm(2, 3), 6);
  assert.equal(Electro.lcm(2, 4), 4);
  assert.equal(Electro.lcm(1, 1), 1);
  assert.equal(Electro.lcm(3, 5), 15);
});

/* ───── energy ───── */
test('specific energy: chlor-alkali at 3.5 V is about 2.6 kWh per kg of Cl₂; efficiency raises it', () => {
  const e = Electro.specificEnergy(2, 3.5, 70.90, 1);
  close(e, 2 * 96485.33212 * 3.5 / 3.6e6 * 1000 / 70.90, 1e-12);       // independent unit path: J/mol → kWh → per kg
  assert.ok(e > 2.5 && e < 2.8, 'kWh/kg = ' + e);
  close(Electro.specificEnergy(2, 3.5, 70.90, 0.95), e / 0.95, 1e-12);
});

test('energy and Faraday agree: kWh = I·V·t/3.6e6 for the mass the same charge deposits', () => {
  const I = 400, t = 3 * 3600, V = 2.1, eff = 0.9, M = 65.38, z = 2;
  const m = Electro.faraday({ m: null, I, t, eff, M, z }).value;          // g
  const kWh = I * V * t / 3.6e6;
  close(Electro.specificEnergy(z, V, M, eff) * m / 1000, kWh, 1e-12);
});

/* ───── data sanity ───── */
test('product molar masses match standard atomic weights', () => {
  const w = { Cu: 63.546, Zn: 65.38, Ni: 58.693, Fe: 55.845, Ag: 107.868, Au: 196.967, Al: 26.982, Mg: 24.305, Na: 22.990, Cl: 35.45, H: 1.008, O: 15.999 };
  close(P('Cl2').M, 2 * w.Cl, 3e-3);
  close(P('H2').M, 2 * w.H, 3e-3);
  close(P('O2').M, 2 * w.O, 3e-3);
  close(P('NaOH').M, w.Na + w.O + w.H, 3e-3);
  ['Cu', 'Zn', 'Ni', 'Fe', 'Ag', 'Au', 'Al', 'Mg', 'Na'].forEach(e => close(P(e).M, w[e], 1e-3, e));
  Electro.PRODUCTS.forEach(p => assert.ok(p.M > 0 && p.z >= 1 && Number.isInteger(p.z), p.id));
});

test('half-reaction table: hydrogen is zero, ordering follows the activity series, entries well-formed', () => {
  assert.equal(H('H2').E, 0);
  const order = ['Li', 'Ca', 'Na', 'Mg', 'Al', 'Zn', 'Fe', 'Ni', 'Pb', 'H2', 'Cu', 'Ag', 'Cl2', 'Au', 'F2'];
  for (let i = 1; i < order.length; i++) assert.ok(H(order[i]).E > H(order[i - 1]).E, order[i - 1] + ' < ' + order[i]);
  Electro.HALF_REACTIONS.forEach(h => assert.ok(Number.isFinite(h.E) && Number.isInteger(h.z) && h.z >= 1 && h.label.indexOf('→') > 0, h.id));
  const ids = Electro.HALF_REACTIONS.map(h => h.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  // the two water reactions differ by 0.0591 × 14 = 0.828 V of pH
  close(H('H2Oa').E, -0.0591596 * 14, 2e-3);
  close(H('O2a').E, 1.229 - 0.0591596 * 14, 2e-3);
});

console.log(`\n${passed} test groups passed` + (process.exitCode ? ' — with failures' : ''));
