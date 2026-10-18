import { knownModel } from './shared-models.js'

/** Catalog for the supplied default provider; user-selected providers retain their native configuration. */
export function modelCatalogJson(model: string): string {
  return JSON.stringify([{ id: model, ...knownModel(model)?.defaultModel }])
}
