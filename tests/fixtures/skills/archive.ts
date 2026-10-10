import { crc32, deflateRawSync } from 'node:zlib'

/** Independent ZIP fixture writer with explicit names and Unix entry modes. */
export function skillZip(files: readonly { path: string, content: string | Buffer, mode?: number }[]): Buffer {
  const local: Buffer[] = []; const directory: Buffer[] = []; let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path); const raw = Buffer.from(file.content); const data = deflateRawSync(raw)
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); header.copy(central, 6, 4, 30)
    central.writeUInt32LE(((file.mode ?? 0o100644) * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42)
    local.push(header, name, data); directory.push(central, name); offset += header.length + name.length + data.length
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(Buffer.concat(directory).length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...directory, end])
}
export const validSkill = '---\nname: example-skill\ndescription: A useful skill\n---\n# Example\nRun scripts/example.py.\n'
