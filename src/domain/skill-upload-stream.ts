import { SkillArchiveError } from './skill-library.js'
/** Bound uploads and release admission even when the sender stops yielding bytes. */
export async function readSkillUpload(content: AsyncIterable<Uint8Array>, signal: AbortSignal, limit: number): Promise<Buffer> {
  let length = 0; const chunks: Buffer[] = [], iterator = content[Symbol.asyncIterator]()
  try {
    while (true) {
      signal.throwIfAborted(); let abort!: () => void
      const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
      let next: IteratorResult<Uint8Array>
      try { next = await Promise.race([iterator.next(), cancelled]) } finally { signal.removeEventListener('abort', abort) }
      if (next.done) break
      signal.throwIfAborted(); length += next.value.length
      if (length > limit) throw new SkillArchiveError('skill-upload-too-large', 'The compressed skill must be at most 20 MB.')
      chunks.push(Buffer.from(next.value))
    }
    signal.throwIfAborted(); return Buffer.concat(chunks)
  } finally { if (signal.aborted) void iterator.return?.().catch(() => {}) }
}
