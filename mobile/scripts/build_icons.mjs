import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(join(root, 'src/ui/components/Icon.tsx'), 'utf8');
const mapping = source.split('const ICONS:')[1].split('};')[0].split('= {')[1];
const directory = join(root, 'mobile/assets/icons');
await mkdir(directory, { recursive: true });
for (const match of mapping.matchAll(/(\w+):\s*(\w+)/g)) {
  const [, name, component] = match;
  if (!lucide[component]) throw new Error(`Missing Lucide icon ${component}`);
  await writeFile(join(directory, `${name}.svg`), renderToStaticMarkup(createElement(lucide[component], { color: '#ffffff' })));
}
await copyFile(join(root, 'node_modules/lucide-react/LICENSE'), join(directory, 'LICENSE'));
