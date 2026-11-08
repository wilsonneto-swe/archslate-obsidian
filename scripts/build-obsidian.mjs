// npm run build:obsidian: the plugin as Obsidian loads it, in apps/obsidian/dist/:
//   main.js        one CommonJS file (`obsidian` is provided by the app), not
//                  minified, so the code a vault runs stays readable
//   styles.css     the editor's stylesheet, then the plugin's own
//   manifest.json  the repository root's
// ES2021 syntax and no Node.js module: the plugin runs on desktop and mobile.
//
//   --watch    rebuild on every change (with --vault, reinstall each time)
//   --vault <path to a vault>   also copy the build into <vault>/.obsidian/plugins/<id>/
import { context } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'apps', 'obsidian', 'dist');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const vaultIndex = args.indexOf('--vault');
const vault = vaultIndex >= 0 ? args[vaultIndex + 1] : null;
if (vaultIndex >= 0 && !vault) {
  console.error('usage: npm run build:obsidian -- [--watch] [--vault <path to a vault>]');
  process.exit(2);
}

function writeExtras() {
  const css = [join(root, 'packages', 'ui', 'styles.css'), join(root, 'apps', 'obsidian', 'src', 'styles.css')].map((f) => readFileSync(f, 'utf8')).join('\n');
  writeFileSync(join(out, 'styles.css'), css);
  copyFileSync(join(root, 'manifest.json'), join(out, 'manifest.json'));
  if (vault) {
    const target = join(resolve(vault), '.obsidian', 'plugins', manifest.id);
    if (!existsSync(join(resolve(vault), '.obsidian'))) throw new Error(`${vault} is not a vault (no .obsidian folder)`);
    mkdirSync(target, { recursive: true });
    for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(join(out, f), join(target, f));
    console.log(`installed into ${target}`);
  }
}

mkdirSync(out, { recursive: true });
const ctx = await context({
  entryPoints: [join(root, 'apps', 'obsidian', 'src', 'main.js')],
  outfile: join(out, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2021',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  minify: false,
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'warning',
  banner: {
    js: `/* ${manifest.name} ${manifest.version} for Obsidian. ${manifest.authorUrl ? `${manifest.authorUrl}. ` : ''}MIT License. Built from the source in this repository; not minified. */`,
  },
  plugins: [{ name: 'extras', setup: (b) => b.onEnd((result) => !result.errors.length && writeExtras()) }],
});

if (watch) {
  await ctx.watch();
  console.log(`watching; builds go to ${out}`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log(`built ${manifest.id} ${manifest.version} into ${out}`);
}
