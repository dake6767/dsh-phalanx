import { Document, isAlias, isMap, isNode, isSeq, parseDocument, type Node } from 'yaml'

const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }

/** Official composed config is data: preserve lazy expressions without executing them. */
export function disableNativeCreatorTools(source: string): string {
  const document = parseDocument(source, options)
  if (document.errors.length || document.warnings.length || !isSeq(document.contents)) throw new Error('Native composed configuration is unavailable')
  const matches = document.contents.items.filter(row => isMap(row) && String(row.get('id')) === 'preset-cordis')
  if (matches.length !== 1 || !isMap(matches[0])) throw new Error('Native Creator configuration is unavailable')
  const config = expand(matches[0].get('config', true), document)
  if (!isMap(config) || !isSeq(config.get('plugins', true))) throw new Error('Native Creator plugins are unavailable')
  const plugins = config.get('plugins', true)
  if (!isSeq(plugins)) throw new Error('Native Creator plugins are unavailable')
  for (const id of ['tool-plugin-manager', 'tool-plugin-market']) {
    const rows = plugins.items.filter(row => isMap(row) && row.get('id') === id)
    if (rows.length !== 1 || !isMap(rows[0])) throw new Error('Native Creator installation tools are unavailable')
    rows[0].delete('disabled')
    rows[0].set('disabled', true)
  }
  const output = new Document([{ id: 'preset-cordis' }], options)
  output.setIn([0, 'config'], config)
  return output.toString()
}

/** Project deployment tool policy from the official composed configuration, preserving lazy values. */
export function nativeToolPolicy(source: string, restrictCreator: boolean): string {
  const document = parseDocument(source, options)
  if (document.errors.length || document.warnings.length || !isSeq(document.contents)) throw new Error('Native composed configuration is unavailable')
  const output = new Document([], options)
  const toolConfigs: unknown[] = []
  const visit = (rows: unknown): boolean => {
    if (!isSeq(rows)) return false
    let changed = false
    for (const row of rows.items) {
      if (!isMap(row)) continue
      if (row.get('id') === 'tools') toolConfigs.push(row.get('config', true))
      if (row.get('name') === '@deepseek-ai/dsh-tool-web') {
        let config = row.get('config', true)
        if (config === undefined) {
          row.set('config', document.createNode({}))
          config = row.get('config', true)
        }
        if (!isMap(config)) throw new Error('Native web tool configuration is unavailable')
        config.set('fetch', false)
        changed = true
      }
      if (row.get('group') === true) changed = visit(row.get('config', true)) || changed
      const config = row.get('config', true)
      if (isMap(config)) changed = visit(config.get('plugins', true)) || changed
    }
    return changed
  }
  for (const original of document.contents.items) {
    const row = expand(original, document)
    if (!isMap(row)) continue
    const single = new Document([], options)
    single.contents = single.createNode([row])
    if (visit(single.contents)) {
      const patch: unknown = output.createNode({ id: row.get('id') })
      if (!isMap(patch)) throw new Error('Native tool policy is unavailable')
      patch.set('config', row.get('config', true))
      if (row.get('id') === 'preset-cordis' && restrictCreator) {
        const creator = parseDocument(disableNativeCreatorTools(source), options)
        const disabled = expand(creator.getIn([0, 'config'], true), creator)
        if (!isMap(disabled)) throw new Error('Native Creator configuration is unavailable')
        // Apply fetch policy to the same complete configuration, so neither patch overwrites the other.
        visit(disabled.get('plugins', true))
        patch.set('config', disabled)
      }
      output.add(patch)
    }
  }
  if (restrictCreator && !output.toJS().some((row: { id?: string }) => row.id === 'preset-cordis')) {
    const creator = parseDocument(disableNativeCreatorTools(source), options)
    output.add(expand(creator.getIn([0], true), creator))
  }
  if (toolConfigs.length !== 1) throw new Error('Native tool service configuration is unavailable')
  const layers = document.contents.items.filter(row => isMap(row) && String(row.get('id')) === 'phalanx-platform-layer')
  if (layers.length !== 1 || !isMap(layers[0])) throw new Error('Native platform layer is unavailable')
  const config = expand(layers[0].get('config', true), document)
  if (!isMap(config)) throw new Error('Native platform layer configuration is unavailable')
  if (config.get('patches', true) === undefined) config.set('patches', document.createNode([]))
  const patches = config.get('patches', true)
  if (!isSeq(patches)) throw new Error('Native platform layer patches are unavailable')
  const service: unknown = output.createNode({ id: 'phalanx-tools' })
  if (!isMap(service)) throw new Error('Native tool service configuration is unavailable')
  service.set('config', toolConfigs[0] ?? {})
  patches.add(service)
  const layer: unknown = output.createNode({ id: 'phalanx-platform-layer' })
  if (!isMap(layer) || !isSeq(output.contents)) throw new Error('Native tool policy is unavailable')
  layer.set('config', config)
  output.contents.items.unshift(layer)
  return output.toString()
}

/** Expand aliases before moving the subtree, so external anchors cannot become dangling references. */
function expand(value: unknown, document: Document, depth = 0): Node | null {
  if (depth > 50) throw new Error('Native Creator configuration nesting is excessive')
  if (isAlias(value)) return expand(value.resolve(document), document, depth + 1)
  if (!isNode(value)) return null
  const copy = value.clone()
  if ('anchor' in copy) delete copy.anchor
  if (isSeq(copy)) copy.items = copy.items.map(item => expand(item, document, depth + 1))
  if (isMap(copy))
    for (const pair of copy.items) {
      pair.key = expand(pair.key, document, depth + 1)
      pair.value = expand(pair.value, document, depth + 1)
    }
  return copy as Node
}
