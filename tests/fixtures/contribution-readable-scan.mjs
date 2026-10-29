// Executed as the member inside its container. No platform credential enters this process.
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
let files = 0,
  bytes = 0,
  denied = 0
const errors = []
const seenFiles = new Set(),
  seenDirectories = new Set()
async function emit(path) {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return
    const id = `${stat.dev}:${stat.ino}`
    if (seenFiles.has(id)) return
    seenFiles.add(id)
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length
      if (!process.stdout.write(chunk)) await once(process.stdout, 'drain')
    }
    files++
  } catch (e) {
    if (['EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'EIO', 'EINVAL'].includes(e.code)) denied++
    else errors.push({ path, code: e.code })
  }
}
async function walk(path) {
  let entries
  try {
    const stat = await fs.stat(path),
      id = `${stat.dev}:${stat.ino}`
    if (seenDirectories.has(id)) return
    seenDirectories.add(id)
    entries = await fs.readdir(path, { withFileTypes: true })
  } catch (e) {
    if (['EACCES', 'EPERM', 'ENOENT'].includes(e.code)) {
      denied++
      return
    }
    throw e
  }
  for (const entry of entries) {
    const name = path === '/' ? '/' + entry.name : path + '/' + entry.name
    if (['/proc', '/sys'].includes(name)) continue
    if (entry.isDirectory()) await walk(name)
    else if (entry.isFile()) await emit(name)
    else if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.stat(name)
        if (stat.isDirectory()) await walk(name)
        else if (stat.isFile()) await emit(name)
      } catch (e) {
        if (['EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'ELOOP'].includes(e.code)) denied++
        else errors.push({ path: name, code: e.code })
      }
    }
  }
}
await walk('/')
for (const pid of (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))) {
  await emit(`/proc/${pid}/environ`)
  await emit(`/proc/${pid}/cmdline`)
  await walk(`/proc/${pid}/fd`)
}
process.stderr.write(JSON.stringify({ files, bytes, denied, errors }))
if (errors.length) process.exitCode = 1
