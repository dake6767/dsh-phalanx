import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
async function fixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'docs-check-')); roots.push(root)
  for (const [path, text] of Object.entries({ 'README.md': '# Product\n', 'README.zh-CN.md': '# 产品\n',
    'docs/install.md': '# Install\n', 'docs/install.zh-CN.md': '# 安装\n', ...files })) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text)
  }
  return root
}
function check(root: string) { return spawnSync(process.execPath, [resolve('scripts/check-docs.mjs'), root], { encoding: 'utf8' }) }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
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
it('checks relative files, Unicode and duplicate anchors, reference links and HTML image sources', async () => {
  const root = await fixture({ 'README.md': '# Product\n[Install](docs/install.md#prepare)\n[Again][install]\n<img src="docs/chart.svg">\n\n[install]: docs/install.md#prepare-1\n',
    'docs/install.md': '# Install\n## Prepare\n## Prepare\n## 中文说明\n<a id="stable-entry"></a>\n[中文](#中文说明) [Stable](#stable-entry)\n',
    'docs/install.zh-CN.md': '# 安装\n## 准备\n## 准备\n## 中文说明\n', 'docs/chart.svg': '<svg/>' })
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
  const root = await fixture({ 'docs/install.md': '# Install\n## Recoverable system updates\n', 'docs/install.zh-CN.md': '# 安装\n## 系统升级\n',
    'src/inbound/help.ts': 'const help = "https://github.com/dake6767/dsh-phalanx/blob/main/docs/install.md#recoverable-system-updates";',
    'admin-ui/src/help.tsx': 'const help = "https://raw.githubusercontent.com/dake6767/dsh-phalanx/main/docs/install.md#recoverable-system-updates";' })
  expect(check(root).status).toBe(0)
  await writeFile(join(root, 'docs/install.md'), '# Install\n## Renamed\n')
  expect(check(root).status).toBe(1)
  expect(check(root).stderr).toContain('src/inbound/help.ts: missing anchor')
  expect(check(root).stderr).toContain('admin-ui/src/help.tsx: missing anchor')
  await writeFile(join(root, 'src/inbound/help.ts'), 'const help = "https://github.com/dake6767/dsh-phalanx/blob/main/docs/gone.md";')
  expect(check(root).stderr).toContain('missing file docs/gone.md')
})
