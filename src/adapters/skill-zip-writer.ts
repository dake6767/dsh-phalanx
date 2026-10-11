import { crc32 } from 'node:zlib'
import type { SkillImportFile } from './skill-import.js'

/** Deterministic stored ZIP for already validated files; no shell or temporary extraction. */
export function skillFileArchive(files: readonly SkillImportFile[]): Buffer {
  const entries: Buffer[] = [], index: Buffer[] = []; let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path), header = Buffer.alloc(30), central = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt32LE(crc32(file.bytes), 14); header.writeUInt32LE(file.bytes.length, 18); header.writeUInt32LE(file.bytes.length, 22); header.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); header.copy(central, 6, 4, 30)
    central.writeUInt32LE((0o100555 * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42)
    entries.push(header, name, file.bytes); index.push(central, name); offset += header.length + name.length + file.bytes.length
  }
  const directory = Buffer.concat(index), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...entries, directory, end])
}
