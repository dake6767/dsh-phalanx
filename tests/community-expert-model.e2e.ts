// Validation: T2; real credentials: none; actual DSH through installed candidate CLI on Linux.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { latestHumanText, streamText } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

it('starts new expert conversations with a chosen shared model, allows native changes and falls back when disabled', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'community-expert-model-')))
  const captured = new Map<string, { model: string, context: string }>()
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (body.tools?.length) captured.set(latestHumanText(body), { model: body.model, context: text })
    response.setHeader('content-type', 'text/event-stream'); streamText(response, 'EXPERT_MODEL_READY')
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'expert-model-acceptance-fixture-secret', runtime })
  const browser = await chromium.launch({ headless: true })
  let primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    const api = async (path: string, input?: object) => {
      const response = input ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: input }) : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.status(), await response.text()).toBeLessThan(300); return response.json()
    }
    const provider = { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-expert-model-key', enabled: true, models: [{ name: 'default-model', enabled: true }, { name: 'expert-model', enabled: true }] }
    const settings = await api('models', { revision: (await api('models')).revision, action: 'save-provider', provider })
    const savedProvider = settings.providers[0]
    await api('models', { revision: settings.revision, action: 'set-default', defaultModelId: savedProvider.models[0].id })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    await admin.goto(origin + '/admin'); await admin.getByRole('link', { name: 'Expert library', exact: true }).click()
    await admin.getByRole('button', { name: 'Create expert', exact: true }).click()
    await admin.getByLabel('Expert name', { exact: true }).fill('Commerce expert')
    await admin.getByLabel('Expert description', { exact: true }).fill('Marketing workflow')
    await admin.getByLabel('Expert persona', { exact: true }).fill('EXPERT_MODEL_PERSONA')
    await admin.getByRole('button', { name: /Expert model/u }).click()
    await admin.getByRole('option', { name: 'Fixture / expert-model', exact: true }).click()
    await admin.getByRole('button', { name: 'Save expert', exact: true }).click()
    await admin.locator('article').filter({ has: admin.getByRole('heading', { name: 'Commerce expert', exact: true }) }).getByText('Fixture / expert-model', { exact: true }).waitFor()
    const library = await api('experts'), expert = library.experts[0]
    const groupPath = `groups/${account.groupId}/experts`
    await api(groupPath, { names: [expert.id], revision: (await api(groupPath)).revision, confirmed: true })
    const member = await browser.newPage({ locale: 'en' }); member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    const openMarket = async () => { await member.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await member.getByRole('tab', { name: 'Experts', exact: true }).click() }
    const start = async () => { await openMarket(); await member.getByRole('button', { name: 'Start conversation', exact: true }).click(); await member.locator('[data-composer-input]').waitFor() }
    const prompt = async (marker: string, expectedModel: string) => {
      const composer = member.locator('[data-composer-input]'); await composer.fill(marker); await composer.press('Enter')
      await expect.poll(() => captured.get(marker), { timeout: 30000 }).toMatchObject({ model: expectedModel })
      expect(captured.get(marker)?.context).toContain('EXPERT_MODEL_PERSONA')
      await member.locator('p').filter({ hasText: 'EXPERT_MODEL_READY' }).last().waitFor()
    }
    await start(); const firstUrl = member.url()
    await member.getByRole('button', { name: /Fixture \/ expert-model/u }).waitFor()
    await prompt('EXPERT_START', 'expert-model')
    await member.getByRole('button', { name: /Fixture \/ expert-model/u }).click()
    await member.getByRole('menuitem', { name: /^Model/u }).click()
    await member.getByRole('menuitemradio', { name: /Fixture \/ default-model/u }).click()
    await prompt('EXPERT_CHANGED', 'default-model')
    await start(); await expect.poll(() => member.url()).not.toBe(firstUrl)
    await prompt('EXPERT_SECOND_START', 'expert-model')
    await member.getByRole('button', { name: 'New session', exact: true }).first().click()
    await member.getByRole('button', { name: /Standard mode/u }).click()
    await member.getByRole('menuitem', { name: /Commerce expert/u }).click()
    await member.getByRole('button', { name: /Fixture \/ default-model/u }).waitFor()
    await prompt('EXPERT_NATIVE_MODE', 'default-model')
    const current = await api('models')
    await api('models', { revision: current.revision, action: 'save-provider', provider: { ...provider, id: savedProvider.id, models: savedProvider.models.map((row: { id: string, name: string }) => ({ ...row, enabled: row.name !== 'expert-model' })) } })
    await admin.reload(); await admin.getByText('Expert model is unavailable. New conversations use the host default.', { exact: true }).waitFor()
    await start(); await member.getByRole('button', { name: /Fixture \/ default-model/u }).waitFor()
    await prompt('EXPERT_DISABLED_MODEL', 'default-model')
    const denied = await member.request.post(origin + '/market/api/experts', { headers: { origin }, data: { name: 'not-owned', action: 'start' } }); expect(denied.status()).toBe(404)
  } catch (error) { primaryFailure = error }
  finally {
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); return true } catch (error) { cleanupErrors.push(error); return false } }
    await attempt(() => browser.close())
    const stopped = await attempt(() => app.stop()), rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    if (stopped && rebuilt) await attempt(() => rm(root, { recursive: true, force: true }))
    model.closeAllConnections(); await attempt(() => new Promise<void>(resolve => model.close(() => resolve())))
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Expert model acceptance cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 240000)
