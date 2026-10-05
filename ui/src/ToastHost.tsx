import type { CSSProperties } from 'react'
import { dismissToast, removeToast, useToasts, type Toast } from './toasts'

function ToneIcon({ tone }: { tone: Toast['tone'] }) {
  if (tone === 'danger') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  if (tone === 'info') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 5.5v3M6 3.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.2 5 8.5l4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ToastHost() {
  const toasts = useToasts()
  if (toasts.length === 0) return null

  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-id={toast.id}
          className={`toast is-${toast.tone}${toast.leaving ? ' is-leaving' : ''}`}
          role={toast.tone === 'danger' ? 'alert' : 'status'}
          style={{ '--toast-life': `${toast.durationMs}ms` } as CSSProperties}
          onAnimationEnd={(event) => {
            if (event.animationName === 'toast-out') removeToast(toast.id)
          }}
        >
          <span className="toast-icon"><ToneIcon tone={toast.tone} /></span>
          <button
            type="button"
            className="toast-body"
            disabled={toast.onOpen === undefined}
            onClick={() => {
              toast.onOpen?.()
              dismissToast(toast.id)
            }}
          >
            <strong>{toast.title}</strong>
            {toast.detail ? <span>{toast.detail}</span> : null}
          </button>
          <button type="button" className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Fermer la notification">×</button>
          <span
            className="toast-life"
            aria-hidden="true"
            onAnimationEnd={(event) => {
              event.stopPropagation()
              dismissToast(toast.id)
            }}
          />
        </div>
      ))}
    </div>
  )
}
