import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { checkInstaller } from './install/build-installer.mjs'
import { checkContainerCommand } from './build-container-command.mjs'

await checkInstaller()
await checkContainerCommand()

// A contraction must not ship compiled modules left by an earlier build.
const root = fileURLToPath(new URL('..', import.meta.url))
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' })
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('close', code => { process.exitCode = code ?? 1 })
