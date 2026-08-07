import { useEffect, useState } from 'react'
import { getSettings, updateSettings } from './api'
import type { FilesystemScope } from './types'
import { DEFAULT_ACTION_FORMAT } from './actionHeadings'
import type { ActionFormat } from './actionHeadings'

const DEFAULT_SCOPE: FilesystemScope = 'project-and-ai-roots'

function splitHeadings(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de charger les paramètres.'
}

export function AppSettingsView() {
  const [scope, setScope] = useState<FilesystemScope>(DEFAULT_SCOPE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [format, setFormat] = useState<ActionFormat>(DEFAULT_ACTION_FORMAT)
  const [todoDraft, setTodoDraft] = useState(DEFAULT_ACTION_FORMAT.todoHeadings.join(', '))
  const [followUpDraft, setFollowUpDraft] = useState(
    DEFAULT_ACTION_FORMAT.followUpHeadings.join(', '),
  )

  useEffect(() => {
    let ignore = false
    void getSettings()
      .then((settings) => {
        if (ignore) return
        setScope(settings.filesystemScope ?? DEFAULT_SCOPE)
        const stored = { ...DEFAULT_ACTION_FORMAT, ...(settings.actionFormat ?? {}) }
        setFormat(stored)
        setTodoDraft(stored.todoHeadings.join(', '))
        setFollowUpDraft(stored.followUpHeadings.join(', '))
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [])

  async function handleScopeChange(next: FilesystemScope) {
    if (next === scope) return
    if (next === 'full-system') {
      const confirmed = window.confirm(
        'Autoriser les nouveaux projets à modifier des fichiers sur tout le système ?'
          + '\n\nLes projets existants conservent leur réglage propre.',
      )
      if (!confirmed) return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const settings = await updateSettings({ filesystemScope: next })
      setScope(settings.filesystemScope ?? next)
      setSaved(true)
    } catch (saveError: unknown) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  async function handleFormatChange(patch: Partial<ActionFormat>) {
    const next = { ...format, ...patch }
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const settings = await updateSettings({ actionFormat: next })
      const stored = { ...DEFAULT_ACTION_FORMAT, ...(settings.actionFormat ?? next) }
      setFormat(stored)
      // Le serveur normalise (liste vide, doublons, casse) : on réaligne les
      // champs sur ce qu'il a réellement retenu.
      setTodoDraft(stored.todoHeadings.join(', '))
      setFollowUpDraft(stored.followUpHeadings.join(', '))
      setSaved(true)
    } catch (saveError: unknown) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-view" aria-labelledby="app-settings-title">
      <header className="settings-view-header">
        <div>
          <p className="eyebrow">Application</p>
          <h1 id="app-settings-title">Paramètres globaux</h1>
          <p>Les valeurs ici servent de défaut aux nouveaux projets.</p>
        </div>
      </header>

      <div className="settings-card">
        <div>
          <h2>Accès filesystem par défaut</h2>
          <p>
            Ce réglage s’applique aux projets créés ensuite. Un projet peut ensuite
            définir sa propre portée depuis son bouton de configuration.
          </p>
        </div>
        <label className="settings-select-label" htmlFor="app-filesystem-scope">
          Portée par défaut
          <select
            id="app-filesystem-scope"
            value={scope}
            disabled={loading || saving}
            onChange={(event) => void handleScopeChange(event.target.value as FilesystemScope)}
          >
            <option value="project-and-ai-roots">Projet + racines IA</option>
            <option value="full-system">Tout le système</option>
          </select>
        </label>
        <p className="settings-help">
          Les racines <code>~/.claude</code> et <code>~/.codex</code> restent accessibles
          dans les deux modes.
        </p>
        {saved ? <p className="settings-success" role="status">Paramètre enregistré.</p> : null}
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
      </div>

      <div className="settings-card">
        <div>
          <h2>Blocs d’actions</h2>
          <p>
            Pupitre demande à l’agent de terminer ses réponses par un bloc d’actions et
            un bloc de propositions, puis les transforme en cases à cocher. Cocher une
            ligne compose la consigne correspondante dans le champ de message.
          </p>
        </div>
        <label className="settings-checkbox-label">
          <input
            type="checkbox"
            checked={format.enabled}
            disabled={loading || saving}
            onChange={(event) => void handleFormatChange({ enabled: event.target.checked })}
          />
          Demander ce format à l’agent
        </label>
        <label className="settings-select-label" htmlFor="app-todo-headings">
          Intitulés du bloc d’actions
          <input
            id="app-todo-headings"
            value={todoDraft}
            disabled={loading || saving}
            onChange={(event) => setTodoDraft(event.target.value)}
            onBlur={() => void handleFormatChange({ todoHeadings: splitHeadings(todoDraft) })}
          />
        </label>
        <label className="settings-select-label" htmlFor="app-followup-headings">
          Intitulés du bloc de propositions
          <input
            id="app-followup-headings"
            value={followUpDraft}
            disabled={loading || saving}
            onChange={(event) => setFollowUpDraft(event.target.value)}
            onBlur={() => void handleFormatChange({ followUpHeadings: splitHeadings(followUpDraft) })}
          />
        </label>
        <p className="settings-help">
          Séparés par des virgules. Le premier intitulé est celui demandé à l’agent, les
          suivants restent reconnus à l’affichage. Une liste vide rétablit les défauts.
        </p>
      </div>
    </section>
  )
}
