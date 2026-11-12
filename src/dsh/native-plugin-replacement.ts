import { DSH_BUNDLE_ENABLE, DSH_BUNDLE_INSTALL, DSH_BUNDLE_LIST, DSH_BUNDLE_REMOVE } from './plugin-manager-protocol.js'
import { dshProfileWriterLoader } from './profile-writer.js'
import { platformPluginContainerPath } from './community-platform-plugin.js'
import { DSH_CONTAINER_PROFILE, DSH_PATCH_CONFIG, DSH_PROFILE_LOCK, DSH_PROFILE_MANIFEST } from './profile-layout.js'
import { PLUGIN_UPLOAD_MAX_BYTES } from '../domain/plugin-library.js'

export const MEMBER_PLUGIN_ARCHIVE_DIRECTORY = DSH_CONTAINER_PROFILE + '/.phalanx-market'

/** Used inside the member carrier, for the current inventory and immediately before mutation. */
export const nativeArchiveVerification = String.raw`
async function readRegularFile(path, maxBytes, onChunk) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid profile file');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({autoClose:false})) {
      bytes += chunk.length;
      if (bytes > stat.size) throw new Error('Profile file changed');
      await onChunk(chunk);
    }
    if (bytes !== stat.size) throw new Error('Profile file changed');
  } finally { await handle.close(); }
}
async function verifiedArchive(path, integrity) {
  const hash = createHash('sha512');
  await readRegularFile(path, ${PLUGIN_UPLOAD_MAX_BYTES}, chunk => hash.update(chunk));
  return 'sha512-' + hash.digest('base64') === integrity;
}
async function readOptionalProfileFile(path) {
  const chunks = [];
  try { await readRegularFile(path, 16 * 1024 * 1024, chunk => chunks.push(chunk)); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  return Buffer.concat(chunks);
}
`

/** DSH's dependency spec and the package manager's resolved archive must agree. */
export const nativeArchiveResolution = `
async function resolvedArchive(name, path, integrity) {
  const { parse } = await import(${JSON.stringify(platformPluginContainerPath + '/yaml/dist/index.js')});
  const profile = ${JSON.stringify(DSH_CONTAINER_PROFILE)};
  const lock = parse((await readOptionalProfileFile(join(profile, ${JSON.stringify(DSH_PROFILE_LOCK)})))?.toString('utf8') ?? '');
  const reference = lock?.importers?.['.']?.dependencies?.[name];
  if (typeof reference?.specifier !== 'string' || !reference.specifier.startsWith('file:') ||
      resolve(profile, reference.specifier.slice(5)) !== path || !reference.version?.startsWith('file:')) return false;
  const resolved = Object.entries(lock.packages ?? {}).find(([key]) => {
    const locator = name + '@' + reference.version;
    return key === locator || (locator.startsWith(key + '(') && key.startsWith(name + '@file:'));
  })?.[1];
  return resolved?.resolution?.integrity === integrity && await verifiedArchive(path, integrity);
}
`

export const nativeReplacementImports = `
import { constants } from 'node:fs';
import { open, rename, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
`

/** Runs on the signed route with the same mutation queue as native browser operations. */
export const nativeReplacementModule = `
${nativeArchiveVerification}
${nativeArchiveResolution}
${dshProfileWriterLoader}
const archiveDirectory = ${JSON.stringify(MEMBER_PLUGIN_ARCHIVE_DIRECTORY)};
const profileDirectory = ${JSON.stringify(DSH_CONTAINER_PROFILE)};
const patchName = ${JSON.stringify(DSH_PATCH_CONFIG)};
const successful = value => value?.application === 'applied' || value?.application === 'restart-required';
const archivePath = integrity => typeof integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
  ? join(archiveDirectory, Buffer.from(integrity.slice(7), 'base64').toString('hex') + '.tgz') : undefined;
class NativeRecoveryFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const patchPath = join(profileDirectory, patchName);
async function copyArchive(source, target) {
  const destination = await open(target, 'wx', 0o600);
  try { await readRegularFile(source, ${PLUGIN_UPLOAD_MAX_BYTES}, chunk => destination.writeFile(chunk)); }
  finally { await destination.close(); }
}
const readPatch = () => readOptionalProfileFile(patchPath);
const samePatch = (before, after) => before === undefined ? after === undefined : after !== undefined && before.equals(after);
const yamlParser = () => import(${JSON.stringify(platformPluginContainerPath + '/yaml/dist/index.js')});
function patchDocument(yaml, bytes) {
  const document = yaml.parseDocument(bytes?.toString('utf8') ?? '[]', { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (document.errors.length || !yaml.isSeq(document.contents)) throw new NativeRecoveryFailure('settings-invalid');
  return document;
}
const ownsPatch = (yaml, rows, patch) => yaml.isMap(patch) && !patch.has('insert') &&
  rows.some(row => row.rowId === patch.get('id') && (!patch.has('name') || row.moduleName === patch.get('name')));
function selectedPatchText(document, select, includeComments = false) {
  const copy = document.clone();
  copy.contents.items = copy.contents.items.filter(select);
  copy.contents.flow = false;
  if (!includeComments) {
    copy.comment = copy.commentBefore = copy.contents.comment = copy.contents.commentBefore = undefined;
  }
  return copy.toString({ verifyAliasOrder: false });
}
// A reference can supply the row or its target identity.
function hasAliasedPatchTarget(yaml, ...documents) {
  return documents.some(document => document.contents.items.some(patch => {
    if (yaml.isAlias(patch)) return true;
    return yaml.isMap(patch) && (
      patch.items.some(pair => yaml.isAlias(pair.key)) ||
      yaml.isAlias(patch.get('id', true)) ||
      yaml.isAlias(patch.get('name', true))
    );
  }));
}
function hasCrossReference(yaml, patches) {
  let referenced = false;
  for (const patch of patches) yaml.visit(patch, (_key, node) => {
    if (yaml.isAlias(node) || node?.anchor) referenced = true;
  });
  return referenced;
}
async function restoreBundleSettings(original, rows) {
  if (samePatch(original, await readPatch())) return;
  const require = createRequire(process.argv[1]);
  const { withFileLock, writeFileAtomic } = await loadDshProfileWriter(require, pathToFileURL);
  await withFileLock(join(profileDirectory, ${JSON.stringify(DSH_PROFILE_MANIFEST)}), async () => {
    const latest = await readPatch();
    if (samePatch(original, latest)) return;
    const yaml = await yamlParser();
    const before = patchDocument(yaml, original);
    const after = patchDocument(yaml, latest);
    const owned = patch => ownsPatch(yaml, rows, patch);
    const unrelated = patch => !owned(patch);
    const desired = before.contents.items.filter(owned);
    const current = after.contents.items.filter(owned);
    const unrelatedSame = selectedPatchText(before, unrelated, true) === selectedPatchText(after, unrelated, true);
    if (hasAliasedPatchTarget(yaml, before, after) || hasCrossReference(yaml, [...desired, ...current])) throw new NativeRecoveryFailure('settings-alias-conflict');
    if (selectedPatchText(before, owned) === selectedPatchText(after, owned)) return;
    if (unrelatedSame) {
      if (original === undefined) await rm(patchPath, { force: true });
      else await writeFileAtomic(patchPath, original, { mode: 0o600 });
      return;
    }
    const index = after.contents.items.findIndex(owned);
    after.contents.items = after.contents.items.filter(unrelated);
    after.contents.items.splice(index < 0 ? after.contents.items.length : index, 0, ...desired);
    await writeFileAtomic(patchPath, String(after), { mode: 0o600 });
  }, { waitMs: 5000 });
}
async function bundleSettingsMatch(original, rows) {
  const latest = await readPatch();
  if (samePatch(original, latest)) return true;
  const yaml = await yamlParser();
  const select = patch => ownsPatch(yaml, rows, patch);
  const before = patchDocument(yaml, original);
  const after = patchDocument(yaml, latest);
  if (hasAliasedPatchTarget(yaml, before, after) || hasCrossReference(yaml, [...before.contents.items.filter(select), ...after.contents.items.filter(select)])) return false;
  return selectedPatchText(before, select) === selectedPatchText(after, select);
}
async function replaceNativeBundle(invoke, args) {
  const { packageName, previous, next, authorizationUrl } = args.replacement;
  const oldPath = archivePath(previous.integrity), newPath = archivePath(next.integrity);
  const { registry, requestId } = args.options ?? {};
  const fail = (replacement, reason, recovery) => ({ replacement, reason, ...(recovery ? { recovery } : {}) });
  if (!oldPath || !newPath || newPath !== args.spec || newPath === oldPath ||
    typeof packageName !== 'string' || typeof previous.enabled !== 'boolean' ||
    typeof previous.version !== 'string' || typeof next.version !== 'string' || typeof authorizationUrl !== 'string')
    return fail('changed', 'invalid-update');
  // A disconnected observer does not cancel a profile mutation or its compensating work.
  const signal = new AbortController().signal;
  const call = (endpoint, input) => invoke(endpoint, input, signal);
  const inventory = () => call(${JSON.stringify(DSH_BUNDLE_LIST)}, {});
  const owned = rows => rows.find(row => row.name === packageName && (row.installed || row.enabled));
  const current = async () => owned(await inventory());
  const matches = (row, path, version) => row?.installed === true && row.source === 'file:' + path && row.version === version;
  const sameState = (row, path, version) => matches(row, path, version) && row.enabled === previous.enabled && !row.error;
  const verify = (path, integrity) => verifiedArchive(path, integrity).catch(() => false);
  const installedArchive = (path, integrity) => resolvedArchive(packageName, path, integrity).catch(() => false);
  const remove = (name = packageName) => call(${JSON.stringify(DSH_BUNDLE_REMOVE)}, { name });
  const select = enabled => call(${JSON.stringify(DSH_BUNDLE_ENABLE)}, { name: packageName, enabled });
  const install = (spec, id, enabled) => call(${JSON.stringify(DSH_BUNDLE_INSTALL)}, {
    spec, options: { enabled, ...(registry === undefined ? {} : { registry }), ...(id === undefined ? {} : { requestId: id }) },
  });
  // DSH normalizes relative bundle modules against the stable profile dependency path.
  // When a new bundle changes the row/module identity, refuse to silently drop its saved overrides.
  const settingsCompatible = async (before, after, original) => {
    if (original === undefined || !before.rows?.length) return true;
    const yaml = await yamlParser();
    const document = patchDocument(yaml, original);
    const retained = old => after.rows?.some(row => row.rowId === old.rowId && row.moduleName === old.moduleName);
    if (hasAliasedPatchTarget(yaml, document)) return before.rows.every(retained);
    return document.contents.items.every(patch => {
      if (!yaml.isMap(patch) || patch.has('insert')) return true;
      const old = before.rows.find(row => row.rowId === patch.get('id') && (!patch.has('name') || row.moduleName === patch.get('name')));
      return !old || retained(old);
    });
  };
  let recovery, originalPatch, before;
  const clean = () => recovery ? rm(recovery, { recursive: true, force: true }).catch(() => {}) : undefined;
  try {
    if (!(await installedArchive(oldPath, previous.integrity)) || !(await verify(newPath, next.integrity)))
      return fail('changed', 'archive-unverified');
    before = await current();
    if (!sameState(before, oldPath, previous.version) || !before.removable) return fail('changed', 'copy-changed');
    recovery = await mkdtemp(join(archiveDirectory, 'recovery-'));
    const savedArchive = join(recovery, 'previous.tgz');
    await copyArchive(oldPath, savedArchive);
    if (!(await verify(savedArchive, previous.integrity))) throw new NativeRecoveryFailure('archive-unverified');
    originalPatch = await readPatch();
    for (const name of ${JSON.stringify([DSH_PROFILE_MANIFEST, DSH_PROFILE_LOCK])}) {
      const data = await readOptionalProfileFile(join(profileDirectory, name));
      if (data !== undefined) await writeFile(join(recovery, name), data, { flag: 'wx', mode: 0o600 });
    }
    if (originalPatch !== undefined) await writeFile(join(recovery, patchName), originalPatch, { flag: 'wx', mode: 0o600 });
    await writeFile(join(recovery, 'update.json'), JSON.stringify({ requestId, packageName, previous, next, oldPath }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await clean();
    return fail('changed', error instanceof NativeRecoveryFailure ? error.code : 'recovery-preparation-failed');
  }
  // Authorize after the backup and native checks, immediately before changing the dependency.
  let occupied;
  try {
    if (!(await installedArchive(oldPath, previous.integrity)) || !(await verify(newPath, next.integrity)) ||
      !(await bundleSettingsMatch(originalPatch, before.rows ?? []))) throw new NativeRecoveryFailure('copy-changed');
    const confirmation = await fetch(authorizationUrl, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(20000) });
    const rows = await inventory();
    const actual = owned(rows);
    if (!confirmation.ok || !sameState(actual, oldPath, previous.version) || !actual.removable) throw new NativeRecoveryFailure('copy-changed');
    occupied = new Set(rows.filter(row => row.installed || row.enabled).map(row => row.name));
  } catch {
    await clean();
    return fail('changed', 'admission-changed');
  }
  const recoveryName = recovery.slice(archiveDirectory.length + 1);
  const record = (result, reason) => writeFile(join(recovery, 'result.json'), JSON.stringify({ result, reason }), { mode: 0o600 }).catch(() => {});
  let targetRows = [];
  let targetAttempted = false;
  let restartRequired = false;
  const noteApplication = result => {
    if (result?.application === 'restart-required') restartRequired = true;
    return successful(result);
  };
  let reason = 'remove-failed';
  try {
    const removal = await remove();
    if (noteApplication(removal)) {
      reason = 'target-archive-changed';
      if (!(await verify(newPath, next.integrity))) throw new NativeRecoveryFailure(reason);
      targetAttempted = true;
      reason = 'install-failed';
      const result = await install(newPath, requestId, false);
      if (noteApplication(result) && result.bundle === packageName) {
        reason = 'target-not-confirmed';
        const target = await current();
        if (matches(target, newPath, next.version) && !target.enabled && !target.error && await installedArchive(newPath, next.integrity)) {
          targetRows = target.rows ?? [];
          reason = 'settings-incompatible';
          if (await bundleSettingsMatch(originalPatch, before.rows ?? []) && await settingsCompatible(before, target, originalPatch)) {
            reason = 'activation-failed';
            const selection = previous.enabled ? await select(true) : result;
            if (noteApplication(selection)) {
              reason = 'target-not-confirmed';
              if (sameState(await current(), newPath, next.version) && await bundleSettingsMatch(originalPatch, [...(before.rows ?? []), ...targetRows]) && await installedArchive(newPath, next.integrity)) {
                await clean();
                return { application: restartRequired ? 'restart-required' : 'applied' };
              }
            }
          }
        }
      }
    }
  } catch {}
  try {
    let unexpectedRemains = false;
    if (targetAttempted) {
      const unexpected = (await inventory()).filter(row => row.installed && row.source === 'file:' + newPath && row.name !== packageName);
      for (const row of unexpected) {
        if (occupied.has(row.name) || !row.removable) {
          unexpectedRemains = true;
          continue;
        }
        try { if (!noteApplication(await remove(row.name))) unexpectedRemains = true; }
        catch { unexpectedRemains = true; }
      }
    }
    let actual = await current();
    if (actual?.source === 'file:' + newPath) {
      if (!noteApplication(await remove())) throw new NativeRecoveryFailure('target-removal-failed');
      actual = await current();
    }
    if (actual && !matches(actual, oldPath, previous.version)) throw new NativeRecoveryFailure('unexpected-copy');
    if (!(await verify(oldPath, previous.integrity))) {
      const savedArchive = join(recovery, 'previous.tgz');
      if (!(await verify(savedArchive, previous.integrity))) throw new NativeRecoveryFailure('previous-archive-unverified');
      const restoredArchive = join(recovery, 'restored.tgz');
      await copyArchive(savedArchive, restoredArchive);
      if (!(await verify(restoredArchive, previous.integrity))) throw new NativeRecoveryFailure('previous-archive-unverified');
      await rename(restoredArchive, oldPath);
    }
    const settingsRows = [...(before.rows ?? []), ...targetRows];
    await restoreBundleSettings(originalPatch, settingsRows);
    if (!actual) {
      if (!(await verify(oldPath, previous.integrity))) throw new NativeRecoveryFailure('previous-archive-unverified');
      const restored = await install(oldPath, undefined, false);
      if (!noteApplication(restored) || restored.bundle !== packageName) throw new NativeRecoveryFailure('previous-install-failed');
      actual = await current();
      if (actual?.enabled !== false) throw new NativeRecoveryFailure('previous-copy-not-confirmed');
    }
    if (!matches(actual, oldPath, previous.version) || actual.error || !(await installedArchive(oldPath, previous.integrity)))
      throw new NativeRecoveryFailure('previous-copy-not-confirmed');
    if (actual.enabled !== previous.enabled && !noteApplication(await select(previous.enabled)))
      throw new NativeRecoveryFailure('previous-selection-failed');
    if (!sameState(await current(), oldPath, previous.version) || !(await installedArchive(oldPath, previous.integrity))) throw new NativeRecoveryFailure('previous-copy-not-confirmed');
    if (!(await bundleSettingsMatch(originalPatch, settingsRows))) throw new NativeRecoveryFailure('settings-changed');
    if (unexpectedRemains) throw new NativeRecoveryFailure('unexpected-copy');
    await clean();
    return { ...fail('restored', reason), ...(restartRequired ? { restartRequired: true } : {}) };
  } catch (error) {
    const detail = error instanceof NativeRecoveryFailure ? error.code : 'native-state-unavailable';
    await record('restore-failed', reason + '/' + detail);
    return fail('restore-failed', reason + '/' + detail, recoveryName);
  }
}
`
