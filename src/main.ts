/**
 * Bootstrap and hash router (SPEC.md section 8).
 *
 * Routes: `#/` (library), `#/edit/:id` (editor), `#/play/:id` (practice), `#/settings`.
 * Ids must match ID_RE. An unknown route or a missing song id redirects with
 * `location.replace('#/')`. On the initial load and on every `hashchange` the current screen
 * is unmounted (`current?.()`), the root is emptied (`replaceChildren`) and the new screen is
 * mounted with its params.
 *
 * The pure helpers (`parseRoute`, `routeIsAvailable`, `titleForRoute`) are exported for tests;
 * the bootstrap only runs when a DOM with `#app` exists.
 */
import type { Screen } from './types';
import { getSong, isValidId } from './song/storage';
import { libraryScreen } from './ui/screens/library';
import { editorScreen } from './ui/screens/editor';
import { practiceScreen } from './ui/screens/practice';
import { settingsScreen } from './ui/screens/settings';

export type RouteName = 'library' | 'editor' | 'practice' | 'settings';

export interface Route {
  name: RouteName;
  params: Record<string, string>;
}

/** Hash of the library (the home screen and the redirect target). */
export const HOME_HASH = '#/';

export const APP_NAME = 'GuitarZero';

const SCREENS: Record<RouteName, Screen> = {
  library: libraryScreen,
  editor: editorScreen,
  practice: practiceScreen,
  settings: settingsScreen,
};

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parses a location hash into a route, or null when it matches nothing.
 * `''`, `'#'`, `'#/'` -> library. Trailing slashes and a `?query` suffix are ignored.
 */
export function parseRoute(hash: string): Route | null {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  path = path.trim();
  if (!path.startsWith('/')) {
    if (path === '') return { name: 'library', params: {} };
    return null;
  }
  const parts = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .map(decodeSegment);
  if (parts.length === 1 && parts[0] === '') return { name: 'library', params: {} };
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings', params: {} };
  if (parts.length === 2 && (parts[0] === 'edit' || parts[0] === 'play')) {
    const id = parts[1];
    if (!isValidId(id)) return null;
    return { name: parts[0] === 'edit' ? 'editor' : 'practice', params: { id } };
  }
  return null;
}

/** True when the route can be mounted: routes with an `id` need an existing song. */
export function routeIsAvailable(route: Route): boolean {
  if (route.name === 'editor' || route.name === 'practice') {
    const id = route.params.id;
    return typeof id === 'string' && getSong(id) !== null;
  }
  return true;
}

/** Document title for a route (Spanish UI). */
export function titleForRoute(route: Route): string {
  switch (route.name) {
    case 'library':
      return `${APP_NAME} — Biblioteca`;
    case 'editor':
      return `${APP_NAME} — Editor`;
    case 'practice':
      return `${APP_NAME} — Practicar`;
    case 'settings':
      return `${APP_NAME} — Ajustes`;
  }
}

/** Wires the router to `root`; returns a function that renders the current hash. */
export function createRouter(root: HTMLElement): () => void {
  let current: (() => void) | null = null;

  return function render(): void {
    const route = parseRoute(location.hash);
    if (!route || !routeIsAvailable(route)) {
      // The hashchange fired by replace() renders the library; if the hash cannot change
      // (it already is the home hash with a stale song id, which cannot happen) we would
      // simply render again on the next change.
      location.replace(HOME_HASH);
      return;
    }
    try {
      current?.();
    } catch (err) {
      console.error('Error al desmontar la pantalla anterior', err);
    }
    current = null;
    root.replaceChildren();
    root.dataset.route = route.name;
    document.title = titleForRoute(route);
    window.scrollTo(0, 0);
    current = SCREENS[route.name].mount(root, route.params);
  };
}

function boot(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('No se encontró el elemento #app');
  const render = createRouter(root);
  window.addEventListener('hashchange', render);
  render();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('app')) {
  boot();
}
