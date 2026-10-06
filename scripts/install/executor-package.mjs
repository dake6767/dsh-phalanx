import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const directory = new URL('./', import.meta.url)
export async function executorSources() {
  const names = [...JSON.parse(await readFile(new URL('executor-files.json', directory), 'utf8')), 'updater.service.in', 'executor-files.json']
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(name, directory), 'utf8')])))
}
export async function packageExecutor(destination, commit) {
  const files = await executorSources()
  await mkdir(destination, { recursive: true })
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(destination, name), text)))
  const inventory = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')]))
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({ schema: 1, sourceCommit: commit, files: inventory }, null, 2) + '\n')
}
