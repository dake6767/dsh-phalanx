import { createServer } from 'node:net'

/** Choose a private listener port before advertising a different browser URL. */
export async function loopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Private listener did not allocate a TCP port')
  await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  return address.port
}
