# I want to survive Chem Eng too

Calculators for undergraduate chemical engineering that show their working: a mass balance flowsheet solver
with degrees-of-freedom analysis, energy balances, step-by-step integrals and derivatives, electrochemistry,
vapour pressure, ideal gas and a unit converter.
Plain HTML, CSS and JavaScript. No build step, no server needed, and no AI at runtime. The one piece of outside code is
[KaTeX](https://katex.org) (MIT licence), which only typesets formulas; a copy is included in `vendor/katex/`, so the site
has no other dependency and works offline.

| Page | What it does |
| --- | --- |
| `balance.html` | Flowsheet mass balances. You draw the flowsheet (units and streams) on a canvas; it does the DOF analysis, finds redundant or contradictory specifications, solves recycle and purge, writes the step-by-step solution and puts the answers on your drawing |
| `energy.html` | Energy balances: sensible heat, phase changes, heats of formation / reaction / combustion, adiabatic reactor and flame temperature, steady-flow balance, each with its working, plus an editable data table. The flowsheet on `balance.html` can carry the energy balance too (stream temperatures, unit heat duties) |
| `calculus.html` | Integrals (indefinite, definite, improper) and derivatives including partial derivatives, step by step with the rule named at each step, a plot, and every integral verified by differentiating the answer |
| `multi.html` | Double and triple integrals in Cartesian, polar, cylindrical and spherical coordinates: you write the limits innermost first, it does one integral per variable with the working, draws the region (or a wire frame of the solid), swaps the order of integration for regions between curves, and checks the answer against a nested numerical integration of the original function |
| `electro.html` | Faraday's law with current efficiency, Nernst equation and cell potential, ΔG and K, kWh per kg |
| `antoine.html` | Vapour pressure / boiling point from the Antoine equation, with a plot |
| `gas.html` | Ideal gas solver: pick any of P, V, n, T to solve for |
| `units.html` | Unit converter |
| `calculators.html`, `planned.html`, `about.html`, `index.html` | Directory, roadmap, about, home |

## Run it locally

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

then visit http://localhost:8000.

## Put it online (free, GitHub Pages)

1. Push this folder to a GitHub repository (the files in this folder at the repo root).
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.
3. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

## Layout

```
js/chem.js       units, number parsing, Antoine equation, ideal gas (window.Chem)
js/balance.js    mass balance engine: equations, DOF, solver, step-by-step solution (window.Balance)
js/flowsheet.js  the flowsheet drawing as data: editing, layout, stream routing, conversion to the solver's model (window.Flowsheet)
js/electro.js    Faraday's law, Nernst, energy (window.Electro)
js/energy.js     heat capacity, phase change, heats of reaction, adiabatic temperature, open-system balance (window.Energy)
js/cas.js        small computer algebra core: parser, exact simplification, differentiation, polynomials (window.CAS)
js/integrate.js  rule-based step-by-step integrator with verification, definite and improper integrals (window.Integrate)
js/multi.js      double and triple integrals: coordinate systems and Jacobians, iterated integrals, region and solid geometry, change of order (window.Multi)
js/tex.js        turns the plain-text mathematics the calculators print into LaTeX (window.Tex); the page then typesets it with KaTeX
js/ui-kit.js     small DOM helpers shared by the calculus pages, including typeset formulas (window.UIKit)
vendor/katex/    KaTeX 0.19.1 (script, stylesheet, fonts and licence), unchanged
js/site.js       banner, navigation and footer shared by every page; the TOOLS list at the top is the sidebar
js/*-ui.js       the code behind each page (forms and display only, no calculations)
tests/           one test file per library; run-jxa.js runs them on a Mac without Node
```

The libraries have no DOM code, so they run in the browser and in Node and can be tested without a browser.

## Tests

```bash
node tests/chem.test.js
node tests/balance.test.js
node tests/flowsheet.test.js
node tests/electro.test.js
node tests/energy.test.js
node tests/cas.test.js
node tests/integrate.test.js
node tests/multi.test.js
node tests/tex.test.js
```

No Node? On a Mac, `osascript -l JavaScript tests/run-jxa.js "$PWD"` runs every test file with the JavaScript engine that ships with macOS (or name the files: `... "$PWD" cas integrate`).

- `chem`: unit factors and round trips, Antoine constants against known boiling points and 25 °C vapour pressures.
- `balance`: flowsheets solved by hand (mixer, column, splitter, reactor, recycle, recycle with purge), DOF counts per unit, underspecified / redundant / contradictory problems, input validation, and 300 random flowsheets whose every balance and specification is re-checked by separate code.
- `flowsheet`: every example survives drawing → model → solver and gets its hand-worked answer; layout never overlaps units; ports sit on unit edges; no stream runs through a unit or through the text under it (checked on the examples and on 600 random drawings); editing, renaming and reconnecting; live per-unit checks agree with the solver's own errors.
- `energy`: hand-worked cases, Hess's law, ∫Cp dT additive over sub-ranges, adiabatic temperatures that satisfy the balance, and the built-in data checked against NIST-JANAF enthalpy increments, handbook latent heats and heats of formation.
- `cas`: parser round trips and error messages, derivatives against a table and against finite differences on random expressions, simplification never changing a value.
- `integrate`: about 130 classic integrals each re-checked by finite differences, random derivative-then-integrate tests (every answer is verified or the result is "no method"; a wrong answer is never shown), definite and improper integrals against numeric quadrature.
- `multi`: every worked example against its hand value, the conversions to polar / cylindrical / spherical coordinates, random double and triple integrals in all four systems against a separate fixed-panel Gauss–Legendre integrator, symbols as parameters, honest failures (no closed form, divergence, limits that are not real, limits the wrong way round), the picture geometry (shaded area equals the integral of 1), and the change of order on classic regions and on random ones.
- `tex`: fixed cases for every kind of notation; 400 random expressions printed by the algebra core, turned into LaTeX and read back as the same expression; and every line the integrator, the derivative rules and the multiple-integral solver produce (700+ lines of mathematics, 500+ of prose, 200+ rule formulas) cut into words and formulas, with KaTeX checked to accept all of the LaTeX.
- `electro`: grams per ampere-hour for common products against handbook values, Nernst, ΔG, K, energy per kg.

## Adding things

- **A compound:** add an entry to `COMPOUNDS` in `js/chem.js` (constants in `log10(P/bar) = A - B/(T/K + C)` form) and its known boiling point and 25 °C vapour pressure to `NBP` / `P25` in `tests/chem.test.js`. The test tells you if the constants are wrong.
- **An electrolysis product or half-reaction:** add it to `PRODUCTS` / `HALF_REACTIONS` in `js/electro.js`. The tests check molar masses against atomic weights and the ordering of the potentials.
- **A unit type or specification type in the mass balance solver:** the solver is `build()` (turns the problem into equations) and `analyze()` in `js/balance.js`. Add the equations in `build()`, add its entry to `UNIT_TYPES` or `SPEC_TYPES` so the page offers it, and add a worked example to `EXAMPLES` with the answer worked out by hand: every example is automatically tested.
- **A species in the energy balance data:** add it to `SPECIES` in `js/energy.js` with its source in a comment, and add its checks (enthalpy increment, heat of formation, latent heat) to `tests/energy.test.js`.
- **An integration rule:** add a rule function to `RULES` in `js/integrate.js` (the list is tried in order, the way a student would). Whatever it returns is verified by differentiating, so a wrong rule shows up as "no method" rather than a wrong answer; add the integral to the table in `tests/integrate.test.js`.
- **A new kind of unit:** besides `UNIT_TYPES` and `build()` in `js/balance.js`, add its prefix to `PREFIX` in `js/flowsheet.js` (so new units get a sensible name), its rules to `unitProblems()`, and its shape to `unitShape()` in `js/balance-ui.js`.
- **A new tool page:** copy `gas.html` and `js/gas.js`, and add the page to the `TOOLS` list at the top of `js/site.js`.

## Data caveat

The built-in data (Antoine constants, electrode potentials, molar masses, and the heat capacities, heats of formation and
latent heats of the energy balances) are standard published values, sanity-checked by the tests. The energy balance data
are taken from Felder & Rousseau, *Elementary Principles of Chemical Processes*, Appendix B, and cross-checked against
NIST-JANAF and handbook values. Textbooks differ in the last digit: check them against your own course tables before
relying on them for assessed work. The energy page lets you type your own values.
