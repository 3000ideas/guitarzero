/** Minimal DOM helpers (no framework). */

type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

/**
 * h('button.primary', { onclick }, 'Texto') — tag may carry `.class` suffixes and `#id`.
 * Keys starting with `on` are event listeners; other keys become properties when they
 * exist on the element, attributes otherwise.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | string,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tagName, ...rest] = String(tag).split(/(?=[.#])/);
  const el = document.createElement(tagName || 'div') as HTMLElementTagNameMap[K];
  for (const part of rest) {
    if (part.startsWith('.')) el.classList.add(part.slice(1));
    else if (part.startsWith('#')) el.id = part.slice(1);
  }
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') {
        for (const c of String(value).split(/\s+/)) if (c) el.classList.add(c);
      } else if (key === 'style') {
        if (typeof value === 'string') el.setAttribute('style', value);
        else Object.assign(el.style, value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in el) {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child | Child[]): void {
  if (Array.isArray(children)) {
    for (const c of children) append(parent, c);
    return;
  }
  if (children === null || children === undefined || children === false) return;
  if (children instanceof Node) parent.appendChild(children);
  else parent.appendChild(document.createTextNode(String(children)));
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}

export function fmtSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
