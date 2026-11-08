# Development

Node.js 22 or later (`.nvmrc` has the version CI uses). There are no runtime dependencies; the development ones
are esbuild (the builds) and eslint with Obsidian's review rules (the lint). The code is plain JavaScript with
JSDoc types, the shared shapes in `packages/types.d.ts`: the lint checks them with type information, as the
community directory's scan does, and `npx tsc --noEmit` reads them too.

```
npm install
npm run dev              # the web version from the sources: http://localhost:5173/apps/web/
npm test                 # unit tests (node:test): core, plugin, CLI, file format, scanner
npm run build            # apps/web/dist and apps/obsidian/dist
npm run check            # lint, both builds, unit tests, the scan for private data (what CI runs)
npm run test:e2e         # end-to-end: the built web page in Chrome, the plugin in the real Obsidian app
```

## The plugin in Obsidian

`npm run build:obsidian -- --watch --vault "<test vault>"` rebuilds and installs into a vault on every change. Use a
test vault, not the one you use every day.

`npm run test:e2e` drives the real Obsidian app installed on this Mac (`e2e/helpers/obsidian.mjs`). Every run gets a
throwaway profile and vault under the temp folder (`ARCHSLATE_OBSIDIAN_TMP` to choose another), passed to Obsidian
as `--user-data-dir`: your own profile, vault list and vaults are never opened. The run refuses to start while your
own Obsidian is running, ends only the process it started, and removes the folder afterwards. The web tests serve
`apps/web/dist` and drive a headless Chrome with its own throwaway profile.

Each suite skips, with the reason, when what it needs is missing: Obsidian (`/Applications/Obsidian.app`, or
`ARCHSLATE_OBSIDIAN_APP` with the path to another `Obsidian.app`) or Google Chrome (`CHROME` with the path to the browser's
executable on Windows or Linux), or the build (`npm run build` first).

## README images

`npm run readme:media` records the GIFs and screenshots in `.github/assets/` and `docs/images/web.png`, in the same isolated Obsidian and in headless Chrome (`node scripts/readme-media.mjs hero` for
one scene). GIFs are encoded by `scripts/lib/gif.mjs`, with no ffmpeg needed.

## The agent skill

`skills/system-design-diagram/scripts/archslate.mjs` is generated: change `tools/archslate-cli/cli.mjs`, then run
`npm run build:skill`. `node scripts/examples-source.mjs` writes `examples/*.md` (and the skill's two examples).

## Nothing private in public places

This repository and the web page are public. `npm run check:public` scans every file git would publish (or the
folders you name) and refuses home-folder paths, email addresses, tokens and keys, `.env` files and the like;
`npm run check` and both workflows run it. Commits use the GitHub noreply address, not a personal email.
