import { useEffect, useState, type Key } from 'react'
import { ToggleButton } from '@heroui/react/toggle-button'
import { ToggleButtonGroup } from '@heroui/react/toggle-button-group'
import { Dropdown } from '@heroui/react/dropdown'
import { Button } from '@heroui/react/button'
import { Label } from '@heroui/react/label'
import { usePlatformLanguage } from './CommunityLanguage'
import type { PlatformLanguagePreference } from '../../src/domain/platform-language'
type Appearance = 'system' | 'light' | 'dark'
declare global {
  interface Window {
    dshPhalanxAppearance?: { get: () => Appearance; set: (value: Appearance) => void }
  }
}
// Sun, moon and monitor outlines on the 24px grid used by CommunityIcon.
const appearances = [
  {
    id: 'light',
    label: 'Light',
    path: 'M12 3v2M12 19v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M3 12h2M19 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  },
  { id: 'dark', label: 'Dark', path: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z' },
  { id: 'system', label: 'System appearance', path: 'M3 5h18v11H3zM8 20h8M12 16v4' },
] as const
const languages = [
  { id: 'system', label: 'System' },
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
] as const
const glyph = (path: string) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
)

/** Top bar preferences: a segmented light/dark/system pill and a language menu. */
export default function CommunityHeaderControls() {
  const { t, preference, setPreference } = usePlatformLanguage()
  const [appearance, setAppearance] = useState<Appearance>(() => window.dshPhalanxAppearance?.get() ?? 'system')
  useEffect(() => {
    const sync = (event: Event) => setAppearance((event as CustomEvent<Appearance>).detail)
    addEventListener('dsh-phalanx:appearance', sync)
    return () => removeEventListener('dsh-phalanx:appearance', sync)
  }, [])
  const language = languages.find(option => option.id === preference) ?? languages[0]
  return (
    <div className="header-controls">
      <ToggleButtonGroup
        className="appearance-toggle"
        size="sm"
        isDetached
        aria-label={t('Appearance')}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[appearance]}
        onSelectionChange={(keys: Set<Key>) => {
          const next = [...keys][0]
          if (next) window.dshPhalanxAppearance?.set(next as Appearance)
        }}
      >
        {appearances.map(option => (
          <ToggleButton key={option.id} id={option.id} isIconOnly aria-label={t(option.label)}>
            {glyph(option.path)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Dropdown>
        <Button
          size="sm"
          variant="tertiary"
          className="language-trigger"
          aria-label={`${t('Platform language')}: ${language.id === 'system' ? t('System') : language.label}`}
        >
          {glyph('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18')}
          <span>{language.id === 'system' ? t('System') : language.label}</span>
          {glyph('m6 9 6 6 6-6')}
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={t('Platform language')}
            selectionMode="single"
            selectedKeys={[preference]}
            disallowEmptySelection
            onSelectionChange={keys => {
              const next = keys === 'all' ? undefined : [...keys][0]
              if (next) setPreference(next as PlatformLanguagePreference)
            }}
          >
            {languages.map(option => (
              <Dropdown.Item key={option.id} id={option.id} textValue={option.id === 'system' ? t('System') : option.label}>
                <Label>{option.id === 'system' ? t('System') : option.label}</Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  )
}
