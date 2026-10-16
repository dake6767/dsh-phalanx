/** Deployer egress is available only to trusted download/preparation processes. */
export function outboundProxyEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const proxy = source.https_proxy ?? source.HTTPS_PROXY ?? ''
  if (!proxy) return {}
  try {
    const url = new URL(proxy)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || !['', '/'].includes(url.pathname) || url.search || url.hash || /\s/u.test(proxy)) throw new Error()
  } catch { throw new Error('HTTPS_PROXY must be a valid HTTP(S) proxy URL.') }
  const bypass = [...new Set([...(source.no_proxy ?? source.NO_PROXY ?? '').split(',').map(value => value.trim()).filter(Boolean), 'localhost', '.localhost', '127.0.0.1', '::1'])].join(',')
  return { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: bypass, no_proxy: bypass, NODE_USE_ENV_PROXY: '1' }
}

/** Redact complete secrets and unfinished trailing fragments before streaming logs. */
export function redactProxyOutput(value: string, environment: Readonly<Record<string, string>>): string {
  const proxy = environment.HTTPS_PROXY
  if (!proxy) return value
  const url = new URL(proxy)
  const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
  const secrets = [proxy, url.username, url.password, decode(url.username), decode(url.password)].filter(Boolean)
  for (const secret of secrets) {
    value = value.replaceAll(secret, '[redacted]')
    for (let length = Math.min(secret.length - 1, value.length); length > 0; length--) {
      if (value.endsWith(secret.slice(0, length))) { value = value.slice(0, -length) + '[redacted]'; break }
    }
  }
  return value
}

/** Private stdin envelope; proxy values never enter the container CLI or image config. */
export const preparationProxyBootstrap = String.raw`
const { readFileSync } = require('node:fs'), { spawn } = require('node:child_process');
const environment = JSON.parse(readFileSync(0, 'utf8'));
const child = spawn(process.argv[1], process.argv.slice(2), { env: { ...process.env, ...environment }, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', () => process.exit(127));
child.on('exit', code => process.exit(code ?? 1));
`
