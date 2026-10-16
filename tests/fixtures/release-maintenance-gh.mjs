import { appendFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.MAINTENANCE_FIXTURE_ROOT, args = process.argv.slice(2)
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n')
if (args[0] === 'api' && args.includes('DELETE')) {
  if (!/^users\/dake6767\/packages\/container\/dsh-phalanx\/versions\/[1-9]\d*$/u.test(args[1])) throw Error('Unexpected package deletion')
} else if (args[0] === 'api') {
  const facts = JSON.parse(readFileSync(join(root, 'responses.json'), 'utf8'))
  if (!Object.hasOwn(facts, args[1])) throw new Error(`Unconfigured GitHub fixture path: ${args[1]}`)
  console.log(JSON.stringify(facts[args[1]]))
} else if (args[0] === 'release' && args[1] === 'download') {
  const directory = args[args.indexOf('--dir') + 1], name = args[args.indexOf('--pattern') + 1]
  mkdirSync(directory, { recursive: true })
  copyFileSync(join(root, args[2], name), join(directory, name))
} else if (!((args[0] === 'workflow' && args[1] === 'run') || (args[0] === 'release' && args[1] === 'delete'))) {
  throw new Error('Unsupported maintenance command')
}
