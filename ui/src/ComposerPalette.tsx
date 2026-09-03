import { useEffect, useMemo, useRef, useState } from 'react'
import { listSkills } from './api'
import type { SkillProvenance, SkillSummary } from './types'
import { COMPOSER_DIRECTIVES } from './composerDirectives'

/**
 * Popover unique du composer, trois déclencheurs : `$` liste les skills,
 * `@` les outils
 * (sélection = insertion de l'invocation dans le message), `/` en tête de
 * message liste les actions de la conversation (sélection = exécution).
 * La palette globale Ctrl K reste une surface distincte : ici on complète le
 * message en cours, on ne navigue pas dans l'application.
 */

export type ComposerPaletteMode = 'skills' | 'actions' | 'tools'

export interface ComposerPaletteTrigger {
  mode: ComposerPaletteMode
  /** Position du caractère déclencheur (`$` ou `/`) dans le message. */
  anchor: number
  query: string
}

export type ComposerAction = 'summary' | 'test' | 'review' | 'switch-model' | 'handoff'

export interface ComposerActionItem {
  id: ComposerAction
  label: string
  detail: string
}

export interface ComposerToolItem {
  id: string
  label: string
  detail: string
}

export const COMPOSER_TOOLS: ComposerToolItem[] = [
  { id: 'chrome', label: 'chrome', detail: 'Piloter Chrome avec l’intégration du fournisseur' },
  ...COMPOSER_DIRECTIVES,
]

export const COMPOSER_ACTIONS: ComposerActionItem[] = [
  { id: 'summary', label: 'Résumé de session', detail: 'Lister les changements et les éléments à terminer' },
  { id: 'review', label: 'Relire le diff', detail: 'Analyser le diff Git avec le modèle de review' },
  { id: 'switch-model', label: 'Changer de modèle', detail: 'Provider, modèle ou effort de la conversation' },
  { id: 'handoff', label: 'Passation', detail: 'Transmettre le travail à une nouvelle conversation' },
  { id: 'test', label: 'Tester', detail: 'Proposer des vérifications ciblées' },
]

const PROVENANCE_LABELS: Record<SkillProvenance, string> = {
  'claude-global': 'Global',
  'claude-plugin': 'Plugin',
  'claude-project': 'Projet',
  'codex-prompt': 'Codex',
  'agents-global': 'AGENTS',
  'agents-project': 'Projet',
  'grok-global': 'Grok',
  'grok-project': 'Projet',
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function matches(query: string, ...values: string[]): boolean {
  const needle = normalized(query.trim())
  return !needle || values.some((value) => normalized(value).includes(needle))
}

/**
 * Déclencheur sous le curseur : `$mot` n'importe où (skills), `/mot` seulement
 * en tête de message (actions). Un token avec espace n'est plus un déclencheur.
 */
export function paletteTrigger(message: string, cursor: number): ComposerPaletteTrigger | null {
  const upToCursor = message.slice(0, cursor)
  const tokenStart = Math.max(
    upToCursor.lastIndexOf(' '),
    upToCursor.lastIndexOf('\n'),
    upToCursor.lastIndexOf('\t'),
  ) + 1
  const token = upToCursor.slice(tokenStart)
  if (token.startsWith('$') && token.length <= 48) {
    return { mode: 'skills', anchor: tokenStart, query: token.slice(1) }
  }
  if (token.startsWith('@') && token.length <= 48) {
    return { mode: 'tools', anchor: tokenStart, query: token.slice(1) }
  }
  if (token.startsWith('/') && tokenStart === 0 && token.length <= 48) {
    return { mode: 'actions', anchor: 0, query: token.slice(1) }
  }
  return null
}

/** Skills du projet et favoris d'abord : ce sont eux qu'on invoque le plus. */
export function rankSkills(skills: SkillSummary[], projectId: string): SkillSummary[] {
  return skills
    .filter((skill) => skill.project_id === null || skill.project_id === projectId)
    .sort((left, right) => {
      const leftRank = (left.favorite ? 0 : 2) + (left.project_id === null ? 1 : 0)
      const rightRank = (right.favorite ? 0 : 2) + (right.project_id === null ? 1 : 0)
      return leftRank - rightRank || left.invocation.localeCompare(right.invocation)
    })
}

export interface ComposerPaletteItems {
  skills: SkillSummary[]
  actions: ComposerActionItem[]
  tools: ComposerToolItem[]
  count: number
  totalSkills: number
}

/** Les items vivent dans le composer : c'est lui qui tient la sélection ⏎. */
export function useComposerPaletteItems(
  trigger: ComposerPaletteTrigger | null,
  projectId: string,
  hasConversation: boolean,
): ComposerPaletteItems {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const open = trigger !== null

  useEffect(() => {
    if (!open) return
    let ignore = false
    const controller = new AbortController()
    void listSkills({ favoriteProjectId: projectId, signal: controller.signal })
      .then((loaded) => { if (!ignore) setSkills(loaded) })
      .catch(() => {
        // Le popover affiche « aucun skill » ; l'invocation tapée reste valide.
      })
    return () => {
      ignore = true
      controller.abort()
    }
  }, [open, projectId])

  const ranked = useMemo(() => rankSkills(skills, projectId), [skills, projectId])
  const skillItems = useMemo(
    () => trigger?.mode === 'skills'
      ? ranked.filter((skill) => matches(trigger.query, skill.invocation, skill.name, skill.description, ...skill.triggers))
      : [],
    [ranked, trigger?.mode, trigger?.query],
  )
  const actionItems = useMemo(
    () => trigger?.mode === 'actions' && hasConversation
      ? COMPOSER_ACTIONS.filter((action) => matches(trigger.query, action.label, action.detail))
      : [],
    [trigger?.mode, trigger?.query, hasConversation],
  )
  const toolItems = useMemo(
    () => trigger?.mode === 'tools'
      ? COMPOSER_TOOLS.filter((tool) => matches(trigger.query, tool.label, tool.detail))
      : [],
    [trigger?.mode, trigger?.query],
  )
  return {
    skills: skillItems,
    actions: actionItems,
    tools: toolItems,
    count: trigger?.mode === 'skills'
      ? skillItems.length
      : trigger?.mode === 'tools' ? toolItems.length : actionItems.length,
    totalSkills: ranked.length,
  }
}

interface ComposerPaletteProps {
  trigger: ComposerPaletteTrigger
  items: ComposerPaletteItems
  selectedIndex: number
  onSelectedIndexChange: (index: number) => void
  onSkillPick: (skill: SkillSummary) => void
  onToolPick: (tool: ComposerToolItem) => void
  onAction: (action: ComposerAction) => void
  hasConversation: boolean
}

export function ComposerPalette({
  trigger,
  items,
  selectedIndex,
  onSelectedIndexChange,
  onSkillPick,
  onToolPick,
  onAction,
  hasConversation,
}: ComposerPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="composer-palette" role="dialog" aria-label={trigger.mode === 'skills' ? 'Skills disponibles' : trigger.mode === 'tools' ? 'Outils disponibles' : 'Actions de la conversation'}>
      <div className="composer-palette-list" role="listbox" ref={listRef}>
        {items.count === 0 ? (
          <p className="composer-palette-empty">
            {trigger.mode === 'skills'
              ? 'Aucun skill ne correspond.'
              : trigger.mode === 'tools' ? 'Aucun outil ne correspond.'
              : hasConversation ? 'Aucune action ne correspond.' : 'Les actions demandent une conversation ouverte.'}
          </p>
        ) : null}
        {trigger.mode === 'skills' ? items.skills.map((skill, index) => (
          <button
            type="button"
            key={skill.id}
            className={`composer-palette-row${index === selectedIndex ? ' is-selected' : ''}`}
            role="option"
            aria-selected={index === selectedIndex}
            onMouseEnter={() => onSelectedIndexChange(index)}
            // mousedown : le clic ne doit pas voler le focus du textarea.
            onMouseDown={(event) => { event.preventDefault(); onSkillPick(skill) }}
          >
            <span className="composer-palette-invocation">${skill.invocation}</span>
            <span className="composer-palette-description">{skill.description || skill.name}</span>
            <span className="composer-palette-source">{PROVENANCE_LABELS[skill.provenance]}</span>
          </button>
        )) : trigger.mode === 'tools' ? items.tools.map((tool, index) => (
          <button
            type="button"
            key={tool.id}
            className={`composer-palette-row${index === selectedIndex ? ' is-selected' : ''}`}
            role="option"
            aria-selected={index === selectedIndex}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onMouseDown={(event) => { event.preventDefault(); onToolPick(tool) }}
          >
            <span className="composer-palette-invocation">@{tool.label}</span>
            <span className="composer-palette-description">{tool.detail}</span>
          </button>
        )) : items.actions.map((action, index) => (
          <button
            type="button"
            key={action.id}
            className={`composer-palette-row${index === selectedIndex ? ' is-selected' : ''}`}
            role="option"
            aria-selected={index === selectedIndex}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onMouseDown={(event) => { event.preventDefault(); onAction(action.id) }}
          >
            <span className="composer-palette-invocation">/{action.label}</span>
            <span className="composer-palette-description">{action.detail}</span>
          </button>
        ))}
      </div>
      <footer className="composer-palette-footer">
        <span><kbd>↑↓</kbd> naviguer</span>
        <span><kbd>⏎</kbd> {trigger.mode === 'actions' ? 'lancer' : 'insérer'}</span>
        <span><kbd>Échap</kbd> fermer</span>
        <span className="composer-palette-count">
          {trigger.mode === 'skills'
            ? `${items.count} / ${items.totalSkills} skills`
            : trigger.mode === 'tools' ? `${items.count} outil${items.count > 1 ? 's' : ''}` : `${items.count} action${items.count > 1 ? 's' : ''}`}
        </span>
      </footer>
    </div>
  )
}
