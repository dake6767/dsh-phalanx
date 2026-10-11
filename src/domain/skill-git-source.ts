import { SkillArchiveError } from './skill-library.js'

export interface SkillGitTarget { readonly url: string, readonly subpath: string, readonly ref: string, readonly tree?: string }
export interface SkillGitSource extends SkillGitTarget { readonly path: string, readonly commit: string, readonly contentHash: string }
const invalid = (reason: string) => new SkillArchiveError('skill-archive-invalid', reason)

/** Public repository syntax only; credentials and local/alternate transports are not accepted. */
export function parseSkillGitSource(input: string): SkillGitTarget {
  const value = input.trim()
  if (!value || value.length > 2048 || /[\s\\]/u.test(value)) throw invalid('Enter a public HTTPS Git repository or owner/repo.')
  const parts = value.split('#')
  if (parts.length > 2) throw invalid('Use only one #ref suffix.')
  let ref = parts[1] ?? '', path = parts[0]!, subpath = '', tree: string | undefined
  if (!path.includes('://')) {
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+(?:\/[^?#]+)?$/u.test(path)) throw invalid('SSH and local paths are unsupported. Use a public HTTPS Git repository.')
    path = 'https://github.com/' + path
  }
  let url: URL
  try { url = new URL(path) } catch { throw invalid('Enter a valid public HTTPS Git repository.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search) throw invalid('Only public HTTPS Git repositories without credentials or query parameters are supported.')
  if (!url.hostname.includes('.') || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost') || /^[\d.[\]:]+$/u.test(url.hostname) || url.hostname.toLowerCase().includes('skillhub')) throw invalid('Local hosts and skillhub API sources are unsupported. Use a public Git repository.')
  let segments: string[]
  try { segments = path.slice(path.indexOf('://') + 3).replace(/^[^/]*/u, '').split('/').filter(Boolean).map(part => decodeURIComponent(part)) } catch { throw invalid('The repository path is invalid.') }
  if (segments.flatMap(part => part.split('/')).some(part => part === '.' || part === '..' || part === '.well-known' || /[\\:]/u.test(part) || [...part].some(char => char.charCodeAt(0) < 32))) throw invalid('Repository paths must stay inside the source. Well-known sources are unsupported.')
  if (url.hostname === 'github.com') {
    if (segments.length < 2) throw invalid('Specify a GitHub owner and repository.')
    const [owner, repo, ...tail] = segments
    if (tail[0] === 'tree') {
      if (!tail[1]) throw invalid('A GitHub tree URL requires a ref.')
      tree = tail.slice(1).join('/')
      if (ref) { subpath = tree.startsWith(ref + '/') ? tree.slice(ref.length + 1) : tail.slice(2).join('/'); tree = undefined }
      else { ref = tail[1]; subpath = tail.slice(2).join('/'); if (ref.includes('/') || /^[a-f0-9]{40,64}$/iu.test(ref)) tree = undefined }
    } else subpath = tail.join('/')
    url.pathname = `/${owner}/${repo!.replace(/\.git$/u, '')}.git`
  }
  if (ref && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.includes('//'))) throw invalid('The Git ref is invalid.')
  return { url: url.href.replace(/\/$/u, ''), subpath, ref, ...(tree ? { tree } : {}) }
}
