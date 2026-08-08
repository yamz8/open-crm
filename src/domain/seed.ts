import type { Ctx } from './context.ts';
import { RESOURCES } from './resources.ts';
import { create } from './store.ts';
import { createDeal, moveDeal } from './deals.ts';
import { ensureDefaultPipeline, getDefaultPipeline } from './pipelines.ts';
import { addTags } from './tags.ts';
import type { StageRow } from './pipelines.ts';

/**
 * Demo data that exercises every part of the model — pipelines, timelines,
 * overdue tasks, a won deal, a lost deal — so `selfcheck`, the dashboards, and
 * the work queue all have something real to say immediately after install.
 */
export function seedDemoData(ctx: Ctx): { created: Record<string, number> } {
  ensureDefaultPipeline(ctx);
  const pipeline = getDefaultPipeline(ctx);
  const stages = ctx.db
    .prepare('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position ASC')
    .all(pipeline.id) as StageRow[];

  const stageId = (name: string): string =>
    stages.find((s) => s.name === name)?.id ?? stages[0]!.id;

  const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
  const daysAhead = (days: number): string =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  const counts: Record<string, number> = {
    companies: 0,
    contacts: 0,
    deals: 0,
    activities: 0,
    tasks: 0,
  };

  const companySpecs = [
    {
      name: 'Northwind Logistics',
      domain: 'northwind.example',
      industry: 'Logistics',
      size: '201-500',
    },
    {
      name: 'Verity Health',
      domain: 'verityhealth.example',
      industry: 'Healthcare',
      size: '1001-5000',
    },
    {
      name: 'Lumen Robotics',
      domain: 'lumenrobotics.example',
      industry: 'Manufacturing',
      size: '51-200',
    },
    {
      name: 'Ashgrove Capital',
      domain: 'ashgrove.example',
      industry: 'Financial Services',
      size: '11-50',
    },
    { name: 'Tidewater Studios', domain: 'tidewater.example', industry: 'Media', size: '11-50' },
  ];

  const companies = companySpecs.map((spec) => {
    counts['companies']!++;
    return create(ctx, RESOURCES['company']!, {
      ...spec,
      website: `https://${spec.domain}`,
      description: `${spec.name} — seeded demo record.`,
    });
  });

  const contactSpecs = [
    {
      first_name: 'Dana',
      last_name: 'Whitfield',
      title: 'VP Operations',
      company: 0,
      lifecycle_stage: 'opportunity',
    },
    {
      first_name: 'Marcus',
      last_name: 'Ide',
      title: 'Logistics Manager',
      company: 0,
      lifecycle_stage: 'lead',
    },
    {
      first_name: 'Priya',
      last_name: 'Raman',
      title: 'Director of IT',
      company: 1,
      lifecycle_stage: 'customer',
    },
    {
      first_name: 'Tomas',
      last_name: 'Berg',
      title: 'Head of Engineering',
      company: 2,
      lifecycle_stage: 'qualified',
    },
    {
      first_name: 'Ines',
      last_name: 'Calder',
      title: 'COO',
      company: 2,
      lifecycle_stage: 'opportunity',
    },
    {
      first_name: 'Ruth',
      last_name: 'Oyelaran',
      title: 'Partner',
      company: 3,
      lifecycle_stage: 'lead',
    },
    {
      first_name: 'Sam',
      last_name: 'Petrov',
      title: 'Producer',
      company: 4,
      lifecycle_stage: 'subscriber',
    },
  ];

  const contacts = contactSpecs.map((spec) => {
    counts['contacts']!++;
    const company = companies[spec.company]!;
    return create(ctx, RESOURCES['contact']!, {
      first_name: spec.first_name,
      last_name: spec.last_name,
      title: spec.title,
      email: `${spec.first_name.toLowerCase()}.${spec.last_name.toLowerCase()}@${String(company['domain'])}`,
      phone: `+1-555-01${String(counts['contacts']).padStart(2, '0')}`,
      company_id: company['id'],
      lifecycle_stage: spec.lifecycle_stage,
      source: 'seed',
    });
  });

  const dealSpecs = [
    {
      title: 'Northwind — fleet rollout',
      company: 0,
      contact: 0,
      amount: 4_800_000,
      stage: 'Proposal',
      close: 21,
    },
    {
      title: 'Verity Health — renewal',
      company: 1,
      contact: 2,
      amount: 2_400_000,
      stage: 'Negotiation',
      close: 10,
    },
    {
      title: 'Lumen Robotics — pilot',
      company: 2,
      contact: 3,
      amount: 950_000,
      stage: 'Qualified',
      close: 45,
    },
    {
      title: 'Ashgrove — advisory retainer',
      company: 3,
      contact: 5,
      amount: 1_200_000,
      stage: 'New',
      close: 60,
    },
    {
      title: 'Tidewater — production suite',
      company: 4,
      contact: 6,
      amount: 320_000,
      stage: 'New',
      close: 90,
    },
  ];

  const deals = dealSpecs.map((spec) => {
    counts['deals']!++;
    return createDeal(ctx, {
      title: spec.title,
      company_id: companies[spec.company]!['id'],
      contact_id: contacts[spec.contact]!['id'],
      amount: spec.amount,
      currency: 'USD',
      close_date: daysAhead(spec.close).slice(0, 10),
      description: 'Seeded demo opportunity.',
      ...(spec.stage === 'New' ? {} : { stage_id: stageId(spec.stage) }),
    });
  });

  // One closed-won and one closed-lost so win rate and revenue are not empty.
  const wonDeal = createDeal(ctx, {
    title: 'Verity Health — initial licence',
    company_id: companies[1]!['id'],
    contact_id: contacts[2]!['id'],
    amount: 1_750_000,
    currency: 'USD',
  });
  moveDeal(ctx, String(wonDeal['id']), {
    stage_id: stageId('Won'),
    note: 'Signed after security review.',
  });
  counts['deals']!++;

  const lostDeal = createDeal(ctx, {
    title: 'Tidewater — colour grading add-on',
    company_id: companies[4]!['id'],
    contact_id: contacts[6]!['id'],
    amount: 180_000,
    currency: 'USD',
  });
  moveDeal(ctx, String(lostDeal['id']), {
    stage_id: stageId('Lost'),
    note: 'Went with an incumbent vendor.',
  });
  counts['deals']!++;

  const activitySpecs = [
    {
      type: 'call',
      subject: 'Discovery call',
      body: 'Walked through current fleet tracking. Pain is manual dispatch.',
      contact: 0,
      deal: 0,
      days: 12,
      duration: 35,
      direction: 'outbound',
    },
    {
      type: 'email',
      subject: 'Sent proposal',
      body: 'Proposal v2 with the phased rollout option.',
      contact: 0,
      deal: 0,
      days: 5,
      direction: 'outbound',
    },
    {
      type: 'meeting',
      subject: 'Renewal planning',
      body: 'Priya wants SSO before signing. Security review scheduled.',
      contact: 2,
      deal: 1,
      days: 8,
      duration: 60,
    },
    {
      type: 'note',
      subject: 'Budget context',
      body: 'Budget cycle closes end of quarter — hard deadline.',
      contact: 2,
      deal: 1,
      days: 3,
    },
    {
      type: 'call',
      subject: 'Technical scoping',
      body: 'Tomas walked through the integration surface. Two-week pilot proposed.',
      contact: 3,
      deal: 2,
      days: 20,
      duration: 45,
      direction: 'inbound',
    },
    {
      type: 'note',
      subject: 'Intro from conference',
      body: 'Met Ruth at the operations summit.',
      contact: 5,
      days: 30,
    },
  ];

  for (const spec of activitySpecs) {
    counts['activities']!++;
    create(
      ctx,
      RESOURCES['activity']!,
      {
        type: spec.type,
        subject: spec.subject,
        body: spec.body,
        occurred_at: daysAgo(spec.days),
        contact_id: contacts[spec.contact]!['id'],
        company_id: contacts[spec.contact]!['company_id'],
        ...(spec.deal !== undefined ? { deal_id: deals[spec.deal]!['id'] } : {}),
        ...(spec.duration ? { duration_min: spec.duration } : {}),
        ...(spec.direction ? { direction: spec.direction } : {}),
      },
      {
        extra: { actor_type: ctx.actor.type, actor_id: ctx.actor.id, actor_label: ctx.actor.label },
        silent: true,
      },
    );
  }

  const taskSpecs = [
    { title: 'Send Northwind the revised pricing', due: -2, priority: 'high', contact: 0, deal: 0 },
    {
      title: 'Chase Verity security questionnaire',
      due: -1,
      priority: 'urgent',
      contact: 2,
      deal: 1,
    },
    { title: 'Schedule Lumen pilot kickoff', due: 3, priority: 'normal', contact: 3, deal: 2 },
    { title: 'Draft Ashgrove retainer scope', due: 6, priority: 'normal', contact: 5, deal: 3 },
    { title: 'Follow up with Sam about Q4 slate', due: 14, priority: 'low', contact: 6 },
  ];

  for (const spec of taskSpecs) {
    counts['tasks']!++;
    create(ctx, RESOURCES['task']!, {
      title: spec.title,
      priority: spec.priority,
      due_at: spec.due < 0 ? daysAgo(-spec.due) : daysAhead(spec.due),
      contact_id: contacts[spec.contact]!['id'],
      ...(spec.deal !== undefined ? { deal_id: deals[spec.deal]!['id'] } : {}),
    });
  }

  addTags(ctx, 'company', String(companies[0]!['id']), ['enterprise', 'logistics']);
  addTags(ctx, 'company', String(companies[1]!['id']), ['enterprise', 'renewal']);
  addTags(ctx, 'contact', String(contacts[0]!['id']), ['champion']);
  addTags(ctx, 'deal', String(deals[1]!['id']), ['at-risk']);

  return { created: counts };
}
