import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareMemberPlaywrightBrowsers } from '../src/adapters/member-playwright-browsers.js'

it('keeps legacy browsers and shares the same prepared Chromium files across references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'member-browser-test-'))
  try {
    const sources = join(root, 'dependencies')
    const browser = async (id: string, revision: string) => {
      const directory = join(sources, id)
      const child = join(directory, 'chromium_headless_shell-' + revision)
      await mkdir(child, { recursive: true })
      await writeFile(join(child, 'chrome-headless-shell'), revision)
      return { directory, mountedDirectory: '/dsh-phalanx/runtime-dependencies/' + id }
    }
    const legacy = await browser('original', '1217')
    const extra = await browser('extra', '1248')
    await writeFile(join(legacy.directory, 'legacy-launcher'), 'preserved')
    const plans = [
      legacy,
      { ...legacy, packageName: 'share', chromiumBuild: '1217', directories: ['chromium_headless_shell-1217'] },
      { ...extra, packageName: 'extra', chromiumBuild: '1248', directories: ['chromium_headless_shell-1248'] },
    ]
    const host = await prepareMemberPlaywrightBrowsers(root, false, legacy.directory, plans)
    expect(host?.volumes).toEqual([])
    expect(await readdir(host!.path)).toEqual(['chromium_headless_shell-1217', 'chromium_headless_shell-1248', 'legacy-launcher'])
    expect(await readFile(join(host!.path, 'legacy-launcher'), 'utf8')).toBe('preserved')
    expect(await readFile(join(host!.path, 'chromium_headless_shell-1248/chrome-headless-shell'), 'utf8')).toBe('1248')
    const mounted = await prepareMemberPlaywrightBrowsers(root, true, legacy.mountedDirectory, plans)
    expect(mounted?.volumes).toHaveLength(1)
    expect(await readlink(join(mounted!.volumes[0]!.host, 'chromium_headless_shell-1217'))).toBe(legacy.mountedDirectory + '/chromium_headless_shell-1217')
    expect(await prepareMemberPlaywrightBrowsers(root, true, legacy.mountedDirectory, [...plans, plans[2]!])).toEqual(mounted)
    expect(await prepareMemberPlaywrightBrowsers(root, true, '/operator/cache', plans)).toBeUndefined()
    expect(await prepareMemberPlaywrightBrowsers(root, true, legacy.mountedDirectory, [legacy])).toBeUndefined()
    const conflicting = await browser('conflicting', '1248')
    const failures: string[] = []
    expect(
      await prepareMemberPlaywrightBrowsers(
        root,
        true,
        legacy.mountedDirectory,
        [
          ...plans,
          { ...conflicting, packageName: 'conflicting', chromiumBuild: '1248', directories: ['chromium_headless_shell-1248'] },
          { ...legacy, packageName: 'missing', chromiumBuild: '9999', directories: ['chromium_headless_shell-9999'] },
        ],
        (name: string) => failures.push(name),
      ),
    ).toEqual(mounted)
    expect(failures).toEqual(['conflicting', 'missing'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
