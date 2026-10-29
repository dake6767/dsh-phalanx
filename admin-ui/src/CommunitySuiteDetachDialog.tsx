import { useState } from 'react'
import type { CommunitySuiteInstallView } from '../../src/domain/admin-contract'
import { detachCommunitySuiteEntry } from './community-api'
import CommunityDialog from './CommunityDialog'
import { suiteKindLabels as kindLabels } from './community-suite-labels'
import { Button } from '@heroui/react/button'
import { usePlatformLanguage } from './CommunityLanguage'
import CommunityMessage from './CommunityMessage'

export default function CommunitySuiteDetachDialog({
  tool,
  suite,
  entry,
  onClose,
  onSubmitted,
}: {
  tool: string
  suite: string
  entry: CommunitySuiteInstallView['entries'][number]
  onClose: () => void
  onSubmitted: () => void
}) {
  const { t, errorText } = usePlatformLanguage()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await detachCommunitySuiteEntry(suite, entry)
      onSubmitted()
    } catch (failure) {
      setError(failure)
      setBusy(false)
    }
  }
  return (
    <CommunityDialog
      title={t('Detach {name} from {tool}?', { name: entry.name, tool })}
      eyebrow={t(kindLabels[entry.kind])}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" isDisabled={busy} onPress={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            isDisabled={busy}
            onPress={() => {
              void submit()
            }}
          >
            {t('Detach from {tool}', { tool })}
          </Button>
        </>
      }
    >
      {error !== undefined ? <CommunityMessage role="alert" status="danger" title={errorText(error)} /> : null}
      <p>{t('The entry becomes an ordinary library entry you can edit. It no longer follows catalog updates and stays when the tool is uninstalled.')}</p>
      <p>{t('Its grants, publication and references do not change.')}</p>
    </CommunityDialog>
  )
}
