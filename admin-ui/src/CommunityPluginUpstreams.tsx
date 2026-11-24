import { TextField } from '@heroui/react/textfield'
import { TextArea } from '@heroui/react/textarea'
import { Label } from '@heroui/react/label'
import CommunitySelect from './CommunitySelect'
import CommunityUpstreamTest from './CommunityUpstreamTest'
import { useEffect, useId, useRef, useState } from 'react'
import { Tabs } from '@heroui/react/tabs'
import { Button } from '@heroui/react/button'
import { Chip } from '@heroui/react/chip'
import { Card } from '@heroui/react/card'
import { Checkbox } from '@heroui/react/checkbox'
import { upstreamWriteInput } from '../../src/domain/plugin-upstream'
import type { CommunityPluginUpstreamInput, CommunityPluginUpstreamView } from '../../src/domain/admin-contract'
import { CommunityApiRequestError, communityPluginUpstreams, updateCommunityPluginUpstreams } from './community-api'
import { CommunityCopyError, usePlatformLanguage } from './CommunityLanguage'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import CommunityMessage from './CommunityMessage'
import { useDraftGuard } from './useDraftGuard'

export default function CommunityPluginUpstreams({
  packageName,
  mode = 'manual',
  embedded = false,
  onChanged,
}: {
  packageName: string
  mode?: 'manual' | 'catalog' | 'advanced'
  embedded?: boolean
  onChanged?: () => void
}) {
  const { t, errorText } = usePlatformLanguage()
  const [revision, setRevision] = useState(0)
  const [reload, setReload] = useState(0)
  const [rows, setRows] = useState<readonly CommunityPluginUpstreamView[]>()
  const [editing, setEditing] = useState<CommunityPluginUpstreamView | null>()
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    const controller = new AbortController()
    void communityPluginUpstreams(packageName, controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setRows(next)
        setError(undefined)
      })
      .catch(error => {
        if (!controller.signal.aborted) setError(error)
      })
    return () => controller.abort()
  }, [packageName, reload])
  const catalog = mode === 'catalog'
  const visible = rows?.filter(row => mode === 'manual' || Boolean(row.managedImage) === catalog)
  if (catalog && visible?.length === 0 && !error) return null
  const title = t(catalog ? 'Access settings' : 'Plugin upstreams')
  return (
    <section className={embedded ? 'catalog-service-slot' : 'plugin-detail-section'} aria-label={embedded ? undefined : title}>
      {!embedded ? (
        <div className="plugin-section-heading">
          <h2>{title}</h2>
          {!catalog ? (
            <Button size="sm" variant="secondary" isDisabled={rows === undefined} onPress={() => setEditing(null)}>
              {t('Add upstream')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p>{t('Testing checks the address, credential and headers only. It does not verify that the plugin calls through the platform.')}</p>
      <p>{t('Credentials stay on the platform. Address and header changes apply to the next request.')}</p>
      {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      {visible === undefined ? (
        <p role="status">{t('Loading…')}</p>
      ) : (
        visible.map(row => (
          <Card className="plugin-upstream-card" key={row.name}>
            <Card.Content>
              <div className="plugin-section-heading">
                <strong>{row.managedImage ? t('Image generation') : row.name}</strong>
                <Chip size="sm" variant="soft" color={row.managedImage && !row.managedImage.ready ? 'warning' : undefined}>
                  <span>
                    {t(
                      row.managedImage
                        ? row.managedImage.disabled
                          ? 'Disabled'
                          : row.managedImage.ready
                            ? 'Access configured'
                            : 'Upstream setup required'
                        : row.credential.configured
                          ? 'Credential configured'
                          : 'Credential not configured',
                    )}
                  </span>
                  {!row.managedImage && row.credential.configured ? <span>{` ••••${row.credential.last4}`}</span> : null}
                </Chip>
              </div>
              {row.baseUrl ? <p className="plugin-upstream-address">{row.baseUrl}</p> : null}
              {row.managedImage && row.model ? <p>{row.model}</p> : null}
              {row.managedImage?.credentialUnavailable ? <p>{t('Saved upstream credentials could not be read. Re-enter them in the configuration.')}</p> : null}
              {row.managedImage && (!row.baseUrl || !row.credential.configured || !row.model) ? (
                <p>
                  {t('Fields to configure: {fields}', {
                    fields: [!row.baseUrl && t('Upstream address'), !row.credential.configured && t('API key'), !row.model && t('Model name')]
                      .filter(Boolean)
                      .join(' · '),
                  })}
                </p>
              ) : null}
              <CommunityUpstreamTest
                actions={
                  <Button variant="secondary" onPress={() => setEditing(row)}>
                    {t(row.managedImage ? 'Edit configuration' : 'Edit upstream')}
                  </Button>
                }
                key={`${revision}:${JSON.stringify(row)}`}
                packageName={packageName}
                name={row.name}
                ready={(row.managedImage?.ready ?? row.credential.configured) && Boolean(row.testRequest)}
              />
            </Card.Content>
          </Card>
        ))
      )}
      {editing !== undefined ? (
        <UpstreamEditor
          packageName={packageName}
          existing={editing}
          names={rows?.map(row => row.name) ?? []}
          onClose={() => setEditing(undefined)}
          onReload={() => {
            setEditing(undefined)
            setRows(undefined)
            setReload(value => value + 1)
          }}
          onSaved={next => {
            setRows(next)
            onChanged?.()
            setRevision(value => value + 1)
            setEditing(undefined)
          }}
        />
      ) : null}
    </section>
  )
}
function UpstreamEditor({
  packageName,
  existing,
  names,
  onClose,
  onReload,
  onSaved,
}: {
  packageName: string
  existing: CommunityPluginUpstreamView | null
  names: readonly string[]
  onClose: () => void
  onReload: () => void
  onSaved: (rows: readonly CommunityPluginUpstreamView[]) => void
}) {
  const { t, errorText } = usePlatformLanguage()
  const [name, setName] = useState(existing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [model, setModel] = useState(existing?.model ?? '')
  const managed = existing?.managedImage !== undefined
  const savedEnabled = !existing?.managedImage?.disabled
  const [enabled, setEnabled] = useState(savedEnabled)
  const enabledChanged = managed && enabled !== savedEnabled
  const [credential, setCredential] = useState('')
  const [clearCredential, setClearCredential] = useState(false)
  const [headers, setHeaders] = useState<CommunityPluginUpstreamInput['headers']>(
    existing ? upstreamWriteInput(existing).headers : [{ name: 'Authorization', value: 'Bearer {credential}' }],
  )
  const repairing = existing?.managedImage?.credentialUnavailable === true
  const repairHeaders = headers.filter(header => existing?.managedImage?.unreadableHeaders?.includes(header.name))
  const [testMethod, setTestMethod] = useState(existing?.testRequest?.method ?? 'GET')
  const [testPath, setTestPath] = useState('')
  const [testBody, setTestBody] = useState('')
  const [clearTest, setClearTest] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const conflict = error instanceof CommunityApiRequestError && error.code === 'platform-configuration-conflict'
  const [deleting, setDeleting] = useState(false)
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const [editorTab, setEditorTab] = useState('basic')
  const testDirty = clearTest || testMethod !== (existing?.testRequest?.method ?? 'GET') || testPath !== '' || testBody !== ''
  const dirty =
    enabledChanged ||
    clearCredential ||
    testDirty ||
    name !== (existing?.name ?? '') ||
    baseUrl !== (existing?.baseUrl ?? '') ||
    model !== (existing?.model ?? '') ||
    credential !== '' ||
    JSON.stringify(headers) !== JSON.stringify(existing ? upstreamWriteInput(existing).headers : [{ name: 'Authorization', value: 'Bearer {credential}' }])
  const save = async () => {
    if (busy || conflict) return false
    if (!existing && names.includes(name)) {
      setEditorTab('basic')
      setError(new CommunityCopyError('This upstream name already exists.'))
      return false
    }
    const invalid = form.current?.querySelector<HTMLInputElement>(':invalid')
    if (invalid) {
      setEditorTab(invalid.closest('[data-editor-tab]')?.getAttribute('data-editor-tab') ?? 'basic')
      setError(new CommunityCopyError('Complete the required fields.'))
      return false
    }
    setBusy(true)
    setError(undefined)
    try {
      let body: unknown
      if (testBody.trim() && testPath) {
        try {
          body = JSON.parse(testBody)
        } catch {
          setEditorTab('test')
          throw new CommunityCopyError('Enter a valid JSON test body.')
        }
      }
      if (!testPath && (testBody.trim() || testMethod !== (existing?.testRequest?.method ?? 'GET')) && !clearTest) {
        setEditorTab('test')
        throw new CommunityCopyError('Complete the required fields.')
      }
      const testRequest = clearTest ? null : testPath ? { method: testMethod, path: testPath, ...(body === undefined ? {} : { body }) } : undefined
      const next = await updateCommunityPluginUpstreams(packageName, {
        action: 'save',
        ...(existing?.managedImage?.revision ? { expectedRevision: existing.managedImage.revision } : {}),
        ...(enabledChanged ? { enabled } : {}),
        upstream: {
          name,
          baseUrl,
          headers,
          testRequest,
          ...(managed ? { model: model.trim() } : {}),
          ...(clearCredential ? { clearCredential: true } : credential ? { credential } : {}),
        },
      })
      setCredential('')
      onSaved(next)
      return true
    } catch (error) {
      setError(error)
      return false
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    setError(undefined)
    try {
      onSaved(await updateCommunityPluginUpstreams(packageName, { action: 'delete', name }))
    } catch (error) {
      setDeleting(false)
      setError(error)
    } finally {
      setBusy(false)
    }
  }
  const guard = useDraftGuard(dirty, save, () => setCredential(''), busy)
  const changeCredential = (value: string) => {
    setCredential(value)
    setClearCredential(false)
  }
  const clearSavedCredential = existing?.credential.configured ? (
    <Button
      variant="secondary"
      isDisabled={busy}
      onPress={() => {
        setClearCredential(value => !value)
        setCredential('')
      }}
    >
      {t(clearCredential ? 'Keep saved credential' : 'Clear saved credential')}
    </Button>
  ) : null
  return (
    <>
      <CommunityDialog
        size="lg"
        title={t(managed ? 'Image generation' : existing ? 'Edit upstream' : 'Add upstream')}
        busy={busy}
        onClose={() => guard.request(onClose)}
        footer={
          <div className="upstream-editor-actions">
            {existing && !managed ? (
              <Button className="upstream-delete-action" variant="danger-soft" isDisabled={busy} onPress={() => setDeleting(true)}>
                {t('Delete upstream')}
              </Button>
            ) : null}
            <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>
              {t('Cancel')}
            </Button>
            {conflict ? (
              <Button variant="secondary" onPress={onReload}>
                {t('Retry loading configuration')}
              </Button>
            ) : null}
            <Button
              type="submit"
              form={id}
              isDisabled={
                busy ||
                conflict ||
                !name ||
                !baseUrl ||
                (!existing && names.includes(name)) ||
                (managed && (!model.trim() || (!credential && !existing.credential.configured))) ||
                repairHeaders.some(header => !header.value)
              }
            >
              {t('Save changes')}
            </Button>
          </div>
        }
      >
        <form
          ref={form}
          noValidate
          id={id}
          className="upstream-editor"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          {error ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
          {managed ? (
            <>
              <CommunityField label={t('Upstream address')} type="url" value={baseUrl} onChange={setBaseUrl} disabled={busy} required />
              <CommunityField
                label={t('API key')}
                type="password"
                value={credential}
                onChange={changeCredential}
                disabled={busy}
                description={t(
                  repairing && !existing.credential.configured
                    ? 'Saved upstream credentials could not be read. Re-enter them in the configuration.'
                    : existing.credential.configured
                      ? 'Saved credential'
                      : 'No saved credential',
                )}
                autoComplete="new-password"
                required={!existing.credential.configured}
              />
              {clearSavedCredential}
              <CommunityField label={t('Model name')} value={model} onChange={setModel} disabled={busy} required />
              {repairHeaders.length ? (
                <details>
                  <summary>{t('Request headers')}</summary>
                  <p>{t('Use {credential} for the saved secret. Fixed values replace member headers.')}</p>
                  {repairHeaders.map(header => (
                    <CommunityField
                      key={header.name}
                      label={header.name}
                      type="password"
                      autoComplete="new-password"
                      value={header.value}
                      disabled={busy}
                      required
                      onChange={value => setHeaders(rows => rows.map(row => (row.name === header.name ? { ...row, value } : row)))}
                    />
                  ))}
                </details>
              ) : null}
              {existing.managedImage?.ready || existing.managedImage?.disabled ? (
                <Checkbox isSelected={enabled} isDisabled={busy} onChange={setEnabled}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    {t('Enable image generation')}
                  </Checkbox.Content>
                </Checkbox>
              ) : null}
            </>
          ) : (
            <Tabs className="upstream-editor-tabs" selectedKey={editorTab} onSelectionChange={key => setEditorTab(String(key))} variant="secondary">
              <Tabs.ListContainer>
                <Tabs.List aria-label={t(existing ? 'Edit upstream' : 'Add upstream')}>
                  <Tabs.Tab id="basic">
                    {t('Basic information')}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="headers">
                    {t('Request headers')}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="test">
                    {t('Test request')}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
              <Tabs.Panel id="basic" shouldForceMount data-editor-tab="basic">
                <p className="upstream-editor-description">{t('Credentials stay on the platform. Address and header changes apply to the next request.')}</p>
                <CommunityField
                  label={t('Upstream name')}
                  value={name}
                  onChange={setName}
                  readOnly={existing !== null}
                  disabled={busy}
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
                  description={t('Use a unique name with letters, digits, underscores or hyphens.')}
                />
                {!existing && names.includes(name) ? <CommunityMessage status="danger" title={t('This upstream name already exists.')} /> : null}
                <CommunityField
                  label={t('Upstream address')}
                  type="url"
                  value={baseUrl}
                  onChange={setBaseUrl}
                  disabled={busy}
                  required
                  description={t('HTTP(S) addresses, including private networks, are supported.')}
                />
                <CommunityField
                  label={t('Platform credential')}
                  type="password"
                  value={credential}
                  placeholder={existing?.credential.configured ? `••••${existing.credential.last4}` : undefined}
                  onChange={changeCredential}
                  disabled={busy}
                  autoComplete="new-password"
                  description={t(existing?.credential.configured ? 'Leave blank to keep the saved credential.' : 'Enter the credential used by this upstream.')}
                />
                {clearSavedCredential}
              </Tabs.Panel>
              <Tabs.Panel id="headers" shouldForceMount data-editor-tab="headers">
                <p className="upstream-editor-description">{t('Use {credential} for the saved secret. Fixed values replace member headers.')}</p>
                {headers.map((header, index) => (
                  <div className="plugin-environment-row upstream-header-row" key={index}>
                    <CommunityField
                      label={t('Header name')}
                      value={header.name}
                      disabled={busy}
                      required
                      onChange={name => setHeaders(rows => rows.map((row, i) => (i === index ? { ...row, name } : row)))}
                    />
                    <CommunityField
                      label={t('Header value')}
                      placeholder={
                        existing?.headers.find(row => row.name === header.name)?.configured
                          ? `••••${existing.headers.find(row => row.name === header.name)!.last4}`
                          : undefined
                      }
                      type="password"
                      autoComplete="new-password"
                      description={
                        existing?.headers.find(row => row.name === header.name)?.configured ? t('Leave blank to keep the saved credential.') : undefined
                      }
                      value={header.value}
                      disabled={busy}
                      onChange={value => setHeaders(rows => rows.map((row, i) => (i === index ? { ...row, value } : row)))}
                    />
                    <Button variant="tertiary" isDisabled={busy} onPress={() => setHeaders(rows => rows.filter((_, i) => i !== index))}>
                      {t('Remove header')}
                    </Button>
                  </div>
                ))}
                <Button variant="secondary" isDisabled={busy} onPress={() => setHeaders(rows => [...rows, { name: '', value: '' }])}>
                  {t('Add header')}
                </Button>
              </Tabs.Panel>
              <Tabs.Panel id="test" shouldForceMount data-editor-tab="test">
                <p>{t('Testing checks the address, credential and headers only. It does not verify that the plugin calls through the platform.')}</p>
                <CommunitySelect
                  label={t('Test method')}
                  value={testMethod}
                  onChange={setTestMethod}
                  options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(value => ({ id: value, label: value }))}
                />
                <CommunityField
                  label={t('Test path')}
                  value={testPath}
                  onChange={value => {
                    setTestPath(value)
                    setClearTest(false)
                  }}
                  disabled={busy}
                  description={t('Use a path such as /search. Leave blank to keep the saved test request.')}
                />
                {existing?.testRequest ? (
                  <>
                    <p>{t(clearTest ? 'Saved test request will be removed.' : 'A test request is configured. Enter a complete request to replace it.')}</p>
                    <Button
                      variant="secondary"
                      isDisabled={busy}
                      onPress={() => {
                        setClearTest(true)
                        setTestPath('')
                        setTestBody('')
                      }}
                    >
                      {t('Clear saved test request')}
                    </Button>
                  </>
                ) : null}
                <TextField value={testBody} onChange={setTestBody} isDisabled={busy} fullWidth>
                  <Label>{t('Test JSON body (optional)')}</Label>
                  <TextArea className="plugin-yaml-input" rows={7} />
                </TextField>
              </Tabs.Panel>
            </Tabs>
          )}
        </form>
      </CommunityDialog>
      {guard.dialog}
      {deleting ? (
        <CommunityDialog
          title={t('Delete upstream')}
          busy={busy}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setDeleting(false)}>
                {t('Cancel')}
              </Button>
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  void remove()
                }}
              >
                {t('Confirm')}
              </Button>
            </>
          }
        >
          <p>{t('Delete this upstream and its saved credential?')}</p>
        </CommunityDialog>
      ) : null}
    </>
  )
}
