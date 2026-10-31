import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

type WorkflowStep = { id?: string; run?: string; with?: { name: string; path: string } }
type WorkflowJob = { steps: WorkflowStep[] }

it.each(['amd64', 'arm64'])('only hands off %s artifacts after aggregation of all independent runners', architecture => {
  const workflow = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8'))
  const output = architecture === 'amd64' ? 'image_artifact' : 'development_image_artifact'
  expect(workflow.on.workflow_call.outputs[output].value).toBe('${{ jobs.' + architecture + '-verified.outputs.' + output + ' }}')
  const gate = workflow.jobs[architecture + '-verified']
  const bundle = architecture === 'amd64' ? 'amd64-bundle' : 'native-arm64'
  expect(gate.needs).toEqual(expect.arrayContaining(['scope', bundle, 'native-tests']))
  expect(gate.if).toContain('always()')
  const verify = gate.steps.find((s: { id?: string }) => s.id === 'verified')
  expect(verify.if).toBe('always()')
  expect(verify.run).toContain('test "$BUNDLE_RESULT" = success')
  expect(verify.run).toContain('test "$TEST_RESULT" = success')
  expect(verify.run.indexOf('t2-shards.mjs verify')).toBeLessThan(verify.run.indexOf("printf '" + output + '='))
  const tests = workflow.jobs['native-tests']
  expect(tests.strategy).toMatchObject({ 'fail-fast': false, 'max-parallel': 8, matrix: { architecture: ['amd64', 'arm64'] } })
  expect(tests.strategy.matrix.shard).toBe('${{ fromJSON(needs.scope.outputs.matrix).include }}')
  expect(tests['runs-on']).toContain('ubuntu-24.04-arm')
  expect(workflow.jobs['native-arm64']['runs-on']).toBe('ubuntu-24.04-arm')
  expect(workflow.jobs['formal-upgrade'].if).toContain("needs.scope.outputs.upgrade == 'true'")
})

it('runs only the arm64 smoke in development image mode, leaving full acceptance to shards', () => {
  const workflow = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8'))
  const step = workflow.jobs['native-arm64'].steps.find((entry: { name: string }) => entry.name === 'Run the shared rootless Linux command')
  expect(step.if).toBe('inputs.development_image_only')
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `cat() { printf '%s\\n' fixture-image; }; sudo() { printf '%s\\n' "$@"; };\n${step.run}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SOURCE_SHA: 'a'.repeat(40) },
  })
  expect(result.status, result.stderr).toBe(0)
  const argv = result.stdout.trim().split('\n')
  expect(argv).toContain('scripts/validation/t2-host.py')
  expect(argv).toContain('--smoke')
  expect(argv).not.toContain('--files')
  expect(argv).not.toContain('--reuse-baseline')
})

it.each(['amd64', 'arm64'])('passes the assigned frozen shard and native archive to the %s runner', architecture => {
  const workflow = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8'))
  const step = workflow.jobs['native-tests'].steps.find((entry: { name: string }) => entry.name === 'Run the assigned installed Linux cases')
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `cat() { printf '%s\\n' fixture-image; }; sudo() { printf '%s\\n' "$@"; };\n${step.run}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, MODE: 'full', SHARD: '2', EXPECTED_ARCH: architecture, SOURCE_SHA: 'a'.repeat(40) },
  })
  expect(result.status, result.stderr).toBe(0)
  const argv = result.stdout.trim().split('\n')
  expect(argv).toContain('--shard')
  expect(argv).toContain('2/4')
  expect(argv).toContain('/var/tmp/dsh-phalanx-spike-bundle/dsh-phalanx-dsh-linux-' + architecture + '.oci.tar')
  expect(argv).toContain('--identity')
  expect(argv).not.toContain('--smoke')
})

it.each(['', '12345'])('adopts both tested archives and updater for a candidate with baseline %s', baseline => {
  const workflow = parse(readFileSync('.github/workflows/candidate.yml', 'utf8'))
  const job = (Object.values(workflow.jobs) as WorkflowJob[]).find(entry => entry.steps?.some(step => step.run?.includes('t2-image.mjs')))!
  const step = job.steps.find(entry => entry.run?.includes('t2-image.mjs'))!
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `node() { printf '%s\\n' "$*"; }; sudo() { :; };\n${step.run}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REUSE_BASELINE_RUN: baseline },
  })
  expect(result.status, result.stderr).toBe(0)
  const adoption = result.stdout.split('\n').find(line => line.includes('t2-image.mjs'))!
  expect(adoption.split(/\s+/u)).toContain('--include-platform')
})

it('rejects changed platform and updater bytes when restoring a tested candidate', async () => {
  const workflow = parse(readFileSync('.github/workflows/candidate.yml', 'utf8'))
  const job = (Object.values(workflow.jobs) as WorkflowJob[]).find(entry => entry.steps?.some(step => step.run?.includes('t2-image.mjs')))!
  const step = job.steps.find(entry => entry.run?.includes('cmp t2-image/'))!
  const root = await mkdtemp(join(tmpdir(), 'candidate-restore-bytes-'))
  const files = ['dsh-phalanx-dsh-linux-amd64.oci.tar', 'dsh-phalanx-linux-amd64.tar.gz', 'updater.json']
  try {
    for (const dir of ['t2-image', 'candidate']) {
      await mkdir(join(root, dir))
      for (const name of files) await writeFile(join(root, dir, name), 'tested ' + name)
    }
    const run = () =>
      spawnSync('bash', ['-eo', 'pipefail', '-c', step.run!], { cwd: root, env: { PATH: process.env.PATH, REUSE_BASELINE_RUN: '' }, encoding: 'utf8' })
    expect(run().status).toBe(0)
    for (const name of files.slice(1)) {
      await writeFile(join(root, 'candidate', name), 'different bytes')
      expect(run().status, name).not.toBe(0)
      await writeFile(join(root, 'candidate', name), 'tested ' + name)
    }
    expect(run().status).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains the exact tested arm64 platform, updater and image together', () => {
  const workflow = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8'))
  const upload = workflow.jobs['native-arm64'].steps.find((step: WorkflowStep) => step.id === 'development-image-artifact')
  expect(upload.with.name).toBe('t2-development-arm64-${{ github.run_id }}-${{ github.run_attempt }}')
  const paths = upload.with.path.trim().split(/\s+/u)
  expect(paths).toEqual(
    expect.arrayContaining(
      ['dsh-phalanx-dsh-linux-arm64.oci.tar', 'dsh-phalanx-linux-arm64.tar.gz', 'updater.json', 'manifest.json', 'SHA256SUMS', 'image-selection.json'].map(
        name => '/var/tmp/dsh-phalanx-spike-bundle/' + name,
      ),
    ),
  )
  expect(paths).toHaveLength(6)
})

it.each(['amd64-bundle', 'native-arm64'])('records the database and platform unit journals before %s uploads a failed installation', name => {
  const steps = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8')).jobs[name].steps as (WorkflowStep & { name: string; if?: string })[]
  const install = steps.findIndex(step => step.id === 'install')
  const record = steps.findIndex(step => step.name === 'Record failed installation service diagnostics')
  const upload = steps.findIndex(step => step.id === 'diagnostics')
  expect(install).toBeGreaterThanOrEqual(0)
  expect(install < record && record < upload).toBe(true)
  const step = steps[record]!
  expect(step.if).toBe("failure() && steps.install.outcome == 'failure'")
  expect(step.run).toContain('_SYSTEMD_USER_UNIT="$unit"')
  expect(step.run).toContain('dsh-phalanx-postgres.service')
  expect(step.run).toContain('journalctl -k')
  // Raw journals are written outside the uploaded results and only enter them redacted.
  expect(step.run).toMatch(/raw=\$\(sudo mktemp -d \/var\/tmp\/dsh-phalanx-install-raw\./u)
  expect(step.run).not.toMatch(/> *"?\$results\/[^"]*"? *2>&1/u)
  expect(step.run).toContain('redact-diagnostics.py "$raw/$name" "$results/$name"')
})

it('redacts secret values from public install diagnostics while keeping the failing lines readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redact-diagnostics-'))
  try {
    const source = join(root, 'raw.txt'),
      target = join(root, 'public.txt')
    await writeFile(
      source,
      [
        'Process: 1234 ExecStartPre=/opt/dsh-phalanx/current/start database-password-file --config-file /var/lib/dsh-phalanx/keys/builtin-database.json --output /run/user/1002/dsh-phalanx-database/password (code=exited, status=1/FAILURE)',
        'Error: open /run/secrets/postgres-password: permission denied',
        'POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password',
        'HTTPS_PROXY=http://proxy-user:proxy-pass-123@proxy.example:3128',
        'Open http://127.0.0.1:18080/bootstrap?credential=bootstrap-value-456 to initialize',
        'GET https://objects.example/file.tar?sig=signed-value-789',
        '{"message": "connect", "password": "json-value-abc"}',
        'connection postgres://phalanx:db-value-def@127.0.0.1:25432/dsh_phalanx refused',
        'Master fingerprint sha256:' + 'a'.repeat(64),
        'run --api-key api-value-ghi --token=token-value-jkl',
        'Authorization: Bearer bearer-value-mno',
        'dsh-phalanx-postgres.service: Failed with result exit-code.',
      ].join('\n'),
    )
    const result = spawnSync('python3', ['-I', 'scripts/validation/redact-diagnostics.py', source, target], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    const output = readFileSync(target, 'utf8')
    for (const value of [
      'proxy-pass-123',
      'proxy-user',
      'bootstrap-value-456',
      'signed-value-789',
      'json-value-abc',
      'db-value-def',
      'a'.repeat(64),
      'api-value-ghi',
      'token-value-jkl',
      'bearer-value-mno',
    ])
      expect(output).not.toContain(value)
    expect(output).toContain('database-password-file --config-file /var/lib/dsh-phalanx/keys/builtin-database.json')
    expect(output).toContain('(code=exited, status=1/FAILURE)')
    expect(output).toContain('open /run/secrets/postgres-password: permission denied')
    expect(output).toContain('POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password')
    expect(output).toContain('dsh-phalanx-postgres.service: Failed with result exit-code.')
    expect(output.split('\n')).toHaveLength(12)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['amd64-bundle', 'native-tests', 'native-arm64'])('names each symbolic link before %s refuses to upload its results', async name => {
  const steps = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8')).jobs[name].steps as (WorkflowStep & { name: string; if?: string })[]
  const checkIndex = steps.findIndex(step => step.id === 'diagnostics')
  const receiptIndex = steps.findIndex(step => step.with?.path === '/var/tmp/dsh-phalanx-results-check/')
  expect(checkIndex).toBeGreaterThanOrEqual(0)
  expect(receiptIndex).toBeGreaterThan(checkIndex)
  expect(steps[receiptIndex]!.if).toBe("always() && steps.diagnostics.outcome == 'failure' && steps.diagnostics.outputs.receipt == 'ready'")
  const root = await mkdtemp(join(tmpdir(), 't2-results-check-'))
  try {
    const results = join(root, 'results'),
      receipt = join(root, 'receipt'),
      output = join(root, 'github-output')
    const script = steps[checkIndex]!.run!.replaceAll('/var/tmp/dsh-phalanx-spike-results', results).replaceAll('/var/tmp/dsh-phalanx-results-check', receipt)
    const runStep = () => {
      spawnSync('rm', ['-rf', receipt])
      return spawnSync('bash', ['-e', '-c', `sudo() { "$@"; }; chown() { :; }; ${script}`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
      })
    }
    const link = (target: string, path: string) => expect(spawnSync('ln', ['-s', target, path]).status).toBe(0)

    expect(runStep().status).toBe(0)
    await mkdir(join(results, 'linux-files', '1', 'tmp'), { recursive: true })
    await writeFile(join(results, 'cleanup.json'), '{"result":"passed","errors":[]}\n')
    expect(runStep().status).toBe(0)
    expect(readFileSync(join(receipt, 'cleanup.json'), 'utf8')).toContain('"passed"')

    link('http://user:secret-value@example.test/x?token=query-value', join(results, 'linux-files', '1', 'tmp', 'retained-link'))
    const refused = runStep()
    expect(refused.status).toBe(1)
    expect(refused.stdout).toContain('Results contain symbolic links')
    expect(refused.stdout).toMatch(/::stop-commands::[0-9a-f]{16}/u)
    expect(readFileSync(output, 'utf8')).toContain('receipt=ready')
    const listed = readFileSync(join(receipt, 'links.txt'), 'utf8')
    expect(listed).toContain('retained-link -> http://')
    expect(listed).not.toContain('secret-value')
    expect(listed).not.toContain('query-value')

    // A pre-existing receipt path is never adopted for upload.
    await rm(receipt, { recursive: true, force: true })
    await mkdir(receipt)
    await writeFile(output, '')
    const planted = spawnSync('bash', ['-e', '-c', `sudo() { "$@"; }; chown() { :; }; ${script}`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
    })
    expect(planted.status).toBe(1)
    expect(planted.stdout).toContain('Receipt path already exists')
    // Without the ready output the receipt upload is skipped, so the planted directory never leaves the runner.
    expect(readFileSync(output, 'utf8')).not.toContain('receipt=ready')

    await rm(results, { recursive: true, force: true })
    await writeFile(results, 'not a directory')
    const file = runStep()
    expect(file.status).toBe(1)
    expect(file.stdout).toContain('Results root is not a directory')
    await rm(results)
    link(root, results)
    const rooted = runStep()
    expect(rooted.status).toBe(1)
    expect(rooted.stdout).toContain('Results root is a symbolic link')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['amd64', 'arm64'])('withholds the %s artifact when a prerequisite fails, is cancelled or is skipped', async architecture => {
  const workflow = parse(readFileSync('.github/workflows/linux-t2.yml', 'utf8'))
  const step = workflow.jobs[architecture + '-verified'].steps.find((entry: { id?: string }) => entry.id === 'verified')
  const root = await mkdtemp(join(tmpdir(), 't2-workflow-gate-'))
  const output = join(root, 'github-output')
  try {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      for (const failed of ['BUNDLE_RESULT', 'TEST_RESULT']) {
        await writeFile(output, '')
        const run = spawnSync('bash', ['-eo', 'pipefail', '-c', `node() { :; };\n${step.run}`], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            GITHUB_OUTPUT: output,
            BUNDLE_RESULT: 'success',
            TEST_RESULT: 'success',
            DEVELOPMENT_IMAGE_ONLY: 'false',
            ARTIFACT_ID: '123',
            [failed]: result,
          },
        })
        expect(run.status, failed + '=' + result).not.toBe(0)
        expect(await readFile(output, 'utf8')).toBe('')
      }
    }
    if (architecture === 'arm64') {
      const run = spawnSync('bash', ['-eo', 'pipefail', '-c', `node() { :; };\n${step.run}`], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          BUNDLE_RESULT: 'success',
          TEST_RESULT: 'skipped',
          DEVELOPMENT_IMAGE_ONLY: 'true',
          ARTIFACT_ID: '123',
        },
      })
      expect(run.status, run.stderr).toBe(0)
      expect(await readFile(output, 'utf8')).toBe('development_image_artifact=123\n')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
