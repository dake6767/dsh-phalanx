import type { NpmPluginRequest } from '../domain/plugin-intake.js'
import type { PluginIdentity } from '../domain/plugin-library.js'

export interface NpmPluginSourcePort {
  resolve(input: NpmPluginRequest, signal: AbortSignal): Promise<PluginIdentity>
}

/** A public GitHub repository pinned to one commit and its source archive. */
export interface GithubPluginRevision {
  readonly repository: string
  readonly commit: string
}
export interface GithubPluginSourcePort {
  /** Resolves the default branch to its latest commit through the GitHub API prefix. */
  resolve(repository: string, signal: AbortSignal): Promise<GithubPluginRevision>
  /** Downloads that commit's source archive through the GitHub asset prefix to a new file under directory. */
  download(revision: GithubPluginRevision, directory: string, signal: AbortSignal): Promise<string>
}
/** Packs a source archive without scripts in an isolated container and returns the npm pack archive written under directory. */
export interface PluginSourcePackerPort {
  pack(
    sourceArchive: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ readonly packageName: string; readonly version: string; readonly archive: string }>
}
/** Pins and packs a GitHub source, then admits the archive exactly as an uploaded package. */
export interface GithubPluginArchivePort {
  resolve(repository: string, signal: AbortSignal): Promise<GithubPluginRevision>
  pack(revision: GithubPluginRevision, signal: AbortSignal): Promise<import('../domain/plugin-library.js').UploadedPlugin>
  discard(archive: string): Promise<void>
}
