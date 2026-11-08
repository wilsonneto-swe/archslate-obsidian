// The rules Obsidian's community review applies (eslint-plugin-obsidianmd, recommended), over the code that runs
// inside Obsidian: the plugin (apps/obsidian/src) and the editor it bundles (packages/). Not over the web page
// (apps/web, a browser page Obsidian never loads), the Node scripts and tests, or the agent skill's tool.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

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
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
]);
