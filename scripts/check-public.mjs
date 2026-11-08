// npm run check:public [-- <folder or file>...]: refuses anything that should
// not be published. This repository is public, and so is the web build it
// deploys: with no arguments it scans every file git would publish (tracked,
// plus new files that are not ignored); `npm run check` runs it, so does CI.
//
// It flags: absolute home-folder paths (/Users/…, /home/…, C:\Users\…), temp (check-public: allow)
// and scratch paths, email addresses other than GitHub's noreply ones, tokens
// and keys (GitHub, npm, AWS, OpenAI/Anthropic style, Slack, Stripe, Google,
// JWTs, private keys), .env files, a plugin's data.json, and folders that
// never belong in a repository (node_modules, .DS_Store, .obsidian). Paths are
// checked from the repository root, so a vault's .obsidian folder inside the
// repository is caught too. A line that must mention one of them (this file's
// own rules) says so with "check-public: allow". Exit code: 0 clean, 1
// something found, 2 bad usage.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RULES = [
  ['home folder path', /(?<![\w.])\/(?:Users|home)\/(?!<)[^/\s"'`<>()]+/],
  ['Windows user path', /[A-Za-z]:\\{1,2}Users\\{1,2}(?!<)[^\\\s"'`<>()]+/],
  ['temp or scratch path', /\/private\/tmp\/|\/var\/folders\/|scratchpad/], // check-public: allow
  ['email address', /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}|_authToken\s*=/],
  ['AWS key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['API key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\b(?:sk|rk)_live_[A-Za-z0-9]{10,}|\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\//],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/], // check-public: allow
];
// Text that looks like a match but is fine to publish.
const ALLOWED = [/\bnoreply@anthropic\.com\b/, /\bexample\.(?:com|org)\b/];
const NEVER = [/(^|\/)node_modules(\/|$)/, /(^|\/)\.DS_Store$/, /(^|\/)\.env(\.|$)/, /(^|\/)\.obsidian(\/|$)/, /(^|\/)data\.json$/, /\.(?:pem|key|p12)$/];
const SKIP = [/(^|\/)\.git(\/|$)/];
const BINARY = /\.(?:png|gif|jpe?g|webp|ico|woff2?|zip)$/i;

function files(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

// Folders are scanned from inside (a build folder's files by their own
// names); files are named from the current folder, the repository root when
// npm runs this, so folder rules see the whole path.
export function scan(paths) {
  const found = [];
  for (const root of paths.map((p) => resolve(p))) {
    // A file deleted but not yet staged is still listed by git: nothing to read.
    if (!existsSync(root)) continue;
    const base = statSync(root).isDirectory() ? root : process.cwd();
    for (const file of files(root)) {
      const rel = relative(base, file).split('\\').join('/');
      if (SKIP.some((re) => re.test(rel))) continue;
      if (NEVER.some((re) => re.test(rel))) {
        found.push(`${rel}: must not be published`);
        continue;
      }
      if (BINARY.test(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('check-public: allow')) return;
        const clean = ALLOWED.reduce((text, re) => text.replace(new RegExp(re, 'g'), ''), line);
        for (const [what, re] of RULES) {
          if (re.test(clean)) found.push(`${rel}:${i + 1}: ${what}`);
        }
      });
    }
  }
  return found;
}

// The files git would publish: tracked ones and new ones that are not ignored.
export function publishedFiles() {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const given = process.argv.slice(2);
  const targets = given.length ? given : publishedFiles();
  if (!targets.length) {
    console.error('check:public: nothing to scan');
    process.exit(2);
  }
  const found = scan(targets);
  if (found.length) {
    console.error(`check:public: ${found.length} finding${found.length === 1 ? '' : 's'}, nothing should be published like this:\n${found.join('\n')}`);
    process.exit(1);
  }
  console.log(`check:public: nothing sensitive in ${given.length ? given.join(', ') : `the ${targets.length} files git would publish`}`);
}
