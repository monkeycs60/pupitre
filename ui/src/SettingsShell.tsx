import { useState } from 'react'
import { AppSettingsView } from './AppSettingsView'
import { HelpView } from './HelpView'
import type { ComponentProps } from 'react'

type SettingsSection = 'general' | 'help'

interface SettingsShellProps extends ComponentProps<typeof AppSettingsView> {
  helpSlug?: string | null
}

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'Général' },
  { id: 'help', label: 'Aide' },
]

export function SettingsShell({ helpSlug = null, ...settingsProps }: SettingsShellProps) {
  const [section, setSection] = useState<SettingsSection>(helpSlug === null ? 'general' : 'help')

  return (
    <div className="settings-shell">
      <nav className="settings-sidebar" aria-label="Sections des réglages">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={section === id ? 'is-selected' : ''}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-shell-content">
        {section === 'help'
          ? <HelpView key={helpSlug ?? 'index'} initialSlug={helpSlug} />
          : <AppSettingsView {...settingsProps} />}
      </div>
    </div>
  )
}
