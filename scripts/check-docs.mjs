#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
const ignored = new Set(['.git', 'node_modules', 'dist', '.data', '.scratch', '.archify', '.runtime', 'coverage', 'playwright-report', 'test-results'])
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.filter(entry => !ignored.has(entry.name)).map(async entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? await files(path) : entry.isFile() ? [path] : []
  }))).flat()
}
const inventory = await files(root)
const documents = new Map(await Promise.all(inventory.filter(path => path.endsWith('.md')).map(async path => [relative(root, path), await readFile(path, 'utf8')])))
const errors = []
for (const [path, text] of documents) {
  if (!path.startsWith('releases/') && /\bv?0\.1\.\d+\b/u.test(text)) errors.push(`${path}: version narration belongs in releases/`)
}
function prose(text) {
  let fence
  return text.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker && !fence) { fence = marker; return '' }
    if (fence) { if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined; return '' }
    return line
  }).join('\n')
}
function headings(text) { return [...prose(text).matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gmu)].map(match => ({ level: match[1].length, text: match[2] })) }
for (const [english, chinese] of [['README.md', 'README.zh-CN.md'], ['docs/install.md', 'docs/install.zh-CN.md']]) {
  if (!documents.has(english) || !documents.has(chinese)) errors.push(`${english}: missing paired document ${chinese}`)
  else if (JSON.stringify(headings(documents.get(english)).map(item => item.level)) !== JSON.stringify(headings(documents.get(chinese)).map(item => item.level))) errors.push(`${english}: heading structure differs from ${chinese}`)
}
function anchors(text) {
  const result = new Set()
  for (const heading of headings(text)) {
    const base = heading.text.toLowerCase().replace(/<[^>]*>/gu, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/gu, '-')
    let anchor = base; let duplicate = 0
    while (result.has(anchor)) anchor = `${base}-${++duplicate}`
    result.add(anchor)
  }
  for (const match of prose(text).matchAll(/\b(?:id|name)=["']([^"']+)["']/gu)) result.add(match[1])
  return result
}
async function link(from, target, fromRoot = false) {
  if (/^(?:[a-z][\w+.-]*:|\/\/)/iu.test(target)) return
  let decoded
  try { decoded = decodeURIComponent(target) } catch { errors.push(`${from}: invalid link ${target}`); return }
  const [path, anchor] = decoded.split('#')
  const destination = resolve(fromRoot ? root : dirname(join(root, from)), path.split('?')[0] || '.')
  const file = path ? destination : join(root, from)
  const local = relative(root, file)
  if (local.startsWith('..') || !(await stat(file).catch(() => undefined))) { errors.push(`${from}: missing file ${target}`); return }
  if (anchor && documents.has(local) && !anchors(documents.get(local)).has(anchor)) errors.push(`${from}: missing anchor ${target}`)
}
for (const [path, text] of documents) {
  const content = prose(text)
  for (const match of content.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu)) await link(path, match[1] ?? match[2])
  for (const match of content.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gmu)) await link(path, match[1])
  for (const match of content.matchAll(/\b(?:src|srcset|href)=["']([^"']+)["']/gu)) {
    for (const source of match[1].split(',')) await link(path, source.trim().split(/\s/u)[0])
  }
}
for (const path of inventory.filter(path => /^(?:src|admin-ui\/src)\//u.test(relative(root, path)) && /\.[cm]?[jt]sx?$/u.test(path))) {
  const text = await readFile(path, 'utf8')
  for (const match of text.matchAll(/https:\/\/(?:github\.com\/dake6767\/dsh-phalanx\/blob\/main\/|raw\.githubusercontent\.com\/dake6767\/dsh-phalanx\/main\/)([^\s"'`<>]+)/gu)) await link(relative(root, path), match[1], true)
}
if (errors.length) { process.stderr.write(`${errors.join('\n')}\n`); process.exitCode = 1 }
else process.stdout.write(`Documentation checks passed (${documents.size} Markdown files).\n`)
