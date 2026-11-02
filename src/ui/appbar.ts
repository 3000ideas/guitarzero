/**
 * The bar at the top of every screen: logo and tagline on the left, the menus on the right
 * (Canciones, Afinador, Ajustes) and, inside a song, the switch Practicar / Editar.
 *
 * It lives OUTSIDE the router's root (the router empties the root on every route), is created once and
 * updated with `update(route)`. It publishes its height as `--appbar-h` so full-screen layouts (the practice
 * highway, the editor studio) can leave room for it.
 */
import { h } from './dom';
import { isExampleId } from '../song/examples';

export interface AppBarRoute {
  name: 'library' | 'editor' | 'practice' | 'settings' | 'tuner';
  params: Record<string, string>;
}

export interface AppBar {
  el: HTMLElement;
  update(route: AppBarRoute): void;
}

export const TAGLINE = 'Practica acordes al ritmo de la pelota';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The logo: a ball bouncing along a dotted path. */
function logo(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '30');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<defs><linearGradient id="gz-logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#4ade80"/></linearGradient></defs>' +
    '<path d="M3 25 Q 9 5 15 21 T 26 11" stroke="url(#gz-logo-g)" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-dasharray="0.5 5.2"/>' +
    '<circle cx="26" cy="9" r="5.2" fill="url(#gz-logo-g)"/><circle cx="24.4" cy="7.4" r="1.4" fill="#fff" fill-opacity="0.55"/>';
  return svg;
}

export function createAppBar(): AppBar {
  const brand = h(
    'a.appbar-brand',
    { href: '#/', title: 'GuitarZero: la biblioteca de canciones' },
    logo() as unknown as Node,
    h('span.appbar-name', null, h('strong', null, 'GuitarZero'), h('span.appbar-tagline', null, TAGLINE)),
  );

  const practiceLink = h('a.appbar-seg', { role: 'tab' }, 'Practicar');
  const editLink = h('a.appbar-seg', { role: 'tab' }, 'Editar');
  const seg = h('div.appbar-segs', { role: 'tablist', 'aria-label': 'Practicar o editar esta canción' }, practiceLink, editLink);
  const songGroup = h('div.appbar-song', null, seg);
  songGroup.hidden = true;

  const navLink = (href: string, label: string, title: string): HTMLAnchorElement => h('a.appbar-link', { href, title }, label) as HTMLAnchorElement;
  const libraryLink = navLink('#/', 'Canciones', 'Tus canciones y los ejemplos');
  const tunerLink = navLink('#/tuner', 'Afinador', 'Comprueba si la guitarra está afinada');
  const settingsLink = navLink('#/settings', 'Ajustes', 'Micrófono, latencia, afinación y versión de la app');
  const nav = h('nav.appbar-nav', { 'aria-label': 'Menú principal' }, libraryLink, tunerLink, settingsLink);

  const el = h('header.appbar', null, brand, songGroup, nav);

  function mark(link: HTMLElement, on: boolean): void {
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  /** Publishes the real height (the bar wraps on narrow screens) for the layouts that sit under it. */
  function publishHeight(): void {
    document.documentElement.style.setProperty('--appbar-h', `${el.offsetHeight}px`);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(publishHeight).observe(el);

  const bar: AppBar = {
    el,
    update(route) {
      mark(libraryLink, route.name === 'library');
      mark(tunerLink, route.name === 'tuner');
      mark(settingsLink, route.name === 'settings');
      const id = route.params.id;
      const inSong = (route.name === 'editor' || route.name === 'practice') && typeof id === 'string';
      songGroup.hidden = !inSong;
      if (inSong) {
        practiceLink.setAttribute('href', `#/play/${id}`);
        mark(practiceLink, route.name === 'practice');
        const readOnly = isExampleId(id);
        // Examples are read-only: «Editar» there makes a copy from the library, so it is not offered here.
        editLink.hidden = readOnly;
        if (!readOnly) editLink.setAttribute('href', `#/edit/${id}`);
        mark(editLink, route.name === 'editor');
      }
      publishHeight();
    },
  };
  return bar;
}
