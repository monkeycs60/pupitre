import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ConversationConfig } from './ConfigPanel'
import {
  formatModelPrice,
  modelCostTicks,
  modelCostTone,
  modelLabel,
  MODEL_COST_TICKS,
  MODEL_PRICING,
  PROVIDER_EFFORTS,
  relativeCostLabel,
} from './modelOptions'
import { quotaSummary } from './quotaSignals'
import type {
  ConversationSpeed,
  Preset,
  PresetPermissionMode,
  Provider,
  QuotaSnapshot,
} from './types'

type Submenu = 'model' | 'effort' | 'speed' | 'permission' | 'subagents' | null

export interface ModelConfigSelectorProps {
  config: ConversationConfig
  presets: Preset[]
  selectedPresetId: string
  quotas: QuotaSnapshot
  isLoading?: boolean
  isBusy?: boolean
  isDefault?: boolean
  /** Certains contextes ne peuvent modifier que le modèle, l'effort et la vitesse. */
  showConversationSettings?: boolean
  onConfigChange: (config: ConversationConfig) => void
  onPresetSelect: (preset: Preset) => void
  onSaveAs?: () => void
  onOverwrite?: () => void
  onRevert?: () => void
  onRename?: () => void
  onDelete?: () => void
  onRestore?: () => void
  onToggleDefault?: () => void
  onHelp?: () => void
  placement?: 'top' | 'bottom'
  submenuPlacement?: 'left' | 'right'
}

function configOf(preset: Preset): ConversationConfig {
  return {
    presetId: preset.id,
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort ?? 'high',
    speed: preset.speed ?? 'standard',
    permissionMode: preset.permission_mode ?? null,
    orchestrator: preset.orchestrator,
    subagentPresetId: preset.subagent_preset_id ?? null,
    subagentEffort: preset.subagent_effort ?? null,
  }
}

function sameConfig(left: ConversationConfig, right: ConversationConfig): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.effort === right.effort
    && left.orchestrator === right.orchestrator
    && left.subagentPresetId === right.subagentPresetId
    && left.subagentEffort === right.subagentEffort
    && left.permissionMode === right.permissionMode
    && (left.provider === 'codex' ? left.speed === right.speed : true)
}

function selectorModelLabel(model: string): string {
  return modelLabel(model).replace(/^GPT-/, '')
}

function configSummary(config: ConversationConfig): string {
  return `${selectorModelLabel(config.model).toLowerCase()} · ${config.effort}${config.provider === 'codex' && config.speed === 'fast' ? ' · rapide' : ''}`
}

function permissionLabel(permission: PresetPermissionMode | null): string {
  switch (permission) {
    case 'default': return 'Par défaut'
    case 'acceptEdits': return 'Éditions acceptées'
    case 'plan': return 'Lecture seule'
    case 'dontAsk': return 'Autonome'
    case 'bypassPermissions': return 'YOLO'
    default: return 'Hériter du projet'
  }
}

function speedLabel(speed: ConversationSpeed): string {
  return speed === 'fast' ? 'Rapide 1,5×' : 'Standard'
}

function toneClass(tone: 'ok' | 'warn' | 'danger'): string {
  return `is-${tone}`
}

function providerQuota(provider: Provider, quotas: QuotaSnapshot): {
  label: string
  filled: number
  tone: 'ok' | 'warn' | 'danger'
} {
  const summary = quotaSummary(provider, quotas[provider] ?? null)
  const remaining = summary.usedPercent === null ? null : Math.max(0, 100 - summary.usedPercent)
  return {
    label: remaining === null ? 'quota indisponible' : `${Math.round(remaining)} % restants · ${summary.note ?? 'réinitialisation inconnue'}`,
    filled: remaining === null ? 0 : Math.round(remaining / 100 * MODEL_COST_TICKS),
    tone: remaining === null || remaining >= 60 ? 'ok' : remaining >= 25 ? 'warn' : 'danger',
  }
}

function Checkmark() {
  return (
    <svg className="preset-selector-check" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="m2.5 7.5 3 3 6-6.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Chevron({ direction = 'right' }: { direction?: 'right' | 'down' }) {
  return (
    <svg className={`preset-selector-chevron is-${direction}`} viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d={direction === 'down' ? 'm2 4 3 3 3-3' : 'm4 2 3 3-3 3'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Le même sélecteur compact est placé dans le composer et dans la modale de
 * bascule. Les opérations de persistance restent injectées par ConfigPanel.
 */
export function ModelConfigSelector({
  config,
  presets,
  selectedPresetId,
  quotas,
  isLoading = false,
  isBusy = false,
  isDefault = false,
  showConversationSettings = true,
  onConfigChange,
  onPresetSelect,
  onSaveAs,
  onOverwrite,
  onRevert,
  onRename,
  onDelete,
  onRestore,
  onToggleDefault,
  onHelp,
  placement = 'top',
  submenuPlacement = 'right',
}: ModelConfigSelectorProps) {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<Submenu>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null
  const selectedSubagentPreset = presets.find((preset) => preset.id === config.subagentPresetId) ?? null
  const subagentEfforts = selectedSubagentPreset
    ? PROVIDER_EFFORTS[selectedSubagentPreset.provider]
    : ['low', 'medium', 'high', 'xhigh']
  const isDirty = selectedPreset !== null && !sameConfig(config, configOf(selectedPreset))
  const summary = configSummary(config)

  // Le sous-menu est ancré au bouton, mais la liste des modèles dépasse souvent le viewport.
  useLayoutEffect(() => {
    if (!open || submenu === null) return
    const el = rootRef.current?.querySelector('.preset-selector-submenu') as HTMLElement | null
    if (!el) return
    el.style.top = '0px'
    el.style.maxHeight = ''
    const pad = 8
    const first = el.getBoundingClientRect()
    const overflowBottom = first.bottom - (window.innerHeight - pad)
    if (overflowBottom > 0) el.style.top = `${-overflowBottom}px`
    const next = el.getBoundingClientRect()
    if (next.top >= pad) return
    el.style.top = `${parseFloat(el.style.top || '0') + (pad - next.top)}px`
    el.style.maxHeight = `${window.innerHeight - pad * 2}px`
  }, [open, submenu])

  useEffect(() => {
    if (!open) return
    function closeWhenClickingAway(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setSubmenu(null)
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (submenu !== null) setSubmenu(null)
      else setOpen(false)
    }
    document.addEventListener('mousedown', closeWhenClickingAway)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeWhenClickingAway)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, submenu])

  function patch(change: Partial<ConversationConfig>) {
    onConfigChange({ ...config, ...change })
  }

  function chooseModel(model: string, provider: Provider) {
    onConfigChange(provider === config.provider
      ? { ...config, model }
      : { ...config, provider, model, effort: 'high', speed: 'standard' })
    setSubmenu(null)
  }

  function choosePreset(preset: Preset) {
    onPresetSelect(preset)
    setSubmenu(null)
  }

  function toggleSubmenu(next: Exclude<Submenu, null>) {
    setSubmenu((current) => current === next ? null : next)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) return
    const target = event.target
    if (!(target instanceof HTMLButtonElement)) return

    const nextSubmenu = ({
      Modèle: 'model',
      Effort: 'effort',
      Vitesse: 'speed',
      Autonomie: 'permission',
      'Sub-agents': 'subagents',
    } as const)[target.getAttribute('aria-label') ?? '']

    if (event.key === 'ArrowRight' && nextSubmenu) {
      event.preventDefault()
      setSubmenu(nextSubmenu)
      return
    }
    if (event.key === 'ArrowLeft' && submenu !== null) {
      event.preventDefault()
      setSubmenu(null)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

    const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      .filter((button) => button !== target.closest('.preset-selector')?.querySelector('.preset-selector-chip'))
    const index = buttons.indexOf(target)
    if (index < 0 || buttons.length === 0) return
    event.preventDefault()
    const offset = event.key === 'ArrowDown' ? 1 : -1
    buttons[(index + offset + buttons.length) % buttons.length]?.focus()
  }

  const chipName = selectedPreset?.name ?? 'Réglages libres'

  return (
    <div className={`preset-selector opens-${placement} submenus-${submenuPlacement}`} ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className={`preset-selector-chip${isDirty ? ' is-dirty' : ''}${selectedPreset === null ? ' is-free' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={isLoading || isBusy}
        onClick={() => {
          setOpen((current) => !current)
          setSubmenu(null)
        }}
      >
        <span className="preset-selector-chip-dot" aria-hidden="true" />
        <span className="preset-selector-chip-name">{chipName}</span>
        {isDirty ? <span className="preset-selector-chip-dirty">modifié</span> : null}
        <span className="preset-selector-chip-summary">{summary}</span>
        <Chevron direction="down" />
      </button>

      {open ? (
        <div className="preset-selector-popovers">
          <section className="preset-selector-menu" role="menu" aria-label="Configuration de la conversation">
            {isDirty && selectedPreset ? (
              <div className="preset-selector-dirty-actions">
                <p>Réglages différents de {selectedPreset.name}</p>
                <span>{summary} au lieu de {configSummary(configOf(selectedPreset))}</span>
                {onSaveAs ? <button type="button" onClick={() => { onSaveAs(); setOpen(false) }}>Enregistrer comme preset…</button> : null}
                {onOverwrite ? <button type="button" onClick={() => { onOverwrite(); setOpen(false) }}>Écraser {selectedPreset.name}</button> : null}
                {onRevert ? <button type="button" onClick={onRevert}>Revenir à {selectedPreset.name}</button> : null}
              </div>
            ) : null}

            <div className="preset-selector-heading">Presets</div>
            <div className="preset-selector-list" aria-label="Presets disponibles">
              {presets.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  role="menuitemradio"
                  aria-checked={preset.id === selectedPresetId}
                  className={`preset-selector-preset${preset.id === selectedPresetId ? ' is-selected' : ''}`}
                  onClick={() => choosePreset(preset)}
                >
                  <span>{preset.id === selectedPresetId ? <Checkmark /> : null}</span>
                  <span>{preset.name}</span>
                  <span>{isDefault && preset.id === selectedPresetId ? 'défaut' : configSummary(configOf(preset))}</span>
                </button>
              ))}
              {presets.length === 0 ? <p className="preset-selector-empty">Aucun preset enregistré.</p> : null}
            </div>

            <div className="preset-selector-divider" />
            <div className="preset-selector-settings">
              <div className="preset-selector-setting">
                <button type="button" aria-label="Modèle" onClick={() => toggleSubmenu('model')}>
                  <span>Modèle</span><span>{selectorModelLabel(config.model)}</span><Chevron />
                </button>
                {submenu === 'model' ? (
                  <section className="preset-selector-submenu preset-selector-model-menu" role="menu" aria-label="Choisir un modèle">
                    {(['codex', 'claude', 'grok'] as const).map((provider) => {
                      const quota = providerQuota(provider, quotas)
                      return (
                        <div className="preset-selector-provider" key={provider}>
                          <header>
                            <div><strong>{provider}</strong><span className={toneClass(quota.tone)}>{quota.label}</span></div>
                            <div className="preset-selector-quota-ticks" aria-hidden="true">
                              {Array.from({ length: MODEL_COST_TICKS }, (_, index) => <i key={index} className={index < quota.filled ? toneClass(quota.tone) : ''} />)}
                            </div>
                          </header>
                          {MODEL_PRICING.filter((pricing) => pricing.provider === provider).map((pricing) => {
                            const isSelected = pricing.model === config.model
                            const tone = modelCostTone(pricing.model)
                            return (
                              <button
                                type="button"
                                key={pricing.model}
                                role="menuitemradio"
                                aria-checked={isSelected}
                                aria-label={selectorModelLabel(pricing.model)}
                                className={`preset-selector-model${isSelected ? ' is-selected' : ''}`}
                                onClick={() => chooseModel(pricing.model, provider)}
                              >
                                <span>{isSelected ? <Checkmark /> : null}</span>
                                <span>{selectorModelLabel(pricing.model)}</span>
                                <span className="preset-selector-cost-ticks" aria-hidden="true">
                                  {Array.from({ length: MODEL_COST_TICKS }, (_, index) => <i key={index} className={index < modelCostTicks(pricing.model) ? toneClass(tone) : ''} />)}
                                </span>
                                <span>{modelCostTicks(pricing.model) === 1 ? 'le moins cher' : modelCostTicks(pricing.model) === MODEL_COST_TICKS ? 'le plus cher' : ''}</span>
                                <strong className={toneClass(tone)}>{relativeCostLabel(pricing.model, config.model)}</strong>
                                <span>{formatModelPrice(pricing.model)}</span>
                              </button>
                            )
                          })}
                        </div>
                      )
                    })}
                    <footer>Jauge : coût relatif d’un échange type. Les prix API sont indicatifs et ne sont pas facturés sur abonnement.</footer>
                  </section>
                ) : null}
              </div>
              <div className="preset-selector-setting">
                <button type="button" aria-label="Effort" onClick={() => toggleSubmenu('effort')}>
                  <span>Effort</span><span>{config.effort}</span><Chevron />
                </button>
                {submenu === 'effort' ? (
                  <section className="preset-selector-submenu preset-selector-option-menu" role="menu" aria-label="Choisir l’effort">
                    {PROVIDER_EFFORTS[config.provider].map((effort) => (
                      <button type="button" key={effort} role="menuitemradio" aria-checked={config.effort === effort} onClick={() => { patch({ effort }); setSubmenu(null) }}>
                        <span>{config.effort === effort ? <Checkmark /> : null}</span>{effort}
                      </button>
                    ))}
                  </section>
                ) : null}
              </div>
              {config.provider === 'codex' ? (
                <div className="preset-selector-setting">
                  <button type="button" aria-label="Vitesse" onClick={() => toggleSubmenu('speed')}>
                    <span>Vitesse</span><span>{speedLabel(config.speed)}</span><Chevron />
                  </button>
                  {submenu === 'speed' ? (
                    <section className="preset-selector-submenu preset-selector-option-menu" role="menu" aria-label="Choisir la vitesse">
                      {(['standard', 'fast'] as const).map((speed) => (
                        <button type="button" key={speed} role="menuitemradio" aria-checked={config.speed === speed} onClick={() => { patch({ speed }); setSubmenu(null) }}>
                          <span>{config.speed === speed ? <Checkmark /> : null}</span>{speedLabel(speed)}
                        </button>
                      ))}
                    </section>
                  ) : null}
                </div>
              ) : null}
              {showConversationSettings ? (
                <>
                  <div className="preset-selector-setting">
                    <button type="button" aria-label="Autonomie" onClick={() => toggleSubmenu('permission')}>
                      <span>Autonomie</span><span className={config.permissionMode === 'bypassPermissions' ? 'is-danger' : ''}>{permissionLabel(config.permissionMode)}</span><Chevron />
                    </button>
                    {submenu === 'permission' ? (
                      <section className="preset-selector-submenu preset-selector-option-menu" role="menu" aria-label="Choisir l’autonomie">
                        {([
                          [null, 'Hériter du projet'],
                          ['default', 'Par défaut du provider'],
                          ['acceptEdits', 'Éditions acceptées'],
                          ['plan', 'Plan / lecture seule'],
                          ['dontAsk', 'Autonome (sans demande)'],
                          ['bypassPermissions', 'YOLO · sans permissions'],
                        ] as const).map(([permission, label]) => (
                          <button type="button" key={permission ?? 'inherit'} role="menuitemradio" aria-checked={config.permissionMode === permission} className={permission === 'bypassPermissions' ? 'is-danger' : ''} onClick={() => { patch({ permissionMode: permission }); setSubmenu(null) }}>
                            <span>{config.permissionMode === permission ? <Checkmark /> : null}</span>{label}
                          </button>
                        ))}
                      </section>
                    ) : null}
                  </div>
                  <div className="preset-selector-setting">
                    <button type="button" aria-label="Sub-agents" onClick={() => toggleSubmenu('subagents')}>
                      <span>Sub-agents</span><span>{config.orchestrator ? 'Délégation auto' : 'Désactivés'}</span><Chevron />
                    </button>
                    {submenu === 'subagents' ? (
                      <section className="preset-selector-submenu preset-selector-option-menu" role="menu" aria-label="Configurer les sub-agents">
                        <button type="button" role="menuitemradio" aria-checked={config.orchestrator} onClick={() => patch({ orchestrator: !config.orchestrator })}>
                          <span>{config.orchestrator ? <Checkmark /> : null}</span>{config.orchestrator ? 'Autoriser la délégation' : 'Activer la délégation'}
                        </button>
                        {config.orchestrator ? (
                          <>
                            <label>
                              Preset imposé
                              <select value={config.subagentPresetId ?? ''} onChange={(event) => patch({ subagentPresetId: event.target.value || null, subagentEffort: null })}>
                                <option value="">Choix du modèle principal</option>
                                {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {selectorModelLabel(preset.model)}</option>)}
                              </select>
                            </label>
                            <label>
                              Effort sub-agent
                              <select value={config.subagentEffort ?? ''} onChange={(event) => patch({ subagentEffort: event.target.value || null })}>
                                <option value="">{selectedSubagentPreset ? 'Effort du preset' : 'Choix du modèle principal'}</option>
                                {subagentEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                              </select>
                            </label>
                          </>
                        ) : null}
                      </section>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>

            <div className="preset-selector-divider" />
            <div className="preset-selector-actions">
              {!isDirty && onSaveAs ? <button type="button" onClick={() => { onSaveAs(); setOpen(false) }}>Enregistrer comme preset…</button> : null}
              {selectedPreset && onRename ? <button type="button" onClick={() => { onRename(); setOpen(false) }}>Renommer {selectedPreset.name}</button> : null}
              {selectedPreset && onToggleDefault ? <button type="button" onClick={() => { onToggleDefault(); setOpen(false) }}>{isDefault ? 'Retirer le défaut du projet' : 'Définir comme défaut'}</button> : null}
              {selectedPreset?.built_in && onRestore ? <button type="button" onClick={() => { onRestore(); setOpen(false) }}>Restaurer les valeurs d’origine</button> : null}
              {selectedPreset && !selectedPreset.built_in && onDelete ? <button type="button" className="is-danger" onClick={() => { onDelete(); setOpen(false) }}>Supprimer</button> : null}
              {onHelp ? <button type="button" onClick={() => { onHelp(); setOpen(false) }}>En savoir plus sur les presets</button> : null}
            </div>
          </section>

        </div>
      ) : null}
    </div>
  )
}
