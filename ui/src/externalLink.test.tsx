import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const opened: string[] = []
const openedPaths: string[] = []
const revealedPaths: string[] = []
mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async (url: string) => { opened.push(url) },
  openPath: async (path: string) => { openedPaths.push(path) },
  revealItemInDir: async (path: string) => { revealedPaths.push(path) },
}))

const { cleanup, render, fireEvent } = await import('@testing-library/react')
const { DownloadLink, ExternalLink } = await import('./externalLink')
const Markdown = (await import('./Markdown')).default
const { hasTauriRuntime } = await import('./transport')
const defaultFetch = globalThis.fetch

const TAURI = '__TAURI_INTERNALS__'

function inTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI]
}

afterEach(() => {
  cleanup()
  inTauri(false)
  opened.length = 0
  openedPaths.length = 0
  revealedPaths.length = 0
  globalThis.fetch = defaultFetch
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

test('un lien web Markdown délègue lui aussi au navigateur système', () => {
  inTauri(true)
  render(<Markdown>[Documentation](https://example.com/docs)</Markdown>)
  const link = document.querySelector('a') as HTMLAnchorElement
  fireEvent.click(link)
  expect(opened).toEqual(['https://example.com/docs'])
})

test('un lien vscode ouvre l’éditeur système', () => {
  inTauri(true)
  render(<ExternalLink href="vscode://file/home/clement/proj">Ouvrir dans VS Code</ExternalLink>)
  fireEvent.click(document.querySelector('a') as HTMLAnchorElement)
  expect(opened).toEqual(['vscode://file/home/clement/proj'])
})

test('un lien HTTP local ouvre le navigateur système', () => {
  inTauri(true)
  render(<Markdown>[Preview](http://localhost:5174/)</Markdown>)
  fireEvent.click(document.querySelector('a') as HTMLAnchorElement)
  expect(opened).toEqual(['http://localhost:5174/'])
})

test('un lien local HTML n’est pas interprété comme une route Pupitre', () => {
  inTauri(true)
  render(<Markdown>[README](/home/clement/Downloads/readme.html)</Markdown>)
  const link = document.querySelector('a') as HTMLAnchorElement
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  fireEvent(link, event)
  expect(event.defaultPrevented).toBe(true)
  expect(openedPaths).toEqual(['/home/clement/Downloads/readme.html'])
  expect(link.getAttribute('href')).toBe('file:///home/clement/Downloads/readme.html')
})

test('un lien local vers un document révèle le fichier dans l’explorateur', () => {
  inTauri(true)
  render(<Markdown>[Rapport](/home/clement/Downloads/rapport.docx)</Markdown>)
  fireEvent.click(document.querySelector('a') as HTMLAnchorElement)
  expect(revealedPaths).toEqual(['/home/clement/Downloads/rapport.docx'])
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

test('onClick s’exécute avant l’ouverture système et peut l’annuler', () => {
  inTauri(true)
  const clicks: string[] = []
  render(
    <ExternalLink
      href="https://gitlab.example.com/mr/12"
      onClick={(event) => {
        clicks.push('clicked')
        event.preventDefault()
      }}
    >
      MR
    </ExternalLink>,
  )
  fireEvent.click(document.querySelector('a') as HTMLAnchorElement)
  expect(clicks).toEqual(['clicked'])
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
  expect(opened).toEqual(['http://127.0.0.1:4820/media/abc.pdf'])
})

test('le bouton Télécharger laisse WebKit déclencher le téléchargement dans Tauri', () => {
  inTauri(true)
  render(
    <DownloadLink
      href="/media/abc.pdf"
      filename="rapport.pdf"
    >
      Télécharger
    </DownloadLink>,
  )
  const link = document.querySelector('a') as HTMLAnchorElement
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  fireEvent(link, event)
  expect(event.defaultPrevented).toBe(false)
  expect(link.getAttribute('download')).toBe('rapport.pdf')
  expect(openedPaths).toEqual([])
})

test('openStoredMedia demande le chemin au sidecar puis l’ouvre', async () => {
  const { openStoredMedia } = await import('./externalLink')
  inTauri(true)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/media/') && url.includes('/path')) {
      return Response.json({ path: '/tmp/abc.pdf' })
    }
    throw new Error(`fetch inattendu: ${url}`)
  }) as typeof fetch
  await openStoredMedia('abc.pdf')
  expect(openedPaths).toEqual(['/tmp/abc.pdf'])
})

test('openStoredMedia se rabat sur le navigateur si le chemin est indisponible', async () => {
  const { openStoredMedia } = await import('./externalLink')
  inTauri(true)
  globalThis.fetch = (async () => new Response('media inconnu', { status: 404 })) as typeof fetch
  await openStoredMedia('abc.pdf')
  expect(openedPaths).toEqual([])
  expect(opened).toEqual(['http://127.0.0.1:4820/media/abc.pdf'])
})

test('dans le navigateur, Télécharger garde l’ancre native', () => {
  inTauri(false)
  render(
    <DownloadLink href="/media/abc.pdf" filename="rapport.pdf">
      Télécharger
    </DownloadLink>,
  )
  const link = document.querySelector('a') as HTMLAnchorElement
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  fireEvent(link, event)
  expect(event.defaultPrevented).toBe(false)
  expect(link.getAttribute('download')).toBe('rapport.pdf')
  expect(openedPaths).toEqual([])
})
