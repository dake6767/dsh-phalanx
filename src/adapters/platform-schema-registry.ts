import { PLATFORM_MIGRATIONS } from './platform-schema.js'

export interface PlatformSchema {
  readonly name: string
  readonly migrations: readonly { readonly version: number; readonly name: string; readonly sql: string }[]
}

/** The production schema inventory, shared by migration, compatibility and backup readers. */
export const PLATFORM_SCHEMAS: readonly PlatformSchema[] = [{ name: 'dsh_phalanx', migrations: PLATFORM_MIGRATIONS }]

/** Registry names are SQL identifiers, never arbitrary SQL or a search_path expression. */
export function schemaIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name) || name.startsWith('pg_') || name === 'information_schema' || name === 'public')
    throw Error('A registered platform schema must have a distinct non-system SQL name')
  return `"${name}"`
}

/** A composition supplies a fixed inventory for one database lifetime. */
export function registeredSchemas(schemas: readonly PlatformSchema[]): readonly PlatformSchema[] {
  if (schemas[0]?.name !== 'dsh_phalanx') throw Error('The platform core schema must be registered first')
  const names = new Set<string>()
  return Object.freeze(
    schemas.map(schema => {
      schemaIdentifier(schema.name)
      if (names.has(schema.name)) throw Error('Platform schema names must be unique')
      names.add(schema.name)
      if (!schema.migrations.length || schema.migrations.some((migration, index) => migration.version !== index + 1))
        throw Error('Registered schema migrations must be contiguous from version 1')
      return Object.freeze({ name: schema.name, migrations: Object.freeze(schema.migrations.map(migration => Object.freeze({ ...migration }))) })
    }),
  )
}
