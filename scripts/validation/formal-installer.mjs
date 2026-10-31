import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harnessReusePlan } from '../release/harness-reuse.mjs'

/** Publication receipts may follow the tested build; compare complete trees and exact installer bytes. */
export function formalInstallerIdentity(source, tag, acceptance) {
  if (!/^v\d+\.\d+\.\d+$/u.test(tag) || acceptance?.status !== 'accepted' || !/^[a-f0-9]{40}$/u.test(acceptance.commit ?? ''))
    throw Error('An accepted formal build and stable tag are required')
  const git = args => execFileSync('git', ['-C', source, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const tagged = git(['rev-parse', '--verify', tag + '^{commit}'])
    .toString()
    .trim()
  const tree = commit => ({
    truncated: false,
    tree: git(['ls-tree', '-r', '-z', '--full-tree', commit])
      .toString()
      .split('\0')
      .filter(Boolean)
      .map(row => {
        const [, mode, type, sha, path] = /^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row) ?? []
        if (!path) throw Error('Invalid formal source tree')
        return { mode, type, sha, path }
      }),
  })
  const plan = harnessReusePlan(tree(acceptance.commit), tree(tagged), Object.keys(acceptance.checks ?? {}))
  if (plan.checks.length) {
    const proof = acceptance.harnessReuse
    if (proof?.builtSource !== acceptance.commit || proof.inputDigest !== plan.inputDigest || !plan.checks.every(check => proof.reruns?.[check] === 'passed'))
      throw Error('Formal tag has unverified executable Harness changes')
  }
  const built = git(['show', acceptance.commit + ':install.sh']),
    installer = git(['show', tag + ':install.sh'])
  if (!built.equals(installer)) throw Error('The formal tag installer differs from accepted build bytes')
  return {
    tag,
    tagCommit: tagged,
    builtSource: acceptance.commit,
    installerSha256: createHash('sha256').update(installer).digest('hex'),
    changedPaths: plan.changed,
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--tag' || args[2] !== '--output') throw Error('Usage: formal-installer.mjs --tag vX.Y.Z --output PATH')
  const record = JSON.parse(readFileSync(`releases/acceptance/${args[1].slice(1)}.json`, 'utf8'))
  writeFileSync(args[3], JSON.stringify(formalInstallerIdentity(process.cwd(), args[1], record), null, 2) + '\n')
}
