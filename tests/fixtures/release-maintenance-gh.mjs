import { appendFileSync, readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const root = process.env.MAINTENANCE_FIXTURE_ROOT,
  args = process.argv.slice(2)
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n')
if (args[0] === 'api' && args.includes('DELETE')) {
  if (!/^users\/dake6767\/packages\/container\/dsh-phalanx(?:-dev)?\/versions\/[1-9]\d*$/u.test(args[1])) throw Error('Unexpected package deletion')
} else if (args[0] === 'api') {
  const facts = JSON.parse(readFileSync(join(root, 'responses.json'), 'utf8'))
  if (args.includes('PUT')) {
    const request = JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
    const key = args[1] + '?ref=main',
      old = facts[key]
    if (!old || request.sha !== old.sha || request.branch !== 'main') throw Error('Content revision conflict')
    const bytes = Buffer.from(request.content, 'base64'),
      sha = createHash('sha1')
        .update('blob ' + bytes.length + '\0')
        .update(bytes)
        .digest('hex')
    facts[key] = { ...old, sha, size: bytes.length, content: request.content }
    writeFileSync(join(root, 'responses.json'), JSON.stringify(facts))
    console.log(JSON.stringify({ content: { sha } }))
    process.exit(0)
  }
  if (!Object.hasOwn(facts, args[1])) throw new Error(`Unconfigured GitHub fixture path: ${args[1]}`)
  console.log(JSON.stringify(facts[args[1]]))
} else if (args[0] === 'release' && args[1] === 'download') {
  const directory = args[args.indexOf('--dir') + 1],
    name = args[args.indexOf('--pattern') + 1]
  mkdirSync(directory, { recursive: true })
  copyFileSync(join(root, args[2], name), join(directory, name))
} else if (!((args[0] === 'workflow' && args[1] === 'run') || (args[0] === 'release' && args[1] === 'delete'))) {
  throw new Error('Unsupported maintenance command')
}
