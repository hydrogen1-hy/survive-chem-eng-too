/* Tiny dependency-free SVG line chart. Colours come from CSS classes so it follows light/dark mode. */
(function (root) {
  var NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function niceStep(range, count) {
    var raw = range / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  function linTicks(min, max, count) {
    var step = niceStep(max - min, count), out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
    return out;
  }
  function logTicks(min, max) {
    var lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max)), out = [];
    var mults = (hi - lo) <= 3 ? [1, 2, 5] : [1];
    for (var d = lo; d <= hi; d++) mults.forEach(function (m) { out.push(m * Math.pow(10, d)); });
    return out;
  }

  /* opts: { points: [[x,y]...], marker: [x,y]|null, xLabel, yLabel, logY, yFmt, xFmt } */
  function lineChart(svg, opts) {
    // Draw at the container's real width so text stays a readable size on phones.
    var W = Math.max(300, Math.round(svg.getBoundingClientRect().width || 640));
    var H = Math.round(Math.max(250, Math.min(380, W * 0.56)));
    var M = W < 480 ? { l: 52, r: 12, t: 14, b: 46 } : { l: 66, r: 20, t: 16, b: 50 };
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.textContent = '';

    var pts = opts.points.filter(function (p) { return isFinite(p[0]) && isFinite(p[1]) && (!opts.logY || p[1] > 0); });
    if (pts.length < 2) {
      svg.appendChild(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', 'class': 'axis-label' }, 'No valid points to plot for these constants'));
      return;
    }
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
    var xt = linTicks(xmin, xmax, Math.max(3, Math.min(8, Math.floor((W - M.l - M.r) / 80)))), yt;
    if (opts.logY) {
      yt = logTicks(ymin, ymax);
      ymin = yt[0]; ymax = yt[yt.length - 1];
    } else {
      ymin = 0; yt = linTicks(0, ymax * 1.05, 5); ymax = yt[yt.length - 1];
    }

    var pw = W - M.l - M.r, ph = H - M.t - M.b;
    var px = function (x) { return M.l + (x - xmin) / (xmax - xmin) * pw; };
    var py = opts.logY
      ? function (y) { return M.t + ph - (Math.log10(y) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin)) * ph; }
      : function (y) { return M.t + ph - (y - ymin) / (ymax - ymin) * ph; };
    var xf = opts.xFmt || function (v) { return String(v); };
    var yf = opts.yFmt || function (v) { return String(v); };

    yt.forEach(function (v) {
      var y = py(v);
      svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, 'class': 'grid-line' }));
      svg.appendChild(el('text', { x: M.l - 8, y: y + 4, 'text-anchor': 'end', 'class': 'tick' }, yf(v)));
    });
    xt.forEach(function (v) {
      var x = px(v);
      svg.appendChild(el('line', { x1: x, x2: x, y1: M.t + ph, y2: M.t + ph + 5, 'class': 'axis' }));
      svg.appendChild(el('text', { x: x, y: M.t + ph + 19, 'text-anchor': 'middle', 'class': 'tick' }, xf(v)));
    });
    svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: M.t + ph, y2: M.t + ph, 'class': 'axis' }));
    svg.appendChild(el('line', { x1: M.l, x2: M.l, y1: M.t, y2: M.t + ph, 'class': 'axis' }));

    svg.appendChild(el('text', { x: M.l + pw / 2, y: H - 8, 'text-anchor': 'middle', 'class': 'axis-label' }, opts.xLabel || ''));
    svg.appendChild(el('text', { x: 14, y: M.t + ph / 2, 'text-anchor': 'middle', 'class': 'axis-label', transform: 'rotate(-90 14 ' + (M.t + ph / 2) + ')' }, opts.yLabel || ''));

    svg.appendChild(el('polyline', {
      'class': 'line',
      points: pts.map(function (p) { return px(p[0]).toFixed(1) + ',' + py(p[1]).toFixed(1); }).join(' ')
    }));

    var m = opts.marker;
    if (m && isFinite(m[0]) && isFinite(m[1]) && m[0] >= xmin && m[0] <= xmax && m[1] >= ymin && m[1] <= ymax && (!opts.logY || m[1] > 0)) {
      var mx = px(m[0]), my = py(m[1]);
      svg.appendChild(el('line', { x1: mx, x2: mx, y1: my, y2: M.t + ph, 'class': 'dot-guide' }));
      svg.appendChild(el('line', { x1: M.l, x2: mx, y1: my, y2: my, 'class': 'dot-guide' }));
      svg.appendChild(el('circle', { cx: mx, cy: my, r: 5.5, 'class': 'dot' }));
      var right = mx < M.l + pw * 0.6;
      var nearBottom = my > M.t + ph - 28;     // keep the label off the x-axis tick labels
      svg.appendChild(el('text', {
        x: right ? mx + 10 : mx - 10,
        y: right ? (nearBottom ? my - 12 : my + 18) : my - 10,
        'text-anchor': right ? 'start' : 'end', 'class': 'dot-label'
      }, xf(m[0]) + ', ' + yf(m[1])));
    }
  }

  root.SimpleChart = { lineChart: lineChart };
})(window);
