// Validation: T2; real credentials: none; installed global CLI, real systemd and rootless member tasks.
import { join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { Client } from 'pg'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import type { CommunityInstanceResourceMember } from '../src/domain/admin-contract.js'
import type { PlatformDatabaseConnection } from '../src/domain/platform-database.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { deploymentControl, type DeploymentFacts } from './fixtures/deployment-control.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { runCommunityTerminal, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
import { postgresConnection, dropCreatedDatabase } from './support/postgres.js'
import { instanceWorkspacePath } from './support/real-dsh-runtime.js'

const autostart = (result: DeploymentFacts) =>
  Object.fromEntries(result.components.filter(row => row.autostart !== undefined).map(row => [row.name, row.autostart]))

it('stops the installed deployment without detached tasks, preserves data and boot policy, and restores resident rules with built-in and external databases', async test => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !process.env.DSH_PHALANX_CANDIDATE_SHA)
    throw Error('Requires an isolated Linux candidate and root lifecycle guardian')
  const control = await deploymentControl(),
    receipts: unknown[] = []
  const errors: unknown[] = []
  try {
    for (const mode of ['builtin', 'external'] as const) {
      let browser: Browser | undefined, external: PlatformDatabaseConnection | undefined, database: Client | undefined
      let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
      try {
        const scene = await control.request('prepare')
        expect(scene.source).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
        external = mode === 'external' ? postgresConnection() : undefined
        model = await startCommunityModel()
        browser = await chromium.launch({ headless: true })
        const context = await newValidationContext(browser, { locale: 'en' }),
          admin = await context.newPage(),
          origin = scene.origin
        const credential = readBootstrapCredential(scene.dataRoot)
        expect(credential).not.toBeNull()
        await admin.goto(origin + '/bootstrap#credential=' + encodeURIComponent(credential!.credential))
        if (external) {
          await admin.getByRole('heading', { name: 'Platform database', exact: true }).waitFor()
          await admin.getByLabel('Platform database', { exact: true }).selectOption('external')
          for (const [label, value] of [
            ['Database host', external.host],
            ['Database port', String(external.port)],
            ['Database name', external.database],
            ['Database username', external.username],
            ['Database password', external.password],
          ])
            await admin.getByLabel(label!, { exact: true }).fill(value!)
          await admin.getByLabel('TLS mode', { exact: true }).selectOption('disable')
          await admin.getByRole('button', { name: 'Test connection', exact: true }).click()
          await expect.poll(() => admin.getByRole('button', { name: 'Continue', exact: true }).isEnabled(), { timeout: 30_000 }).toBe(true)
          await admin.getByRole('button', { name: 'Continue', exact: true }).click()
        } else await selectBuiltinDatabase(admin)
        await admin.getByLabel('Username').fill('admin')
        await admin.getByLabel('Password', { exact: true }).fill('fictional-lifecycle-password')
        await admin.getByRole('button', { name: 'Create administrator', exact: true }).click()
        await admin.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
        await admin.waitForURL(origin + '/admin')
        const post = (path: string, data: object) => context.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
        expect(
          (
            await post('models', {
              revision: 0,
              action: 'save-provider',
              provider: {
                name: 'Lifecycle fixture',
                baseUrl: model.origin + '/anthropic',
                apiFormat: 'anthropic-messages',
                apiKey: 'community-provider-fixture-key',
                enabled: true,
                models: [{ name: 'deepseek-chat', enabled: true }],
              },
            })
          ).status(),
        ).toBe(200)
        for (const username of ['resident', 'ondemand', 'disabled'])
          expect((await post('accounts', { username, email: '', password: 'fictional-lifecycle-password' })).status()).toBe(201)
        await admin.reload()
        for (const username of ['resident', 'disabled']) {
          await admin.getByRole('button', { name: 'Edit ' + username, exact: true }).click()
          const drawer = admin.getByRole('dialog', { name: 'Edit account: ' + username, exact: true })
          await drawer.getByText('Resident instance', { exact: true }).click()
          await drawer.getByRole('button', { name: 'Save changes', exact: true }).click()
          await drawer.waitFor({ state: 'detached' })
        }
        expect((await post('accounts/disabled/actions', { action: 'set-disabled', disabled: true })).status()).toBe(200)
        const member = async (username: string) =>
          (await (await context.request.get(origin + '/admin/api/instance-resources?username=' + username)).json()) as CommunityInstanceResourceMember
        await expect.poll(async () => (await member('resident')).instanceKey, { timeout: 120_000 }).not.toBeNull()
        const identity = (await member('resident')).spaceId
        const residentContext = await newValidationContext(browser, { locale: 'en' }),
          resident = await residentContext.newPage()
        await signInCommunity(resident, origin, 'resident', 'fictional-lifecycle-password')
        await selectCommunityWorkspace(residentContext, resident, origin, instanceWorkspacePath('', true), true)
        const heartbeatWorker = String.raw`setInterval(() => require('node:fs').appendFileSync('lifecycle-heartbeat.log', 'tick\n'), 200)`
        const heartbeat = `process.chdir(${JSON.stringify(instanceWorkspacePath('', true))});require('node:fs').writeFileSync('lifecycle-retained.txt','LIFECYCLE_DATA_RETAINED');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(heartbeatWorker)}],{detached:true,stdio:'ignore',cwd:process.cwd()});child.unref();console.log('LIFECYCLE_TASK_STARTED')`
        const encoded = Buffer.from(heartbeat).toString('base64')
        await runCommunityTerminal(resident, `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`, 'LIFECYCLE_TASK_STARTED')
        const demandContext = await newValidationContext(browser, { locale: 'en' }),
          demand = await demandContext.newPage()
        await signInCommunity(demand, origin, 'ondemand', 'fictional-lifecycle-password')
        await selectCommunityWorkspace(demandContext, demand, origin, instanceWorkspacePath('', true), true)
        await runCommunityTerminal(demand, 'printf LIFECYCLE_ONDEMAND_READY', 'LIFECYCLE_ONDEMAND_READY')
        await expect.poll(async () => control.request('member-counts'), { timeout: 30_000 }).toEqual({ resident: 1, ondemand: 1, disabled: 0 })
        const firstHeartbeat = (await control.request('heartbeat')).bytes
        await expect.poll(async () => (await control.request('heartbeat')).bytes, { timeout: 5000 }).toBeGreaterThan(firstHeartbeat)
        if (external) {
          database = new Client({
            host: external.host,
            port: external.port,
            database: external.database,
            user: external.username,
            password: external.password,
            ssl: false,
            connectionTimeoutMillis: 10000,
          })
          await database.connect()
          await database.query('CREATE TABLE public.lifecycle_external_probe (value text)')
          await database.query('INSERT INTO public.lifecycle_external_probe VALUES ($1)', ['EXTERNAL_DATABASE_RETAINED'])
        }
        await control.request('hold-lock')
        try {
          expect((await control.request('status')).exitCode).toBe(0)
          for (const action of ['start', 'stop'] as const) {
            const refused = await control.request(action)
            expect(refused.exitCode).toBe(1)
            expect(refused.result.conflict).toBe(true)
          }
        } finally {
          await control.request('release-lock')
        }
        const unavailable = await control.request('query-failed-status')
        expect(unavailable.exitCode).toBe(1)
        expect(unavailable.result.state).toBe('query-failed')
        expect(unavailable.result.components).toContainEqual(expect.objectContaining({ name: 'platform', state: 'running', ready: true }))
        await control.request('maintenance')
        try {
          expect((await control.request('status')).result.state).toBe('maintenance')
          for (const action of ['start', 'stop'] as const) expect((await control.request(action)).exitCode).toBe(1)
        } finally {
          await control.request('clear-maintenance')
        }
        await control.request('detach-platform')
        expect((await control.request('status')).result.state).toBe('partial')
        await control.request('orphan-maintenance')
        const incomplete = await control.request('partial-stop')
        expect(incomplete.exitCode).toBe(1)
        expect(incomplete.result.state).toBe('partial')
        expect(incomplete.result.steps).toContainEqual(expect.objectContaining({ component: 'updater', status: 'failed' }))
        const stopped = await control.request('stop')
        expect(stopped.exitCode).toBe(0)
        expect(stopped.result.state).toBe('stopped')
        expect(autostart(stopped.result)).toEqual(scene.autostart)
        expect(await control.request('audit-stopped')).toEqual({ stopped: true, serviceTasks: 0, memberTasks: 0, maintenanceDescriptors: 0 })
        expect((await control.request('stop')).result.changed).toBe(false)
        const stoppedHeartbeat = (await control.request('heartbeat')).bytes
        if (database)
          expect((await database.query('SELECT value FROM public.lifecycle_external_probe')).rows).toEqual([{ value: 'EXTERNAL_DATABASE_RETAINED' }])
        const started = await control.request('start')
        expect(
          started.exitCode,
          JSON.stringify({
            mode,
            state: started.result.state,
            errors: started.result.errors,
            steps: started.result.steps?.map(({ component, action, status }) => ({ component, action, status })),
          }),
        ).toBe(0)
        expect(started.result.state).toBe('running')
        expect(autostart(started.result)).toEqual(scene.autostart)
        await expect.poll(async () => control.request('member-counts'), { timeout: 120_000 }).toEqual({ resident: 1, ondemand: 0, disabled: 0 })
        expect((await member('resident')).spaceId).toBe(identity)
        expect((await control.request('start')).result.changed).toBe(false)
        expect((await control.request('heartbeat')).bytes).toBe(stoppedHeartbeat)
        const reopened = await newValidationContext(browser, { locale: 'en' }),
          page = await reopened.newPage()
        await signInCommunity(page, origin, 'resident', 'fictional-lifecycle-password')
        expect(
          await readFile(join(scene.userDataRoot, '_spaces', identity, 'home/Documents/deepseek-harness/default-workspace/lifecycle-retained.txt'), 'utf8'),
        ).toBe('LIFECYCLE_DATA_RETAINED')
        await selectCommunityWorkspace(reopened, page, origin, instanceWorkspacePath('', true), true)
        await runCommunityTerminal(page, `cat ${JSON.stringify(join(instanceWorkspacePath('', true), 'lifecycle-retained.txt'))}`, 'LIFECYCLE_DATA_RETAINED')
        receipts.push({
          mode,
          source: scene.source,
          snapshot: scene.receiptSha256,
          allStopped: true,
          noTaskResume: true,
          autostartPreserved: true,
          residentOnly: true,
          externalDatabaseRetained: mode === 'external',
        })
      } finally {
        for (const action of [
          () => saveBrowserEvidence(test),
          async () => {
            const restored = await control.request('restore')
            expect(restored.restored).toBe(true)
            if (restored.autostartPreserved !== undefined) expect(restored.autostartPreserved).toBe(true)
          },
          () => browser?.close(),
          () => {
            model?.release()
            return model?.close()
          },
          () => database?.end(),
          () => {
            if (external) dropCreatedDatabase(external.database)
          },
        ]) {
          try {
            await action()
          } catch (error) {
            errors.push(error)
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Lifecycle scene cleanup failed')
    }
  } finally {
    control.close()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, 'deployment-lifecycle.json'), JSON.stringify({ receipts, cleanupErrors: errors.length }) + '\n')
    }
  }
}, 1_200_000)
