import { useState } from 'react'
import { Button } from '@heroui/react/button'
import { Card } from '@heroui/react/card'
import type { CommunityRuntimeDependencyView } from '../../src/domain/runtime-dependency-contract'
import type { PlatformLocale } from '../../src/domain/platform-language'
import CommunityDialog from './CommunityDialog'
import CommunityGrantSection from './CommunityGrantSection'
import CommunityIcon from './CommunityIcon'
import { usePlatformLanguage } from './CommunityLanguage'
import browserLabels from './playwright-browser-labels.json'

export function dependencySize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function browserBuildName(locale: PlatformLocale, build: string): string {
  return browserLabels[locale].build.replace('{build}', build)
}

export default function CommunityPlaywrightBrowsers({
  dependencies,
  onOpenDependency,
}: {
  dependencies: readonly CommunityRuntimeDependencyView[]
  onOpenDependency: (name: string) => void
}) {
  const { t, locale } = usePlatformLanguage()
  const [open, setOpen] = useState(false)
  const builds = dependencies
    .flatMap(row => (row.browserBuilds ?? []).map(build => ({ ...build, dependency: row.name })))
    .sort((left, right) => Number(left.build) - Number(right.build))
  const title = t('Playwright browsers')
  const bytes = dependencySize(builds.reduce((total, build) => total + build.bytes, 0))

  return (
    <>
      <Card className="plugin-library-card">
        <Card.Header>
          <div className="library-card-heading">
            <Card.Title>{title}</Card.Title>
            <CommunityIcon name="chevron" size={14} />
          </div>
          <p className="plugin-summary-meta">
            {browserLabels[locale].total.replace('{count}', String(builds.length))} · {bytes}
          </p>
        </Card.Header>
        <Button
          variant="tertiary"
          size="sm"
          aria-label={t('View dependency {name}', { name: title })}
          className="plugin-details-action"
          onPress={() => setOpen(true)}
        />
      </Card>
      {open ? (
        <CommunityDialog drawer drawerClassName="plugin-drawer" title={title} closeLabel={t('Close dependency details')} onClose={() => setOpen(false)}>
          <div className="plugin-settings-panel">
            <CommunityGrantSection title={t('Definition and references')}>
              <ul className="grant-rows">
                {builds.map(build => (
                  <li key={build.dependency + ':' + build.build}>
                    <div className="grant-row-main">
                      <div className="grant-row-title">
                        <strong>{browserBuildName(locale, build.build)}</strong>
                        <span>{dependencySize(build.bytes)}</span>
                      </div>
                      {build.playwrightVersions.length ? <p>Playwright {build.playwrightVersions.join(', ')}</p> : null}
                      {build.plugins.length ? (
                        <p>
                          {t('References')} · {build.plugins.join(', ')}
                        </p>
                      ) : null}
                      {build.memberCopies ? <p>{t('Member copies · {count}', { count: build.memberCopies })}</p> : null}
                      {!build.plugins.length && !build.memberCopies ? <p>{t('No resource references this dependency.')}</p> : null}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        setOpen(false)
                        onOpenDependency(build.dependency)
                      }}
                    >
                      {t('Preparation and checks')}
                    </Button>
                  </li>
                ))}
              </ul>
            </CommunityGrantSection>
          </div>
        </CommunityDialog>
      ) : null}
    </>
  )
}
