import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommunityRuntimeConfig } from '../../src/domain/community-config.js'
import { bochaSample } from './real-mcp-samples.js'

/** Reuse the exact upstream Python archive when final acceptance supplies it. */
export async function verifiedBochaInput(base: CommunityRuntimeConfig) {
  const archive = process.env.DSH_PHALANX_PYTHON312_ARCHIVE
  if (!archive) return { runtime: base, service: bochaSample }
  if (!base.container) throw Error('Verified Bocha input requires Linux containers')
  const digest = 'c74addcd1b033a6e4d60ead3ab47fcc995569027e01d3061c4a934f363c4a0cf'
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== digest) throw Error('Python archive identity mismatch')
  const wrapper = join(base.dataRoot, 'podman-verified-input')
  await writeFile(wrapper, `#!/usr/bin/python3\nimport os,sys\nargs=sys.argv[1:]\nif args[0]=='run' and any(v.startswith('dsh-phalanx.execution=') for v in args): args[1:1]=['--volume',${JSON.stringify(archive + ':/acceptance-python.tgz:ro')}]\nos.execvp(${JSON.stringify(base.container.runtime)},[${JSON.stringify(base.container.runtime)},*args])\n`, { mode: 0o700, flag: 'wx' })
  const prepareCommand = bochaSample.run!.prepareCommand!
    .replace('UV_PYTHON_INSTALL_DIR=', `mkdir python-runtime && cp /acceptance-python.tgz python.tgz && echo '${digest}  python.tgz' | sha256sum -c - && tar xzf python.tgz -C python-runtime && rm python.tgz && UV_PYTHON_INSTALL_DIR=`)
    .replace('--python 3.12.12', '--python "$PWD/python-runtime/python/bin/python3.12"')
  return { runtime: { ...base, container: { ...base.container, runtime: wrapper } }, service: { ...bochaSample, run: { ...bochaSample.run!, prepareCommand } } }
}
