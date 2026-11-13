import { expect } from 'vitest'
import type { APIResponse } from 'playwright'
import { installedShellArgument } from './installed-storage-layout.js'

const inventoryDirectory = 'plugins/staging/formal-upgrade-inventory'
const inventoryCount = 1800

export async function seedLargeUpgradeInventory(remote: (command: string) => Promise<string>) {
  const program = [
    'from pathlib import Path',
    'root = Path("/var/lib/dsh-phalanx/data") / ' + JSON.stringify(inventoryDirectory),
    'for index in range(' + String(inventoryCount) + '):',
    '    (root / (str(index) + "-" + "x" * 150)).mkdir(parents=True, exist_ok=True)',
  ].join('\n')
  await remote('sudo -u dsh-phalanx python3 -c ' + installedShellArgument(program))
  return { directories: inventoryCount }
}

export async function assertLargeUpgradeJournal(remote: (command: string) => Promise<string>, operation: string) {
  expect(operation).toMatch(/^[a-f0-9-]{36}$/u)
  const program = [
    'import json, sys',
    'from pathlib import Path',
    'path = Path(sys.argv[1])',
    'rows = json.loads(path.read_text())["backup"]["retainedDirectories"]',
    'prefix = ' + JSON.stringify(inventoryDirectory + '/'),
    'print(json.dumps({"bytes": path.stat().st_size, "directories": sum(row.startswith(prefix) for row in rows)}))',
  ].join('\n')
  const journal = '/var/lib/dsh-phalanx-updater/' + operation + '/operation.json'
  const observed = JSON.parse(await remote('sudo python3 -c ' + installedShellArgument(program) + ' ' + installedShellArgument(journal)))
  expect(observed.directories).toBe(inventoryCount)
  expect(observed.bytes).toBeGreaterThan(262144)
  return observed.bytes as number
}

export async function assertUpgradeCapacity(
  remote: (command: string, timeout?: number, acceptedExitCodes?: number[]) => Promise<string>,
  prepareCommand: string,
  pidCommand: string,
  expectedPid: string,
) {
  await remote('sudo mkdir -p /var/lib/dsh-phalanx-updater && sudo mount -t tmpfs -o size=8m,mode=700 candidate-capacity /var/lib/dsh-phalanx-updater')
  try {
    const result = JSON.parse(await remote(prepareCommand, 1800000, [1]))
    expect(result).toMatchObject({ status: 'upgrade', operation: { phase: 'prepare-failed', space: { sufficient: false } } })
    expect((await remote(pidCommand)).trim()).toBe(expectedPid)
    await remote('sudo test ! -e /etc/dsh-phalanx/maintenance')
    return result
  } finally {
    await remote('sudo umount /var/lib/dsh-phalanx-updater')
  }
}

export async function bootstrapInstalledUpgrade({
  run,
  platformPid,
  expectedPid,
  platformStatus,
  candidate,
  requests,
}: {
  run: () => Promise<string>
  platformPid: () => Promise<string>
  expectedPid: string
  platformStatus: (() => Promise<number>) | undefined
  candidate: string
  requests: readonly string[]
}) {
  if (platformStatus) expect(await platformStatus()).toBe(200)
  const requestStart = requests.length
  const result = JSON.parse(await run())
  expect(result).toMatchObject({ status: 'updater-ready', executor: { sourceCommit: candidate }, operation: null })
  expect(await platformPid()).toBe(expectedPid)
  if (platformStatus) expect(await platformStatus()).toBe(200)
  const downloads = requests.slice(requestStart)
  expect(downloads.length).toBeGreaterThan(0)
  expect(downloads.every(url => url.endsWith('/updater.json'))).toBe(true)
  return { executor: result.executor, platformPidUnchanged: true, smallUpdaterOnly: true, requests: downloads }
}

export async function checkBootstrappedUpdater({
  check,
  version,
  platformPid,
  expectedPid,
}: {
  check: () => Promise<APIResponse>
  version: string
  platformPid: () => Promise<string>
  expectedPid: string
}) {
  let result: { check: { status: string; version: string } } | undefined
  await expect
    .poll(
      async () => {
        try {
          const response = await check()
          if (response.status() !== 200) return 'unavailable'
          result = await response.json()
          return result?.check.status
        } catch {
          return 'unavailable'
        }
      },
      { timeout: 300000 },
    )
    .toBe('available')
  expect(result?.check).toMatchObject({ status: 'available', version })
  expect(await platformPid()).toBe(expectedPid)
  return { check: result!.check, releaseBoundExecutor: true, platformPidUnchanged: true }
}
