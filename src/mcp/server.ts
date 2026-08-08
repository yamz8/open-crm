import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, TOOLS_BY_NAME } from './tools.ts';
import type { Executor } from './executor.ts';
import { VERSION } from '../core/version.ts';

export const MCP_SERVER_INFO = { name: 'open-crm', version: VERSION };

const INSTRUCTIONS = `open-crm is a self-hosted CRM you share with human colleagues.

Orientation:
- crm_whoami tells you which credentials you hold and what they may do.
- crm_discover returns the full capability map; read it once before unfamiliar work.
- crm_work_queue is the best first call in a working session: it says what is overdue,
  what has gone quiet, and suggests the next action.

Working well here:
- Search before you create. Duplicate contacts are the most common damage an agent does.
- Use crm_get_context, not several reads: it returns the record with its relations,
  timeline, and open tasks in one call.
- Money is an integer in minor units. 150000 means $1,500.00.
- Move deals with crm_move_deal rather than editing stage_id — it keeps the status,
  the close date, and the timeline consistent, and records why.
- Pass an idempotency_key on writes so a retry cannot duplicate the record.
- Archive rather than delete. Archiving is reversible; hard deletion is not.

Accountability:
Every change you make is attributed to your token with a full before-image. A human can
review your work with crm_audit and undo any single change with crm_revert. Leave notes
on timelines when you change something a person will later wonder about.`;

type Content = { type: 'text'; text: string };

function toContent(value: unknown): Content[] {
  return [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ];
}

export function createMcpServer(exec: Executor): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly,
        destructiveHint: tool.name === 'crm_archive' || tool.name === 'crm_revert',
        idempotentHint: tool.readOnly,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS_BY_NAME.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: toContent({
          error: `Unknown tool "${request.params.name}"`,
          available: [...TOOLS_BY_NAME.keys()],
        }),
      };
    }

    let call;
    try {
      call = tool.build((request.params.arguments ?? {}) as Record<string, unknown>);
    } catch (error) {
      return {
        isError: true,
        content: toContent({ error: error instanceof Error ? error.message : String(error) }),
      };
    }

    const result = await exec(call);
    // Errors come back as tool results rather than protocol errors so the model
    // can read the `hint` and correct itself instead of just seeing a failure.
    return {
      isError: result.status >= 400,
      content: toContent(result.body),
      structuredContent: isRecord(result.body) ? result.body : { result: result.body },
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'crm://discover',
        name: 'Capability map',
        description: 'Every record type, field, filter, and workflow this instance supports.',
        mimeType: 'application/json',
      },
      {
        uri: 'crm://work-queue',
        name: 'Work queue',
        description: 'Overdue tasks, stale deals, and untouched contacts right now.',
        mimeType: 'application/json',
      },
      {
        uri: 'crm://overview',
        name: 'Overview metrics',
        description: 'Counts, revenue, and win rate over the last 30 days.',
        mimeType: 'application/json',
      },
      {
        uri: 'crm://pipelines',
        name: 'Pipelines and stages',
        description: 'Stage ids you need in order to move deals.',
        mimeType: 'application/json',
      },
    ],
  }));

  const RESOURCE_ROUTES: Record<string, string> = {
    'crm://discover': '/api/v1/discover',
    'crm://work-queue': '/api/v1/insights/work-queue',
    'crm://overview': '/api/v1/insights/overview',
    'crm://pipelines': '/api/v1/pipelines',
  };

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const path = RESOURCE_ROUTES[request.params.uri];
    if (!path) throw new Error(`Unknown resource ${request.params.uri}`);
    const result = await exec({ method: 'GET', path });
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: 'application/json',
          text: JSON.stringify(result.body, null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'daily_review',
        title: 'Daily CRM review',
        description: 'Work through everything that needs attention today and report what changed.',
        arguments: [{ name: 'assignee_id', description: 'Focus on one user', required: false }],
      },
      {
        name: 'prep_for_meeting',
        title: 'Prepare for a meeting',
        description: 'Assemble the full picture on a person or company before you talk to them.',
        arguments: [{ name: 'who', description: 'Name, email, or company', required: true }],
      },
      {
        name: 'review_agent_changes',
        title: 'Review what an agent changed',
        description:
          'Audit an API token’s recent writes and flag anything that should be reverted.',
        arguments: [
          { name: 'actor_id', description: 'User or token id', required: true },
          { name: 'since', description: 'ISO-8601 timestamp', required: false },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    const text = promptText(request.params.name, args);
    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
    };
  });

  return server;
}

function promptText(name: string, args: Record<string, string>): string {
  switch (name) {
    case 'daily_review':
      return `Run today's CRM review${args['assignee_id'] ? ` for ${args['assignee_id']}` : ''}.

1. Call crm_work_queue${args['assignee_id'] ? ` with assignee_id "${args['assignee_id']}"` : ''}.
2. For each overdue task, decide: complete it (crm_complete_task), reschedule it
   (crm_update with a new due_at), or leave it and say why.
3. For each stale deal, open crm_get_context and either log an activity with the latest
   state or move the stage with crm_move_deal, giving a reason in the note.
4. Finish with crm_overview and write a short summary: what you changed, what you left
   alone, and what a human needs to decide.

Do not invent facts about conversations that did not happen. If a deal is stale and you
have no new information, say so rather than logging a filler note.`;

    case 'prep_for_meeting':
      return `Prepare a briefing on "${args['who'] ?? ''}".

1. crm_search for them.
2. crm_get_context on the best match (and on their company, if the match is a person).
3. Summarize: who they are, the current state of any open deals with amounts and stages,
   what was last discussed and when, what is still outstanding, and the two or three
   things worth raising.

Quote dates and amounts exactly as stored. Flag anything that looks stale or contradictory
instead of smoothing it over.`;

    case 'review_agent_changes':
      return `Review what actor "${args['actor_id'] ?? ''}" changed${args['since'] ? ` since ${args['since']}` : ' in the last day'}.

1. crm_audit with that actor_id${args['since'] ? ` and since "${args['since']}"` : ''}.
2. Group the entries by record type and action, and read the field-level \`changes\`.
3. Flag anything suspicious: duplicate records, deals closed without a reason, fields
   cleared rather than set, bulk edits that look accidental.
4. For each item you would undo, give the audit id and the reason. Only call crm_revert
   for changes the human has explicitly approved.`;

    default:
      throw new Error(`Unknown prompt "${name}"`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
