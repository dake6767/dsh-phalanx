import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acceptanceProgress } from '../support/acceptance-progress.js'

const root = process.argv[2]!, resumeFrom = process.argv[3]!
const progress = await acceptanceProgress(join(root, 'progress.json'), { candidate: 'fixture candidate', host: 'fixture host' },
  ['install', 'upgrade', 'verify'], resumeFrom || undefined)
const effect = (step: string) => appendFile(join(root, 'effects.txt'), step + '\n')
const baseline = await progress.step('install', async () => { await effect('install'); return { preserved: 'baseline member data' } })
await progress.step('upgrade', async () => { await effect('upgrade'); if (!resumeFrom) throw Error('controlled failure'); return null })
await progress.step('verify', async () => { await effect('verify'); return null })
await progress.finish()
console.log(JSON.stringify({ ...baseline, verified: true }))
