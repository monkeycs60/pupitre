import { useEffect, useState } from 'react'
import { getSettings } from './api'
import { DEFAULT_ACTION_FORMAT, type ActionFormat } from './actionHeadings'
import { retryUntilAvailable } from './startupRetry'

export function useActionFormat(): ActionFormat {
  const [actionFormat, setActionFormat] = useState<ActionFormat>(DEFAULT_ACTION_FORMAT)

  useEffect(() => {
    let ignore = false
    void retryUntilAvailable(() => getSettings(), { cancelled: () => ignore })
      .then((settings) => {
        if (ignore || !settings?.actionFormat) return
        setActionFormat({ ...DEFAULT_ACTION_FORMAT, ...settings.actionFormat })
      })
    return () => {
      ignore = true
    }
  }, [])

  return actionFormat
}
