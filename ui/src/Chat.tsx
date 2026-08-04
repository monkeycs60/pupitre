import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EventView } from './EventView'
import type { EventBlock } from './EventView'
import { Lightbox } from './Lightbox'
import type { AppEvent } from './types'

interface ChatProps {
  events: AppEvent[]
}

interface LightboxImage {
  src: string
  alt: string
}

function groupEvents(events: AppEvent[]): EventBlock[] {
  const blocks: EventBlock[] = []
  const tools = new Map<string, Extract<EventBlock, { kind: 'tool' }>>()
  let assistant: Extract<EventBlock, { kind: 'assistant' }> | null = null
  let turnNumber = 0
  let turnFooter: Extract<EventBlock, { kind: 'turn-footer' }> | null = null

  function ensureTurnFooter() {
    turnFooter ??= {
      kind: 'turn-footer',
      id: `turn-footer-${turnNumber}`,
    }
    return turnFooter
  }

  function flushTurnFooter() {
    if (turnFooter !== null) blocks.push(turnFooter)
    turnFooter = null
  }

  events.forEach((event, index) => {
    switch (event.type) {
      case 'session':
        break

      case 'user-message':
        flushTurnFooter()
        turnNumber += 1
        assistant = null
        blocks.push({
          kind: 'user',
          id: `user-${index}`,
          text: event.text,
          images: event.images,
        })
        break

      case 'text-delta':
        if (assistant === null) {
          assistant = {
            kind: 'assistant',
            id: `assistant-${index}`,
            text: '',
            streaming: true,
          }
          blocks.push(assistant)
        }
        assistant.text += event.text
        assistant.streaming = true
        break

      case 'text-final':
        if (assistant === null) {
          assistant = {
            kind: 'assistant',
            id: `assistant-${index}`,
            text: event.text,
            streaming: false,
          }
          blocks.push(assistant)
        } else {
          assistant.text = event.text
          assistant.streaming = false
        }
        assistant = null
        break

      case 'tool-start': {
        assistant = null
        const tool: Extract<EventBlock, { kind: 'tool' }> = {
          kind: 'tool',
          id: `tool-${event.toolId}`,
          toolId: event.toolId,
          toolName: event.toolName,
          input: event.input,
          images: [],
        }
        tools.set(event.toolId, tool)
        blocks.push(tool)
        break
      }

      case 'tool-end': {
        assistant = null
        const tool = tools.get(event.toolId)
        if (tool !== undefined) {
          tool.output = event.output
          tool.images = event.images
        }
        break
      }

      case 'usage': {
        const footer = ensureTurnFooter()
        footer.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        }
        break
      }

      case 'status':
        ensureTurnFooter().status = event
        if (event.state !== 'running') assistant = null
        break
    }
  })

  flushTurnFooter()
  return blocks
}

export function Chat({ events }: ChatProps) {
  const blocks = useMemo(() => groupEvents(events), [events])
  const viewportRef = useRef<HTMLDivElement>(null)
  const followsBottomRef = useRef(true)
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null)

  const scrollToBottomIfFollowing = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport !== null && followsBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [])

  useLayoutEffect(scrollToBottomIfFollowing, [blocks, scrollToBottomIfFollowing])

  const handleImageOpen = useCallback((src: string, alt: string) => {
    setLightboxImage({ src, alt })
  }, [])

  const handleLightboxClose = useCallback(() => {
    setLightboxImage(null)
  }, [])

  function handleScroll() {
    const viewport = viewportRef.current
    if (viewport === null) return

    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    followsBottomRef.current = distanceFromBottom <= 64
  }

  return (
    <>
      <div className="events-view" ref={viewportRef} onScroll={handleScroll}>
        <div className="events-list" aria-live="polite">
          {blocks.length === 0 ? (
            <p className="events-empty">Aucun événement dans cette conversation.</p>
          ) : (
            blocks.map((block) => (
              <EventView
                key={block.id}
                block={block}
                onImageOpen={handleImageOpen}
                onImageLoad={scrollToBottomIfFollowing}
              />
            ))
          )}
        </div>
      </div>

      {lightboxImage !== null ? (
        <Lightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={handleLightboxClose}
        />
      ) : null}
    </>
  )
}
