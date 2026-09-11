import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
 */
function crossesBoundaryTo(source: string, target: string): boolean {
  const ref = `['"][^'"]*\\/${target}(?:\\/[^'"]*)?['"]`;
  const patterns = [
    new RegExp(`import\\s+[^;]*?from\\s+${ref}`), // import ... from '.../target/...'
    new RegExp(`import\\s+${ref}`), // import '.../target/...' (side-effect)
    new RegExp(`import\\s*\\(\\s*${ref}\\s*\\)`), // import('.../target/...') (dynamic)
    new RegExp(`export\\s+[^;]*?from\\s+${ref}`), // export ... from '.../target/...' (re-export)
  ];
  return patterns.some((re) => re.test(source));
}

describe('batas lisensi', () => {
  it('tidak ada berkas sumber di spektra/src yang menyebut web/ EMULSION', () => {
    const offenders = allSourceFiles('src').filter((f) =>
      crossesBoundaryTo(readFileSync(f, 'utf8'), 'web'),
    );
    expect(offenders).toEqual([]);
  });

  it('tidak ada berkas sumber di web/src yang menyebut spektra (arah sebaliknya)', () => {
    // Read-only: web/ is EMULSION's own tree, not GPL-3.0. This check never
    // writes to web/ or touches its toolchain — it only confirms EMULSION
    // does not pull GPL-3.0 code across the boundary, which spektra/ (the
    // GPL-3.0 party) is the one with standing to enforce.
    const offenders = allSourceFiles('../web/src').filter((f) =>
      crossesBoundaryTo(readFileSync(f, 'utf8'), 'spektra'),
    );
    expect(offenders).toEqual([]);
  });
});
