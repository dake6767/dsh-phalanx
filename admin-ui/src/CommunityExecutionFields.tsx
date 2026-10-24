import { Button } from '@heroui/react/button';
import { Checkbox } from '@heroui/react/checkbox';
import { TextField } from '@heroui/react/textfield';
import { TextArea } from '@heroui/react/textarea';
import { Label } from '@heroui/react/label';
import { Description } from '@heroui/react/description';
import type { CommunityExecutionInput, CommunityExecutionView } from '../../src/domain/admin-contract';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityField from './CommunityField';

type CommandDraft = { key: string; command: string; source?: string; memberPath?: string; blockedOptions?: readonly string[]; blocked: string };
type VariableDraft = { key: string; name: string; secret: boolean; configured: boolean; value?: string };
type ExecutionDraft = { commandRows: CommandDraft[]; variableRows: VariableDraft[] };
let nextRowKey = 0;
const rowKey = () => String(++nextRowKey);
const commandRow = (): CommandDraft => ({ key: rowKey(), command: '', blocked: '' });
const variableRow = (): VariableDraft => ({ key: rowKey(), name: '', secret: true, configured: false });
export function executionDraft(view: CommunityExecutionView): ExecutionDraft {
  return { commandRows: view.commands.length ? view.commands.map(row => ({ key: rowKey(), command: row.command, ...(row.source ? { source: row.source } : {}), ...(row.memberPath ? { memberPath: row.memberPath } : {}), ...(row.blockedOptions ? { blockedOptions: row.blockedOptions } : {}), blocked: row.blocked.join('\n') })) : [commandRow()],
    variableRows: view.variables.length ? view.variables.map(row => ({ ...row, key: rowKey() })) : [variableRow()] };
}
export function executionInput(draft: ExecutionDraft): Pick<CommunityExecutionInput, 'commands' | 'variables'> {
  return { commands: draft.commandRows.filter(row => row.command || row.blocked).map(({ command, source, memberPath, blockedOptions, blocked }) => ({ command, ...(source ? { source } : {}), ...(memberPath ? { memberPath } : {}), ...(blockedOptions ? { blockedOptions } : {}), blocked: blocked.split('\n').filter(Boolean) })),
    variables: draft.variableRows.filter(row => row.name || row.value).map(({ name, secret, value, configured }) => ({ name, secret, ...(value !== undefined && !(secret && configured && value === '') ? { value } : {}) })) };
}
export default function CommunityExecutionFields({ draft, onChange, busy }: { draft: ExecutionDraft; onChange: (value: ExecutionDraft) => void; busy: boolean }) {
  const { t } = usePlatformLanguage();
  const command = (index: number, change: Partial<CommandDraft>) => onChange({ ...draft, commandRows: draft.commandRows.map((row, i) => i === index ? { ...row, ...change } : row) });
  const variable = (index: number, change: Partial<VariableDraft>) => onChange({ ...draft, variableRows: draft.variableRows.map((row, i) => i === index ? { ...row, ...change } : row) });
  return <>
    <h4>{t('Delegated commands')}</h4>
    {draft.commandRows.map((row, index) => <fieldset className="plugin-access-template" key={row.key}>
      <legend>{t('Command {number}', { number: index + 1 })}</legend>
      <CommunityField label={t('Delegated command')} value={row.command} onChange={value => command(index, { command: value })} disabled={busy} description={t('Enter a command name or a script path relative to this skill.')}/>
      <TextField value={row.blocked} onChange={value => command(index, { blocked: value })} isDisabled={busy} fullWidth>
        <Label>{t('Blocked first arguments')}</Label><TextArea rows={2}/><Description>{t('One argument per line. Matching calls return the platform credential notice without running the command.')}</Description>
      </TextField>
      <div><Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => onChange({ ...draft, commandRows: draft.commandRows.filter((_, i) => i !== index) })}>{t('Remove command')}</Button></div>
    </fieldset>)}
    <div><Button variant="secondary" isDisabled={busy || draft.commandRows.length >= 32} onPress={() => onChange({ ...draft, commandRows: [...draft.commandRows, commandRow()] })}>{t('Add command')}</Button></div>
    <h4>{t('Credential variables')}</h4>
    {draft.variableRows.map((row, index) => <fieldset className="plugin-access-template" key={row.key}>
      <legend>{t('Variable {number}', { number: index + 1 })}</legend>
      <div className="plugin-environment-row">
        <CommunityField label={t('Credential variable')} value={row.name} onChange={value => variable(index, { name: value })} disabled={busy}/>
        <CommunityField label={t('Credential value')} value={row.value ?? ''} onChange={value => variable(index, { value })} disabled={busy} type={row.secret ? 'password' : 'text'} description={t(row.secret ? row.configured ? 'A credential is saved. Leave blank to keep it.' : 'Credentials are stored only by the platform and are never displayed.' : 'This value remains visible to administrators.')}/>
        <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => onChange({ ...draft, variableRows: draft.variableRows.filter((_, i) => i !== index) })}>{t('Remove variable')}</Button>
      </div>
      <Checkbox isSelected={row.secret} onChange={secret => variable(index, { secret, ...(!secret && row.secret && row.value === undefined ? { value: '' } : {}) })} isDisabled={busy}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{t('Secret value')}</Checkbox.Content>
      </Checkbox>
    </fieldset>)}
    <div><Button variant="secondary" isDisabled={busy || draft.variableRows.length >= 64} onPress={() => onChange({ ...draft, variableRows: [...draft.variableRows, variableRow()] })}>{t('Add variable')}</Button></div>
    <p>{t('Runtime variables such as PATH, HOME and interpreter startup options are reserved.')}</p>
  </>;
}
