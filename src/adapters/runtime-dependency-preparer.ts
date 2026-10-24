import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { RuntimeDependencyDefinition } from '../domain/runtime-dependency.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependencyCheck, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { RuntimeDependencyPreparerPort } from '../ports/runtime-dependencies.js'
import type { ContainerExecutionProcess } from './execution-container-process.js'
import { FileExecutionArtifacts } from './execution-artifacts.js'
import { platformSystemPath } from './platform-process-host.js'
import { downloadSourceEnvironment, resolveDownloadSources } from '../domain/download-source.js'
import type { DownloadSourceReaderPort } from '../ports/download-sources.js'
import { outboundProxyEnvironment, redactProxyOutput } from './outbound-proxy.js'

export const runtimeDependencyMount = '/dsh-phalanx/runtime-dependencies/.trees'
/** Only deployer egress credentials enter preparation; member/provider credentials never do. */
export class RuntimeDependencyPreparer implements RuntimeDependencyPreparerPort {
  private image = ''
  constructor(private readonly process: Pick<ContainerExecutionProcess, 'run' | 'recover' | 'imageIdentity' | 'canDiscardArtifacts' | 'isolated'>, private readonly artifacts: FileExecutionArtifacts, private readonly sources?: { directory(version: string): string },
    private readonly downloads: DownloadSourceReaderPort = { current: () => resolveDownloadSources({ preset: 'official' }) }) {}
  get isolated(): boolean { return this.process.isolated }
  async recover(): Promise<void> { await this.process.recover(); this.image = await this.process.imageIdentity() }
  // Source defaults affect the next preparation, not the validity of an existing version.
  identity(input: RuntimeDependencyDefinition): string {
    const values: unknown[] = [input.prepareCommand, input.pathDirectories, input.checkCommand ?? '', input.sourceVersion ?? '', this.image]
    if (input.type === 'python-library') values.push(input.type, input.packages)
    if (input.type === 'resource') values.push(input.type)
    return createHash('sha256').update(JSON.stringify(values)).digest('hex')
  }
  collect(retained: readonly string[]): Promise<void> { return this.process.canDiscardArtifacts ? this.artifacts.collect(retained) : Promise.resolve() }
  async prepare(input: RuntimeDependencyDefinition, progress: (log: string, checks?: readonly RuntimeDependencyCheck[]) => Promise<void>, signal: AbortSignal): Promise<RuntimeDependencyVersion> {
    const stage = await this.artifacts.stage(), id = basename(stage.directory), mountedPath = this.isolated ? `${runtimeDependencyMount}/${id}` : stage.directory
    const downloads = this.downloads.current()
    const defaults = { ...downloadSourceEnvironment(downloads, process.arch) }
    // npm treats environment names case-insensitively, with order-dependent
    // collisions. A private HOME config is lower priority than either spelling
    // of an explicit environment assignment, and than command-line options.
    delete defaults.NPM_CONFIG_REGISTRY
    delete defaults.PNPM_CONFIG_REGISTRY
    const proxy = outboundProxyEnvironment()
    const environment = { ...defaults, ...proxy, HOME: '/tmp/phalanx-home', TMPDIR: '/tmp', PYTHONNOUSERSITE: '1', RD_OUT: mountedPath, PATH: platformSystemPath([], !this.isolated) }
    const output: Buffer[] = [], checks: RuntimeDependencyCheck[] = []; let published = false
    const log = () => redactProxyOutput(Buffer.concat(output).toString('utf8'), proxy)
    const execute = (command: string, argv: readonly string[], readOnly: boolean, emit: (data: Uint8Array) => Promise<void>, path = environment.PATH) => this.process.run({
      mounts: [{ host: stage.directory, mounted: mountedPath, readOnly }], cwd: mountedPath, command, argv, stdin: new Uint8Array(), timeoutMs: 600_000, environment: { ...environment, PATH: path },
    }, event => emit(event.data), signal)
    const executeShell = (command: string, readOnly: boolean, emit: (data: Uint8Array) => Promise<void>, path = environment.PATH) => execute('/bin/sh',
      ['-c', 'set -e; export XDG_CONFIG_HOME="$HOME/.config"; mkdir -p "$XDG_CONFIG_HOME/pnpm"; printf "registry=%s\\n" "$1" > "$HOME/.npmrc"; printf "%s\\n" "$3" > "$XDG_CONFIG_HOME/pnpm/config.yaml"; exec /bin/sh -c "$2"', 'runtime-dependency', downloads.npm, command, JSON.stringify({ registry: downloads.npm })], readOnly, emit, path)
    const emit = async (data: Uint8Array) => { output.push(Buffer.from(data)); await progress(log()) }
    const fail = (code: ConstructorParameters<typeof RuntimeDependencyPreparationFailure>[0], kind: RuntimeDependencyCheck['kind'], detail: string): never => {
      checks.push({ kind, passed: false, detail }); throw new RuntimeDependencyPreparationFailure(code, detail, checks)
    }
    try {
      await emit(Buffer.from('Download defaults (explicit command options take precedence): '+JSON.stringify({ npmUserConfigRegistry: downloads.npm, ...defaults })+'\n'))
      await emit(Buffer.from('Preparation command (explicit source options and assignments override defaults): '+input.prepareCommand+'\n'))
      if (input.sourceVersion) {
        if (!this.sources) throw new Error('Migration source is unavailable')
        await this.artifacts.seed(stage, this.sources.directory(input.sourceVersion))
      }
      // Downloads can exceed the process container's small ephemeral /tmp.
      // Keep preparation scratch space on the artifact volume, then discard it
      // before validating or publishing any output.
      const temporaryDirectory = await mkdtemp(join(stage.directory, '.preparation-tmp-'))
      environment.TMPDIR = `${mountedPath}/${basename(temporaryDirectory)}`
      const exit = await executeShell(input.prepareCommand, false, emit)
      if (exit !== 0) throw new RuntimeDependencyPreparationFailure('prepare-failed', `Preparation exited with code ${exit}.${proxy.HTTPS_PROXY ? ' Check HTTPS_PROXY/NO_PROXY and proxy availability if the download failed.' : ''}`)
      await rm(temporaryDirectory, { recursive: true, force: true })
      environment.TMPDIR = '/tmp'
      signal.throwIfAborted(); await progress(log(), checks)
      const inspection: Buffer[] = []
      const inspectionExit = await execute('node', ['-e', inspectArtifact, mountedPath, JSON.stringify(input.pathDirectories)], true, async data => { inspection.push(Buffer.from(data)) })
      if (inspectionExit !== 0) fail('path-invalid', 'paths', 'Artifact inspection could not finish.')
      const result = JSON.parse(Buffer.concat(inspection).toString('utf8')) as { code?: 'path-invalid' | 'link-escape' | 'command-conflict', kind?: RuntimeDependencyCheck['kind'], detail?: string, commands: string[], commandPaths: Record<string, string>, bytes: number }
      if (result.code) fail(result.code, result.kind!, result.detail!)
      let python: RuntimeDependencyVersion['python']
      if (input.type === 'python-library') {
        const metadata: Buffer[] = []
        const code = await execute(`${mountedPath}/venv/bin/python3`, ['-c', 'import json,sys,sysconfig; print(json.dumps({"prefix":sys.prefix,"sitePackages":sysconfig.get_path("purelib"),"abi":sys.implementation.cache_tag}))'], true, async data => { metadata.push(Buffer.from(data)) })
        if (code !== 0) fail('path-invalid', 'paths', 'Python venv metadata could not be inspected.')
        const value = JSON.parse(Buffer.concat(metadata).toString('utf8')) as { prefix: string, sitePackages: string, abi: string }
        if (value.prefix !== `${mountedPath}/venv` || !value.sitePackages.startsWith(value.prefix + '/') || !/^cpython-\d+$/u.test(value.abi)) fail('path-invalid', 'paths', 'Python interpreter does not use its prepared venv.')
        python = { name: input.name, interpreter: 'venv/bin/python3', sitePackages: value.sitePackages.slice(mountedPath.length + 1), abi: value.abi }
        result.commands = ['python3']; result.commandPaths = { python3: python.interpreter }
      }
      checks.push({ kind: 'links', passed: true }, { kind: 'paths', passed: true }, { kind: 'commands', passed: true }); await progress(log(), checks)
      if (input.checkCommand) {
        await emit(Buffer.from('Check command (explicit source options and assignments override defaults): '+input.checkCommand+'\n'))
        let exit = 125
        try { exit = await executeShell(input.checkCommand, true, async data => { output.push(Buffer.from(data)); await progress(log(), checks) }, platformSystemPath(input.pathDirectories.map(path => `${mountedPath}/${path}`), !this.isolated)) }
        catch (error) { if (signal.aborted) throw error; fail('check-failed', 'check-command', 'Check command could not complete; inspect its output and timeout.') }
        if (exit !== 0) fail('check-failed', 'check-command', `Check command exited with code ${exit}.`)
        checks.push({ kind: 'check-command', passed: true })
      }
      signal.throwIfAborted()
      const identity = this.identity(input)
      await this.artifacts.publish(stage, id, identity, log()); published = true
      return { id, identity, directory: stage.directory, mountedPath, pathDirectories: [...input.pathDirectories], commands: result.commands, commandPaths: result.commandPaths, bytes: result.bytes, isolated: this.isolated, checks, log: log(), ...(python ? { python } : {}) }
    } catch (error) {
      if (error instanceof RuntimeDependencyPreparationFailure || signal.aborted) throw error
      throw new RuntimeDependencyPreparationFailure('prepare-failed', 'Preparation or artifact inspection could not finish.', checks)
    } finally { if (!published && this.process.canDiscardArtifacts) await this.artifacts.discard(stage) }
  }
}

// Resolve in the runtime filesystem: absolute links and venv shebangs use the final mounted path.
const inspectArtifact = `
const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(process.argv[1]), directories = JSON.parse(process.argv[2]);
const inside = target => target === root || target.startsWith(root + path.sep);
const reject = (code, kind, detail) => { throw { code, kind, detail }; };
let bytes = 0; const commands = new Set(), commandPaths = {};
const walk = entry => {
  const info = fs.lstatSync(entry);
  if (info.isSymbolicLink()) {
    let target; try { target = fs.realpathSync(entry); } catch { reject('link-escape', 'links', 'Broken link: ' + path.relative(root, entry)); }
    if (!inside(target)) reject('link-escape', 'links', 'Link escapes artifact: ' + path.relative(root, entry));
  } else if (info.isDirectory()) for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
  else if (info.isFile()) bytes += info.size;
  else reject('path-invalid', 'paths', 'Unsupported artifact entry: ' + path.relative(root, entry));
};
try {
  walk(root);
  for (const directory of directories) {
    const location = path.join(root, directory); let target;
    try { target = fs.realpathSync(location); if (!fs.statSync(target).isDirectory()) throw Error(); }
    catch { reject('path-invalid', 'paths', 'PATH directory is missing: ' + directory); }
    if (!inside(target)) reject('link-escape', 'links', 'PATH directory escapes artifact: ' + directory);
    let found = false;
    for (const name of fs.readdirSync(target).sort()) {
      const entry = path.join(target, name), info = fs.statSync(entry);
      if (!info.isFile() || !(info.mode & 73)) continue;
      found = true;
      if (commands.has(name)) reject('command-conflict', 'commands', 'Duplicate command: ' + name);
      commands.add(name); commandPaths[name] = path.posix.join(directory, name);
    }
    if (!found) reject('path-invalid', 'paths', 'PATH directory has no executable files: ' + directory);
  }
  process.stdout.write(JSON.stringify({ commands: [...commands].sort(), commandPaths, bytes }));
} catch (error) { process.stdout.write(JSON.stringify(error.code && error.kind ? error : { code: 'path-invalid', kind: 'paths', detail: 'Artifact cannot be inspected.' })); }
`
