'use client'

import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'

export function useRefreshSafeDraft<T>({
  identity,
  version,
  serverValue,
}: {
  identity: string
  version: string
  serverValue: T
}) {
  const [draft, setDraftState] = useState(serverValue)
  const [dirty, setDirtyState] = useState(false)
  const dirtyRef = useRef(false)
  const identityRef = useRef(identity)

  useEffect(() => {
    const identityChanged = identityRef.current !== identity
    if (identityChanged || !dirtyRef.current) {
      setDraftState(serverValue)
      dirtyRef.current = false
      setDirtyState(false)
    }
    identityRef.current = identity
  }, [identity, serverValue, version])

  const setDraft = useCallback((next: SetStateAction<T>) => {
    dirtyRef.current = true
    setDraftState(next)
    setDirtyState(true)
  }, [])

  const markClean = useCallback(() => {
    dirtyRef.current = false
    setDirtyState(false)
  }, [])

  return { draft, setDraft, dirty, markClean }
}
