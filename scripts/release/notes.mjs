import { api } from './process.mjs'

export function formalReleaseNotes(repo, version) {
  const repository = api(`repos/${repo}`)
  const file = api(`repos/${repo}/contents/releases/notes/${version}.md?ref=${encodeURIComponent(repository.default_branch)}`)
  if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('Release notes are unavailable')
  const notes = Buffer.from(file.content, 'base64').toString('utf8')
  if (!notes.trim() || notes.match(/^#\s+v?(\d+\.\d+\.\d+)\s*$/mu)?.[1] !== version) throw new Error('Release notes are empty or have a different version')
  const base = `https://github.com/${repo}/blob/v${version}/releases/notes/${version}.md`
  const destination = value => /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(value) ? value : new URL(value, base).href
  const link = (_match, prefix, angle, bare) => prefix + (angle === undefined ? destination(bare) : `<${destination(angle)}>`)
  const linked = notes.replace(/(\]\()(?:<([^>\n]+)>|([^\s)]+))(?=[\s)])/gu, link)
    .replace(/^(\s*\[[^\]]+\]:\s*)(?:<([^>\n]+)>|(\S+))/gmu, link)
  return `${linked.trimEnd()}\n\n本发布由已验收候选直接提升，未重新构建；校验见 release.json、acceptance.md。\n`
}
