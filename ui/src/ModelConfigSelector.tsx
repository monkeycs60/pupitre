import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ConversationConfig } from './ConfigPanel'
import {
  AUTONOMY_LEVELS,
  EFFORT_HINTS,
  formatModelPrice,
  modelCostTicks,
  modelCostTone,
  modelLabel,
  MODEL_COST_TICKS,
  MODEL_HINTS,
  PROVIDER_EFFORTS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  PROVIDERS,
  relativeCostLabel,
} from './modelOptions'
import { HelpLink } from './HelpLink'
import { ProviderMark } from './ProviderMark'
import { quotaSummary } from './quotaSignals'
import type {
  ConversationSpeed,
  PresetPermissionMode,
  Provider,
  QuotaSnapshot,
} from './types'

type Panel = 'model' | 'effort' | 'settings' | null

export interface ModelConfigSelectorProps {
  config: ConversationConfig
  quotas: QuotaSnapshot
  /** Autonomie appliquée quand la conversation hérite du projet. */
  projectPermissionMode?: PresetPermissionMode
  isLoading?: boolean
  isBusy?: boolean
  /** Certains contextes ne peuvent modifier que le modèle, l'effort et la vitesse. */
  showConversationSettings?: boolean
  onConfigChange: (config: ConversationConfig) => void
  placement?: 'top' | 'bottom'
}

function autonomyLevel(permission: PresetPermissionMode) {
  return AUTONOMY_LEVELS.find((level) => level.mode === permission) ?? null
}

function permissionLabel(permission: PresetPermissionMode | null): string {
  if (permission === null) return 'Hériter du projet'
  return autonomyLevel(permission)?.label ?? permission
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
    <svg className="model-strip-check" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="m2.5 7.5 3 3 6-6.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Chevron() {
  return (
    <svg className="model-strip-chevron" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="m2 4 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Sliders() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
      <path d="M2 5h5M11 5h3M2 11h3M9 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="9" cy="5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7" cy="11" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** Rang de l'autonomie sur l'échelle, dans le vocabulaire de la jauge d'effort. */
function AutonomyGauge({ level, tone, muted = false }: {
  level: number
  tone: 'ok' | 'accent' | 'warn' | 'danger'
  muted?: boolean
}) {
  return (
    <span
      className={`model-strip-steps autonomy-gauge is-${tone}${muted ? ' is-muted' : ''}`}
      aria-hidden="true"
    >
      {AUTONOMY_LEVELS.map((_, index) => (
        <i key={index} className={index <= level ? 'is-on' : ''} />
      ))}
    </span>
  )
}

function EffortGauge({ level, count }: { level: number; count: number }) {
  return (
    <span className="model-strip-steps" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <i key={index} className={index <= level ? 'is-on' : ''} />
      ))}
    </span>
  )
}

function Ticks({ filled, tone }: { filled: number; tone: 'ok' | 'warn' | 'danger' }) {
  return (
    <span className="model-strip-ticks" aria-hidden="true">
      {Array.from({ length: MODEL_COST_TICKS }, (_, index) => (
        <i key={index} className={index < filled ? toneClass(tone) : ''} />
      ))}
    </span>
  )
}

function CostBar({ model, tone }: { model: string; tone: 'ok' | 'warn' | 'danger' }) {
  return (
    <span className={`model-strip-bar ${toneClass(tone)}`} aria-hidden="true">
      <i style={{ width: `${modelCostTicks(model) / MODEL_COST_TICKS * 100}%` }} />
    </span>
  )
}

/**
 * Réglette de lancement : provider, modèle, effort côte à côte ; vitesse et
 * autonomie dans le panneau des réglages du tour.
 */
export function ModelConfigSelector({
  config,
  quotas,
  projectPermissionMode = 'acceptEdits',
  isLoading = false,
  isBusy = false,
  showConversationSettings = true,
  onConfigChange,
  placement = 'top',
}: ModelConfigSelectorProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Revenir à un provider redonne le modèle qu'on y avait laissé.
  const lastModelRef = useRef<Record<Provider, string>>({
    codex: PROVIDER_MODELS.codex[0],
    claude: PROVIDER_MODELS.claude[0],
    grok: PROVIDER_MODELS.grok[0],
  })
  const disabled = isLoading || isBusy
  const efforts = PROVIDER_EFFORTS[config.provider] as readonly string[]
  const effortLevel = Math.max(0, efforts.indexOf(config.effort))
  const inheritedIndex = AUTONOMY_LEVELS.findIndex((level) => level.mode === projectPermissionMode)
  const inherited = AUTONOMY_LEVELS[inheritedIndex] ?? AUTONOMY_LEVELS[2]!
  const hasSettingsPanel = showConversationSettings || config.provider === 'codex'

  useEffect(() => {
    lastModelRef.current[config.provider] = config.model
  }, [config.provider, config.model])

  // Le panneau est ancré à sa cellule, mais la liste des modèles est plus large
  // que la réglette et le composer touche le bas de la fenêtre.
  useLayoutEffect(() => {
    if (panel === null) return
    const element = rootRef.current?.querySelector('.model-strip-pop') as HTMLElement | null
    const anchor = element?.parentElement
    if (!element || !anchor) return
    element.style.left = '0px'
    element.style.maxHeight = ''
    const pad = 8
    const anchorRect = anchor.getBoundingClientRect()
    const overflowRight = element.getBoundingClientRect().right - (window.innerWidth - pad)
    if (overflowRight > 0) element.style.left = `${-overflowRight}px`
    const available = placement === 'bottom'
      ? window.innerHeight - anchorRect.bottom - 6 - pad
      : anchorRect.top - 6 - pad
    if (element.getBoundingClientRect().height > available) {
      element.style.maxHeight = `${Math.max(160, Math.round(available))}px`
    }
  }, [panel, placement])

  useEffect(() => {
    if (panel === null) return
    function closeWhenClickingAway(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setPanel(null)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPanel(null)
    }
    document.addEventListener('mousedown', closeWhenClickingAway)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeWhenClickingAway)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [panel])

  function patch(change: Partial<ConversationConfig>) {
    onConfigChange({ ...config, ...change })
  }

  function chooseProvider(provider: Provider) {
    if (provider === config.provider) return
    const nextEfforts = PROVIDER_EFFORTS[provider] as readonly string[]
    onConfigChange({
      ...config,
      provider,
      model: lastModelRef.current[provider],
      effort: nextEfforts.includes(config.effort) ? config.effort : 'high',
      speed: provider === 'codex' ? config.speed : 'standard',
    })
    setPanel(null)
  }

  function toggle(next: Exclude<Panel, null>) {
    setPanel((current) => current === next ? null : next)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (panel === null || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    const open = rootRef.current?.querySelector('.model-strip-pop')
    if (!(event.target instanceof HTMLElement) || !open?.contains(event.target)) return
    const buttons = Array.from(open.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const offset = event.key === 'ArrowDown' ? 1 : -1
    buttons[(index + offset + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div className={`model-strip opens-${placement}`} ref={rootRef} onKeyDown={handleKeyDown}>
      <div className="model-strip-providers" role="radiogroup" aria-label="Provider">
        {PROVIDERS.map((provider) => {
          const quota = providerQuota(provider, quotas)
          return (
            <button
              type="button"
              key={provider}
              role="radio"
              aria-checked={provider === config.provider}
              aria-label={PROVIDER_LABELS[provider]}
              title={`${PROVIDER_LABELS[provider]} · ${quota.label}`}
              className={`model-strip-provider is-${provider}${provider === config.provider ? ' is-active' : ''}`}
              disabled={disabled}
              onClick={() => chooseProvider(provider)}
            >
              <ProviderMark provider={provider} />
              {quota.tone !== 'ok' ? <i className={`model-strip-alert ${toneClass(quota.tone)}`} aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>

      <div className="model-strip-cell">
        <button
          type="button"
          className="model-strip-trigger"
          aria-label="Modèle"
          aria-haspopup="menu"
          aria-expanded={panel === 'model'}
          disabled={disabled}
          onClick={() => toggle('model')}
        >
          <span className="model-strip-value">{modelLabel(config.model)}</span>
          <Chevron />
        </button>
        {panel === 'model' ? (
          <section className="model-strip-pop model-strip-models" role="menu" aria-label="Choisir un modèle">
            <header>
              <strong>{PROVIDER_LABELS[config.provider]}</strong>
              <span className={toneClass(providerQuota(config.provider, quotas).tone)}>
                {providerQuota(config.provider, quotas).label}
              </span>
              <Ticks {...providerQuota(config.provider, quotas)} />
            </header>
            {PROVIDER_MODELS[config.provider].map((model) => {
              const isSelected = model === config.model
              const tone = modelCostTone(model)
              return (
                <button
                  type="button"
                  key={model}
                  role="menuitemradio"
                  aria-checked={isSelected}
                  aria-label={modelLabel(model)}
                  className={`model-strip-model${isSelected ? ' is-selected' : ''}`}
                  onClick={() => { patch({ model }); setPanel(null) }}
                >
                  <span className="model-strip-check-slot">{isSelected ? <Checkmark /> : null}</span>
                  <span className="model-strip-model-id">
                    <strong>{modelLabel(model)}</strong>
                    <small>{MODEL_HINTS[model] ?? ''}</small>
                  </span>
                  <span className="model-strip-model-cost">
                    <span className="model-strip-cost-line">
                      <CostBar model={model} tone={tone} />
                      <b className={toneClass(tone)}>{relativeCostLabel(model, config.model)}</b>
                    </span>
                    <small>{formatModelPrice(model)}</small>
                  </span>
                </button>
              )
            })}
            <footer>Jauge : coût relatif d’un échange type. Les prix API sont indicatifs et ne sont pas facturés sur abonnement.</footer>
          </section>
        ) : null}
      </div>

      <div className="model-strip-cell">
        <button
          type="button"
          className="model-strip-trigger"
          aria-label="Effort"
          aria-haspopup="menu"
          aria-expanded={panel === 'effort'}
          disabled={disabled}
          onClick={() => toggle('effort')}
        >
          <EffortGauge level={effortLevel} count={efforts.length} />
          <span className="model-strip-value">{config.effort}</span>
          <Chevron />
        </button>
        {panel === 'effort' ? (
          <section className="model-strip-pop model-strip-efforts" role="menu" aria-label="Choisir l’effort">
            {efforts.map((effort, index) => (
              <button
                type="button"
                key={effort}
                role="menuitemradio"
                aria-checked={config.effort === effort}
                className={config.effort === effort ? 'is-selected' : ''}
                onClick={() => { patch({ effort }); setPanel(null) }}
              >
                <span className="model-strip-check-slot">{config.effort === effort ? <Checkmark /> : null}</span>
                <EffortGauge level={index} count={efforts.length} />
                <strong>{effort}</strong>
                <small>{EFFORT_HINTS[effort] ?? ''}</small>
              </button>
            ))}
          </section>
        ) : null}
      </div>

      {hasSettingsPanel ? (
        <div className="model-strip-cell">
          <button
            type="button"
            className={`model-strip-trigger is-icon${config.permissionMode === 'bypassPermissions' ? ' is-danger' : ''}`}
            aria-label="Réglages du tour"
            title={showConversationSettings
              ? `Autonomie : ${permissionLabel(config.permissionMode)}`
              : `Vitesse : ${speedLabel(config.speed)}`}
            aria-haspopup="menu"
            aria-expanded={panel === 'settings'}
            disabled={disabled}
            onClick={() => toggle('settings')}
          >
            <Sliders />
          </button>
          {panel === 'settings' ? (
            <section className="model-strip-pop model-strip-settings" role="menu" aria-label="Réglages du tour">
              {config.provider === 'codex' ? (
                <>
                  <p className="model-strip-section">Vitesse</p>
                  {(['standard', 'fast'] as const).map((speed) => (
                    <button
                      type="button"
                      key={speed}
                      role="menuitemradio"
                      aria-checked={config.speed === speed}
                      className={config.speed === speed ? 'is-selected' : ''}
                      onClick={() => patch({ speed })}
                    >
                      <span className="model-strip-check-slot">{config.speed === speed ? <Checkmark /> : null}</span>
                      {speedLabel(speed)}
                    </button>
                  ))}
                </>
              ) : null}

              {showConversationSettings ? (
                <>
                  <p className="model-strip-section">Autonomie</p>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={config.permissionMode === null}
                    className={`autonomy-option is-inherit${config.permissionMode === null ? ' is-selected' : ''}`}
                    onClick={() => patch({ permissionMode: null })}
                  >
                    <span className="model-strip-check-slot">{config.permissionMode === null ? <Checkmark /> : null}</span>
                    <AutonomyGauge level={inheritedIndex} tone={inherited.tone} muted />
                    <span className="autonomy-text">
                      <strong>Hériter du projet</strong>
                      <small>Suit le réglage du projet : {inherited.label.toLowerCase()}.</small>
                    </span>
                  </button>
                  <p className="autonomy-scale">Du plus borné au plus ouvert</p>
                  {AUTONOMY_LEVELS.map((level, index) => (
                    <button
                      type="button"
                      key={level.mode}
                      role="menuitemradio"
                      aria-checked={config.permissionMode === level.mode}
                      className={`autonomy-option is-${level.tone}${config.permissionMode === level.mode ? ' is-selected' : ''}`}
                      onClick={() => patch({ permissionMode: level.mode })}
                    >
                      <span className="model-strip-check-slot">{config.permissionMode === level.mode ? <Checkmark /> : null}</span>
                      <AutonomyGauge level={index} tone={level.tone} />
                      <span className="autonomy-text">
                        <strong>{level.label}</strong>
                        <small>{level.hint}</small>
                      </span>
                    </button>
                  ))}
                  <p className="autonomy-help">
                    <HelpLink slug="autonomie" label="Ce que chaque rang autorise" />
                  </p>
                </>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {showConversationSettings && config.permissionMode === 'bypassPermissions' ? (
        <span className="model-strip-yolo">YOLO</span>
      ) : null}
    </div>
  )
}
