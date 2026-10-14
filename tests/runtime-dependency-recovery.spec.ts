import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'

it.each([false, true])('recovers orphan shared readers before collecting dependency versions (cleanup fails: %s)', async fail => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-recovery-'))
  const old = join(root, 'runtime-dependencies/.trees', 'a'.repeat(64)), cli = join(root, 'container-cli')
  const ownership = createHash('sha256').update(root).digest('hex')
  await mkdir(old, { recursive: true }); await writeFile(join(old, 'active-input'), 'still-needed')
  // An orphaned draining reader may be older than both persisted current and previous.
  await writeFile(cli, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const root=${JSON.stringify(root)};
if(args[0]==='ps' && (args.includes('label=dsh-phalanx.mcp-shared=${ownership}') || args.some(v=>v.startsWith('name='))) && !fs.existsSync(root+'/removed')) console.log('abc123def456');
else if(args[0]==='inspect') console.log(${JSON.stringify(ownership)});
else if(args[0]==='image') console.log('fixture-image');
else if(args[0]==='rm'){fs.writeFileSync(root+'/cleanup-observed',String(fs.existsSync(${JSON.stringify(join(old, 'active-input'))})));if(${fail})process.exit(1);fs.writeFileSync(root+'/removed','yes');}
`, { mode: 0o700 })
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'dependency-recovery-fixture-secret', runtime: { command: '/unavailable', args: [], dataRoot: root,
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } }, container: { runtime: cli, image: 'fixture-image', internalPort: 4180, gatewayPort: 4181 } } })
  try {
    if (fail) await expect(app.start()).rejects.toThrow()
    else await app.start()
    expect(await readFile(join(root, 'cleanup-observed'), 'utf8')).toBe('true')
    if (fail) expect(await readFile(join(old, 'active-input'), 'utf8')).toBe('still-needed')
    else await expect(readFile(join(old, 'active-input'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await app.stop().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
