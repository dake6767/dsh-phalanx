import { registryDependenciesAllowed } from '../domain/plugin-library.js'

/** Entry files a packed manifest declares; every one must be inside the packed file list. Serialized into the packing script. */
export function declaredPluginEntries(manifest: {
  readonly main?: unknown
  readonly exports?: unknown
  readonly dsh?: { readonly bundle?: { readonly patch?: unknown } }
}): string[] | undefined {
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !patch.startsWith('./')) return undefined
  if (manifest.main !== undefined && typeof manifest.main !== 'string') return undefined
  const entries = [patch.slice(2), ...(typeof manifest.main === 'string' ? [manifest.main.replace(/^\.\//u, '')] : [])]
  // Walk export conditions iteratively: a nested function would not survive serialization by every transpiler.
  const pending: unknown[] = manifest.exports === undefined ? [] : [manifest.exports]
  while (pending.length) {
    const value = pending.pop()
    if (value === null) continue
    if (typeof value === 'string') {
      // Patterns name no single file; other targets must be package-relative.
      if (value.includes('*')) continue
      if (!value.startsWith('./')) return undefined
      entries.push(value.slice(2))
    } else if (Array.isArray(value)) pending.push(...value)
    else if (value && typeof value === 'object') pending.push(...Object.values(value))
    else return undefined
  }
  return [...new Set(entries.map(entry => entry.replace(/\/+$/u, '')))]
}

/**
 * Runs with no network: argv `--pack` source archive, output directory, scratch directory.
 * The repository is packed with npm's ignore-scripts mode and no user, global or project npm configuration.
 */
export const pluginSourcePacking = String.raw`
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const registryDependenciesAllowed = ${registryDependenciesAllowed.toString()};
const declaredPluginEntries = ${declaredPluginEntries.toString()};
const [archive, output, scratch] = process.argv.slice(process.argv.indexOf('--pack') + 1);
const result = value => { console.log(JSON.stringify(value)); process.exit(0); };
try {
  const source = join(scratch, 'source'), work = join(scratch, 'work');
  mkdirSync(source, { recursive: true }); mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', source, '--strip-components=1', '--no-same-owner', '--no-same-permissions'], { timeout: 120000, stdio: 'ignore' });
  // Links and special files could pull container files into the package; GitHub archives of plugins do not need them.
  let count = 0, size = 0;
  const walk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (!item.isFile()) result({ ok: false, code: 'plugin-package-invalid' });
      else if (++count > 20000 || (size += lstatSync(path).size) > 524288000) result({ ok: false, code: 'plugin-package-invalid' });
    }
  };
  walk(source);
  const stat = lstatSync(join(source, 'package.json'));
  if (!stat.isFile() || stat.size > 1048576) result({ ok: false, code: 'plugin-package-invalid' });
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || manifest.private === true) result({ ok: false, code: 'plugin-package-invalid' });
  if (!registryDependenciesAllowed(manifest) || manifest.bundleDependencies || manifest.bundledDependencies) result({ ok: false, code: 'plugin-dependency-invalid' });
  const entries = declaredPluginEntries(manifest);
  if (!entries) result({ ok: false, code: 'plugin-package-invalid' });
  // Empty user and global configuration. Project configuration comes from the scratch working directory, not the repository;
  // the repository .npmrc is also deleted as a second barrier.
  writeFileSync(join(work, 'user.npmrc'), ''); writeFileSync(join(work, 'global.npmrc'), ''); rmSync(join(source, '.npmrc'), { force: true });
  const env = { PATH: process.env.PATH, HOME: work, npm_config_cache: join(work, 'cache'), npm_config_ignore_scripts: 'true', npm_config_userconfig: join(work, 'user.npmrc'), npm_config_globalconfig: join(work, 'global.npmrc'), npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  const packed = JSON.parse(execFileSync('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', output], { cwd: work, env, encoding: 'utf8', timeout: 300000, maxBuffer: 16777216 }));
  const files = new Set((packed[0]?.files ?? []).map(file => file.path));
  const present = entry => files.has(entry) || ['.js', '.json', '/index.js'].some(suffix => files.has(entry + suffix));
  if (packed.length !== 1 || readdirSync(output).length !== 1 || packed[0].name !== manifest.name || packed[0].version !== manifest.version) result({ ok: false, code: 'plugin-package-invalid' });
  if (!entries.every(present)) result({ ok: false, code: 'plugin-build-required' });
  result({ ok: true, packageName: manifest.name, version: manifest.version, filename: packed[0].filename });
} catch { result({ ok: false, code: 'plugin-package-invalid' }); }
`
