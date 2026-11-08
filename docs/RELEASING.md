# Releasing

This one repository publishes two things: the **web version** (GitHub Pages) and the **Obsidian plugin** (GitHub
releases, which Obsidian installs from). Obsidian reads `manifest.json`, `README.md` and `LICENSE` at the root of
the default branch, and the release whose tag is the manifest's `version`; the rest of the repository is ours.

## The web version

Every push to `main` that touches the web version (`apps/web`, `packages`, the build script) runs
`.github/workflows/deploy-web.yml`: unit tests, `scripts/build-web.mjs` (which refuses a page without its
Content-Security-Policy), a scan for private data, and a deploy to https://wilsonneto-swe.github.io/archslate-obsidian/.

One-time setup: repository **Settings > Pages > Build and deployment > Source: GitHub Actions**
(or `gh api -X POST repos/wilsonneto-swe/archslate-obsidian/pages -f build_type=workflow`).

## The plugin

1. Check everything first: `npm run check` (lint, builds, unit tests, the scan for private data) and
   `npm run test:e2e`. If the UI changed, record the README images again (`npm run readme:media`) and commit them.
2. Bump the version: `npm version patch` (or `minor`, `major`). A version that is not x.y.z (`1.1.0-beta`) is
   refused before any file changes. `scripts/version-bump.mjs` copies it into `manifest.json` and adds it to
   `versions.json` with the current `minAppVersion`; npm commits the four files (`package.json`,
   `package-lock.json`, `manifest.json`, `versions.json`) and tags the commit with the bare version (`1.0.1`, no
   "v": `.npmrc` says so, and Obsidian needs it).
3. Push the commit and the tag: `git push --follow-tags`.
4. `.github/workflows/release.yml` checks that the tag is the manifest's version and that `versions.json` maps it,
   runs `npm run check` with read-only access, then a second job (which runs no project code) attests `main.js`,
   `manifest.json` and `styles.css` (built into `apps/obsidian/dist`) and drafts a GitHub release with them. Write
   the notes and publish it.

## The first submission

Once the first release is published: sign in at [community.obsidian.md](https://community.obsidian.md) with your
Obsidian account, link GitHub, and add the plugin from `wilsonneto-swe/archslate-obsidian`. The directory reads the
`manifest.json` on the default branch, so it must be committed first. The listing takes the screenshots in
`.github/assets/` (1200 x 800).

What the directory and its review look at:

- `README.md`, `LICENSE` and `manifest.json` at the repository root.
- `manifest.json`: `id` with no "obsidian" and not ending in "plugin"; `name` without "Obsidian" or "Plugin"; a short
  `description` that starts with what it does and ends with a period; `minAppVersion`; `isDesktopOnly: false` (no
  Node.js or Electron APIs in the plugin); `fundingUrl` only because sponsorship is accepted.
- No `innerHTML`, no default hotkeys, no plugin id in command ids, no sample code, no client-side telemetry, no
  network requests (the README's Privacy section says so).
- `npm run lint` applies the review's rules to the code that runs in Obsidian: `eslint-plugin-obsidianmd`'s
  recommended rules, and typescript-eslint's type-checked recommended rules, which the directory's source scan
  uses. The code is JavaScript typed with JSDoc comments (the shared shapes are in `packages/types.d.ts`), so
  those rules see real types rather than `any`.
- The directory also lints every stylesheet in the repository with stylelint: features Obsidian's Electron
  supports, no `!important`, no named colours.
