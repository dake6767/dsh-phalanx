import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { CommunityRuntimeDependencyInput } from '../domain/admin-contract.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependencyCheck, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { RuntimeDependencyPreparerPort } from '../ports/runtime-dependencies.js'
import type { ContainerExecutionProcess } from './execution-container-process.js'
import { FileExecutionArtifacts } from './execution-artifacts.js'
import { platformSystemPath } from './platform-process-host.js'

export const runtimeDependencyMount = '/dsh-phalanx/runtime-dependencies/.trees'
/** Credentials never enter this seam. Validation gets a new HOME and a read-only artifact mount. */
export class RuntimeDependencyPreparer implements RuntimeDependencyPreparerPort {
  private image = ''
  constructor(private readonly process: Pick<ContainerExecutionProcess, 'run' | 'recover' | 'imageIdentity' | 'canDiscardArtifacts' | 'isolated'>, private readonly artifacts: FileExecutionArtifacts) {}
  get isolated(): boolean { return this.process.isolated }
  async recover(): Promise<void> { await this.process.recover(); this.image = await this.process.imageIdentity() }
  identity(input: CommunityRuntimeDependencyInput): string { return createHash('sha256').update(JSON.stringify([input.prepareCommand, input.pathDirectories, input.checkCommand ?? '', this.image])).digest('hex') }
  collect(retained: readonly string[]): Promise<void> { return this.process.canDiscardArtifacts ? this.artifacts.collect(retained) : Promise.resolve() }
  async prepare(input: CommunityRuntimeDependencyInput, progress: (log: string, checks?: readonly RuntimeDependencyCheck[]) => Promise<void>, signal: AbortSignal): Promise<RuntimeDependencyVersion> {
    const stage = await this.artifacts.stage(), id = basename(stage.directory), mountedPath = this.isolated ? `${runtimeDependencyMount}/${id}` : stage.directory
    const environment = { HOME: '/tmp/phalanx-home', TMPDIR: '/tmp', PYTHONNOUSERSITE: '1', RD_OUT: mountedPath, PATH: platformSystemPath([]) }
    const output: Buffer[] = [], checks: RuntimeDependencyCheck[] = []; let published = false
    const log = () => Buffer.concat(output).toString('utf8')
    const execute = (command: string, argv: readonly string[], readOnly: boolean, emit: (data: Uint8Array) => Promise<void>, path = environment.PATH) => this.process.run({
      mounts: [{ host: stage.directory, mounted: mountedPath, readOnly }], cwd: mountedPath, command, argv, stdin: new Uint8Array(), timeoutMs: 600_000, environment: { ...environment, PATH: path },
    }, event => emit(event.data), signal)
    const emit = async (data: Uint8Array) => { output.push(Buffer.from(data)); await progress(log()) }
    const fail = (code: ConstructorParameters<typeof RuntimeDependencyPreparationFailure>[0], kind: RuntimeDependencyCheck['kind'], detail: string): never => {
      checks.push({ kind, passed: false, detail }); throw new RuntimeDependencyPreparationFailure(code, detail, checks)
    }
    try {
      const exit = await execute('/bin/sh', ['-c', input.prepareCommand], false, emit)
      if (exit !== 0) throw new RuntimeDependencyPreparationFailure('prepare-failed', `Preparation exited with code ${exit}.`)
      signal.throwIfAborted(); await progress(log(), checks)
      const inspection: Buffer[] = []
      const inspectionExit = await execute('node', ['-e', inspectArtifact, mountedPath, JSON.stringify(input.pathDirectories)], true, async data => { inspection.push(Buffer.from(data)) })
      if (inspectionExit !== 0) fail('path-invalid', 'paths', 'Artifact inspection could not finish.')
      const result = JSON.parse(Buffer.concat(inspection).toString('utf8')) as { code?: 'path-invalid' | 'link-escape' | 'command-conflict', kind?: RuntimeDependencyCheck['kind'], detail?: string, commands: string[], bytes: number }
      if (result.code) fail(result.code, result.kind!, result.detail!)
      checks.push({ kind: 'links', passed: true }, { kind: 'paths', passed: true }, { kind: 'commands', passed: true }); await progress(log(), checks)
      if (input.checkCommand) {
        let exit = 125
        try { exit = await execute('/bin/sh', ['-c', input.checkCommand], true, async data => { output.push(Buffer.from(data)); await progress(log(), checks) }, platformSystemPath(input.pathDirectories.map(path => `${mountedPath}/${path}`))) }
        catch (error) { if (signal.aborted) throw error; fail('check-failed', 'check-command', 'Check command could not complete; inspect its output and timeout.') }
        if (exit !== 0) fail('check-failed', 'check-command', `Check command exited with code ${exit}.`)
        checks.push({ kind: 'check-command', passed: true })
      }
      signal.throwIfAborted()
      const identity = this.identity(input)
      await this.artifacts.publish(stage, id, identity, log()); published = true
      return { id, identity, directory: stage.directory, mountedPath, pathDirectories: [...input.pathDirectories], commands: result.commands, bytes: result.bytes, isolated: this.isolated, checks, log: log() }
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
let bytes = 0; const commands = new Set();
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
      commands.add(name);
    }
    if (!found) reject('path-invalid', 'paths', 'PATH directory has no executable files: ' + directory);
  }
  process.stdout.write(JSON.stringify({ commands: [...commands].sort(), bytes }));
} catch (error) { process.stdout.write(JSON.stringify(error.code && error.kind ? error : { code: 'path-invalid', kind: 'paths', detail: 'Artifact cannot be inspected.' })); }
`
