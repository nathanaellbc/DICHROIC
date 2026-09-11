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
    new RegExp(`import\\s+[^;]*?from\\s+${ref}`), // import ... from '.../target/...'
    new RegExp(`import\\s+${ref}`), // import '.../target/...' (side-effect)
    new RegExp(`import\\s*\\(\\s*${ref}\\s*\\)`), // import('.../target/...') (dynamic)
    new RegExp(`export\\s+[^;]*?from\\s+${ref}`), // export ... from '.../target/...' (re-export)
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
