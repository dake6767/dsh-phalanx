/** Acceptance caller of the public service; no sample implementation is imported. */
export const name = 'plugin-access-probe'
export const inject = ['web', 'webServer']
export function apply(ctx) {
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
