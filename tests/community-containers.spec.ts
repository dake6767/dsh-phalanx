import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OwnedCommunityContainers } from '../src/adapters/community-containers.js'

it('retains only a space-labelled identity and removes owned carriers without requiring a database during offline cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-container-cli-'))
  const path = join(root, 'state.json'),
    runtime = join(root, 'runtime.mjs')
  const records = [
    {
      Name: 'current',
      State: 'running',
      Labels: { 'dsh-phalanx.community': '1', 'dsh-phalanx.community-root': 'fixture-root', 'dsh-phalanx.user': 'alice', 'dsh-phalanx.space': 'a'.repeat(32) },
    },
    { Name: 'legacy', State: 'running', Labels: { 'dsh-phalanx.community': '1', 'dsh-phalanx.community-root': 'fixture-root', 'dsh-phalanx.user': 'alice' } },
  ]
  try {
    await writeFile(path, JSON.stringify(records))
    await writeFile(
      runtime,
      `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const path=${JSON.stringify(path)}, args=process.argv.slice(2), rows=JSON.parse(readFileSync(path,'utf8'));
if(args[0]==='rm')writeFileSync(path,JSON.stringify(rows.filter(row=>row.Name!==args.at(-1))));
else if(args[0]==='inspect')console.log('observed-current');
else if(args[0]==='ps'){
 const filter=args.find(value=>value.startsWith('name=^'));
 const selected=filter?rows.filter(row=>'name=^'+row.Name+'$'===filter):rows;
 console.log(args.at(-1)==='json'?JSON.stringify(selected):selected.map(row=>row.Name).join('\\n'));
}else throw Error('Unexpected container command');
`,
      { mode: 0o700 },
    )
    const observed: unknown[] = []
    const containers = new OwnedCommunityContainers({ runtime, image: 'fixture', internalPort: 4180, gatewayPort: 3081 }, 'fixture-root')
    expect(
      await containers.rebuild({
        get: async () => {
          throw Error('Unexpected allocation')
        },
        remember: async (owner, hostname) => {
          observed.push({ owner, hostname })
          return hostname
        },
      }),
    ).toEqual(['current', 'legacy'])
    expect(observed).toEqual([{ owner: { username: 'alice', spaceId: 'a'.repeat(32) }, hostname: 'observed-current' }])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
    await writeFile(path, JSON.stringify(records))
    expect(await containers.rebuild()).toEqual(['current', 'legacy'])
    expect(observed).toHaveLength(1)
    await writeFile(path, JSON.stringify([{ ...records[0], Labels: { ...records[0]!.Labels, 'dsh-phalanx.community-root': 'foreign-root' } }]))
    await expect(containers.rebuild()).rejects.toThrow('ownership')
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
