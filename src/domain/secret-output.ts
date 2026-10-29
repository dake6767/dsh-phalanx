interface Pattern {
  readonly bytes: Uint8Array
  readonly failure: Int32Array
  state: number
}
/** Incremental prefix matching keeps work independent of secret length per output byte. */
export function secretOutputRedactor(values: readonly string[]): { write(bytes: Uint8Array, final?: boolean): Uint8Array; flush(): Uint8Array } {
  // Anonymous expression keeps serialization independent of transpiler class-name helpers.
  return new (class {
    private readonly patterns: readonly Pattern[]
    private chunks: { readonly bytes: Uint8Array; offset: number }[] = []
    private chunkHead = 0
    private ranges: [number, number][] = []
    private rangeHead = 0
    private processed = 0
    private position = 0
    private readonly replacement = new TextEncoder().encode('[redacted]')
    constructor(values: readonly string[]) {
      const representations = values.filter(Boolean).flatMap(value => {
        let encoded = value
        try {
          encoded = encodeURIComponent(value)
        } catch {
          /* UTF-8 and JSON cover isolated surrogates. */
        }
        const json = JSON.stringify(value).slice(1, -1)
        return [value, json, json.replaceAll('/', '\\/'), encoded]
      })
      this.patterns = [...new Set(representations)].map(value => {
        const bytes = new TextEncoder().encode(value),
          failure = new Int32Array(bytes.length)
        for (let index = 1, prefix = 0; index < bytes.length; index++) {
          while (prefix && bytes[index] !== bytes[prefix]) prefix = failure[prefix - 1]!
          if (bytes[index] === bytes[prefix]) prefix++
          failure[index] = prefix
        }
        return { bytes, failure, state: 0 }
      })
    }
    write(bytes: Uint8Array, final = false): Uint8Array {
      if (!this.patterns.length) return bytes
      if (bytes.length) this.chunks.push({ bytes: bytes.slice(), offset: 0 })
      for (const byte of bytes) {
        this.processed++
        let matched = 0
        for (const pattern of this.patterns) {
          while (pattern.state && byte !== pattern.bytes[pattern.state]) pattern.state = pattern.failure[pattern.state - 1]!
          if (byte === pattern.bytes[pattern.state]) pattern.state++
          if (pattern.state === pattern.bytes.length) {
            matched = Math.max(matched, pattern.state)
            pattern.state = pattern.failure[pattern.state - 1]!
          }
        }
        if (matched) {
          let start = Math.max(this.position, this.processed - matched)
          while (this.ranges.length > this.rangeHead && this.ranges.at(-1)![1] >= start) start = Math.min(start, this.ranges.pop()![0])
          this.ranges.push([start, this.processed])
        }
      }
      let end = Math.max(this.position, final ? this.processed : this.processed - Math.max(0, ...this.patterns.map(pattern => pattern.state)))
      // Already matched bytes can be released even when they overlap another active prefix.
      for (let index = this.rangeHead; index < this.ranges.length && this.ranges[index]![0] <= end; index++) end = Math.max(end, this.ranges[index]![1])
      const pieces: Uint8Array[] = []
      while (this.position < end) {
        const range = this.ranges[this.rangeHead]
        if (range && range[0] <= this.position) {
          this.consume(Math.min(end, range[1]), pieces, false)
          pieces.push(this.replacement)
          this.rangeHead++
        } else this.consume(Math.min(end, range?.[0] ?? end), pieces, true)
      }
      if (this.chunkHead === this.chunks.length || (this.chunkHead > 1024 && this.chunkHead > this.chunks.length / 2)) {
        this.chunks = this.chunks.slice(this.chunkHead)
        this.chunkHead = 0
      }
      if (this.rangeHead === this.ranges.length || (this.rangeHead > 1024 && this.rangeHead > this.ranges.length / 2)) {
        this.ranges = this.ranges.slice(this.rangeHead)
        this.rangeHead = 0
      }
      if (final) for (const pattern of this.patterns) pattern.state = 0
      const result = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0))
      let offset = 0
      for (const piece of pieces) {
        result.set(piece, offset)
        offset += piece.length
      }
      return result
    }
    flush(): Uint8Array {
      return this.write(new Uint8Array(), true)
    }
    private consume(end: number, pieces: Uint8Array[], visible: boolean): void {
      while (this.position < end) {
        const chunk = this.chunks[this.chunkHead]!,
          count = Math.min(end - this.position, chunk.bytes.length - chunk.offset)
        if (visible) pieces.push(chunk.bytes.subarray(chunk.offset, chunk.offset + count))
        chunk.offset += count
        this.position += count
        if (chunk.offset === chunk.bytes.length) this.chunkHead++
      }
    }
  })(values)
}
