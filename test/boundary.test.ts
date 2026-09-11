import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WGSL has no import/module syntax as of the current spec, so a .wgsl file
 * has no mechanism to reference another module across the license boundary.
 * Scanning .wgsl for JS-style `import`/`export` syntax would always be a
 * no-op, so this check is restricted to .ts/.tsx, where crossing imports are
 * actually possible.
 */
function allSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allSourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * True if `source` contains any import/export form that references `target`
 * as a path segment: static `import ... from '...'`, side-effect
 * `import '...'` (no "from"), dynamic `import('...')`, or re-export
 * `export ... from '...'`. A single regex anchored on "from" misses the
 * second and third forms entirely — both are legal ways to cross the
 * license boundary, so all four are checked independently.
 *
 * The string delimiter can be `'`, `"`, or a template-literal backtick — a
 * backreference (`\1`) ties the closing delimiter to whichever one opened
 * the string, and the negated character class excludes all three so a
 * template literal's `${...}` interpolation doesn't break the match.
 *
 * `import`/`export`/`from` are matched with `\b` word boundaries and `\s*`
 * (zero or more, not one or more) surrounding whitespace, not literal
 * spaces: real JS/TS tokenizes `import{x}from'...'` (no spaces at all —
 * exactly what a minifier, or someone deliberately dodging this check,
 * would produce) as the same three tokens as the spaced-out form, since `{`
 * and `'` aren't identifier characters and don't need a space to separate
 * them from a keyword. The `\b` after each keyword is what keeps this safe:
 * it requires the next character to be non-identifier (whitespace, `{`,
 * `'`, `"`, `` ` ``, `(`), so it can never match inside a longer identifier
 * like `importantData` or `reimportCount` — those aren't real `import`/
 * `export` tokens in valid source, and `\s*` alone (without `\b`) would
 * have started matching inside them.
 *
 * This matches on raw text, not a parsed AST, so a string or comment that
 * merely *looks* like a crossing import (e.g. inside a code sample in a
 * comment) can also trigger it. That's a deliberate choice: it fails safe
 * (a false positive costs a human a second look; a false negative costs a
 * license violation), and parsing a real AST for a boundary check this
 * narrow would be over-engineering.
 */
function crossesBoundaryTo(source: string, target: string): boolean {
  const ref = `(['"\`])[^'"\`]*\\/${target}(?:\\/[^'"\`]*)?\\1`;
  const patterns = [
    new RegExp(`\\bimport\\b\\s*[^;]*?\\bfrom\\b\\s*${ref}`), // import ... from '.../target/...'
    new RegExp(`\\bimport\\b\\s*${ref}`), // import '.../target/...' (side-effect)
    new RegExp(`\\bimport\\b\\s*\\(\\s*${ref}\\s*\\)`), // import('.../target/...') (dynamic)
    new RegExp(`\\bexport\\b\\s*[^;]*?\\bfrom\\b\\s*${ref}`), // export ... from '.../target/...' (re-export)
  ];
  return patterns.some((re) => re.test(source));
}

const WEB_SRC_DIR = '../web/src';
const webSrcExists = existsSync(WEB_SRC_DIR);
const reverseCheckName = webSrcExists
  ? 'tidak ada berkas sumber di web/src yang menyebut spektra (arah sebaliknya)'
  : `DILEWATI: ${WEB_SRC_DIR} tidak ditemukan — checkout ini tampaknya hanya ` +
    'berisi spektra/ tanpa EMULSION (web/), jadi pemeriksaan arah-balik ' +
    'tidak bisa dijalankan; ini bukan kelulusan, lihat status "skipped" di atas';

describe('batas lisensi', () => {
  it('tidak ada berkas sumber di spektra/src yang menyebut web/ EMULSION', () => {
    const offenders = allSourceFiles('src').filter((f) =>
      crossesBoundaryTo(readFileSync(f, 'utf8'), 'web'),
    );
    expect(offenders).toEqual([]);
  });

  // Read-only: web/ is EMULSION's own tree, not GPL-3.0. This check never
  // writes to web/ or touches its toolchain — it only confirms EMULSION
  // does not pull GPL-3.0 code across the boundary, which spektra/ (the
  // GPL-3.0 party) is the one with standing to enforce. spektra/ is designed
  // to be distributable on its own (see README.md), so a checkout can
  // legitimately have no ../web/src at all — guarded with skipIf instead of
  // letting readdirSync throw ENOENT, so that case degrades to a visibly
  // skipped test instead of crashing the whole suite.
  it.skipIf(!webSrcExists)(reverseCheckName, () => {
    const offenders = allSourceFiles(WEB_SRC_DIR).filter((f) =>
      crossesBoundaryTo(readFileSync(f, 'utf8'), 'spektra'),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Unit tests for crossesBoundaryTo itself, against string literals — no
 * filesystem access, so these run in milliseconds and never depend on
 * whether web/ exists.
 *
 * The two describe-level tests above are green today only because the real
 * trees they scan happen to contain no violations; they say nothing about
 * whether the pattern itself still works. Three regressions already reached
 * this file that way (missing side-effect/dynamic-import forms, missing
 * backtick delimiters, missing no-whitespace forms) — each one only caught
 * by a manual probe that was written, run, and thrown away. This table is
 * what replaces "prove it once, forget it" with permanent coverage: every
 * form this file has ever had to learn about stays pinned here.
 */
describe('crossesBoundaryTo', () => {
  const mustDetect: Array<[string, string]> = [
    ['static import-from', "import { x } from '../../web/src/a';"],
    ['side-effect import (no "from")', "import '../../web/src/a';"],
    ['dynamic import()', "const m = import('../../web/src/a');"],
    ['re-export (export * from)', "export * from '../../web/src/a';"],
    ['named re-export (export { a } from)', "export { a } from '../../web/src/a';"],
    ['export type re-export', "export type { X } from '../../web/src/a';"],
    ['backtick, static path', 'import x from `../../web/src/a`;'],
    ['backtick with ${...} interpolation', 'import(`../../web/src/${name}`);'],
    ['import spanning multiple lines', 'import {\n  a,\n  b,\n} from \'../../web/src/a\';'],
    ['import type', "import type { X } from '../../web/src/a';"],
    ['different relative depth', "import x from '../../../../web/a';"],
    ['double quotes', 'import x from "../../web/src/a";'],
    ['await import(...) spanning multiple lines', "const m = await import(\n  '../../web/src/a'\n);"],
    ['no space after "from"', "import x from'../../web/src/a';"],
    ['no space at all', "import{x}from'../../web/src/a';"],
    ['default + named combined', "import Def, { Named } from '../../web/src/a';"],
  ];

  const mustPass: Array<[string, string]> = [
    ["bare package literally named 'webpack'", "import webpack from 'webpack';"],
    ['sibling dir that starts with "web" (./web3/x)', "import x from './web3/x';"],
    ['sibling dir that starts with "web" (./website/x)', "import x from './website/x';"],
    ['ordinary string containing the word "web"', "const msg = 'visit our web site sometime';"],
    [
      'identifier containing "import" as a substring, unrelated "from"',
      "const importantData = getData(); processFrom(importantData, from);",
    ],
    ['identifier containing "import" as a substring, no from/export nearby', 'const reimportCount = 3;'],
  ];

  it.each(mustDetect)('mendeteksi: %s', (_label, source) => {
    expect(crossesBoundaryTo(source, 'web')).toBe(true);
  });

  it.each(mustPass)('tidak salah tangkap: %s', (_label, source) => {
    expect(crossesBoundaryTo(source, 'web')).toBe(false);
  });
});
