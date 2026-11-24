/* Page for balance.html: the drawing canvas, the "what you know" rows, and the result display.
   The drawing itself (units, streams, layout, routes) is Flowsheet; the solving is Balance.
   This file only draws, handles clicks and drags, and shows results.
   All text from the user goes in with textContent, never innerHTML. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var STORE = 'survive-chemeng-balance-v2';
  var OLD_STORE = 'survive-chemeng-balance-v1';
  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  var diagram = Flowsheet.empty();                 // the drawing being edited
  var ui = { tool: 'select', sel: null, drag: null, draw: null, hot: null, probBox: null };
  var geom = null;                                 // geometry of the editable drawing as last drawn
  var solvedOnce = false;
  var resultCtl = null;                            // { wrap, svg, dg, out } for the drawing inside the results

  var svg = $('fs-svg'), wrap = $('fs-wrap');

  /* ───────── small DOM helpers ───────── */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function labelled(label, control, cls) {
    var f = el('div', 'field' + (cls ? ' ' + cls : ''));
    control.id = 'bf' + (++uid);
    var l = el('label', null, label);
    l.htmlFor = control.id;
    f.appendChild(l);
    f.appendChild(control);
    return f;
  }
  function textInput(value, placeholder) {
    var i = el('input');
    i.type = 'text'; i.autocomplete = 'off'; i.spellcheck = false;
    i.value = value === undefined || value === null ? '' : value;
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  function select(options, value) {
    var s = el('select');
    options.forEach(function (o) {
      var opt = el('option', null, o.label);
      opt.value = o.value;
      s.appendChild(opt);
    });
    if (value !== undefined && value !== null) s.value = value;
    return s;
  }
  function button(label, cls, onClick) {
    var b = el('button', cls || 'secondary', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function removeButton(row, after) {
    var b = el('button', 'secondary remove', 'Remove');
    b.type = 'button';
    b.setAttribute('aria-label', 'Remove this row');
    b.addEventListener('click', function () { row.parentNode.removeChild(row); if (after) after(); });
    return b;
  }
  // Errors show in red; plain information (info = true) in neutral colours.
  function note(text, info) {
    var m = $('fs-msg');
    m.textContent = text || '';
    m.classList.toggle('hidden', !text);
    m.classList.toggle('info', !!info);
  }

  /* ───────── energy balance settings (optional; everything here is inert while the box is unticked) ───────── */

  var ENERGY_STORE = 'chemeng-energy-data-v1';       // the user's own data, edited on the Energy page
  var MOL_FLOW = ['mol/s', 'mol/min', 'mol/h', 'kmol/s', 'kmol/min', 'kmol/h', 'lbmol/h'];
  var MASS_FLOW = ['g/s', 'kg/s', 'kg/h', 't/h', 'lb/s', 'lb/h'];
  var PHASE_TEXT = { g: 'gas', l: 'liquid', s: 'solid' };
  var energy = { on: false, flowUnit: 'mol/s', tempUnit: '°C', powerUnit: 'kW', P: '101.325', map: {} };
  var energyDB = Energy.SPECIES, energyEdits = 0;

  function loadEnergyDB() {
    var edits = {};
    try {
      var raw = localStorage.getItem(ENERGY_STORE);
      if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) edits = o; }
    } catch (e) { edits = {}; }
    energyEdits = Object.keys(edits).length;
    energyDB = Energy.extendDatabase(Energy.SPECIES, Object.keys(edits).map(function (k) { return edits[k]; }));
  }
  function flowSpec() {                                // how the flow unit turns into mol/s (mole flows) or kg/s (mass flows)
    var u = energy.flowUnit;
    if (MASS_FLOW.indexOf(u) >= 0) return { type: 'mass', factor: Chem.convert('massFlow', 1, u, 'kg/s') };
    var p = u.split('/');
    return { type: 'mol', factor: Chem.convert('amount', 1, p[0], 'mol') / Chem.convert('time', 1, p[1], 's') };
  }
  function energySection() {
    var P = Chem.parseNumber(energy.P);
    return { species: energy.map, flowUnit: flowSpec(), P: P > 0 ? P : 101.325, db: energyDB };
  }
  var tempToK = function (v) { return Chem.convert('temperature', v, energy.tempUnit, 'K'); };
  var kToTemp = function (K) { return Chem.convert('temperature', K, 'K', energy.tempUnit); };
  var powerToKW = function (v) { return Chem.convert('power', v, energy.powerUnit, 'kW'); };
  var kwToPower = function (v) { return Chem.convert('power', v, 'kW', energy.powerUnit); };
  var resEn = energy;                                  // the energy settings as they were when Solve was pressed
  function fmtTemp(K) { return K === null || K === undefined ? '?' : Chem.fmt(Chem.convert('temperature', K, 'K', resEn.tempUnit), 5) + ' ' + resEn.tempUnit; }
  function fmtPower(kW) { return kW === null || kW === undefined ? '?' : Chem.fmt(Chem.convert('power', kW, 'kW', resEn.powerUnit), 5) + ' ' + resEn.powerUnit; }
  function unitOpts() { return { tempUnit: energy.tempUnit, powerUnit: energy.powerUnit }; }

  /* ───────── what the "what you know" rows can choose from: the drawing ───────── */

  function specRows() { return Array.prototype.slice.call($('specs').children); }

  function choices() {
    return {
      streams: diagram.streams.map(function (s) { return s.name; }),
      comps: Balance.parseList($('components').value),
      units: diagram.units.map(function (u) { return u.name; })
    };
  }

  function optionsFor(kind, ch) {
    var list = kind === 'stream' || kind === 'stream2' ? ch.streams : (kind === 'unit' ? ch.units : ch.comps);
    return list.map(function (v) { return { value: v, label: v }; });
  }

  // renames = { unit: {old: new}, stream: {old: new} }: rows that pointed at the old name follow it
  function refreshChoices(renames) {
    var ch = choices();
    specRows().forEach(function (r) {
      var fields = r._f.fields;
      Object.keys(fields).forEach(function (k) {
        if (k === 'reaction') return;
        var sel = fields[k], keep = sel.value;
        if (renames) {
          var map = k === 'unit' ? renames.unit : (k === 'stream' || k === 'stream2' ? renames.stream : null);
          if (map && map[keep]) keep = map[keep];
        }
        sel.innerHTML = '';
        var opts = optionsFor(k, ch);
        if (!opts.length) opts = [{ value: '', label: '(none yet)' }];
        opts.forEach(function (o) { var opt = el('option', null, o.label); opt.value = o.value; sel.appendChild(opt); });
        if (opts.some(function (o) { return o.value === keep; })) sel.value = keep;
      });
    });
  }

  // When a unit or stream is deleted, the rows about it have nothing left to refer to.
  function dropSpecsFor(kind, names) {
    var removed = 0;
    specRows().forEach(function (r) {
      var f = r._f.fields, hit = false;
      if (kind === 'unit') hit = !!(f.unit && names.indexOf(f.unit.value) >= 0);
      else hit = ['stream', 'stream2'].some(function (k) { return f[k] && names.indexOf(f[k].value) >= 0; });
      if (hit) { r.parentNode.removeChild(r); removed++; }
    });
    return removed;
  }

  /* ───────── specification rows ───────── */

  var FIELD_LABELS = { stream: 'Stream', stream2: 'Second stream', comp: 'Component', comp2: 'Second component', unit: 'Unit' };

  function specType(id) {
    var all = Balance.SPEC_TYPES.concat(Balance.ENERGY_SPEC_TYPES);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return Balance.SPEC_TYPES[0];
  }
  function isEnergyType(id) { return Balance.ENERGY_SPEC_TYPES.some(function (t) { return t.id === id; }); }
  // the types a row can choose from: the energy ones only while the energy balance is on (or if the row already uses one)
  function typeOptions(current) {
    var list = Balance.SPEC_TYPES.slice();
    if (energy.on || isEnergyType(current)) list = list.concat(Balance.ENERGY_SPEC_TYPES);
    return list.map(function (t) { return { value: t.id, label: t.label }; });
  }
  function valueLabel(t) {
    if (t.id === 'temp') return 'Temperature (' + energy.tempUnit + ')';
    if (t.id === 'duty') return 'Heat added (' + energy.powerUnit + '; negative = heat removed)';
    return 'Value (' + t.value + ')';
  }

  function addSpec(d) {
    d = d || {};
    var row = el('div', 'spec-row');
    var typeSel = select(typeOptions(d.type), d.type || 'flow');
    var holder = el('div', 'spec-fields');
    var valueIn = textInput(d.value);
    var valueField = labelled('Value', valueIn, 'f-value');
    row._f = { type: typeSel, fields: {}, value: valueIn };
    var l1 = el('div', 'line'), l2 = el('div', 'line');
    l1.appendChild(labelled('What you know', typeSel, 'f-spectype'));
    l1.appendChild(removeButton(row, specsChanged));
    l2.appendChild(holder);
    l2.appendChild(valueField);
    row.appendChild(l1); row.appendChild(l2);

    function rebuild(seed) {
      var t = specType(typeSel.value), ch = choices();
      var old = {};
      Object.keys(row._f.fields).forEach(function (k) { old[k] = row._f.fields[k].value; });
      holder.innerHTML = '';
      row._f.fields = {};
      t.fields.forEach(function (k) {
        var opts = optionsFor(k, ch);
        if (!opts.length) opts = [{ value: '', label: '(none yet)' }];
        var wanted = seed && seed[k] !== undefined ? seed[k] : old[k];
        if (wanted && !opts.some(function (o) { return o.value === wanted; })) opts = opts.concat([{ value: wanted, label: wanted }]);
        var s = select(opts, wanted);
        row._f.fields[k] = s;
        holder.appendChild(labelled(FIELD_LABELS[k], s, 'f-choice'));
      });
      if (t.id === 'extent') {
        var rn = textInput(seed && seed.reaction !== undefined ? seed.reaction : (old.reaction || '1'));
        rn.size = 3;
        row._f.fields.reaction = rn;
        holder.appendChild(labelled('Reaction no.', rn, 'f-small'));
      }
      valueField.querySelector('label').textContent = valueLabel(t);
      valueField.classList.toggle('hidden', t.value === null);        // some energy specifications need no number
    }
    row._f.relabel = function () { rebuild(null); };
    row._f.retype = function () {
      var keep = typeSel.value;
      typeSel.innerHTML = '';
      typeOptions(keep).forEach(function (o) { var opt = el('option', null, o.label); opt.value = o.value; typeSel.appendChild(opt); });
      typeSel.value = keep;
    };
    typeSel.addEventListener('change', function () { rebuild(null); });
    rebuild(d);
    $('specs').appendChild(row);
    return row;
  }

  function focusSpec(row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row._f.value.focus({ preventScroll: true });
  }

  /* ───────── reading and writing the page state ───────── */

  function rawSpecs() {
    return specRows().map(function (r) {
      var o = { type: r._f.type.value, value: r._f.value.value };
      Object.keys(r._f.fields).forEach(function (k) { o[k] = r._f.fields[k].value; });
      return o;
    });
  }

  function numericSpecs(raw) {
    return raw.map(function (s) {
      var o = {};
      Object.keys(s).forEach(function (k) { o[k] = s[k]; });
      var v = Chem.parseNumber(s.value);
      o.value = isNaN(v) ? '' : v;
      if (s.reaction !== undefined) o.reaction = Number(s.reaction) || 1;
      return o;
    });
  }

  function buildModel() {
    var comps = Balance.parseList($('components').value), specs = numericSpecs(rawSpecs());
    if (!energy.on) return Flowsheet.toModel(diagram, comps, specs);
    // the model wants K and kW: the person typed the units chosen in the energy box
    specs = specs.map(function (s) {
      var o = {};
      Object.keys(s).forEach(function (k) { o[k] = s[k]; });
      if (o.type === 'temp' && o.value !== '') o.value = tempToK(o.value);
      if (o.type === 'duty' && o.value !== '') o.value = powerToKW(o.value);
      return o;
    });
    return Flowsheet.toModel(diagram, comps, specs, energySection());
  }

  function setEnergy(e) {
    var en = e || {};
    energy = { on: !!en.on, flowUnit: en.flowUnit || 'mol/s', tempUnit: en.tempUnit || '°C', powerUnit: en.powerUnit || 'kW', P: en.P || '101.325', map: en.map || {} };
    $('en-on').checked = energy.on;
    $('en-flow').value = energy.flowUnit; $('en-temp').value = energy.tempUnit; $('en-power').value = energy.powerUnit; $('en-P').value = energy.P;
    $('en-box').classList.toggle('hidden', !energy.on);
    refreshEnergySpecies();
  }

  function loadState(st) {
    $('components').value = st.components || '';
    diagram = st.diagram ? Flowsheet.clone(st.diagram) : Flowsheet.empty();
    ui.sel = null; ui.drag = null; ui.draw = null; ui.hot = null;
    setEnergy(st.energy);
    $('specs').innerHTML = '';
    (st.specs || []).forEach(addSpec);
    refreshChoices();
    refreshPick();
    note(null);
    drawEditor();
    drawInspector();
  }

  function stateFromExample(ex) {
    var m = ex.model;
    var st = {
      components: m.components.join(', '),
      diagram: Flowsheet.fromModel(m),
      specs: m.specs.map(function (s) {
        var o = {};
        Object.keys(s).forEach(function (k) { o[k] = s[k]; });
        // examples with energy are written in K and kW; show them in °C and kW
        if (m.energy && o.type === 'temp') o.value = Number(Chem.convert('temperature', o.value, 'K', '°C').toPrecision(10));
        return o;
      })
    };
    if (m.energy) st.energy = { on: true, flowUnit: 'mol/s', tempUnit: '°C', powerUnit: 'kW', P: '101.325', map: (m.energy.species || {}) };
    return st;
  }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ components: $('components').value, diagram: diagram, specs: rawSpecs(), energy: energy }));
    } catch (e) { /* private mode: fine */ }
  }

  // Reads the current save, or an older save that had a list of units instead of a drawing.
  function restore() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE));
      if (s && s.diagram && s.specs) return { components: s.components || '', diagram: Flowsheet.sanitize(s.diagram), specs: s.specs, energy: s.energy };
    } catch (e) { /* ignore */ }
    try {
      var o = JSON.parse(localStorage.getItem(OLD_STORE));
      if (o && o.units && o.specs) {
        var model = { units: o.units.map(function (u) { return { name: u.name, type: u.type, inlets: u.inlets, outlets: u.outlets, reactions: u.reactions }; }) };
        return { components: o.components || '', diagram: Flowsheet.fromModel(model), specs: o.specs };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ───────── drawing a flowsheet (used for the editable canvas and for the results) ───────── */

  function unitShape(type, sw, hh) {
    var g = svgEl('g');
    if (type === 'mixer') {
      g.appendChild(svgEl('polygon', { points: [-sw, -hh, sw, -hh / 2, sw, hh / 2, -sw, hh].join(' '), 'class': 'fs-shape' }));
    } else if (type === 'splitter') {
      g.appendChild(svgEl('polygon', { points: [-sw, -hh / 2, sw, -hh, sw, hh, -sw, hh / 2].join(' '), 'class': 'fs-shape' }));
    } else if (type === 'separator') {
      g.appendChild(svgEl('rect', { x: -sw, y: -hh, width: 2 * sw, height: 2 * hh, rx: 24, 'class': 'fs-shape' }));
    } else if (type === 'reactor') {
      g.appendChild(svgEl('rect', { x: -sw, y: -hh, width: 2 * sw, height: 2 * hh, rx: 5, 'class': 'fs-shape' }));
      g.appendChild(svgEl('rect', { x: -sw + 6, y: -hh + 6, width: 2 * sw - 12, height: 2 * hh - 12, rx: 3, 'class': 'fs-inner' }));
    } else {
      g.appendChild(svgEl('rect', { x: -sw, y: -hh, width: 2 * sw, height: 2 * hh, rx: 3, 'class': 'fs-shape' }));
    }
    return g;
  }

  /*
   * o: id            prefix for ids inside this svg
   *    interactive   draw the wide invisible hit area on streams
   *    sel, hot      selected item {kind, name}; unit under the cursor
   *    rubber        {x1, y1, x2, y2} line being drawn
   *    streamLines   name -> [{text, cls}] shown under a stream
   *    unitLines     name -> [{text, cls}] shown under a unit
   *    pill          name -> {text, cls, tip} badge under a unit
   *    problems      unit -> [string]; a warning badge is drawn on units that have some
   *    empty         message for an empty drawing
   */
  function drawDiagram(target, holder, dg, o) {
    var lines = {}, ulines = {}, pills = {};
    dg.streams.forEach(function (s) { lines[s.name] = o.streamLines ? o.streamLines(s.name) : []; });
    dg.units.forEach(function (u) {
      ulines[u.name] = o.unitLines ? o.unitLines(u.name) : [];
      pills[u.name] = o.pill ? o.pill(u.name) : null;
    });
    var G = Flowsheet.geometry(dg, {
      lines: function (n) { return lines[n] ? lines[n].length : 0; },
      unitRows: function (n) { return (pills[n] ? 1 : 0) + (ulines[n] ? ulines[n].length : 0); }
    });
    var b = G.bounds, lowest = b.maxY;
    dg.streams.forEach(function (s) {
      lowest = Math.max(lowest, G.streams[s.name].below.y + 14 * lines[s.name].length + 10);
    });
    var avail = Math.max(holder.clientWidth - 2, 0);
    var x0 = Math.min(0, Math.floor(b.minX - 20)), y0 = Math.min(0, Math.floor(b.minY - 20));
    var w = Math.max(Math.ceil(b.maxX + 40) - x0, avail, 520);
    var h = Math.max(Math.ceil(lowest + 20) - y0, o.minHeight || 240);
    // A drawing wider than its box is shrunk to fit, down to 80%; beyond that it scrolls sideways.
    var scale = avail > 0 && w > avail ? Math.max(0.8, avail / w) : 1;
    target.setAttribute('viewBox', [x0, y0, w, h].join(' '));
    target.setAttribute('width', Math.round(w * scale));
    target.setAttribute('height', Math.round(h * scale));
    while (target.firstChild) target.removeChild(target.firstChild);

    var defs = svgEl('defs');
    ['', '-sel'].forEach(function (suffix) {
      var m = svgEl('marker', { id: o.id + '-arrow' + suffix, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 11, markerHeight: 11, orient: 'auto', markerUnits: 'userSpaceOnUse' });
      m.appendChild(svgEl('path', { d: 'M0 1 L10 5 L0 9 z', 'class': 'fs-arrow' + (suffix ? ' sel' : '') }));
      defs.appendChild(m);
    });
    target.appendChild(defs);

    if (!dg.units.length && o.empty) {
      target.appendChild(svgEl('text', { x: x0 + Math.min(w, avail || w) / 2, y: y0 + h / 2, 'class': 'fs-empty' }, o.empty));
    }

    dg.streams.forEach(function (s) {
      var g = G.streams[s.name];
      var selected = o.sel && o.sel.kind === 'stream' && o.sel.name === s.name;
      var grp = svgEl('g', { 'class': 'fs-stream' + (selected ? ' sel' : ''), 'data-stream': s.name });
      if (o.interactive) grp.appendChild(svgEl('path', { d: g.d, 'class': 'fs-hit' }));
      grp.appendChild(svgEl('path', { d: g.d, 'class': 'fs-line', 'marker-end': 'url(#' + o.id + '-arrow' + (selected ? '-sel' : '') + ')' }));
      target.appendChild(grp);
    });

    dg.units.forEach(function (u) {
      var g = G.units[u.name], hh = g.h / 2, sw = g.w / 2;
      var selected = o.sel && o.sel.kind === 'unit' && o.sel.name === u.name;
      var grp = svgEl('g', {
        'class': 'fs-unit' + (selected ? ' sel' : '') + (o.hot === u.name ? ' hot' : ''),
        'data-unit': u.name, transform: 'translate(' + g.cx + ' ' + g.cy + ')'
      });
      grp.appendChild(unitShape(u.type, sw, hh));
      grp.appendChild(svgEl('text', { x: 0, y: -2, 'class': 'fs-uname' }, u.name));
      grp.appendChild(svgEl('text', { x: 0, y: 15, 'class': 'fs-utype' }, Balance.UNIT_TYPES[u.type].label));
      var y = hh + 18;
      var pill = pills[u.name];
      if (pill) {
        var pg = svgEl('g', { transform: 'translate(0 ' + y + ')' });
        if (pill.tip) pg.appendChild(svgEl('title', null, pill.tip));
        pg.appendChild(svgEl('rect', { x: -30, y: -10, width: 60, height: 19, rx: 9.5, 'class': 'fs-pill ' + pill.cls }));
        pg.appendChild(svgEl('text', { x: 0, y: 4, 'class': 'fs-pilltext' }, pill.text));
        grp.appendChild(pg);
        y += 20;
      }
      ulines[u.name].forEach(function (ln) {
        grp.appendChild(svgEl('text', { x: 0, y: y, 'text-anchor': 'middle', 'class': 'fs-text ' + ln.cls }, ln.text));
        y += 14;
      });
      var probs = o.problems ? o.problems(u) : [];
      if (probs.length) {
        var bg = svgEl('g', { transform: 'translate(' + sw + ' ' + (-hh) + ')' });
        bg.appendChild(svgEl('title', null, probs.join(' ')));
        bg.appendChild(svgEl('circle', { r: 9, 'class': 'fs-badge' }));
        bg.appendChild(svgEl('text', { x: 0, y: 4.5, 'class': 'fs-badgetext' }, '!'));
        grp.appendChild(bg);
      }
      target.appendChild(grp);
    });

    // stream names and text go on top of everything, so a unit's outline never cuts into them
    dg.streams.forEach(function (s) {
      var g = G.streams[s.name];
      var labels = svgEl('g', { 'data-stream': s.name });
      labels.appendChild(svgEl('text', { x: g.label.x, y: g.label.y, 'text-anchor': 'middle', 'class': 'fs-text fs-sname' }, s.name));
      lines[s.name].forEach(function (ln, i) {
        labels.appendChild(svgEl('text', { x: g.below.x, y: g.below.y + 14 * i, 'text-anchor': 'middle', 'class': 'fs-text ' + ln.cls }, ln.text));
      });
      target.appendChild(labels);
    });

    if (o.rubber) target.appendChild(svgEl('line', { x1: o.rubber.x1, y1: o.rubber.y1, x2: o.rubber.x2, y2: o.rubber.y2, 'class': 'fs-rubber' }));
    return G;
  }

  function noteLines(list, cls) { return (list || []).map(function (t) { return { text: t, cls: cls }; }); }

  // How many lines of "what you entered" sit under each stream. The layout leaves room for them.
  function editorOpts() {
    var notes = Flowsheet.specNotes(numericSpecs(rawSpecs()), unitOpts());
    if (energy.on) diagram.streams.forEach(function (s) { if (s.phase) (notes.streams[s.name] = notes.streams[s.name] || []).push(PHASE_TEXT[s.phase]); });
    return { notes: notes, lines: function (n) { return (notes.streams[n] || []).length; } };
  }

  function drawEditor() {
    var notes = editorOpts().notes;
    wrap.className = 'fs-wrap tool-' + ui.tool;
    geom = drawDiagram(svg, wrap, diagram, {
      id: 'fs-svg', interactive: true, sel: ui.sel, hot: ui.hot, rubber: ui.draw ? ui.draw.rubber : null, minHeight: 300,
      streamLines: function (n) { return noteLines(notes.streams[n], 'fs-note'); },
      unitLines: function (n) { return noteLines(notes.units[n], 'fs-note'); },
      problems: function (u) { return Flowsheet.unitProblems(diagram, u); },
      empty: 'Add a unit with the buttons above to start drawing.'
    });
  }

  function revealUnit(name) {
    var g = geom && geom.units[name];
    if (!g) return;
    if (g.right + 120 > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = g.right + 120 - wrap.clientWidth;
    if (g.left - 60 < wrap.scrollLeft) wrap.scrollLeft = Math.max(0, g.left - 60);
  }

  /* ───────── things that change the problem ───────── */

  function markStale() { if (solvedOnce) $('stale').classList.remove('hidden'); }

  function dataChanged(renames) {
    markStale();
    refreshChoices(renames);
    refreshPick();
    drawEditor();
    updateProblems();
    save();
  }

  function specsChanged() {
    markStale();
    drawEditor();
    save();
  }

  // The "Edit:" dropdown lists every unit and stream: the keyboard (and screen reader) way to select one.
  function refreshPick() {
    var s = $('pick');
    s.innerHTML = '';
    s.appendChild(new Option(diagram.units.length || diagram.streams.length ? 'choose a unit or stream' : 'nothing drawn yet', ''));
    diagram.units.forEach(function (u) { s.appendChild(new Option('Unit ' + u.name, 'u:' + u.name)); });
    diagram.streams.forEach(function (t) { s.appendChild(new Option('Stream ' + t.name, 's:' + t.name)); });
    s.value = ui.sel ? (ui.sel.kind === 'unit' ? 'u:' : 's:') + ui.sel.name : '';
  }
  $('pick').addEventListener('change', function () {
    var v = $('pick').value;
    selectItem(v ? { kind: v.charAt(0) === 'u' ? 'unit' : 'stream', name: v.slice(2) } : null);
  });

  function selectItem(sel) {
    ui.sel = sel;
    refreshPick();
    drawEditor();
    drawInspector();
  }

  function deleteSelected() {
    var sel = ui.sel;
    if (!sel) return;
    var parts = [], dropped = 0;
    if (sel.kind === 'unit') {
      var r = Flowsheet.removeUnit(diagram, sel.name);
      dropped = dropSpecsFor('unit', [sel.name]) + dropSpecsFor('stream', r.removedStreams);
      parts.push('Removed ' + sel.name + (r.removedStreams.length ? ' and ' + (r.removedStreams.length > 1 ? 'streams ' : 'stream ') + r.removedStreams.join(', ') : ''));
      if (r.detached.length) parts.push((r.detached.length > 1 ? 'Streams ' : 'Stream ') + r.detached.join(', ') + (r.detached.length > 1 ? ' now have' : ' now has') + ' a loose end');
    } else {
      Flowsheet.removeStream(diagram, sel.name);
      dropped = dropSpecsFor('stream', [sel.name]);
      parts.push('Removed stream ' + sel.name);
    }
    if (dropped) parts.push(dropped + (dropped > 1 ? ' rows in “What you know” were' : ' row in “What you know” was') + ' removed because ' + (dropped > 1 ? 'they were' : 'it was') + ' about something you deleted');
    ui.sel = null;
    dataChanged();
    drawInspector();
    note(parts.join('. ') + '.', true);
  }

  /* ───────── mouse, touch and keyboard on the canvas ───────── */

  function svgPoint(e) {
    var p = svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    var m = svg.getScreenCTM();
    return m ? p.matrixTransform(m.inverse()) : { x: 0, y: 0 };
  }
  function snap(v) { return Math.round(v / 10) * 10; }
  function unitUnder(p) { return geom ? Flowsheet.unitAt(geom, p.x, p.y) : null; }

  function finishDraw(toUnit) {
    var from = ui.draw.from;
    ui.draw = null; ui.hot = null;
    if (from && toUnit && from === toUnit) { note('A stream cannot start and end at the same unit.'); drawEditor(); return; }
    var r = Flowsheet.addStream(diagram, from, toUnit);
    if (r.error) { note(r.error); drawEditor(); return; }
    note(null);
    ui.sel = { kind: 'stream', name: r.stream.name };
    dataChanged();
    drawInspector();
  }

  svg.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var p = svgPoint(e), hit = unitUnder(p);
    svg.focus({ preventScroll: true });
    note(null);
    if (ui.tool === 'draw') {
      e.preventDefault();
      if (ui.draw && ui.draw.armed) { finishDraw(hit); return; }
      ui.draw = { from: hit, armed: false, start: p, rubber: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } };
      svg.setPointerCapture(e.pointerId);
      drawEditor();
      return;
    }
    if (hit) {
      e.preventDefault();
      var u = Flowsheet.findUnit(diagram, hit);
      ui.drag = { name: hit, dx: p.x - u.x, dy: p.y - u.y, moved: false };
      svg.setPointerCapture(e.pointerId);
      if (!ui.sel || ui.sel.kind !== 'unit' || ui.sel.name !== hit) selectItem({ kind: 'unit', name: hit });
      return;
    }
    var se = e.target && e.target.closest ? e.target.closest('[data-stream]') : null;
    selectItem(se ? { kind: 'stream', name: se.getAttribute('data-stream') } : null);
  });

  svg.addEventListener('pointermove', function (e) {
    var p = svgPoint(e);
    if (ui.drag) {
      var u = Flowsheet.findUnit(diagram, ui.drag.name);
      if (!u) return;
      var half = Flowsheet.sizeOf(diagram, u, editorOpts()).h / 2;
      var nx = Math.max(Flowsheet.MIN_X, snap(p.x - ui.drag.dx)), ny = Math.max(half + 24, snap(p.y - ui.drag.dy));
      if (nx !== u.x || ny !== u.y) { u.x = nx; u.y = ny; ui.drag.moved = true; drawEditor(); }
    } else if (ui.tool === 'draw') {
      var hot = unitUnder(p);
      if (ui.draw) ui.draw.rubber = { x1: ui.draw.start.x, y1: ui.draw.start.y, x2: p.x, y2: p.y };
      if (ui.draw || hot !== ui.hot) { ui.hot = hot; drawEditor(); }
    }
  });

  svg.addEventListener('pointerup', function (e) {
    var p = svgPoint(e);
    if (ui.drag) {
      var moved = ui.drag.moved;
      ui.drag = null;
      if (moved) dataChanged();
      return;
    }
    if (ui.tool === 'draw' && ui.draw && !ui.draw.armed) {
      if (Math.hypot(p.x - ui.draw.start.x, p.y - ui.draw.start.y) > 12) finishDraw(unitUnder(p));
      else {
        ui.draw.armed = true;
        note(ui.draw.from ? 'Now click the unit where the stream should end, or empty space to make it a product.' : 'Now click the unit this feed should enter.', true);
        drawEditor();
      }
    }
  });

  svg.addEventListener('pointercancel', function () {
    ui.drag = null;
    if (ui.draw && !ui.draw.armed) ui.draw = null;
    drawEditor();
  });

  svg.addEventListener('pointerleave', function () {
    if (ui.hot && !ui.draw) { ui.hot = null; drawEditor(); }
  });

  svg.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (ui.draw) { ui.draw = null; ui.hot = null; note(null); drawEditor(); }
      else if (ui.tool === 'draw') setTool('select');
      else if (ui.sel) selectItem(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.sel) {
      e.preventDefault();
      deleteSelected();
    } else if (/^Arrow/.test(e.key) && ui.sel && ui.sel.kind === 'unit') {
      e.preventDefault();
      var u = Flowsheet.findUnit(diagram, ui.sel.name);
      var step = e.shiftKey ? 50 : 10;
      u.x = Math.max(Flowsheet.MIN_X, u.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0));
      u.y = Math.max(Flowsheet.sizeOf(diagram, u, editorOpts()).h / 2 + 24, u.y + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0));
      dataChanged();
    }
  });

  /* ───────── tools and palette ───────── */

  var HINTS = {
    select: 'Drag a unit to move it. Click a unit or a stream to edit it below the drawing. With a unit selected, the arrow keys nudge it and Delete removes it.',
    draw: 'Click a unit, then click another unit to join them with a stream (or drag from one to the other). Click empty space instead of a unit to start a feed or to end a product. Esc stops drawing.'
  };

  function setTool(t) {
    ui.tool = t; ui.draw = null; ui.hot = null;
    $('tool-select').setAttribute('aria-pressed', String(t === 'select'));
    $('tool-draw').setAttribute('aria-pressed', String(t === 'draw'));
    $('fs-hint').textContent = HINTS[t];
    note(null);
    drawEditor();
  }
  $('tool-select').addEventListener('click', function () { setTool('select'); });
  $('tool-draw').addEventListener('click', function () { setTool('draw'); });

  Object.keys(Balance.UNIT_TYPES).forEach(function (type) {
    var b = button('+ ' + Balance.UNIT_TYPES[type].label, 'secondary', function () {
      var u = Flowsheet.addUnit(diagram, type);
      note(null);
      ui.sel = { kind: 'unit', name: u.name };
      dataChanged();
      drawInspector();
      revealUnit(u.name);
    });
    b.title = Balance.UNIT_TYPES[type].hint;
    $('palette').appendChild(b);
  });

  $('tidy').addEventListener('click', function () { Flowsheet.layout(diagram, editorOpts()); note(null); dataChanged(); });

  /* ───────── the edit panel under the drawing ───────── */

  function addSpecFor(spec) {
    var row = addSpec(spec);
    dataChanged();
    focusSpec(row);
  }

  function updateProblems() {
    var box = ui.probBox;
    if (!box || !ui.sel || ui.sel.kind !== 'unit') return;
    var u = Flowsheet.findUnit(diagram, ui.sel.name);
    if (!u) return;
    var ps = Flowsheet.unitProblems(diagram, u);
    box.innerHTML = '';
    ps.forEach(function (t) { box.appendChild(el('li', null, t)); });
    box.classList.toggle('hidden', !ps.length);
  }

  function commitOnEnter(input, commit) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
  }

  function drawInspector() {
    var box = $('inspector');
    box.innerHTML = '';
    ui.probBox = null;
    var sel = ui.sel;
    if (sel && sel.kind === 'unit' && !Flowsheet.findUnit(diagram, sel.name)) sel = ui.sel = null;
    if (sel && sel.kind === 'stream' && !Flowsheet.findStream(diagram, sel.name)) sel = ui.sel = null;
    if (!sel) {
      box.appendChild(el('p', 'muted small', 'Nothing selected. Click a unit or a stream in the drawing to rename it, change its type or connections, or delete it.'));
      return;
    }
    if (sel.kind === 'unit') unitInspector(box, Flowsheet.findUnit(diagram, sel.name));
    else streamInspector(box, Flowsheet.findStream(diagram, sel.name));
  }

  function unitInspector(box, u) {
    box.appendChild(el('h3', null, 'Selected unit'));
    var l1 = el('div', 'line');
    var nameIn = textInput(u.name);
    var types = Object.keys(Balance.UNIT_TYPES).map(function (k) { return { value: k, label: Balance.UNIT_TYPES[k].label }; });
    var typeSel = select(types, u.type);
    l1.appendChild(labelled('Name', nameIn, 'f-name'));
    l1.appendChild(labelled('Type', typeSel, 'f-type'));
    box.appendChild(l1);

    var rxIn = textInput(u.reactions, 'A + 2 B -> C');
    var rxLine = el('div', 'line');
    rxLine.appendChild(labelled('Reaction(s), separated by semicolons. Use the component names from step 1.', rxIn, 'f-rx'));
    rxLine.classList.toggle('hidden', u.type !== 'reactor');
    box.appendChild(rxLine);

    var hint = el('p', 'hintline', Balance.UNIT_TYPES[u.type].hint);
    box.appendChild(hint);
    var probs = el('ul', 'problems');
    box.appendChild(probs);
    ui.probBox = probs;
    updateProblems();

    function commitName() {
      var old = ui.sel.name;
      var r = Flowsheet.renameUnit(diagram, old, nameIn.value);
      if (r.error) { note(r.error); nameIn.value = old; return; }
      note(null);
      nameIn.value = r.name;
      if (r.name !== old) {
        ui.sel.name = r.name;
        var ren = { unit: {} }; ren.unit[old] = r.name;
        dataChanged(ren);
      }
    }
    nameIn.addEventListener('change', commitName);
    commitOnEnter(nameIn, commitName);
    typeSel.addEventListener('change', function () {
      u.type = typeSel.value;
      rxLine.classList.toggle('hidden', u.type !== 'reactor');
      hint.textContent = Balance.UNIT_TYPES[u.type].hint;
      dataChanged();
    });
    rxIn.addEventListener('input', function () { u.reactions = rxIn.value; dataChanged(); });
    commitOnEnter(rxIn, function () { rxIn.blur(); });

    var buttons = el('div', 'buttons');
    buttons.appendChild(button('+ Feed into this unit', 'secondary', function () { newStream(null, u.name); }));
    buttons.appendChild(button('+ Product out of this unit', 'secondary', function () { newStream(u.name, null); }));
    if (u.type === 'reactor') {
      buttons.appendChild(button('Add a conversion for it', 'secondary', function () { addSpecFor({ type: 'conversion', unit: u.name }); }));
    }
    if (energy.on) {
      buttons.appendChild(button('Adiabatic', 'secondary', function () { addSpecFor({ type: 'adiabatic', unit: u.name }); }));
      buttons.appendChild(button('Isothermal', 'secondary', function () { addSpecFor({ type: 'isothermal', unit: u.name }); }));
      buttons.appendChild(button('Add its heat duty', 'secondary', function () { addSpecFor({ type: 'duty', unit: u.name }); }));
    }
    buttons.appendChild(button('Delete unit', 'secondary danger', deleteSelected));
    box.appendChild(buttons);
  }

  function newStream(from, to) {
    var r = Flowsheet.addStream(diagram, from, to);
    if (r.error) { note(r.error); return; }
    note(null);
    ui.sel = { kind: 'stream', name: r.stream.name };
    dataChanged();
    drawInspector();
  }

  function streamInspector(box, s) {
    box.appendChild(el('h3', null, 'Selected stream'));
    var l1 = el('div', 'line');
    var nameIn = textInput(s.name);
    var unitOpts = diagram.units.map(function (u) { return { value: u.name, label: u.name + ' (' + Balance.UNIT_TYPES[u.type].label.toLowerCase() + ')' }; });
    var fromSel = select([{ value: '', label: 'outside (a feed)' }].concat(unitOpts), s.from || '');
    var toSel = select([{ value: '', label: 'outside (a product)' }].concat(unitOpts), s.to || '');
    l1.appendChild(labelled('Name', nameIn, 'f-name'));
    l1.appendChild(labelled('Comes from', fromSel, 'f-end'));
    l1.appendChild(labelled('Goes to', toSel, 'f-end'));
    box.appendChild(l1);

    function commitName() {
      var old = ui.sel.name;
      var r = Flowsheet.renameStream(diagram, old, nameIn.value);
      if (r.error) { note(r.error); nameIn.value = old; return; }
      note(null);
      nameIn.value = r.name;
      if (r.name !== old) {
        ui.sel.name = r.name;
        var ren = { stream: {} }; ren.stream[old] = r.name;
        dataChanged(ren);
      }
    }
    nameIn.addEventListener('change', commitName);
    commitOnEnter(nameIn, commitName);
    [['from', fromSel], ['to', toSel]].forEach(function (pair) {
      pair[1].addEventListener('change', function () {
        var r = Flowsheet.connect(diagram, ui.sel.name, pair[0], pair[1].value);
        if (r.error) { note(r.error); pair[1].value = s[pair[0]] || ''; return; }
        note(null);
        dataChanged();
      });
    });

    if (energy.on) {
      var phSel = select([{ value: 'auto', label: 'Automatic (from its temperature)' }, { value: 'g', label: 'Gas' }, { value: 'l', label: 'Liquid' }, { value: 's', label: 'Solid' }], s.phase || 'auto');
      var lp = el('div', 'line');
      lp.appendChild(labelled('Phase for the energy balance', phSel, 'f-end'));
      box.appendChild(lp);
      box.appendChild(el('p', 'hintline', 'Choose a phase when the temperature is unknown and the stream could boil or condense, or to say that a stream is all vapour or all liquid.'));
      phSel.addEventListener('change', function () { Flowsheet.setStreamPhase(diagram, ui.sel.name, phSel.value); dataChanged(); });
    }

    var buttons = el('div', 'buttons');
    buttons.appendChild(button('Add what I know about this stream', 'secondary', function () { addSpecFor({ type: 'flow', stream: ui.sel.name }); }));
    if (energy.on) buttons.appendChild(button('Add its temperature', 'secondary', function () { addSpecFor({ type: 'temp', stream: ui.sel.name }); }));
    buttons.appendChild(button('Delete stream', 'secondary danger', deleteSelected));
    box.appendChild(buttons);
  }

  /* ───────── showing the result ───────── */

  function fmtv(v) { return v === null || v === undefined ? '?' : Chem.fmt(v, 6); }
  function fmtShort(v) { return v === null || v === undefined ? '?' : Chem.fmt(v, 5); }

  function table(headers, rows, rowClass) {
    var holder = el('div', 'table-wrap'), t = el('table'), th = el('thead'), tb = el('tbody');
    var hr = el('tr');
    headers.forEach(function (h, i) { var c = el('th', i ? 'num' : null, h); hr.appendChild(c); });
    th.appendChild(hr);
    rows.forEach(function (r, k) {
      var tr = el('tr', rowClass ? rowClass(k) : null);
      r.forEach(function (cell, i) {
        var td = el('td', i ? 'num' : null, cell);
        if (cell === '?') td.className += ' unknown';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(th); t.appendChild(tb); holder.appendChild(t);
    return holder;
  }

  function list(items) {
    var ul = el('ul', 'plain');
    items.forEach(function (t) { ul.appendChild(el('li', null, t)); });
    return ul;
  }

  // The drawing with the answers on it. It is a copy of the drawing as it was when Solve was pressed.
  function drawResultDiagram() {
    if (!resultCtl) return;
    var out = resultCtl.out, byStream = {}, byUnit = {};
    out.streams.forEach(function (s) { byStream[s.name] = s; });
    out.units.forEach(function (u) { byUnit[u.name] = u; });
    var box = $('show-comps');
    var showComps = !!(box && box.checked);
    drawDiagram(resultCtl.svg, resultCtl.wrap, resultCtl.dg, {
      id: 'res-svg', minHeight: 200,
      streamLines: function (name) {
        var s = byStream[name];
        if (!s) return [];
        var lines = [{ text: 'F = ' + fmtShort(s.F), cls: s.F === null ? 'fs-unk' : 'fs-val' }];
        if (out.energy) lines.push({ text: 'T = ' + fmtTemp(s.T), cls: s.T === null || s.T === undefined ? 'fs-unk' : 'fs-val' });
        if (showComps) {
          out.comps.forEach(function (c) {
            var v = s.comps[c].n;
            lines.push({ text: c + ' = ' + fmtShort(v), cls: v === null ? 'fs-unk' : 'fs-note' });
          });
        }
        return lines;
      },
      unitLines: function (name) {
        var u = byUnit[name];
        if (!u || !out.energy) return [];
        return [{ text: 'Q = ' + fmtPower(u.Q), cls: u.Q === null || u.Q === undefined ? 'fs-unk' : 'fs-val' }];
      },
      pill: function (name) {
        var u = byUnit[name];
        if (!u) return null;
        return {
          text: 'DOF ' + u.dof, cls: u.dof === 0 ? '' : (u.dof > 0 ? 'warn' : 'bad'),
          tip: 'Degrees of freedom counting only this unit’s own balances and the data about its own streams. 0 means it could be solved on its own.'
        };
      }
    });
  }

  function render(out, dg) {
    var box = $('results');
    box.innerHTML = '';
    resultCtl = null;

    var cls = out.status === 'solved' ? 'good' : (out.status === 'underspecified' ? 'warn' : 'bad');
    box.appendChild(el('div', 'feedback ' + cls, out.headline));

    if (out.errors.length) box.appendChild(list(out.errors));
    if (out.conflicts.length) {
      var h = el('h2', null, 'What does not fit');
      box.appendChild(h);
      box.appendChild(el('p', null, 'These specifications cannot all be true together. Check the numbers you typed, and the basis (moles or mass) you used.'));
      box.appendChild(list(out.conflicts.map(function (c) {
        var t = c.label.replace(/^Specification: /, '');
        return c.shown ? t + '. The other information gives: ' + c.shown + '.' : t + '.';
      })));
    }
    if (out.warnings.length) box.appendChild(list(out.warnings));
    if (out.status === 'error') return;

    /* the drawing with the answers on it */
    if (out.status === 'solved' || out.status === 'underspecified') {
      box.appendChild(el('h2', null, 'Your flowsheet'));
      var tools = el('div', 'res-tools');
      var lab = el('label', 'checkbox');
      var cb = el('input'); cb.type = 'checkbox'; cb.id = 'show-comps';
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode('Show the flow of each component too'));
      tools.appendChild(lab);
      box.appendChild(tools);
      var rwrap = el('div', 'fs-wrap');
      var rsvg = svgEl('svg', { 'class': 'fs-svg', role: 'img', 'aria-label': 'The flowsheet with the solved flows written on each stream.' });
      rwrap.appendChild(rsvg);
      box.appendChild(rwrap);
      resultCtl = { wrap: rwrap, svg: rsvg, dg: dg, out: out };
      cb.addEventListener('change', drawResultDiagram);
      drawResultDiagram();
      box.appendChild(el('p', 'note', 'F is the total flow of the stream' + (out.energy ? ', T its temperature and Q the heat added to a unit (negative: heat removed)' : '') + '. The DOF tag under each unit is its own degrees of freedom: a unit with DOF 0 can be solved on its own.'));
    }

    /* degrees of freedom */
    if (out.dof) {
      box.appendChild(el('h2', null, 'Degrees of freedom'));
      var rows = out.units.map(function (u) { return [u.label + ' ' + u.name, String(u.variables), String(u.equations), String(u.dof)]; });
      rows.push(['Whole flowsheet', String(out.dof.variables), String(out.dof.equations), String(out.dof.dof)]);
      box.appendChild(table(['', 'Variables', 'Equations', 'DOF'], rows, function (k) { return k === rows.length - 1 ? 'hl' : null; }));
      box.appendChild(el('p', 'note', 'DOF = variables − independent equations. Variables are the flow of each component in each stream, plus reaction extents' + (out.energy ? ', a temperature for every stream and a heat duty for every unit' : '') + '. Equations are the material balances' + (out.energy ? ', one energy balance per unit (and the rule that a splitter’s outlets leave at the temperature of its inlet)' : '') + ' plus everything you specified. Each unit row only counts the specifications that involve that unit’s own streams, so it shows where you could start by hand: a unit with DOF 0 can be solved on its own.'));
      if (out.energy) {
        var en = out.energy, mt = en.material;
        box.appendChild(el('p', 'note', 'Split into its two parts: material balances on their own have ' + mt.variables + ' variables, ' + mt.equations + ' equations, DOF ' + mt.dof + '; temperatures and duties have ' + en.variables + ' variables, ' + en.equations + ' equations, DOF ' + en.dof + '. A flow that only an energy balance can fix (the cooling water for an exchanger, say) shows as a material DOF that the energy part removes.'));
      }
    }

    if (out.status === 'underspecified' && out.free.length) {
      box.appendChild(el('h2', null, 'What to specify next'));
      var shown = out.free.slice(0, 40).join(', ') + (out.free.length > 40 ? ', ...' : '');
      box.appendChild(el('p', null, out.dof.dof === 1
        ? 'Knowing any one of these would complete the problem (as a flow, or through a fraction or ratio that involves it): ' + shown
        : 'You need ' + out.dof.dof + ' more independent pieces of information. These quantities are not pinned down yet, so a value (or a fraction or ratio) involving them helps: ' + shown));
    }

    if (out.status === 'inconsistent' || out.status === 'failed') return;

    /* streams */
    box.appendChild(el('h2', null, out.status === 'solved' ? 'Results' : 'What could be found'));
    var heads = ['Stream', 'Total'].concat(out.comps);
    var srows = out.streams.map(function (s) {
      return [s.name + (s.kind === 'feed' ? ' (feed)' : s.kind === 'product' ? ' (product)' : ''), fmtv(s.F)]
        .concat(out.comps.map(function (c) { return fmtv(s.comps[c].n); }));
    });
    box.appendChild(el('h3', null, 'Flows'));
    box.appendChild(table(heads, srows));
    var frows = out.streams.map(function (s) {
      return [s.name].concat(out.comps.map(function (c) { return fmtv(s.comps[c].x); }));
    });
    box.appendChild(el('h3', null, 'Composition (fraction of the stream)'));
    box.appendChild(table(['Stream'].concat(out.comps), frows));
    if (out.energy) {
      box.appendChild(el('h3', null, 'Temperatures and enthalpy flows'));
      box.appendChild(table(['Stream', 'Temperature', 'Phase', 'Enthalpy flow Ḣ (' + resEn.powerUnit + ')'], out.streams.map(function (s) {
        return [s.name, fmtTemp(s.T), s.phase && s.phase !== 'auto' ? PHASE_TEXT[s.phase] : 'from its temperature', s.H === null || s.H === undefined ? '?' : fmtv(Chem.convert('power', s.H, 'kW', resEn.powerUnit))];
      })));
      box.appendChild(el('h3', null, 'Heat duties'));
      box.appendChild(table(['Unit', 'Heat added Q (' + resEn.powerUnit + ')', ''], out.units.map(function (u) {
        var q = u.Q;
        return [u.label + ' ' + u.name, q === null || q === undefined ? '?' : fmtv(Chem.convert('power', q, 'kW', resEn.powerUnit)),
          q === null || q === undefined ? '' : (Math.abs(q) < 1e-9 ? 'no heat exchanged' : (q > 0 ? 'heat added' : 'heat removed'))];
      })));
      box.appendChild(el('p', 'note', out.energy.formation
        ? 'Reference state: the elements at 25 °C and 1 atm, so each enthalpy includes the heat of formation of its species; the heat of reaction is built in. Enthalpy flows are in kW.'
        : 'Reference state: each species at 25 °C and 1 atm in its normal phase (enthalpy zero there). Enthalpy flows are in kW. Pressure effects on enthalpy are neglected.'));
    }
    if (out.extents.length) {
      box.appendChild(el('h3', null, 'Reaction extents'));
      box.appendChild(table(['Reaction', 'Extent'], out.extents.map(function (x) { return [x.name, fmtv(x.value)]; })));
    }
    if (out.undetermined.length) {
      box.appendChild(el('h3', null, 'Still unknown'));
      box.appendChild(el('p', null, out.undetermined.join(', ')));
    }

    /* worked solution */
    if (out.steps.length || out.givens.length) {
      box.appendChild(el('h2', null, 'Solution, step by step'));
      box.appendChild(el('p', 'note', 'n(A,S1) is the flow of component A in stream S1. F(S1) is the total flow of S1. ξ(R1) is the extent of reaction in reactor R1.' + (out.energy ? ' T(S1) is the temperature of S1 in K, Ḣ(S1) its enthalpy flow in kW, and Q(R1) the heat added to unit R1 in kW. In the energy steps the working is in K, kJ/mol and kW.' : '') + ' Each step uses one equation with a single unknown, or a small group that must be solved together. “Overall balance” steps treat the whole flowsheet as one box.'));
      if (out.givens.length) box.appendChild(el('p', null, 'Given: ' + out.givens.map(function (g) { return out.energy && /^T\(/.test(g) ? g + ' K' : (out.energy && /^Q\(/.test(g) ? g + ' kW' : g); }).join(';  ')));
      var ol = el('ol', 'steps');
      out.steps.forEach(function (s) {
        var li = el('li');
        li.appendChild(el('span', 'title', s.title));
        if (s.type === 'single') {
          li.appendChild(el('div', 'eq', s.equation));
          if (s.substituted !== s.equation) li.appendChild(el('div', 'eq sub', '→ ' + s.substituted));
        } else {
          s.equations.forEach(function (q) {
            li.appendChild(el('div', 'eq', q.equation));
            if (q.substituted !== q.equation) li.appendChild(el('div', 'eq sub', '→ ' + q.substituted));
          });
        }
        (s.lines || []).forEach(function (t) { li.appendChild(el('div', 'eq sub', t)); });
        li.appendChild(el('div', 'eq result', s.results.map(function (r) {
          if (r.unit === 'K') return r.name + ' = ' + Balance.num(r.value) + ' K  (' + Balance.num(r.value - 273.15) + ' °C)';
          return r.name + ' = ' + Balance.num(r.value) + (r.unit ? ' ' + r.unit : '');
        }).join(',  ')));
        ol.appendChild(li);
      });
      box.appendChild(ol);
    }
  }

  /* ───────── the energy box ───────── */

  var enSel = { flow: $('en-flow'), temp: $('en-temp'), power: $('en-power') };
  MOL_FLOW.concat(MASS_FLOW).forEach(function (u) { enSel.flow.add(new Option(u + (MASS_FLOW.indexOf(u) >= 0 ? ' (mass)' : ''), u)); });
  Object.keys(Chem.CATEGORIES.temperature.units).forEach(function (u) { enSel.temp.add(new Option(u, u)); });
  Object.keys(Chem.CATEGORIES.power.units).forEach(function (u) { enSel.power.add(new Option(u, u)); });

  var spUid = 0;
  function refreshEnergySpecies() {
    var box = $('en-species'), warn = $('en-warning');
    box.innerHTML = '';
    var comps = Balance.parseList($('components').value), missing = [];
    comps.forEach(function (c) {
      var auto = Energy.findSpecies(energyDB, c);
      var cur = energy.map[c] && energyDB[energy.map[c]] ? energy.map[c] : (auto || '');
      energy.map[c] = cur;
      if (!cur) missing.push(c);
      spUid += 1;
      var row = el('div', 'srow'), f = el('div', 'field f-sp'), l = el('label', null, c);
      l.htmlFor = 'en-sp-' + spUid;
      var sel = el('select'); sel.id = 'en-sp-' + spUid;
      sel.appendChild(new Option('(choose a species)', ''));
      Object.keys(energyDB).forEach(function (id) { sel.appendChild(new Option(energyDB[id].name + ' (' + id + ')', id)); });
      sel.value = cur;
      sel.addEventListener('change', function () { energy.map[c] = sel.value; refreshEnergySpecies(); markStale(); save(); });
      f.appendChild(l); f.appendChild(sel); row.appendChild(f);
      box.appendChild(row);
    });
    warn.textContent = missing.length ? 'Choose a species for ' + missing.join(', ') + '.' : '';
    warn.classList.toggle('hidden', !missing.length || !energy.on);
    if (!comps.length) box.appendChild(el('p', 'muted small', 'Enter the components in step 1 first.'));
  }

  $('en-on').addEventListener('change', function () {
    energy.on = $('en-on').checked;
    $('en-box').classList.toggle('hidden', !energy.on);
    refreshEnergySpecies();
    specRows().forEach(function (r) { r._f.retype(); });
    markStale(); drawEditor(); drawInspector(); save();
  });
  enSel.flow.addEventListener('change', function () { energy.flowUnit = enSel.flow.value; markStale(); save(); });
  $('en-P').addEventListener('input', function () { energy.P = $('en-P').value; markStale(); save(); });
  // a change of unit converts the numbers already typed, so they keep their meaning
  enSel.temp.addEventListener('change', function () {
    var old = energy.tempUnit, nw = enSel.temp.value;
    specRows().forEach(function (r) {
      if (r._f.type.value !== 'temp') return;
      var v = Chem.parseNumber(r._f.value.value);
      if (!isNaN(v)) r._f.value.value = String(Number(Chem.convert('temperature', v, old, nw).toPrecision(10)));
    });
    energy.tempUnit = nw;
    specRows().forEach(function (r) { r._f.relabel(); });
    specsChanged();
  });
  enSel.power.addEventListener('change', function () {
    var old = energy.powerUnit, nw = enSel.power.value;
    specRows().forEach(function (r) {
      if (r._f.type.value !== 'duty') return;
      var v = Chem.parseNumber(r._f.value.value);
      if (!isNaN(v)) r._f.value.value = String(Number(Chem.convert('power', v, old, nw).toPrecision(10)));
    });
    energy.powerUnit = nw;
    specRows().forEach(function (r) { r._f.relabel(); });
    specsChanged();
  });

  /* ───────── wiring ───────── */

  function solve() {
    save();
    var out, dg = Flowsheet.clone(diagram);
    resEn = JSON.parse(JSON.stringify(energy));
    try { out = Balance.analyze(buildModel()); }
    catch (e) { out = { status: 'error', headline: 'Something unexpected went wrong: ' + e.message, errors: [], warnings: [], conflicts: [], units: [], streams: [], extents: [], givens: [], steps: [], undetermined: [], free: [], comps: [], dof: null }; }
    solvedOnce = true;
    $('stale').classList.add('hidden');
    render(out, dg);
    var r = $('results');
    if (r.getBoundingClientRect().top > window.innerHeight * 0.8) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  var exSel = $('example');
  exSel.add(new Option('Choose an example...', ''));
  Balance.EXAMPLES.forEach(function (ex) { exSel.add(new Option(ex.title, ex.id)); });
  var energyGroup = document.createElement('optgroup');
  energyGroup.label = 'With energy balances';
  Balance.ENERGY_EXAMPLES.forEach(function (ex) { energyGroup.appendChild(new Option(ex.title, ex.id)); });
  exSel.appendChild(energyGroup);
  exSel.addEventListener('change', function () {
    var ex = Balance.EXAMPLES.concat(Balance.ENERGY_EXAMPLES).filter(function (e) { return e.id === exSel.value; })[0];
    var d = $('example-desc');
    if (!ex) { d.classList.add('hidden'); return; }
    d.textContent = ex.description;
    d.classList.remove('hidden');
    loadState(stateFromExample(ex));
    solve();
  });

  $('add-spec').addEventListener('click', function () { var r = addSpec({ type: 'flow' }); specsChanged(); r._f.value.focus(); });
  $('solve').addEventListener('click', solve);
  $('clear').addEventListener('click', function () {
    loadState({ components: '', diagram: Flowsheet.empty(), specs: [] });
    $('results').innerHTML = '';
    resultCtl = null; solvedOnce = false;
    $('stale').classList.add('hidden');
    exSel.value = ''; $('example-desc').classList.add('hidden');
    save();
  });
  $('components').addEventListener('input', function () { refreshChoices(); refreshEnergySpecies(); markStale(); save(); });
  $('specs').addEventListener('input', specsChanged);
  $('specs').addEventListener('change', specsChanged);
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (e.key === 'Enter' && t && t.tagName === 'INPUT' && t.type !== 'checkbox' && !(t.closest && t.closest('#inspector'))) {
      e.preventDefault();
      solve();
    }
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { drawEditor(); drawResultDiagram(); }, 150);
  });

  loadEnergyDB();
  setEnergy(null);
  setTool('select');
  var saved = restore();
  if (saved) {
    loadState(saved);
    if (saved.diagram.units.length) solve();
  } else {
    exSel.value = 'mixer';
    exSel.dispatchEvent(new Event('change'));
  }
})();
