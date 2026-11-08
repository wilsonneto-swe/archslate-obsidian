import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../scripts/check-public.mjs';

test('check:public finds paths, emails, tokens and junk, and passes clean files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archslate-public-'));
  try {
    const home = ['', 'Users', 'someone', 'notes'].join('/');
    writeFileSync(join(dir, 'clean.md'), 'Copyright (c) 2026 Wilson Neto\nhttps://github.com/wilsonneto-swe\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    writeFileSync(join(dir, 'leaky.md'), `see ${home}/x\nmail me: someone@${'mail'}.com\ntoken ${'ghp_'}${'a'.repeat(36)}\n`);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'x.js'), '');
    writeFileSync(join(dir, '.env'), 'A=1');
    const found = scan([dir]);
    assert.deepEqual(found.sort(), ['.env: must not be published', 'leaky.md:1: home folder path', 'leaky.md:2: email address', 'leaky.md:3: GitHub token', 'node_modules/x.js: must not be published'].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check:public names files from the current folder, skips deleted ones, and knows more key shapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archslate-public-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync(join('vault', '.obsidian'), { recursive: true });
    writeFileSync(join('vault', '.obsidian', 'app.json'), '{}');
    writeFileSync(join('vault', 'data.json'), '{}');
    const home = ['', 'home', 'someone'].join('/');
    const keys = [
      `path ${home}`,
      `stripe ${'sk_live_'}${'a'.repeat(24)}`,
      `google ${'AIza'}${'b'.repeat(35)}`,
      `jwt ${'eyJ'}${'c'.repeat(12)}.${'eyJ'}${'d'.repeat(12)}.${'e'.repeat(12)}`,
      `-----BEGIN ${'PGP'} PRIVATE KEY BLOCK-----`,
    ];
    writeFileSync('keys.md', `${keys.join('\n')}\n`);
    const found = scan([join('vault', '.obsidian', 'app.json'), join('vault', 'data.json'), 'keys.md', 'gone.md']);
    assert.deepEqual(found.sort(), [
      'keys.md:1: home folder path',
      'keys.md:2: API key',
      'keys.md:3: API key',
      'keys.md:4: JSON web token',
      'keys.md:5: private key',
      'vault/.obsidian/app.json: must not be published',
      'vault/data.json: must not be published',
    ].sort());
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
