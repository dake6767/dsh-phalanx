import { randomUUID } from 'node:crypto';
// Acceptance fixture using only public DSH service contracts.
export const name = 'skills-acceptance-observer';
export const inject = ['webServer', 'skills', 'agents', 'sessionController', 'tools', 'pluginManager'];
export function apply(ctx) {
  let changes = 0, failedReports = 0;
  const reportEndpoint = process.env.DSH_PHALANX_SKILL_USAGE_URL;
  ctx.effect(() => () => { if (reportEndpoint === undefined) delete process.env.DSH_PHALANX_SKILL_USAGE_URL; else process.env.DSH_PHALANX_SKILL_USAGE_URL = reportEndpoint; });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/skills-fixture-report-failure', handler: (req) => { failedReports++; req.resume(); req.socket.destroy(); } }));
  const instance = randomUUID();
  ctx.on('skills/change', () => { changes++; });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/skills-fixture', handler: async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : { operation: 'inventory' };
      let value;
      if (input.operation === 'inventory') value = { plugins: await ctx.pluginManager.listPlugins(), changes, instance, failedReports };
      else if (input.operation === 'report-endpoint') { process.env.DSH_PHALANX_SKILL_USAGE_URL = input.mode === 'failure' ? 'http://127.0.0.1:' + req.socket.localPort + '/skills-fixture-report-failure' : reportEndpoint; value = { instance, failedReports }; }
      else if (input.operation === 'report') { const response = await fetch(process.env.DSH_PHALANX_SKILL_USAGE_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN }, body: JSON.stringify(input.report), signal: AbortSignal.timeout(3000) }); value = { status: response.status }; await response.body?.cancel(); }
      else if (input.operation === 'create') value = await ctx.sessionController.create({ cwd: process.cwd(), agentPreset: 'standard' });
      else {
        const agent = ctx.agents.get(input.sessionId);
        if (!agent) throw Error('Session is not live');
        const lookup = { cwd: agent.session.header.cwd, scope: agent, signal: AbortSignal.timeout(15000) };
        if (input.operation === 'events') value = agent.session.snapshotEvents();
        else if (input.operation === 'snapshot') value = { ...(await ctx.skills.snapshot(lookup)), changes };
        else if (input.operation === 'get') value = await ctx.skills.get(input.name, lookup) ?? null;
        else if (input.operation === 'tool') value = await ctx.tools.execute({ callId: 'skills-fixture-' + randomUUID(), name: input.name, arguments: input.args, agent, signal: AbortSignal.timeout(20000) });
        else throw Error('Unknown operation');
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error.stack ?? error) })); }
  } }));
}
