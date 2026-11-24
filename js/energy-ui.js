/* Page for energy.html. Forms and display only: every number comes from Energy (and Chem for units). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (x, n) { return Chem.fmt(x, n || 5); };
  var num = function (id) { return Chem.parseNumber($(id).value); };
  var blank = function (id) { return $(id).value.trim() === ''; };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function clear(node) { node.textContent = ''; }
  function show(node, msg) { node.textContent = msg || ''; node.classList.toggle('hidden', !msg); }
  function opt(sel, value, label) { var o = new Option(label, value); sel.add(o); return o; }
  var uid = 0;
  function nextId(p) { uid += 1; return p + uid; }

  /* ───────────────────────── units ───────────────────────── */

  var U = { temp: '°C', flow: 'mol/s', press: 'kPa', energy: 'kJ/mol', power: 'kW' };
  var FLOW_UNITS = ['mol/s', 'mol/min', 'mol/h', 'kmol/s', 'kmol/min', 'kmol/h', 'lbmol/h'];
  var ENERGY_UNITS = ['kJ/mol', 'J/mol', 'kcal/mol', 'kJ/kmol', 'BTU/lbmol'];
  var PRESS_UNITS = ['kPa', 'Pa', 'bar', 'atm', 'mmHg', 'psi', 'MPa'];

  function flowParts(u) { var p = u.split('/'); return { amount: p[0], time: p[1] }; }
  function flowToMolS(v, u) { var p = flowParts(u || U.flow); return v * Chem.convert('amount', 1, p.amount, 'mol') / Chem.convert('time', 1, p.time, 's'); }
  function amountToMol(v) { return v * Chem.convert('amount', 1, flowParts(U.flow).amount, 'mol'); }
  function tempToK(v) { return Chem.convert('temperature', v, U.temp, 'K'); }
  function kToTemp(K) { return Chem.convert('temperature', K, 'K', U.temp); }
  function pressToKPa(v) { return Chem.convert('pressure', v, U.press, 'kPa'); }
  function powerToKW(v) { return Chem.convert('power', v, U.power, 'kW'); }
  function kWToPower(v) { return Chem.convert('power', v, 'kW', U.power); }
  function energyParts(u) { var p = u.split('/'); return { energy: p[0], amount: p[1] }; }
  function eShow(kJperMol) {                       // kJ/mol → chosen energy per amount
    var p = energyParts(U.energy);
    return kJperMol * Chem.convert('energy', 1, 'kJ', p.energy) / Chem.convert('amount', 1, 'mol', p.amount);
  }
  function energyOnly(kJ) { return kJ * Chem.convert('energy', 1, 'kJ', energyParts(U.energy).energy); }
  function tDisp(K) { return fmt(kToTemp(K), 6) + ' ' + U.temp; }

  function refreshUnitLabels() {
    [['tu', U.temp], ['fu', U.flow], ['pu', U.press], ['wu', U.power], ['au', flowParts(U.flow).amount]].forEach(function (p) {
      Array.prototype.forEach.call(document.querySelectorAll('.' + p[0]), function (n) { n.textContent = p[1]; });
    });
  }
  function convertFields(cls, fn) {
    Array.prototype.forEach.call(document.querySelectorAll('.' + cls), function (inp) {
      var x = Chem.parseNumber(inp.value);
      if (!isNaN(x)) inp.value = fmt(fn(x), 8);
    });
  }

  var unitSel = { temp: $('u-temp'), flow: $('u-flow'), press: $('u-press'), energy: $('u-energy'), power: $('u-power') };
  Object.keys(Chem.CATEGORIES.temperature.units).forEach(function (u) { opt(unitSel.temp, u, u); });
  FLOW_UNITS.forEach(function (u) { opt(unitSel.flow, u, u); });
  PRESS_UNITS.forEach(function (u) { opt(unitSel.press, u, u); });
  ENERGY_UNITS.forEach(function (u) { opt(unitSel.energy, u, u); });
  Object.keys(Chem.CATEGORIES.power.units).forEach(function (u) { opt(unitSel.power, u, u); });
  Object.keys(unitSel).forEach(function (k) { unitSel[k].value = U[k]; });

  unitSel.temp.addEventListener('change', function () {
    var old = U.temp; U.temp = unitSel.temp.value;
    convertFields('tin', function (x) { return Chem.convert('temperature', x, old, U.temp); });
    refreshUnitLabels(); recomputeAll();
  });
  unitSel.flow.addEventListener('change', function () {
    var old = U.flow; U.flow = unitSel.flow.value;
    convertFields('fin', function (x) { return flowToMolS(x, old) / flowToMolS(1, U.flow); });
    convertFields('ain', function (x) { return x * Chem.convert('amount', 1, flowParts(old).amount, 'mol') / Chem.convert('amount', 1, flowParts(U.flow).amount, 'mol'); });
    refreshUnitLabels(); recomputeAll();
  });
  unitSel.press.addEventListener('change', function () {
    var old = U.press; U.press = unitSel.press.value;
    convertFields('pin', function (x) { return Chem.convert('pressure', x, old, U.press); });
    refreshUnitLabels(); recomputeAll();
  });
  unitSel.energy.addEventListener('change', function () { U.energy = unitSel.energy.value; recomputeAll(); });
  unitSel.power.addEventListener('change', function () {
    var old = U.power; U.power = unitSel.power.value;
    convertFields('qin', function (x) { return Chem.convert('power', x, old, U.power); });
    refreshUnitLabels(); recomputeAll();
  });

  /* ───────────────────────── the data (built in + the user's changes) ───────────────────────── */

  var STORE = 'chemeng-energy-data-v1';
  var edits = {};          // id → partial species record
  var DB = Energy.SPECIES;

  function loadEdits() {
    try {
      var raw = window.localStorage.getItem(STORE);
      if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) edits = o; }
    } catch (e) { edits = {}; }
  }
  function saveEdits() { try { window.localStorage.setItem(STORE, JSON.stringify(edits)); } catch (e) { /* private window: keep it in memory */ } }
  function rebuildDB() { DB = Energy.extendDatabase(Energy.SPECIES, Object.keys(edits).map(function (k) { return edits[k]; })); }
  function nEdits() {
    var n = 0;
    Object.keys(edits).forEach(function (id) {
      var e = edits[id];
      Object.keys(e).forEach(function (k) {
        if (k === 'id') return;
        if (k === 'Cp' || k === 'Hf' || k === 'Hc') n += Object.keys(e[k]).length; else n += 1;
      });
    });
    return n;
  }
  function editOf(id) { if (!edits[id]) edits[id] = { id: id }; return edits[id]; }
  function dataChanged() { saveEdits(); rebuildDB(); refreshSpecies(); renderData(); recomputeAll(); }

  /* ───────────────────────── small display helpers ───────────────────────── */

  function resultBox(big, unit, rows, sub) {
    var box = el('div', 'result');
    var b = el('div', 'big', big + ' ');
    if (unit) b.appendChild(el('small', null, unit));
    box.appendChild(b);
    if (sub) box.appendChild(el('div', 'muted', sub));
    if (rows && rows.length) {
      var t = el('table'), tb = el('tbody');
      rows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', null, r[0]));
        tr.appendChild(el('td', 'num', r[1]));
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      var wrap = el('div', 'table-wrap'); wrap.appendChild(t); wrap.style.marginTop = '12px';
      box.appendChild(wrap);
    }
    return box;
  }

  function tableOf(headers, rows) {
    var wrap = el('div', 'table-wrap'), t = el('table'), th = el('thead'), tr = el('tr');
    headers.forEach(function (h, i) { var c = el('th', i > 0 ? 'num' : null, h); if (i > 0) c.style.textAlign = 'right'; tr.appendChild(c); });
    th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var row = el('tr');
      r.forEach(function (c, i) { row.appendChild(el('td', i > 0 ? 'num' : null, c)); });
      tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }

  function warnList(container, warnings, notes) {
    var list = (warnings || []).map(function (w) { return [w, false]; }).concat((notes || []).map(function (n) { return [n, true]; }));
    if (nEdits() > 0) list.push(['Your own data is in use (' + nEdits() + ' change' + (nEdits() === 1 ? '' : 's') + ' on the Data tab), not only the built-in values.', true]);
    if (!list.length) return;
    var ul = el('ul', 'warn-list');
    list.forEach(function (w) { ul.appendChild(el('li', w[1] ? 'note-list' : null, w[0])); });
    container.appendChild(ul);
  }

  function renderSteps(container, steps) {
    if (!steps || !steps.length) return;
    container.appendChild(el('h3', null, 'Solution, step by step'));
    container.appendChild(el('p', 'steps-note', 'The working is in °C, kJ/mol, mol/s and kW. Each step shows the equation, then the numbers put into it.'));
    var ol = el('ol', 'steps');
    steps.forEach(function (s) {
      var li = el('li');
      li.appendChild(el('span', 'title', s.title));
      s.equations.forEach(function (q) {
        if (q.label) li.appendChild(el('div', 'eqlabel', q.label));
        if (q.equation) li.appendChild(el('div', 'eq', q.equation));
        if (q.substituted && q.substituted !== q.equation) li.appendChild(el('div', 'eq sub', '→ ' + q.substituted));
      });
      if (s.results.length) {
        li.appendChild(el('div', 'eq result', s.results.map(function (r) { return r.name + ' = ' + fmt(r.value, 6) + (r.unit ? ' ' + r.unit : ''); }).join(',  ')));
      }
      ol.appendChild(li);
    });
    container.appendChild(ol);
  }

  var PHASE_WORD = { g: 'gas', l: 'liquid', s: 'solid' };
  function speciesLabel(id) { var sp = DB[id]; return sp ? sp.name + ' (' + sp.id + ')' : id; }

  /* ───────────────────────── species lists and stream cards ───────────────────────── */

  var speciesSelects = [];     // { sel, filter } so every list can be refreshed when the data changes
  function speciesFilter(kind) {
    return function (sp) {
      if (kind === 'latent') return sp.Hvap !== null || sp.Hfus !== null;
      if (kind === 'fuel') {
        if (Object.keys(sp.Hf).length === 0) return false;
        try { Energy.combustionReaction(sp.id, DB); return true; } catch (e) { return false; }   // burns completely to CO2, H2O, N2, SO2
      }
      return true;
    };
  }
  function fillSpecies(sel, filter) {
    var keep = sel.value;
    clear(sel);
    Object.keys(DB).forEach(function (id) { if (!filter || filter(DB[id])) opt(sel, id, speciesLabel(id)); });
    if (keep && DB[keep]) sel.value = keep;
  }
  function registerSpecies(sel, kind) {
    var f = speciesFilter(kind);
    speciesSelects.push({ sel: sel, filter: f });
    fillSpecies(sel, f);
  }
  function refreshSpecies() {
    speciesSelects = speciesSelects.filter(function (x) { return document.body.contains(x.sel); });
    speciesSelects.forEach(function (x) { fillSpecies(x.sel, x.filter); });
    var dl = $('a-sp-list'); clear(dl);
    Object.keys(DB).forEach(function (id) { var o = el('option'); o.value = id; o.textContent = DB[id].name; dl.appendChild(o); });
    fillConvSpecies();
    fillFuelPhases();
  }

  function phaseSelect(sel, withAuto, autoLabel) {
    if (withAuto) opt(sel, 'auto', autoLabel || 'Automatic');
    opt(sel, 'g', 'Gas'); opt(sel, 'l', 'Liquid'); opt(sel, 's', 'Solid');
  }

  /* A list of species rows: species, amount, optional phase and temperature. */
  function SpeciesList(container, cfg) {
    var rows = [];
    function add(init) {
      init = init || {};
      var r = el('div', 'srow');
      var id = nextId('sp');
      var f1 = el('div', 'field f-sp'), l1 = el('label', null, 'Species'); l1.htmlFor = id + 's';
      var sel = el('select'); sel.id = id + 's'; registerSpecies(sel);
      if (init.id && DB[init.id]) sel.value = init.id;
      f1.appendChild(l1); f1.appendChild(sel); r.appendChild(f1);
      var amt = null, ph = null, T = null;
      if (cfg.amountLabel) {
        var f2 = el('div', 'field f-amt'), l2 = el('label', null, cfg.amountLabel); l2.htmlFor = id + 'a';
        amt = el('input'); amt.type = 'text'; amt.id = id + 'a'; amt.value = init.n === undefined ? '' : String(init.n);
        amt.setAttribute('inputmode', 'decimal'); amt.autocomplete = 'off';
        if (cfg.amountClass) amt.className = cfg.amountClass;
        f2.appendChild(l2); f2.appendChild(amt); r.appendChild(f2);
      }
      if (cfg.withPhase) {
        var f3 = el('div', 'field f-ph'), l3 = el('label', null, 'Phase'); l3.htmlFor = id + 'p';
        ph = el('select'); ph.id = id + 'p'; phaseSelect(ph, true, 'Automatic'); ph.value = init.phase || 'auto';
        f3.appendChild(l3); f3.appendChild(ph); r.appendChild(f3);
      }
      if (cfg.withTemp) {
        var f4 = el('div', 'field f-T'), l4 = el('label', null, 'Temperature '); l4.htmlFor = id + 't';
        l4.appendChild(el('span', 'tu', U.temp));
        T = el('input'); T.type = 'text'; T.id = id + 't'; T.className = 'tin'; T.setAttribute('inputmode', 'decimal'); T.autocomplete = 'off';
        T.value = init.T === undefined ? '' : String(init.T);
        f4.appendChild(l4); f4.appendChild(T); r.appendChild(f4);
      }
      var rm = el('button', 'secondary remove', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', function () {
        if (rows.length <= 1) return;
        container.removeChild(r);
        rows = rows.filter(function (x) { return x.node !== r; });
        syncRemove();
        cfg.onChange();
      });
      r.appendChild(rm);
      [sel, amt, ph, T].forEach(function (c) { if (c) { c.addEventListener('input', cfg.onChange); c.addEventListener('change', cfg.onChange); } });
      container.appendChild(r);
      rows.push({ node: r, sel: sel, amt: amt, ph: ph, T: T, rm: rm });
      syncRemove();
      refreshUnitLabels();
      return rows[rows.length - 1];
    }
    function syncRemove() { rows.forEach(function (x) { x.rm.disabled = rows.length <= 1; }); }
    function set(list) {
      clear(container); rows = [];
      list.forEach(add);
    }
    function values() {
      return rows.map(function (r) {
        return {
          id: r.sel.value, nRaw: r.amt ? r.amt.value : '1', n: r.amt ? Chem.parseNumber(r.amt.value) : 1,
          phase: r.ph ? r.ph.value : 'auto', TRaw: r.T ? r.T.value : '', T: r.T ? Chem.parseNumber(r.T.value) : NaN
        };
      });
    }
    return { add: add, set: set, values: values };
  }

  /* An inlet or outlet stream of the steady-flow balance. */
  function StreamCard(container, kind, init, onChange, onRemove) {
    var id = nextId('st');
    var card = el('div', 'stream');
    var head = el('div', 'head');
    var fn = el('div', 'field f-name'), ln = el('label', null, 'Stream name'); ln.htmlFor = id + 'n';
    var name = el('input'); name.type = 'text'; name.id = id + 'n'; name.value = init.name || ''; name.autocomplete = 'off';
    fn.appendChild(ln); fn.appendChild(name); head.appendChild(fn);
    var ft = el('div', 'field'), lt = el('label', null, 'Temperature '); lt.htmlFor = id + 't'; lt.appendChild(el('span', 'tu', U.temp));
    var T = el('input'); T.type = 'text'; T.id = id + 't'; T.className = 'tin'; T.setAttribute('inputmode', 'decimal'); T.autocomplete = 'off'; T.value = init.T === undefined ? '' : String(init.T);
    ft.appendChild(lt); ft.appendChild(T); head.appendChild(ft);
    var rm = el('button', 'secondary remove', 'Remove stream'); rm.type = 'button'; head.appendChild(rm);
    card.appendChild(head);
    var list = el('div');
    card.appendChild(list);
    var sl = SpeciesList(list, { amountLabel: 'Flow (' + U.flow + ')', amountClass: 'fin', withPhase: true, onChange: onChange });
    // the flow label follows the unit
    sl.set((init.species || [{ id: Object.keys(DB)[0], n: 1 }]));
    var addb = el('button', 'secondary', '+ Add a species to this stream'); addb.type = 'button';
    addb.addEventListener('click', function () { sl.add({ n: 1 }); labelsFlow(); onChange(); });
    var p = el('p'); p.appendChild(addb); card.appendChild(p);
    var det = el('details'), sum = el('summary', null, 'Optional: pressure, velocity, height (for the phase and for kinetic and potential energy)');
    det.appendChild(sum);
    var drow = el('div', 'row');
    function small(label, cls, val, unitSpan) {
      var f = el('div', 'field'), l = el('label', null, label + ' '); var iid = nextId('sd'); l.htmlFor = iid;
      if (unitSpan) l.appendChild(el('span', unitSpan, ''));
      var i = el('input'); i.type = 'text'; i.id = iid; i.className = cls; i.setAttribute('inputmode', 'decimal'); i.autocomplete = 'off'; i.value = val === undefined ? '' : String(val);
      f.appendChild(l); f.appendChild(i); drow.appendChild(f); return i;
    }
    var P = small('Pressure', 'pin', init.P, 'pu');
    var u = small('Velocity (m/s)', '', init.u);
    var z = small('Height (m)', '', init.z);
    det.appendChild(drow); card.appendChild(det);
    if ((init.P !== undefined && init.P !== '') || init.u || init.z) det.open = true;
    [name, T, P, u, z].forEach(function (c) { c.addEventListener('input', onChange); });
    rm.addEventListener('click', function () { container.removeChild(card); onRemove(api); });
    function labelsFlow() { Array.prototype.forEach.call(card.querySelectorAll('.f-amt label'), function (l) { if (l.textContent.indexOf('Flow (') === 0) l.textContent = 'Flow (' + U.flow + ')'; }); }
    container.appendChild(card);
    refreshUnitLabels();
    var api = {
      node: card, labelsFlow: labelsFlow,
      values: function () {
        return {
          name: name.value.trim() || (kind === 'in' ? 'Inlet' : 'Outlet'), T: Chem.parseNumber(T.value), TRaw: T.value,
          P: P.value.trim() === '' ? undefined : Chem.parseNumber(P.value), u: u.value.trim() === '' ? 0 : Chem.parseNumber(u.value), z: z.value.trim() === '' ? 0 : Chem.parseNumber(z.value),
          species: sl.values()
        };
      }
    };
    return api;
  }

  /* ───────────────────────── tabs ───────────────────────── */

  var TABS = ['sensible', 'phase', 'reaction', 'reactor', 'open', 'data'];
  function selectTab(name, focus) {
    TABS.forEach(function (t) {
      var on = t === name;
      $('tab-' + t).setAttribute('aria-selected', on ? 'true' : 'false');
      $('tab-' + t).tabIndex = on ? 0 : -1;
      $('panel-' + t).classList.toggle('hidden', !on);
    });
    if (focus) $('tab-' + name).focus();
  }
  TABS.forEach(function (t, i) {
    $('tab-' + t).addEventListener('click', function () { selectTab(t); });
    $('tab-' + t).addEventListener('keydown', function (ev) {
      var j = null;
      if (ev.key === 'ArrowRight') j = (i + 1) % TABS.length;
      else if (ev.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length;
      else if (ev.key === 'Home') j = 0;
      else if (ev.key === 'End') j = TABS.length - 1;
      if (j !== null) { ev.preventDefault(); selectTab(TABS[j], true); }
    });
  });

  /* common number checks */
  function needTemp(id, what) {
    if (blank(id) || isNaN(num(id))) throw new Error('Enter a number for ' + what + '.');
    var K = tempToK(num(id));
    if (!(K > 0)) throw new Error(what.charAt(0).toUpperCase() + what.slice(1) + ' is below absolute zero.');
    return K;
  }
  function needNum(id, what) {
    if (blank(id) || isNaN(num(id))) throw new Error('Enter a number for ' + what + '.');
    return num(id);
  }
  function pressure(id) { return blank(id) || isNaN(num(id)) || !(num(id) > 0) ? Energy.P0 : pressToKPa(num(id)); }

  /* ───────────────────────── 1. sensible heat ───────────────────────── */

  var sList = SpeciesList($('s-species'), { amountLabel: 'Mole fraction or flow', onChange: calcSensible });
  sList.set([{ id: 'N2', n: 1 }]);
  $('s-add').addEventListener('click', function () { sList.add({ id: 'O2', n: 1 }); calcSensible(); });
  ['s-phase', 's-T1', 's-T2', 's-flow'].forEach(function (id) { $(id).addEventListener('input', calcSensible); $(id).addEventListener('change', calcSensible); });

  function calcSensible() {
    var out = $('s-out'), err = $('s-error');
    clear(out); show(err, '');
    try {
      var T1 = needTemp('s-T1', 'the starting temperature'), T2 = needTemp('s-T2', 'the final temperature');
      var list = sList.values();
      list.forEach(function (c) { if (isNaN(c.n)) throw new Error('Enter an amount for ' + c.id + ' (a mole fraction or a flow).'); });
      var flow = blank('s-flow') ? undefined : flowToMolS(needNum('s-flow', 'the flow'));
      var r = Energy.sensibleHeat({ species: list.map(function (c) { return { id: c.id, n: c.n }; }), T1: T1, T2: T2, phase: $('s-phase').value, flow: flow, db: DB });
      var rows = [];
      if (r.mixture) r.rows.forEach(function (x) { rows.push(['ΔH of ' + x.id + ' (y = ' + fmt(x.y, 4) + ')', fmt(eShow(x.dH), 5) + ' ' + U.energy]); });
      if (r.meanCp !== undefined) rows.push(['Mean Cp over the range', fmt(r.meanCp, 5) + ' J/(mol·K)']);
      if (r.dU !== undefined) rows.push(['ΔU (ideal gas, Cv = Cp − R)', fmt(eShow(r.dU), 5) + ' ' + U.energy]);
      if (r.Q !== undefined) rows.push(['Duty for the flow given, Q = ṅ ΔH', fmt(kWToPower(r.Q), 5) + ' ' + U.power]);
      out.appendChild(resultBox(fmt(eShow(r.dH), 5), U.energy, rows, 'ΔH from ' + tDisp(T1) + ' to ' + tDisp(T2) + (r.mixture ? ', per mole of mixture' : '')));
      warnList(out, r.warnings, r.notes);
      renderSteps(out, r.steps);
    } catch (e) { show(err, e.message); }
  }

  /* ───────────────────────── 2. phase change ───────────────────────── */

  registerSpecies($('p-species'));
  phaseSelect($('p-ph1'), true, 'Automatic (from the temperature)');
  phaseSelect($('p-ph2'), true, 'Automatic (from the temperature)');
  var PH_EXAMPLES = [
    { label: 'Liquid water at 25 °C to steam at 150 °C', sp: 'H2O', T1: 25, p1: 'l', T2: 150, p2: 'g' },
    { label: 'Ice at −10 °C to steam at 150 °C', sp: 'H2O', T1: -10, p1: 's', T2: 150, p2: 'g' },
    { label: 'Steam at 200 °C cooled to liquid water at 40 °C', sp: 'H2O', T1: 200, p1: 'g', T2: 40, p2: 'l' },
    { label: 'Benzene liquid at 20 °C to vapour at 120 °C', sp: 'C6H6', T1: 20, p1: 'l', T2: 120, p2: 'g' },
    { label: 'Ethanol liquid at 25 °C to vapour at 100 °C', sp: 'C2H5OH', T1: 25, p1: 'l', T2: 100, p2: 'g' },
    { label: 'Methanol liquid at 20 °C to vapour at 100 °C', sp: 'CH3OH', T1: 20, p1: 'l', T2: 100, p2: 'g' },
    { label: 'Toluene vapour at 150 °C cooled to liquid at 25 °C', sp: 'C7H8', T1: 150, p1: 'g', T2: 25, p2: 'l' }
  ];
  PH_EXAMPLES.forEach(function (x, i) { opt($('p-example'), String(i), x.label); });
  function loadPhExample(i) {
    var x = PH_EXAMPLES[i];
    $('p-species').value = x.sp;
    $('p-T1').value = fmt(Chem.convert('temperature', x.T1, '°C', U.temp), 8);
    $('p-T2').value = fmt(Chem.convert('temperature', x.T2, '°C', U.temp), 8);
    $('p-ph1').value = x.p1; $('p-ph2').value = x.p2;
    calcPhase();
  }
  $('p-example').addEventListener('change', function () { loadPhExample(Number($('p-example').value)); });
  ['p-species', 'p-T1', 'p-T2', 'p-ph1', 'p-ph2', 'p-P', 'p-flow'].forEach(function (id) { $(id).addEventListener('input', calcPhase); $(id).addEventListener('change', calcPhase); });

  function calcPhase() {
    var out = $('p-out'), err = $('p-error');
    clear(out); show(err, '');
    try {
      var T1 = needTemp('p-T1', 'the initial temperature'), T2 = needTemp('p-T2', 'the final temperature');
      var flow = blank('p-flow') ? undefined : flowToMolS(needNum('p-flow', 'the flow'));
      var P = pressure('p-P');
      var r = Energy.phaseChange({ id: $('p-species').value, from: { T: T1, phase: $('p-ph1').value }, to: { T: T2, phase: $('p-ph2').value }, P: P, flow: flow, db: DB });
      var rows = r.pieces.map(function (p, i) { return ['Step ' + (i + 1) + ': ' + p.title, fmt(eShow(p.value), 5) + ' ' + U.energy]; });
      if (r.Q !== undefined) rows.push(['Duty for the flow given, Q = ṅ ΔH', fmt(kWToPower(r.Q), 5) + ' ' + U.power]);
      out.appendChild(resultBox(fmt(eShow(r.dH), 5), U.energy, rows,
        'ΔH from ' + PHASE_WORD[r.from.phase] + ' at ' + tDisp(T1) + ' to ' + PHASE_WORD[r.to.phase] + ' at ' + tDisp(T2) + ' (' + speciesLabel($('p-species').value) + ')'));
      warnList(out, r.warnings, r.notes);
      renderSteps(out, r.steps);
    } catch (e) { show(err, e.message); }
  }

  registerSpecies($('l-species'), 'latent');
  $('l-species').value = 'H2O';
  ['l-species', 'l-kind', 'l-T'].forEach(function (id) { $(id).addEventListener('input', calcLatent); $(id).addEventListener('change', calcLatent); });
  function calcLatent() {
    var out = $('l-out'), err = $('l-error');
    clear(out); show(err, '');
    try {
      var kind = $('l-kind').value;
      var T = kind === 'vap' ? needTemp('l-T', 'the temperature') : undefined;
      var r = Energy.latentHeat({ id: $('l-species').value, kind: kind, T: T, P: pressure('p-P'), db: DB });
      out.appendChild(resultBox(fmt(eShow(r.value), 5), U.energy, [], (kind === 'vap' ? 'ΔHvap at ' + tDisp(T) : 'ΔHfus at ' + tDisp(r.T))));
      warnList(out, r.warnings, r.notes);
      renderSteps(out, r.steps);
    } catch (e) { show(err, e.message); }
  }

  /* ───────────────────────── 3. reactions ───────────────────────── */

  var RX_EXAMPLES = [
    { label: 'Methane burnt in oxygen (liquid water)', text: 'CH4 + 2 O2 -> CO2 + 2 H2O' },
    { label: 'Methane burnt in oxygen (water vapour)', text: 'CH4 + 2 O2 -> CO2 + 2 H2O(g)' },
    { label: 'Carbon monoxide oxidation, at 500 °C', text: 'CO + 0.5 O2 -> CO2', T: 500 },
    { label: 'Ammonia synthesis, at 400 °C', text: 'N2 + 3 H2 -> 2 NH3', T: 400 },
    { label: 'Ethanol burnt (liquid ethanol)', text: 'C2H5OH + 3 O2 -> 2 CO2 + 3 H2O' },
    { label: 'Ethylene hydrogenation', text: 'C2H4 + H2 -> C2H6' },
    { label: 'Hydrogen burnt, steam at 150 °C', text: 'H2 + 0.5 O2 -> H2O', T: 150 }
  ];
  RX_EXAMPLES.forEach(function (x, i) { opt($('r-example'), String(i), x.label); });
  $('r-example').addEventListener('change', function () {
    var x = RX_EXAMPLES[Number($('r-example').value)];
    $('r-text').value = x.text;
    $('r-T').value = x.T === undefined ? '' : fmt(Chem.convert('temperature', x.T, '°C', U.temp), 8);
    calcReaction();
  });
  ['r-text', 'r-T', 'r-P', 'r-extent', 'r-keep'].forEach(function (id) { $(id).addEventListener('input', calcReaction); $(id).addEventListener('change', calcReaction); });

  function calcReaction() {
    var out = $('r-out'), err = $('r-error');
    clear(out); show(err, '');
    try {
      var opts = { reaction: $('r-text').value, P: pressure('r-P'), keepPhase: $('r-keep').checked, db: DB };
      if (!blank('r-T')) opts.T = needTemp('r-T', 'the reaction temperature');
      if (!blank('r-extent')) opts.extent = amountToMol(needNum('r-extent', 'the extent of reaction'));
      var r = Energy.heatOfReaction(opts);
      var eo = energyParts(U.energy).energy;
      var showE = function (kJ) { return fmt(energyOnly(kJ), 5) + ' ' + eo; };
      var rows = [['Reaction as read', r.reaction.text], ['Type at 25 °C', r.type]];
      rows.push(['ΔH°rxn at 25 °C', showE(r.dH25) + ' per mole of reaction']);
      if (opts.T !== undefined && Math.abs(opts.T - Energy.T0) > 1e-9) rows.push(['ΔHrxn at ' + tDisp(opts.T), showE(r.dH) + ' per mole of reaction']);
      if (r.Q !== undefined) rows.push(['Heat for ξ = ' + fmt(opts.extent, 5) + ' mol', showE(r.Q) + ' (negative = released)']);
      out.appendChild(resultBox(fmt(energyOnly(r.dH), 6), eo + ' per mole of reaction as written', rows,
        opts.T !== undefined && Math.abs(opts.T - Energy.T0) > 1e-9 ? 'Heat of reaction at ' + tDisp(opts.T) : 'Standard heat of reaction at 25 °C'));
      warnList(out, r.warnings, r.notes);
      renderSteps(out, r.steps);
    } catch (e) { show(err, e.message); }
  }

  registerSpecies($('c-species'), 'fuel');
  $('c-species').value = 'CH4';
  function fillFuelPhases(reset) {
    var sp = DB[$('c-species').value], sel = $('c-phase'), keep = reset ? '' : sel.value;
    clear(sel);
    if (!sp) return;
    ['g', 'l', 's'].forEach(function (p) { if (sp.Hf && sp.Hf[p] !== undefined && sp.Hf[p] !== null) opt(sel, p, PHASE_WORD[p].charAt(0).toUpperCase() + PHASE_WORD[p].slice(1)); });
    if (Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) sel.value = keep; else if (sp.std && Array.prototype.some.call(sel.options, function (o) { return o.value === sp.std; })) sel.value = sp.std;
  }
  $('c-species').addEventListener('change', function () { fillFuelPhases(true); calcCombustion(); });
  $('c-phase').addEventListener('change', calcCombustion);
  function calcCombustion() {
    var out = $('c-out'), err = $('c-error');
    clear(out); show(err, '');
    try {
      var r = Energy.combustion({ id: $('c-species').value, phase: $('c-phase').value || undefined, db: DB });
      var rows = [['Reaction, water liquid (HHV)', r.reactionHHV], ['Reaction, water vapour (LHV)', r.reactionLHV],
        ['Lower heating value, LHV', fmt(eShow(r.lhv), 5) + ' ' + U.energy], ['O₂ needed', fmt(r.o2, 5) + ' mol per mol of fuel']];
      if (r.hhvMass !== undefined) rows.push(['HHV / LHV per kg of fuel', fmt(r.hhvMass, 4) + ' / ' + fmt(r.lhvMass, 4) + ' MJ/kg']);
      if (r.tabulated !== null) rows.push(['HHV from the tabulated heat of combustion (Felder Table B.1)', fmt(eShow(r.tabulated), 5) + ' ' + U.energy]);
      out.appendChild(resultBox(fmt(eShow(r.hhv), 6), U.energy, rows, 'Higher heating value of ' + r.name.toLowerCase() + ' (' + PHASE_WORD[r.fuelPhase] + ')'));
      warnList(out, r.warnings, r.notes);
      renderSteps(out, r.steps);
    } catch (e) { show(err, e.message); }
  }

  /* ───────────────────────── 4. reactor and flame temperature ───────────────────────── */

  registerSpecies($('f-fuel'), 'fuel');
  $('f-fuel').value = 'CH4';
  var gList = SpeciesList($('g-feeds'), { amountLabel: 'Flow (mol/s)', amountClass: 'fin', withPhase: true, withTemp: true, onChange: calcReactor });
  var G_EXAMPLE = [{ id: 'CO', n: 1, T: 25 }, { id: 'O2', n: 1, T: 25 }, { id: 'N2', n: 3.76, T: 25 }];
  gList.set(G_EXAMPLE);
  $('g-rx').value = 'CO + 0.5 O2 -> CO2';
  $('g-add').addEventListener('click', function () { gList.add({ n: 1, T: fmt(kToTemp(Energy.T0), 8) }); relabelFlows(); calcReactor(); });
  function relabelFlows() {
    Array.prototype.forEach.call(document.querySelectorAll('.f-amt label'), function (l) { if (l.textContent.indexOf('Flow (') === 0) l.textContent = 'Flow (' + U.flow + ')'; });
  }
  unitSel.flow.addEventListener('change', relabelFlows);

  function fillConvSpecies() {
    var sel = $('g-conv-sp'), keep = sel.value;
    clear(sel);
    try {
      var rx = Energy.parseEquation($('g-rx').value, DB);
      rx.terms.filter(function (t) { return t.nu < 0; }).forEach(function (t) { opt(sel, t.id, speciesLabel(t.id)); });
    } catch (e) { /* no reaction yet */ }
    if (keep && Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) sel.value = keep;
  }
  function syncMode() {
    var flame = $('x-mode').value === 'flame';
    $('x-flame').classList.toggle('hidden', !flame);
    $('x-general').classList.toggle('hidden', flame);
    var conv = $('g-how').value === 'conv';
    $('g-conv-box').classList.toggle('hidden', !conv);
    $('g-conv-val-box').classList.toggle('hidden', !conv);
    $('g-ext-box').classList.toggle('hidden', conv);
  }
  $('x-mode').addEventListener('change', function () { syncMode(); calcReactor(); });
  $('g-how').addEventListener('change', function () { syncMode(); calcReactor(); });
  $('g-rx').addEventListener('input', function () { fillConvSpecies(); calcReactor(); });
  ['f-fuel', 'f-excess', 'f-conv', 'f-Tfuel', 'f-Tair', 'f-water', 'g-conv-sp', 'g-conv', 'g-ext', 'g-Q', 'x-P'].forEach(function (id) {
    $(id).addEventListener('input', calcReactor); $(id).addEventListener('change', calcReactor);
  });

  function calcReactor() {
    var out = $('x-out'), err = $('x-error');
    clear(out); show(err, '');
    try {
      var P = pressure('x-P'), r, basisNote;
      if ($('x-mode').value === 'flame') {
        var ex = needNum('f-excess', 'the excess air') / 100, cv = needNum('f-conv', 'the fuel conversion') / 100;
        r = Energy.flameTemperature({ fuel: $('f-fuel').value, excess: ex, conversion: cv, Tfuel: needTemp('f-Tfuel', 'the fuel temperature'), Tair: needTemp('f-Tair', 'the air temperature'),
          waterPhase: $('f-water').value, P: P, db: DB });
        basisNote = 'Basis: 1 mol/s of fuel, ' + fmt(r.air, 5) + ' mol/s of air (' + fmt(ex * 100, 4) + ' % excess).';
      } else {
        var text = $('g-rx').value.trim(), reactions = [];
        if (text) {
          var rx = { text: text };
          if ($('g-how').value === 'conv') {
            if (!$('g-conv-sp').value) throw new Error('Write the reaction first so a reactant can be chosen.');
            rx.conversion = { id: $('g-conv-sp').value, x: needNum('g-conv', 'the conversion') / 100 };
          } else rx.extent = flowToMolS(needNum('g-ext', 'the extent of reaction'));
          reactions.push(rx);
        }
        var feeds = gList.values().map(function (f) {
          if (isNaN(f.n)) throw new Error('Enter a flow for ' + f.id + ' in the feed.');
          if (f.TRaw.trim() === '' || isNaN(f.T)) throw new Error('Enter the temperature of ' + f.id + ' in the feed.');
          return { id: f.id, n: flowToMolS(f.n), T: tempToK(f.T), phase: f.phase };
        });
        r = Energy.adiabatic({ reactions: reactions, feeds: feeds, Q: powerToKW(needNum('g-Q', 'the heat duty Q')), P: P, db: DB });
        basisNote = 'Flows are converted to mol/s in the working.';
      }
      var rows = [['Outlet temperature', fmt(r.T, 6) + ' K  =  ' + fmt(r.TC, 6) + ' °C'], ['Ḣin (feed)', fmt(kWToPower(r.Hin), 6) + ' ' + U.power], ['Ḣout at that temperature', fmt(kWToPower(r.Hout), 6) + ' ' + U.power],
        ['Heat added Q', fmt(kWToPower(r.Q), 6) + ' ' + U.power], ['Balance residual', fmt(r.residual, 3) + ' kW']];
      var box = resultBox(fmt(kToTemp(r.T), 6), U.temp, rows, 'Outlet temperature. ' + basisNote);
      if (r.twoPhase) box.appendChild(el('div', 'two', fmt(r.twoPhase.vapour * 100, 4) + ' % of the ' + r.twoPhase.id + ' leaves as vapour: the stream is at its boiling point, mixed vapour and liquid.'));
      out.appendChild(box);
      out.appendChild(el('h3', null, 'Leaving stream at ' + tDisp(r.T)));
      out.appendChild(tableOf(['Species', 'Flow (mol/s)', 'Phase', 'ĥ (kJ/mol)'], r.outlet.map(function (o) { return [o.id, fmt(o.n, 5), PHASE_WORD[o.phase], fmt(o.h, 5)]; })));
      warnList(out, r.warnings, r.notes);
      renderSteps(out, r.steps);
    } catch (e) { show(err, e.message); }
  }

  /* ───────────────────────── 5. steady-flow balance ───────────────────────── */

  var inCards = [], outCards = [];
  function addStream(kind, init) {
    var list = kind === 'in' ? inCards : outCards, box = kind === 'in' ? $('o-in') : $('o-out-streams');
    var card = StreamCard(box, kind, init, calcOpen, function (api) {
      var arr = kind === 'in' ? inCards : outCards;
      arr.splice(arr.indexOf(api), 1);
      calcOpen();
    });
    list.push(card);
    return card;
  }
  function resetStreams(ins, outs) {
    clear($('o-in')); clear($('o-out-streams')); inCards = []; outCards = [];
    ins.forEach(function (s) { addStream('in', s); });
    outs.forEach(function (s) { addStream('out', s); });
  }
  $('o-add-in').addEventListener('click', function () { addStream('in', { name: 'Inlet ' + (inCards.length + 1), T: fmt(kToTemp(Energy.T0), 8), species: [{ id: 'N2', n: 1 }] }); calcOpen(); });
  $('o-add-out').addEventListener('click', function () { addStream('out', { name: 'Outlet ' + (outCards.length + 1), T: fmt(kToTemp(Energy.T0), 8), species: [{ id: 'N2', n: 1 }] }); calcOpen(); });
  ['o-Ws', 'o-P'].forEach(function (id) { $(id).addEventListener('input', calcOpen); });

  var C = function (t) { return fmt(Chem.convert('temperature', t, '°C', U.temp), 8); };
  var OPEN_EXAMPLES = [
    { label: 'Heating air: 10 mol/s from 25 °C to 200 °C', ins: [{ name: 'Cold air', T: 25, species: [{ id: 'N2', n: 7.9, phase: 'g' }, { id: 'O2', n: 2.1, phase: 'g' }] }], outs: [{ name: 'Hot air', T: 200, species: [{ id: 'N2', n: 7.9, phase: 'g' }, { id: 'O2', n: 2.1, phase: 'g' }] }], Ws: 0 },
    { label: 'Boiler: 1 mol/s liquid water at 25 °C to steam at 150 °C', ins: [{ name: 'Feed water', T: 25, species: [{ id: 'H2O', n: 1, phase: 'l' }] }], outs: [{ name: 'Steam', T: 150, species: [{ id: 'H2O', n: 1, phase: 'g' }] }], Ws: 0 },
    { label: 'Mixing hot and cold water (adiabatic: Q should come out zero)', ins: [{ name: 'Hot', T: 80, species: [{ id: 'H2O', n: 1, phase: 'l' }] }, { name: 'Cold', T: 20, species: [{ id: 'H2O', n: 1, phase: 'l' }] }], outs: [{ name: 'Mixed', T: 50, species: [{ id: 'H2O', n: 2, phase: 'l' }] }], Ws: 0 },
    { label: 'Methane burner, products cooled to 25 °C (water liquid)', ins: [{ name: 'Feed', T: 25, species: [{ id: 'CH4', n: 1 }, { id: 'O2', n: 2 }] }], outs: [{ name: 'Products', T: 25, species: [{ id: 'CO2', n: 1 }, { id: 'H2O', n: 2 }] }], Ws: 0 },
    { label: 'Compressor with shaft work: air in at 25 °C, out at 150 °C, Ws = −2 kW', ins: [{ name: 'Air in', T: 25, species: [{ id: 'air', n: 0.1, phase: 'g' }], u: 5 }], outs: [{ name: 'Air out', T: 150, species: [{ id: 'air', n: 0.1, phase: 'g' }], u: 5 }], Ws: -2 }
  ];
  OPEN_EXAMPLES.forEach(function (x, i) { opt($('o-example'), String(i), x.label); });
  function loadOpenExample(i) {
    var x = OPEN_EXAMPLES[i];
    var conv = function (s) { return { name: s.name, T: C(s.T), species: s.species, u: s.u, z: s.z }; };
    resetStreams(x.ins.map(conv), x.outs.map(conv));
    $('o-Ws').value = fmt(kWToPower(x.Ws), 8);
    calcOpen();
  }
  $('o-example').addEventListener('change', function () { loadOpenExample(Number($('o-example').value)); });

  function streamInput(card, kind) {
    var s = card.values();
    if (s.TRaw.trim() === '' || isNaN(s.T)) throw new Error('Enter the temperature of the ' + kind + ' stream "' + s.name + '".');
    return {
      name: s.name, T: tempToK(s.T), P: s.P === undefined ? undefined : (isNaN(s.P) ? undefined : pressToKPa(s.P)), u: isNaN(s.u) ? 0 : s.u, z: isNaN(s.z) ? 0 : s.z,
      species: s.species.map(function (c) {
        if (isNaN(c.n)) throw new Error('Enter a flow for ' + c.id + ' in the ' + kind + ' stream "' + s.name + '".');
        return { id: c.id, n: flowToMolS(c.n), phase: c.phase };
      })
    };
  }

  function calcOpen() {
    var out = $('o-result'), err = $('o-error');
    clear(out); show(err, '');
    try {
      if (!inCards.length || !outCards.length) throw new Error('Add at least one inlet stream and one outlet stream.');
      var r = Energy.openSystem({
        inlets: inCards.map(function (c) { return streamInput(c, 'inlet'); }), outlets: outCards.map(function (c) { return streamInput(c, 'outlet'); }),
        Ws: powerToKW(needNum('o-Ws', 'the shaft work (0 if none)')), P: pressure('o-P'), db: DB
      });
      var rows = [['Reference state', r.formation ? 'elements at 25 °C (heats of formation included)' : 'each species at 25 °C, 1 atm, standard phase'],
        ['Σ Ḣ in', fmt(kWToPower(r.Hin), 6) + ' ' + U.power], ['Σ Ḣ out', fmt(kWToPower(r.Hout), 6) + ' ' + U.power], ['ΔḢ', fmt(kWToPower(r.dH), 6) + ' ' + U.power],
        ['ΔĖk', fmt(kWToPower(r.dKE), 5) + ' ' + U.power], ['ΔĖp', fmt(kWToPower(r.dPE), 5) + ' ' + U.power], ['Shaft work Ws', fmt(kWToPower(r.Ws), 5) + ' ' + U.power]];
      out.appendChild(resultBox(fmt(kWToPower(r.Q), 6), U.power, rows, 'Heat added to the unit, Q (negative: heat is removed)'));
      var srows = [];
      r.inlets.forEach(function (s) { srows.push(['in: ' + s.name + ' at ' + tDisp(s.T), s.species.map(function (c) { return c.id + '(' + c.phase + ')'; }).join(', '), fmt(kWToPower(s.H), 6)]); });
      r.outlets.forEach(function (s) { srows.push(['out: ' + s.name + ' at ' + tDisp(s.T), s.species.map(function (c) { return c.id + '(' + c.phase + ')'; }).join(', '), fmt(kWToPower(s.H), 6)]); });
      out.appendChild(el('h3', null, 'Enthalpy of each stream'));
      out.appendChild(tableOf(['Stream', 'Species and phase', 'Ḣ (' + U.power + ')'], srows));
      warnList(out, r.warnings, r.notes);
      renderSteps(out, r.steps);
    } catch (e) { show(err, e.message); }
  }

  /* ───────────────────────── 6. data tables ───────────────────────── */

  function cpRowSource(id, ph) { return edits[id] && edits[id].Cp && edits[id].Cp[ph] !== undefined ? 'yours' : 'built-in'; }

  function renderData() {
    $('d-status').textContent = nEdits() ? 'You have changed ' + nEdits() + ' value' + (nEdits() === 1 ? '' : 's') + ' (kept in this browser only). Changed values are outlined or shaded.'
      : 'Nothing changed yet: the calculators use the built-in values.';
    /* Cp table */
    var t = $('d-cp'); clear(t);
    var head = el('thead'), hr = el('tr');
    var fl = $('d-felder').checked, EXP = [3, 5, 8, 12];
    ['Species', 'Phase', 'T in'].concat(fl ? ['a ×10³', 'b ×10⁵', 'c ×10⁸', 'd ×10¹²'] : ['a', 'b', 'c', 'd']).concat(['Valid range', 'Source', '']).forEach(function (h) { hr.appendChild(el('th', null, h)); });
    head.appendChild(hr); t.appendChild(head);
    var tb = el('tbody');
    Object.keys(DB).forEach(function (id) {
      var sp = DB[id];
      ['g', 'l', 's'].forEach(function (ph) {
        var cp = sp.Cp[ph];
        if (!cp) return;
        var src = cpRowSource(id, ph), tr = el('tr', src === 'yours' ? 'yours' : null);
        var c0 = el('td'); c0.appendChild(el('span', 'sp-name', id)); c0.appendChild(el('span', 'sub', sp.name)); tr.appendChild(c0);
        tr.appendChild(el('td', null, PHASE_WORD[ph]));
        tr.appendChild(el('td', null, cp.Tunit === 'K' ? 'K' : '°C'));
        [cp.a, cp.b, cp.c, cp.d].forEach(function (v, k) {
          var shown = fl ? v / 1000 * Math.pow(10, EXP[k]) : v;      // Felder prints kJ/(mol·°C) × 10^exp
          tr.appendChild(el('td', 'mono', v ? fmt(shown, 5) : '0'));
        });
        tr.appendChild(el('td', null, (cp.Tmin !== undefined && cp.Tmin !== null ? fmt(cp.Tmin, 5) : '…') + ' to ' + (cp.Tmax !== undefined && cp.Tmax !== null ? fmt(cp.Tmax, 5) : '…') + ' ' + (cp.Tunit === 'K' ? 'K' : '°C')));
        var sc = el('td'); sc.appendChild(el('span', 'tag', src)); tr.appendChild(sc);
        var bc = el('td');
        if (src === 'yours') {
          var b = el('button', 'secondary', Energy.SPECIES[id] && Energy.SPECIES[id].Cp[ph] ? 'Restore built-in' : 'Remove'); b.type = 'button';
          b.addEventListener('click', function () {
            var e = edits[id];
            if (e && e.Cp) delete e.Cp[ph];
            cleanEdit(id); dataChanged();
          });
          bc.appendChild(b);
        }
        tr.appendChild(bc);
        tb.appendChild(tr);
      });
    });
    t.appendChild(tb);

    /* properties table */
    var p = $('d-props'); clear(p);
    var ph2 = el('thead'), pr = el('tr');
    ['Species', 'ΔH°f gas', 'ΔH°f liquid', 'ΔH°f solid', 'Tm (°C)', 'ΔHfus', 'Tb (°C)', 'ΔHvap', 'Tc (K)', 'M (g/mol)', ''].forEach(function (h) { pr.appendChild(el('th', null, h)); });
    ph2.appendChild(pr); p.appendChild(ph2);
    var pb = el('tbody');
    Object.keys(DB).forEach(function (id) {
      var sp = DB[id], base = Energy.SPECIES[id], e = edits[id] || {};
      var tr = el('tr', edits[id] && Object.keys(edits[id]).length > 1 ? 'yours' : null);
      var c0 = el('td'); c0.appendChild(el('span', 'sp-name', id)); c0.appendChild(el('span', 'sub', sp.name + ' · ' + PHASE_WORD[sp.std] + ' at 25 °C')); tr.appendChild(c0);
      function cell(value, isEdited, onSet, scale) {
        var td = el('td'), i = el('input'); i.type = 'text'; i.setAttribute('inputmode', 'decimal'); i.autocomplete = 'off';
        i.value = value === null || value === undefined ? '' : fmt(value, 7);
        if (isEdited) i.className = 'edited';
        i.setAttribute('aria-label', id + ' ' + (scale || ''));
        i.addEventListener('change', function () {
          var v = i.value.trim() === '' ? null : Chem.parseNumber(i.value);
          if (v !== null && isNaN(v)) { i.value = value === null || value === undefined ? '' : fmt(value, 7); return; }
          onSet(v);
        });
        td.appendChild(i); return td;
      }
      ['g', 'l', 's'].forEach(function (ph) {
        var edHas = e.Hf && e.Hf[ph] !== undefined;
        tr.appendChild(cell(sp.Hf[ph], edHas, function (v) { var ed = editOf(id); ed.Hf = ed.Hf || {}; ed.Hf[ph] = v; normaliseEdit(id); dataChanged(); }, 'heat of formation ' + PHASE_WORD[ph]));
      });
      var cellK = function (key, label, toShow, fromShow) {
        var cur = sp[key], v = cur === null || cur === undefined ? null : toShow(cur), edHas = e[key] !== undefined;
        tr.appendChild(cell(v, edHas, function (x) { var ed = editOf(id); ed[key] = x === null ? null : fromShow(x); normaliseEdit(id); dataChanged(); }, label));
      };
      cellK('Tm', 'melting point °C', Energy.toC, Energy.toK);
      cellK('Hfus', 'heat of fusion', function (x) { return x; }, function (x) { return x; });
      cellK('Tb', 'boiling point °C', Energy.toC, Energy.toK);
      cellK('Hvap', 'heat of vaporisation', function (x) { return x; }, function (x) { return x; });
      cellK('Tc', 'critical temperature K', function (x) { return x; }, function (x) { return x; });
      cellK('M', 'molar mass', function (x) { return x; }, function (x) { return x; });
      var bc = el('td');
      if (edits[id]) {
        var b = el('button', 'secondary', base ? 'Reset' : 'Remove'); b.type = 'button';
        b.addEventListener('click', function () { delete edits[id]; dataChanged(); });
        bc.appendChild(b);
      }
      tr.appendChild(bc);
      pb.appendChild(tr);
      if (sp.note) {
        var nr = el('tr', 'note-row'), nc = el('td', null, '↳ ' + sp.name + ': ' + sp.note); nc.colSpan = 11; nr.appendChild(nc); pb.appendChild(nr);
      }
    });
    p.appendChild(pb);
  }

  /* An edit that equals the built-in value is not an edit. Keeps the record small and the "edited" outline honest. */
  function normaliseEdit(id) {
    var e = edits[id], base = Energy.SPECIES[id];
    if (!e || !base) return;
    var same = function (a, b) { return a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b))); };
    ['Tm', 'Hfus', 'Tb', 'Hvap', 'Tc', 'M'].forEach(function (k) { if (e[k] !== undefined && same(e[k], base[k])) delete e[k]; });
    ['Hf'].forEach(function (g) {
      if (!e[g]) return;
      Object.keys(e[g]).forEach(function (ph) { var b = base[g][ph]; if (same(e[g][ph], b === undefined ? null : b)) delete e[g][ph]; });
    });
    cleanEdit(id);
  }
  function cleanEdit(id) {
    var e = edits[id];
    if (!e) return;
    ['Cp', 'Hf', 'Hc'].forEach(function (g) { if (e[g] && Object.keys(e[g]).length === 0) delete e[g]; });
    if (Object.keys(e).length <= 1 && Energy.SPECIES[id]) delete edits[id];
  }

  $('d-felder').addEventListener('change', renderData);
  $('a-felder').addEventListener('click', function () {
    ['a-ea', 'a-eb', 'a-ec', 'a-ed'].forEach(function (id, i) { $(id).value = String([3, 5, 8, 12][i]); });
    $('a-en').value = 'kJ'; $('a-T').value = 'C';
  });
  $('a-go').addEventListener('click', function () {
    var err = $('a-error'); show(err, '');
    try {
      var id = $('a-sp').value.trim();
      if (!id) throw new Error('Type the species: a formula such as N2, or a new one.');
      if (!/^[A-Za-z][A-Za-z0-9()]*$/.test(id)) throw new Error('Use letters and digits only for the formula (for example C3H6).');
      var vals = {};
      ['a', 'b', 'c', 'd'].forEach(function (k) {
        var raw = $('a-' + k).value.trim();
        if (raw === '') { vals[k] = k === 'a' ? NaN : 0; return; }
        vals[k] = Chem.parseNumber(raw);
        if (isNaN(vals[k])) throw new Error('"' + raw + '" is not a number (coefficient ' + k + ').');
      });
      if (isNaN(vals.a)) throw new Error('Enter at least the constant term a.');
      var exps = ['a', 'b', 'c', 'd'].map(function (k) {
        var x = Chem.parseNumber($('a-e' + k).value);
        if (isNaN(x)) throw new Error('The power of ten for ' + k + ' must be a whole number (0 if none).');
        return x;
      });
      var cp = Energy.scaleCoefficients(vals, exps, $('a-en').value);
      cp.Tunit = $('a-T').value;
      var lo = Chem.parseNumber($('a-lo').value), hi = Chem.parseNumber($('a-hi').value);
      if (!isNaN(lo)) cp.Tmin = lo;
      if (!isNaN(hi)) cp.Tmax = hi;
      if (!isNaN(lo) && !isNaN(hi) && !(lo < hi)) throw new Error('The valid range must run from a lower to a higher temperature.');
      var ph = $('a-ph').value, e = editOf(id);
      if (!DB[id]) { e.formula = id; e.name = id; e.std = ph; }
      e.Cp = e.Cp || {}; e.Cp[ph] = cp;
      dataChanged();
      $('a-a').value = $('a-b').value = $('a-c').value = $('a-d').value = '';
    } catch (ex) { show(err, ex.message); }
  });
  $('n-go').addEventListener('click', function () {
    var err = $('n-error'); show(err, '');
    var id = $('n-id').value.trim();
    if (!id) { show(err, 'Type the formula of the new species.'); return; }
    if (!/^[A-Za-z][A-Za-z0-9()]*$/.test(id)) { show(err, 'Use letters and digits only for the formula (for example C3H6).'); return; }
    if (DB[id]) { show(err, id + ' is already in the table: edit its row instead.'); return; }
    edits[id] = { id: id, name: $('n-name').value.trim() || id, formula: id, std: $('n-std').value };
    dataChanged();
    $('n-id').value = ''; $('n-name').value = '';
  });
  var resetArmed = false;
  $('d-reset').addEventListener('click', function () {
    if (!resetArmed) { resetArmed = true; $('d-reset').textContent = 'Click again to remove all my changes'; return; }
    resetArmed = false; $('d-reset').textContent = 'Remove all my changes';
    edits = {}; dataChanged();
  });
  $('d-reset').addEventListener('blur', function () { resetArmed = false; $('d-reset').textContent = 'Remove all my changes'; });

  /* ───────────────────────── start ───────────────────────── */

  function recomputeAll() {
    calcSensible(); calcPhase(); calcLatent(); calcReaction(); calcCombustion(); calcReactor(); calcOpen();
  }

  loadEdits();
  rebuildDB();
  refreshSpecies();
  fillFuelPhases();
  fillConvSpecies();
  syncMode();
  ['p-P', 'r-P', 'x-P', 'o-P'].forEach(function (id) { $(id).value = fmt(Chem.convert('pressure', 101.325, 'kPa', U.press), 8); });
  loadPhExample(0);
  $('r-example').value = '0';
  $('o-example').value = '1';
  loadOpenExample(1);
  refreshUnitLabels();
  renderData();
  recomputeAll();
})();
