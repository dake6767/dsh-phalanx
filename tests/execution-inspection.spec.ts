import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileExecutionInspection } from '../src/adapters/execution-inspection.js'

it('suggests only names from generic script reads, subprocesses and preparation clues without executing content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-inspection-'))
  try {
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts/news.sh'), '#!/bin/sh\nnews-cli hot --key "$NEWS_API_KEY"\n')
    await writeFile(join(root, 'scripts/mps.py'), 'import os, subprocess\nid = os.environ["MPS_SECRET_ID"]\nkey = os.getenv("MPS_SECRET_KEY")\nsubprocess.run(["mps-cli", "query"])\n')
    await writeFile(join(root, 'scripts/showapi.js'), 'const key = process.env.SHOWAPI_TOKEN; spawn("showapi-cli", ["list"]);')
    await writeFile(join(root, 'scripts/gzh.py'), 'key = os.environ.get("GZH_KEY", "do-not-copy-this-value")\n')
    await writeFile(join(root, 'requirements.txt'), 'controlled-dependency==1.0.0\n')
    await writeFile(join(root, 'query.sh'), '#!/bin/sh\necho ready\n')
    await writeFile(join(root, 'setup.sh'), '#!/bin/sh\nprintf SHOULD_NOT_EXECUTE\n')
    const inspection = new FileExecutionInspection({ directory: () => root })
    const result = await inspection.inspect('v1')
    expect(result.commands).toEqual(expect.arrayContaining(['news-cli', 'mps-cli', 'showapi-cli', 'scripts/news.sh', 'scripts/mps.py', 'scripts/showapi.js', 'scripts/gzh.py']))
    expect(result.variables).toEqual(['GZH_KEY', 'MPS_SECRET_ID', 'MPS_SECRET_KEY', 'NEWS_API_KEY', 'SHOWAPI_TOKEN'])
    expect(result.prepare).toContain('python3 -m venv .venv')
    expect(result.prepare).toContain('.venv/bin/pip install -r requirements.txt')
    expect(result.prepare).toContain('sh setup.sh')
    expect(JSON.stringify(result)).not.toContain('do-not-copy-this-value')
    expect(await inspection.available('v1', 'scripts/deleted.py')).toBe(false)
    expect(await inspection.available('v1', 'scripts/mps.py')).toBe(true)
    expect(result.commands).toContain('./query.sh')
    expect(await inspection.available('v1', './query.sh')).toBe(true)
    await rm(join(root, 'query.sh'))
    expect(await inspection.available('v2', './query.sh')).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
