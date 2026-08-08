import { randomBytes } from 'node:crypto';

/**
 * Prefixed, sortable, URL-safe identifiers.
 *
 * The prefix matters more than it looks: an agent that reads `deal_01J...` in a
 * log line knows what endpoint to call without a lookup, and a mistyped id fails
 * loudly at the boundary instead of silently addressing the wrong table.
 */
export const ID_PREFIXES = {
  user: 'user',
  session: 'sess',
  token: 'tok',
  company: 'comp',
  contact: 'cont',
  pipeline: 'pipe',
  stage: 'stg',
  deal: 'deal',
  activity: 'act',
  task: 'task',
  tag: 'tag',
  audit: 'aud',
  webhook: 'whk',
  delivery: 'dlv',
  view: 'view',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Monotonic counter so ids generated inside the same millisecond keep their order. */
let lastTimestamp = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let value = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => b % 32);
}

function incrementRandom(chars: number[]): number[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    const current = next[i] ?? 0;
    if (current < 31) {
      next[i] = current + 1;
      return next;
    }
    next[i] = 0;
  }
  return randomChars();
}

/** ULID-style: 10 chars of timestamp + 16 chars of randomness, lexicographically sortable. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTimestamp) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTimestamp = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((n) => CROCKFORD[n]).join('');
}

export function newId(kind: EntityKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

export function isId(kind: EntityKind, value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${ID_PREFIXES[kind]}_`);
}

/** Returns the entity kind encoded in an id, or null when the prefix is unknown. */
export function kindOfId(value: string): EntityKind | null {
  const prefix = value.split('_')[0];
  if (!prefix) return null;
  for (const [kind, p] of Object.entries(ID_PREFIXES)) {
    if (p === prefix) return kind as EntityKind;
  }
  return null;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
