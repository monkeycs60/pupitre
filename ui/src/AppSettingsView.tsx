import { useEffect, useState } from 'react'
import {
  cancelPromotion,
  getPromotion,
  getSettings,
  getStableHealth,
  startPromotion,
  updateIntegrationTokens,
  updateSettings,
} from './api'
import type { FilesystemScope, InstanceHealth, PromotionState } from './types'
import { DEFAULT_ACTION_FORMAT } from './actionHeadings'
import type { ActionFormat } from './actionHeadings'

const DEFAULT_SCOPE: FilesystemScope = 'project-and-ai-roots'

function splitHeadings(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de charger les paramètres.'
}

const PROMOTION_STEPS = ['preflight', 'build', 'stage', 'drain', 'switch', 'launch', 'verify', 'prune']

export function AppSettingsView({ instance = null }: { instance?: InstanceHealth | null }) {
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
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenSaved, setTokenSaved] = useState(false)
  const [integrationTokens, setIntegrationTokens] = useState<Record<'clickup' | 'gitlab', boolean>>({
    clickup: false,
    gitlab: false,
  })
  const [tokenDrafts, setTokenDrafts] = useState<Record<'clickup' | 'gitlab', string>>({
    clickup: '',
    gitlab: '',
  })
  const [promotion, setPromotion] = useState<PromotionState | null>(null)
  const [stableHealth, setStableHealth] = useState<InstanceHealth | null>(null)
  const [allowDirty, setAllowDirty] = useState(false)
  const [longTaskThreshold, setLongTaskThreshold] = useState(120)
  const promotionFailure = promotion?.state === 'failed'
    ? [...promotion.events].reverse().find((event) => event.status === 'failed')
    : null
  const promotionActivity = promotion?.state === 'running'
    ? promotion.events.at(-1) ?? null
    : null

  useEffect(() => {
    let ignore = false
    void getSettings()
      .then((settings) => {
        if (ignore) return
        setScope(settings.filesystemScope ?? DEFAULT_SCOPE)
        setLongTaskThreshold(settings.longTaskThresholdSeconds ?? 120)
        const stored = { ...DEFAULT_ACTION_FORMAT, ...(settings.actionFormat ?? {}) }
        setFormat(stored)
        setTodoDraft(stored.todoHeadings.join(', '))
        setFollowUpDraft(stored.followUpHeadings.join(', '))
        setIntegrationTokens({
          clickup: settings.integrationTokens?.clickup === true,
          gitlab: settings.integrationTokens?.gitlab === true,
        })
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

  useEffect(() => {
    if (instance?.instance !== 'dev') return
    let ignore = false
    async function refresh() {
      const [nextPromotion, nextStable] = await Promise.all([getPromotion(), getStableHealth()])
      if (ignore) return
      setPromotion(nextPromotion)
      setStableHealth('running' in nextStable ? null : nextStable)
    }
    void refresh().catch((loadError: unknown) => {
      if (!ignore) setError(errorMessage(loadError))
    })
    const timer = setInterval(() => void refresh().catch((loadError: unknown) => {
      if (!ignore) setError(errorMessage(loadError))
    }), 1_000)
    return () => {
      ignore = true
      clearInterval(timer)
    }
  }, [instance?.instance])

  async function promote(options: { force?: boolean; skipBuild?: boolean } = {}) {
    setError(null)
    try {
      setPromotion(await startPromotion(options))
    } catch (promotionError: unknown) {
      setError(errorMessage(promotionError))
    }
  }

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

  async function handleTokenSave(name: 'clickup' | 'gitlab') {
    setTokenSaving(true)
    setTokenSaved(false)
    setError(null)
    try {
      const settings = await updateIntegrationTokens({ [name]: tokenDrafts[name].trim() || undefined })
      setIntegrationTokens({
        clickup: settings.integrationTokens?.clickup === true,
        gitlab: settings.integrationTokens?.gitlab === true,
      })
      setTokenDrafts((current) => ({ ...current, [name]: '' }))
      setTokenSaved(true)
    } catch (saveError: unknown) {
      setError(errorMessage(saveError))
    } finally {
      setTokenSaving(false)
    }
  }

  async function handleTokenClear(name: 'clickup' | 'gitlab') {
    setTokenSaving(true)
    setTokenSaved(false)
    setError(null)
    try {
      const settings = await updateIntegrationTokens({ [name]: null })
      setIntegrationTokens({
        clickup: settings.integrationTokens?.clickup === true,
        gitlab: settings.integrationTokens?.gitlab === true,
      })
      setTokenDrafts((current) => ({ ...current, [name]: '' }))
      setTokenSaved(true)
    } catch (saveError: unknown) {
      setError(errorMessage(saveError))
    } finally {
      setTokenSaving(false)
    }
  }

  async function handleLongTaskThresholdSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const settings = await updateSettings({ longTaskThresholdSeconds: longTaskThreshold })
      setLongTaskThreshold(settings.longTaskThresholdSeconds ?? longTaskThreshold)
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

      {instance?.instance === 'dev' ? (
        <div className="settings-card" id="settings-instance">
          <div>
            <h2>Instance</h2>
            <p>Cette instance (dev) : <code>{instance.build.sha}{instance.build.dirty ? '*' : ''}</code></p>
            <p>
              Instance stable : {stableHealth
                ? <><code>{stableHealth.build.sha}</code> · démarrée le {new Date(stableHealth.startedAt).toLocaleString('fr-FR')}</>
                : 'non lancée'}
            </p>
          </div>
          {instance.build.dirty ? (
            <label className="settings-checkbox-label">
              <input type="checkbox" checked={allowDirty} onChange={(event) => setAllowDirty(event.target.checked)} />
              Autoriser un arbre modifié
            </label>
          ) : null}
          <div className="settings-token-actions">
            <button
              type="button"
              className="primary-button"
              disabled={promotion?.state === 'running' || (instance.build.dirty && !allowDirty)}
              onClick={() => void promote()}
            >
              Promouvoir cette version
            </button>
            {promotion?.state === 'running' ? (
              <>
                <button type="button" className="secondary-button" onClick={() => void cancelPromotion().then(setPromotion)}>Annuler</button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void cancelPromotion().then(() => promote({ force: true, skipBuild: true }))}
                >
                  Forcer la bascule
                </button>
              </>
            ) : null}
          </div>
          {instance.build.dirty && !allowDirty ? <p className="settings-help">Valider ou remiser les changements d’abord.</p> : null}
          {promotion?.state === 'running' ? (
            <div className="settings-promotion-activity" role="status" aria-live="polite">
              <strong>Promotion en cours</strong>
              <span>
                {promotionActivity
                  ? `${promotionActivity.step} · ${promotionActivity.message}`
                  : 'Démarrage…'}
              </span>
            </div>
          ) : null}
          {promotion?.state === 'failed' ? (
            <div className="settings-promotion-error" role="alert">
              <strong>Promotion échouée</strong>
              <span>
                {promotionFailure
                  ? `${promotionFailure.step} · ${promotionFailure.message}`
                  : 'La promotion n’a pas pu être terminée. Relance-la après correction.'}
              </span>
            </div>
          ) : null}
          {promotion ? (
            <ol className="settings-promotion-steps">
              {PROMOTION_STEPS.map((step) => {
                const last = [...promotion.events].reverse().find((event) => event.step === step)
                return <li key={step} className={promotion.steps[step] ? `is-${promotion.steps[step]}` : ''}>
                  <strong>{step}</strong>{last ? ` · ${last.message}` : ''}
                </li>
              })}
            </ol>
          ) : null}
        </div>
      ) : null}

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
          Les racines <code>~/.claude</code>, <code>~/.codex</code> et <code>~/.grok</code> restent accessibles
          dans les deux modes.
        </p>
        {saved ? <p className="settings-success" role="status">Paramètre enregistré.</p> : null}
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
      </div>

      <div className="settings-card">
        <div>
          <h2>Notifications de fin de tâche</h2>
          <p>Notifier quand une tâche interactive dépasse cette durée.</p>
        </div>
        <label className="settings-select-label" htmlFor="app-long-task-threshold">
          Seuil en secondes
          <input
            id="app-long-task-threshold"
            type="number"
            min={10}
            max={86400}
            value={longTaskThreshold}
            disabled={loading || saving}
            onChange={(event) => setLongTaskThreshold(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={loading || saving}
          onClick={() => void handleLongTaskThresholdSave()}
        >
          Enregistrer le seuil
        </button>
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

      <div className="settings-card">
        <div>
          <h2>Tokens d’intégration</h2>
          <p>
            Les valeurs restent écrites côté sidecar. L’interface n’affiche ensuite
            qu’un statut « défini » ou « non défini ».
          </p>
        </div>

        <div className="settings-token-list">
          <div className="settings-token-row">
            <div className="settings-token-heading">
              <strong>ClickUp</strong>
              <span aria-label="Statut token ClickUp">
                {integrationTokens.clickup ? 'défini' : 'non défini'}
              </span>
            </div>
            <label className="settings-select-label" htmlFor="app-clickup-token">
              Token ClickUp
              <input
                id="app-clickup-token"
                type="password"
                value={tokenDrafts.clickup}
                disabled={loading || tokenSaving}
                onChange={(event) => setTokenDrafts((current) => ({
                  ...current,
                  clickup: event.target.value,
                }))}
              />
            </label>
            <div className="settings-token-actions">
              <button
                type="button"
                className="primary-button"
                disabled={loading || tokenSaving}
                onClick={() => void handleTokenSave('clickup')}
              >
                Enregistrer les tokens
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={loading || tokenSaving}
                onClick={() => void handleTokenClear('clickup')}
              >
                Effacer le token ClickUp
              </button>
            </div>
          </div>

          <div className="settings-token-row">
            <div className="settings-token-heading">
              <strong>GitLab</strong>
              <span aria-label="Statut token GitLab">
                {integrationTokens.gitlab ? 'défini' : 'non défini'}
              </span>
            </div>
            <label className="settings-select-label" htmlFor="app-gitlab-token">
              Token GitLab (optionnel si glab est connecté)
              <input
                id="app-gitlab-token"
                type="password"
                value={tokenDrafts.gitlab}
                disabled={loading || tokenSaving}
                onChange={(event) => setTokenDrafts((current) => ({
                  ...current,
                  gitlab: event.target.value,
                }))}
              />
            </label>
            <div className="settings-token-actions">
              <button
                type="button"
                className="primary-button"
                disabled={loading || tokenSaving}
                onClick={() => void handleTokenSave('gitlab')}
              >
                Enregistrer le token GitLab
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={loading || tokenSaving}
                onClick={() => void handleTokenClear('gitlab')}
              >
                Effacer le token GitLab
              </button>
            </div>
          </div>
        </div>

        {tokenSaved ? <p className="settings-success" role="status">Tokens enregistrés.</p> : null}
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
