import { managedPluginPatch } from './managed-plugin-patch.js'
import { registryDependenciesAllowed } from '../domain/plugin-library.js'
import { containerWebCommand } from './cli.js'

/** Official CLI and profile seam for isolated plugin preparation. */
export const pluginPreparationHome = '/prepare/home'
export const pluginPreparationProfile = `${pluginPreparationHome}/.dsh/profiles/web`
export function pluginAddCommand(): string[] {
  return [...containerWebCommand().slice(0, 2), 'plugin', '--profile', 'web', 'add', '/prepare/original.tgz', '--ignore-scripts']
}

/** Runs only inside the isolated image. The host never extracts package archives. */
export const pluginArtifactPreparation = String.raw`
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp, realpath, readdir, lstat, symlink, readlink, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
const input = JSON.parse(await readFile('/control/input.json', 'utf8'));
const fail = code => { throw Object.assign(Error(code), { preparationCode: code }); };
process.on('uncaughtException', async error => { await writeFile('/prepare/failure.json', JSON.stringify({ code: error.preparationCode ?? 'plugin-precheck-failed' })); process.exit(42); });
const registryDependenciesAllowed = ${registryDependenciesAllowed.toString()};
const checkDependencies = manifest => { if (!registryDependenciesAllowed(manifest)) fail('plugin-dependency-invalid'); };
if (process.argv[2] === 'upload') {
  const bytes = await readFile('/prepare/original.tgz');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (integrity !== input.uploadIntegrity) fail('plugin-integrity-invalid');
  await writeFile('/prepare/identity.json', JSON.stringify({ integrity }));
} else if (process.argv[2] === 'download') {
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(input.packageName) + '/' + encodeURIComponent(input.version));
  if (!response.ok) fail('plugin-package-invalid');
  const metadata = await response.json();
  if (metadata.name !== input.packageName || metadata.version !== input.version || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity ?? '')) fail('plugin-integrity-invalid');
  checkDependencies(metadata);
  const url = new URL(metadata.dist.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password) fail('plugin-package-invalid');
  const archive = await fetch(url, { redirect: 'error' });
  if (!archive.ok || !archive.body) fail('plugin-package-invalid');
  let size = 0; const chunks = [];
  for await (const chunk of archive.body) { size += chunk.length; if (size > 50 * 1024 * 1024) fail('plugin-package-invalid'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (integrity !== metadata.dist.integrity) fail('plugin-integrity-invalid');
  await writeFile('/prepare/original.tgz', bytes);
  await writeFile('/prepare/identity.json', JSON.stringify({ integrity }));
} else {
  const profile = '/prepare/home/.dsh/profiles/web';
  const root = profile + '/node_modules';
  // Inspect every installed package before offline code evaluation. Do not follow package symlinks.
  const inspect = async directory => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) {
        const target = await realpath(path);
        if (!target.startsWith(root + '/')) fail('plugin-package-invalid');
        if ((await readlink(path)).startsWith('/')) { await rm(path); await symlink(relative(dirname(path), target), path); }
      } else if (item.isDirectory()) await inspect(path);
      else if (!item.isFile()) fail('plugin-package-invalid');
      else if (item.name === 'package.json') {
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        checkDependencies(manifest);
      }
    }
  };
  await inspect(root);
  const packageRoot = join(root, input.packageName);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== input.packageName || manifest.version !== input.version) fail('plugin-package-invalid');
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || !patch.startsWith('./')) fail('plugin-package-invalid');
  const patchPath = await realpath(resolve(packageRoot, patch));
  if (!patchPath.startsWith(packageRoot + '/') || !(await lstat(patchPath)).isFile()) fail('plugin-package-invalid');
  const bundlePatch = await readFile(patchPath, 'utf8');
  if (Buffer.byteLength(bundlePatch) > 1024 * 1024) fail('plugin-package-invalid');
  // Peers come from the frozen runtime, never a separately installed Cordis instance.
  const runtime = createRequire('/opt/dsh/apps/cli/package.json');
  const peers = {};
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const path = '/opt/dsh/node_modules/' + name;
    try { await realpath(path); } catch { continue; }
    const target = join(root, name);
    await rm(target, { recursive: true, force: true }); await mkdir(dirname(target), { recursive: true });
    await symlink(path, target); peers[name] = path;
  }
  const own = createRequire(join(packageRoot, 'package.json'));
  if (manifest.peerDependencies?.['@deepseek-ai/cordis'] && await realpath(own.resolve('@deepseek-ai/cordis')) !== await realpath(runtime.resolve('@deepseek-ai/cordis'))) fail('plugin-precheck-failed');
  const prepared = '/prepare/prepared/' + input.runtimeRevision;
  await mkdir(prepared, { recursive: true });
  await cp(root, join(prepared, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  const checkProfile = '/prepare/checkhome/.dsh/profiles/web';
  await mkdir(checkProfile, { recursive: true });
  const checkManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  checkManifest.dsh.profile.bundles = checkManifest.dsh.profile.bundles.filter(name => name !== input.packageName);
  await writeFile(join(checkProfile, 'package.json'), JSON.stringify(checkManifest));
  await cp(join(profile, 'cordis.patch.yml'), join(checkProfile, 'cordis.patch.yml'));
  await symlink('/artifact/node_modules', join(checkProfile, 'node_modules'));
  const identity = JSON.parse(await readFile('/prepare/identity.json', 'utf8'));
  await writeFile(join(prepared, 'manifest.json'), JSON.stringify({ ...input, ...identity,
    title: typeof manifest.displayName === 'string' ? manifest.displayName.slice(0, 256) : manifest.name,
    description: typeof manifest.description === 'string' ? manifest.description.slice(0, 4096) : '',
    dependencies: manifest.dependencies ?? {}, optionalDependencies: manifest.optionalDependencies ?? {}, peerDependencies: manifest.peerDependencies ?? {}, bundlePatch, runtimePeers: peers }));
  const yaml = runtime('js-yaml');
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ __jsExpr: value }) }));
  const parsed = yaml.load(bundlePatch, { schema });
  const prefix = 'phalanx-managed-' + createHash('sha256').update(input.packageName).digest('hex').slice(0, 16);
  const compile = ${managedPluginPatch.toString()};
  const compiled = compile(parsed, prefix, name => {
    const candidate = name.startsWith('.') ? resolve(dirname(patchPath), name) : name;
    const resolved = own.resolve(candidate);
    if (resolved.startsWith(root + '/')) return '/artifact/node_modules/' + relative(root, resolved);
    if (resolved.startsWith('/opt/dsh/')) return resolved;
    fail('plugin-package-invalid');
  });
  for (let i = 0; i < compiled.entries.length; i++) await writeFile(join(prepared, prefix + '-entries-' + i + '.json'), JSON.stringify(compiled.entries[i]));
  for (const patch of compiled.overlays) for (const row of patch.insert ?? []) row.config.path = '/artifact/' + row.config.path;
  await writeFile(join(prepared, 'managed.patch.json'), JSON.stringify(compiled.overlays));
  // Preserve original bytes for diagnostics and later runtime preparation.
  await writeFile(join(prepared, 'bundle.patch.yml'), bundlePatch);
}
`
