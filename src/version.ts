/**
 * App version shown in Ajustes and used by "Buscar actualización". The build also writes the same
 * string to `version.json` next to index.html, so an installed (home-screen) copy can ask the
 * server what is current without knowing any URL.
 */

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'desarrollo';

export type UpdateCheck = { kind: 'current' } | { kind: 'newer'; version: string } | { kind: 'error'; message: string };

/** Asks the server for version.json (never from cache) and compares it with this build. */
export async function checkForUpdate(fetchFn: typeof fetch = fetch, baseUrl: string = document.baseURI): Promise<UpdateCheck> {
  try {
    const url = new URL('version.json', baseUrl);
    url.searchParams.set('t', String(Date.now()));
    const res = await fetchFn(url.toString(), { cache: 'no-store' });
    if (!res.ok) return { kind: 'error', message: `El servidor respondió ${res.status}` };
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== 'string') return { kind: 'error', message: 'Respuesta de versión no válida' };
    return data.version === APP_VERSION ? { kind: 'current' } : { kind: 'newer', version: data.version };
  } catch {
    return { kind: 'error', message: 'Sin conexión o servidor no disponible' };
  }
}

/** Drops any Cache Storage / service workers and reloads through a cache-busting URL (keeps the route). */
export async function reloadFresh(): Promise<void> {
  try {
    if ('caches' in globalThis) for (const k of await caches.keys()) await caches.delete(k);
    if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch {
    /* best effort */
  }
  const u = new URL(location.href);
  u.searchParams.set('v', String(Date.now()));
  location.replace(u.toString());
}
