// Manual credentialed facts probe. It is deliberately outside every required credential-free inventory.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, it } from 'vitest'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { officeSdkDownloadFacts } from './fixtures/office-sdk.js'
import { probeOfficeDocument } from './fixtures/office-document.js'
import { skillZip } from './fixtures/skills/archive.js'
import { officeFactsInput, openOfficeSession, until, type OfficeFactsInput, type OfficeSession } from './fixtures/office-session.js'

let input: OfficeFactsInput, session: OfficeSession | undefined
const credentials: string[] = []
let credentialExposureDetected = false
const mask = (value: string) => credentials.reduce((text, credential) => {
  if (text.includes(credential)) credentialExposureDetected = true
  return text.replaceAll(credential, '{credential}')
}, value)
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const record = async (name: string, value: unknown) => writeFile(join(input.root, 'results', name + '.json'), JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? mask(item) : item, 2) + '\n')
const imports = 'import importlib,json,sys; names=["pathops","uharfbuzz","fitz","numpy","PIL"]; [importlib.import_module(name) for name in names]; print(json.dumps({"modules":names,"prefix":sys.prefix}))'
const tool = () => { assert(session, 'Session not started'); return session }
beforeAll(async () => {
  input = await officeFactsInput()
  const info = await lstat(input.credentialFile)
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid!() && (info.mode & 0o777) === 0o600, 'Credential input must be owned and mode 0600')
  const credential = (await readFile(input.credentialFile, 'utf8')).trim()
  assert(credential, 'Missing backend credential')
  credentials.push(credential)
  try { session = await openOfficeSession(input) } catch (error) { throw new Error(mask(error instanceof Error ? error.message : String(error))) }
})
afterAll(async () => { try { await session?.stop() } catch (error) { throw new Error(mask(error instanceof Error ? error.message : String(error))) } })

it('prepares the complete locked libraries through the existing runtime dependency API', async () => {
  const api = tool().api
  const locked = (await readFile(input.requirementsLock, 'utf8')).split('\n').filter(Boolean)
  assert(locked.length > 18 && locked.every(line => /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$/u.test(line)), 'Use a fully resolved exact lock')
  const prepareCommand = ['set -eu', 'python3 -m venv --copies "$RD_OUT/venv"',
    '"$RD_OUT/venv/bin/python" -m pip install --disable-pip-version-check --no-input --no-deps --no-cache-dir --only-binary=:all: ' + locked.map(quote).join(' '),
    '"$RD_OUT/venv/bin/python" -m pip check',
    '"$RD_OUT/venv/bin/python" -m pip freeze > "$RD_OUT/requirements.lock"'].join('\n')
  const expectedDefinition = { prepareCommand, pathDirectories: ['venv/bin'], checkCommand: 'python3 -c ' + quote(imports) }
  const rows = await api('runtime-dependencies')
  const reused = rows.some((row: { name: string }) => row.name === 'office-python')
  if (reused) {
    const existing = await api('runtime-dependencies?name=office-python')
    assert.deepEqual({ prepareCommand: existing.prepareCommand, pathDirectories: existing.pathDirectories, checkCommand: existing.checkCommand },
      expectedDefinition, 'Existing office-python definition differs; retain this root and prepare a new explicitly owned environment')
  }
  if (!reused) {
    await api('runtime-dependencies', { action: 'create', input: { name: 'office-python', ...expectedDefinition } })
  }
  const started = performance.now()
  const row = await until(() => api('runtime-dependencies?name=office-python'), row => row.stage === 'ready' || row.stage === 'failed', 660_000)
  await record(reused ? 'runtime-preparation-reused' : 'runtime-preparation', { stage: row.stage, checks: row.checks, failureCode: row.failureCode,
    elapsedSeconds: (performance.now() - started) / 1000, current: row.current, pythonVenvCopies: true, reused, definitionVerified: true, definitionSha256: createHash('sha256').update(JSON.stringify(expectedDefinition)).digest('hex') })
  await writeFile(join(input.root, reused ? 'results/runtime-preparation-reused.log' : 'results/runtime-preparation.log'), mask(row.log))
  assert(row.stage === 'ready', 'Complete locked runtime dependency preparation failed; retain its log')

  const files: { path: string, content: Buffer | string }[] = []
  for (const path of ['SKILL.md', 'LICENSE', 'SPONSORS.md', 'SPONSORS_CN.md']) files.push({ path, content: await readFile(join(input.skillRoot, path)) })
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relative = prefix + entry.name
      if (entry.isDirectory()) { if (entry.name !== '__pycache__') await visit(path, relative + '/') }
      else if (entry.isFile() && entry.name.endsWith('.py')) files.push({ path: relative, content: await readFile(path) })
    }
  }
  await visit(join(input.skillRoot, 'scripts'), 'scripts/')
  files.push({ path: 'scripts/import_probe.py', content: 'import os,sys,subprocess\n' +
    'if len(sys.argv)>2 and sys.argv[1]=="--pythonpath":\n' +
    ' subprocess.run(["/usr/bin/python3","-c",' + JSON.stringify(imports) + '],env={**os.environ,"PYTHONPATH":sys.argv[2]},check=True)\n' +
    'else:\n exec(' + JSON.stringify(imports) + ')\n' })
  const response = await fetch(tool().origin + '/admin/api/skills/upload', { method: 'POST', headers: {
    origin: tool().origin, cookie: tool().adminCookie, 'content-type': 'application/zip' }, body: new Uint8Array(skillZip(files)) })
  assert(response.status === 200, 'Small unchanged upstream script subset could not be imported')
  const preview = await response.json()
  await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
  const detail = await api('skills/detail?name=ppt-master')
  await api('skills/change', { action: 'runtime-dependencies', name: detail.name, names: ['office-python'], revision: detail.revision })
  const path = `groups/${tool().group.id}/skills`, grant = await api(path)
  await api(path, { action: 'save', names: ['ppt-master'], revision: grant.revision, confirmed: true })
  await api('skills/execution?name=ppt-master', { enabled: true, commands: [
    { command: 'scripts/import_probe.py', blocked: [] }, { command: 'scripts/image_gen.py', blocked: [] }],
  variables: [], runtimeDependencies: ['office-python'] })
  const ready = await until(() => api('skills/execution?name=ppt-master'), row => row.preparation?.stage === 'ready' || row.preparation?.stage === 'failed')
  assert(ready.preparation.stage === 'ready', 'Broker dependency preparation did not become ready')
})

it('compares Python path injection and a dependency virtualenv in real member and broker contexts', async () => {
  const bash = tool().bash
  const defaultResult = await bash('python3 -c ' + quote('import json,sys,sysconfig,os,shutil; print(json.dumps({"prefix":sys.prefix,"site":sysconfig.get_paths()["purelib"],"resolved":os.path.realpath(shutil.which("python3"))}))'))
  await record('python-member-default-output', defaultResult)
  assert(defaultResult.exitCode === 0, 'Default member Python did not start')
  const defaultPython = JSON.parse(defaultResult.stdout.text) as { prefix: string, site: string, resolved: string }
  assert(defaultPython.resolved.startsWith('/dsh-phalanx/runtime-dependencies/.trees/'), 'Python must resolve to the actual mounted dependency')
  const venvBin = defaultPython.resolved.slice(0, defaultPython.resolved.lastIndexOf('/'))
  const result = await bash(quote(defaultPython.resolved) + ' -c ' + quote('import json,sys,sysconfig; print(json.dumps({"prefix":sys.prefix,"site":sysconfig.get_paths()["purelib"]}))'))
  await record('python-explicit-venv-output', result)
  assert(result.exitCode === 0, 'Explicit dependency virtualenv Python did not start')
  const python = JSON.parse(result.stdout.text) as { prefix: string, site: string }
  const own = '/dsh-phalanx/workspace/office-own-venv'
  const created = await bash('/usr/bin/python3 -m venv --without-pip ' + quote(own))
  await record('python-own-venv-created-output', created)
  assert(created.exitCode === 0, 'Member could not create an independent virtualenv in its writable workspace')
  const canImport = 'import importlib.util,json; print(json.dumps({"numpy":importlib.util.find_spec("numpy") is not None}))'
  const commands = {
    memberPythonPath: 'PYTHONPATH=' + quote(python.site) + ' /usr/bin/python3 -c ' + quote(canImport),
    ownPythonPath: 'PYTHONPATH=' + quote(python.site) + ' ' + quote(own + '/bin/python') + ' -c ' + quote(canImport),
    memberDependencyVenv: 'PATH=' + quote(venvBin) + ':"$PATH" python3 -c ' + quote(canImport),
    ownCleanVenv: 'env -u PYTHONPATH ' + quote(own + '/bin/python') + ' -c ' + quote(canImport),
    brokerDependencyVenv: 'python3 /dsh-phalanx/member-skills/live/ppt-master/scripts/import_probe.py',
    brokerPythonPath: 'python3 /dsh-phalanx/member-skills/live/ppt-master/scripts/import_probe.py --pythonpath ' + quote(python.site),
  }
  const outputs: Record<string, unknown> = {}
  for (const [name, command] of Object.entries(commands)) {
    const output = await bash(command)
    await record('python-context-' + name + '-output', output)
    assert(output.exitCode === 0, 'Python context probe failed: ' + name)
    outputs[name] = JSON.parse(output.stdout.text)
  }
  assert((outputs.memberPythonPath as { numpy: boolean }).numpy)
  assert((outputs.ownPythonPath as { numpy: boolean }).numpy, 'PYTHONPATH experiment should expose its effect on self-created venvs')
  assert((outputs.memberDependencyVenv as { numpy: boolean }).numpy)
  assert(!(outputs.ownCleanVenv as { numpy: boolean }).numpy)
  assert((outputs.brokerDependencyVenv as { modules: string[] }).modules.includes('numpy'))
  assert((outputs.brokerPythonPath as { modules: string[] }).modules.includes('numpy'))
  await record('python-contexts', { status: 'passed', experimentalConditions: 'Per-command PYTHONPATH or explicit dependency venv bin PATH; current generic projected python symlink is recorded separately',
    defaultMemberPython: defaultPython,
    observed: outputs, decision: 'dependency virtualenv; global PYTHONPATH also enters member-created venvs', memberPython: python })
})

it('measures the existing distribution adapter with the complete upstream skill', async () => {
  let files = 0, bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else { assert(entry.isFile(), 'Distribution experiment rejects links'); files++; bytes += (await lstat(path)).size }
    }
  }
  await visit(input.skillRoot)
  const distribution = new FileSkillDistribution(join(input.root, 'distribution'), { directory: () => input.skillRoot })
  const skill = { name: 'ppt-master', description: 'Pinned complete upstream office skill',
    hash: createHash('sha256').update(await readFile(join(input.skillRoot, 'SKILL.md'))).digest('hex'), importedAt: 0, published: false }
  const members = [{ spaceId: 'first', skills: [skill] }]
  let start = performance.now(); await distribution.synchronize(members); const firstSeconds = (performance.now() - start) / 1000
  start = performance.now(); await distribution.synchronize([...members, { spaceId: 'second', skills: [skill] }]); const secondSeconds = (performance.now() - start) / 1000
  await record('skill-distribution', { status: 'passed', files, unpackedBytes: bytes, firstSeconds, secondSeconds,
    constructedAdapterInput: true, publicImportLimitsUnchanged: true })
})

it('measures real single and small-manifest image generation through delegated execution', async () => {
  const api = tool().api
  const info = await lstat(input.credentialFile)
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid!() && (info.mode & 0o777) === 0o600, 'Credential file must be owned and mode 0600')
  const key = (await readFile(input.credentialFile, 'utf8')).trim()
  assert(key.length > 0, 'Empty backend credential file')
  const settings = await api('execution/settings')
  assert(settings.limits.timeoutSeconds === 120 && settings.limits.memoryMiB === 512 && settings.limits.cpus === 1 && settings.limits.pids === 64, 'Retain the normal broker limits')
  const commands = [{ command: 'scripts/import_probe.py', blocked: [] }, { command: 'scripts/image_gen.py', blocked: [] }]
  const prefix = input.imageBackend.backend === 'minimax' ? 'MINIMAX' : 'VOLCENGINE'
  const configured = await api('skills/execution?name=ppt-master', { enabled: true, commands, runtimeDependencies: ['office-python'], variables: [
    { name: 'IMAGE_BACKEND', value: input.imageBackend.backend, secret: false },
    { name: prefix + '_MODEL', value: input.imageBackend.model, secret: false },
    { name: prefix + '_BASE_URL', value: input.imageBackend.baseUrl, secret: false },
    { name: prefix + '_API_KEY', value: key, secret: true },
  ] })
  assert(!JSON.stringify(configured).includes(key), 'Execution response exposed a credential')
  const ready = await until(() => api('skills/execution?name=ppt-master'), row => row.preparation?.stage === 'ready' || row.preparation?.stage === 'failed')
  assert(ready.preparation.stage === 'ready', 'Image generation broker is not ready')
  const imageSize = input.imageBackend.backend === 'minimax' ? '512px' : '2K'
  const cwd = '/dsh-phalanx/workspace/office-cwd', host = join(tool().root, 'users/member/workspace/office-cwd')
  await mkdir(join(host, 'batch'), { recursive: true, mode: 0o700 })
  if (!input.imageResumeReport) await writeFile(join(host, 'batch/image_prompts.json'), JSON.stringify({ items: [
    { filename: 'batch-a.png', prompt: 'A simple blue circle on a plain white background, no text', aspect_ratio: '1:1', image_size: imageSize, status: 'Pending' },
    { filename: 'batch-b.png', prompt: 'A simple green triangle on a plain white background, no text', aspect_ratio: '1:1', image_size: imageSize, status: 'Pending' },
  ] }))
  const invocations = [
    { name: 'single', args: quote('A simple orange square on a plain white background, no text') + ' --aspect_ratio 1:1 --image_size ' + imageSize + ' -o single -f single' },
    { name: 'manifest', args: '--manifest batch/image_prompts.json --concurrency 1' },
  ]
  let startedAt = Date.now()
  let measurements: { name: string, exitCode: number, elapsedSeconds: number }[] = []
  if (input.imageResumeReport) {
    assert(!relative(join(input.root, 'results'), input.imageResumeReport).startsWith('..'), 'Resume report must belong to this owned result root')
    const report = JSON.parse(await readFile(input.imageResumeReport, 'utf8')) as { testResults: { assertionResults: { fullName: string }[] }[] }
    const previous = report.testResults.flatMap(row => row.assertionResults).find(row => row.fullName === 'measures real single and small-manifest image generation through delegated execution')
    assert(previous, 'Missing original paid invocation case')
    const checkpoint = JSON.parse(await readFile(join(input.root, 'results/image-generation.json'), 'utf8'))
    assert.deepEqual(checkpoint.imageBackend, input.imageBackend, 'Resume must retain the same backend')
    assert.deepEqual(checkpoint.limits, settings.limits, 'Resume must retain the same broker limits')
    assert(!checkpoint.credentialExposureDetected && checkpoint.measurements.length === 2 && checkpoint.measurements.every((row: { exitCode: number }) => row.exitCode === 0), 'Resume only after both paid calls succeeded')
    for (const name of ['single', 'manifest']) {
      const output = await readFile(join(input.root, 'results/image-' + name + '-output.json'), 'utf8')
      assert(!output.includes('{credential}'), 'An earlier paid output required credential redaction')
    }
    assert(Number.isFinite(checkpoint.startedAt), 'Missing original paid invocation checkpoint time')
    measurements = checkpoint.measurements
    startedAt = checkpoint.startedAt
  } else {
    for (const row of invocations) {
      const started = performance.now()
      let output
      try { output = await tool().bash('cd ' + quote(cwd) + ' && python3 /dsh-phalanx/member-skills/live/ppt-master/scripts/image_gen.py ' + row.args, 120_000) }
      catch (error) { throw new Error(mask(error instanceof Error ? error.message : String(error))) }
      await record('image-' + row.name + '-output', output)
      measurements.push({ name: row.name, exitCode: output.exitCode, elapsedSeconds: (performance.now() - started) / 1000 })
      await record('image-generation', { status: output.exitCode === 0 ? 'running' : 'failed', measurements, startedAt, credentialExposureDetected, imageSize, manifestConcurrency: 1, limits: settings.limits, imageBackend: input.imageBackend })
      assert(output.exitCode === 0, 'Real image generation failed: ' + row.name + '; retained output is private')
    }
  }
  const manifest = JSON.parse(await readFile(join(host, 'batch/image_prompts.json'), 'utf8'))
  assert(manifest.items.length === 2 && manifest.items.every((row: { status: string }) => row.status === 'Generated'), 'Batch manifest was not completed')
  const validation = 'from PIL import Image; import pathlib,json,hashlib; paths=[p for p in pathlib.Path("single").glob("single.*") if p.suffix.lower() in [".png",".jpeg",".jpg"]]+[pathlib.Path("batch")/item["filename"] for item in json.loads(pathlib.Path("batch/image_prompts.json").read_text())["items"]]; result=[]\nfor p in paths:\n im=Image.open(p); im.verify(); result.append({"path":str(p),"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()})\nprint(json.dumps(result))'
  const generated = await tool().bash('cd ' + quote(cwd) + ' && "$(readlink -f "$(command -v python3)")" -c ' + quote(validation))
  await record('image-file-validation-output', generated)
  assert(generated.exitCode === 0, 'Generated files could not be decoded with the dependency Python libraries')
  assert(!credentialExposureDetected, 'A credential appeared in a probe output; the retained output was redacted')
  const files = JSON.parse(generated.stdout.text)
  assert(files.length === 3, 'Expected one single image and two batch images in the calling workspace')
  const usage = await api('usage-records?username=member&capability=skill%3Appt-master')
  const rows = usage.items.filter((row: { startedAt: number, capability: { operation: string } }) => row.startedAt >= startedAt && row.capability.operation === 'scripts/image_gen.py')
  assert(rows.length === 2 && rows.every((row: { exitCode: number, outcome: string }) => row.exitCode === 0 && row.outcome === 'succeeded'), 'Missing successful broker usage records')
  assert(!JSON.stringify(rows).includes(key), 'Usage records exposed a credential')
  const memberEnvironment = await tool().bash('env')
  assert(!memberEnvironment.stdout.text.includes(key), 'Member environment exposed the platform key')
  await record('image-generation', { status: 'passed', measurements, startedAt, credentialExposureDetected, files, usage: rows, limits: settings.limits,
    imageBackend: input.imageBackend, imageSize, manifestConcurrency: 1, resumedValidation: input.imageResumeReport !== undefined, credentialAbsentFromMemberEnvironment: true, writebackToCallingCwd: true })
})

it('accepts the locked SDK archive through the existing github-assets download source', async () => {
  await record('sdk-download-source', officeSdkDownloadFacts())
})

it('opens a real docx in the published OnlyOffice renderer and observes SDK document readiness', async () => {
  try { await probeOfficeDocument(input, tool(), record) } catch (error) { throw new Error(mask(error instanceof Error ? error.message : String(error))) }
})
