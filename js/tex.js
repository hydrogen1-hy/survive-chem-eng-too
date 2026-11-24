/*
 * Tex: turns the plain-text mathematics that the calculators print (x²/2, √(x² + 1), 3x³y²/2 + 1/x, F(4) − F(0) = ...)
 * into LaTeX, so the pages can typeset it with KaTeX. Plain deterministic code: no AI, no network, no DOM.
 * Works in the browser (window.Tex) and in Node.
 *
 * Why it reads text and does not change the solvers: the solvers return plain strings that the tests check and that
 * can be copied as they are. This file is only the last step before the screen.
 *
 * API
 *   Tex.math(text)       -> LaTeX string, or null when the text is not a mathematical expression it understands
 *   Tex.segments(line)   -> [{text}, {math, tex}, ...]   a line of prose with mathematics in it, cut into pieces:
 *                           the words stay words and every stretch of mathematics becomes {math: original text, tex}
 *   Tex.OVERRIDES        exact line -> LaTeX, for the few formulas that contain words (N/D = quotient + remainder/D)
 *
 * What the math reader understands (it is the notation CAS.toString prints, plus the usual ways of writing it):
 *   numbers, letters, Greek names (theta, rho, phi, pi ...) and characters (θ ρ φ π ...), implicit multiplication,
 *   + − · * / ^ and the superscript digits, √(...), sin cos tan ... ln log exp abs, |x|, brackets, ∞, ∫, d/dx and ∂/∂x,
 *   differentials (dx, dy, dθ), relations (= ≈ ≠ ≤ ≥ →), primes, degrees, and a gap of two or more spaces (shown as a gap).
 *   "∫ from a to b of ..." is read as an integral with limits.
 * A slash makes a fraction of everything multiplied together before it and the next factor after it, which is exactly
 * how the calculators print fractions (3x³y²/2 is (3x³y²) over 2; 1/(x + 1) is 1 over x + 1).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tex = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ═════════════════════ vocabulary ═════════════════════ */

  const FUNCS = {
    sin: '\\sin ', cos: '\\cos ', tan: '\\tan ', cot: '\\cot ', sec: '\\sec ', csc: '\\csc ',
    sinh: '\\sinh ', cosh: '\\cosh ', tanh: '\\tanh ', coth: '\\coth ', sech: '\\operatorname{sech}', csch: '\\operatorname{csch}',
    arcsin: '\\arcsin ', arccos: '\\arccos ', arctan: '\\arctan ', arccot: '\\operatorname{arccot}',
    asin: '\\arcsin ', acos: '\\arccos ', atan: '\\arctan ',
    arsinh: '\\operatorname{arsinh}', arcosh: '\\operatorname{arcosh}', artanh: '\\operatorname{artanh}',
    arcsinh: '\\operatorname{arsinh}', arccosh: '\\operatorname{arcosh}', arctanh: '\\operatorname{artanh}',
    ln: '\\ln ', log: '\\log ', exp: '\\exp ', sign: '\\operatorname{sign}', sgn: '\\operatorname{sgn}',
    sqrt: 'SQRT', abs: 'ABS'
  };
  const GREEK = {
    alpha: '\\alpha ', beta: '\\beta ', gamma: '\\gamma ', delta: '\\delta ', epsilon: '\\varepsilon ', zeta: '\\zeta ', eta: '\\eta ',
    theta: '\\theta ', iota: '\\iota ', kappa: '\\kappa ', lambda: '\\lambda ', mu: '\\mu ', nu: '\\nu ', xi: '\\xi ', pi: '\\pi ',
    rho: '\\rho ', sigma: '\\sigma ', tau: '\\tau ', upsilon: '\\upsilon ', phi: '\\varphi ', chi: '\\chi ', psi: '\\psi ', omega: '\\omega '
  };
  const GREEK_CH = {
    'α': GREEK.alpha, 'β': GREEK.beta, 'γ': GREEK.gamma, 'δ': GREEK.delta, 'ε': GREEK.epsilon, 'ζ': GREEK.zeta, 'η': GREEK.eta, 'θ': GREEK.theta,
    'ι': GREEK.iota, 'κ': GREEK.kappa, 'λ': GREEK.lambda, 'μ': GREEK.mu, 'ν': GREEK.nu, 'ξ': GREEK.xi, 'π': GREEK.pi, 'ρ': GREEK.rho,
    'σ': GREEK.sigma, 'τ': GREEK.tau, 'υ': GREEK.upsilon, 'φ': GREEK.phi, 'ϕ': '\\phi ', 'χ': GREEK.chi, 'ψ': GREEK.psi, 'ω': GREEK.omega,
    'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ', 'Ξ': '\\Xi ', 'Π': '\\Pi ', 'Σ': '\\Sigma ', 'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega '
  };
  const WORDS = Object.keys(FUNCS).concat(Object.keys(GREEK), ['inf']).sort((a, b) => b.length - a.length);
  const SUPCH = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+', 'ⁿ': 'n', 'ⁱ': 'i',
    'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵏ': 'k', 'ᵐ': 'm', 'ᵖ': 'p', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z' };
  const SUBCH = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
  const REL = {
    '=': '=', '≈': '\\approx ', '≠': '\\neq ', '≤': '\\leq ', '≥': '\\geq ', '<': '<', '>': '>', '→': '\\to ', '←': '\\leftarrow ',
    '⇒': '\\Rightarrow ', '⇔': '\\Leftrightarrow ', '≡': '\\equiv ', '∝': '\\propto ', '∈': '\\in ', '≪': '\\ll ', '≫': '\\gg '
  };

  class Fail extends Error {}
  const fail = m => { throw new Fail(m); };

  const isGreekWord = w => Object.prototype.hasOwnProperty.call(GREEK, w) && w !== 'pi';
  function varTex(name) {
    if (Object.prototype.hasOwnProperty.call(GREEK, name)) return GREEK[name];
    if (GREEK_CH[name]) return GREEK_CH[name];
    if (name === 'e') return '\\mathrm{e}';
    return name;
  }

  /* ═════════════════════ reading the text ═════════════════════ */

  function lex(src) {
    const toks = [];
    const n = src.length;
    let i = 0;
    const push = t => { toks.push(t); };
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) {
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        if (j - i >= 2 && toks.length && j < n) push({ k: 'gap' });
        i = j; continue;
      }
      const rest = src.slice(i);
      let m;
      // an integral with its limits: ∫ from A to B of ...  (the limits are kept apart by the line cutter below)
      if ((m = /^∫\uE000([^\uE001]*)\uE001([^\uE002]*)\uE002/.exec(rest))) {
        const a = math(m[1].replace(/\uE003/g, ' ')), b = math(m[2].replace(/\uE003/g, ' '));
        if (a === null || b === null) fail('limits');
        push({ k: 'int', tex: '\\int_{' + a + '}^{' + b + '}' });
        i += m[0].length; continue;
      }
      // d/dx, d²/dx², ∂/∂x
      if ((m = /^([d∂])([²³⁴⁵⁶⁷⁸⁹]?)\/\1(theta|rho|phi|[A-Za-zθρφ])([²³⁴⁵⁶⁷⁸⁹]?)(?![A-Za-z])/.exec(rest))) {
        const op = m[1] === 'd' ? '\\mathrm{d}' : '\\partial ';
        const top = m[2] ? '^{' + SUPCH[m[2]] + '}' : '', bot = m[4] ? '^{' + SUPCH[m[4]] + '}' : '';
        push({ k: 'frac', tex: '\\frac{' + op + top + '}{' + op + varTex(m[3]) + bot + '}' });
        i += m[0].length; continue;
      }
      if ((m = /^\d+(?:\.\d+)?(?:e[+-]?\d+(?![A-Za-z]))?/.exec(rest))) {
        const em = /^([\d.]+)e([+-]?\d+)$/.exec(m[0]);
        push({ k: 'num', tex: em ? em[1] + '\\times 10^{' + em[2] + '}' : m[0] });
        i += m[0].length; continue;
      }
      if ((m = /^[A-Za-z]+/.exec(rest))) {
        splitWord(m[0], src[i + m[0].length]).forEach(push);
        i += m[0].length; continue;
      }
      if (c === '\u0304') {                                  // a bar over the letter before it: x̄
        const last = toks[toks.length - 1];
        if (!last || last.k !== 'id') fail('bar');
        last.tex = '\\bar{' + last.tex.trim() + '}';
        i++; continue;
      }
      if (GREEK_CH[c]) { push({ k: 'id', tex: GREEK_CH[c] }); i++; continue; }
      if (SUPCH[c] !== undefined) {
        let s = '';
        while (i < n && SUPCH[src[i]] !== undefined) { s += SUPCH[src[i]]; i++; }
        push({ k: 'sup', tex: s }); continue;
      }
      if (SUBCH[c] !== undefined) {
        let s = '';
        while (i < n && SUBCH[src[i]] !== undefined) { s += SUBCH[src[i]]; i++; }
        push({ k: 'sub', tex: s }); continue;
      }
      i++;
      switch (c) {
        case '+': push({ k: 'op', tex: '+' }); break;
        case '-': case '−': case '–': push({ k: 'op', tex: '-' }); break;
        case '±': push({ k: 'op', tex: '\\pm ' }); break;
        case '∓': push({ k: 'op', tex: '\\mp ' }); break;
        case '·': case '*': case '⋅': push({ k: 'mul', tex: '\\cdot ' }); break;
        case '×': push({ k: 'mul', tex: '\\times ' }); break;
        case '÷': push({ k: 'mul', tex: '\\div ' }); break;
        case '/': push({ k: 'slash' }); break;
        case '^': push({ k: 'caret' }); break;
        case '√': push({ k: 'sqrt' }); break;
        case '∫': push({ k: 'int', tex: '\\int ' }); break;
        case '∞': push({ k: 'const', tex: '\\infty ' }); break;
        case '∂': push({ k: 'const', tex: '\\partial ' }); break;
        case '∇': push({ k: 'const', tex: '\\nabla ' }); break;
        case '…': push({ k: 'const', tex: '\\ldots ' }); break;
        case '°': push({ k: 'sup', tex: '\\circ' }); break;
        case '′': case '’': case '\'': push({ k: 'prime' }); break;
        case '!': push({ k: 'fact' }); break;
        case ',': push({ k: 'punct', tex: ',\\ ' }); break;
        case ';': push({ k: 'punct', tex: ';\\ ' }); break;
        case ':': push({ k: 'punct', tex: '\\colon\\ ' }); break;
        case '(': case ')': case '[': case ']': case '{': case '}': case '|': push({ k: c }); break;
        default:
          if (REL[c] !== undefined) push({ k: 'rel', tex: REL[c] });
          else fail('character ' + c);
      }
    }
    return toks;
  }

  /* a run of ASCII letters becomes a function name, a Greek letter, a differential, or single-letter variables */
  function splitWord(run, next) {
    const out = [];
    if (Object.prototype.hasOwnProperty.call(FUNCS, run)) return [{ k: 'fn', name: run, tex: FUNCS[run] }];
    if (run === 'inf') return [{ k: 'const', tex: '\\infty ' }];
    if (run === 'pi') return [{ k: 'id', tex: GREEK.pi }];
    if (Object.prototype.hasOwnProperty.call(GREEK, run)) return [{ k: 'id', tex: GREEK[run] }];
    if (run.length === 2 && run[0] === 'd') return [{ k: 'id', tex: '\\,\\mathrm{d}' + varTex(run[1]) }];
    if (run[0] === 'd' && isGreekWord(run.slice(1))) return [{ k: 'id', tex: '\\,\\mathrm{d}' + varTex(run.slice(1)) }];
    if (run === 'd' && next && GREEK_CH[next] && next !== 'π') return [{ k: 'diffnext' }];
    let pos = 0, singles = 0;
    while (pos < run.length) {
      let w = null;
      for (const cand of WORDS) if (run.startsWith(cand, pos)) { w = cand; break; }
      if (w) {
        singles = 0;
        out.push(splitWord(w)[0]);
        pos += w.length;
      } else {
        if (++singles > 3) fail('word');
        out.push({ k: 'id', tex: varTex(run[pos]) });
        pos++;
      }
    }
    return out;
  }

  /* ═════════════════════ parsing ═════════════════════ */

  function parse(tokensIn) {
    // 'd' followed by a Greek character is a differential: fold the two tokens into one
    const tokens = [];
    for (let t = 0; t < tokensIn.length; t++) {
      if (tokensIn[t].k === 'diffnext') {
        const g = tokensIn[t + 1];
        if (!g || g.k !== 'id') fail('differential');
        tokens.push({ k: 'id', tex: '\\,\\mathrm{d}' + g.tex });
        t++;
      } else tokens.push(tokensIn[t]);
    }
    let i = 0, absOpen = 0;
    const peek = () => tokens[i];
    const isClose = t => t.k === ')' || t.k === ']' || t.k === '}' || (t.k === '|' && absOpen > 0);
    const startsAtom = t => !!t && (t.k === 'num' || t.k === 'id' || t.k === 'fn' || t.k === '(' || t.k === '[' || t.k === '{' || t.k === 'sqrt' ||
      t.k === 'int' || t.k === 'frac' || t.k === 'const' || (t.k === '|' && absOpen === 0));

    function parseRel() {
      let out = '';
      for (;;) {
        const t = peek();
        if (!t || isClose(t)) break;
        if (t.k === 'rel' || t.k === 'punct') { out += t.tex; i++; continue; }
        if (t.k === 'gap') { out += '\\quad '; i++; continue; }
        out += parseExpr();
      }
      return out;
    }

    function parseExpr() {
      let out = '';
      for (;;) {
        const t = peek();
        if (t && t.k === 'op') { out += t.tex; i++; }
        out += parseTerm();
        const nx = peek();
        if (!(nx && nx.k === 'op')) break;
      }
      return out;
    }

    function joinItems(items, stripGroup) {
      if (stripGroup && items.length === 1 && items[0].group) return items[0].inner;
      let s = '';
      // a differential that starts a product has no integrand before it to be spaced from
      if (items.length && /^\\,/.test(items[0].tex)) items = [Object.assign({}, items[0], { tex: items[0].tex.replace(/^(\\,)+/, '') })].concat(items.slice(1));
      items.forEach((it, k) => {
        if (k > 0 && items[k - 1].num && it.num) s += '\\,';
        s += it.tex;
      });
      return s;
    }

    function parseTerm() {
      let items = [parseFactor()];
      for (;;) {
        const t = peek();
        if (!t) break;
        if (t.k === 'slash') {
          i++;
          if (!peek()) fail('slash');
          const den = parseFactor();
          // an integral sign is not part of the numerator: ∫ 1/u du is the integral of the fraction 1/u
          let lastInt = -1;
          items.forEach((it, q) => { if (it.int) lastInt = q; });
          const pre = items.slice(0, lastInt + 1), numItems = items.slice(lastInt + 1);
          if (!numItems.length) fail('slash');
          const numTex = joinItems(numItems, true).replace(/^(\\,)+/, '');
          items = pre.concat([{ tex: '\\frac{' + numTex + '}{' + (den.group ? den.inner : den.tex) + '}' }]);
          continue;
        }
        if (t.k === 'mul') { i++; items.push({ tex: t.tex }); items.push(parseFactor()); continue; }
        if (startsAtom(t)) { items.push(parseFactor()); continue; }
        break;
      }
      return joinItems(items, false);
    }

    function parseFactor() {
      const t = peek();
      if (!t) fail('end');
      if (t.k === 'op') { i++; const f = parseFactor(); return { tex: t.tex + f.tex }; }
      let a = parseAtom();
      for (;;) {
        const n = peek();
        if (!n) break;
        if (n.k === 'sup' || n.k === 'caret') {
          i++;
          const ex = n.k === 'sup' ? n.tex : parseExponent();
          a = { tex: (a.sup ? '{' + a.tex + '}' : a.tex) + '^{' + ex + '}', sup: true, num: false };
          continue;
        }
        if (n.k === 'sub') { i++; a = { tex: a.tex + '_{' + n.tex + '}', num: false, sup: a.sup }; continue; }
        if (n.k === 'prime') { i++; a = { tex: a.tex + '\'', num: false, sup: a.sup }; continue; }
        if (n.k === 'fact') { i++; a = { tex: a.tex + '!', num: false }; continue; }
        break;
      }
      return a;
    }

    function parseExponent() {
      const t = peek();
      if (!t) fail('exponent');
      if (t.k === '(') { i++; const inner = parseRel(); expect(')'); return inner; }
      if (t.k === 'op') { i++; return t.tex + parseExponent(); }
      if (t.k === 'num' || t.k === 'id' || t.k === 'const') { i++; return t.tex; }
      return fail('exponent');
    }

    function expect(k) {
      const t = peek();
      if (!t || t.k !== k) fail('expected ' + k);
      i++;
    }

    function parseGroup(open, close, l, r) {
      i++;
      const inner = parseRel();
      expect(close);
      // wrapped in braces so TeX treats the whole bracket as one letter: no stray gaps in f(x) or 3(x + 1)
      return { tex: '{\\left' + l + inner + '\\right' + r + '}', group: true, inner };
    }

    function parseAtom() {
      const t = peek();
      if (!t) fail('end');
      switch (t.k) {
        case 'num': i++; return { tex: t.tex, num: true };
        case 'id': case 'const': case 'frac': i++; return { tex: t.tex };
        case 'int': i++; return { tex: t.tex, int: true };
        case 'fn': return parseFn();
        case '(': return parseGroup('(', ')', '(', ')');
        case '[': return parseGroup('[', ']', '[', ']');
        case '{': return parseGroup('{', '}', '\\{', '\\}');
        case '|': {
          i++; absOpen++;
          const inner = parseRel();
          absOpen--;
          expect('|');
          return { tex: '{\\left|' + inner + '\\right|}', group: false };
        }
        case 'sqrt': {
          i++;
          const a = peek();
          if (!a) fail('sqrt');
          if (a.k === '(') { const g = parseGroup('(', ')', '(', ')'); return { tex: '\\sqrt{' + g.inner + '}' }; }
          if (a.k === 'num' || a.k === 'id' || a.k === 'const') { i++; return { tex: '\\sqrt{' + a.tex + '}' }; }
          return fail('sqrt');
        }
        default: return fail('unexpected ' + t.k);
      }
    }

    function parseFn() {
      const t = tokens[i++];
      if (t.name === 'sqrt' || t.name === 'abs') {
        if (!peek() || peek().k !== '(') fail('function');
        const g = parseGroup('(', ')', '(', ')');
        return { tex: t.name === 'sqrt' ? '\\sqrt{' + g.inner + '}' : '{\\left|' + g.inner + '\\right|}' };
      }
      let sup = '';
      while (peek() && peek().k === 'sup') { sup += peek().tex; i++; }
      let out = t.tex + (sup ? '^{' + sup + '}' : '');
      const n = peek();
      if (n && n.k === '(') out += parseGroup('(', ')', '(', ')').tex;
      else if (n && (n.k === 'num' || n.k === 'id' || n.k === 'const' || n.k === 'sqrt' || n.k === '[' || (n.k === '|' && absOpen === 0))) {
        out += ' ' + parseFactor().tex;
      }
      return { tex: out, sup: !!sup };
    }

    const tex = parseRel();
    if (i !== tokens.length) fail('trailing');
    return tex;
  }

  function math(text) {
    try {
      const toks = lex(String(text));
      if (!toks.length) return null;
      return parse(toks).replace(/\s+/g, ' ').replace(/^(\\,)+/, '').trim();
    } catch (e) {
      if (e instanceof Fail) return null;
      throw e;
    }
  }

  /* ═════════════════════ cutting a line into words and mathematics ═════════════════════ */

  const OVERRIDES = {
    'N/D = quotient + remainder/D': '\\frac{N}{D} = \\text{quotient} + \\frac{\\text{remainder}}{D}'
  };

  // words of two or three letters that look like products of variables but are English
  const STOP = new Set(('ab ad am an and any are as at bar bay by can cap day do far fax fry gap gas had has map may nap pad pan par pay run ' +
    'sad sat say set sub sum sun tab tap tar tax try use us van was way wry yet yard').split(' '));
  const VARSET = 'xyzuvwtrsabcnkmpqdfg';       // letters that may be glued together as a product of two variables
  const VARSET3 = 'xyzuvwtr';                  // and of three

  function runReadable(r) {
    if (r.length === 1) return true;
    if (Object.prototype.hasOwnProperty.call(FUNCS, r) || Object.prototype.hasOwnProperty.call(GREEK, r) || r === 'inf') return true;
    if (STOP.has(r)) return false;
    if (/^d[A-Za-z]$/.test(r) || (r[0] === 'd' && isGreekWord(r.slice(1)))) return true;
    if (/^[A-D][xyzuvw]$/.test(r)) return true;                // a coefficient times a variable: Bx, Dx
    const set = r.length === 2 ? VARSET : VARSET3;
    return r.length <= 3 && r.split('').every(ch => set.indexOf(ch) >= 0);
  }
  const MATHCHAR = new RegExp('[0-9=+−*/^·√∫∞≈≠≤≥<>→←⇒|′°…±×÷∂∇\u0304₀₁₂₃₄₅₆₇₈₉' + Object.keys(SUPCH).join('') + ']');

  // M: mathematics, T: a word, B: only brackets (takes the class of a neighbour)
  function wordClass(core) {
    if (!core) return 'B';
    if (/^[α-ωΑ-Ω]$/.test(core)) return 'M';
    const runs = core.match(/[A-Za-z]+/g) || [];
    if (!runs.every(runReadable)) return 'T';
    if (/^[A-Za-z]+$/.test(core)) return 'M';
    if (MATHCHAR.test(core) || /[α-ωΑ-Ω]/.test(core) || /^[-+]$/.test(core)) return 'M';
    if (/[A-Za-z]\(/.test(core)) return 'M';
    return 'T';
  }

  function unbalanced(s) {                  // [leading unmatched openers, trailing unmatched closers]
    const stack = [];
    let extraClose = 0;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === '(' || ch === '[' || ch === '{') stack.push(k);
      else if (ch === ')' || ch === ']' || ch === '}') { if (stack.length) stack.pop(); else extraClose++; }
    }
    return { open: stack, close: extraClose };
  }

  function segments(lineIn) {
    const line = String(lineIn);
    if (Object.prototype.hasOwnProperty.call(OVERRIDES, line)) return [{ math: line, tex: OVERRIDES[line] }];
    // protect "∫ from A to B of": one chunk with markers, spaces inside the limits replaced by a placeholder
    const marked = line.replace(/∫ from (.+?) to (.+?) of (?=\S)/g, (all, a, b) => '∫\uE000' + a.replace(/ /g, '\uE003') + '\uE001' + b.replace(/ /g, '\uE003') + '\uE002 ');
    const restore = s => s.replace(/∫\uE000([^\uE001]*)\uE001([^\uE002]*)\uE002/g, (all, a, b) => '∫ from ' + a.replace(/\uE003/g, ' ') + ' to ' + b.replace(/\uE003/g, ' ') + ' of');

    const chunks = [];
    const re = /(\s+)|(\S+)/g;
    let m, pendingWs = '';
    while ((m = re.exec(marked))) {
      if (m[1] !== undefined) pendingWs = m[1];
      else { chunks.push({ s: m[2], ws: pendingWs }); pendingWs = ''; }
    }
    const trailingWs = pendingWs;

    // classify each chunk
    chunks.forEach(ch => {
      let core = ch.s, trail = '';
      const tm = /^(.*?)([.,;:!?]+)$/.exec(core);
      if (tm && tm[1]) { core = tm[1]; trail = tm[2]; }
      ch.trail = trail;
      const inner = core.replace(/^[(\[{]+/, '').replace(/[)\]}]+$/, '');
      ch.cls = /^∫\uE000/.test(core) ? 'M' : wordClass(inner);
      ch.core = core;
    });
    // the article "a" is a word, not a variable, when another word follows
    chunks.forEach((ch, k) => {
      const inner = ch.core.replace(/^[(\[{]+/, '').replace(/[)\]}]+$/, '');
      if ((inner === 'a' || inner === 'A') && ch.cls === 'M') {
        const nx = chunks[k + 1];
        if (nx && nx.cls === 'T' && /^[A-Za-z]{2,}/.test(nx.core) && !ch.trail) ch.cls = 'T';
      }
    });
    // bracket-only chunks take the class of a neighbour that is mathematics
    chunks.forEach((ch, k) => {
      if (ch.cls !== 'B') return;
      const pv = chunks[k - 1], nx = chunks[k + 1];
      ch.cls = (pv && pv.cls === 'M') || (nx && nx.cls === 'M') ? 'M' : 'T';
    });

    // gather runs of mathematics
    const out = [];
    const addText = s => { if (!s) return; const last = out[out.length - 1]; if (last && last.text !== undefined) last.text += s; else out.push({ text: s }); };
    let k = 0;
    while (k < chunks.length) {
      const ch = chunks[k];
      if (ch.cls !== 'M') { addText(ch.ws + ch.s); k++; continue; }
      let j = k, spanText = ch.core, depth = 0, endTrail = ch.trail;
      const upd = s => { for (const x of s) { if (x === '(' || x === '[' || x === '{') depth++; else if (x === ')' || x === ']' || x === '}') depth--; } };
      upd(ch.core);
      while (j + 1 < chunks.length) {
        const nx = chunks[j + 1];
        if (nx.cls !== 'M') break;
        // a trailing comma or colon closes the stretch unless a bracket is still open
        if (endTrail && depth <= 0) break;
        spanText += (endTrail || '') + nx.ws + nx.core;
        upd(nx.core);
        endTrail = nx.trail;
        j++;
      }
      // brackets that do not pair up at the ends belong to the surrounding words
      let lead = '', tail = '';
      for (;;) {
        const ub = unbalanced(spanText);
        if (ub.close && /[)\]}]$/.test(spanText)) { tail = spanText.slice(-1) + tail; spanText = spanText.slice(0, -1); continue; }
        if (ub.open.length && ub.open[0] === 0) { lead += spanText[0]; spanText = spanText.slice(1); continue; }
        break;
      }
      const restored = restore(spanText);
      const tex = spanText ? math(spanText) : null;
      addText(ch.ws + lead);
      if (tex !== null) out.push({ math: restored, tex });
      else addText(restored);
      addText(tail + endTrail);
      k = j + 1;
    }
    addText(trailingWs);
    // text that went through the marker step must be restored too
    out.forEach(seg => { if (seg.text !== undefined) seg.text = restore(seg.text); });
    return out;
  }

  return { math, segments, OVERRIDES, _lex: lex };
});
