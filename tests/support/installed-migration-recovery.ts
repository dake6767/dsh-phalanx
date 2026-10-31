import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import type { Page, APIResponse } from 'playwright'
import { assetNamesFor, fileHash, sha256, verifyDirectory } from '../../scripts/release/integrity.mjs'
import { installedReleaseFixture } from './installed-release-fixture.js'
import { installedShellArgument, installedUserDataRoot } from './installed-storage-layout.js'
import { runCommunityTerminal, selectCommunityWorkspace } from '../fixtures/community-native-browser.js'

type FixtureManifest = {
  updater?: string
  platform: 'linux/amd64'
  files: Record<string, string>
  image: { reference: string; digest: string }
  compatibility: { schemas: { name: string; sourceMin: number; sourceMax: number; target: number }[] }
  storage: { platformArchiveBytes: number; platformExpandedBytes: number }
  validationFixture?: { kind: string; baseManifestSha256: string }
}
const execute = promisify(execFile)
export interface InstalledExternalUpgradeDatabase {
  readonly kind: 'external'
  readonly configurationSha256: string
  /** Exact rootful Podman fixture, independent of the platform's member containers. */
  readonly containerId: string
}
/** Derive a declared test composition; the actual candidate archive, manifest and updater remain untouched. */
async function failingBundle(bundle: string, output: string, source: string, tag: string, external: boolean) {
  const original = (await verifyDirectory(bundle, { tag, commit: source })) as FixtureManifest,
    names = assetNamesFor(original.platform) as [string, string]
  const stage = join(output, 'stage')
  await mkdir(stage, { mode: 0o700 })
  await execute('tar', ['-xzf', join(bundle, names[0]), '-C', stage])
  const proof = 'phalanx-migration-proof-' + randomUUID()
  const registry = join(stage, 'dist/adapters/platform-schema-registry.js')
  await writeFile(
    registry,
    (await readFile(registry, 'utf8')) +
      `
// Controlled acceptance composition: never part of the candidate or production inventory.
PLATFORM_SCHEMAS.push({name:'migration_failure_fixture',migrations:[
 {version:1,name:'fixture-first',sql:"CREATE TABLE migration_failure_fixture.retained(value text); INSERT INTO migration_failure_fixture.retained VALUES('first')"},
 {version:2,name:'fixture-fails-mid-migration',sql:"UPDATE migration_failure_fixture.retained SET value='changed'; DO $$ BEGIN RAISE LOG '${proof}'; END $$; SELECT 1/0 /* ${proof} */"}
]});
`,
  )
  const buildFile = join(stage, 'build-info.json'),
    build = JSON.parse(await readFile(buildFile, 'utf8'))
  build.schemas.push({ name: 'migration_failure_fixture', target: 2 })
  build.validationFixture = { kind: 'migration-failure', originalPlatformSha256: original.files[names[0]] }
  await writeFile(buildFile, JSON.stringify(build) + '\n')
  const startFile = join(stage, 'start'),
    start = await readFile(startFile, 'utf8'),
    unitMutation = external
      ? ''
      : String.raw`printf '\n# controlled migration acceptance fixture\n' >> "$HOME/.config/systemd/user/dsh-phalanx-postgres.service"`
  expect(start).toContain('exec ./node/bin/node')
  await writeFile(
    startFile,
    start.replace(
      'exec ./node/bin/node',
      `if [ "$#" -eq 0 ]; then
  printf '\\n' >> "$DSH_PHALANX_DATABASE_CONFIG_FILE"
  ${unitMutation}
  (umask 077; printf fixture > "$HOME/keys/upgrade-acceptance.key")
fi
exec ./node/bin/node`,
    ),
  )
  await execute('tar', ['-czf', join(output, names[0]), '-C', stage, '.'])
  for (const name of [names[1], 'updater.json']) {
    await link(join(bundle, name), join(output, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EXDEV') throw error
      return copyFile(join(bundle, name), join(output, name))
    })
  }
  const manifest = structuredClone(original)
  manifest.compatibility.schemas.push({ name: 'migration_failure_fixture', sourceMin: 0, sourceMax: 0, target: 2 })
  manifest.files[names[0]] = await fileHash(join(output, names[0]))
  const measured = JSON.parse((await execute('python3', ['scripts/release/storage.py', output, 'amd64'])).stdout) as {
    storage: FixtureManifest['storage']
    updater: string
  }
  manifest.storage = measured.storage
  manifest.updater = measured.updater
  manifest.validationFixture = { kind: 'migration-failure', baseManifestSha256: sha256(await readFile(join(bundle, 'manifest.json'))) }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest) + '\n')
  await writeFile(join(output, 'SHA256SUMS'), names.map(name => `${manifest.files[name]}  ${name}\n`).join(''))
  await verifyDirectory(output, { tag, commit: source })
  await rm(stage, { recursive: true, force: true })
  return { manifest, proof }
}

/** Real Web preparation/application reaches the observed installed executor and its production backup/restore adapters. */
export async function installedMigrationRecovery(input: {
  releaseBundle: string
  source: string
  tag: string
  address: string
  origin: string
  workspace: string
  member: Page
  remote: (command: string, timeout?: number, acceptedExitCodes?: number[]) => Promise<string>
  get: (path: string) => ReturnType<APIResponse['json']>
  post: (path: string, data: object, timeout?: number) => Promise<APIResponse>
  downloadSources: { preset: string; overrides?: Record<string, string> }
  sourceImage: string
  sourcePid: string
  baselineVersion: string
  database?: InstalledExternalUpgradeDatabase
}) {
  const { remote, post, get, member, origin } = input
  const directory = await mkdtemp(join(tmpdir(), 'installed-migration-failure-'))
  if (input.database) {
    expect(input.database.configurationSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(input.database.containerId).toMatch(/^[a-f0-9]{64}$/u)
  }
  const { manifest, proof } = await failingBundle(input.releaseBundle, directory, input.source, input.tag, input.database !== undefined)
  const release = await installedReleaseFixture(directory, input.source, input.tag)
  const imageUser = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx)'
  let restored = false
  try {
    expect(
      (
        await post('download-sources', {
          ...input.downloadSources,
          overrides: { ...input.downloadSources.overrides, githubAssets: `http://${input.address}:${release.port}/` },
        })
      ).status(),
    ).toBe(200)
    const targetPresent = (await remote(`${imageUser} podman image exists ${manifest.image.reference}; echo $?`)).trim() === '0'
    const checked = (await (await post('system-update', { action: 'check' })).json()).check
    expect(checked).toMatchObject({ status: 'available', manifestSha256: release.manifestSha256 })
    const preparation = await post('system-update', { action: 'prepare', version: checked.version, manifestSha256: checked.manifestSha256 })
    expect(preparation.status()).toBe(200)
    const id = (await preparation.json()).operation.id as string
    expect(id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
    await expect.poll(async () => (await get('system-update')).operation?.phase, { timeout: 1_800_000 }).toBe('prepared')
    await selectCommunityWorkspace(member.context(), member, origin, input.workspace, true)
    const marker = 'upgrade-drain-' + randomUUID() + '.txt'
    await runCommunityTerminal(
      member,
      `printf DRAIN_WRITER_READY; while :; do printf 'owned\\n' >> ${installedShellArgument(join(input.workspace, marker))}; sleep 0.05; done`,
      'DRAIN_WRITER_READY',
    )
    const userRoot = await installedUserDataRoot(remote)
    await expect
      .poll(async () =>
        Number(
          await remote(`sudo python3 - <<'PHALANX_DRAIN'
from pathlib import Path
paths=list(Path(${JSON.stringify(userRoot)}).rglob(${JSON.stringify(marker)}));assert len(paths)==1
print(len(paths[0].read_text().splitlines()))
PHALANX_DRAIN`),
        ),
      )
      .toBeGreaterThanOrEqual(2)
    const appliedAt = (await remote('date -u +%Y-%m-%dT%H:%M:%S.%NZ')).trim()
    expect((await post('system-update', { action: 'apply', operation: id, confirmed: true })).status()).toBe(200)
    await expect
      .poll(
        async () => {
          try {
            return (await get('system-update')).operation?.phase
          } catch {
            return 'offline'
          }
        },
        { timeout: 600_000 },
      )
      .toBe('restored')
    const migrationProof = JSON.parse(
      await remote(`sudo -n python3 - <<'PHALANX_MIGRATION_PROOF'
import subprocess,json,re,hashlib
uid=subprocess.check_output(['id','-u','dsh-phalanx'],text=True).strip()
external=json.loads(${JSON.stringify(JSON.stringify(input.database ?? null))})
if external is None:
 raw=subprocess.check_output(['journalctl','_SYSTEMD_USER_UNIT=dsh-phalanx-postgres.service','_UID='+uid,'--since',${JSON.stringify(appliedAt)},'--no-pager','--output=json'])
 messages=[json.loads(line)['MESSAGE'] for line in raw.decode().splitlines()]
else:
 info=json.loads(subprocess.check_output(['podman','container','inspect',external['containerId']]))[0]
 assert info['Id']==external['containerId'] and info['State']['Running'] is True
 labels=info['Config']['Labels'];assert labels['dsh-phalanx.validation-source']==${JSON.stringify(input.source)}
 assert labels['dsh-phalanx.upgrade-database-sha256']==external['configurationSha256']
 logs=subprocess.run(['podman','logs','--since',${JSON.stringify(appliedAt)},external['containerId']],capture_output=True,check=True)
 raw=logs.stdout+logs.stderr;messages=raw.decode().splitlines()
nonce=${JSON.stringify(proof)}
records=[]
for message in messages:
 match=re.search(r'\\[(\\d+)\\]\\s+(LOG|ERROR|STATEMENT):\\s*(.*)',message,re.S)
 if match:records.append(match.groups())
backends={pid for pid,kind,message in records if kind=='LOG' and message.strip()==nonce}
matched=[pid for pid in backends if any(p==pid and kind=='ERROR' and 'division by zero' in msg for p,kind,msg in records) and any(p==pid and kind=='STATEMENT' and nonce in msg and 'SELECT 1/0' in msg for p,kind,msg in records)]
assert len(matched)>=1,'Missing real second migration and division-by-zero backend evidence'
print(json.dumps({'status':'passed','secondMigrationReached':True,'divisionByZero':True,'proofSha256':hashlib.sha256(nonce.encode()).hexdigest(),'journalSha256':hashlib.sha256(raw).hexdigest(),'matchedBackends':len(matched),'databaseKind':'external' if external else 'builtin'}))
PHALANX_MIGRATION_PROOF`),
    )
    const outcome = (await get('system-update')).operation
    expect(outcome).toMatchObject({ id, phase: 'restored' })
    expect(await remote(`sudo cat /etc/dsh-phalanx/install-state.json`)).toContain('v' + input.baselineVersion)
    const pid = (await remote(`${imageUser} systemctl --user show dsh-phalanx.service -p MainPID --value`)).trim()
    expect(Number(pid)).toBeGreaterThan(0)
    expect(pid).not.toBe(input.sourcePid)
    await member.reload()
    await selectCommunityWorkspace(member.context(), member, origin, input.workspace, true)
    restored = true
    // Preserve the normal upgrade's absent-before-import assertion when this fixture introduced a different image.
    if (!targetPresent && manifest.image.digest !== input.sourceImage) await remote(`${imageUser} podman image rm ${manifest.image.reference}`)
    return {
      status: 'restored',
      operation: id,
      pid,
      testCompositionOnly: true,
      fixtureManifestSha256: release.manifestSha256,
      fixturePlatformSha256: manifest.files['dsh-phalanx-linux-amd64.tar.gz'],
      candidateBytesUnmodified: true,
      memberEntry: true,
      continuousWriterDrained: true,
      migrationProof,
    }
  } finally {
    await release.close()
    if (restored) await rm(directory, { recursive: true, force: true })
  }
}
