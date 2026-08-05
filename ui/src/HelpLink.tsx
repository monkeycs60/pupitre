export function HelpLink({ slug, label = 'En savoir plus' }: { slug: string; label?: string }) {
  return <a className="help-link" href={`#help/${slug}`}>{label}</a>
}
