import { isMap, isSeq, parseDocument } from 'yaml'

/** Invocation overlay only confines the first-use workspace; user settings stay editable. */
export const communityOverlayUrl = new URL('../../runtime/community.cordis.yml', import.meta.url)

/** Supply absent defaults in the native writable profile, below home/invocation patches. */
export function supplyCommunityDefaults(source: string, provider: string, model: string): string {
  const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }
  const document = parseDocument(source, options)
  if (document.errors.length > 0 || !isSeq(document.contents)) throw new Error('Private DSH profile patch must be a valid sequence')
  const defaults = parseDocument(`
- id: agent-default-model
  config:
    provider: ${JSON.stringify(provider)}
    model: ${JSON.stringify(model)}
- id: llm-deepseek
  config:
    baseURL: !!js process.env.DSH_PHALANX_MODEL_GATEWAY_URL
    apiKeyEnv: DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN
    models: !!js "JSON.parse(process.env.DSH_PHALANX_DEFAULT_MODEL_SECRET_CATALOG)"
`, options)
  if (!isSeq(defaults.contents)) throw new Error('Default DSH profile is invalid')
  let changed = false
  for (const row of defaults.contents.items) {
    if (!isMap(row)) continue
    const id = row.get('id')
    if (document.contents.items.some(item => isMap(item) && item.get('id') === id)) continue
    document.contents.add(row); changed = true
  }
  return changed ? document.toString() : source
}
