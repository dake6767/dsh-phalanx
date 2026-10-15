import { appendFileSync, readFileSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

// A fixture for the external GitHub process: exact HTTP facts and asset bytes.
const root = process.env.PROMOTION_FIXTURE_ROOT
const args = process.argv.slice(2)
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n')
if (args[0] === '--curl') {
  const identity = JSON.parse(readFileSync(join(root, 'identity.json'), 'utf8'))
  const url = args.find(value => value.startsWith('https://'))
  const prefix = `https://github.com/${identity.repository}/releases/download/${process.env.REHEARSAL_FIXTURE_TAG}/`
  if (!url?.startsWith(prefix)) throw new Error('Unexpected anonymous source')
  copyFileSync(join(root, 'rehearsal-downloads', url.slice(prefix.length)), args[args.indexOf('--output') + 1])
} else if (args[0] === 'api') {
  const facts = JSON.parse(readFileSync(join(root, 'responses.json'), 'utf8'))
  if (!Object.hasOwn(facts, args[1])) throw new Error(`Unconfigured GitHub fixture path: ${args[1]}`)
  console.log(JSON.stringify(facts[args[1]]))
} else if (args[0] === 'release' && args[1] === 'download') {
  const identity = JSON.parse(readFileSync(join(root, 'identity.json'), 'utf8'))
  if (![identity.tag, process.env.REHEARSAL_FIXTURE_TAG].includes(args[2]) || args[args.indexOf('--repo') + 1] !== identity.repository) throw new Error('Unexpected download identity')
  const target = args[args.indexOf('--dir') + 1]
  const source = args[2] === identity.tag ? 'assets' : 'rehearsal-downloads'
  const names = args.includes('--pattern') ? [args[args.indexOf('--pattern') + 1]] : readdirSync(join(root, source))
  for (const name of names) copyFileSync(join(root, source, name), join(target, name))
} else if (!(args[0] === 'release' && args[1] === 'delete' && args[2] === process.env.REHEARSAL_FIXTURE_TAG)) throw new Error('Promotion verification must not mutate GitHub')
