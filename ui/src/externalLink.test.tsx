import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const opened: string[] = []
mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async (url: string) => { opened.push(url) },
}))

const { cleanup, render, fireEvent } = await import('@testing-library/react')
const { ExternalLink } = await import('./externalLink')
const { hasTauriRuntime } = await import('./transport')

const TAURI = '__TAURI_INTERNALS__'

function inTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI]
}

afterEach(() => {
  cleanup()
  inTauri(false)
  opened.length = 0
})

test('dans la fenêtre Tauri, le clic délègue au système au lieu de ne rien faire', () => {
  inTauri(true)
  expect(hasTauriRuntime()).toBe(true)
  render(<ExternalLink href="https://app.clickup.com/t/86c1">ClickUp</ExternalLink>)
  const link = document.querySelector('a') as HTMLAnchorElement
  // `target="_blank"` est ignoré par la fenêtre principale : sans interception,
  // le clic serait avalé en silence. C'est le bug qu'on protège ici.
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  fireEvent(link, event)
  expect(event.defaultPrevented).toBe(true)
  expect(opened).toEqual(['https://app.clickup.com/t/86c1'])
})

test('dans le navigateur, l’ancre garde son comportement natif', () => {
  inTauri(false)
  render(<ExternalLink href="https://app.clickup.com/t/86c1">ClickUp</ExternalLink>)
  const link = document.querySelector('a') as HTMLAnchorElement
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  fireEvent(link, event)
  expect(event.defaultPrevented).toBe(false)
  expect(opened).toEqual([])
})

test('le lien reste une vraie ancre : adresse, cible et libellés préservés', () => {
  inTauri(true)
  render(
    <ExternalLink
      href="https://gitlab.example.com/mr/12"
      className="dashboard-ticket-link"
      title="Ouvrir dans ClickUp"
      ariaLabel="Ouvrir TECH-1 dans ClickUp"
    >
      MR
    </ExternalLink>,
  )
  const link = document.querySelector('a') as HTMLAnchorElement
  expect(link.getAttribute('href')).toBe('https://gitlab.example.com/mr/12')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noreferrer')
  expect(link.className).toBe('dashboard-ticket-link')
  expect(link.getAttribute('aria-label')).toBe('Ouvrir TECH-1 dans ClickUp')
})

test('la pièce jointe passe par le même chemin que les liens du tableau de bord', async () => {
  const { AttachmentPreview } = await import('./AttachmentPreview')
  inTauri(true)
  render(
    <AttachmentPreview
      attachment={{
        name: 'abc.pdf',
        originalName: 'rapport.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      } as never}
    />,
  )
  const ouvrir = [...document.querySelectorAll('a.event-attachment-action')]
    .find((a) => a.textContent === 'Ouvrir') as HTMLAnchorElement
  expect(ouvrir).toBeTruthy()
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  fireEvent(ouvrir, event)
  expect(event.defaultPrevented).toBe(true)
  // L'adresse est servie par le sidecar : c'est bien elle qui part au système.
  expect(opened.length).toBe(1)
  expect(opened[0]).toContain('/media/abc.pdf')
})
