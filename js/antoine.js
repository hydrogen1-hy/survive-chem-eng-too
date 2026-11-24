(function () {
  var $ = function (id) { return document.getElementById(id); };
  var P_UNITS = ['kPa', 'bar', 'atm', 'mmHg', 'psi', 'Pa'];
  var T_UNITS = ['°C', 'K', '°F'];

  var compound = $('compound'), mode = $('mode'), custom = $('custom'),
      cA = $('cA'), cB = $('cB'), cC = $('cC'), cForm = $('cForm'), cPU = $('cPU'), cTU = $('cTU'),
      val = $('val'), valLabel = $('valLabel'), unit = $('unit'),
      result = $('result'), others = $('others'), resultBox = $('resultBox'),
      warning = $('warning'), constants = $('constants'), logY = $('logY'), chart = $('chart');

  Object.keys(Chem.COMPOUNDS).forEach(function (k) {
    var c = Chem.COMPOUNDS[k];
    compound.add(new Option(c.name + ' (' + c.formula + ')', k));
  });
  compound.add(new Option('Custom constants…', 'custom'));
  P_UNITS.forEach(function (u) { cPU.add(new Option(u, u)); });
  T_UNITS.slice(0, 2).forEach(function (u) { cTU.add(new Option(u, u)); });
  cPU.value = 'mmHg'; cTU.value = '°C';

  function fillUnits() {
    var list = mode.value === 'P' ? T_UNITS : P_UNITS;
    unit.innerHTML = '';
    list.forEach(function (u) { unit.add(new Option(u, u)); });
    unit.value = mode.value === 'P' ? '°C' : 'kPa';
    valLabel.textContent = mode.value === 'P' ? 'Temperature' : 'Pressure';
  }

  /* Returns { P(TK)->Pa, T(Pa)->K, valid(TK), range: [TminK, TmaxK] | null, text } or null if inputs are bad. */
  function buildModel() {
    if (compound.value !== 'custom') {
      var c = Chem.COMPOUNDS[compound.value];
      return {
        P: function (TK) { return Chem.vapourPressureBar(c, TK) * 1e5; },
        T: function (Pa) { return Chem.boilingPointK(c, Pa / 1e5); },
        valid: function () { return true; },
        range: [c.Tmin, c.Tmax],
        text: 'log₁₀(P/bar) = A − B/(T/K + C),  A = ' + c.A + ', B = ' + c.B + ', C = ' + c.C +
              '  (stated range ' + Chem.fmt(c.Tmin - 273.15, 4) + ' to ' + Chem.fmt(c.Tmax - 273.15, 4) + ' °C)'
      };
    }
    var A = Chem.parseNumber(cA.value), B = Chem.parseNumber(cB.value), C = Chem.parseNumber(cC.value);
    if ([A, B, C].some(isNaN)) return null;
    var ln = cForm.value === 'ln', pu = cPU.value, tu = cTU.value;
    return {
      P: function (TK) {
        var T = Chem.convert('temperature', TK, 'K', tu);
        return Chem.convert('pressure', Chem.antoineP(A, B, C, T, ln), pu, 'Pa');
      },
      T: function (Pa) {
        var T = Chem.antoineT(A, B, C, Chem.convert('pressure', Pa, 'Pa', pu), ln);
        return Chem.convert('temperature', T, tu, 'K');
      },
      valid: function (TK) { return Chem.convert('temperature', TK, 'K', tu) + C > 0; },
      range: null,
      text: (ln ? 'ln' : 'log₁₀') + '(P/' + pu + ') = ' + A + ' − ' + B + '/(T/' + tu + ' + (' + C + '))'
    };
  }

  function show(msg, isWarn) {
    result.textContent = msg;
    others.textContent = '';
    resultBox.classList.toggle('warn', !!isWarn);
    if (isWarn) chart.textContent = '';   // don't leave a stale curve behind an error
  }

  function update() {
    warning.classList.add('hidden');
    var m = buildModel();
    custom.classList.toggle('hidden', compound.value !== 'custom');
    if (!m) { show('Enter numbers for A, B and C', true); chart.textContent = ''; return; }
    constants.textContent = m.text;

    var v = Chem.parseNumber(val.value);
    if (isNaN(v)) { show('Enter a number', true); chart.textContent = ''; return; }

    var TK, Pa;
    if (mode.value === 'P') {
      TK = Chem.convert('temperature', v, unit.value, 'K');
      if (!(TK > 0)) { show('Temperature must be above absolute zero', true); return; }
      if (!m.valid(TK)) { show('T + C ≤ 0: outside the equation\'s domain', true); return; }
      Pa = m.P(TK);
    } else {
      Pa = Chem.convert('pressure', v, unit.value, 'Pa');
      if (!(Pa > 0)) { show('Pressure must be positive', true); return; }
      TK = m.T(Pa);
      if (!(TK > 0) || !isFinite(TK) || !m.valid(TK)) { show('No valid temperature for this pressure with these constants', true); return; }
    }
    if (!isFinite(Pa)) { show('Result is out of range for these constants', true); return; }

    resultBox.classList.remove('warn');
    if (mode.value === 'P') {
      result.textContent = '';
      result.appendChild(document.createTextNode(Chem.fmt(Chem.convert('pressure', Pa, 'Pa', 'kPa'), 5) + ' '));
      var s = document.createElement('small'); s.textContent = 'kPa'; result.appendChild(s);
      others.textContent = ['bar', 'atm', 'mmHg', 'psi', 'Pa'].map(function (u) {
        return Chem.fmt(Chem.convert('pressure', Pa, 'Pa', u), 5) + ' ' + u;
      }).join('   ·   ');
    } else {
      result.textContent = '';
      result.appendChild(document.createTextNode(Chem.fmt(Chem.convert('temperature', TK, 'K', '°C'), 5) + ' '));
      var s2 = document.createElement('small'); s2.textContent = '°C'; result.appendChild(s2);
      others.textContent = ['K', '°F'].map(function (u) {
        return Chem.fmt(Chem.convert('temperature', TK, 'K', u), 5) + ' ' + u;
      }).join('   ·   ');
    }

    if (m.range && (TK < m.range[0] || TK > m.range[1])) {
      warning.textContent = 'Outside the stated range of these constants (' + Chem.fmt(m.range[0] - 273.15, 4) + ' to ' +
        Chem.fmt(m.range[1] - 273.15, 4) + ' °C). Treat this as an extrapolation.';
      warning.classList.remove('hidden');
    }
    drawChart(m, TK, Pa);
  }

  function drawChart(m, TK, Pa) {
    var lo, hi;
    if (m.range) { lo = m.range[0]; hi = m.range[1]; }
    else { lo = Math.max(1, TK - 40); hi = TK + 40; }
    if (TK < lo) lo = TK - 5;
    if (TK > hi) hi = TK + 5;
    var pts = [], N = 80;
    for (var i = 0; i <= N; i++) {
      var T = lo + (hi - lo) * i / N;
      if (!m.valid(T)) continue;
      var P = m.P(T);
      if (isFinite(P) && P > 0) pts.push([T - 273.15, P / 1000]);
    }
    SimpleChart.lineChart(chart, {
      points: pts,
      marker: [TK - 273.15, Pa / 1000],
      xLabel: 'Temperature (°C)',
      yLabel: 'Vapour pressure (kPa)',
      logY: logY.checked,
      xFmt: function (v) { return Chem.fmt(v, 4); },
      yFmt: function (v) { return Chem.fmt(v, 3); }
    });
  }

  mode.addEventListener('change', function () {
    fillUnits();
    val.value = mode.value === 'P' ? '25' : '101.325';
    update();
  });
  [compound, cA, cB, cC, cForm, cPU, cTU, val, unit, logY].forEach(function (el) {
    el.addEventListener('input', update);
    el.addEventListener('change', update);
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(update, 120);   // redraw the chart at the new width
  });

  fillUnits();
  update();
})();
