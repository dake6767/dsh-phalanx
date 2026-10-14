/** Durable completion marker written atomically by each configuration owner. */
export interface ContributionReceipt { readonly id: string, readonly revision: string, readonly warnings?: readonly string[] }
export const sameContributionReceipt = (left: ContributionReceipt | undefined, right: ContributionReceipt) => left?.id === right.id && left.revision === right.revision
