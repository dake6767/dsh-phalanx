import { expect, it } from 'vitest'
import { htmlPreviewDocument } from '../src/dsh/community-html-preview.js'

it('decodes complete HTML without rewriting its scripts and rejects malformed UTF-8', () => {
  const source = '<!doctype html><title>中文</title><button onclick="this.textContent=42">Run</button>'
  const document = htmlPreviewDocument(new TextEncoder().encode(source))
  expect(document.endsWith(source)).toBe(true)
  expect(() => htmlPreviewDocument(new Uint8Array([0xff]))).toThrow()
})

it('releases renderer and metadata together when the preview dependency is replaced', async () => {
  const { runInNewContext } = await import('node:vm')
  const { htmlPreviewClient } = await import('../src/dsh/community-html-preview.js')
  const active = new Set<string>()
  let attach!: (scope: object) => void
  const locale = { register: () => () => {}, bind: () => () => '' }
  const ctx = {
    inject: (_names: string[], register: typeof attach) => {
      attach = register
    },
    locale,
    slots: {
      register: () => {
        throw Error('Renderer escaped its dependency lifetime')
      },
    },
  }
  runInNewContext(htmlPreviewClient, { ctx, React: {}, isolated: (run: () => void) => run(), ModuleBoundary: class {}, h: () => null })
  const mount = () => {
    const cleanup: (() => void)[] = []
    const register = (key: string) => {
      expect(active.has(key)).toBe(false)
      active.add(key)
      return () => active.delete(key)
    }
    attach({
      effect: (run: () => () => void) => cleanup.push(run()),
      documentPreviews: { register: () => register('metadata') },
      slots: { inject: (_name: string, run: () => () => void) => cleanup.push(run()), register: () => register('renderer') },
    })
    return () => {
      for (const dispose of cleanup.reverse()) dispose()
    }
  }
  const dispose = mount()
  expect([...active]).toEqual(['metadata', 'renderer'])
  dispose()
  expect(active.size).toBe(0)
  const disposeReplacement = mount()
  expect(active.size).toBe(2)
  disposeReplacement()
  expect(active.size).toBe(0)
})
