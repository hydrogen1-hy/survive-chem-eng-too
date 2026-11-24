/* Shared banner, nav bar, sidebar and footer, injected so every page stays in sync. */
(function () {
  var SITE = 'I want to survive Chem Eng too';

  // Every calculator page, grouped by course. Add a tool here and it shows up in the sidebar.
  var TOOLS = [
    ['Process engineering', [
      ['balance.html', 'Mass balances'],
      ['energy.html', 'Energy balances'],
      ['electro.html', 'Electrochemistry'],
      ['antoine.html', 'Vapour pressure'],
      ['gas.html', 'Ideal gas']
    ]],
    ['Calculus 3', [
      ['calculus.html', 'Integrals and derivatives'],
      ['multi.html', 'Double and triple integrals']
    ]],
    ['General', [
      ['units.html', 'Unit converter']
    ]]
  ];
  var TOOL_PAGES = [];
  TOOLS.forEach(function (g) { g[1].forEach(function (t) { TOOL_PAGES.push(t[0]); }); });
  TOOL_PAGES.push('calculators.html');

  // Top nav: [label, page it links to, pages that count as "inside" this section]
  var SECTIONS = [
    ['Home', 'index.html', ['index.html']],
    ['Calculators', 'calculators.html', TOOL_PAGES],
    ['Roadmap', 'planned.html', ['planned.html']],
    ['About', 'about.html', ['about.html']]
  ];

  var GROUPS = TOOLS.concat([
    ['This site', [['calculators.html', 'All calculators'], ['planned.html', 'Roadmap'], ['about.html', 'About']]]
  ]);

  // "/repo/balance" (no extension) and "/repo/" should still match their pages
  var here = location.pathname.split('/').pop() || 'index.html';
  if (here.indexOf('.') < 0) here += '.html';

  var header = document.getElementById('site-header');
  if (header) {
    var nav = SECTIONS.map(function (s) {
      return '<a href="' + s[1] + '"' + (s[2].indexOf(here) >= 0 ? ' aria-current="page"' : '') + '>' + s[0] + '</a>';
    }).join('');
    header.innerHTML =
      '<div class="banner"><div class="wrap">' +
      '<a class="site-title" href="index.html">' + SITE + '</a>' +
      '<p class="tagline">Calculators that show their working, for undergraduate chemical engineering.</p>' +
      '</div></div>' +
      '<nav class="topnav" aria-label="Main"><div class="wrap">' + nav + '</div></nav>';
  }

  var main = document.querySelector('main');
  if (main) {
    var layout = document.createElement('div');
    layout.className = 'layout';
    var aside = document.createElement('aside');
    aside.className = 'sidebar';
    aside.setAttribute('aria-label', 'Pages');
    aside.innerHTML = GROUPS.map(function (g) {
      return '<div class="box"><h2>' + g[0] + '</h2>' + g[1].map(function (l) {
        return '<a href="' + l[0] + '"' + (l[0] === here ? ' aria-current="page"' : '') + '>' + l[1] + '</a>';
      }).join('') + '</div>';
    }).join('');
    main.parentNode.insertBefore(layout, main);
    layout.appendChild(aside);
    layout.appendChild(main);
    main.className = 'content';
  }

  var footer = document.getElementById('site-footer');
  if (footer) {
    footer.className = 'site-footer';
    footer.innerHTML = '<div class="wrap">' + SITE + '. Check constants and data against your course tables before relying on a result.</div>';
  }
})();
