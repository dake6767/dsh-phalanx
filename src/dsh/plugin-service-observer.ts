/** Offline preparation observer. Only service names cross the public SDK boundary. */
export const pluginServiceObserver = String.raw`
export const name = 'phalanx-plugin-service-observer';
export const inject = ['webServer'];
export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/phalanx-precheck-services', handler: (_req, res) => {
    const names = new Set();
    for (const key of Object.getOwnPropertySymbols(ctx.reflect.store)) {
      const impl = ctx.reflect.store[key];
      if (!impl) continue;
      const seen = new Set();
      for (let fiber = impl.fiber; fiber && !seen.has(fiber); fiber = fiber.parent?.fiber) {
        seen.add(fiber);
        if (fiber.entry?.options.id?.startsWith(config.prefix + '-')) { names.add(impl.name); break; }
      }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([...names].sort()));
  } }));
}
`
