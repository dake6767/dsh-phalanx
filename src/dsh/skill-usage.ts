/** The protected platform plugin's best-effort skill observation channel. */
export const SKILL_USAGE_PATH = '/_dsh-phalanx/usage-skills'
export const SKILL_USAGE_ENDPOINT_ENV = 'DSH_PHALANX_SKILL_USAGE_URL'
export const SKILL_USAGE_PROVIDERS_ENV = 'DSH_PHALANX_SKILL_USAGE_PROVIDERS'

export const skillUsagePlugin = `
export const name = 'phalanx-skill-usage';
export const inject = ['tools'];
export function apply(ctx) {
  let values;
  try { const raw = process.env.${SKILL_USAGE_PROVIDERS_ENV} || '[]'; if (raw.length > 65536) return; values = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(values) || values.length > 256 || values.some(value => typeof value !== 'string' || !value || value.length > 256)) return;
  const providers = new Set(values), pending = new Map(), inflight = new Set();
  let disposed = false, queued = 0;
  ctx.on('tools/result', (exec, result) => {
    try {
      if (disposed || exec.name !== 'skill' || result.isError || !providers.has(result.value?.provider)) return;
      const name = result.value?.name;
      if (typeof name !== 'string' || name.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return;
      const key = JSON.stringify([Math.floor(Date.now() / 86400000), name]), row = pending.get(key);
      if (queued >= 10000 || !row && pending.size >= 100 || row?.count >= 1000) return;
      pending.set(key, { name, count: (row?.count || 0) + 1 }); queued++;
    } catch { /* Observation cannot change the tool result. */ }
  });
  const flush = () => {
    const items = [...pending.values()]; pending.clear(); queued = 0;
    if (disposed || !items.length || inflight.size >= 1) return;
    const controller = new AbortController(); inflight.add(controller);
    const timeout = setTimeout(() => controller.abort(), 2000); timeout.unref?.();
    void (async () => {
      try {
        const response = await fetch(process.env.${SKILL_USAGE_ENDPOINT_ENV}, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN }, body: JSON.stringify({ items }), signal: controller.signal });
        await response.body?.cancel();
      } catch { /* Reports are discarded without retry or session effects. */ }
      finally { clearTimeout(timeout); inflight.delete(controller); }
    })();
  };
  const timer = setInterval(flush, 6000); timer.unref?.();
  ctx.effect(() => () => { disposed = true; clearInterval(timer); pending.clear(); queued = 0; for (const controller of inflight) controller.abort(); inflight.clear(); });
}
`
