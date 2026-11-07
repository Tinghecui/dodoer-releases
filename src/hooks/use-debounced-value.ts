import { useEffect, useState } from "react"

/** The value, settled: it follows `value` only after `value` has stayed the
 *  same for `delayMs`. The first render returns `value` itself. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (Object.is(settled, value)) return
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs, settled])
  return settled
}
