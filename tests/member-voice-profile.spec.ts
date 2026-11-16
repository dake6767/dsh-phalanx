import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemberVoicePreference } from '../src/ports/platform-voice.js'
import { expect, it } from 'vitest'
import { prepareMemberVoiceProfile } from '../src/adapters/member-voice-profile.js'
import { nativeVoiceBundle, nativeVoiceLaunch } from '../src/dsh/native-voice.js'
import { dshWebProfilePath } from '../src/dsh/profile-layout.js'

it('offers the official bundle once, suspends it while unavailable, and preserves a native member opt-out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-profile-'))
  const home = join(root, 'home')
  const profile = dshWebProfilePath(home)
  let recorded: MemberVoicePreference | undefined
  const preference = {
    preference: async () => recorded,
    remember: async (_spaceId: string, state: MemberVoicePreference) => {
      recorded = state
    },
  }
  const project = (available: boolean) => prepareMemberVoiceProfile(home, available, 'member', preference)
  const manifest = join(profile, 'package.json')
  const read = async () => JSON.parse(await readFile(manifest, 'utf8'))
  try {
    await mkdir(profile, { recursive: true })
    expect(await project(false)).toBe(false)
    expect(await project(true)).toBe(true)
    expect((await read()).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', nativeVoiceBundle])
    const original = await read()
    await writeFile(manifest, JSON.stringify({ ...original, testMemberProperty: true }))
    expect(await project(false)).toBe(false)
    expect((await read()).dsh.profile.bundles).not.toContain(nativeVoiceBundle)
    expect(await project(true)).toBe(true)
    expect(await read()).toMatchObject({ testMemberProperty: true })
    const optedOut = await read()
    optedOut.dsh.profile.bundles = optedOut.dsh.profile.bundles.filter((name: string) => name !== nativeVoiceBundle)
    await writeFile(manifest, JSON.stringify(optedOut))
    expect(await project(false)).toBe(false)
    expect(await project(true)).toBe(false)
    expect(await read()).toEqual(optedOut)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('projects only verified platform paths into the carrier', () => {
  expect(nativeVoiceLaunch(undefined, true, '/host/member')).toMatchObject({
    volumes: [],
    rows: expect.arrayContaining([{ id: 'speech-to-text-sensevoice', disabled: true }]),
  })
  const voice = { modelDirectory: '/platform/model', vadModelPath: '/platform/vad', precision: 'int8' } as const
  expect(nativeVoiceLaunch(voice, true, '/host/member')).toEqual({
    rows: [
      {
        id: 'speech-to-text-sensevoice',
        config: {
          dataRoot: '/dsh-phalanx/home/.dsh/speech-to-text/sensevoice',
          precision: 'int8',
          modelDirectory: '/dsh-phalanx/voice/model',
          vadModelPath: '/dsh-phalanx/voice/silero_vad.onnx',
        },
      },
    ],
    volumes: [
      { host: '/platform/model', mounted: '/dsh-phalanx/voice/model' },
      { host: '/platform/vad', mounted: '/dsh-phalanx/voice/silero_vad.onnx' },
    ],
  })
})
