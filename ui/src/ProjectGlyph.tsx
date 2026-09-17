import { projectGlyphIndex } from './projectGlyphIndex'

const glyphs = [
  <><path d="M5 5h6v6H5z" /><path d="M3 3h4M3 3v4M13 3H9m4 0v4M3 13h4m-4 0V9m10 4H9m4 0V9" /></>,
  <><path d="M8 2.5 13 5.3v5.4L8 13.5l-5-2.8V5.3z" /><path d="m3.2 5.4 4.8 3 4.8-3M8 8.4v5" /></>,
  <><circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="5" r="1.5" /><circle cx="7" cy="12" r="1.5" /><path d="m5.3 4.2 5.2.6m-5.7.5 1.6 5.3m4.7-4.2-3 4.4" /></>,
  <><path d="m8 2.5 5 2.6-5 2.6-5-2.6zM3 8l5 2.6L13 8M3 10.9l5 2.6 5-2.6" /></>,
  <><path d="M6 3 2.5 8 6 13M10 3l3.5 5-3.5 5M8.8 2.5 7.2 13.5" /></>,
  <><circle cx="8" cy="8" r="5.5" /><path d="m10.8 5.2-1.5 4.1-4.1 1.5 1.5-4.1z" /><circle cx="8" cy="8" r=".8" /></>,
  <><path d="M3 4.5h10v7H3zM5.5 2.5v2M10.5 2.5v2M5.5 11.5v2M10.5 11.5v2M6 7h4M6 9h2" /></>,
  <><path d="M3 4h6v4H3zM7 8h6v4H7z" /><path d="M9 6h2v2M5 8v2h2" /></>,
]

export function ProjectGlyph({ projectId }: { projectId: string }) {
  const glyphIndex = projectGlyphIndex(projectId)
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" data-project-glyph={glyphIndex}>
      {glyphs[glyphIndex]}
    </svg>
  )
}
