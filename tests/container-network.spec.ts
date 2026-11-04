import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readPastaLoopbackMapping } from '../src/adapters/container-network.js'

async function withRuntimeHelper(action: (runtime: string, helper: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pasta-capability-'))
  const runtime = join(root, 'podman'),
    helper = join(root, 'pasta')
  try {
    await writeFile(runtime, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ host: { pasta: { executable: helper } } }))})`, {
      mode: 0o700,
    })
    await action(runtime, helper)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['stdout', 'stderr'] as const)('detects explicit loopback mapping from the runtime-selected helper help on %s', async stream => {
  await withRuntimeHelper(async (runtime, helper) => {
    await writeFile(
      helper,
      `#!/usr/bin/env node\nif(process.argv[2]!=='--help')process.exit(2);process.${stream}.write('Usage: pasta\\n  --tcp-ports SPEC\\n  --host-lo-to-ns-lo\\n')`,
      { mode: 0o700 },
    )
    expect(await readPastaLoopbackMapping(runtime, new AbortController().signal)).toBe(true)
  })
})

it('keeps the old mapping for older help and does not mistake a longer option for support', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    for (const help of ['--tcp-ports SPEC', '--tcp-ports SPEC\n--host-lo-to-ns-lo-extra']) {
      await writeFile(helper, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(help)})`, { mode: 0o700 })
      expect(await readPastaLoopbackMapping(runtime, new AbortController().signal)).toBe(false)
    }
  })
})

it('refuses unknown capabilities when the helper is missing, fails or returns empty help', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    const read = () => readPastaLoopbackMapping(runtime, new AbortController().signal)
    await expect(read()).rejects.toThrow('capability could not be determined')
    await writeFile(helper, '#!/usr/bin/env node\nprocess.exit(2)', { mode: 0o700 })
    await expect(read()).rejects.toThrow('capability could not be determined')
    await writeFile(helper, '#!/usr/bin/env node\n', { mode: 0o700 })
    await expect(read()).rejects.toThrow('capability could not be determined')
    await writeFile(runtime, '#!/usr/bin/env node\nprocess.stdout.write("{}")')
    await expect(read()).rejects.toThrow('capability could not be determined')
  })
})

it('preserves startup cancellation instead of reporting unsupported pasta', async () => {
  await withRuntimeHelper(async runtime => {
    const controller = new AbortController()
    controller.abort(new Error('fixture startup cancelled'))
    await expect(readPastaLoopbackMapping(runtime, controller.signal)).rejects.toThrow('fixture startup cancelled')
  })
})

it('resolves the helper with the launch client environment without giving member values to helper help', async () => {
  await withRuntimeHelper(async (runtime, helper) => {
    await writeFile(runtime, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({host:{pasta:{executable:process.env.FIXTURE_PASTA_HELPER}}}))')
    await writeFile(
      helper,
      '#!/usr/bin/env node\nif(process.env.FIXTURE_PASTA_HELPER)process.exit(2);process.stdout.write("--tcp-ports SPEC --host-lo-to-ns-lo")',
      { mode: 0o700 },
    )
    expect(await readPastaLoopbackMapping(runtime, new AbortController().signal, { FIXTURE_PASTA_HELPER: helper })).toBe(true)
  })
})
