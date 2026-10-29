import { spawn } from 'node:child_process'
import { registerValidationProcessGroup } from './validation-process-group.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TestCommunityConfig } from './community-application.js'
import type { CommunityApplication } from '../../src/ports/community-application.js'
import { createCommunityApplication, withTestDatabase, seedTestSecrets } from './community-application.js'
import { validationDownloadSelection } from './validation-downloads.js'

interface TestOptions {
  readonly testOnlyWebToolsUpstreamBaseUrl?: string
  readonly testOnlyDenyUsage?: boolean
}

/** Internal injection runs the verified installed modules with their bundled Node; normal candidate tests retain the public CLI. */
export function injectedCandidateApplication(config: TestCommunityConfig, options: TestOptions): CommunityApplication {
  config = { ...withTestDatabase(config), downloadSources: config.downloadSources ?? validationDownloadSelection() }
  const inventory = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
  if (config.network === undefined && inventory !== undefined)
    config = { ...config, network: { hostPublicAddresses: inventory.trim() ? inventory.split(',').map(value => value.trim()) : [] } }
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (installed === undefined) {
    if (config.runtime.container) throw Error('Installed candidate is required for injected container acceptance')
    return createCommunityApplication(config, {
      ...(options.testOnlyWebToolsUpstreamBaseUrl === undefined ? {} : { testOnlyWebToolsUpstreamBaseUrl: options.testOnlyWebToolsUpstreamBaseUrl }),
      ...(options.testOnlyDenyUsage ? { testOnlyUsageDecision: { allow: () => false } } : {}),
    })
  }
  const build = JSON.parse(readFileSync(join(installed, 'build-info.json'), 'utf8')) as { commit: string; platform: string }
  const platform = process.platform === 'linux' && process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
  if (!process.env.DSH_PHALANX_CANDIDATE_SHA || build.commit !== process.env.DSH_PHALANX_CANDIDATE_SHA || build.platform !== platform)
    throw Error('Installed candidate identity mismatch')
  const script = `import {createCommunityApplication} from ${JSON.stringify(pathToFileURL(join(installed, 'dist/composition/community-application.js')).href)};
let app;
process.on('SIGTERM',async()=>{try{await app?.stop();process.exit(0)}catch{process.exit(1)}});
process.once('message',async({config,options})=>{try{
app=createCommunityApplication(config,{...(options.testOnlyWebToolsUpstreamBaseUrl===undefined?{}:{testOnlyWebToolsUpstreamBaseUrl:options.testOnlyWebToolsUpstreamBaseUrl}),...(options.testOnlyDenyUsage?{testOnlyUsageDecision:{allow:()=>false}}:{})});
process.send({origin:await app.start()});
}catch{process.send({error:true});process.exit(1)}});`
  let stop: (() => Promise<void>) | undefined
  return {
    start: async () => {
      await seedTestSecrets(config, installed)
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_PHALANX_')))
      const child = spawn(join(installed, 'node/bin/node'), ['--input-type=module', '-e', script], {
        cwd: installed,
        detached: true,
        env: inherited,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      registerValidationProcessGroup(child.pid)
      child.stdout?.resume()
      child.stderr?.resume()
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      stop = async () => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
        const result = await exited
        if (result.code !== 0 || result.signal !== null)
          throw Error(`Injected installed application did not stop cleanly (code ${result.code}, signal ${result.signal})`)
      }
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        return await new Promise<string>((resolve, reject) => {
          deadline = setTimeout(() => reject(Error('Injected installed application did not report readiness')), 30000)
          child.once('error', reject)
          child.once('exit', () => reject(Error('Injected installed application exited before readiness')))
          child.once('message', message => {
            const result = message as { origin?: string }
            if (typeof result.origin === 'string') resolve(result.origin)
            else reject(Error('Injected installed application failed'))
          })
          const production = { ...config }
          delete production.sessionSecret
          delete production.modelGateway
          child.send({ config: production, options })
        })
      } catch (error) {
        try {
          await stop()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Injected installed application startup and cleanup failed')
        }
        throw error
      } finally {
        if (deadline) clearTimeout(deadline)
      }
    },
    stop: async () => {
      await stop?.()
    },
  }
}
