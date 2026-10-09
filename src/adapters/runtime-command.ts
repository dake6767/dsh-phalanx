import { execFile } from 'node:child_process'

/** Minimal inherited environment for the rootless container CLI. */
export function containerClientEnvironment(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key]
    if (value !== undefined) inherited[key] = value
  }
  return inherited
}

export function execFileText(
  command: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal, readonly maxBuffer?: number, readonly env?: NodeJS.ProcessEnv, readonly timeout?: number,
    readonly reportOutputOnFailure?: boolean, readonly acceptedExitCodes?: readonly number[] } = {},
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const { reportOutputOnFailure, acceptedExitCodes, ...execOptions } = options
    execFile(command, [...args], { encoding: 'utf8', ...execOptions }, (error, stdout, stderr) => {
      if (error !== null && !(typeof error.code === 'number' && acceptedExitCodes?.includes(error.code))) reject(reportOutputOnFailure
        ? new Error(`${error.message}\n${sanitize(stderr.slice(-2000))}\n${sanitize(stdout.slice(-2000))}`)
        : error)
      else resolveOutput(stdout)
    })
  })
}

export function sanitize(value: string): string {
  return value.replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]')
}
