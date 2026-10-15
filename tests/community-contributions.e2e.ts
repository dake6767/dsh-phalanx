// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { createHash } from 'node:crypto'
import { execFileText } from '../src/adapters/runtime-command.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { signInCommunity, selectCommunityWorkspace } from './fixtures/community-native-browser.js'

it.each(['standard', 'minimal'])('requires foreground confirmation in %s before uploading and adopting a skill', async preset => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'contributions-native-'))
  let credentialFindings = ''
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.setHeader('content-type', 'text/event-stream')
      const contributionId = JSON.stringify(body.messages).includes('UPDATE_SKILL') ? 'update-skill-call' : 'contribution-call'
      if (hasToolResult(body, 'credential-call', false)) credentialFindings = JSON.stringify(body.messages)
      if (JSON.stringify(body.messages).includes('CHECK_CREDENTIAL') && !(JSON.stringify(body.messages).includes('SUBMIT_SKILL') || JSON.stringify(body.messages).includes('UPDATE_SKILL')) && !latestHumanText(body).startsWith('Generate the session title') && !hasToolResult(body, 'credential-call', false) && !hasToolResult(body, 'credential-call', true)) {
        streamToolCall(response, 'credential-call', 'submit_contribution', { action: 'submit', path: 'team-guide', purpose: 'Share team search' })
      } else if ((JSON.stringify(body.messages).includes('SUBMIT_SKILL') || JSON.stringify(body.messages).includes('UPDATE_SKILL')) && !latestHumanText(body).startsWith('Generate the session title') && !hasToolResult(body, contributionId, false) && !hasToolResult(body, contributionId, true)) {
        expect(body.tools.some((tool: { name: string }) => tool.name === 'submit_contribution')).toBe(true)
        streamToolCall(response, contributionId, 'submit_contribution', { action: 'submit', path: 'team-guide', declaration: { purpose: 'Share our team workflow', execution: { commands: [{ command: './search.js', blocked: ['configure'] }], variables: [{ name: 'CONTRIBUTION_KEY', purpose: 'Authenticate', application: 'Provider dashboard' }] } } })
      } else streamText(response, 'CONTRIBUTION_TURN_COMPLETE')
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const runtime = runtimeSection(root, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, runtimeSettings)
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'contribution-test-session-secret-long', runtime, modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  const browser = await chromium.launch({ headless: true })
  try {
    await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    await accounts.create({ username: 'member', password: 'password', email: '' })
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }), member = await browser.newPage({ locale: 'en' })
    await signInCommunity(admin, origin, 'admin', 'password', true)
    await signInCommunity(member, origin, 'member', 'password')
    const workspace = defaultWorkspacePath(root, 'member'), skill = join(workspace, 'team-guide')
    await mkdir(skill, { recursive: true }); await writeFile(join(skill, 'SKILL.md'), '---\n"name": >-\n  team-guide\ndescription: Our team workflow\n---\n# Team guide\nShare useful steps.\n')
    await writeFile(join(skill, '.env'), 'EXAMPLE_SECRET=excluded-fixture\n')
    await selectCommunityWorkspace(member.context(), member, origin, instanceWorkspacePath(workspace, !!runtimeSettings.containerImage), !!runtimeSettings.containerImage)
    await member.getByRole('button', { name: 'Standard mode', exact: true }).click()
    await member.getByText(preset === 'minimal' ? 'Minimal mode' : 'Standard mode', { exact: true }).last().click()
    await writeFile(join(skill, 'search.js'), 'const apiKey = "Q8rB3mZ7xK2nV9sP4cD6hF1tL5aE0wY";');
    const composer = member.locator('[data-composer-input]'); await composer.fill('CHECK_CREDENTIAL: Check and submit this skill.'); await composer.press('Enter');
    await expect.poll(() => credentialFindings, { timeout: 60000 }).toContain('contribution-credential-high');
    expect(credentialFindings).not.toContain('Q8rB3mZ7xK2nV9sP4cD6hF1tL5aE0wY');
    expect((await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions).toEqual([]);
    expect(await member.getByText('Submit / 提交', { exact: true }).count()).toBe(0);
    await member.getByText('CONTRIBUTION_TURN_COMPLETE', { exact: true }).last().waitFor();
    await writeFile(join(skill, 'search.js'), '#!/usr/bin/env node\nconsole.log(process.env.CONTRIBUTION_KEY ? "PLATFORM_CREDENTIAL_USED" : "MISSING");\n');
    await composer.fill('SUBMIT_SKILL: Submit team-guide to the platform.'); await composer.press('Enter')
    try { await member.getByText('Submit / 提交', { exact: true }).waitFor({ timeout: 60000 }) }
    catch (error) { throw new Error(await member.locator('body').innerText(), { cause: error }) }
    expect(await member.locator('body').innerText()).toContain('Skill / 技能: team-guide')
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await member.screenshot({ path: join(evidence, preset + '-confirm.png'), fullPage: true, animations: 'disabled' }) }
    expect((await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions).toEqual([])
    await member.getByText('Submit / 提交', { exact: true }).click()
    const submit = member.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ })
    if (await submit.count()) await submit.first().click()
    await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions.length, { timeout: 30000 }).toBe(1)
    await member.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    await member.getByRole('tab', { name: 'Skills', exact: true }).click()
    await member.getByRole('region', { name: 'My contributions', exact: true }).getByRole('heading', { name: 'team-guide' }).waitFor()
    await admin.goto(origin + '/admin/skills?locale=en'); await admin.getByRole('tab', { name: 'Member contributions' }).click()
    await admin.getByRole('button', { name: 'Review contribution' }).click()
    if (evidence) await admin.screenshot({ path: join(evidence, preset + '-review.png'), fullPage: true, animations: 'disabled' })
    expect(await admin.getByRole('dialog').getByText('.env', { exact: true }).count()).toBe(0)
    await admin.getByRole('button', { name: 'Adopt contribution', exact: true }).click()
    await admin.getByLabel('Credential variable', { exact: true }).waitFor();
    expect(await admin.getByLabel('Credential variable', { exact: true }).inputValue()).toBe('CONTRIBUTION_KEY');
    expect(await admin.getByLabel('Delegated command', { exact: true }).inputValue()).toBe('./search.js');
    await admin.getByLabel('Credential value', { exact: true }).fill('platform-contribution-fixture-secret');
    await admin.getByText('Enable platform execution', { exact: true }).click();
    if (evidence) await admin.screenshot({ path: join(evidence, preset + '-configuration.png'), fullPage: true, animations: 'disabled' });
    expect((await (await admin.request.get(origin + '/admin/api/skills')).json())).toEqual([]);
    await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click();
    await admin.getByText('Publish to Platform App Center', { exact: true }).click();
    const ordinaryGroups = await (await admin.request.get(origin + '/admin/api/groups')).json();
    const groupName = ordinaryGroups.find((row: {id: string}) => row.id === accounts.get('member')!.groupId).name;
    await admin.getByText(groupName, { exact: true }).click();
    if (evidence) await admin.screenshot({ path: join(evidence, preset + '-distribution.png'), fullPage: true, animations: 'disabled' });
    await admin.getByRole('button', { name: 'Confirm adoption', exact: true }).click()
    await admin.getByRole('button', { name: 'Finish adoption', exact: true }).waitFor();
    const execution = await (await admin.request.get(origin + '/admin/api/skills/execution?name=team-guide')).json();
    expect(execution.variables).toEqual([{ name: 'CONTRIBUTION_KEY', secret: true, configured: true }]);
    expect(JSON.stringify(execution)).not.toContain('platform-contribution-fixture-secret');
    expect(execution.awaitingPreparation).toBe(true);
    expect(execution.preparation).toMatchObject({ stage: 'ready', usable: true });
    const granted = await (await admin.request.get(origin + '/admin/api/groups/' + accounts.get('member')!.groupId + '/skills')).json();
    expect(granted.skills.find((row: {name: string}) => row.name === 'team-guide').granted).toBe(true);
    await admin.getByRole('button', { name: 'Approve execution', exact: true }).click();
    await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/skills/execution?name=team-guide')).json()).awaitingPreparation, { timeout: 120000 }).toBe(false);
    await expect.poll(() => admin.getByRole('button', { name: 'Approve execution', exact: true }).count()).toBe(0);
    if (runtimeSettings.containerImage) {
      const ownership = createHash('sha256').update(root).digest('hex');
      const container = (await execFileText(runtimeSettings.containerRuntimeCli, ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', 'label=dsh-phalanx.user=member', '--format', '{{.Names}}'])).trim();
      expect(await execFileText(runtimeSettings.containerRuntimeCli, ['exec', container, 'node', '/dsh-phalanx/member-skills/live/team-guide/search.js'])).toContain('PLATFORM_CREDENTIAL_USED');
      const scan = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await scan(path);
          else if (entry.isFile()) expect((await readFile(path)).includes(Buffer.from('platform-contribution-fixture-secret')), path).toBe(false);
        }
      };
      await scan(join(root, 'users/member')); await scan(join(root, 'skills/members', accounts.get('member')!.spaceId));
      if (preset === 'standard') {
        await admin.getByRole('button', { name: 'Finish adoption', exact: true }).click()
        await member.getByText('CONTRIBUTION_TURN_COMPLETE', { exact: true }).last().waitFor()
        await member.getByRole('button', { name: 'New session', exact: true }).first().click()
        await writeFile(join(skill, 'CHANGELOG.md'), 'Update the contributed skill')
        await writeFile(join(skill, 'search.js'), '#!/usr/bin/env node\nconsole.log(process.env.CONTRIBUTION_KEY ? "UPDATED_CREDENTIAL_USED" : "MISSING");\n')
        await composer.fill('UPDATE_SKILL: Submit the updated team-guide.'); await composer.press('Enter')
        await member.getByText('Submit / 提交', { exact: true }).waitFor({ timeout: 60000 }); await member.getByText('Submit / 提交', { exact: true }).click()
        const confirm = member.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ }); if (await confirm.count()) await confirm.first().click()
        await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions.filter((row: {status: string}) => row.status === 'pending').length, { timeout: 30000 }).toBe(1)
        const oldPreparation = (await (await admin.request.get(origin + '/admin/api/skills/execution?name=team-guide')).json()).preparation
        await admin.goto(origin + '/admin/skills?locale=en'); await admin.getByRole('tab', { name: 'Member contributions' }).click()
        await admin.getByRole('button', { name: 'Review contribution' }).last().click()
        await admin.getByText('Added files', { exact: true }).waitFor(); expect(await admin.getByRole('dialog').innerText()).toContain('CHANGELOG.md')
        await admin.getByRole('button', { name: 'Adopt contribution', exact: true }).click()
        expect(await admin.getByLabel('Credential value', { exact: true }).inputValue()).toBe('')
        await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click()
        await admin.getByRole('button', { name: 'Confirm adoption', exact: true }).click(); await admin.getByRole('button', { name: 'Finish adoption', exact: true }).waitFor()
        const updatedExecution = await (await admin.request.get(origin + '/admin/api/skills/execution?name=team-guide')).json()
        expect(updatedExecution).toMatchObject({ awaitingPreparation: true, preparation: oldPreparation })
        await expect(execFileText(runtimeSettings.containerRuntimeCli, ['exec', container, 'node', '/dsh-phalanx/member-skills/live/team-guide/search.js'])).rejects.toThrow(/not-ready/)
        if (evidence) await admin.screenshot({ path: join(evidence, 'standard-update-awaits-prepare.png'), fullPage: true, animations: 'disabled' })
        await admin.getByRole('button', { name: 'Approve execution', exact: true }).click()
        await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/skills/execution?name=team-guide')).json()).awaitingPreparation, { timeout: 120000 }).toBe(false)
        await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/skills/execution?name=team-guide')).json()).preparation?.stage, { timeout: 120000 }).toBe('ready')
        expect(await execFileText(runtimeSettings.containerRuntimeCli, ['exec', container, 'node', '/dsh-phalanx/member-skills/live/team-guide/search.js'])).toContain('UPDATED_CREDENTIAL_USED')
      }

    }
    await expect.poll(async () => (await (await admin.request.get(origin + '/admin/api/skills')).json()).map((row: { name: string }) => row.name)).toEqual(['team-guide'])
  } finally {
    await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); accounts.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([])
    await rm(root, { recursive: true, force: true })
  }
})
