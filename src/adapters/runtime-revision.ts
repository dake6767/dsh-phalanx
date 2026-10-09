import { readFileSync } from 'node:fs'
/** Release-owned runtime identity, shared by source and installed layouts. */
export function declaredRuntimeRevision(): string {
  const value = JSON.parse(readFileSync(new URL('../../runtime-versions.json', import.meta.url), 'utf8')) as { dsh?: { revision?: string } }
  if (!value.dsh?.revision || !/^[a-f0-9]{40}$/u.test(value.dsh.revision)) throw new Error('Runtime revision is unavailable')
  return value.dsh.revision
}

export function pluginCompatibilityTarget(): string {
  const value = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  return `${value.version}/${declaredRuntimeRevision()}`
}
