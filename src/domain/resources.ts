import type { ZodType } from 'zod';
import type { EntityKind } from '../core/ids.ts';
import * as S from './schemas.ts';

export type SortSpec = {
  /** SQL expression used for ordering. Coalesced so NULLs never break keyset paging. */
  expr: string;
  type: 'text' | 'number';
};

export type ResourceDef = {
  /** Singular machine name, also the `object` field on every serialized record. */
  name: string;
  plural: string;
  table: string;
  idKind: EntityKind;
  /** Permission scope, e.g. "contacts". */
  scope: string;
  description: string;
  createSchema: ZodType;
  updateSchema: ZodType;
  /** Columns a client may write. Anything else is rejected with a suggestion. */
  writable: readonly string[];
  jsonColumns: readonly string[];
  archivable: boolean;
  defaultSort: string;
  sortable: Record<string, SortSpec>;
  filterable: readonly string[];
  taggable: boolean;
  /** Text pulled into the full-text index. */
  searchText: (row: Record<string, unknown>) => { title: string; body: string } | null;
  /** One-line human label, used in the UI, CLI output, and MCP tool responses. */
  label: (row: Record<string, unknown>) => string;
};

const text = (col: string): SortSpec => ({ expr: `COALESCE(${col}, '')`, type: 'text' });
const num = (col: string): SortSpec => ({ expr: `COALESCE(${col}, 0)`, type: 'number' });
const dateCol = (col: string): SortSpec => ({
  expr: `COALESCE(${col}, '9999-12-31')`,
  type: 'text',
});

const str = (row: Record<string, unknown>, key: string): string => {
  const v = row[key];
  return typeof v === 'string' ? v : '';
};

export const contactResource: ResourceDef = {
  name: 'contact',
  plural: 'contacts',
  table: 'contacts',
  idKind: 'contact',
  scope: 'contacts',
  description: 'A person. The unit most CRM work hangs off of.',
  createSchema: S.contactCreate,
  updateSchema: S.contactUpdate,
  writable: [
    'first_name',
    'last_name',
    'email',
    'phone',
    'title',
    'company_id',
    'owner_id',
    'lifecycle_stage',
    'source',
    'linkedin_url',
    'description',
    'properties',
  ],
  jsonColumns: ['properties'],
  archivable: true,
  defaultSort: '-created_at',
  sortable: {
    created_at: text('created_at'),
    updated_at: text('updated_at'),
    last_name: text('last_name'),
    first_name: text('first_name'),
    email: text('email'),
    lifecycle_stage: text('lifecycle_stage'),
  },
  filterable: ['company_id', 'owner_id', 'lifecycle_stage', 'source', 'email', 'title'],
  taggable: true,
  searchText: (row) => ({
    title: `${str(row, 'first_name')} ${str(row, 'last_name')}`.trim() || str(row, 'email'),
    body: [
      str(row, 'email'),
      str(row, 'phone'),
      str(row, 'title'),
      str(row, 'source'),
      str(row, 'description'),
    ]
      .filter(Boolean)
      .join(' \n'),
  }),
  label: (row) =>
    `${str(row, 'first_name')} ${str(row, 'last_name')}`.trim() ||
    str(row, 'email') ||
    'Unnamed contact',
};

export const companyResource: ResourceDef = {
  name: 'company',
  plural: 'companies',
  table: 'companies',
  idKind: 'company',
  scope: 'companies',
  description: 'An organization. Contacts and deals attach to it.',
  createSchema: S.companyCreate,
  updateSchema: S.companyUpdate,
  writable: [
    'name',
    'domain',
    'industry',
    'size',
    'website',
    'phone',
    'address',
    'description',
    'owner_id',
    'properties',
  ],
  jsonColumns: ['properties'],
  archivable: true,
  defaultSort: '-created_at',
  sortable: {
    created_at: text('created_at'),
    updated_at: text('updated_at'),
    name: text('name'),
    industry: text('industry'),
  },
  filterable: ['owner_id', 'industry', 'size', 'domain'],
  taggable: true,
  searchText: (row) => ({
    title: str(row, 'name'),
    body: [
      str(row, 'domain'),
      str(row, 'industry'),
      str(row, 'website'),
      str(row, 'address'),
      str(row, 'description'),
    ]
      .filter(Boolean)
      .join(' \n'),
  }),
  label: (row) => str(row, 'name') || 'Unnamed company',
};

export const dealResource: ResourceDef = {
  name: 'deal',
  plural: 'deals',
  table: 'deals',
  idKind: 'deal',
  scope: 'deals',
  description: 'A revenue opportunity moving through pipeline stages.',
  createSchema: S.dealCreate,
  updateSchema: S.dealUpdate,
  writable: [
    'title',
    'company_id',
    'contact_id',
    'pipeline_id',
    'stage_id',
    'amount',
    'currency',
    'status',
    'close_date',
    'lost_reason',
    'owner_id',
    'description',
    'properties',
  ],
  jsonColumns: ['properties'],
  archivable: true,
  defaultSort: '-created_at',
  sortable: {
    created_at: text('created_at'),
    updated_at: text('updated_at'),
    title: text('title'),
    amount: num('amount'),
    close_date: dateCol('close_date'),
  },
  filterable: [
    'pipeline_id',
    'stage_id',
    'status',
    'company_id',
    'contact_id',
    'owner_id',
    'currency',
    'amount',
    'close_date',
  ],
  taggable: true,
  searchText: (row) => ({
    title: str(row, 'title'),
    body: [str(row, 'description'), str(row, 'lost_reason')].filter(Boolean).join(' \n'),
  }),
  label: (row) => str(row, 'title') || 'Untitled deal',
};

export const activityResource: ResourceDef = {
  name: 'activity',
  plural: 'activities',
  table: 'activities',
  idKind: 'activity',
  scope: 'activities',
  description: 'A timeline entry: note, call, email, meeting, or system event.',
  createSchema: S.activityCreate,
  updateSchema: S.activityUpdate,
  writable: [
    'type',
    'subject',
    'body',
    'direction',
    'duration_min',
    'occurred_at',
    'contact_id',
    'company_id',
    'deal_id',
    'properties',
  ],
  jsonColumns: ['properties'],
  archivable: true,
  defaultSort: '-occurred_at',
  sortable: {
    occurred_at: text('occurred_at'),
    created_at: text('created_at'),
    type: text('type'),
  },
  filterable: [
    'type',
    'contact_id',
    'company_id',
    'deal_id',
    'actor_type',
    'actor_id',
    'direction',
  ],
  taggable: false,
  searchText: (row) => ({
    title: str(row, 'subject') || str(row, 'type'),
    body: str(row, 'body'),
  }),
  label: (row) => str(row, 'subject') || `${str(row, 'type')} activity`,
};

export const taskResource: ResourceDef = {
  name: 'task',
  plural: 'tasks',
  table: 'tasks',
  idKind: 'task',
  scope: 'tasks',
  description: 'Something a human or agent still has to do, optionally linked to a record.',
  createSchema: S.taskCreate,
  updateSchema: S.taskUpdate,
  writable: [
    'title',
    'description',
    'status',
    'priority',
    'due_at',
    'assignee_id',
    'contact_id',
    'company_id',
    'deal_id',
    'properties',
  ],
  jsonColumns: ['properties'],
  archivable: true,
  defaultSort: 'due_at',
  sortable: {
    due_at: dateCol('due_at'),
    created_at: text('created_at'),
    updated_at: text('updated_at'),
    priority: text('priority'),
    title: text('title'),
  },
  filterable: [
    'status',
    'priority',
    'assignee_id',
    'contact_id',
    'company_id',
    'deal_id',
    'due_at',
  ],
  taggable: true,
  searchText: (row) => ({ title: str(row, 'title'), body: str(row, 'description') }),
  label: (row) => str(row, 'title') || 'Untitled task',
};

export const RESOURCES: Record<string, ResourceDef> = {
  contact: contactResource,
  company: companyResource,
  deal: dealResource,
  activity: activityResource,
  task: taskResource,
};

export const RESOURCE_LIST: ResourceDef[] = Object.values(RESOURCES);

export function resourceByPlural(plural: string): ResourceDef | undefined {
  return RESOURCE_LIST.find((r) => r.plural === plural);
}
