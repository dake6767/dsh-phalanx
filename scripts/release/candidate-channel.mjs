import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { TextDecoder } from 'node:util'
import { join } from 'node:path'
import { api } from './process.mjs'
import { compareVersions, versionParts } from './compatibility.mjs'

const repository = 'dake6767/dsh-phalanx-candidates',
  name = 'candidate-channel.json',
  endpoint = `repos/${repository}/contents/${name}`

function validateChannelIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) throw Error('Invalid candidate channel metadata')
  if (value.candidate === null) return value
  if (
    typeof value.candidate !== 'string' ||
    !/^run-[1-9]\d*$/u.test(value.candidate) ||
    typeof value.commit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(value.commit) ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.manifestSha256)
  )
    throw Error('Invalid candidate channel identity')
  versionParts(value.targetVersion)
  return value
}

function readChannelIndex(request) {
  const entries = request(`repos/${repository}/contents?ref=main`)
  if (!Array.isArray(entries)) throw Error('Invalid candidate metadata directory')
  const entry = entries.find(item => item.name === name)
  if (!entry) return {}
  const file = request(`${endpoint}?ref=main`)
  if (
    entry.type !== 'file' ||
    file.type !== 'file' ||
    file.name !== name ||
    file.path !== name ||
    file.encoding !== 'base64' ||
    typeof file.content !== 'string' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > 65536 ||
    typeof file.sha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(file.sha)
  )
    throw Error('Invalid candidate channel file')
  const bytes = Buffer.from(file.content, 'base64')
  if (bytes.length !== file.size) throw Error('Invalid candidate channel file size')
  return { sha: file.sha, value: validateChannelIndex(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
}

async function updateChannelIndex(choose, request) {
  let current = readChannelIndex(request)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-phalanx-channel-'))
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = choose(current.value)
      if (next === undefined) return { status: 'unchanged' }
      const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n')
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      const body = join(directory, 'request.json')
      await writeFile(
        body,
        JSON.stringify({
          message: 'Update candidate channel',
          branch: 'main',
          content: bytes.toString('base64'),
          ...(current.sha ? { sha: current.sha } : {}),
        }),
        { mode: 0o600 },
      )
      let response
      try {
        response = request(endpoint, ['--method', 'PUT', '--input', body])
      } catch (error) {
        const observed = readChannelIndex(request)
        if (observed.sha === current.sha) throw error
        current = observed
        continue
      }
      if (response?.content?.sha !== blob) throw Error('Published candidate channel bytes differ')
      return { status: 'updated', candidate: next.candidate, gitBlob: blob }
    }
    throw Error('Candidate channel changed concurrently; retry publication')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Publish only after the run's assets are complete; competing writers compare the content revision. */
export async function publishCandidateChannel(manifest, manifestSha256, request = api) {
  if (compareVersions(manifest.targetVersion, '0.1.27') < 0) return { status: 'legacy' }
  const next = validateChannelIndex({ schema: 1, candidate: manifest.tag, targetVersion: manifest.targetVersion, commit: manifest.commit, manifestSha256 })
  return updateChannelIndex(current => {
    if (current?.candidate) {
      const order = compareVersions(current.targetVersion, next.targetVersion)
      if (order > 0 || (order === 0 && BigInt(current.candidate.slice(4)) > BigInt(next.candidate.slice(4)))) return
      if (current.candidate === next.candidate) {
        if (current.commit !== next.commit || current.manifestSha256 !== next.manifestSha256) throw Error('Conflicting candidate channel identity')
        return
      }
    }
    return next
  }, request)
}

/** Remove a discovery pointer before the existing owned cleanup deletes its run. */
export async function clearCandidateChannel(manifests, request = api) {
  const selected = new Set(manifests.filter(manifest => compareVersions(manifest.targetVersion, '0.1.27') >= 0).map(manifest => manifest.tag))
  if (!selected.size) return { status: 'legacy' }
  return updateChannelIndex(current => (current?.candidate && selected.has(current.candidate) ? { schema: 1, candidate: null } : undefined), request)
}
