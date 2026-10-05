import { useState, type CSSProperties } from 'react'
import { projectIconUrl } from './api'
import { projectInitials } from './projectInitials'
import type { Project } from './types'

export const PROJECT_COLORS = [
  '#8b7cff', '#4f8cff', '#22b8cf', '#20c997', '#51cf66', '#fcc419',
  '#ff922b', '#ff6b6b', '#f06595', '#cc5de8', '#94a3b8', '#a9e34b',
] as const

type AvatarProject = Pick<Project, 'id' | 'name'> & Partial<Pick<Project, 'color' | 'icon' | 'appearance_version'>>

interface ProjectAvatarProps {
  project: AvatarProject
  className?: string
}

/**
 * Pastille ronde d'un projet. L'image n'apparaît qu'une fois chargée : sans
 * logo dans le dépôt, la requête répond 404 et les initiales restent.
 */
export function ProjectAvatar({ project, className = '' }: ProjectAvatarProps) {
  const icon = project.icon ?? 'auto'
  const src = icon === 'initials' ? null : projectIconUrl(project)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const showImage = src !== null && loadedSrc === src
  const style = { '--project-color': project.color ?? PROJECT_COLORS[0] } as CSSProperties
  return (
    <span
      className={`project-avatar${showImage ? ` has-image${icon === 'custom' ? ' is-filled' : ''}` : ''} ${className}`}
      style={style}
      aria-hidden="true"
    >
      {showImage ? null : <span className="project-avatar-initials">{projectInitials(project.name)}</span>}
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          hidden={!showImage}
          onLoad={() => setLoadedSrc(src)}
          onError={() => setLoadedSrc(null)}
        />
      ) : null}
    </span>
  )
}
