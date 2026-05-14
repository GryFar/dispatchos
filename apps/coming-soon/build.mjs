import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const html = readFileSync(join(root, 'static/index.html'), 'utf8');
const css = readFileSync(join(root, 'static/styles.css'), 'utf8');
const js = readFileSync(join(root, 'static/app.js'), 'utf8');
const src = readFileSync(join(root, 'src/worker.template.js'), 'utf8');

const out = src
  .replace('__HTML__', JSON.stringify(html))
  .replace('__CSS__', JSON.stringify(css))
  .replace('__JS__', JSON.stringify(js));

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/worker.js'), out);
console.log(`Built worker.js: ${out.length} bytes`);
