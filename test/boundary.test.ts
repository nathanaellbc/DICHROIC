import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function allSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allSourceFiles(full, acc);
    else if (/\.(ts|tsx|wgsl)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('batas lisensi', () => {
  it('tidak ada berkas sumber yang menyebut web/ EMULSION', () => {
    const offenders = allSourceFiles('src').filter((f) =>
      /from\s+['"][^'"]*\/web\//.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
