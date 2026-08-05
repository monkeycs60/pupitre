import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'

const RAW_PAGES = import.meta.glob('../../docs/help/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

interface HelpPage {
  slug: string
  title: string
  content: string
}

const PAGES: HelpPage[] = Object.entries(RAW_PAGES).map(([path, content]) => {
  const slug = path.split('/').pop()!.replace(/\.md$/, '')
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? slug
  return { slug, title, content }
}).sort((left, right) => left.title.localeCompare(right.title, 'fr'))

interface HelpViewProps {
  initialSlug: string | null
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

export function HelpView({ initialSlug }: HelpViewProps) {
  const [query, setQuery] = useState('')
  const [selectedSlug, setSelectedSlug] = useState(
    PAGES.some((page) => page.slug === initialSlug) ? initialSlug! : PAGES[0]?.slug ?? '',
  )
  const visible = useMemo(() => {
    const needle = normalized(query.trim())
    return needle ? PAGES.filter((page) => normalized(`${page.title}\n${page.content}`).includes(needle)) : PAGES
  }, [query])
  const selected = visible.find((page) => page.slug === selectedSlug)
    ?? visible[0]
    ?? null

  function select(slug: string) {
    setSelectedSlug(slug)
    window.location.hash = `help/${slug}`
  }

  return (
    <section className="help-view" aria-labelledby="help-title">
      <header className="help-header"><div><h1 id="help-title">Aide</h1><p>Les concepts propres à Pupitre, expliqués sans quitter le cockpit.</p></div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher dans l'aide" aria-label="Rechercher dans l'aide" /></header>
      <div className="help-body">
        <nav className="help-list" aria-label="Pages d'aide">
          {visible.length === 0 ? <div className="help-empty">Aucune page ne correspond à cette recherche.</div> : visible.map((page) => <button type="button" key={page.slug} className={selected?.slug === page.slug ? 'is-selected' : ''} onClick={() => select(page.slug)}>{page.title}</button>)}
        </nav>
        <article className="help-article">{selected ? <ReactMarkdown>{selected.content}</ReactMarkdown> : <div className="help-empty">Aucune page d'aide disponible.</div>}</article>
      </div>
    </section>
  )
}
