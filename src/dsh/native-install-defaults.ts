import { DSH_BUNDLE_ENABLE, DSH_BUNDLE_INSTALL, DSH_BUNDLE_LIST, DSH_BUNDLE_REMOVE } from './plugin-manager-protocol.js'
import { DSH_CONTAINER_HOME, DSH_PROFILE_MANIFEST, dshHomePath } from './profile-layout.js'
import { mergePluginConfig } from './managed-plugin-access.js'
import { canonicalJson } from '../domain/suite-catalog-document.js'
import { pluginAccessObject } from '../domain/plugin-access.js'

/** Generated with the native mutation queue and its profile file helpers. */
export const nativeInstallDefaultsModule = `
import { randomUUID as defaultsJournalId } from 'node:crypto';
const pluginAccessObject = ${pluginAccessObject.toString()};
const canonicalJson = ${canonicalJson.toString()};
const mergePluginConfig = ${mergePluginConfig.toString()};
const bundleInstalled = (row, spec, version) => row?.installed === true && row.source === 'file:' + spec && row.version === version;
const memberHomeDirectory = ${JSON.stringify(dshHomePath(DSH_CONTAINER_HOME))};
const homePatchPath = join(memberHomeDirectory, patchName);

function defaultDeliveryMatches(delivery, spec, identity = delivery) {
  return delivery?.packageName === identity?.packageName && delivery?.version === identity?.version &&
    delivery?.integrity === identity?.integrity && typeof spec === 'string' && spec === archivePath(delivery?.integrity) &&
    /^(?:@[a-z0-9._-]+[/])?[a-z0-9][a-z0-9._-]*$/.test(delivery?.packageName ?? '') &&
    typeof delivery?.version === 'string' && pluginAccessObject(delivery?.entries);
}

// An existing tagged value, scalar, sequence, or alias owns its entire setting.
function fillMissingSettings(yaml, node, defaults, additions, prefix = []) {
  if (!yaml.isMap(node) || node.tag || !pluginAccessObject(defaults)) return;
  for (const [key, value] of Object.entries(defaults)) {
    const keys = [...prefix, key];
    if (!node.has(key)) {
      node.set(key, value);
      additions.push(keys);
    } else fillMissingSettings(yaml, node.get(key, true), value, additions, keys);
  }
}

const flattenNativeRows = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flattenNativeRows(row.config) : [])]);

const nativeDefaultContextMatches = profile => profile?.dir === profileDirectory &&
  profile.patchPath === patchPath && profile.home === memberHomeDirectory;
const defaultsRows = (yaml, document, target) => document.contents.items.filter(patch =>
  ownsPatch(yaml, [target], patch) && patch.has('config'));

async function nativeDefaultBundle(packageName, profileContext) {
  if (!nativeDefaultContextMatches(profileContext))
    throw new NativeRecoveryFailure('settings-target-changed');
  const require = createRequire(process.argv[1]);
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const directory = boot.resolveBundleDir('dsh', packageName, profileContext.installAnchor, profileDirectory);
  const expectedDirectory = await realpath(join(profileDirectory, 'node_modules', packageName));
  if (expectedDirectory !== await realpath(directory)) throw new NativeRecoveryFailure('settings-target-changed');
  const manifest = boot.readProfileManifest('dsh', directory);
  const ownPatches = boot.bundlePatchPaths(directory, manifest.dsh.bundle).flatMap(file => boot.loadOverlayPatches('dsh', file));
  const declared = flattenNativeRows(ownPatches.flatMap(patch => patch.insert ?? [])).filter(row => !row.group);
  return { require, boot, directory, expectedDirectory, ownPatches, declared };
}

function nativeSettingsRows(rows, bundle) {
  const result = [...rows];
  for (const row of bundle.declared) {
    if (!result.some(existing => existing.rowId === row.id && existing.moduleName === row.name))
      result.push({ rowId: row.id, moduleName: row.name });
  }
  return result;
}

async function writeInstallDefaults(delivery, profileContext, writes, bundle = undefined, journal = undefined) {
  const { packageName, entries } = delivery;
  const { require, boot, directory, expectedDirectory, ownPatches, declared } = bundle ?? await nativeDefaultBundle(packageName, profileContext);
  const anchor = join(profileDirectory, ${JSON.stringify(DSH_PROFILE_MANIFEST)});
  const fromBundle = createRequire(join(directory, 'package.json'));
  const { withFileLock, writeFileAtomic } = await loadDshProfileWriter(require, pathToFileURL);
  return await withFileLock(anchor, async () => {
    const yaml = await yamlParser();
    const layers = [];
    for (const file of [patchPath, homePatchPath]) {
      const original = await readPatch(file);
      const document = patchDocument(yaml, original);
      if (hasAliasedPatchTarget(yaml, document)) throw new NativeRecoveryFailure('settings-alias-conflict');
      const patches = original ? boot.loadOverlayPatches('dsh', file) : [];
      layers.push({ file, document, patches, effects: [] });
    }
    const overlays = profileContext.overlays;
    const dependencies = boot.readBundlePatches('dsh', profileContext);
    const otherPatches = [...dependencies, ...layers.flatMap(layer => layer.patches), ...overlays];
    const occupied = new Set(otherPatches.flatMap(patch => flattenNativeRows(patch.insert ?? []).map(row => row.id)));
    const available = flattenNativeRows(boot.composeEntries([dependencies, ownPatches]));
    for (const [rowId, defaults] of Object.entries(entries)) {
      const declaredRows = declared.filter(row => row.id === rowId && !row.group);
      const source = available.filter(row => row.id === rowId && !row.group);
      if (declaredRows.length !== 1 || source.length !== 1 || source[0].name !== declaredRows[0].name)
        throw new NativeRecoveryFailure('settings-target-changed');
      const moduleName = source[0].name;
      const modulePath = await realpath(fromBundle.resolve(moduleName.startsWith('file:') ? fileURLToPath(moduleName) : moduleName));
      if (!modulePath.startsWith(expectedDirectory + '/')) throw new NativeRecoveryFailure('settings-target-changed');
      const target = { rowId, moduleName };
      if (occupied.has(target.rowId) || overlays.some(patch => patch.id === target.rowId &&
          (!patch.name || patch.name === target.moduleName) && Object.hasOwn(patch, 'config')))
        throw new NativeRecoveryFailure('settings-target-changed');
      // Cordis replaces the whole config field. The last explicit value in
      // either persisted layer owns it, including an explicitly empty scalar.
      const layer = layers.findLast(layer => defaultsRows(yaml, layer.document, target).length) ?? layers[0];
      const explicit = defaultsRows(yaml, layer.document, target).at(-1);
      if (explicit) {
        if (hasCrossReference(yaml, [explicit])) throw new NativeRecoveryFailure('settings-alias-conflict');
        const additions = [];
        fillMissingSettings(yaml, explicit.get('config', true), defaults, additions);
        if (additions.length) layer.effects.push({ target, created: false, additions });
        continue;
      }
      const { document } = layer;
      const config = document.createNode(mergePluginConfig(source[0].config, defaults));
      yaml.visit(config, (_key, node) => {
        if (!yaml.isMap(node) || !node.has('__jsExpr')) return;
        const expression = document.createNode(node.get('__jsExpr'));
        expression.tag = 'tag:yaml.org,2002:js';
        return expression;
      });
      const patch = document.createNode({ id: target.rowId, name: target.moduleName });
      patch.set('config', config);
      document.contents.add(patch);
      layer.effects.push({ target, created: true, additions: [[]] });
    }
    const effects = [];
    for (const { file, document, effects: planned } of layers) {
      if (!planned.length) continue;
      if (journal) for (const effect of planned) {
        const row = defaultsRows(yaml, document, effect.target).at(-1);
        effect.marker = defaultsJournalId();
        annotateDefaultsRow(row, effect.marker);
      }
      const updated = Buffer.from(String(document));
      writes.push({ file, updated });
      if (!journal) continue;
      // Read the rendered YAML so the record contains the same tagged values,
      // scalar types and comments a later process will find on disk.
      const rendered = patchDocument(yaml, updated);
      for (const { target, created, additions, marker } of planned) {
        const rows = defaultsRows(yaml, rendered, target);
        const row = markedDefaultsRow(rows, marker);
        if (!row) throw new NativeRecoveryFailure('install-defaults-recovery-invalid');
        const config = row.get('config', true);
        effects.push({ layer: file === patchPath ? 'profile' : 'home', ...target, created, marker,
          additions: additions.map(keys => ({ keys, value: serializeStagedNode(yaml, yamlValueAt(yaml, config, keys)) })),
        });
      }
    }
    // Persist the compensation plan before either file can change.
    if (journal) await journal(effects);
    for (const write of writes) await writeFileAtomic(write.file, write.updated, { mode: 0o600 });
  }, { waitMs: 5000 });
}

const defaultsNote = marker => ' [phalanx-install-defaults:' + marker + ']';

function annotateDefaultsRow(row, marker) {
  const id = row.get('id', true);
  const lines = (id.comment ?? '').split('\\n');
  lines[0] += defaultsNote(marker);
  id.comment = lines.join('\\n');
}

function markedDefaultsRow(rows, marker) {
  const matching = rows.filter(row => row.get('id', true)?.comment?.includes(defaultsNote(marker)));
  return matching.length === 1 ? matching[0] : undefined;
}

function clearDefaultsNote(row, marker) {
  const id = row.get('id', true);
  const comment = id.comment.replace(defaultsNote(marker), '');
  id.comment = comment.trim() ? comment : undefined;
}

function yamlValueAt(yaml, node, keys) {
  for (const key of keys) {
    if (!yaml.isMap(node) || node.tag || node.anchor) return;
    node = node.get(key, true);
  }
  return node;
}

function serializeStagedNode(yaml, node) {
  const document = new yaml.Document();
  document.contents = node.clone();
  return String(document);
}

const sameNodeNotes = (current, staged) => current?.tag === staged?.tag &&
  current?.anchor === staged?.anchor && current?.comment === staged?.comment &&
  current?.commentBefore === staged?.commentBefore;

function sameStagedNode(yaml, current, staged) {
  if (!sameNodeNotes(current, staged)) return false;
  if (yaml.isScalar(staged)) return yaml.isScalar(current) && Object.is(current.value, staged.value);
  if (yaml.isSeq(staged)) return yaml.isSeq(current) && current.items.length === staged.items.length &&
    staged.items.every((node, index) => sameStagedNode(yaml, current.items[index], node));
  if (yaml.isMap(staged)) return yaml.isMap(current) && current.items.length === staged.items.length &&
    staged.items.every((pair, index) => sameStagedNode(yaml, current.items[index].key, pair.key) &&
      sameStagedNode(yaml, current.items[index].value, pair.value));
  return current === staged;
}

// Drop untouched additions at their leaves. Data the member wrote below a
// platform-added object keeps that object alive, including arrays and tags.
function removeStagedNode(yaml, current, staged) {
  if (!yaml.isMap(current) || !yaml.isMap(staged) || current.tag || current.anchor)
    return sameStagedNode(yaml, current, staged);
  for (const expected of staged.items) {
    const key = expected.key.value;
    const observed = current.items.find(pair => yaml.isScalar(pair.key) && pair.key.value === key);
    if (observed && sameStagedNode(yaml, observed.key, expected.key) && removeStagedNode(yaml, observed.value, expected.value))
      current.delete(key);
  }
  return current.items.length === 0 && sameNodeNotes(current, staged);
}

async function restorePendingDefaultEffects(effects, undo = true) {
  if (effects === undefined || (Array.isArray(effects) && effects.length === 0)) return;
  if (!Array.isArray(effects) || effects.length > 64) throw new NativeRecoveryFailure('install-defaults-recovery-invalid');
  const require = createRequire(process.argv[1]);
  const { withFileLock, writeFileAtomic } = await loadDshProfileWriter(require, pathToFileURL);
  const anchor = join(profileDirectory, ${JSON.stringify(DSH_PROFILE_MANIFEST)});
  const yaml = await yamlParser();
  await withFileLock(anchor, async () => {
    const layers = new Map();
    for (const effect of effects) {
      if (!['profile', 'home'].includes(effect?.layer) || typeof effect.rowId !== 'string' ||
          typeof effect.moduleName !== 'string' || typeof effect.marker !== 'string' || !/^[a-f0-9-]{36}$/.test(effect.marker) ||
          typeof effect.created !== 'boolean' || !Array.isArray(effect.additions))
        throw new NativeRecoveryFailure('install-defaults-recovery-invalid');
      const file = effect.layer === 'profile' ? patchPath : homePatchPath;
      if (!layers.has(file)) {
        const document = patchDocument(yaml, await readPatch(file));
        layers.set(file, { document, before: String(document) });
      }
      const { document } = layers.get(file);
      const row = markedDefaultsRow(defaultsRows(yaml, document, effect), effect.marker);
      // No marker can mean that this write never ran or the member removed it.
      // An ambiguous mark is not authority to edit either matching row.
      if (!row || row.tag || row.anchor) continue;
      clearDefaultsNote(row, effect.marker);
      for (const addition of undo ? effect.additions : []) {
        const keys = addition?.keys;
        if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string') ||
            (keys.length === 0 && !effect.created) || typeof addition.value !== 'string')
          throw new NativeRecoveryFailure('install-defaults-recovery-invalid');
        const expected = yaml.parseDocument(addition.value, { customTags: profilePatchTags });
        if (expected.errors.length || !expected.contents) throw new NativeRecoveryFailure('install-defaults-recovery-invalid');
        const config = row.get('config', true);
        const parent = keys.length ? yamlValueAt(yaml, config, keys.slice(0, -1)) : row;
        if (!yaml.isMap(parent) || parent.tag || parent.anchor) continue;
        const key = keys.at(-1) ?? 'config';
        const pair = parent.items.find(item => yaml.isScalar(item.key) && item.key.value === key);
        if (!pair || pair.key.comment || pair.key.commentBefore || pair.key.anchor) continue;
        if (!removeStagedNode(yaml, pair.value, expected.contents)) continue;
        const pristineRow = keys.length === 0 && row.items.length === 3 && row.get('name') === effect.moduleName &&
          !row.comment && !row.commentBefore && row.items.every(item => !item.key.comment && !item.key.commentBefore &&
            (item === pair || (!item.value?.comment && !item.value?.commentBefore && !item.value?.anchor)));
        if (pristineRow) document.contents.items.splice(document.contents.items.indexOf(row), 1);
        else parent.delete(key);
      }
    }
    for (const [file, { document, before }] of layers) {
      const next = String(document);
      if (next !== before) await writeFileAtomic(file, next, { mode: 0o600 });
    }
  }, { waitMs: 5000 });
}

async function defaultSettingsMatch(original, rows, writes = []) {
  for (const layer of original) {
    const write = writes.find(change => change.file === layer.file);
    if (!await bundleSettingsMatch(write ? write.updated : layer.original, rows, layer.file)) return false;
  }
  return true;
}

async function restoreDefaultSettings(original, rows) {
  for (const layer of original) await restoreBundleSettings(layer.original, rows, layer.file);
}

async function readInstallSettings(home) {
  const files = home ? [patchPath, homePatchPath] : [patchPath];
  return await Promise.all(files.map(async file => ({ file, original: await readPatch(file) })));
}

const defaultIntentPath = spec => spec + '.install-defaults.json';
const defaultsFingerprint = entries => createHash('sha256').update(canonicalJson(entries)).digest('hex');
const defaultIntent = (delivery) => ({
  packageName: delivery.packageName, version: delivery.version, integrity: delivery.integrity, defaults: defaultsFingerprint(delivery.entries),
});

async function readDefaultIntent(spec) {
  const bytes = await readOptionalProfileFile(defaultIntentPath(spec));
  try { return bytes ? JSON.parse(bytes.toString('utf8')) : undefined; }
  catch { return undefined; }
}

function matchesDefaultIntent(intent, identity) {
  return intent?.packageName === identity.packageName && intent?.version === identity.version && intent?.integrity === identity.integrity &&
    typeof intent?.defaults === 'string' && /^[a-f0-9]{64}$/.test(intent.defaults);
}

// Only the same catalog contract can resume an interrupted signed install.
// A superseded copy remains visible so the member can remove it.
async function pendingNativeDefaults(bundle) {
  if (!bundle?.installed || typeof bundle.source !== 'string' || !bundle.source.startsWith('file:' + archiveDirectory + '/')) return;
  const spec = bundle.source.slice(5);
  const match = /^([a-f0-9]{128})[.]tgz$/.exec(spec.slice(archiveDirectory.length + 1));
  if (!match) return;
  const integrity = 'sha512-' + Buffer.from(match[1], 'hex').toString('base64');
  const identity = { packageName: bundle.name, version: bundle.version, integrity };
  const intent = await readDefaultIntent(spec).catch(() => undefined);
  if (!matchesDefaultIntent(intent, identity)) return;
  return { spec, fingerprint: intent.discarding ? 'discarding' : intent.defaults, intent };
}

async function discardPendingDefaultEffects(pending) {
  const require = createRequire(process.argv[1]);
  const { writeFileAtomic } = await loadDshProfileWriter(require, pathToFileURL);
  const path = defaultIntentPath(pending.spec);
  const intent = { ...pending.intent, configured: false, discarding: true };
  await writeFileAtomic(path, JSON.stringify(intent), { mode: 0o600 });
  await restorePendingDefaultEffects(intent.effects);
  await writeFileAtomic(path, JSON.stringify({ ...intent, effects: [] }), { mode: 0o600 });
}

async function installNativeBundleWithDefaults(invoke, args, profileContext) {
  const { spec, options, installDefaults: delivery } = args;
  const fail = code => ({ error: { code } });
  if (!defaultDeliveryMatches(delivery, spec)) return fail('install-defaults-invalid');
  const { packageName, version, integrity } = delivery;
  const signal = new AbortController().signal;
  const call = (endpoint, input) => invoke(endpoint, input, signal);
  const current = async () => (await call(${JSON.stringify(DSH_BUNDLE_LIST)}, {}))
    .find(row => row.name === packageName && (row.installed || row.enabled));
  if (!await verifiedArchive(spec, integrity)) return fail('install-defaults-target-changed');
  const before = await current();
  const recorded = await readDefaultIntent(spec);
  const intent = defaultIntent(delivery);
  const resumed = !!before && matchesDefaultIntent(recorded, delivery) && !recorded.discarding && recorded.defaults === intent.defaults &&
    bundleInstalled(before, spec, version) && !before.error && (!before.enabled || recorded.configured === true) && await resolvedArchive(packageName, spec, integrity);
  if (before && !resumed) return fail('install-defaults-target-changed');
  const path = defaultIntentPath(spec);
  const require = createRequire(process.argv[1]);
  const { writeFileAtomic } = await loadDshProfileWriter(require, pathToFileURL);
  const saveIntent = state => {
    const bytes = JSON.stringify({ ...intent, ...state });
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new NativeRecoveryFailure('install-defaults-recovery-too-large');
    return writeFileAtomic(path, bytes, { mode: 0o600 });
  };
  let original;
  const writeChanges = [];
  let effects = [];
  let targetRows = [];
  let confirmed = false;
  try {
    if (before?.enabled) {
      // A target with this intent was enabled only after its settings were saved.
      confirmed = true;
      await rm(path, { force: true });
      await restorePendingDefaultEffects(recorded.effects, false).catch(() => {});
      return { application: 'applied', bundle: packageName, version, enabled: true };
    }
    if (matchesDefaultIntent(recorded, delivery)) await restorePendingDefaultEffects(recorded.effects);
    await saveIntent({ configured: false });
    original = await readInstallSettings(true);
    const installed = resumed ? { application: 'applied', bundle: packageName, version } :
      await call(${JSON.stringify(DSH_BUNDLE_INSTALL)}, { spec, options: { ...options, enabled: false, expected: { name: packageName, version } } });
    if (!successful(installed)) {
      if (await current()) throw new NativeRecoveryFailure('install-defaults-apply-failed');
      await rm(path, { force: true });
      return installed;
    }
    const target = await current();
    if (installed.bundle !== packageName || !bundleInstalled(target, spec, version) || target.enabled || target.error ||
        !await resolvedArchive(packageName, spec, integrity)) throw new NativeRecoveryFailure('install-defaults-target-changed');
    const definition = await nativeDefaultBundle(packageName, profileContext);
    targetRows = nativeSettingsRows(target.rows ?? [], definition);
    await writeInstallDefaults(delivery, profileContext, writeChanges, definition, async planned => {
      await saveIntent({ configured: false, effects: planned });
      effects = planned;
    });
    await saveIntent({ configured: true, effects });
    const selection = await call(${JSON.stringify(DSH_BUNDLE_ENABLE)}, { name: packageName, enabled: true });
    const selected = await current();
    if (!successful(selection) || !bundleInstalled(selected, spec, version) || !selected.enabled || selected.error ||
        !await defaultSettingsMatch(original, targetRows, writeChanges)) throw new NativeRecoveryFailure('install-defaults-activation-failed');
    confirmed = true;
    await rm(path, { force: true });
    await restorePendingDefaultEffects(effects, false).catch(() => {});
    return { ...installed, enabled: true, application: installed.application === 'restart-required' || selection.application === 'restart-required' ? 'restart-required' : 'applied' };
  } catch (error) {
    if (confirmed || !original) return fail('install-defaults-retry-needed');
    try {
      const target = await current();
      if (target && !bundleInstalled(target, spec, version)) return fail('install-defaults-restore-failed');
      if (target && resumed && target.enabled) {
        if (!successful(await call(${JSON.stringify(DSH_BUNDLE_ENABLE)}, { name: packageName, enabled: false })))
          return fail('install-defaults-restore-failed');
      } else if (target && !resumed) {
        if (!successful(await call(${JSON.stringify(DSH_BUNDLE_REMOVE)}, { name: packageName })) || await current())
          return fail('install-defaults-restore-failed');
      }
      if (await defaultSettingsMatch(original, targetRows, writeChanges)) await restoreDefaultSettings(original, targetRows);
      else await restorePendingDefaultEffects(effects);
      if (resumed) await saveIntent({ configured: false });
      else await rm(path, { force: true });
    } catch {
      return fail('install-defaults-restore-failed');
    }
    return fail(error instanceof NativeRecoveryFailure ? error.code : 'install-defaults-apply-failed');
  }
}
`
