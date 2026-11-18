import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'

// Redirect only the installed platform's outbound native inventory RPC.
const original = http.request
const gate = new URL(process.env.PHALANX_TEST_INVENTORY_GATE)
http.request = function request(url, options, callback) {
  if (url instanceof URL && url.hostname === '127.0.0.1' && url.pathname === '/api/pluginManager/listBundles' && options?.method === 'POST') {
    return original.call(this, gate, { ...options, headers: { ...options.headers, 'x-test-inventory-port': url.port } }, callback)
  }
  return original.call(this, url, options, callback)
}
syncBuiltinESMExports()
