// Builds the distributable SDK packages: `pnpm sdk:pack` → dist-sdk/z-cloudbase-web-<v>.tgz, z-cloudbase-server-<v>.tgz.
// Runtime: esbuild ESM bundles with the internal workspace packages (@z-cloudbase/contracts, @z-cloudbase/security)
// inlined; `jose` (and `zod` for the server SDK) stay real dependencies. Types: tsc declarations of the SDK plus the internal
// packages under dist/types/_internal, with their import specifiers rewritten to relative paths, so the
// tarball works in any project without the monorepo. The workspace sources keep exporting TS for local use;
// the tarball's package.json is built from `publishConfig` (exports into dist/) and the runtime dependencies.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-sdk');
const INTERNAL = { '@z-cloudbase/contracts': 'packages/contracts', '@z-cloudbase/security': 'packages/security' };
const SDKS = [
  { dir: 'packages/sdk-web', entries: ['index', 'auth', 'storage', 'analytics', 'autocapture', 'logs'], platform: 'browser' },
  { dir: 'packages/sdk-server', entries: ['index'], platform: 'neutral' },
];

const tsc = path.join(ROOT, 'node_modules/.bin/tsc');
function declarations(pkgDir, outDir) {
  const config = path.join(pkgDir, 'tsconfig.build.json');
  writeFileSync(config, JSON.stringify({ extends: './tsconfig.json', include: ['src'], compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, rootDir: './src', outDir } }));
  try {
    execFileSync(tsc, ['-p', config], { stdio: 'inherit' });
  } finally {
    rmSync(config);
  }
}

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));

/** `from '@z-cloudbase/contracts'` → relative path to the copied declarations, in every .d.ts under `typesDir`. */
function rewriteSpecifiers(typesDir) {
  for (const file of walk(typesDir).filter((f) => f.endsWith('.d.ts'))) {
    let text = readFileSync(file, 'utf8');
    for (const name of Object.keys(INTERNAL)) {
      const target = path.join(typesDir, '_internal', name.split('/')[1], 'index.js');
      let rel = path.relative(path.dirname(file), target).split(path.sep).join('/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      text = text.replaceAll(`'${name}'`, `'${rel}'`).replaceAll(`"${name}"`, `"${rel}"`);
    }
    // Declarations keep `.ts` specifiers (allowImportingTsExtensions); consumers resolve `.js`.
    text = text.replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2').replace(/(import\(['"]\.{1,2}\/[^'"]+)\.ts(['"]\))/g, '$1.js$2');
    writeFileSync(file, text);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const sdk of SDKS) {
  const pkgDir = path.join(ROOT, sdk.dir);
  const dist = path.join(pkgDir, 'dist');
  rmSync(dist, { recursive: true, force: true });

  await build({
    entryPoints: Object.fromEntries(sdk.entries.map((e) => [e, path.join(pkgDir, 'src', `${e}.ts`)])),
    outdir: dist,
    bundle: true,
    splitting: sdk.entries.length > 1,
    format: 'esm',
    platform: sdk.platform,
    mainFields: ['module', 'main'],
    target: 'es2022',
    external: ['jose', 'zod'],
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const bundled = walk(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
  // The browser bundle must not pull zod (440 kB): its contracts imports are zod-free modules (ids, limits, errors).
  const forbiddenImports = sdk.platform === 'browser' ? ['@z-cloudbase/', 'from "hono', 'from "zod"'] : ['@z-cloudbase/', 'from "hono'];
  for (const forbidden of forbiddenImports) {
    if (bundled.includes(forbidden)) throw new Error(`${sdk.dir}: bundle still references ${forbidden}`);
  }

  const types = path.join(dist, 'types');
  declarations(pkgDir, types);
  for (const [name, dir] of Object.entries(INTERNAL)) {
    const tmp = path.join(dist, '_tmp', name.split('/')[1]);
    declarations(path.join(ROOT, dir), tmp);
    cpSync(tmp, path.join(types, '_internal', name.split('/')[1]), { recursive: true });
  }
  rmSync(path.join(dist, '_tmp'), { recursive: true, force: true });
  rewriteSpecifiers(types);

  // A clean manifest (publishConfig applied, no workspace devDependencies or scripts) packed from a stage dir.
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const stage = path.join(OUT, '_stage', path.basename(pkgDir));
  cpSync(dist, path.join(stage, 'dist'), { recursive: true });
  const manifest = {
    name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, type: 'module', sideEffects: false,
    ...pkg.publishConfig, files: ['dist'], dependencies: pkg.dependencies,
  };
  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // npm always packs a LICENSE at the package root.
  cpSync(path.join(ROOT, 'LICENSE'), path.join(stage, 'LICENSE'));
  execFileSync('npm', ['pack', '--silent', '--pack-destination', OUT], { cwd: stage, stdio: 'inherit' });
}
rmSync(path.join(OUT, '_stage'), { recursive: true, force: true });
console.log(`SDK tarballs in ${path.relative(ROOT, OUT)}/:`, readdirSync(OUT).join(', '));
