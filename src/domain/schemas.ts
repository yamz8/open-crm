import { z } from 'zod';

/**
 * One schema per concept, reused by three consumers: HTTP request validation,
 * the generated OpenAPI document, and MCP tool input schemas. There is exactly
 * one definition of "what a valid contact looks like" in this codebase.
 */

const trimmed = z.string().trim();
const nullableText = trimmed.max(20_000).nullish().describe('Free text, or null to clear');
const shortText = trimmed.max(500).nullish();

export const properties = z
  .record(z.string(), z.unknown())
  .describe('Arbitrary custom fields. Use this instead of forking the schema.');

export const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Must be an ISO-8601 date-time, e.g. 2026-08-08T14:30:00Z',
  })
  .describe('ISO-8601 date-time');

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a calendar date formatted YYYY-MM-DD');

export const lifecycleStages = [
  'subscriber',
  'lead',
  'qualified',
  'opportunity',
  'customer',
  'evangelist',
  'churned',
] as const;

export const activityTypes = [
  'note',
  'call',
  'email',
  'meeting',
  'stage_change',
  'system',
] as const;
export const taskStatuses = ['open', 'done', 'cancelled'] as const;
export const taskPriorities = ['low', 'normal', 'high', 'urgent'] as const;
export const dealStatuses = ['open', 'won', 'lost'] as const;
export const roles = ['owner', 'admin', 'member', 'readonly'] as const;

const idRef = (kind: string) =>
  trimmed.regex(new RegExp(`^${kind}_[0-9A-Z]{26}$`), {
    message: `Must be a ${kind} id, e.g. ${kind}_01JQ8Z...`,
  });

export const companyId = idRef('comp');
export const contactId = idRef('cont');
export const dealId = idRef('deal');
export const userId = idRef('user');
export const pipelineId = idRef('pipe');
export const stageId = idRef('stg');

// -- Company -----------------------------------------------------------------

export const companyCreate = z.strictObject({
  name: trimmed.min(1, 'A company needs a name').max(300),
  domain: shortText.describe('Primary web domain, e.g. "acme.com". Unique across active records.'),
  industry: shortText,
  size: shortText.describe('Headcount band, e.g. "11-50"'),
  website: shortText,
  phone: shortText,
  address: nullableText,
  description: nullableText,
  owner_id: userId.nullish(),
  properties: properties.optional(),
});
export const companyUpdate = companyCreate.partial();

// -- Contact -----------------------------------------------------------------

export const contactCreate = z
  .strictObject({
    first_name: trimmed.max(200).optional(),
    last_name: trimmed.max(200).optional(),
    email: z.email('Must be a valid email address').nullish(),
    phone: shortText,
    title: shortText.describe('Job title'),
    company_id: companyId.nullish(),
    owner_id: userId.nullish(),
    lifecycle_stage: z.enum(lifecycleStages).optional(),
    source: shortText.describe('Where the contact came from, e.g. "inbound", "conference"'),
    linkedin_url: shortText,
    description: nullableText,
    properties: properties.optional(),
  })
  .refine((v) => Boolean(v.first_name || v.last_name || v.email), {
    message: 'Provide at least one of first_name, last_name, or email',
  });

export const contactUpdate = z.strictObject({
  first_name: trimmed.max(200).optional(),
  last_name: trimmed.max(200).optional(),
  email: z.email().nullish(),
  phone: shortText,
  title: shortText,
  company_id: companyId.nullish(),
  owner_id: userId.nullish(),
  lifecycle_stage: z.enum(lifecycleStages).optional(),
  source: shortText,
  linkedin_url: shortText,
  description: nullableText,
  properties: properties.optional(),
});

// -- Pipeline & stages -------------------------------------------------------

export const stageCreate = z.strictObject({
  name: trimmed.min(1).max(120),
  position: z.number().int().min(0).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  outcome: z.enum(['open', 'won', 'lost']).optional(),
});
export const stageUpdate = stageCreate.partial();

export const pipelineCreate = z.strictObject({
  name: trimmed.min(1).max(200),
  is_default: z.boolean().optional(),
  stages: z.array(stageCreate).min(1).optional(),
});
export const pipelineUpdate = z.strictObject({
  name: trimmed.min(1).max(200).optional(),
  is_default: z.boolean().optional(),
});

// -- Deal --------------------------------------------------------------------

export const dealCreate = z.strictObject({
  title: trimmed.min(1, 'A deal needs a title').max(300),
  company_id: companyId.nullish(),
  contact_id: contactId.nullish(),
  pipeline_id: pipelineId.nullish().describe('Defaults to the default pipeline'),
  stage_id: stageId.nullish().describe('Defaults to the first stage of the pipeline'),
  amount: z
    .number()
    .int('Amounts are integers in minor units — 1500 means $15.00')
    .min(0)
    .optional(),
  currency: trimmed.length(3).toUpperCase().optional(),
  close_date: isoDate.nullish().describe('Expected close date'),
  owner_id: userId.nullish(),
  description: nullableText,
  properties: properties.optional(),
});

export const dealUpdate = dealCreate.partial().extend({
  status: z.enum(dealStatuses).optional(),
  lost_reason: shortText,
});

export const dealMove = z.strictObject({
  stage_id: stageId,
  note: trimmed.max(5000).optional().describe('Optional note recorded on the deal timeline'),
});

export const dealClose = z.strictObject({
  outcome: z.enum(['won', 'lost']),
  reason: trimmed.max(1000).optional(),
  amount: z.number().int().min(0).optional().describe('Final amount, if it changed'),
});

// -- Activity ----------------------------------------------------------------

export const activityCreate = z
  .strictObject({
    type: z.enum(activityTypes).default('note'),
    subject: shortText,
    body: nullableText,
    direction: z.enum(['inbound', 'outbound']).nullish(),
    duration_min: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullish(),
    occurred_at: isoDateTime.optional().describe('Defaults to now'),
    contact_id: contactId.nullish(),
    company_id: companyId.nullish(),
    deal_id: dealId.nullish(),
    properties: properties.optional(),
  })
  .refine((v) => Boolean(v.contact_id || v.company_id || v.deal_id), {
    message: 'An activity must be attached to at least one of contact_id, company_id, or deal_id',
  });

export const activityUpdate = z.strictObject({
  type: z.enum(activityTypes).optional(),
  subject: shortText,
  body: nullableText,
  direction: z.enum(['inbound', 'outbound']).nullish(),
  duration_min: z.number().int().min(0).nullish(),
  occurred_at: isoDateTime.optional(),
  properties: properties.optional(),
});

// -- Task --------------------------------------------------------------------

export const taskCreate = z.strictObject({
  title: trimmed.min(1, 'A task needs a title').max(300),
  description: nullableText,
  status: z.enum(taskStatuses).optional(),
  priority: z.enum(taskPriorities).optional(),
  due_at: isoDateTime.nullish(),
  assignee_id: userId.nullish(),
  contact_id: contactId.nullish(),
  company_id: companyId.nullish(),
  deal_id: dealId.nullish(),
  properties: properties.optional(),
});
export const taskUpdate = taskCreate.partial();

// -- Tags --------------------------------------------------------------------

export const tagCreate = z.strictObject({
  name: trimmed.min(1).max(80),
  color: trimmed.regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #6366f1').optional(),
});
export const tagUpdate = tagCreate.partial();

export const taggingInput = z.strictObject({
  tags: z.array(trimmed.min(1).max(80)).min(1).describe('Tag names; created on demand'),
});

// -- Query -------------------------------------------------------------------

/**
 * Query strings carry booleans as text, and `Boolean("false")` is `true` — a
 * bug that silently un-hides archived records. Parse the literal instead.
 */
export const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const listQuery = z.object({
  q: trimmed.max(500).optional().describe('Full-text search across the record'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: trimmed.optional().describe('Opaque cursor from the previous page'),
  sort: trimmed.optional().describe('Field name, prefix with "-" for descending'),
  include_archived: booleanish.optional(),
  filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const searchQuery = z.object({
  q: trimmed.min(1, 'Provide a search phrase').max(500),
  types: z.array(z.enum(['contact', 'company', 'deal', 'activity', 'task'])).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// -- Auth --------------------------------------------------------------------

export const email = z.email().toLowerCase();
export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .describe('Minimum 10 characters');

export const setupInput = z.strictObject({
  email,
  name: trimmed.min(1).max(200),
  password,
});

export const loginInput = z.strictObject({ email, password: z.string().min(1) });

export const userCreate = z.strictObject({
  email,
  name: trimmed.min(1).max(200),
  password,
  role: z.enum(roles).optional(),
});

export const userUpdate = z.strictObject({
  name: trimmed.min(1).max(200).optional(),
  email: email.optional(),
  role: z.enum(roles).optional(),
  password: password.optional(),
  disabled: z.boolean().optional(),
});

export const tokenCreate = z.strictObject({
  name: trimmed.min(1).max(200).describe('What is this token for? e.g. "claude-code-laptop"'),
  scopes: z
    .array(trimmed.min(1))
    .optional()
    .describe('Defaults to ["*"]. Use "contacts:read", "deals:write", etc.'),
  expires_at: isoDateTime.nullish(),
});

export const webhookCreate = z.strictObject({
  url: z.url('Must be an absolute http(s) URL'),
  events: z.array(trimmed.min(1)).optional().describe('Defaults to ["*"]'),
  description: shortText,
  active: z.boolean().optional(),
});
export const webhookUpdate = webhookCreate.partial();

export const savedViewCreate = z.strictObject({
  name: trimmed.min(1).max(200),
  entity_type: z.enum(['contact', 'company', 'deal', 'task', 'activity']),
  query: z.record(z.string(), z.unknown()).optional(),
  shared: z.boolean().optional(),
});
export const savedViewUpdate = savedViewCreate.partial();

export type ListQuery = z.infer<typeof listQuery>;
export type SearchQuery = z.infer<typeof searchQuery>;
