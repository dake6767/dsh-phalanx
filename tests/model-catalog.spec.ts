import { describe, expect, it } from 'vitest'
import { modelCatalogJson } from '../src/domain/model-catalog.js'

describe('platform model catalog', () => {
  it('lists exactly the allowed model and keeps known DeepSeek metadata without tool updates', () => {
    const [flash, ...rest] = JSON.parse(modelCatalogJson('deepseek-flash')) as Array<Record<string, unknown>>
    expect(rest).toEqual([])
    expect(flash).toEqual({ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' })
    expect(flash).not.toHaveProperty('toolUpdate')
  })

  it('gives an unknown allowed model an id-only entry', () => {
    expect(JSON.parse(modelCatalogJson('deepseek-chat'))).toEqual([{ id: 'deepseek-chat' }])
  })
})
