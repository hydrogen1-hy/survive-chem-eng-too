// Run with:  node tests/chem.test.js
const assert = require('node:assert/strict');
const Chem = require('../js/chem.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const close = (a, b, relTol, msg) => {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  assert.ok(err <= relTol, `${msg || ''} expected ≈${b}, got ${a} (rel err ${(err * 100).toFixed(3)}%)`);
};

/* ───── Units ───── */
test('known conversions', () => {
  close(Chem.convert('pressure', 1, 'atm', 'kPa'), 101.325, 1e-9);
  close(Chem.convert('pressure', 1, 'psi', 'kPa'), 6.894757, 1e-6);
  close(Chem.convert('pressure', 760, 'mmHg', 'atm'), 1, 1e-6);
  close(Chem.convert('energy', 1, 'BTU', 'kJ'), 1.055056, 1e-6);
  close(Chem.convert('energy', 1, 'kWh', 'MJ'), 3.6, 1e-12);
  close(Chem.convert('power', 1, 'hp', 'kW'), 0.7456999, 1e-6);
  close(Chem.convert('volFlow', 100, 'L/min', 'm³/h'), 6, 1e-12);
  close(Chem.convert('massFlow', 1, 'lb/h', 'kg/h'), 0.45359237, 1e-12);
  close(Chem.convert('viscosity', 1, 'cP', 'Pa·s'), 0.001, 1e-12);
  close(Chem.convert('density', 62.4, 'lb/ft³', 'kg/m³'), 999.5, 1e-3);
  close(Chem.convert('volume', 1, 'bbl', 'gal (US)'), 42, 1e-9);
  close(Chem.convert('amount', 1, 'lbmol', 'mol'), 453.59237, 1e-9);
  close(Chem.convert('time', 1, 'day', 'h'), 24, 1e-12);
  close(Chem.convert('time', 90, 'min', 's'), 5400, 1e-12);
  close(Chem.convert('current', 2.5, 'kA', 'A'), 2500, 1e-12);
  close(Chem.convert('charge', 1, 'A·h', 'C'), 3600, 1e-12);
  close(Chem.convert('charge', 1, 'faraday', 'C'), 96485.33212, 1e-9);
  close(Chem.convert('charge', 1, 'faraday', 'A·h'), 26.80148, 1e-6);          // the classic 26.8 Ah per mole of electrons
  close(Chem.convert('currentDensity', 1, 'mA/cm²', 'A/m²'), 10, 1e-12);
  close(Chem.convert('currentDensity', 2, 'kA/m²', 'mA/cm²'), 200, 1e-12);
});

test('temperature conversions', () => {
  close(Chem.convert('temperature', 25, '°C', 'K'), 298.15, 1e-12);
  close(Chem.convert('temperature', 212, '°F', '°C'), 100, 1e-12);
  close(Chem.convert('temperature', 0, '°C', '°F'), 32, 1e-12);
  close(Chem.convert('temperature', 0, 'K', '°R'), 0, 1);
  close(Chem.convert('temperature', 100, '°C', '°R'), 671.67, 1e-9);
});

test('every unit round-trips', () => {
  for (const [cat, def] of Object.entries(Chem.CATEGORIES)) {
    const names = Object.keys(def.units);
    for (const a of names) for (const b of names) {
      const there = Chem.convert(cat, 123.456, a, b);
      close(Chem.convert(cat, there, b, a), 123.456, 1e-9, `${cat} ${a}->${b}->${a}`);
    }
  }
});

test('category defaults are valid units', () => {
  for (const [cat, def] of Object.entries(Chem.CATEGORIES)) {
    assert.ok(def.units[def.def[0]] !== undefined, cat + ' default from');
    assert.ok(def.units[def.def[1]] !== undefined, cat + ' default to');
  }
});

test('parseNumber', () => {
  assert.equal(Chem.parseNumber('12.5'), 12.5);
  assert.equal(Chem.parseNumber(' 1,234.5 '), 1234.5);
  assert.equal(Chem.parseNumber('1,5'), 1.5);
  assert.equal(Chem.parseNumber('1.2e-3'), 0.0012);
  assert.equal(Chem.parseNumber('−4'), -4);
  assert.ok(Number.isNaN(Chem.parseNumber('abc')));
  assert.ok(Number.isNaN(Chem.parseNumber('')));
  assert.ok(Number.isNaN(Chem.parseNumber('1.2.3')));
});

test('fmt', () => {
  assert.equal(Chem.fmt(0.000012345, 3), '1.23e-5');
  assert.equal(Chem.fmt(1234.5678, 4), '1235');
  assert.equal(Chem.fmt(0.5, 4), '0.5');
  assert.equal(Chem.fmt(NaN), '—');
});

/* ───── Antoine: sanity-check every built-in constant set ───── */
// Literature normal boiling points (K) and 25 °C vapour pressures (kPa).
const NBP = { water: 373.15, ethanol: 351.44, methanol: 337.7, acetone: 329.2, benzene: 353.2, toluene: 383.8, hexane: 341.9 };
const P25 = { water: 3.169, ethanol: 7.87, methanol: 16.9, acetone: 30.8, benzene: 12.7, toluene: 3.79, hexane: 20.2 };

test('Antoine constants reproduce normal boiling points (±1.5 K)', () => {
  for (const [k, c] of Object.entries(Chem.COMPOUNDS)) {
    const T = Chem.boilingPointK(c, 1.01325);
    assert.ok(Math.abs(T - NBP[k]) < 1.5, `${k}: predicted ${T.toFixed(2)} K vs ${NBP[k]} K`);
  }
});

test('Antoine constants reproduce 25 °C vapour pressures (±3%)', () => {
  for (const [k, c] of Object.entries(Chem.COMPOUNDS)) {
    close(Chem.vapourPressureBar(c, 298.15) * 100, P25[k], 0.03, k);
  }
});

test('water is accurate: boils at 100.0 °C at 1 atm (±0.1 K), 25 °C and 50 °C within 1%', () => {
  const w = Chem.COMPOUNDS.water;
  assert.ok(Math.abs(Chem.boilingPointK(w, 1.01325) - 373.15) < 0.1, 'NBP ' + Chem.boilingPointK(w, 1.01325));
  close(Chem.vapourPressureBar(w, 298.15) * 100, 3.169, 0.01);
  close(Chem.vapourPressureBar(w, 323.15) * 100, 12.352, 0.01);
  // the textbook mmHg / °C form must agree with the converted bar / K form
  const textbook = Math.pow(10, 8.07131 - 1730.63 / (80 + 233.426));           // mmHg at 80 °C
  close(Chem.vapourPressureBar(w, 353.15) * 750.06168, textbook, 1e-4);
});

test('Antoine P and T functions are inverses; ln form agrees with log10 form', () => {
  const c = Chem.COMPOUNDS.benzene;
  for (const T of [290, 310, 330, 350]) {
    close(Chem.antoineT(c.A, c.B, c.C, Chem.antoineP(c.A, c.B, c.C, T, false), false), T, 1e-12);
  }
  // convert the log10 form to ln form: ln P = A·ln10 − B·ln10/(T+C)
  const ln10 = Math.LN10;
  close(Chem.antoineP(c.A * ln10, c.B * ln10, c.C, 330, true), Chem.antoineP(c.A, c.B, c.C, 330, false), 1e-12);
});

test('compound validity ranges are sensible', () => {
  for (const c of Object.values(Chem.COMPOUNDS)) assert.ok(c.Tmin < c.Tmax && c.Tmin > 200 && c.Tmax < 600);
});

/* ───── Ideal gas ───── */
test('ideal gas: 1 mol at 273.15 K, 1 atm = 22.414 L', () => {
  const V = Chem.idealGas({ P: 101325, V: null, n: 1, T: 273.15 }).value;
  close(V * 1000, 22.414, 1e-4);
});
test('ideal gas: solves each unknown consistently', () => {
  const P = 150000, V = 0.02, n = 1.2, T = 300;
  const Pc = Chem.idealGas({ P: null, V, n, T }).value;
  close(Chem.idealGas({ P: Pc, V: null, n, T }).value, V, 1e-12);
  close(Chem.idealGas({ P: Pc, V, n: null, T }).value, n, 1e-12);
  close(Chem.idealGas({ P: Pc, V, n, T: null }).value, T, 1e-12);
  assert.throws(() => Chem.idealGas({ P, V, n, T }));
  assert.throws(() => Chem.idealGas({ P: null, V: null, n, T }));
});

console.log(`\n${passed} test groups passed` + (process.exitCode ? ' — with failures' : ''));
