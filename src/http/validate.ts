import type { ZodType } from 'zod';
import { validationFailed } from '../core/errors.ts';

export type FieldIssue = { field: string; message: string; code: string };

/**
 * Validation errors are the most common thing an agent sees, so they are
 * formatted to be acted on: a flat list of `field` + `message`, plus the list of
 * accepted fields when the caller sent something unrecognized.
 */
export function parse<T>(schema: ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const issues: FieldIssue[] = result.error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));

  const unknownKeys = result.error.issues
    .filter((i) => i.code === 'unrecognized_keys')
    .flatMap((i) => (i as unknown as { keys: string[] }).keys ?? []);

  const hint = unknownKeys.length
    ? `Unrecognized field(s): ${unknownKeys.join(', ')}. Call GET /api/v1/discover to see the accepted shape for ${what}.`
    : `Fix the listed fields and retry. GET /api/v1/discover documents ${what}.`;

  throw validationFailed(`Invalid ${what}`, issues, hint);
}

/**
 * Express-style bracket query strings (`filter[status]=open`) arrive flat from
 * Fastify's default parser, so unpack them into the nested object zod expects.
 */
export function unflattenQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    const match = /^(\w+)\[([^\]]+)\]$/.exec(key);
    if (match) {
      const [, outer, inner] = match as unknown as [string, string, string];
      const bucket = (out[outer] ??= {}) as Record<string, unknown>;
      bucket[inner] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}
