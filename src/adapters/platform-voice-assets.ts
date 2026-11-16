import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PlatformVoicePrecision } from '../domain/admin-contract.js'
import { PlatformVoicePreparationError } from '../domain/platform-voice.js'
import { voiceAssets, type VoiceAsset, type VoiceAssetLock } from '../dsh/voice-assets.js'
import type { PlatformVoiceAssetsPort, PreparedVoice } from '../ports/platform-voice.js'

/** Store blobs by SHA-256, and publish one read-only model directory per verified model/token pair. */
export class FilePlatformVoiceAssets implements PlatformVoiceAssetsPort {
  private readonly verified = new Map<string, string>()
  constructor(
    private readonly root: string,
    private readonly origin: () => string,
    private readonly lock: VoiceAssetLock = voiceAssets,
    private readonly request: (url: URL, init: RequestInit) => Promise<Response> = fetch,
  ) {}

  bytes(precision: PlatformVoicePrecision): number {
    return this.files(precision).reduce((total, file) => total + file.bytes, 0)
  }

  async available(precision: PlatformVoicePrecision): Promise<PreparedVoice | undefined> {
    const [tokens, vad, model] = this.files(precision)
    const modelDirectory = await this.modelDirectory(model, tokens)
    if (!modelDirectory) return undefined
    const vadModelPath = this.blob(vad)
    const facts = await Promise.all([
      this.linked(join(modelDirectory, model.name), model),
      this.linked(join(modelDirectory, tokens.name), tokens),
      this.verify(vadModelPath, vad),
    ])
    if (facts.every(Boolean)) return { precision, modelDirectory, vadModelPath }
    return undefined
  }

  async prepare(precision: PlatformVoicePrecision, progress: (received: number) => void, signal: AbortSignal): Promise<PreparedVoice> {
    try {
      let received = 0
      const [tokens, vad, model] = this.files(precision)
      const origin = this.origin()
      for (const file of [tokens, vad, model]) {
        await this.prepareBlob(file, origin, bytes => progress(received + bytes), signal)
        received += file.bytes
        progress(received)
      }
      signal.throwIfAborted()
      await this.publishModel(model, tokens)
      const prepared = await this.available(precision)
      if (!prepared) throw new PlatformVoicePreparationError('storage')
      return prepared
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof PlatformVoicePreparationError) throw error
      throw new PlatformVoicePreparationError('storage', { cause: error })
    }
  }

  private files(precision: PlatformVoicePrecision) {
    return [this.lock.tokens, this.lock.vad, this.lock.models[precision]] as const
  }

  private blob(file: VoiceAsset) {
    return join(this.root, 'blobs', file.sha256)
  }

  private async published(path: string, file: VoiceAsset): Promise<boolean> {
    try {
      const info = await lstat(path)
      return info.isFile() && info.size === file.bytes && (info.mode & 0o222) === 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async linked(path: string, asset: VoiceAsset): Promise<boolean> {
    if (!(await this.published(path, asset)) || !(await this.verify(this.blob(asset), asset))) return false
    const [entry, blob] = await Promise.all([lstat(path), lstat(this.blob(asset))])
    return entry.ino === blob.ino && entry.dev === blob.dev
  }

  private async verify(path: string, file: VoiceAsset, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    if (!(await this.published(path, file))) return false
    const evidence = async () => {
      const info = await lstat(path, { bigint: true })
      return [info.dev, info.ino, info.ctimeNs, info.mtimeNs, info.size, info.mode].join(':')
    }
    const before = await evidence()
    if (this.verified.get(path) === before) return true
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
    if (digest.digest('hex') !== file.sha256 || (await evidence()) !== before) return false
    this.verified.set(path, before)
    return true
  }

  private async prepareBlob(file: VoiceAsset, origin: string, progress: (bytes: number) => void, signal: AbortSignal): Promise<void> {
    const target = this.blob(file)
    if (await this.verify(target, file, signal)) return
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    const stage = target + '.partial-' + randomUUID()
    try {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(60 * 60 * 1000)])
      const address = new URL(new URL(file.url).pathname, origin)
      const response = await this.request(address, { signal: timeout }).catch(cause => {
        throw new PlatformVoicePreparationError('download', { cause })
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new PlatformVoicePreparationError('download')
      }
      const hash = createHash('sha256')
      let bytes = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > file.bytes) {
            callback(new PlatformVoicePreparationError('integrity'))
            return
          }
          hash.update(chunk)
          progress(bytes)
          callback(null, chunk)
        },
      })
      const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      await pipeline(stream, meter, createWriteStream(stage, { flags: 'wx', mode: 0o600 }), { signal: timeout }).catch(cause => {
        if (cause instanceof PlatformVoicePreparationError) throw cause
        const code = (cause as NodeJS.ErrnoException).code
        throw new PlatformVoicePreparationError(code && ['ENOSPC', 'EACCES', 'EROFS', 'EIO'].includes(code) ? 'storage' : 'download', { cause })
      })
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new PlatformVoicePreparationError('integrity')
      signal.throwIfAborted()
      await chmod(stage, 0o444)
      await rename(stage, target)
    } finally {
      await rm(stage, { force: true })
    }
  }

  private modelPointer(model: VoiceAsset, tokens: VoiceAsset) {
    return join(this.root, 'models', model.sha256 + '-' + tokens.sha256)
  }

  private async modelDirectory(model: VoiceAsset, tokens: VoiceAsset): Promise<string | undefined> {
    const pointer = this.modelPointer(model, tokens)
    let generation: string
    try {
      generation = (await readFile(pointer + '.current', 'utf8')).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return /^[a-f0-9-]{36}$/u.test(generation) ? pointer + '-' + generation : undefined
  }

  private async publishModel(model: VoiceAsset, tokens: VoiceAsset): Promise<void> {
    const previous = await this.modelDirectory(model, tokens)
    if (previous && (await this.linked(join(previous, model.name), model)) && (await this.linked(join(previous, tokens.name), tokens))) return
    const pointer = this.modelPointer(model, tokens)
    const generation = randomUUID()
    const directory = pointer + '-' + generation
    await mkdir(dirname(directory), { recursive: true, mode: 0o755 })
    const stage = directory + '.partial-' + randomUUID()
    const next = pointer + '.partial-' + generation
    await mkdir(stage, { mode: 0o755 })
    let published = false
    try {
      await link(this.blob(model), join(stage, model.name))
      await link(this.blob(tokens), join(stage, tokens.name))
      await rename(stage, directory)
      await writeFile(next, generation, { mode: 0o600, flag: 'wx' })
      await rename(next, pointer + '.current')
      published = true
    } finally {
      await rm(next, { force: true })
      await rm(stage, { recursive: true, force: true })
      if (!published) await rm(directory, { recursive: true, force: true })
    }
  }
}
