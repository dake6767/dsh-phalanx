interface CandidateIdentity {
  readonly tag: string
  readonly targetVersion: string
  readonly commit: string
}
type ContentRequest = (endpoint: string, options?: string[]) => unknown
interface ChannelUpdate {
  readonly status: 'legacy' | 'unchanged' | 'updated'
  readonly candidate?: string | null
  readonly gitBlob?: string
}
export function publishCandidateChannel(manifest: CandidateIdentity, manifestSha256: string, request?: ContentRequest): Promise<ChannelUpdate>
export function clearCandidateChannel(manifests: readonly Pick<CandidateIdentity, 'tag' | 'targetVersion'>[], request?: ContentRequest): Promise<ChannelUpdate>
