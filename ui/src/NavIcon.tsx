import type { ReactNode } from 'react'

/** Glyphes des destinations de navigation, partagés par la barre de titre et
 *  les surfaces qui listent les mêmes vues. */
export type NavName =
  | 'conversations'
  | 'fleet'
  | 'attention'
  | 'dashboard'
  | 'documents'
  | 'design'
  | 'progress'
  | 'costs'
  | 'library'
  | 'memory'
  | 'routines'
  | 'help'
  | 'settings'

const NAV_PATHS: Record<NavName, ReactNode> = {
  conversations: (
    <>
      <path d="M3 3h10v7H7l-3.5 2v-2H3Z" />
      <path d="M5.5 6h5M5.5 8h3" />
    </>
  ),
  fleet: <path d="M2 8h3l1.5-4L9 12l1.5-4H14" />,
  attention: <path d="M4 6.5a4 4 0 0 1 8 0v2.3l1.2 2H2.8l1.2-2ZM6.5 12.5h3" />,
  dashboard: <path d="M2 3h5v5H2zM9 3h5v3H9zM9 8h5v5H9zM2 10h5v3H2z" />,
  documents: (
    <>
      <path d="M3 2.5h6l3 3V14H3Z" />
      <path d="M9 2.5V6h3M5.5 9h4M5.5 11.5h4" />
    </>
  ),
  design: (
    <>
      <path d="M8 2a6 6 0 1 0 0 12h1a1.3 1.3 0 0 0 .8-2.3l-.5-.3A1.3 1.3 0 0 1 10 9h2.5A1.5 1.5 0 0 0 14 7.5 6 6 0 0 0 8 2Z" />
      <circle cx="5.2" cy="6" r=".65" />
      <circle cx="7.8" cy="4.5" r=".65" />
      <circle cx="10.6" cy="5.4" r=".65" />
    </>
  ),
  progress: (
    <>
      <path d="M3 12.5 6.2 9l2.1 1.8L13 4.5" />
      <path d="M10.5 4.5H13V7" />
    </>
  ),
  costs: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M9.7 5.8c-.4-.4-1-.6-1.7-.6-1 0-1.7.5-1.7 1.2 0 1.8 3.4.8 3.4 2.4 0 .7-.7 1.2-1.7 1.2-.8 0-1.4-.2-1.8-.7M8 4.5v7" />
    </>
  ),
  library: <path d="m8 2.5 1.3 4.2 4.2 1.3-4.2 1.3L8 13.5l-1.3-4.2L2.5 8l4.2-1.3Z" />,
  memory: (
    <>
      <ellipse cx="8" cy="4" rx="4.5" ry="1.8" />
      <path d="M3.5 4v3.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4M3.5 7.5V11c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V7.5" />
      <path d="M6 4.2h4M6 7.7h4M6 11.2h4" />
    </>
  ),
  routines: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.5 6.2A1.7 1.7 0 0 1 8.2 5c1 0 1.8.6 1.8 1.5 0 1.7-2 1.5-2 3M8 11.8v.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M6.5 2h3l.5 2a4.5 4.5 0 0 1 1.3.8l1.9-.7 1.5 2.6-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.5 2.6-1.9-.7a4.5 4.5 0 0 1-1.3.8l-.5 2h-3l-.5-2a4.5 4.5 0 0 1-1.3-.8l-1.9.7-1.5-2.6 1.5-1.3a5 5 0 0 1 0-1.6L1.3 6.7l1.5-2.6 1.9.7A4.5 4.5 0 0 1 6 4l.5-2Z" />
    </>
  ),
}

export function NavIcon({ name }: { name: NavName }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3">
        {NAV_PATHS[name]}
      </g>
    </svg>
  )
}

