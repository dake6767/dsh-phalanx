import { appendFileSync } from 'node:fs'

/** Register test applications that deliberately start their own session. */
export function registerValidationProcessGroup(pid: number | undefined): void {
  const path = process.env.DSH_PHALANX_PROCESS_GROUPS_FILE
  if (path && pid !== undefined) appendFileSync(path, JSON.stringify({ pid }) + '\n')
}
