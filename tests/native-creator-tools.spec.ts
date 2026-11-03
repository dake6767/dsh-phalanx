import { expect, it } from 'vitest'
import { disableNativeCreatorTools } from '../src/dsh/native-creator-tools.js'
import { parseDocument } from 'yaml'

it('preserves the complete composed Creator configuration and lazy expressions while disabling only its two installation tools', () => {
  const dump = `- id: unrelated\n  config: { secret: fixture }\n- id: preset-cordis\n  config:\n    id: cordis\n    order: 42\n    description: Custom creator\n    plugins:\n      - id: tool-plugin-manager\n        name: '@deepseek-ai/tool-plugin-manager'\n        disabled: !!js '!ctx.get("profileContext")'\n      - id: tool-plugin-market\n        name: '@deepseek-ai/tool-plugin-market'\n      - id: member-tool\n        name: '@fixture/member-tool'\n        config:\n          lazy: !!js 'ctx.get("fixture")'\n`
  const result = disableNativeCreatorTools(dump)
  expect(result).not.toContain('secret')
  expect(result).toContain('!!js')
  const parsed = parseDocument(result, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ expression: source }) }] }).toJS()
  expect(parsed).toEqual([
    {
      id: 'preset-cordis',
      config: {
        id: 'cordis',
        order: 42,
        description: 'Custom creator',
        plugins: [
          { id: 'tool-plugin-manager', name: '@deepseek-ai/tool-plugin-manager', disabled: true },
          { id: 'tool-plugin-market', name: '@deepseek-ai/tool-plugin-market', disabled: true },
          { id: 'member-tool', name: '@fixture/member-tool', config: { lazy: { expression: 'ctx.get("fixture")' } } },
        ],
      },
    },
  ])
})

it('resolves external YAML aliases before publishing and refuses missing or duplicate installation tool declarations', () => {
  const config = `- id: anchor-holder\n  config: &member-config\n    lazy: !!js 'ctx.get("fixture")'\n- id: preset-cordis\n  config:\n    id: cordis\n    plugins:\n      - { id: tool-plugin-manager, name: fixture-manager }\n      - { id: tool-plugin-market, name: fixture-market }\n      - id: member-tool\n        config: *member-config\n`
  const result = disableNativeCreatorTools(config)
  const parsed = parseDocument(result, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ expression: source }) }] })
  expect(parsed.errors).toHaveLength(0)
  expect(parsed.toJS()[0].config.plugins[2].config).toEqual({ lazy: { expression: 'ctx.get("fixture")' } })
  expect(() => disableNativeCreatorTools(config.replace('tool-plugin-market', 'other-tool'))).toThrow('installation tools')
  expect(() => disableNativeCreatorTools(config.replace('member-tool', 'tool-plugin-manager'))).toThrow('installation tools')
})
