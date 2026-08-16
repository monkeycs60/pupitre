export type Surface = 'conversation' | 'code'

interface SurfaceSwitchProps {
  active: Surface
  dirtyCount?: number
  onConversation: () => void
  onCode: () => void
}

export function SurfaceSwitch({ active, dirtyCount = 0, onConversation, onCode }: SurfaceSwitchProps) {
  return (
    <div className={`surface-switch is-${active}`} role="tablist" aria-label="Surface de travail">
      <span className="surface-switch-thumb" aria-hidden="true" />
      <button
        type="button"
        role="tab"
        aria-selected={active === 'conversation'}
        className={active === 'conversation' ? 'is-active' : undefined}
        onClick={() => { if (active !== 'conversation') onConversation() }}
      >
        Conversation
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'code'}
        className={active === 'code' ? 'is-active' : undefined}
        onClick={() => { if (active !== 'code') onCode() }}
      >
        Code{dirtyCount > 0 ? <span className="surface-switch-badge">{dirtyCount}</span> : null}
      </button>
    </div>
  )
}
