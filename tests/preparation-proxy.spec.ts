import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { egressProxy } from './fixtures/egress-proxy.js'
import { DevelopmentExecutionProcess } from '../src/adapters/execution-development-process.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { RuntimeDependencyPreparer } from '../src/adapters/runtime-dependency-preparer.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { preparationProxyBootstrap } from '../src/adapters/outbound-proxy.js'

it.each(['curl', 'node'])('prepares with %s through CONNECT, bypasses local traffic and redacts proxy credentials', async tool => {
  const proxy = await egressProxy(), root = await mkdtemp(join(tmpdir(), 'proxy-preparation-'))
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) vi.stubEnv(name, '')
  vi.stubEnv('https_proxy', proxy.proxy); vi.stubEnv('no_proxy', '.internal.test')
  const process = Object.assign(new DevelopmentExecutionProcess(), { isolated: false, canDiscardArtifacts: true, recover: async () => {}, imageIdentity: async () => 'development' })
  const preparer = new RuntimeDependencyPreparer(process, new FileExecutionArtifacts(root))
  const logs: string[] = []
  const download = tool === 'curl' ? `curl --fail --silent --show-error --max-time 5 --cacert '${proxy.ca}' '${proxy.url}' -o bin/tool`
    : `NODE_EXTRA_CA_CERTS='${proxy.ca}' node --input-type=module -e 'import { writeFile } from "node:fs/promises"; const response = await fetch("${proxy.url}", { signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error("Download failed"); await writeFile("bin/tool", await response.text())'`
  const input = { name: 'proxy-test', pathDirectories: ['bin'], prepareCommand: `set -e; mkdir bin; ${download}; chmod +x bin/tool; printf '%s\\n' "$HTTPS_PROXY"`, checkCommand: 'tool' }
  try {
    const result = await preparer.prepare(input, async log => { logs.push(log) }, new AbortController().signal)
    expect(proxy.connects).toEqual(['proxy-fixture.test:443'])
    expect(await readFile(join(result.directory, 'bin/tool'), 'utf8')).toContain('proxy-ready')
    expect(result.log).toContain('proxy-ready')
    expect([...logs, result.log].join()).not.toContain('fixture-proxy-password')
    const local = await preparer.prepare({ ...input, prepareCommand: input.prepareCommand.replace(proxy.url, proxy.direct) }, async () => {}, new AbortController().signal)
    expect(local.checks.every(row => row.passed)).toBe(true)
    expect(proxy.connects).toHaveLength(1)
    proxy.fail()
    await expect(preparer.prepare(input, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'prepare-failed', log: expect.stringContaining('HTTPS_PROXY') })
  } finally { vi.unstubAllEnvs(); await proxy.close(); await preparer.collect([]); await rm(root, { recursive: true, force: true }) }
})

it('downloads with the plugin preparation stdin envelope and propagates a failed child', async () => {
  const proxy = await egressProxy()
  const command = [ '-e', preparationProxyBootstrap, process.execPath, '--input-type=module', '-e', `const response = await fetch('${proxy.url}', { signal: AbortSignal.timeout(5000) }); if (!response.ok) throw Error('Download failed'); console.log(await response.text())` ]
  const options = { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: proxy.ca }, input: JSON.stringify({ HTTPS_PROXY: proxy.proxy, NODE_USE_ENV_PROXY: '1' }) }
  try {
    expect(await execFileText(process.execPath, command, options)).toContain('proxy-ready')
    expect(proxy.connects).toEqual(['proxy-fixture.test:443'])
    proxy.fail()
    await expect(execFileText(process.execPath, command, options)).rejects.toThrow()
  } finally { await proxy.close() }
})
