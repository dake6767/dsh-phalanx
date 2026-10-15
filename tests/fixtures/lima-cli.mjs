import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2), home = process.env.LIMA_HOME
appendFileSync(process.env.FIXTURE_LIMA_LOG, JSON.stringify(args) + '\n')
const instance = join(home, 'development'), status = join(instance, 'status')
switch (args[0]) {
  case 'list':
    if (existsSync(status)) console.log(`development ${readFileSync(status, 'utf8')}`)
    break
  case 'create':
    if (existsSync(instance)) throw new Error('Instance already exists')
    mkdirSync(instance); copyFileSync(args.at(-1), join(instance, 'lima.yaml')); writeFileSync(status, 'Stopped')
    break
  case 'start': writeFileSync(status, 'Running'); break
  case 'stop': writeFileSync(status, 'Stopped'); break
  case 'delete': rmSync(instance, { recursive: true }); break
  case 'shell':
    if (readFileSync(status, 'utf8') !== 'Running') throw new Error('Instance is stopped')
    console.log('guest command completed')
    break
  default: throw new Error(`Unexpected Lima command: ${args[0]}`)
}
