// The rules Obsidian's community review applies, over the code that runs inside Obsidian: the plugin
// (apps/obsidian/src) and the editor it bundles (packages/). Not over the web page (apps/web, a browser page
// Obsidian never loads), the Node scripts and tests, or the agent skill's tool.
//  - eslint-plugin-obsidianmd, recommended: Obsidian's own rules.
//  - typescript-eslint, recommendedTypeChecked: the directory's source scan. The code is JavaScript typed with
//    JSDoc (shared shapes in packages/types.d.ts), so these rules see real types rather than `any`.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

const OBSIDIAN_CODE = ['apps/obsidian/src/**/*.js', 'packages/**/*.js'];

export default defineConfig([
  {
    ignores: [
      'node_modules/**',
      'apps/obsidian/dist/**',
      'apps/obsidian/test/**',
      'apps/web/**',
      'e2e/**',
      'scripts/**',
      'test/**',
      'tools/**',
      'skills/**',
      'eslint.config.mjs',
    ],
  },
  ...obsidianmd.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: OBSIDIAN_CODE })),
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: OBSIDIAN_CODE,
    rules: {
      // The editor makes its elements with the main window's `document` on purpose, also for a view in a pop-out
      // window. Appended there they are adopted and stay this window's objects, so `instanceof` checks keep
      // working; elements made by a pop-out's `activeDocument` belong to that window's JavaScript realm and fail
      // them (nested elements turned into "[object HTMLSpanElement]" text). e2e/obsidian.test.mjs covers it.
      'obsidianmd/prefer-active-doc': 'off',
    },
  },
]);
