/* Page for electro.html. All numbers come from Electro (and Chem for units). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (x, n) { return Chem.fmt(x, n || 5); };
  var num = function (id) { return Chem.parseNumber($(id).value); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function lines(container, arr) {
    container.textContent = '';
    arr.forEach(function (t) { container.appendChild(el('div', null, t)); });
  }
  function show(warnEl, msg) {
    warnEl.textContent = msg || '';
    warnEl.classList.toggle('hidden', !msg);
  }
  function resultBox(big, unit, tableRows) {
    var box = el('div', 'result');
    var b = el('div', 'big', big + ' ');
    if (unit) b.appendChild(el('small', null, unit));
    box.appendChild(b);
    if (tableRows && tableRows.length) {
      var t = el('table'), tb = el('tbody');
      tableRows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', null, r[0]));
        tr.appendChild(el('td', 'num', r[1]));
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      var wrap = el('div', 'table-wrap'); wrap.appendChild(t);
      wrap.style.marginTop = '12px';
      box.appendChild(wrap);
    }
    return box;
  }

  /* ───────── product ───────── */

  var product = $('product');
  Electro.PRODUCTS.forEach(function (p) { product.add(new Option(p.label, p.id)); });
  product.add(new Option('Custom (enter M and z)', 'custom'));
  function currentProduct() { return Electro.PRODUCTS.filter(function (p) { return p.id === product.value; })[0] || null; }
  product.addEventListener('change', function () {
    var p = currentProduct();
    if (p) { $('M').value = String(p.M); $('z').value = String(p.z); }
    faradayUpdate(); energyUpdate();
  });
  [$('M'), $('z')].forEach(function (i) {
    i.addEventListener('input', function () { product.value = 'custom'; faradayUpdate(); energyUpdate(); });
  });

  /* ───────── Faraday's law ───────── */

  var VARS = [
    { key: 'm',   label: 'Mass of product', cat: 'mass',    unit: 'g', value: '',     base: 'g' },
    { key: 'I',   label: 'Current',         cat: 'current', unit: 'A', value: '1000', base: 'A' },
    { key: 't',   label: 'Time',            cat: 'time',    unit: 'h', value: '8',    base: 's' },
    { key: 'eff', label: 'Current efficiency η', cat: null, unit: '%', value: '95',   base: '' }
  ];
  var unknown = 'm';

  VARS.forEach(function (v) {
    var row = el('div', 'gas-row');
    var f1 = el('div', 'field'), l1 = el('label', null, v.label);
    l1.htmlFor = 'f-in-' + v.key;
    v.input = el('input'); v.input.type = 'text'; v.input.id = 'f-in-' + v.key; v.input.value = v.value;
    v.input.setAttribute('inputmode', 'decimal'); v.input.autocomplete = 'off';
    f1.appendChild(l1); f1.appendChild(v.input);

    var f2 = el('div', 'field'), l2 = el('label', null, 'Unit');
    if (v.cat) {
      l2.htmlFor = 'f-un-' + v.key;
      v.select = el('select'); v.select.id = 'f-un-' + v.key;
      Object.keys(Chem.CATEGORIES[v.cat].units).forEach(function (u) { v.select.add(new Option(u, u)); });
      v.select.value = v.unit;
      f2.appendChild(l2); f2.appendChild(v.select);
      v.select.addEventListener('change', faradayUpdate);
    } else {
      f2.appendChild(l2); f2.appendChild(el('div', 'static', '%'));
    }

    var rl = el('label', 'radio-row');
    v.radio = el('input'); v.radio.type = 'radio'; v.radio.name = 'f-unknown'; v.radio.value = v.key; v.radio.checked = v.key === unknown;
    rl.appendChild(v.radio); rl.appendChild(document.createTextNode(' Solve for this'));

    row.appendChild(f1); row.appendChild(f2); row.appendChild(rl);
    $('f-rows').appendChild(row);
    v.radio.addEventListener('change', function () { unknown = v.key; faradaySync(); });
    v.input.addEventListener('input', faradayUpdate);
  });
  [$('gas-T'), $('gas-P')].forEach(function (i) { i.addEventListener('input', faradayUpdate); });

  function faradaySync() {
    VARS.forEach(function (v) {
      v.input.disabled = v.key === unknown;
      if (v.key === unknown) v.input.value = '';
    });
    faradayUpdate();
  }

  function faradayUpdate() {
    var warn = $('f-warning'), out = $('f-working');
    show(warn, ''); out.textContent = '';
    var target = VARS.filter(function (v) { return v.key === unknown; })[0];
    $('f-gas').classList.toggle('hidden', !(currentProduct() && currentProduct().gas));

    var M = num('M'), z = num('z');
    if (!(M > 0) || !(z > 0)) { target.input.value = ''; show(warn, 'Enter a molar mass and the electrons per mole (both above zero), or pick a product.'); return; }

    var s = { M: M, z: z }, bad = '';
    VARS.forEach(function (v) {
      if (v.key === unknown) { s[v.key] = null; return; }
      var x = Chem.parseNumber(v.input.value);
      if (isNaN(x) || !(x > 0)) { bad = bad || 'Enter a number above zero for ' + v.label.toLowerCase() + '.'; return; }
      s[v.key] = v.key === 'eff' ? x / 100 : Chem.convert(v.cat, x, v.select.value, v.base);
    });
    if (bad) { target.input.value = ''; show(warn, bad); return; }

    var sol = Electro.faraday(s);
    var shown = sol.key === 'eff' ? sol.value * 100 : Chem.convert(target.cat, sol.value, target.base, target.select.value);
    target.input.value = fmt(shown, 6);

    var a = { m: s.m, I: s.I, t: s.t, eff: s.eff };
    a[sol.key] = sol.value;
    var F = Electro.F;
    if (a.eff > 1 + 1e-9) show(warn, 'The efficiency comes out above 100%, which is not possible. Check the numbers.');

    var formulas = {
      m:   'm = I·t·η·M / (z·F) = (' + fmt(a.I, 6) + ' A × ' + fmt(a.t, 6) + ' s × ' + fmt(a.eff, 6) + ' × ' + fmt(M, 6) + ' g/mol) / (' + fmt(z, 6) + ' × 96485.33 C/mol) = ' + fmt(a.m, 6) + ' g',
      I:   'I = m·z·F / (t·η·M) = (' + fmt(a.m, 6) + ' g × ' + fmt(z, 6) + ' × 96485.33 C/mol) / (' + fmt(a.t, 6) + ' s × ' + fmt(a.eff, 6) + ' × ' + fmt(M, 6) + ' g/mol) = ' + fmt(a.I, 6) + ' A',
      t:   't = m·z·F / (I·η·M) = (' + fmt(a.m, 6) + ' g × ' + fmt(z, 6) + ' × 96485.33 C/mol) / (' + fmt(a.I, 6) + ' A × ' + fmt(a.eff, 6) + ' × ' + fmt(M, 6) + ' g/mol) = ' + fmt(a.t, 6) + ' s',
      eff: 'η = m·z·F / (I·t·M) = (' + fmt(a.m, 6) + ' g × ' + fmt(z, 6) + ' × 96485.33 C/mol) / (' + fmt(a.I, 6) + ' A × ' + fmt(a.t, 6) + ' s × ' + fmt(M, 6) + ' g/mol) = ' + fmt(a.eff, 6) + ' (' + fmt(a.eff * 100, 5) + '%)'
    };
    var Q = a.I * a.t, nProd = a.m / M, mTheory = Q * M / (z * F);
    var info = [
      'Working in SI units (g, A, s). Faraday’s law: m = I·t·η·M / (z·F), with F = 96485.33 C/mol.',
      formulas[sol.key],
      'Charge passed: Q = I·t = ' + fmt(Q, 6) + ' C = ' + fmt(Q / 3600, 5) + ' A·h = ' + fmt(Q / F, 5) + ' mol of electrons.',
      'Product made: ' + fmt(nProd, 6) + ' mol. At 100% efficiency the same charge would give ' + fmt(mTheory, 6) + ' g.'
    ];
    var p = currentProduct();
    if (p && p.gas) {
      var T = num('gas-T'), P = num('gas-P');
      if (!isNaN(T) && !isNaN(P) && P > 0 && T + 273.15 > 0) {
        var V = Electro.gasVolume(nProd, T + 273.15, P);      // mol · (kPa·L/(mol·K)) · K / kPa = L
        info.push('Gas volume at ' + fmt(T, 4) + ' °C and ' + fmt(P, 5) + ' kPa (ideal gas): V = nRT/P = ' + fmt(V, 6) + ' L.');
      }
    }
    lines(out, info);
  }

  /* ───────── cell voltage ───────── */

  var cath = $('cath'), anod = $('anod');
  function fillHalf(sel) {
    Electro.HALF_REACTIONS.forEach(function (h) {
      sel.add(new Option(h.label + '   (' + (h.E > 0 ? '+' : h.E < 0 ? '−' : '') + Math.abs(h.E).toFixed(3) + ' V)', h.id));
    });
    sel.add(new Option('Custom (enter E° and electrons)', 'custom'));
  }
  fillHalf(cath); fillHalf(anod);
  cath.value = 'Cu'; anod.value = 'Zn';

  function half(side) {            // { E, z, label } for the chosen half-reaction
    var sel = side === 'c' ? cath : anod;
    if (sel.value === 'custom') {
      var pre = side === 'c' ? 'cath' : 'anod';
      return { E: num(pre + '-E'), z: num(pre + '-z'), label: 'custom half-reaction' };
    }
    var h = Electro.HALF_REACTIONS.filter(function (x) { return x.id === sel.value; })[0];
    return { E: h.E, z: h.z, label: h.label };
  }
  function reversed(label) {
    var m = label.match(/^(.*?)\s*(\(.*\))?$/), parts = m[1].split(' → ');
    return parts.length === 2 ? parts[1] + ' → ' + parts[0] + (m[2] ? '  ' + m[2] : '') : label;
  }

  function resetN() {
    var c = half('c'), a = half('a');
    if (c.z > 0 && a.z > 0) $('n').value = String(Electro.lcm(Math.round(c.z), Math.round(a.z)));
    cellUpdate();
  }
  function customToggle() { $('c-custom').classList.toggle('hidden', cath.value !== 'custom' && anod.value !== 'custom'); }
  [cath, anod].forEach(function (s) { s.addEventListener('change', function () { customToggle(); resetN(); }); });
  ['cath-E', 'cath-z', 'anod-E', 'anod-z'].forEach(function (id) { $(id).addEventListener('input', resetN); });
  ['n', 'c-T', 'c-Q'].forEach(function (id) { $(id).addEventListener('input', cellUpdate); });

  function cellUpdate() {
    var out = $('c-out'), warn = $('c-warning');
    out.textContent = ''; show(warn, '');
    var c = half('c'), a = half('a');
    var n = num('n'), Tc = num('c-T'), Q = num('c-Q');
    if (isNaN(c.E) || isNaN(a.E)) { show(warn, 'Enter a number for each custom E°.'); return; }
    if (!(n > 0)) { show(warn, 'Enter the number of electrons in the balanced reaction (above zero).'); return; }
    if (isNaN(Tc) || Tc + 273.15 <= 0) { show(warn, 'Enter a temperature above absolute zero.'); return; }
    if (!(Q > 0)) { show(warn, 'The reaction quotient must be above zero.'); return; }

    var T = Tc + 273.15;
    var E0 = Electro.cellStandard(c.E, a.E), E = Electro.nernst(E0, n, Q, T);
    var dG0 = Electro.deltaG(n, E0) / 1000, dG = Electro.deltaG(n, E) / 1000;
    var k = Electro.equilibriumK(n, E0, T);
    var Kshow = Math.abs(k.log10K) < 300 ? fmt(k.K, 4) : '10^' + fmt(k.log10K, 4);

    var box = resultBox(fmt(E0, 4) + ' V', 'standard cell potential E°cell', [
      ['E° cell = E°cathode − E°anode', fmt(c.E, 4) + ' − (' + fmt(a.E, 4) + ') = ' + fmt(E0, 4) + ' V'],
      ['Nernst: E = E° − (RT/nF) ln Q', fmt(E0, 4) + ' − (' + fmt(Electro.R * T / (n * Electro.F), 5) + ') × ln ' + fmt(Q, 4) + ' = ' + fmt(E, 4) + ' V'],
      ['ΔG° = −nFE°', fmt(dG0, 5) + ' kJ/mol'],
      ['ΔG = −nFE', fmt(dG, 5) + ' kJ/mol'],
      ['K = exp(nFE° / RT)', Kshow]
    ]);
    out.appendChild(box);
    var verdict = E > 0
      ? 'E is positive: the reaction as written is spontaneous. This is a galvanic cell that can deliver electrical energy.'
      : (E < 0 ? 'E is negative: the reaction as written does not happen by itself. An electrolytic cell must be driven with at least ' + fmt(-E, 4) + ' V, and real cells need more to cover overpotentials and resistive losses.'
               : 'E is zero: the cell is at equilibrium.');
    var txt = el('p', 'note');
    txt.textContent = 'Cathode: ' + c.label + '.  Anode: ' + reversed(a.label) + '.  n = ' + fmt(n, 4) + ' electrons.  ' + verdict;
    out.appendChild(txt);
  }

  /* ───────── energy ───────── */

  ['e-V', 'e-eff', 'e-price'].forEach(function (id) { $(id).addEventListener('input', energyUpdate); });

  function energyUpdate() {
    var out = $('e-out'), warn = $('e-warning');
    out.textContent = ''; show(warn, '');
    var M = num('M'), z = num('z'), V = num('e-V'), eff = num('e-eff') / 100, price = num('e-price');
    if (!(M > 0) || !(z > 0)) { show(warn, 'Pick a product, or enter a molar mass and electrons per mole above.'); return; }
    if (!(V > 0)) { show(warn, 'Enter a cell voltage above zero.'); return; }
    if (!(eff > 0)) { show(warn, 'Enter a current efficiency above zero.'); return; }
    if (eff > 1 + 1e-9) show(warn, 'Efficiency above 100% is not possible. Check the number.');

    var e = Electro.specificEnergy(z, V, M, eff);
    var rows = [
      ['kWh per kg  = z·F·V / (3600·M·η)', fmt(z, 4) + ' × 96485.33 × ' + fmt(V, 4) + ' / (3600 × ' + fmt(M, 5) + ' × ' + fmt(eff, 4) + ') = ' + fmt(e, 5)],
      ['kWh per tonne', fmt(e * 1000, 5)]
    ];
    if (price > 0) rows.push(['Electricity cost per kg of product', fmt(e * price, 4)]);
    out.appendChild(resultBox(fmt(e, 4), 'kWh per kg of product', rows));
  }

  /* ───────── start ───────── */

  product.value = 'Zn';
  $('M').value = '65.38'; $('z').value = '2';
  customToggle();
  resetN();
  faradaySync();
  energyUpdate();
})();
