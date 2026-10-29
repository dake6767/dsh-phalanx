// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { validationRuntimePreparer } from './support/validation-downloads.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection } from './support/real-dsh-runtime.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it.skipIf(!runtimeSettings.containerImage)(
  'prepares downloads larger than the container temporary filesystem without publishing temporary files',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dependency-temporary-files-'))
    const process = new ContainerExecutionProcess(runtimeSection(root, 'https://example.test', runtimeSettings))
    const artifacts = new FileExecutionArtifacts(join(root, '.trees'))
    const preparer = validationRuntimePreparer(process, artifacts)
    try {
      await preparer.recover()
      const version = await preparer.prepare(
        {
          name: 'large-download',
          pathDirectories: ['bin'],
          prepareCommand:
            'set -eu; dd if=/dev/zero of="$TMPDIR/download" bs=1048576 count=160; mkdir bin; printf "#!/bin/sh\\necho ready\\n" > bin/example; chmod +x bin/example',
          checkCommand: 'test ! -e "$TMPDIR/download" && example',
        },
        async () => {},
        new AbortController().signal,
      )
      expect(version.checks.every(check => check.passed)).toBe(true)
      expect(version.bytes).toBeLessThan(1024)
      expect(await readdir(version.directory)).toEqual(['bin'])
    } finally {
      await process.stop()
      await artifacts.collect([])
      await removeCommunityFixture(root)
    }
  },
  120000,
)
