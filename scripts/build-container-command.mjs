import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { containerWebCommand } from '../src/dsh/cli.ts'

// The recipe contains generated data; official CLI facts remain in their owner.
const target = new URL('../containers/dsh/Containerfile', import.meta.url)
const recipe = await readFile(target, 'utf8')
const commands = recipe.match(/^CMD .*$/gmu)
if (commands?.length !== 1) throw new Error('Expected one generated image command')
const generated = recipe.replace(/^CMD .*$/gmu, `CMD ${JSON.stringify(containerWebCommand())}`)
export async function checkContainerCommand() {
  if (recipe !== generated) throw new Error('Image command is stale; run node scripts/build-container-command.mjs')
}
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--check')) await checkContainerCommand()
  else await writeFile(target, generated)
}
