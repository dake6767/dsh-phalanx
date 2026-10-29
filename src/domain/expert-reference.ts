export interface ExpertReferenceTarget {
  readonly kind: 'skill' | 'pack' | 'plugin' | 'mcp'
  readonly name: string
}
export interface ExpertReferenceImpact {
  readonly experts: readonly { readonly id: string; readonly name: string }[]
  readonly revision: string
}
