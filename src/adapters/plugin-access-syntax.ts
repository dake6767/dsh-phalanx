import { isNode, parseDocument, visit } from 'yaml'
import { pluginAccessObject } from '../domain/plugin-access.js'
import type { PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import { literalPluginAccess, managedAccessEntryIds } from '../dsh/managed-plugin-access.js'
export class YamlPluginAccessSyntax implements PluginAccessSyntaxPort {
  parse(source: string): Readonly<Record<string, PluginEntryConfig>> {
    if (!source.trim()) return {}
    const document = parseDocument(source)
    if (document.errors.length || document.warnings.length) throw Error('Invalid YAML')
    visit(document, (_, node) => { if (isNode(node) && node.tag) throw Error('YAML tags are not allowed') })
    const value: unknown = document.toJS({ maxAliasCount: 0 })
    if (!pluginAccessObject(value) || Object.values(value).some(row => !pluginAccessObject(row))) throw Error('Entry configuration must be a mapping of objects')
    if (!literalPluginAccess(value)) throw Error('Invalid configuration value')
    return value as Readonly<Record<string, PluginEntryConfig>>
  }
  entryIds(plugin: PreparedPlugin): readonly string[] { return managedAccessEntryIds(plugin.bundlePatch) }
}
