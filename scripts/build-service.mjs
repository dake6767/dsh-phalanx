import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { checkInstaller } from './install/build-installer.mjs'
import { checkContainerCommand } from './build-container-command.mjs'

await checkInstaller()
await checkContainerCommand()

// A contraction must not ship compiled modules left by an earlier build.
const root = fileURLToPath(new URL('..', import.meta.url))
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', resolve)
})
if (code !== 0) process.exitCode = code ?? 1
else {
  const { communityMaintenancePage } = await import(new URL('../dist/inbound/community-maintenance-page.js', import.meta.url))
  await Promise.all(['en', 'zh-CN'].map(locale => writeFile(new URL(`../dist/maintenance.${locale}.html`, import.meta.url), communityMaintenancePage(locale))))
}
