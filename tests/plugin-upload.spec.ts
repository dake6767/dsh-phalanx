import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginUpload } from '../src/adapters/plugin-upload.js'
import { PLUGIN_UPLOAD_MAX_BYTES } from '../src/domain/plugin-library.js'

it('streams opaque bytes, limits size, and removes rejected or interrupted incoming files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-upload-'))
  let inspections = 0
  const upload = new FilePluginUpload(root, { inspect: async archive => {
    inspections++; expect(await readFile(archive)).toEqual(Buffer.from([1, 2, 3]))
    return { packageName: '@example/private', version: '1.0.0' }
  } })
  async function* bytes() { yield new Uint8Array([1]); yield new Uint8Array([2, 3]) }
  try {
    await expect(upload.accept('package.zip', bytes(), new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-upload-extension' })
    const accepted = await upload.accept('private.tgz', bytes(), new AbortController().signal)
    expect(accepted.packageName).toBe('@example/private')
    expect(await readFile(accepted.archive)).toEqual(Buffer.from([1, 2, 3]))
    expect(accepted.integrity).toBe('sha512-J4ZMxSGalRp6blK4yN3faYHQmNoWWNliWMhwssiN+8tRhBrqFyoouvpqeXMRZVhGdwZgRclZ7Q+ZKWiNBN78KQ==')
    async function* huge() { for (let i = 0; i <= PLUGIN_UPLOAD_MAX_BYTES / 1048576; i++) yield new Uint8Array(1048576) }
    await expect(upload.accept('large.tgz', huge(), new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-upload-too-large' })
    const controller = new AbortController()
    let opened!: () => void
    const reading = new Promise<void>(resolve => { opened = resolve })
    async function* interrupted() { yield new Uint8Array([1]); opened(); await new Promise(() => {}) }
    const pending = upload.accept('interrupted.tgz', interrupted(), controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'plugin-upload-interrupted' })
    await reading; controller.abort(); await assertion
    expect(inspections).toBe(1)
    expect(await readdir(join(root, 'plugins/uploads/incoming'))).toEqual([])
    await upload.discard(accepted.archive)
    expect(await readdir(join(root, 'plugins/uploads/archives'))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('recovers orphan archives after interrupted admission while preserving durable originals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-upload-recovery-'))
  const upload = new FilePluginUpload(root, { inspect: async () => ({ packageName: 'private-plugin', version: '1.0.0' }) })
  async function* bytes() { yield new Uint8Array([1, 2, 3]) }
  try {
    const retained = await upload.accept('retained.tgz', bytes(), new AbortController().signal)
    const orphan = await upload.accept('orphan.tgz', bytes(), new AbortController().signal)
    // Simulate a restart after rename but before library admission is durable.
    const restarted = new FilePluginUpload(root, { inspect: async () => { throw new Error('not invoked') } })
    await restarted.recover([retained.archive])
    expect(await readFile(retained.archive)).toEqual(Buffer.from([1, 2, 3]))
    await expect(readFile(orphan.archive)).rejects.toMatchObject({ code: 'ENOENT' })
    await restarted.recover([retained.archive])
    expect(await readdir(join(root, 'plugins/uploads/archives'))).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
