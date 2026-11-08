// npm run build:web: the web version as a static site, in apps/web/dist/
// (or --out <folder>): index.html, app.js (bundled, minified), styles.css,
// theme.js and favicon.svg. Every URL is relative, so it works from any
// sub-path (GitHub Pages serves it under /<repository>/).
//
// The page must keep its Content-Security-Policy: the build refuses a page
// whose policy is missing, allows inline code, or lets the page load from or
// talk to any other host. No source maps are published.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'apps', 'web');
const OUTPUT = ['index.html', 'app.js', 'styles.css', 'theme.js', 'favicon.svg'];

// Fetch directives and the sources each may name. Anything else (another
// host, 'unsafe-…', a nonce, a scheme) fails the build.
const SOURCES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'script-src-elem': ["'self'"],
  'script-src-attr': ["'none'"],
  'style-src': ["'self'"],
  'style-src-elem': ["'self'"],
  'style-src-attr': ["'none'"],
  'connect-src': ["'self'", "'none'"],
  'img-src': ["'self'", "'none'", 'data:', 'blob:'],
  'font-src': ["'self'", "'none'"],
  'media-src': ["'self'", "'none'"],
  'frame-src': ["'none'"],
  'child-src': ["'none'"],
  'worker-src': ["'self'", "'none'"],
  'manifest-src': ["'self'", "'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'", "'none'"],
  'form-action': ["'none'", "'self'"],
};
const REQUIRED = ['default-src', 'script-src', 'style-src', 'connect-src', 'object-src', 'base-uri', 'form-action'];

export function checkPolicy(source) {
  const html = source.replace(/<!--[\s\S]*?-->/g, '');
  const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const meta = head.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i);
  if (!meta) throw new Error('index.html has no Content-Security-Policy meta tag in its <head>');
  // A policy only covers what comes after it.
  if (/<(script|link)\b/i.test(head.slice(0, meta.index))) throw new Error('the Content-Security-Policy must come before any <script> or <link>');
  const policy = new Map();
  for (const part of meta[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    const directive = name.toLowerCase();
    // Browsers ignore a repeated directive: one written twice is a mistake.
    if (policy.has(directive)) throw new Error(`the policy has ${directive} twice`);
    policy.set(directive, values.map((v) => v.toLowerCase()));
  }
  for (const directive of REQUIRED) {
    if (!policy.has(directive)) throw new Error(`the policy has no ${directive}`);
  }
  for (const [directive, values] of policy) {
    const allowed = SOURCES[directive];
    if (!allowed) throw new Error(`the policy has ${directive}, which the build does not know how to check`);
    const bad = values.filter((v) => !allowed.includes(v));
    if (bad.length || values.length === 0) throw new Error(`${directive} may only be ${allowed.join(' / ')}, not ${values.join(' ') || 'empty'}`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error('index.html has an inline <script>');
  for (const [, src] of html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]*)"/gi)) {
    if (!src.startsWith('./')) throw new Error(`index.html loads ${src}: only files next to it (./…)`);
  }
  if (/\son[a-z]+=/i.test(html)) throw new Error('index.html has an inline event handler');
  if (/\sstyle="/i.test(html.replace(/<svg[\s\S]*?<\/svg>/g, ''))) throw new Error('index.html has an inline style attribute');
}

// The output folder: apps/web/dist, or --out <folder>. Only the build's own
// files are ever deleted there, and a folder holding anything else (the
// repository, a source folder) is refused.
function outputFolder() {
  const at = process.argv.indexOf('--out');
  if (at < 0) return join(web, 'dist');
  const folder = resolve(process.argv[at + 1] ?? '');
  const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
  if (inside(folder, root) || inside(join(web, 'src'), folder) || inside(join(root, 'packages'), folder)) {
    throw new Error(`--out ${relative(process.cwd(), folder) || '.'}: not a build folder`);
  }
  const strangers = existsSync(folder) ? readdirSync(folder).filter((name) => !OUTPUT.includes(name)) : [];
  if (strangers.length) throw new Error(`--out ${folder} holds other files (${strangers.slice(0, 3).join(', ')}): use an empty folder`);
  return folder;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await buildSite(outputFolder());

async function buildSite(out) {
  for (const name of OUTPUT) rmSync(join(out, name), { force: true });
  mkdirSync(out, { recursive: true });

  await build({
    entryPoints: [join(web, 'src', 'main.js')],
    outfile: join(out, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  const css = [join(web, 'src', 'shell.css'), join(root, 'packages', 'ui', 'styles.css')].map((f) => readFileSync(f, 'utf8')).join('\n');
  writeFileSync(join(out, 'styles.css'), css);
  copyFileSync(join(web, 'src', 'theme.js'), join(out, 'theme.js'));
  copyFileSync(join(web, 'favicon.svg'), join(out, 'favicon.svg'));

  const html = readFileSync(join(web, 'index.html'), 'utf8')
    .replace(/<!-- build:css (\S+) -->[\s\S]*?<!-- endbuild -->/, '<link rel="stylesheet" href="./$1" />')
    .replace(/<!-- build:js (\S+) -->[\s\S]*?<!-- endbuild -->/, '<script type="module" src="./$1"></script>')
    .replace('./src/theme.js', './theme.js');
  checkPolicy(html);
  writeFileSync(join(out, 'index.html'), html);
  console.log(`built the web version into ${out}`);
}
