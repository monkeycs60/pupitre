import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { projectIconUrl } from './api'
import { PROJECT_COLORS, ProjectAvatar } from './ProjectAvatar'
import type { Project } from './types'

const POPOVER_MARGIN = 8

function popoverStyle(anchor: DOMRect, height: number): CSSProperties {
  const top = Math.max(POPOVER_MARGIN, Math.min(anchor.top, window.innerHeight - height - POPOVER_MARGIN))
  return { position: 'fixed', top, left: anchor.right + 6, right: 'auto' }
}

function Popover({ anchor, estimatedHeight, onClose, className, label, role, children }: {
  anchor: DOMRect
  estimatedHeight: number
  onClose: () => void
  className: string
  label: string
  role: 'menu' | 'dialog'
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className={className} role={role} aria-label={label} style={popoverStyle(anchor, estimatedHeight)}>
      {children}
    </div>,
    document.body,
  )
}

interface ProjectMenuProps {
  project: Project
  anchor: DOMRect
  live: boolean
  onClose: () => void
  onRename: () => void
  onAppearance: () => void
  onToggleArchive: () => void
  onRemove: () => void
}

export function ProjectMenu({ project, anchor, live, onClose, onRename, onAppearance, onToggleArchive, onRemove }: ProjectMenuProps) {
  const pick = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <Popover
      anchor={anchor}
      estimatedHeight={150}
      onClose={onClose}
      className="conversation-actions-menu rail-project-menu"
      role="menu"
      label={`Actions pour le projet ${project.name}`}
    >
      <button type="button" role="menuitem" autoFocus onClick={pick(onRename)}>Renommer</button>
      <button type="button" role="menuitem" onClick={pick(onAppearance)}>Couleur et icône…</button>
      <button type="button" role="menuitem" onClick={pick(onToggleArchive)}>
        {project.archived_at ? 'Désarchiver' : 'Archiver'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        disabled={live}
        title={live ? 'Un run est en cours dans ce projet' : undefined}
        onClick={pick(onRemove)}
      >
        Retirer le projet…
      </button>
    </Popover>
  )
}

const ICON_SIZE = 128

/**
 * Ramène l'image à un carré de 128 px : recadrée au centre si elle est presque
 * carrée, sinon contenue avec des marges transparentes. La pastille ronde peut
 * alors toujours la remplir sans la déformer.
 */
export async function squareProjectImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const width = image.naturalWidth || ICON_SIZE
    const height = image.naturalHeight || ICON_SIZE
    const ratio = width / height
    const canvas = document.createElement('canvas')
    canvas.width = ICON_SIZE
    canvas.height = ICON_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas indisponible')
    context.imageSmoothingQuality = 'high'
    if (ratio > 0.8 && ratio < 1.25) {
      const side = Math.min(width, height)
      context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE)
    } else {
      const scale = (ICON_SIZE * 0.86) / Math.max(width, height)
      const drawnWidth = width * scale
      const drawnHeight = height * scale
      context.drawImage(image, (ICON_SIZE - drawnWidth) / 2, (ICON_SIZE - drawnHeight) / 2, drawnWidth, drawnHeight)
    }
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface ProjectAppearancePanelProps {
  project: Project
  anchor: DOMRect
  onClose: () => void
  onChange: (patch: { color?: string; icon?: string }) => Promise<void>
}

export function ProjectAppearancePanel({ project, anchor, onClose, onChange }: ProjectAppearancePanelProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [hasLogo, setHasLogo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const icon = project.icon ?? 'auto'
  const color = project.color ?? PROJECT_COLORS[0]

  async function apply(patch: { color?: string; icon?: string }) {
    setError(null)
    try { await onChange(patch) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.') }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    try { await apply({ icon: await squareProjectImage(file) }) }
    catch { setError('Cette image ne peut pas être lue.') }
  }

  return (
    <Popover
      anchor={anchor}
      estimatedHeight={300}
      onClose={onClose}
      className="rail-appearance"
      role="dialog"
      label={`Apparence du projet ${project.name}`}
    >
      <div className="rail-appearance-head">
        <ProjectAvatar project={project} className="is-large" />
        <div>
          <strong>{project.name}</strong>
          <span>{icon === 'custom' ? 'Image personnalisée' : icon === 'initials' ? 'Initiales' : hasLogo ? 'Logo du dépôt' : 'Initiales (aucun logo trouvé)'}</span>
        </div>
      </div>

      <span className="rail-appearance-label">Couleur</span>
      <div className="rail-appearance-swatches" role="radiogroup" aria-label="Couleur">
        {PROJECT_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            role="radio"
            aria-checked={color === swatch}
            aria-label={swatch}
            className="rail-appearance-swatch"
            style={{ '--swatch': swatch } as CSSProperties}
            onClick={() => void apply({ color: swatch })}
          />
        ))}
        <label className="rail-appearance-swatch is-custom" title="Couleur libre" style={{ '--swatch': color } as CSSProperties}>
          <input
            type="color"
            aria-label="Couleur libre"
            value={color}
            onChange={(event) => void apply({ color: event.target.value })}
          />
        </label>
      </div>

      <span className="rail-appearance-label">Icône</span>
      <div className="rail-appearance-icons">
        <button type="button" aria-pressed={icon === 'auto' && hasLogo} onClick={() => void apply({ icon: 'auto' })} disabled={!hasLogo} title={hasLogo ? 'Logo trouvé dans le dépôt' : 'Aucun logo trouvé dans le dépôt'}>
          <img src={projectIconUrl(project, 'logo')} alt="" hidden={!hasLogo} onLoad={() => setHasLogo(true)} onError={() => setHasLogo(false)} />
          Logo
        </button>
        <button type="button" aria-pressed={icon === 'initials' || (icon === 'auto' && !hasLogo)} onClick={() => void apply({ icon: 'initials' })}>
          Initiales
        </button>
        <button type="button" aria-pressed={icon === 'custom'} onClick={() => fileInput.current?.click()}>
          Image…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={(event) => {
            void handleFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </div>
      {error ? <p role="alert" className="rail-error">{error}</p> : null}
    </Popover>
  )
}
