// npm version patch|minor|major runs this twice:
//  - as `preversion` (with --check), before npm touches any file: Obsidian
//    needs x.y.z versions, so anything else ("1.1.0-beta") stops here;
//  - as `version`: the new version from package.json goes into manifest.json,
//    and versions.json maps it to the manifest's minAppVersion, so Obsidian
//    knows which app versions can install it.
import { readFileSync, writeFileSync } from 'node:fs';

const X_Y_Z = /^\d+\.\d+\.\d+$/;

if (process.argv.includes('--check')) {
  const next = process.env.npm_new_version;
  if (next !== undefined && !X_Y_Z.test(next)) {
    console.error(`Obsidian needs x.y.z versions, not ${next}: nothing was changed`);
    process.exit(1);
  }
  process.exit(0);
}

const version = process.env.npm_package_version ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!X_Y_Z.test(version)) throw new Error(`Obsidian needs x.y.z versions, not ${version}`);
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
manifest.version = version;
writeFileSync('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[version] = manifest.minAppVersion;
writeFileSync('versions.json', `${JSON.stringify(versions, null, 2)}\n`);
console.log(`manifest.json and versions.json: ${version} (Obsidian ${manifest.minAppVersion} or later)`);
