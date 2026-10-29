#!/usr/bin/env node
// Public container CLI fixture: a creation finishes after the first removal observes no container.
import { setInterval } from 'node:timers'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const self = fileURLToPath(import.meta.url),
  root = dirname(self),
  args = process.argv.slice(2)
const exists = async path => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
const wait = async name => {
  const path = join(root, name)
  await new Promise((resolve, reject) => {
    const watcher = watch(root, () => {
      void check()
    })
    watcher.on('error', reject)
    const check = async () => {
      if (await exists(path)) {
        watcher.close()
        resolve()
      }
    }
    void check()
  })
}
const container = join(root, 'container')
if (args[0] === 'late-create') {
  await wait('first-removal')
  await writeFile(container, 'late container')
  await writeFile(join(root, 'creation-finished'), 'yes')
} else if (args[0] === 'run') {
  const worker = spawn(process.execPath, [self, 'late-create'], { detached: true, stdio: 'ignore' })
  worker.unref()
  for await (const chunk of process.stdin) {
    void chunk /* Container stdin is deliberately not retained. */
  }
  process.stdout.write(JSON.stringify({ stream: 'stdout', data: Buffer.from('ready-to-cancel').toString('base64') }) + '\n')
  setInterval(() => {}, 60_000)
} else if (args[0] === 'rm') {
  if (!(await exists(join(root, 'first-removal')))) {
    await writeFile(join(root, 'first-removal'), 'initial absence observed')
    await wait('creation-finished')
  } else await rm(container, { force: true })
} else if (args[0] === 'ps') {
  if (await exists(container)) process.stdout.write('abcdef123456\n')
} else if (args[0] === 'inspect') process.stdout.write(await readFile(join(root, 'ownership'), 'utf8'))
else process.exitCode = 1
