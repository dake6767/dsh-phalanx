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
  case 'start':
    writeFileSync(status, 'Running')
    writeFileSync(join(instance, 'boot'), String(Number(existsSync(join(instance, 'boot')) ? readFileSync(join(instance, 'boot'), 'utf8') : '0') + 1))
    break
  case 'stop': writeFileSync(status, 'Stopped'); break
  case 'delete': rmSync(instance, { recursive: true }); break
  case 'shell':
    if (readFileSync(status, 'utf8') !== 'Running') throw new Error('Instance is stopped')
    if (args.includes('test') && process.env.FIXTURE_TEST_FAIL === '1') process.exit(87)
    if (args.at(-1) === 'clock') {
      const marker = join(instance, 'clock-boot'), boot = readFileSync(join(instance, 'boot'), 'utf8')
      if (!existsSync(marker)) writeFileSync(marker, boot)
      console.log(process.env.FIXTURE_CLOCK_NOT_READY === '1' || readFileSync(marker, 'utf8') === boot ? 'restart-required' : 'ready')
    } else if (args.at(-1) === '/var/lib/dsh-phalanx-dev/build.json') {
      console.log(JSON.stringify({ imageSource: { inputHash: process.env.FIXTURE_IMAGE_HASH ?? 'a'.repeat(64), mode: 'pull' }, manifest: { image: { digest: 'sha256:'+'b'.repeat(64) } } }))
    } else console.log('guest command completed')
    break
  case 'copy': writeFileSync(args.at(-1), 'fixture image'); break
  default: throw new Error(`Unexpected Lima command: ${args[0]}`)
}
