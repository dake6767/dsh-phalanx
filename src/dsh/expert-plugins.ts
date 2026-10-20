export const EXPERT_PLUGIN_STATUS_PATH = '/phalanx-expert-plugin-status'

/** Final preset loader: each package is loaded once, and failed packages finish teardown before audit. */
export const expertPluginLoader = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const runtime = createRequire(process.argv[1]);
const { EntryTree, EntryGroup } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/cordis-plugin-loader')).href);
const { Context } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/cordis')).href);
// FiberState is a public const enum in the pinned SDK, erased from its JavaScript exports.
const FAILED = 3;
const PENDING = 0;
class MemoryTree extends EntryTree { write() {} }
export const name = 'phalanx-expert-plugins';
export const inject = ['loader'];
export async function apply(ctx, config) {
  const tree = new MemoryTree(ctx), failures = new Set(), lostServices = new Set();
  ctx.effect(() => () => tree.root.stop());
  await tree.root.update([{ id: 'expert-plugin-scope', name: 'cordis:group', group: true,
    isolate: Object.fromEntries(config.services.map(name => [name, true])),
    config: config.packages.map((row, index) => ({ id: 'package-' + index, name: 'cordis:group', group: true, config: row.entries })) }]);
  const packages = new Map(config.packages.map((row, index) => [tree.resolve('package-' + index), row]));
  const owner = entry => {
    if (packages.has(entry)) return entry;
    const seen = new Set();
    for (let fiber = entry.parent.ctx.fiber; fiber && !seen.has(fiber); fiber = fiber.parent?.fiber) {
      seen.add(fiber);
      if (packages.has(fiber.entry)) return fiber.entry;
    }
  };
  while (true) {
    await tree.await();
    const rejected = new Set();
    for (const entry of tree.entries()) {
      if (entry.disabled) continue;
      if (!entry.fiber || entry.fiber.state === FAILED) { const parent = owner(entry); if (parent) rejected.add(parent); }
      else if (entry.fiber.state === PENDING && Object.keys(entry.fiber.inject).some(name => lostServices.has(name) && entry.fiber.ctx.get(name) === undefined)) {
        const parent = owner(entry); if (parent) rejected.add(parent);
      }
    }
    // An older artifact or a conditional service may not have a preparation-time inventory.
    // Discard only its owning package if it publishes into the root realm.
    for (const key of Object.getOwnPropertySymbols(ctx.reflect.store)) {
      const impl = ctx.reflect.store[key];
      if (!impl || ctx.root[Context.isolate][impl.name] !== key) continue;
      const seen = new Set();
      for (let fiber = impl.fiber; fiber && !seen.has(fiber); fiber = fiber.parent?.fiber) {
        seen.add(fiber);
        if (packages.has(fiber.entry)) { lostServices.add(impl.name); rejected.add(fiber.entry); break; }
      }
    }
    if (!rejected.size) break;
    for (const entry of rejected) {
      const row = packages.get(entry); failures.add(row.failureId ?? 'plugin:' + row.packageName);
      for (const service of row.services ?? []) lostServices.add(service);
      packages.delete(entry);
      const fiber = entry.fiber;
      tree.remove(entry.options.id);
      if (fiber) await fiber.dispose();
    }
  }
  ctx.on('phalanx/expert-plugin-status', rows => rows.push({ id: config.id, entries: [...failures].sort() }), { global: true });
}
// Keep nested expressions in their actual child plugin context.
apply[EntryGroup.key] = true;
`

/** Public event collection keeps diagnostics separate from plugin values and credentials. */
export const expertPluginStatusObserver = String.raw`
export const name = 'phalanx-expert-plugin-status';
export const inject = ['webServer'];
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '${EXPERT_PLUGIN_STATUS_PATH}', handler: (_req, res) => {
    const rows = []; ctx.emit('phalanx/expert-plugin-status', rows);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(rows));
  } }));
}
`
