// External registry/CLI fixture for the public image publication command.
import { readFile, writeFile, appendFile } from 'node:fs/promises'
const root = process.env.IMAGE_REGISTRY_FIXTURE
if (process.argv[2] === 'inspect') {
  process.stdout.write(await readFile(`${root}/${process.argv.includes('--config') ? 'config.json' : 'raw.json'}`))
} else if (process.argv[2] === 'copy') {
  const args = process.argv.slice(2),
    destination = args.at(-1).split(':').at(-1)
  await appendFile(`${root}/copies.jsonl`, JSON.stringify(args) + '\n')
  const state = JSON.parse(await readFile(`${root}/registry.json`, 'utf8'))
  state[destination] = process.env.IMAGE_REGISTRY_DIGEST
  await writeFile(`${root}/registry.json`, JSON.stringify(state))
} else {
  globalThis.fetch = async url => {
    if (url.includes('/token?')) return new globalThis.Response(JSON.stringify({ token: 'fixture-token' }))
    const state = JSON.parse(await readFile(`${root}/registry.json`, 'utf8'))
    const digest = state[url.split('/').at(-1)]
    return new globalThis.Response('{}', { status: digest ? 200 : 404, headers: digest ? { 'docker-content-digest': digest } : {} })
  }
}
