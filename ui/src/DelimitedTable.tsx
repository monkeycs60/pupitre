import { useMemo } from 'react'
import { MAX_PREVIEW_ROWS, parseDelimited } from './delimited'

export function DelimitedTable({ content, kind = 'csv' }: { content: string; kind?: 'csv' | 'tsv' }) {
  const data = useMemo(() => parseDelimited(content, kind), [content, kind])

  if (data.headers.length === 0) return <p className="delimited-table-empty">Le fichier est vide.</p>

  return (
    <div className="delimited-table-shell">
      <div className="delimited-table-scroll" tabIndex={0}>
        <table className="delimited-table">
          <thead>
            <tr>
              <th className="delimited-table-index" scope="col" aria-label="Numéro de ligne">#</th>
              {data.headers.map((header, index) => <th key={`${header}-${index}`} scope="col">{header}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="delimited-table-index" scope="row">{rowIndex + 1}</th>
                {data.headers.map((_, columnIndex) => <td key={columnIndex} title={row[columnIndex] ?? ''}>{row[columnIndex] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="delimited-table-status">
        {data.totalRows.toLocaleString('fr-FR')} ligne{data.totalRows === 1 ? '' : 's'}
        {data.truncated ? ` · aperçu limité aux ${MAX_PREVIEW_ROWS.toLocaleString('fr-FR')} premières` : ''}
      </p>
    </div>
  )
}
