/** A ~40-line view layer. No framework, no build-time magic, no upgrade treadmill. */

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'dataset') Object.assign(element.dataset, value as object);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'html') element.innerHTML = String(value);
    else if (key in element && key !== 'list') (element as never as Props)[key] = value;
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(target: HTMLElement, ...children: Child[]): void {
  target.replaceChildren();
  append(target, children);
}

export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

// -- Formatting ---------------------------------------------------------------

export function money(minorUnits: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format((minorUnits ?? 0) / 100);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '—';
  const abs = Math.abs(ms);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (abs >= size) return formatter.format(Math.round(ms / size), unit);
  }
  return 'just now';
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function initials(label: string): string {
  return (
    label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

/** Deterministic accent colour so the same record always looks the same. */
export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const palette = [
    '#6366f1',
    '#0ea5e9',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#ec4899',
    '#14b8a6',
  ];
  return palette[Math.abs(hash) % palette.length]!;
}

// -- Toasts -------------------------------------------------------------------

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const host = $('#toasts') ?? document.body.appendChild(h('div', { id: 'toasts' }));
  const node = h('div', { class: `toast toast-${kind}` }, message);
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 250);
  }, 4200);
}
