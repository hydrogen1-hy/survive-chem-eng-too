(function () {
  var VARS = [
    { key: 'P', label: 'Pressure',    cat: 'pressure',    unit: 'kPa', value: '101.325', base: 'Pa' },
    { key: 'V', label: 'Volume',      cat: 'volume',      unit: 'L',   value: '',        base: 'm³' },
    { key: 'n', label: 'Amount',      cat: 'amount',      unit: 'mol', value: '1',       base: 'mol' },
    { key: 'T', label: 'Temperature', cat: 'temperature', unit: '°C',  value: '0',       base: 'K' }
  ];
  var rowsEl = document.getElementById('rows'),
      warning = document.getElementById('warning'),
      working = document.getElementById('working');
  var unknown = 'V';

  VARS.forEach(function (v) {
    var row = document.createElement('div');
    row.className = 'gas-row';

    var field = document.createElement('div'); field.className = 'field';
    var label = document.createElement('label'); label.setAttribute('for', 'in-' + v.key); label.textContent = v.label;
    v.input = document.createElement('input');
    v.input.type = 'text'; v.input.id = 'in-' + v.key; v.input.value = v.value;
    v.input.setAttribute('inputmode', 'decimal'); v.input.autocomplete = 'off';
    field.appendChild(label); field.appendChild(v.input);

    var sel = document.createElement('div'); sel.className = 'field';
    var sl = document.createElement('label'); sl.setAttribute('for', 'un-' + v.key); sl.textContent = 'Unit';
    v.select = document.createElement('select'); v.select.id = 'un-' + v.key;
    Object.keys(Chem.CATEGORIES[v.cat].units).forEach(function (u) { v.select.add(new Option(u, u)); });
    v.select.value = v.unit;
    sel.appendChild(sl); sel.appendChild(v.select);

    var rl = document.createElement('label'); rl.className = 'radio-row';
    v.radio = document.createElement('input');
    v.radio.type = 'radio'; v.radio.name = 'unknown'; v.radio.value = v.key; v.radio.checked = v.key === unknown;
    rl.appendChild(v.radio); rl.appendChild(document.createTextNode(' Solve for this'));

    row.appendChild(field); row.appendChild(sel); row.appendChild(rl);
    rowsEl.appendChild(row);

    v.radio.addEventListener('change', function () { unknown = v.key; sync(); });
    v.input.addEventListener('input', update);
    v.select.addEventListener('change', update);
  });

  function sync() {
    VARS.forEach(function (v) {
      v.input.disabled = v.key === unknown;
      if (v.key === unknown) v.input.value = '';
    });
    update();
  }

  function update() {
    warning.classList.add('hidden');
    var si = {}, ok = true, msg = '';
    VARS.forEach(function (v) {
      if (v.key === unknown) { si[v.key] = null; return; }
      var x = Chem.parseNumber(v.input.value);
      if (isNaN(x)) { ok = false; msg = 'Enter a number for ' + v.label.toLowerCase() + '.'; return; }
      var s = Chem.convert(v.cat, x, v.select.value, v.base);
      if (!(s > 0)) { ok = false; msg = v.label + ' must be above zero' + (v.key === 'T' ? ' kelvin (absolute zero).' : '.'); return; }
      si[v.key] = s;
    });

    var target = VARS.filter(function (v) { return v.key === unknown; })[0];
    if (!ok) {
      target.input.value = '';
      working.textContent = '';
      if (msg.indexOf('above zero') >= 0) { warning.textContent = msg; warning.classList.remove('hidden'); }
      return;
    }

    var sol = Chem.idealGas(si);
    target.input.value = Chem.fmt(Chem.convert(target.cat, sol.value, target.base, target.select.value), 6);

    var f = { P: 'P = nRT / V', V: 'V = nRT / P', n: 'n = PV / (RT)', T: 'T = PV / (nR)' }[unknown];
    var parts = VARS.map(function (v) {
      var val = v.key === unknown ? sol.value : si[v.key];
      return v.key + ' = ' + Chem.fmt(val, 6) + ' ' + v.base;
    });
    working.textContent = 'Working in SI (R = 8.314 J/(mol·K)): ' + parts.join(', ') + '.  Rearranged: ' + f + '.';
  }

  sync();
})();
