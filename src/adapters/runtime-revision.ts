import { readFileSync } from 'node:fs'
/** Release-owned runtime identity, shared by source and installed layouts. */
export function declaredRuntimeRevision(): string {
  const value = JSON.parse(readFileSync(new URL('../../runtime-versions.json', import.meta.url), 'utf8')) as { dsh?: { revision?: string } }
  if (!value.dsh?.revision || !/^[a-f0-9]{40}$/u.test(value.dsh.revision)) throw new Error('Runtime revision is unavailable')
  return value.dsh.revision
}

/** Platform version declared by the release package, used for catalog `engines.platform` matching. */
export function declaredPlatformVersion(): string {
  const value = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  if (!value.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)) throw new Error('Platform version is unavailable')
  return value.version
}

export function pluginCompatibilityTarget(): string {
  const value = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  return `${value.version}/${declaredRuntimeRevision()}`
}
