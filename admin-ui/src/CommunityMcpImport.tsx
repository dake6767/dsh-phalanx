import { useState } from 'react';
import { Button } from '@heroui/react/button';
import { TextField } from '@heroui/react/textfield';
import { TextArea } from '@heroui/react/textarea';
import { Label } from '@heroui/react/label';
import { McpImportError, parseMcpServers, type McpImportDraft } from '../../src/domain/mcp-import';
import type { CommunityMcpSettings } from '../../src/domain/admin-contract';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityDialog from './CommunityDialog';
import CommunityMessage from './CommunityMessage';
import McpEditor from './CommunityMcpEditor';
export default function McpImport({ onClose, onSaved, onRefreshed }: { onClose: () => void; onRefreshed: (row: CommunityMcpSettings) => void; onSaved: (rows: readonly CommunityMcpSettings[]) => void }) {
  const { t, errorText } = usePlatformLanguage();
  const [text, setText] = useState(''), [error, setError] = useState<unknown>();
  const [drafts, setDrafts] = useState<readonly McpImportDraft[]>(), [index, setIndex] = useState(0);
  const parse = () => { try { setDrafts(parseMcpServers(text)); setText(''); setError(undefined); } catch (failure) { setError(failure); } };
  const next = () => { if (index + 1 < (drafts?.length ?? 0)) setIndex(index + 1); else onClose(); };
  if (drafts?.[index]) return <McpEditor key={index} value="new" seed={drafts[index]} progress={t('Review service {current} of {total}', { current: index + 1, total: drafts.length })} onClose={next} onSaved={onSaved} onRefreshed={onRefreshed}/>;
  return <CommunityDialog title={t('Import MCP JSON')} onClose={onClose} footer={<><Button variant="tertiary" onPress={onClose}>{t('Cancel')}</Button><Button isDisabled={!text.trim()} onPress={parse}>{t('Review imported services')}</Button></>}>
    <p>{t('Paste mcpServers JSON. Review and save each service separately; nothing is created automatically.')}</p>
    <TextField value={text} onChange={setText} fullWidth><Label>{t('mcpServers JSON')}</Label><TextArea rows={12} spellCheck={false}/></TextField>
    {error ? <CommunityMessage role="alert" status="danger" title={error instanceof McpImportError ? t(error.kind === 'json' ? 'Invalid MCP JSON.' : error.kind === 'unknown' ? 'Unknown MCP field: {path}' : 'Invalid or conflicting MCP fields: {path}', { path: error.path }) : errorText(error)}/> : null}
  </CommunityDialog>;
}
