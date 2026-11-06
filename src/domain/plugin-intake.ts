import { BusinessRuleError } from './business-error.js'
import { assertPluginIdentity, assertGithubRepository } from './plugin-library.js'

/** npm input is permissive only until resolution produces a strict library identity. */
export interface NpmPluginRequest {
  readonly packageName: string
  readonly version: string
}
/** A GitHub request names only a public repository; the default branch is pinned to a commit during precheck. */
export type PluginSourceRequest = ({ readonly kind: 'npm' } & NpmPluginRequest) | { readonly kind: 'github'; readonly repository: string }

export function pluginSourceRequest(input: string): PluginSourceRequest {
  const text = input.trim()
  if (/^(?:git(?:\+[^:]+)?:|ssh:|git@)/iu.test(text))
    throw new BusinessRuleError(
      'invalid',
      'Only GitHub repositories are supported as Git sources. Use github:owner/repo or https://github.com/owner/repo.',
      'plugin-git-url-unsupported',
    )
  if (/^https?:\/\//iu.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw invalidInput()
    }
    if (url.hostname !== 'github.com')
      throw new BusinessRuleError('invalid', 'Only npm packages and github.com repositories are supported.', 'plugin-source-host-unsupported')
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalidInput()
    if (url.search || url.hash) throw refUnsupported()
    const segments = url.pathname.replace(/\/$/u, '').split('/').slice(1)
    if (segments.length > 2) throw ['tree', 'commit', 'blob', 'releases', 'tag'].includes(segments[2]!) ? refUnsupported() : invalidInput()
    if (segments.length === 2 && segments[1]!.endsWith('.git'))
      throw new BusinessRuleError(
        'invalid',
        'Only GitHub repositories are supported as Git sources. Use github:owner/repo or https://github.com/owner/repo.',
        'plugin-git-url-unsupported',
      )
    return github(segments.join('/'))
  }
  if (/^github:/iu.test(text)) {
    const repository = text.slice('github:'.length)
    if (/[#@]/u.test(repository) || repository.split('/').length > 2) throw refUnsupported()
    return github(repository)
  }
  return { kind: 'npm', ...npmRequest(text) }
}

/** The npm-only retry path keeps the exact npm contract. */
export function npmPluginRequest(input: string): NpmPluginRequest {
  const request = pluginSourceRequest(input)
  if (request.kind !== 'npm') throw new BusinessRuleError('invalid', 'Use an npm package name, an exact version or @latest.', 'plugin-source-unsupported')
  return { packageName: request.packageName, version: request.version }
}

function github(repository: string): PluginSourceRequest {
  try {
    assertGithubRepository(repository)
  } catch {
    throw invalidInput()
  }
  return { kind: 'github', repository }
}
function npmRequest(text: string): NpmPluginRequest {
  const separator = text.lastIndexOf('@')
  const packageName = separator > 0 ? text.slice(0, separator) : text
  const version = separator > 0 ? text.slice(separator + 1) : 'latest'
  try {
    assertPluginIdentity({ packageName, version: '0.0.0' })
  } catch {
    throw invalidInput()
  }
  if (version === 'latest') return { packageName, version }
  try {
    assertPluginIdentity({ packageName, version })
    return { packageName, version }
  } catch {
    /* Classify the unsupported user form below. */
  }
  if (/^[~^<>=*]/u.test(version) || /[|\s]/u.test(version) || /^(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}$/u.test(version))
    throw new BusinessRuleError('invalid', 'Version ranges are not supported. Use an exact version or @latest.', 'plugin-version-range-unsupported')
  if (/^[a-zA-Z][a-zA-Z0-9._-]*$/u.test(version))
    throw new BusinessRuleError('invalid', 'Only the latest tag is supported. Use @latest or an exact version.', 'plugin-tag-unsupported')
  throw invalidInput()
}
function refUnsupported(): BusinessRuleError {
  return new BusinessRuleError(
    'invalid',
    'Branches, tags and commits cannot be chosen. Use github:owner/repo; the precheck pins the default branch to its latest commit.',
    'plugin-github-ref-unsupported',
  )
}
function invalidInput(): BusinessRuleError {
  return new BusinessRuleError(
    'invalid',
    'Enter a package name such as plugin, plugin@1.2.3 or @scope/plugin@latest, or a repository such as github:owner/repo.',
    'plugin-input-invalid',
  )
}
