interface DiffViewerProps {
  diff: string
  label: string
}

export function DiffViewer({ diff, label }: DiffViewerProps) {
  return (
    <pre className="diff-viewer" aria-label={label}>
      <code>{diff}</code>
    </pre>
  )
}
