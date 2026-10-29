import { createServer } from 'node:http'

/** Real HTTP fixture for wrapper transport; authorization policy is covered separately against PG. */
export async function serveMemberMcpInput(configuration: unknown, diagnostic = false) {
  const token = 'm'.repeat(43),
    path = `/mcp-member${diagnostic ? '-test' : ''}/p-test?generation=1`
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== path || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(configuration))
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  return {
    reference: JSON.stringify({ path }),
    access: { url, token },
    environment: { DSH_PHALANX_MODEL_GATEWAY_URL: url, DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: token },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => resolve())
      })
    },
  }
}
