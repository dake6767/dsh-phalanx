/** Public tool-service composition: refresh platform MCP before step admission and deny unconfined fetch. */
export const memberToolsModule = `
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const runtime = createRequire(process.argv[1])
const { default: ToolsService } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-tools')).href)
export default class PhalanxTools extends ToolsService {
  constructor(ctx) {
    super(ctx)
    this.guard(exec => exec.name === 'web_fetch' ? 'Web fetch is unavailable in this deployment.' : undefined)
  }
  async resolve(context) {
    context.signal.throwIfAborted()
    await this.ctx.root.parallel('phalanx/before-tools-resolve', context)
    context.signal.throwIfAborted()
    return super.resolve(context)
  }
}
`
