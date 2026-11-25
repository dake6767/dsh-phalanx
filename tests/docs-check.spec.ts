import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'

const BILINGUAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['README.md', 'README.zh-CN.md'],
  ['docs/install.md', 'docs/install.zh-CN.md'],
  ['docs/operations.md', 'docs/operations.zh-CN.md'],
  ['docs/admin-guide.md', 'docs/admin-guide.zh-CN.md'],
  ['docs/member-guide.md', 'docs/member-guide.zh-CN.md'],
  ['docs/plugin-access.md', 'docs/plugin-access.zh-CN.md'],
  ['docs/skill-execution.md', 'docs/skill-execution.zh-CN.md'],
]

const roots: string[] = []
async function fixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-'))
  roots.push(root)
  const defaults = Object.fromEntries(
    BILINGUAL_PAIRS.flatMap(([english, chinese]) => [
      [english, '# Title\n'],
      [chinese, '# 标题\n'],
    ]),
  )
  for (const [path, text] of Object.entries({
    ...defaults,
    'README.md': '# Product\n',
    'README.zh-CN.md': '# 产品\n',
    'docs/install.md': '# Install\n',
    'docs/install.zh-CN.md': '# 安装\n',
    ...files,
  })) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}
function check(root: string) {
  return spawnSync(process.execPath, [resolve('scripts/check-docs.mjs'), root], { encoding: 'utf8' })
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('allows release history but rejects version narration elsewhere', async () => {
  const root = await fixture({ 'releases/notes/0.1.5.md': '# Changes in v0.1.5\n', 'README.md': '# Product\nUse vX.Y.Z.\n' })
  expect(check(root).status).toBe(0)
  await writeFile(join(root, 'README.md'), '# Product\nNew in v0.1.5.\n')
  expect(check(root).status).toBe(1)
  expect(check(root).stderr).toContain('README.md: version')
})
it('requires both translations to have the same heading levels and count', async () => {
  const root = await fixture({ 'README.md': '# Product\n## Start\n```md\n### Example only\n```\n', 'README.zh-CN.md': '# 产品\n## 开始\n' })
  expect(check(root).status).toBe(0)
  await writeFile(join(root, 'README.zh-CN.md'), '# 产品\n### 开始\n')
  expect(check(root).status).toBe(1)
  expect(check(root).stderr).toContain('heading structure')
  await rm(join(root, 'README.zh-CN.md'))
  expect(check(root).status).toBe(1)
})
it('requires all seven bilingual guide pairs to exist with matching heading levels and counts', async () => {
  for (const [english, chinese] of BILINGUAL_PAIRS) {
    const root = await fixture({
      [english]: '# Guide\n## Section\n### Detail\n',
      [chinese]: '# 指南\n## 章节\n### 详情\n',
    })
    expect(check(root).status, `${english} baseline`).toBe(0)
    await writeFile(join(root, chinese), '# 指南\n## 章节\n## 详情\n')
    const levelMismatch = check(root)
    expect(levelMismatch.status, `${english} heading level mismatch`).toBe(1)
    expect(levelMismatch.stderr).toContain(`${english}: heading structure differs from ${chinese}`)
    await writeFile(join(root, chinese), '# 指南\n## 章节\n')
    const countMismatch = check(root)
    expect(countMismatch.status, `${english} heading count mismatch`).toBe(1)
    expect(countMismatch.stderr).toContain(`${english}: heading structure differs from ${chinese}`)
    await rm(join(root, chinese))
    const missingChinese = check(root)
    expect(missingChinese.status, `${english} missing Chinese pair`).toBe(1)
    expect(missingChinese.stderr).toContain(`${english}: missing paired document ${chinese}`)
    await writeFile(join(root, chinese), '# 指南\n## 章节\n### 详情\n')
    await rm(join(root, english))
    const missingEnglish = check(root)
    expect(missingEnglish.status, `${english} missing English pair`).toBe(1)
    expect(missingEnglish.stderr).toContain(`${english}: missing paired document ${chinese}`)
  }
})

it('checks relative files, Unicode and duplicate anchors, reference links and HTML image sources', async () => {
  const root = await fixture({
    'README.md': '# Product\n[Install](docs/install.md#prepare)\n[Again][install]\n<img src="docs/chart.svg">\n\n[install]: docs/install.md#prepare-1\n',
    'docs/install.md': '# Install\n## Prepare\n## Prepare\n## 中文说明\n<a id="stable-entry"></a>\n[中文](#中文说明) [Stable](#stable-entry)\n',
    'docs/install.zh-CN.md': '# 安装\n## 准备\n## 准备\n## 中文说明\n',
    'docs/chart.svg': '<svg/>',
  })
  expect(check(root).status).toBe(0)
  await writeFile(join(root, 'README.md'), '# Product\n[Missing](docs/install.md#missing)\n')
  expect(check(root).status).toBe(1)
  expect(check(root).stderr).toContain('missing anchor')
  await writeFile(join(root, 'README.md'), '# Product\n[Gone][target]\n\n[target]: docs/gone.md\n')
  expect(check(root).status).toBe(1)
  expect(check(root).stderr).toContain('missing file')
  await writeFile(join(root, 'README.md'), '# Product\n<picture><source srcset="docs/gone.svg"></picture>\n')
  expect(check(root).status).toBe(1)
})
it('validates main-branch documentation URLs used by server and management source', async () => {
  const root = await fixture({
    'docs/install.md': '# Install\n## Recoverable system updates\n',
    'docs/install.zh-CN.md': '# 安装\n## 系统升级\n',
    'src/inbound/help.ts': 'const help = "https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates";',
    'admin-ui/src/help.tsx': 'const help = "https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/docs/install.md#recoverable-system-updates";',
  })
  expect(check(root).status).toBe(0)
  await writeFile(join(root, 'docs/install.md'), '# Install\n## Renamed\n')
  expect(check(root).status).toBe(1)
  expect(check(root).stderr).toContain('src/inbound/help.ts: missing anchor')
  expect(check(root).stderr).toContain('admin-ui/src/help.tsx: missing anchor')
  await writeFile(join(root, 'src/inbound/help.ts'), 'const help = "https://github.com/dake6767/dsh-phalanx/blob/main/docs/gone.md";')
  expect(check(root).stderr).toContain('missing file docs/gone.md')
})
