import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileCommunityMaintenance } from '../src/adapters/community-maintenance.js'
import { FileContributionArtifacts } from '../src/adapters/contribution-storage.js'
import { FilePluginContributionPreparation } from '../src/adapters/plugin-contribution-preparation.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('retains pending contribution archives during maintenance and collects them after the marker is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-maintenance-')),
    marker = join(root, 'maintenance'),
    maintenance = new FileCommunityMaintenance(marker),
    artifacts = new FileContributionArtifacts(join(root, 'artifacts'), [], undefined, () => !maintenance.closed()),
    payload = skillZip([{ path: 'SKILL.md', content: validSkill }])
  async function* bytes() {
    yield payload
  }
  try {
    const accepted = await artifacts.accept(bytes(), new AbortController().signal)
    await writeFile(marker, 'closed')
    await artifacts.collect([])
    expect(await artifacts.read(accepted.hash)).toEqual(payload)
    await rm(marker)
    await artifacts.collect([])
    await expect(artifacts.read(accepted.hash)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves plugin contribution trees and the internal upload carriers until maintenance ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-contribution-maintenance-')),
    marker = join(root, 'maintenance'),
    maintenance = new FileCommunityMaintenance(marker),
    dataRoot = join(root, 'data'),
    intake = join(dataRoot, 'contributions/plugin-intake/plugins'),
    tree = join(intake, 'artifacts', 'a'.repeat(128)),
    archive = join(intake, 'uploads/archives/old.tgz'),
    incoming = join(intake, 'uploads/incoming/old.tgz'),
    preparation = new FilePluginContributionPreparation(
      {
        command: process.execPath,
        args: [],
        dataRoot,
        defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'http://model.example.test' } },
      },
      undefined,
      () => !maintenance.closed(),
    )
  try {
    await mkdir(tree, { recursive: true })
    await mkdir(join(intake, 'uploads/archives'), { recursive: true })
    await mkdir(join(intake, 'uploads/incoming'), { recursive: true })
    await writeFile(join(tree, 'retained'), 'old plugin tree')
    await writeFile(archive, 'old archive')
    await writeFile(incoming, 'old upload')
    await writeFile(marker, 'closed')
    await preparation.recover([])
    expect(await readFile(join(tree, 'retained'), 'utf8')).toBe('old plugin tree')
    expect(await readFile(archive, 'utf8')).toBe('old archive')
    expect(await readFile(incoming, 'utf8')).toBe('old upload')
    await rm(marker)
    await preparation.recover([])
    expect(await readdir(join(intake, 'artifacts'))).toEqual([])
    expect(await readdir(join(intake, 'uploads/archives'))).toEqual([])
    await expect(readFile(incoming)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
