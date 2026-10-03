const KNOWN_MODELS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'deepseek-flash': { name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' },
  'deepseek-v4-pro': {
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
  },
}

/** Catalog for the supplied default provider; user-selected providers retain their native configuration. */
export function modelCatalogJson(model: string): string {
  return JSON.stringify([{ id: model, ...KNOWN_MODELS[model] }])
}
