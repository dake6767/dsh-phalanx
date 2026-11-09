import type { ReactNode } from 'react'
import { Button } from '@heroui/react/button'
import { Chip } from '@heroui/react/chip'
import type { CommunityMcpInput, CommunityMcpSettings, CommunityMcpTemplate } from '../../src/domain/admin-contract'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'
import CommunityIcon from './CommunityIcon'

type TemplateRow = CommunityMcpTemplate & { readonly retainedArgument?: NonNullable<CommunityMcpInput['retainedArguments']>[number] }
export function TemplateFields({
  kind,
  rows,
  busy,
  onChange,
  summaries,
  protectedArguments,
}: {
  kind: 'headers' | 'query' | 'env' | 'args'
  summaries?: readonly { name: string; configured: boolean; last4: string }[]
  protectedArguments?: CommunityMcpSettings['protectedFields']
  rows: readonly TemplateRow[]
  busy: boolean
  onChange: (rows: readonly TemplateRow[]) => void
}) {
  const { t } = usePlatformLanguage()
  const labels = {
    headers: ['Request headers', 'Header name', 'Header value', 'Remove header', 'Add header'],
    query: ['Query parameters', 'Parameter name', 'Parameter value', 'Remove parameter', 'Add parameter'],
    env: ['Environment variables', 'Variable name', 'Variable value', 'Remove variable', 'Add variable'],
    args: ['Command arguments', 'Argument', 'Argument', 'Remove argument', 'Add argument'],
  } as const
  const copy = labels[kind]
  return (
    <section className="mcp-template-fields">
      <div className="plugin-section-heading">
        <h3>{t(copy[0])}</h3>
        <Button size="sm" variant="secondary" isDisabled={busy || rows.length >= 32} onPress={() => onChange([...rows, { name: '', value: '' }])}>
          {t(copy[4])}
        </Button>
      </div>
      {rows.map((row, index) => (
        <div className={`plugin-environment-row upstream-header-row${kind === 'args' ? ' mcp-argument-row' : ''}`} key={index}>
          {kind !== 'args' ? (
            <CommunityField
              label={t(copy[1])}
              value={row.name}
              disabled={busy}
              required
              onChange={name => onChange(rows.map((item, i) => (i === index ? { ...item, name } : item)))}
            />
          ) : null}
          <CommunityField
            label={t(copy[2])}
            type={kind === 'args' ? undefined : 'password'}
            placeholder={
              row.retainedArgument
                ? `••••${protectedArguments?.['args/' + row.retainedArgument.sourceIndex]?.last4 ?? ''}`
                : summaries?.find(saved => saved.name.toLowerCase() === row.name.toLowerCase() && saved.configured)
                  ? `••••${summaries.find(saved => saved.name.toLowerCase() === row.name.toLowerCase())!.last4}`
                  : undefined
            }
            value={row.value}
            disabled={busy}
            onChange={value => onChange(rows.map((item, i) => (i === index ? { ...item, value } : item)))}
          />
          <Button variant="tertiary" isIconOnly aria-label={t(copy[3])} isDisabled={busy} onPress={() => onChange(rows.filter((_, i) => i !== index))}>
            <CommunityIcon name="close" size={16} />
          </Button>
        </div>
      ))}
    </section>
  )
}

export function McpPreparation({ settings }: { settings?: CommunityMcpSettings }) {
  const { t, locale } = usePlatformLanguage(),
    preparation = settings?.preparation
  if (!preparation) return null
  return (
    <>
      {preparation.isolated === false ? <CommunityMessage role="status" status="warning" title={t('Shared run is not isolated. Development only.')} /> : null}
      <div className="mcp-preparation-status" role="status">
        <Chip size="sm" variant="soft" color={preparation.stage === 'failed' ? 'danger' : preparation.stage === 'ready' ? 'success' : 'accent'}>
          {t(preparation.stage === 'failed' ? 'Preparation failed' : preparation.stage === 'ready' ? 'Dependencies ready' : 'Preparing dependencies…')}
        </Chip>
        <time dateTime={new Date(preparation.updatedAt).toISOString()}>{new Date(preparation.updatedAt).toLocaleString(locale)}</time>
      </div>
      {preparation.log ? (
        <details className="mcp-preparation-log">
          <summary>{t('Preparation log')}</summary>
          <pre className="plugin-preparation-log">{preparation.log}</pre>
        </details>
      ) : null}
    </>
  )
}

/** Unnamed on purpose: fields inside reuse the heading text as their label. */
export function McpEditorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plugin-detail-section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}
