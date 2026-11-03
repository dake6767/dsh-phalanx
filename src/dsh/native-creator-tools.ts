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
