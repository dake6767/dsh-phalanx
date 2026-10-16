/** Acceptance caller of the public service; no sample implementation is imported. */
export const name = 'plugin-access-probe'
export const inject = ['web', 'webServer', 'credentials']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/credential-probe',
    handler: async (_request, response) => {
      const facts = {};
      for (const ref of ['ANYSEARCH_API_KEY', 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN', 'PERSONAL_FIXTURE_KEY']) {
        const resolved = await ctx.credentials.resolve(ref);
        facts[ref] = { source: resolved?.source, matchesEnvironment: resolved?.value === process.env[ref] };
      }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(facts));
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/access-probe',
    handler: async (_request, response) => {
      try {
        const result = await ctx.web.search({ query: 'ACCESS_READY' })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(result))
      } catch (error) { response.statusCode = 500; response.end(String(error)) }
    },
  }))
}
