import { pythonPackagePins } from '../../src/domain/python-library'
import type { CommunityRuntimeDependencyView } from '../../src/domain/admin-contract'
import { useId, useRef, useState } from 'react'
import { Button } from '@heroui/react/button'
import { TextField } from '@heroui/react/textfield'
import { TextArea } from '@heroui/react/textarea'
import { Label } from '@heroui/react/label'
import { Description } from '@heroui/react/description'
import CommunityDialog from './CommunityDialog'
import CommunityField from './CommunityField'
import CommunitySelect from './CommunitySelect'
import CommunityMessage from './CommunityMessage'
import { usePlatformLanguage } from './CommunityLanguage'
import { useDraftGuard } from './useDraftGuard'
import { changeRuntimeDependency } from './community-api'

const examples = {
  npm: 'npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund package-name@1.2.3',
  pip: 'python3 -m venv --copies "$RD_OUT/.venv"\n"$RD_OUT/.venv/bin/pip" install package-name==1.2.3',
  release:
    'set -eu\nmkdir -p "$RD_OUT/bin"\ncurl -fL https://github.com/owner/repository/releases/download/v1.2.3/tool-linux-amd64 -o "$RD_OUT/bin/tool"\nprintf \'%s  %s\\n\' REPLACE_WITH_SHA256 "$RD_OUT/bin/tool" | sha256sum -c -\nchmod +x "$RD_OUT/bin/tool"',
  custom: 'set -eu\nmkdir -p "$RD_OUT/bin"\n# Write your preparation script here.',
}
export function DependencyCommandField({
  label,
  value,
  onChange,
  description,
  required = false,
  disabled = false,
  readOnly = false,
  rows = 4,
}: {
  label: string
  value: string
  onChange?: (value: string) => void
  description?: string
  required?: boolean
  disabled?: boolean
  readOnly?: boolean
  rows?: number
}) {
  return (
    <TextField
      className="platform-field"
      value={value}
      onChange={onChange}
      isRequired={required}
      isDisabled={disabled}
      isReadOnly={readOnly}
      validationBehavior="native"
      fullWidth
    >
      <Label>{label}</Label>
      <TextArea rows={rows} className="font-mono" />
      {description ? <Description>{description}</Description> : null}
    </TextField>
  )
}
export default function CommunityRuntimeDependencyForm({
  onClose,
  onCreated,
  dependency,
  initialInput,
}: {
  onClose: () => void
  onCreated: (name: string) => void
  dependency?: CommunityRuntimeDependencyView
  initialInput?: { name: string; prepareCommand: string; pathDirectories?: readonly string[]; checkCommand?: string }
}) {
  const { t, errorText } = usePlatformLanguage()
  const initial = dependency ?? initialInput
  const [name, setName] = useState(initial?.name ?? ''),
    [command, setCommand] = useState(initial?.prepareCommand ?? ''),
    [paths, setPaths] = useState(initial?.pathDirectories?.join('\n') ?? ''),
    [check, setCheck] = useState(initial?.checkCommand ?? ''),
    [example, setExample] = useState<string | null>(null)
  const [category, setCategory] = useState<'commands' | 'python-library' | 'resource'>(dependency?.type ?? 'commands')
  const [packages, setPackages] = useState(dependency?.type === 'python-library' ? dependency.packages.join('\n') : '')
  const pins = pythonPackagePins(packages.split(/\s+/u).filter(Boolean))
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>()
  const pending = useRef(false),
    id = useId()
  const valid = Boolean(name.trim() && (category === 'python-library' ? pins : command.trim() && (category === 'resource' || paths.trim())))
  const save = async () => {
    if (pending.current || !valid) return false
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await changeRuntimeDependency({
        ...(dependency ? { action: 'update' as const, name: dependency.name } : { action: 'create' as const }),
        input:
          category === 'python-library'
            ? { name: name.trim(), type: category, packages: pins! }
            : {
                name: name.trim(),
                ...(category === 'resource' ? { type: category } : {}),
                prepareCommand: command,
                pathDirectories:
                  category === 'resource'
                    ? []
                    : paths
                        .split('\n')
                        .map(path => path.trim())
                        .filter(Boolean),
                ...(check.trim() ? { checkCommand: check } : {}),
              },
      })
      onCreated(name.trim())
      return true
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const guard = useDraftGuard(
    category !== (dependency?.type ?? 'commands') ||
      packages !== (dependency?.type === 'python-library' ? dependency.packages.join('\n') : '') ||
      name !== (dependency?.name ?? '') ||
      command !== (dependency?.prepareCommand ?? '') ||
      paths !== (dependency?.pathDirectories.join('\n') ?? '') ||
      check !== (dependency?.checkCommand ?? ''),
    save,
    () => {
      setName('')
      setCommand('')
      setPaths('')
      setCheck('')
      setPackages('')
      setCategory('commands')
    },
    busy,
  )
  return (
    <>
      <CommunityDialog
        title={t(dependency ? 'Edit runtime dependency' : 'Create runtime dependency')}
        size="lg"
        busy={busy}
        onClose={() => guard.request(onClose)}
        footer={
          <>
            <Button variant="tertiary" isDisabled={busy} onPress={() => guard.request(onClose)}>
              {t('Cancel')}
            </Button>
            <Button form={id} type="submit" isDisabled={busy || !valid}>
              {t(dependency ? 'Save and prepare' : 'Start preparation')}
            </Button>
          </>
        }
      >
        {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
        <form
          id={id}
          className="page-stack"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <CommunityField label={t('Dependency name')} value={name} onChange={setName} required disabled={busy} readOnly={Boolean(dependency)} autoFocus />
          <CommunitySelect
            label={t('Dependency category')}
            value={category}
            disabled={busy}
            onChange={key => setCategory(key === 'python-library' || key === 'resource' ? key : 'commands')}
            options={[
              { id: 'commands', label: t('Commands') },
              { id: 'python-library', label: t('Python libraries') },
              { id: 'resource', label: t('Resource files') },
            ]}
          />
          {category === 'python-library' ? (
            <DependencyCommandField
              label={t('Locked PyPI packages')}
              value={packages}
              onChange={setPackages}
              required
              disabled={busy}
              rows={7}
              description={t(
                'List every package, including transitive dependencies, as name==version. Only wheels are installed. Members can import these libraries with python3; their own venv stays separate.',
              )}
            />
          ) : (
            <>
              <CommunitySelect
                label={t('Preparation example')}
                value={example}
                disabled={busy}
                onChange={key => {
                  setExample(key)
                  setCommand(examples[key as keyof typeof examples])
                }}
                options={[
                  { id: 'npm', label: t('npm package') },
                  { id: 'pip', label: t('pip / venv') },
                  { id: 'release', label: t('GitHub Release with SHA-256') },
                  { id: 'custom', label: t('Custom script') },
                ]}
              />
              <DependencyCommandField
                label={t('Prepare command')}
                value={command}
                onChange={setCommand}
                required
                disabled={busy}
                rows={7}
                description={t('Runs in the output directory with RD_OUT set. Platform credentials are not available.')}
              />
              {category === 'resource' ? (
                <p>{t('Resource files are shared read-only and do not add commands to PATH.')}</p>
              ) : (
                <DependencyCommandField
                  label={t('PATH directories')}
                  value={paths}
                  onChange={setPaths}
                  required
                  disabled={busy}
                  rows={2}
                  description={t('One relative directory per line, for example bin, node_modules/.bin or .venv/bin.')}
                />
              )}
              <DependencyCommandField
                label={t('Check command')}
                value={check}
                onChange={setCheck}
                disabled={busy}
                rows={2}
                description={t('Optional. Runs with the declared PATH in a fresh environment after preparation.')}
              />
            </>
          )}
        </form>
      </CommunityDialog>
      {guard.dialog}
    </>
  )
}
