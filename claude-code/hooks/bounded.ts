// Requête HTTP bornée dans le temps : null si elle échoue ou dépasse `timeoutMs`.
// Partagée par les appels au service (service.ts) et la demande de clé anonyme (key.ts).
import type { EngineInterface, HttpInit, HttpResponse } from 'claude-code'

export async function bounded($: EngineInterface, url: string, init: HttpInit,
                              timeoutMs: number): Promise<HttpResponse | null> {
  const stop = new AbortController()
  const request = $.http.fetch(url, init).catch(() => null)
  const late = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(() => null, () => null)
  try {
    return await Promise.race([request, late])
  } finally {
    stop.abort()
  }
}
