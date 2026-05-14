import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const html = readFileSync(join(root, 'static/index.html'), 'utf8');
const css = readFileSync(join(root, 'static/styles.css'), 'utf8');
const js = readFileSync(join(root, 'static/app.js'), 'utf8');
const privacy = readFileSync(join(root, 'static/privacy.html'), 'utf8');
const terms = readFileSync(join(root, 'static/terms.html'), 'utf8');
const favicon = readFileSync(join(root, 'static/favicon.svg'), 'utf8');
const ogBase64 = readFileSync(join(root, 'static/og.png')).toString('base64');
const src = readFileSync(join(root, 'src/worker.template.js'), 'utf8');

const out = src
  .replace('__HTML__', JSON.stringify(html))
  .replace('__CSS__', JSON.stringify(css))
  .replace('__JS__', JSON.stringify(js))
  .replace('__PRIVACY__', JSON.stringify(privacy))
  .replace('__TERMS__', JSON.stringify(terms))
  .replace('__FAVICON__', JSON.stringify(favicon))
  .replace('__OG_B64__', JSON.stringify(ogBase64));

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/worker.js'), out);
console.log(`Built worker.js: ${out.length} bytes`);
