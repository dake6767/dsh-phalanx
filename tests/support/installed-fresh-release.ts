import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import { validateManifest } from '../../scripts/release/integrity.mjs'
import { signInCommunity } from '../fixtures/community-native-browser.js'
import { installedShellArgument } from './installed-storage-layout.js'

type Remote = (command: string, timeout?: number) => Promise<string>

/** Bind the final browser to this fresh context rather than another retained fixture deployment. */
export function freshGateEntry(root: string, origin: string, proof: Record<string, unknown>) {
  const nonce = /^\/var\/tmp\/candidate-release-gate-([a-f0-9]{32})$/u.exec(root)?.[1]
  if (
    !nonce ||
    typeof proof.publicOrigin !== 'string' ||
    typeof proof.member !== 'string' ||
    proof.member !== 'gate-' + nonce ||
    typeof proof.spaceId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(proof.spaceId)
  )
    throw Error('Member entry does not belong to the verified fresh installation')
  const configured = new URL(proof.publicOrigin),
    browser = new URL(origin)
  if (
    configured.origin !== browser.origin ||
    configured.pathname !== '/' ||
    configured.search ||
    configured.hash ||
    configured.username ||
    configured.password ||
    browser.pathname !== '/' ||
    browser.search ||
    browser.hash ||
    browser.username ||
    browser.password
  )
    throw Error('Browser origin differs from the verified installation')
  return { origin: configured.origin, member: proof.member, pathname: '/app/' + proof.spaceId + '/' }
}

/** Consume actual owner-local execution receipts, cross-check the live installation, then enter DSH. */
export async function verifyInstalledFreshGate(input: { remote: Remote; origin: string; candidate: string; tag: string; target: string }) {
  const harness = process.env.DSH_PHALANX_OS_HARNESS_SHA ?? input.candidate
  if (!/^[a-f0-9]{40}$/u.test(harness)) throw Error('Requires the actual installed probe Harness commit')
  const root = process.env.DSH_PHALANX_OS_GATE_ROOT
  if (!root || !/^\/var\/tmp\/candidate-release-gate-[a-f0-9]{32}$/u.test(root)) throw Error('Requires protected actual fresh-installation receipts')
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const files = Object.fromEntries(
    await Promise.all(
      Object.entries({
        'prepare-probe.py': 'installed-probe-prepare.py',
        'probe-controller.py': 'installed-probe-controller.py',
        'probe-driver.py': 'installed-probe-driver.py',
        'physical-scan.py': 'installed-secret-scan.py',
        'secret_scan_files.py': 'secret_scan_files.py',
      }).map(async ([name, source]) => [name, hash(await readFile('scripts/validation/' + source))]),
    ),
  )
  const expected = {
    files,
    freshInstallerSha256: hash(await readFile('scripts/validation/installed-fresh-install.py')),
    installerSha256: hash(await readFile('install.sh')),
  }
  const verifier = await readFile('scripts/validation/installed-fresh-verify.py', 'utf8')
  let passed = false
  const started = Date.now()
  let proof: Record<string, unknown> | undefined
  try {
    const raw = JSON.parse(
      await input.remote(
        'sudo python3 -c ' + [verifier, root, input.candidate, input.tag, JSON.stringify(expected), harness].map(installedShellArgument).join(' '),
        300000,
      ),
    ) as Record<string, unknown> & { manifest: unknown }
    const manifest = validateManifest(raw.manifest, { commit: input.candidate }) as { tag: string; targetVersion: string }
    expect(manifest.tag).toBe(input.tag)
    expect(manifest.targetVersion).toBe(input.target)
    expect(raw).toMatchObject({
      status: 'passed',
      freshInstall: true,
      plaintextScan: 'passed',
      singleInstalledContext: true,
      projectionRebuild: true,
      processGroupsDrained: true,
    })
    proof = Object.fromEntries(
      [
        'harnessSource',
        'manifestSha256',
        'freshInstallationReceiptSha256',
        'businessReceiptSha256',
        'scanReceiptSha256',
        'freshInstall',
        'plaintextScan',
        'singleInstalledContext',
        'knownSecretCount',
        'representations',
        'projectionRebuild',
        'processGroupsDrained',
      ].map(key => [key, raw[key]]),
    )
    const entry = freshGateEntry(root, input.origin, raw)
    proof.entryBindingSha256 = createHash('sha256').update(JSON.stringify(entry)).digest('hex')
    const browser = await chromium.launch({ headless: true })
    try {
      const member = await browser.newPage({ locale: 'en' })
      await signInCommunity(member, entry.origin, entry.member, 'milestone-member-password')
      await member.locator('#root').waitFor({ state: 'attached', timeout: 300000 })
      expect(new URL(member.url()).pathname).toBe(entry.pathname)
      passed = true
    } finally {
      await browser.close()
    }
  } finally {
    const directory = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (directory)
      await writeFile(
        join(directory, 'installed-release-gate-result.json'),
        JSON.stringify({
          passed,
          tier: 'T4',
          gate: 'release',
          mode: 'fresh',
          candidate: input.candidate,
          tag: input.tag,
          target: input.target,
          ...proof,
          memberEntry: passed ? 'passed' : 'failed',
          seconds: Math.round((Date.now() - started) / 1000),
        }) + '\n',
      )
  }
}
