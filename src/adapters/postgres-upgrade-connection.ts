import type { PlatformDatabaseConnection } from '../domain/platform-database.js'

/** libpq's private password-file encoding; validate before downtime as well as immediately before use. */
export function postgresUpgradePasswordFile(connection: PlatformDatabaseConnection): string {
  const fields = [connection.host, String(connection.port), connection.database, connection.username, connection.password]
  return (
    fields
      .map(value => {
        if (/[\r\n\0]/u.test(value))
          throw Error('PostgreSQL archive credentials must fit the private password-file format; the running deployment was not changed')
        return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
      })
      .join(':') + '\n'
  )
}

/** TOC selection omits only creation of original namespaces, preserving every ACL and content entry. */
export function postgresUpgradeRestoreList(input: string, retainedSchemas: readonly string[]): string {
  const seen = new Set<string>()
  const lines = input.split('\n').map(line => {
    const schema = /^[0-9]+; [0-9]+ [0-9]+ SCHEMA - ([a-z_][a-z0-9_]*) /u.exec(line)?.[1]
    if (!schema) return line
    if (!retainedSchemas.includes(schema) || seen.has(schema)) throw Error('Database archive schema inventory differs from its backup')
    seen.add(schema)
    return ';' + line
  })
  if (seen.size !== retainedSchemas.length) throw Error('Database archive is missing an original namespace')
  return lines.join('\n')
}
