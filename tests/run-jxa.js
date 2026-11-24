// Runs the tests on a Mac that has no Node installed, using the JavaScriptCore engine that ships with macOS.
// It is only a stand-in for `node tests/x.test.js`: the tests are written for Node and run the same way there.
//
//   osascript -l JavaScript tests/run-jxa.js "$PWD"              # every tests/*.test.js
//   osascript -l JavaScript tests/run-jxa.js "$PWD" balance chem # just these
//
// Each name maps to tests/<name>.test.js. require('../js/x.js') or require('./x.js') loads js/x.js, and
// require('node:assert/strict') is a small stand-in (ok, equal, notEqual, deepEqual, throws).
ObjC.import('Foundation');

function readFile(p) {
  const s = $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null);
  if (!s || s.isNil()) throw new Error('cannot read ' + p);
  return s.js;
}
function exists(p) { return $.NSFileManager.defaultManager.fileExistsAtPath($(p)); }

function run(argv) {
  const base = argv[0];
  let names = argv.slice(1);
  if (!names.length) {
    // every tests/*.test.js, in alphabetical order
    const files = ObjC.deepUnwrap($.NSFileManager.defaultManager.contentsOfDirectoryAtPathError($(base + '/tests'), null)) || [];
    names = files.filter(f => /\.test\.js$/.test(f)).map(f => f.replace(/\.test\.js$/, '')).sort();
  }
  const out = [];
  const G = globalThis;

  G.console = { log: m => out.push(String(m)), error: m => out.push(String(m)) };
  G.process = { exitCode: 0 };
  const nodeAssert = {
    ok(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); },
    equal(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`); },
    notEqual(a, b, msg) { if (a === b) throw new Error(msg || `expected value different from ${b}`); },
    deepEqual(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); },
    throws(fn) { let threw = false; try { fn(); } catch (e) { threw = true; } if (!threw) throw new Error('expected function to throw'); }
  };

  const cache = {};
  G.require = p => {
    if (p.indexOf('assert') >= 0) return nodeAssert;
    const file = base + '/js/' + p.split('/').pop();
    if (!cache[file]) {
      const outer = G.module;                 // the file that asked for this one keeps its own `module`
      G.module = { exports: {} };
      (0, eval)(readFile(file));
      cache[file] = G.module.exports;
      G.module = outer;
    }
    return cache[file];
  };

  names.forEach(n => {
    out.push('=== ' + n + ' ===');
    G.module = { exports: {} };
    (0, eval)(readFile(base + '/tests/' + n + '.test.js'));
  });

  out.push('exitCode=' + G.process.exitCode);
  return out.join('\n');
}
