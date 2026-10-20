import type { CommunityUsageRecords } from '../../src/domain/admin-contract.js'

/** Observe usage through the same administrator contract as the records page. */
export async function readUsageRecords(origin: string, cookie: string): Promise<CommunityUsageRecords> {
  const response = await fetch(origin + '/admin/api/usage-records', { headers: { cookie } })
  if (!response.ok) throw Error(`Usage records request failed (${response.status})`)
  return await response.json() as CommunityUsageRecords
}
