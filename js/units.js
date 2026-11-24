(function () {
  var $ = function (id) { return document.getElementById(id); };
  var cat = $('cat'), val = $('val'), from = $('from'), to = $('to'),
      out = $('result'), tbody = $('all'), note = $('note');

  Object.keys(Chem.CATEGORIES).forEach(function (k) {
    cat.add(new Option(Chem.CATEGORIES[k].label, k));
  });

  function fillUnits() {
    var def = Chem.CATEGORIES[cat.value];
    var names = Object.keys(def.units);
    [from, to].forEach(function (sel) {
      sel.innerHTML = '';
      names.forEach(function (n) { sel.add(new Option(n, n)); });
    });
    from.value = def.def[0];
    to.value = def.def[1];
    note.classList.toggle('hidden', cat.value !== 'temperature');
  }

  function render() {
    var v = Chem.parseNumber(val.value);
    out.textContent = '';
    tbody.textContent = '';
    if (isNaN(v)) { out.textContent = 'Enter a number'; return; }

    var r = Chem.convert(cat.value, v, from.value, to.value);
    out.appendChild(document.createTextNode(Chem.fmt(v, 6) + ' ' + from.value + ' = ' + Chem.fmt(r, 6) + ' '));
    var small = document.createElement('small');
    small.textContent = to.value;
    out.appendChild(small);

    Object.keys(Chem.CATEGORIES[cat.value].units).forEach(function (name) {
      var tr = document.createElement('tr');
      if (name === to.value) tr.className = 'hl';
      var th = document.createElement('td');
      th.textContent = name;
      var td = document.createElement('td');
      td.className = 'num';
      td.textContent = Chem.fmt(Chem.convert(cat.value, v, from.value, name), 6);
      tr.appendChild(th); tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  cat.addEventListener('change', function () { fillUnits(); render(); });
  [val, from, to].forEach(function (el) { el.addEventListener('input', render); el.addEventListener('change', render); });
  $('swap').addEventListener('click', function () {
    var t = from.value; from.value = to.value; to.value = t; render();
  });

  fillUnits();
  render();
})();
