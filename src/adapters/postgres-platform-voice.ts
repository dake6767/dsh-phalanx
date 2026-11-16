import type { PlatformVoiceSettingsChange } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { MemberVoicePreference, MemberVoicePreferencesPort, PlatformVoiceState, PlatformVoiceStore } from '../ports/platform-voice.js'
import type { PlatformDatabase } from './platform-database.js'

type Row = Omit<PlatformVoiceState, 'revision' | 'failure' | 'activePrecision'> & {
  revision: string
  active_precision: PlatformVoiceState['activePrecision']
  issue_code: NonNullable<PlatformVoiceState['failure']> | null
}
const columns = 'revision,enabled,precision,active_precision,status,failure AS issue_code'
function state(row: Row): PlatformVoiceState {
  return {
    revision: Number(row.revision),
    enabled: row.enabled,
    precision: row.precision,
    activePrecision: row.active_precision,
    status: row.status,
    ...(row.issue_code === null ? {} : { failure: row.issue_code }),
  }
}

export class PostgresPlatformVoice implements PlatformVoiceStore, MemberVoicePreferencesPort {
  constructor(private readonly database: PlatformDatabase) {}

  async state() {
    const [row] = await this.database.query<Row>(`SELECT ${columns} FROM dsh_phalanx.platform_voice_settings WHERE id=1`)
    return state(row!)
  }

  async save({ revision, enabled, precision }: PlatformVoiceSettingsChange) {
    const [row] = await this.database.query<Row>(
      `UPDATE dsh_phalanx.platform_voice_settings
       SET revision=revision+1,enabled=$2,precision=$3,status=CASE WHEN $2 THEN 'preparing' ELSE 'off' END,
           active_precision=CASE WHEN $2 THEN active_precision ELSE NULL END,failure=NULL
       WHERE id=1 AND revision=$1 RETURNING ${columns}`,
      [revision, enabled, precision],
    )
    if (!row) throw new BusinessRuleError('conflict', 'Platform voice settings changed. Reload before saving.', 'platform-configuration-conflict')
    return state(row)
  }

  async preference(spaceId: string): Promise<MemberVoicePreference | undefined> {
    const [row] = await this.database.query<{ state: MemberVoicePreference }>('SELECT state FROM dsh_phalanx.member_voice_preferences WHERE space_id=$1', [
      spaceId,
    ])
    return row?.state
  }

  async remember(spaceId: string, state: MemberVoicePreference): Promise<void> {
    await this.database.query(
      'INSERT INTO dsh_phalanx.member_voice_preferences (space_id,state) VALUES($1,$2) ON CONFLICT(space_id) DO UPDATE SET state=excluded.state',
      [spaceId, state],
    )
  }

  async settle(revision: number, result: { readonly ready: true } | { readonly failure: NonNullable<PlatformVoiceState['failure']> }): Promise<void> {
    const ready = 'ready' in result
    await this.database.query(
      `UPDATE dsh_phalanx.platform_voice_settings
       SET status=$2,active_precision=CASE WHEN $2='ready' THEN precision ELSE active_precision END,failure=$3
       WHERE id=1 AND revision=$1 AND status='preparing'`,
      [revision, ready ? 'ready' : 'failed', ready ? null : result.failure],
    )
  }
}
