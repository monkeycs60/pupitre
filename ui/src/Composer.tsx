import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
} from 'react'
import {
  ApiError,
  cancelConversation,
  createConversation,
  importMediaPath,
  sendMessage,
  uploadMedia,
} from './api'
import { buildCreateConversationInput } from './conversationDraft'
import { ConfigPanel, type ConversationConfig } from './ConfigPanel'
import { ProviderMark } from './ProviderMark'
import { ComposerPalette, paletteTrigger, useComposerPaletteItems } from './ComposerPalette'
import type { ComposerAction, ComposerPaletteTrigger, ComposerToolItem } from './ComposerPalette'
import type { Attachment, Conversation, Project, Provider, QuotaSnapshot, SkillSummary } from './types'
import { PROVIDER_MODELS } from './modelOptions'
import { mediaUrl } from './transport'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'

interface ComposerProps {
  conversationId: string | null
  project: Project
  quotas: QuotaSnapshot
  isRunning: boolean
  onConversationCreated: (conversation: Conversation) => void
  onProjectUpdated: (project: Project) => void
  message: string
  onMessageChange: (message: string) => void
  focusRequest: number
  /** Libellé provider · modèle · effort de la conversation ouverte (en-tête du
   *  composer, comme la maquette). Null pour une nouvelle conversation : dérivé
   *  de la config choisie. */
  providerLabel?: string | null
  provider?: Provider | null
  initialConfig?: Partial<ConversationConfig>
  initialAttachments?: Attachment[]
  ticketId?: string | null
  originType?: 'sentry' | 'problem' | null
  originKey?: string | null
  problemPlanIndex?: number | null
  problemIds?: string[]
  problemPlanIndices?: Record<string, number[]>
  missionTitle?: string
  /** Actions `/` du popover (résumé, test, review) : exécutées par le parent,
   *  qui tient les callbacks de revue et d'ouverture du code. */
  onAction?: (action: ComposerAction) => void | Promise<void>
}

interface UploadedAttachment {
  id: string
  attachment: Attachment
}

const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])
const COMPOSER_MIN_HEIGHT = 64
const COMPOSER_MAX_HEIGHT = 200

function resizeComposerTextarea(area: HTMLTextAreaElement) {
  area.style.height = 'auto'
  area.style.height = `${Math.max(COMPOSER_MIN_HEIGHT, Math.min(area.scrollHeight, COMPOSER_MAX_HEIGHT))}px`
  area.style.overflowY = area.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
}

function imageMimeFromName(name: string): string | null {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  switch (extension) {
    case '.gif': return 'image/gif'
    case '.jpeg':
    case '.jpg': return 'image/jpeg'
    case '.svg': return 'image/svg+xml'
    case '.webp': return 'image/webp'
    case '.png': return 'image/png'
    default: return null
  }
}

function isImageFile(file: File, itemType = ''): boolean {
  if (file.type.startsWith('image/') || itemType.startsWith('image/')) return true
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(extension)
}

function filesFromTransfer(dataTransfer: DataTransfer): File[] {
  const itemCandidates: Array<{ file: File; itemType?: string }> = []
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null) itemCandidates.push({ file, itemType: item.type })
  }

  const candidates: Array<{ file: File; itemType?: string }> = itemCandidates.length > 0
    ? itemCandidates
    : Array.from(dataTransfer.files).map((file) => ({ file }))

  const seen = new Set<string>()
  return candidates.flatMap(({ file, itemType }) => {
    const key = `${file.name}:${file.size}:${file.lastModified}:${file.type || itemType || 'image'}`
    if (seen.has(key)) return []
    seen.add(key)
    return [file]
  })
}

function imageFilesFromTransfer(dataTransfer: DataTransfer): File[] {
  return filesFromTransfer(dataTransfer).filter((file) => isImageFile(file))
}

function isImageAttachment(attachment: Attachment): boolean {
  return attachment.mimeType.startsWith('image/')
    || imageMimeFromName(attachment.originalName) !== null
}

function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

function uploadableImage(file: File): Blob {
  if (file.type.startsWith('image/')) return file
  const mime = imageMimeFromName(file.name)
  return mime === null ? file : file.slice(0, file.size, mime)
}

function imageExtensionFromMime(mime: string): string {
  switch (mime) {
    case 'image/gif': return 'gif'
    case 'image/jpeg': return 'jpg'
    case 'image/svg+xml': return 'svg'
    case 'image/webp': return 'webp'
    default: return 'png'
  }
}

interface NativeClipboardImage {
  mime_type: string
  data: number[]
}

async function readNativeClipboardImages(): Promise<File[]> {
  if (!hasTauriRuntime()) return []

  try {
    const image = await invoke<NativeClipboardImage | null>('read_clipboard_image')
    if (image === null || image.data.length === 0) return []

    return [new File(
      [new Uint8Array(image.data)],
      `capture-${crypto.randomUUID()}.${imageExtensionFromMime(image.mime_type)}`,
      { type: image.mime_type },
    )]
  } catch {
    // Le runtime peut ne pas avoir de lecteur de presse-papiers natif installé.
    return []
  }
}

async function readClipboardImages(): Promise<File[]> {
  if (typeof navigator.clipboard?.read === 'function') {
    try {
      const clipboardItems = await navigator.clipboard.read()
      const files: File[] = []
      for (const item of clipboardItems) {
        const mime = item.types.find((type) => type.startsWith('image/'))
        if (mime === undefined) continue
        const blob = await item.getType(mime)
        files.push(new File(
          [blob],
          `capture-${crypto.randomUUID()}.${imageExtensionFromMime(mime)}`,
          { type: mime },
        ))
      }
      if (files.length > 0) return files
    } catch {
      // La WebView peut refuser la lecture du presse-papiers sans permission.
      // Le lecteur natif prend le relais dans ce cas.
    }
  }

  return readNativeClipboardImages()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

export function Composer({
  conversationId,
  project,
  quotas,
  isRunning,
  onConversationCreated,
  onProjectUpdated,
  message,
  onMessageChange,
  focusRequest,
  providerLabel = null,
  provider = null,
  initialConfig,
  initialAttachments = [],
  ticketId = null,
  originType = null,
  originKey = null,
  problemPlanIndex = null,
  problemIds,
  problemPlanIndices,
  missionTitle,
  onAction,
}: ComposerProps) {
  const isNewConversation = conversationId === null
  const [config, setConfig] = useState<ConversationConfig>({
    presetId: null,
    provider: 'claude',
    model: PROVIDER_MODELS.claude[0],
    effort: 'high',
    speed: 'standard',
    permissionMode: null,
    orchestrator: true,
    subagentPresetId: null,
    subagentEffort: null,
    ...initialConfig,
  })
  const [attachments, setAttachments] = useState<UploadedAttachment[]>(() =>
    initialAttachments.map((attachment) => ({ id: crypto.randomUUID(), attachment })),
  )
  const [pendingUploads, setPendingUploads] = useState(0)
  const [isDragActive, setIsDragActive] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [configReady, setConfigReady] = useState(!isNewConversation)
  const [toast, setToast] = useState<string | null>(null)
  const [trigger, setTrigger] = useState<ComposerPaletteTrigger | null>(null)
  const [paletteIndex, setPaletteIndex] = useState(0)
  /** Échap sur un token : le popover reste fermé tant que ce `$`/`/` vit. */
  const dismissedAnchorRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importPathsRef = useRef<(paths: string[]) => void>(() => {})
  const canSteer = conversationId !== null
    && isRunning
    && (provider === 'codex' || provider === 'claude')
  const canSubmit =
    (message.trim().length > 0 || attachments.length > 0) &&
    pendingUploads === 0 &&
    !isSubmitting &&
    (!isRunning || canSteer) &&
    configReady
  const paletteItems = useComposerPaletteItems(trigger, project.id, conversationId !== null)

  useLayoutEffect(() => {
    const area = textareaRef.current
    if (area !== null) resizeComposerTextarea(area)
  }, [message])

  function syncPaletteTrigger(value: string, cursor: number) {
    const next = paletteTrigger(value, cursor)
    if (next === null) {
      dismissedAnchorRef.current = null
      setTrigger(null)
      return
    }
    if (dismissedAnchorRef.current === next.anchor) {
      setTrigger(null)
      return
    }
    if (trigger === null || trigger.anchor !== next.anchor || trigger.mode !== next.mode) {
      setPaletteIndex(0)
    }
    setTrigger(next)
  }

  function handleCaretSync() {
    const area = textareaRef.current
    if (area !== null) syncPaletteTrigger(message, area.selectionStart)
  }

  function handleSkillPick(skill: SkillSummary) {
    if (trigger === null) return
    const cursor = textareaRef.current?.selectionStart ?? message.length
    const inserted = `$${skill.invocation} `
    onMessageChange(`${message.slice(0, trigger.anchor)}${inserted}${message.slice(cursor)}`)
    setTrigger(null)
    dismissedAnchorRef.current = null
    const caret = trigger.anchor + inserted.length
    requestAnimationFrame(() => {
      const area = textareaRef.current
      if (area !== null) {
        area.focus()
        area.setSelectionRange(caret, caret)
      }
    })
  }

  function handleToolPick(tool: ComposerToolItem) {
    if (trigger === null) return
    const cursor = textareaRef.current?.selectionStart ?? message.length
    const inserted = `@${tool.label} `
    onMessageChange(`${message.slice(0, trigger.anchor)}${inserted}${message.slice(cursor)}`)
    setTrigger(null)
    dismissedAnchorRef.current = null
    const caret = trigger.anchor + inserted.length
    requestAnimationFrame(() => {
      const area = textareaRef.current
      if (area !== null) {
        area.focus()
        area.setSelectionRange(caret, caret)
      }
    })
  }

  function handlePaletteAction(action: ComposerAction) {
    if (trigger === null) return
    const cursor = textareaRef.current?.selectionStart ?? message.length
    onMessageChange(`${message.slice(0, trigger.anchor)}${message.slice(cursor)}`)
    setTrigger(null)
    dismissedAnchorRef.current = null
    void onAction?.(action)
  }

  /** Bouton « Insérer un skill » : pose un `$` au bout du message et rend le
   *  focus au textarea — le popover s'ouvre par le même chemin que la frappe. */
  function openSkillPalette() {
    const base = message.length > 0 && !message.endsWith(' ') && !message.endsWith('\n')
      ? `${message} $`
      : `${message}$`
    onMessageChange(base)
    dismissedAnchorRef.current = null
    setPaletteIndex(0)
    setTrigger({ mode: 'skills', anchor: base.length - 1, query: '' })
    requestAnimationFrame(() => {
      const area = textareaRef.current
      if (area !== null) {
        area.focus()
        area.setSelectionRange(base.length, base.length)
      }
    })
  }

  async function importFiles(files: File[]) {
    if (files.length === 0 || (isRunning && !canSteer)) return

    setToast(null)
    setPendingUploads((current) => current + files.length)

    const results = await Promise.allSettled(
      files.map((file) => uploadMedia(uploadableImage(file), file.name)),
    )
    const uploaded = results.flatMap((result) =>
      result.status === 'fulfilled'
        ? [{ id: crypto.randomUUID(), attachment: result.value }]
        : [],
    )

    if (uploaded.length > 0) {
      setAttachments((current) => [...current, ...uploaded])
    }
    if (uploaded.length !== files.length) {
      setToast('Impossible de téléverser une pièce jointe.')
    }
    setPendingUploads((current) => current - files.length)
  }

  async function importPaths(paths: string[]) {
    if (paths.length === 0 || (isRunning && !canSteer)) return

    setToast(null)
    setPendingUploads((current) => current + paths.length)
    const results = await Promise.allSettled(paths.map(importMediaPath))
    const uploaded = results.flatMap((result) =>
      result.status === 'fulfilled'
        ? [{ id: crypto.randomUUID(), attachment: result.value }]
        : [],
    )
    if (uploaded.length > 0) {
      setAttachments((current) => [...current, ...uploaded])
    }
    if (uploaded.length !== paths.length) {
      const rejected = results.find((result) => result.status === 'rejected')
      const reason = rejected?.status === 'rejected' ? errorMessage(rejected.reason) : null
      setToast(reason === null
        ? 'Impossible d’importer un ou plusieurs fichiers.'
        : `Impossible d’importer un ou plusieurs fichiers : ${reason}`)
    }
    setPendingUploads((current) => current - paths.length)
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const hasImageItem = Array.from(event.clipboardData.items)
      .some((item) => item.type.startsWith('image/'))
    const imageFiles = imageFilesFromTransfer(event.clipboardData)
    if (hasImageItem) event.preventDefault()
    const clipboardImages = imageFiles.length > 0 ? imageFiles : await readClipboardImages()
    if (clipboardImages.length === 0) return

    event.preventDefault()
    await importFiles(clipboardImages)
  }

  function handleDragEnter(event: DragEvent<HTMLFormElement>) {
    if ((isRunning && !canSteer) || filesFromTransfer(event.dataTransfer).length === 0) return
    event.preventDefault()
    setIsDragActive(true)
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>) {
    if ((isRunning && !canSteer) || filesFromTransfer(event.dataTransfer).length === 0) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setIsDragActive(false)
  }

  async function handleDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsDragActive(false)
    if (isRunning && !canSteer) return

    const droppedFiles = Array.from(event.dataTransfer.files)
    await importFiles(droppedFiles)
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? [])
    event.target.value = ''
    await importFiles(selectedFiles)
  }

  importPathsRef.current = importPaths

  useEffect(() => {
    if (!hasTauriRuntime()) return

    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setIsDragActive(true)
        return
      }
      if (event.payload.type === 'leave') {
        setIsDragActive(false)
        return
      }
      setIsDragActive(false)
      void importPathsRef.current(event.payload.paths)
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    }).catch(() => {
      // Le runtime navigateur n'expose pas l'événement Tauri en mode dev web.
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const trimmedMessage = message.trim()
    if ((!trimmedMessage && attachments.length === 0) || !canSubmit) return

    setIsSubmitting(true)
    setToast(null)
    const attachmentInputs = attachments.map((item) => item.attachment)
    const imageNames = attachmentInputs
      .filter(isImageAttachment)
      .map((attachment) => attachment.name)

    try {
      if (conversationId === null) {
        const conversation = await createConversation(buildCreateConversationInput({
          projectId: project.id,
          ...config,
          ticketId,
          originType,
          originKey,
          problemPlanIndex,
          problemIds,
          problemPlanIndices,
          missionTitle,
          message: trimmedMessage,
          images: imageNames,
          attachments: attachmentInputs,
        }))
        onConversationCreated(conversation)
      } else {
        await sendMessage(conversationId, {
          message: trimmedMessage,
          images: imageNames,
          attachments: attachmentInputs,
        })
        onMessageChange('')
        setAttachments([])
      }
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setToast('un tour est déjà en cours')
      } else {
        setToast(errorMessage(error))
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // WebKitGTK ouvre son sélecteur d'emoji natif sur Ctrl+; et Ctrl+. — ce
    // raccourci est réservé à la dictée vocale, on le neutralise ici.
    if (event.ctrlKey && (event.key === ';' || event.key === '.' || event.key === ':')) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (trigger !== null) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPaletteIndex((current) => paletteItems.count ? (current + 1) % paletteItems.count : 0)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPaletteIndex((current) => paletteItems.count ? (current - 1 + paletteItems.count) % paletteItems.count : 0)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        dismissedAnchorRef.current = trigger.anchor
        setTrigger(null)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey && paletteItems.count > 0) {
        event.preventDefault()
        const index = Math.min(paletteIndex, paletteItems.count - 1)
        if (trigger.mode === 'skills') handleSkillPick(paletteItems.skills[index]!)
        else if (trigger.mode === 'tools') handleToolPick(paletteItems.tools[index]!)
        else handlePaletteAction(paletteItems.actions[index]!.id)
        return
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }

    event.preventDefault()
    void handleSubmit()
  }

  async function handleCancel() {
    if (conversationId === null || isCancelling) return

    setIsCancelling(true)
    setToast(null)
    try {
      await cancelConversation(conversationId)
    } catch (error: unknown) {
      setToast(errorMessage(error))
    } finally {
      setIsCancelling(false)
    }
  }

  const composerModel = isNewConversation ? null : providerLabel

  return (
    <div className="composer-area">
      {toast !== null ? (
        <div className="composer-toast" role="alert">
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Fermer la notification"
          >
            ×
          </button>
        </div>
      ) : null}

      <form
        className={`composer${isDragActive ? ' is-drag-active' : ''}`}
        onSubmit={(event) => void handleSubmit(event)}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => void handleDrop(event)}
      >
        {attachments.length > 0 || pendingUploads > 0 ? (
          <div className="composer-attachments" aria-label="Pièces jointes">
            {attachments.map(({ id, attachment }) => (
              isImageAttachment(attachment) ? (
                <div className="composer-image" key={id}>
                  <img src={mediaUrl(attachment.name)} alt={attachment.originalName} />
                  <button
                    type="button"
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== id))}
                    aria-label={`Retirer ${attachment.originalName}`}
                    title="Retirer la pièce jointe"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div className="composer-file" key={id}>
                  <span className="composer-file-kind" aria-hidden="true">
                    {attachment.originalName.split('.').pop()?.toUpperCase() ?? 'FICHIER'}
                  </span>
                  <span className="composer-file-name" title={attachment.originalName}>
                    {attachment.originalName}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== id))}
                    aria-label={`Retirer ${attachment.originalName}`}
                    title="Retirer la pièce jointe"
                  >
                    ×
                  </button>
                </div>
              )
            ))}
            {pendingUploads > 0 ? (
              <span className="composer-uploading">Import en cours…</span>
            ) : null}
          </div>
        ) : null}

        <div className="composer-input-wrap">
          {trigger !== null ? (
            <ComposerPalette
              trigger={trigger}
              items={paletteItems}
              selectedIndex={Math.min(paletteIndex, Math.max(0, paletteItems.count - 1))}
              onSelectedIndexChange={setPaletteIndex}
              onSkillPick={handleSkillPick}
              onToolPick={handleToolPick}
              onAction={handlePaletteAction}
              hasConversation={conversationId !== null}
            />
          ) : null}
          <textarea
            key={`composer-message-${focusRequest}`}
            ref={textareaRef}
            value={message}
            onChange={(event) => {
              onMessageChange(event.target.value)
              syncPaletteTrigger(event.target.value, event.target.selectionStart)
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) handleCaretSync()
            }}
            onClick={handleCaretSync}
            onBlur={() => setTrigger(null)}
            onPaste={(event) => void handlePaste(event)}
            placeholder={isRunning ? (canSteer ? 'Ajoute une précision au tour en cours…' : 'tour en cours…') : ''}
            aria-label="Message"
            rows={3}
            disabled={isRunning && !canSteer}
            autoFocus={isNewConversation || focusRequest > 0}
          />
          {message === '' && !isRunning ? (
            <div className="composer-placeholder" aria-hidden="true">
              Écris ton message, ou <span className="composer-ph-key">/</span> pour une action,{' '}
              <span className="composer-ph-key">$</span> pour un skill,{' '}
              <span className="composer-ph-key">@</span> pour un outil
            </div>
          ) : null}
        </div>

        {isDragActive ? (
          <div className="composer-drop-hint" aria-live="polite">
            Déposez vos fichiers ici
          </div>
        ) : null}

        <div className="composer-actions">
          <div className="composer-tools">
            {isNewConversation ? (
              <ConfigPanel
                project={project}
                quotas={quotas}
                config={config}
                onConfigChange={setConfig}
                onProjectUpdated={onProjectUpdated}
                onError={setToast}
                onReady={setConfigReady}
              />
            ) : null}
            <input
              ref={fileInputRef}
              className="composer-file-input"
              type="file"
              accept="image/*,.csv,.doc,.docx,.json,.md,.pdf,.txt,.xls,.xlsx,.xml,.zip"
              multiple
              onChange={(event) => void handleFileInputChange(event)}
              tabIndex={-1}
            />
            <button
              type="button"
              className="composer-icon-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={(isRunning && !canSteer) || pendingUploads > 0 || isSubmitting}
              title="Joindre une ou plusieurs pièces jointes"
              aria-label="Joindre"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M9.5 4 5 8.5a2.1 2.1 0 0 0 3 3l4.5-4.5a3.5 3.5 0 0 0-5-5L3 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="composer-skill-button"
              onClick={openSkillPalette}
              disabled={(isRunning && !canSteer) || isSubmitting}
              title="Insérer un skill ($)"
              aria-label="Insérer un skill"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2.5 3.5h11v9h-11z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
                <path d="m5 6 2 2-2 2M8.8 10h2.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Insérer un skill</span>
            </button>
            {composerModel && provider ? (
              <>
                <span className="composer-tools-divider" aria-hidden="true" />
                <span className={`composer-model is-${provider}`} title={`${provider} · ${composerModel}`}>
                  <ProviderMark provider={provider} />
                  {composerModel}
                </span>
              </>
            ) : null}
          </div>
          <div className="composer-send-group">
            {isRunning && conversationId !== null ? (
              <button
                type="button"
                className="cancel-button"
                onClick={() => void handleCancel()}
                disabled={isCancelling}
              >
                {isCancelling ? 'Annulation…' : 'Annuler le tour'}
              </button>
            ) : null}
            <button type="submit" className={`send-button${isRunning ? ' is-running' : ''}`} disabled={!canSubmit}>
              {isSubmitting
                ? isNewConversation
                  ? 'Création…'
                  : 'Envoi…'
                : canSteer ? 'Orienter' : 'Envoyer'}
              {!isSubmitting ? <kbd aria-hidden="true">⏎</kbd> : null}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
