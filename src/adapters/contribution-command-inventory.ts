import type { ContributionCommandInventory } from '../ports/member-contributions.js'
import type { ContainerExecutionProcess } from './execution-container-process.js'
import { platformSystemPath } from './platform-process-host.js'

/** Inspect only the platform image's executable directories, never a member's packages or contributed code. */
export class RuntimeContributionCommands implements ContributionCommandInventory {
  private cached: readonly string[] | undefined
  constructor(private readonly process: ContainerExecutionProcess) {}
  async commands(signal: AbortSignal): Promise<readonly string[]> {
    if (this.cached) return this.cached
    let output = ''
    const script = `const fs=require('node:fs'),path=require('node:path'),names=new Set();for(const directory of process.env.PATH.split(path.delimiter)){let entries;try{entries=fs.readdirSync(directory)}catch{continue}for(const name of entries){try{const file=path.join(directory,name);if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);names.add(name)}}catch{}}}process.stdout.write(JSON.stringify([...names]));`
    const status = await this.process.run({ mounts: [], cwd: '/tmp', command: 'node', argv: ['-e', script], stdin: new Uint8Array(), environment: { HOME: '/tmp', TMPDIR: '/tmp', PATH: platformSystemPath([], !this.process.isolated) }, timeoutMs: 30000 }, async event => {
      if (event.stream === 'stdout') { output += Buffer.from(event.data).toString('utf8'); if (output.length > 1024 * 1024) throw Error('Image command inventory exceeded its limit') }
    }, signal)
    if (status !== 0) throw Error('Could not inspect image commands')
    const names: unknown = JSON.parse(output)
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw Error('Invalid image command inventory')
    this.cached = names; return names
  }
}
