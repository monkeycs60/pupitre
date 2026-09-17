const MAX_PREVIEW_ROWS = 500

export type DelimitedData = {
  headers: string[]
  rows: string[][]
  totalRows: number
  truncated: boolean
}

function detectDelimiter(content: string, fallback: ',' | '\t'): ',' | ';' | '\t' {
  if (fallback === '\t') return '\t'
  const sample = content.split(/\r?\n/, 1)[0] ?? ''
  const counts = ([',', ';', '\t'] as const).map((delimiter) => ({
    delimiter,
    count: sample.split(delimiter).length - 1,
  }))
  counts.sort((left, right) => right.count - left.count)
  return counts[0].count > 0 ? counts[0].delimiter : fallback
}

export function parseDelimited(content: string, kind: 'csv' | 'tsv'): DelimitedData {
  const delimiter = detectDelimiter(content, kind === 'tsv' ? '\t' : ',')
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"' && field === '') {
      quoted = true
    } else if (character === delimiter) {
      record.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1
      record.push(field)
      if (record.some((value) => value !== '')) records.push(record)
      record = []
      field = ''
    } else {
      field += character
    }
  }

  record.push(field)
  if (record.some((value) => value !== '')) records.push(record)

  const headers = (records.shift() ?? []).map((value, index) => {
    const cleaned = index === 0 ? value.replace(/^\uFEFF/, '') : value
    return cleaned || `Colonne ${index + 1}`
  })
  const totalRows = records.length
  return {
    headers,
    rows: records.slice(0, MAX_PREVIEW_ROWS),
    totalRows,
    truncated: totalRows > MAX_PREVIEW_ROWS,
  }
}

export { MAX_PREVIEW_ROWS }
