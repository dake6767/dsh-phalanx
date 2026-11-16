import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePlatformVoiceAssets } from '../src/adapters/platform-voice-assets.js'

const locked = (name: string, value: string) => ({
  name,
  sha256: createHash('sha256').update(value).digest('hex'),
  bytes: Buffer.byteLength(value),
  url: 'https://huggingface.co/example/repo/resolve/locked/' + name,
})
const files = {
  models: { int8: locked('model.int8.onnx', 'int8'), fp32: locked('model.onnx', 'fp32') },
  tokens: locked('tokens.txt', 'tokens'),
  vad: locked('silero_vad.onnx', 'vad'),
}

it('verifies assets, shares tokens and VAD, and reuses verified files on retry and precision changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-assets-'))
  const requests: string[] = []
  const progress: number[] = []
  let damaged = true
  const store = new FilePlatformVoiceAssets(
    root,
    () => 'https://mirror.example.test',
    files,
    async url => {
      const address = new URL(url)
      expect(address.hostname).toBe('mirror.example.test')
      const name = address.pathname.split('/').at(-1)!
      requests.push(name)
      const value = { 'tokens.txt': 'tokens', 'silero_vad.onnx': 'vad', 'model.int8.onnx': 'int8', 'model.onnx': damaged ? 'bad!' : 'fp32' }[name]
      return new Response(value)
    },
  )
  const install = (precision: 'int8' | 'fp32') => store.prepare(precision, bytes => progress.push(bytes), new AbortController().signal)
  try {
    const first = await install('int8')
    expect(await readFile(join(first.modelDirectory, 'model.int8.onnx'), 'utf8')).toBe('int8')
    expect(await readFile(first.vadModelPath, 'utf8')).toBe('vad')
    expect((await stat(join(first.modelDirectory, 'model.int8.onnx'))).mode & 0o777).toBe(0o444)
    expect(await store.available('int8')).toEqual(first)
    expect(progress.at(-1)).toBe(files.tokens.bytes + files.vad.bytes + files.models.int8.bytes)
    expect(requests).toHaveLength(3)
    await expect(install('fp32')).rejects.toMatchObject({ code: 'integrity' })
    expect(await store.available('fp32')).toBeUndefined()
    expect(await store.available('int8')).toEqual(first)
    damaged = false
    const second = await install('fp32')
    expect(second.vadModelPath).toBe(first.vadModelPath)
    expect(await readFile(join(second.modelDirectory, 'model.onnx'), 'utf8')).toBe('fp32')
    expect(await install('int8')).toEqual(first)
    expect(requests.filter(name => name === 'tokens.txt')).toHaveLength(1)
    expect(requests.filter(name => name === 'silero_vad.onnx')).toHaveLength(1)
    expect(requests.filter(name => name === 'model.onnx')).toHaveLength(2)
    await chmod(first.vadModelPath, 0o644)
    await writeFile(first.vadModelPath, 'bad')
    await chmod(first.vadModelPath, 0o444)
    expect(await store.available('int8')).toBeUndefined()
    expect(await install('int8')).toEqual(first)
    expect(await readFile(first.vadModelPath, 'utf8')).toBe('vad')
    await rm(join(first.modelDirectory, 'tokens.txt'))
    expect(await store.available('int8')).toBeUndefined()
    const repaired = await install('int8')
    expect(repaired.modelDirectory).not.toBe(first.modelDirectory)
    expect(await readFile(join(repaired.modelDirectory, 'tokens.txt'), 'utf8')).toBe('tokens')
    expect(requests.filter(name => name === 'tokens.txt')).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
