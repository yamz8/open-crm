import { api, query, RequestFailed } from './api.ts';
import { $, colorFor, h, initials, money, mount, relativeTime, shortDate, toast } from './dom.ts';

// -- State --------------------------------------------------------------------

type Identity = { actor: { label: string; role: string; type: string }; user: any | null };

const state: {
  identity: Identity | null;
  pipelines: any[];
} = { identity: null, pipelines: [] };

const root = () => $('#app')!;

// -- Routing ------------------------------------------------------------------

type Route = { path: string; segments: string[] };

function currentRoute(): Route {
  const segments = location.pathname.split('/').filter(Boolean);
  return { path: location.pathname, segments };
}

export function navigate(path: string): void {
  if (path !== location.pathname) history.pushState({}, '', path);
  void render();
}

document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest?.('a[data-link]') as HTMLAnchorElement | null;
  if (!link) return;
  event.preventDefault();
  navigate(new URL(link.href).pathname);
});
window.addEventListener('popstate', () => void render());

// -- Error handling -----------------------------------------------------------

/**
 * The API always explains itself; the UI just relays that explanation rather than
 * replacing it with "Something went wrong".
 */
function reportError(error: unknown): void {
  if (error instanceof RequestFailed) {
    const detail = Array.isArray(error.error.details)
      ? ` (${error.error.details.map((d: any) => `${d.field}: ${d.message}`).join('; ')})`
      : '';
    toast(
      `${error.error.message}${detail}${error.error.hint ? ` — ${error.error.hint}` : ''}`,
      'error',
    );
    return;
  }
  toast(error instanceof Error ? error.message : String(error), 'error');
}

async function guard<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

// -- Shell --------------------------------------------------------------------

const NAV = [
  { path: '/', label: 'Dashboard', icon: '◎' },
  { path: '/deals', label: 'Deals', icon: '◆' },
  { path: '/contacts', label: 'Contacts', icon: '●' },
  { path: '/companies', label: 'Companies', icon: '▣' },
  { path: '/tasks', label: 'Tasks', icon: '✓' },
  { path: '/activities', label: 'Activity', icon: '≡' },
];

const NAV_ADMIN = [
  { path: '/audit', label: 'Audit log', icon: '⏱' },
  { path: '/agents', label: 'Agents & API', icon: '⚡' },
  { path: '/health', label: 'Health', icon: '♥' },
];

function shell(content: HTMLElement): HTMLElement {
  const path = location.pathname;
  const isActive = (target: string) => (target === '/' ? path === '/' : path.startsWith(target));

  const navLink = (item: { path: string; label: string; icon: string }) =>
    h(
      'a',
      {
        href: item.path,
        'data-link': '',
        class: `nav-item ${isActive(item.path) ? 'active' : ''}`,
      },
      h('span', { class: 'nav-icon' }, item.icon),
      item.label,
    );

  return h(
    'div',
    { class: 'shell' },
    h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, '◇'), 'open-crm'),
      h(
        'button',
        { class: 'nav-item', onclick: () => openPalette() },
        h('span', { class: 'nav-icon' }, '⌕'),
        'Search',
        h('span', { class: 'kbd', style: 'margin-left:auto' }, '⌘K'),
      ),
      ...NAV.map(navLink),
      h('div', { class: 'nav-group' }, 'Oversight'),
      ...NAV_ADMIN.map(navLink),
      h(
        'div',
        { class: 'sidebar-footer' },
        h(
          'div',
          { class: 'nav-item', style: 'cursor:default' },
          h(
            'div',
            {
              class: 'avatar',
              style: `background:${colorFor(state.identity?.actor.label ?? '?')}`,
            },
            initials(state.identity?.actor.label ?? '?'),
          ),
          h(
            'div',
            { style: 'min-width:0' },
            h('div', { style: 'font-size:12.5px' }, state.identity?.actor.label ?? ''),
            h('div', { class: 'faint', style: 'font-size:11px' }, state.identity?.actor.role ?? ''),
          ),
        ),
        h(
          'button',
          {
            class: 'nav-item',
            onclick: async () => {
              await api.post('/auth/logout');
              state.identity = null;
              navigate('/');
            },
          },
          h('span', { class: 'nav-icon' }, '⇥'),
          'Sign out',
        ),
      ),
    ),
    h('main', { class: 'main' }, content),
  );
}

function pageHead(title: string, ...actions: (HTMLElement | false | null)[]): HTMLElement {
  return h(
    'div',
    { class: 'page-head' },
    h('h1', {}, title),
    h('div', { class: 'spacer' }),
    ...actions,
  );
}

const loading = () => h('div', { class: 'loading' }, h('span', { class: 'spinner' }));

function empty(title: string, note: string, action?: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-title' }, title),
    h('div', {}, note),
    action ? h('div', { style: 'margin-top:14px' }, action) : null,
  );
}

// -- Auth screens -------------------------------------------------------------

function authScreen(mode: 'login' | 'setup'): HTMLElement {
  const isSetup = mode === 'setup';
  const form = h(
    'form',
    {
      onsubmit: async (event: Event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target as HTMLFormElement)) as any;
        await guard(async () => {
          if (isSetup) {
            await api.post('/setup', {
              email: data.email,
              name: data.name,
              password: data.password,
            });
          }
          await api.post('/auth/login', { email: data.email, password: data.password });
          await boot();
          navigate('/');
        });
      },
    },
    isSetup
      ? h(
          'div',
          { class: 'field' },
          h('label', { for: 'name' }, 'Your name'),
          h('input', { id: 'name', name: 'name', required: true, autocomplete: 'name' }),
        )
      : null,
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'email' }, 'Email'),
      h('input', {
        id: 'email',
        name: 'email',
        type: 'email',
        required: true,
        autocomplete: 'username',
      }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'password' }, 'Password'),
      h('input', {
        id: 'password',
        name: 'password',
        type: 'password',
        required: true,
        minLength: isSetup ? 10 : 1,
        autocomplete: isSetup ? 'new-password' : 'current-password',
      }),
      isSetup
        ? h(
            'div',
            { class: 'faint', style: 'margin-top:5px;font-size:12px' },
            'At least 10 characters.',
          )
        : null,
    ),
    h(
      'button',
      { class: 'btn-primary', type: 'submit', style: 'width:100%;justify-content:center' },
      isSetup ? 'Create owner account' : 'Sign in',
    ),
  );

  return h(
    'div',
    { class: 'auth' },
    h(
      'div',
      { class: 'auth-card' },
      h(
        'div',
        { class: 'auth-head' },
        h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, '◇'), 'open-crm'),
        h(
          'div',
          { class: 'subtle' },
          isSetup ? 'Set up this instance by creating the first account.' : 'Sign in to continue.',
        ),
      ),
      h('div', { class: 'card' }, h('div', { class: 'card-body' }, form)),
      h(
        'div',
        { class: 'faint', style: 'text-align:center;margin-top:16px;font-size:12px' },
        'Building an agent? See ',
        h('a', { href: '/llms.txt' }, '/llms.txt'),
        ' and ',
        h('a', { href: '/api/v1/discover' }, '/api/v1/discover'),
        '.',
      ),
    ),
  );
}

// -- Dashboard ----------------------------------------------------------------

async function dashboardView(): Promise<HTMLElement> {
  const [overview, work, summary] = await Promise.all([
    api.get('/insights/overview'),
    api.get('/insights/work-queue'),
    api.get('/insights/pipeline').catch(() => null),
  ]);

  const stat = (label: string, value: string, note?: string) =>
    h(
      'div',
      { class: 'card stat' },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value' }, value),
      note ? h('div', { class: 'stat-note' }, note) : null,
    );

  const currency = overview.revenue.currency;

  const queueSection = (
    title: string,
    records: any[],
    type: string,
    describe: (r: any) => string,
  ) =>
    records.length === 0
      ? null
      : h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'card-head' },
            h('h2', {}, title),
            h('span', { class: 'badge' }, String(records.length)),
          ),
          h(
            'div',
            {},
            ...records.slice(0, 6).map((record) =>
              h(
                'div',
                {
                  class: 'tl-item',
                  style: 'cursor:pointer',
                  onclick: () => navigate(`/${type}/${record.id}`),
                },
                h(
                  'div',
                  { class: 'tl-body' },
                  h('div', { class: 'tl-subject' }, record._label),
                  h('div', { class: 'tl-text' }, describe(record)),
                ),
              ),
            ),
          ),
        );

  return shell(
    h(
      'div',
      {},
      pageHead(
        'Dashboard',
        h('button', { class: 'btn-primary', onclick: () => openCreate('deal') }, '+ New deal'),
      ),
      h(
        'div',
        { class: 'grid grid-4', style: 'margin-bottom:16px' },
        stat(
          'Open pipeline',
          money(overview.revenue.open_pipeline, currency),
          `${overview.counts.deals_open} open deal${overview.counts.deals_open === 1 ? '' : 's'}`,
        ),
        stat(
          'Won',
          money(overview.revenue.won_in_window, currency),
          `last ${overview.window_days} days`,
        ),
        stat(
          'Win rate',
          overview.revenue.win_rate === null ? '—' : `${overview.revenue.win_rate}%`,
          `${overview.revenue.won_count} won / ${overview.revenue.lost_count} lost`,
        ),
        stat(
          'Open tasks',
          String(overview.counts.tasks_open),
          overview.counts.tasks_overdue > 0
            ? `${overview.counts.tasks_overdue} overdue`
            : 'nothing overdue',
        ),
      ),
      h(
        'div',
        { class: 'card', style: 'margin-bottom:16px' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', {}, 'What needs attention'),
          h(
            'span',
            { class: 'subtle', style: 'margin-left:auto;font-size:12.5px' },
            work.suggested_next_action,
          ),
        ),
        h(
          'div',
          { class: 'grid grid-2', style: 'padding:16px' },
          queueSection(
            'Overdue tasks',
            work.overdue_tasks,
            'tasks',
            (t) => `Due ${relativeTime(t.due_at)} · ${t.priority}`,
          ) ?? h('div', { class: 'subtle' }, 'No overdue tasks.'),
          queueSection(
            'Deals gone quiet',
            work.stale_deals,
            'deals',
            (d) => `${d.amount_formatted} · no activity in ${work.stale_days} days`,
          ) ?? h('div', { class: 'subtle' }, 'Every open deal has recent activity.'),
        ),
      ),
      summary
        ? h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'card-head' },
              h('h2', {}, `Pipeline — ${summary.pipeline.name}`),
              h(
                'span',
                { class: 'subtle', style: 'margin-left:auto;font-size:12.5px' },
                `${money(summary.totals.weighted_amount, currency)} weighted`,
              ),
            ),
            h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'Stage'),
                  h('th', {}, 'Deals'),
                  h('th', {}, 'Value'),
                  h('th', {}, 'Weighted'),
                ),
              ),
              h(
                'tbody',
                {},
                ...summary.stages.map((row: any) =>
                  h(
                    'tr',
                    { onclick: () => navigate('/deals') },
                    h(
                      'td',
                      {},
                      h(
                        'span',
                        { class: 'cell-main' },
                        row.stage_name,
                        h('span', { class: 'badge' }, `${row.probability}%`),
                      ),
                    ),
                    h('td', {}, String(row.deal_count)),
                    h('td', {}, money(row.total_amount, currency)),
                    h('td', { class: 'subtle' }, money(row.weighted_amount, currency)),
                  ),
                ),
              ),
            ),
          )
        : null,
    ),
  );
}

// -- Generic list view --------------------------------------------------------

type Column = { header: string; render: (record: any) => HTMLElement | string };

type ListConfig = {
  plural: string;
  title: string;
  columns: Column[];
  filters?: { name: string; label: string; options: [string, string][] }[];
  sorts: [string, string][];
  createType?: string;
  emptyNote: string;
};

const mainCell = (label: string, sub?: string) =>
  h(
    'span',
    { class: 'cell-main' },
    h('div', { class: 'avatar', style: `background:${colorFor(label)}` }, initials(label)),
    h(
      'div',
      {},
      h('div', {}, label),
      sub ? h('div', { class: 'faint', style: 'font-size:12px' }, sub) : null,
    ),
  );

async function listView(config: ListConfig): Promise<HTMLElement> {
  const params = new URLSearchParams(location.search);
  const load = () =>
    api.get(
      `/${config.plural}${query({
        q: params.get('q') ?? undefined,
        sort: params.get('sort') ?? undefined,
        limit: 50,
        ...Object.fromEntries(
          (config.filters ?? [])
            .map((f) => [`filter[${f.name}]`, params.get(f.name) ?? undefined])
            .filter(([, v]) => v !== undefined),
        ),
      })}`,
    );

  const result = await load();

  const setParam = (key: string, value: string) => {
    if (value) params.set(key, value);
    else params.delete(key);
    const search = params.toString();
    navigate(`/${config.plural}${search ? `?${search}` : ''}`);
  };

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('input', {
      type: 'search',
      placeholder: `Search ${config.plural}…`,
      value: params.get('q') ?? '',
      onchange: (event: Event) => setParam('q', (event.target as HTMLInputElement).value),
    }),
    ...(config.filters ?? []).map((filter) =>
      h(
        'select',
        {
          onchange: (event: Event) =>
            setParam(filter.name, (event.target as HTMLSelectElement).value),
        },
        h('option', { value: '' }, filter.label),
        ...filter.options.map(([value, label]) =>
          h('option', { value, selected: params.get(filter.name) === value }, label),
        ),
      ),
    ),
    h(
      'select',
      { onchange: (event: Event) => setParam('sort', (event.target as HTMLSelectElement).value) },
      ...config.sorts.map(([value, label]) =>
        h('option', { value, selected: params.get('sort') === value }, label),
      ),
    ),
    h('div', { class: 'spacer', style: 'flex:1' }),
    h('span', { class: 'subtle', style: 'font-size:12.5px' }, `${result.total} total`),
  );

  const table =
    result.data.length === 0
      ? empty(
          'Nothing here yet',
          config.emptyNote,
          config.createType
            ? h(
                'button',
                { class: 'btn-primary', onclick: () => openCreate(config.createType!) },
                `+ New`,
              )
            : undefined,
        )
      : h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...config.columns.map((c) => h('th', {}, c.header)))),
          h(
            'tbody',
            {},
            ...result.data.map((record: any) =>
              h(
                'tr',
                { onclick: () => navigate(`/${config.plural}/${record.id}`) },
                ...config.columns.map((column) => {
                  const value = column.render(record);
                  return h('td', {}, typeof value === 'string' ? value : value);
                }),
              ),
            ),
          ),
        );

  return shell(
    h(
      'div',
      {},
      pageHead(
        config.title,
        config.createType
          ? h(
              'button',
              { class: 'btn-primary', onclick: () => openCreate(config.createType!) },
              '+ New',
            )
          : null,
      ),
      toolbar,
      h('div', { class: 'card' }, table),
    ),
  );
}

const LIFECYCLE_BADGE: Record<string, string> = {
  customer: 'badge-ok',
  opportunity: 'badge-accent',
  qualified: 'badge-accent',
  churned: 'badge-danger',
};

const contactsConfig: ListConfig = {
  plural: 'contacts',
  title: 'Contacts',
  createType: 'contact',
  emptyNote: 'Add the people you work with, or import them through the API.',
  sorts: [
    ['-created_at', 'Newest first'],
    ['last_name', 'Last name A–Z'],
    ['-updated_at', 'Recently updated'],
  ],
  filters: [
    {
      name: 'lifecycle_stage',
      label: 'Any stage',
      options: [
        ['lead', 'Lead'],
        ['qualified', 'Qualified'],
        ['opportunity', 'Opportunity'],
        ['customer', 'Customer'],
        ['churned', 'Churned'],
      ],
    },
  ],
  columns: [
    { header: 'Name', render: (r) => mainCell(r._label, r.title ?? undefined) },
    { header: 'Email', render: (r) => h('span', { class: 'subtle' }, r.email ?? '—') },
    {
      header: 'Stage',
      render: (r) =>
        h(
          'span',
          { class: `badge ${LIFECYCLE_BADGE[r.lifecycle_stage] ?? ''}` },
          r.lifecycle_stage,
        ),
    },
    { header: 'Added', render: (r) => h('span', { class: 'subtle' }, relativeTime(r.created_at)) },
  ],
};

const companiesConfig: ListConfig = {
  plural: 'companies',
  title: 'Companies',
  createType: 'company',
  emptyNote: 'Companies group contacts and deals together.',
  sorts: [
    ['-created_at', 'Newest first'],
    ['name', 'Name A–Z'],
  ],
  columns: [
    { header: 'Company', render: (r) => mainCell(r.name, r.domain ?? undefined) },
    { header: 'Industry', render: (r) => h('span', { class: 'subtle' }, r.industry ?? '—') },
    { header: 'Size', render: (r) => h('span', { class: 'subtle' }, r.size ?? '—') },
    { header: 'Added', render: (r) => h('span', { class: 'subtle' }, relativeTime(r.created_at)) },
  ],
};

const tasksConfig: ListConfig = {
  plural: 'tasks',
  title: 'Tasks',
  createType: 'task',
  emptyNote: 'Tasks can be assigned to people and linked to any record.',
  sorts: [
    ['due_at', 'Due soonest'],
    ['-created_at', 'Newest first'],
  ],
  filters: [
    {
      name: 'status',
      label: 'Any status',
      options: [
        ['open', 'Open'],
        ['done', 'Done'],
        ['cancelled', 'Cancelled'],
      ],
    },
  ],
  columns: [
    { header: 'Task', render: (r) => h('span', { style: 'font-weight:550' }, r.title) },
    {
      header: 'Due',
      render: (r) => {
        const overdue = r.status === 'open' && r.due_at && Date.parse(r.due_at) < Date.now();
        return h(
          'span',
          { class: overdue ? 'badge badge-danger' : 'subtle' },
          relativeTime(r.due_at),
        );
      },
    },
    { header: 'Priority', render: (r) => h('span', { class: 'badge' }, r.priority) },
    {
      header: 'Status',
      render: (r) =>
        h('span', { class: `badge ${r.status === 'done' ? 'badge-ok' : ''}` }, r.status),
    },
  ],
};

const activitiesConfig: ListConfig = {
  plural: 'activities',
  title: 'Activity',
  emptyNote: 'Calls, emails, meetings, and notes logged by people and agents.',
  sorts: [['-occurred_at', 'Most recent']],
  filters: [
    {
      name: 'type',
      label: 'Any type',
      options: [
        ['note', 'Note'],
        ['call', 'Call'],
        ['email', 'Email'],
        ['meeting', 'Meeting'],
        ['stage_change', 'Stage change'],
      ],
    },
    {
      name: 'actor_type',
      label: 'Any author',
      options: [
        ['user', 'People'],
        ['agent', 'Agents'],
        ['system', 'System'],
      ],
    },
  ],
  columns: [
    { header: 'Type', render: (r) => h('span', { class: 'badge' }, r.type) },
    { header: 'Subject', render: (r) => h('span', { style: 'font-weight:550' }, r._label) },
    {
      header: 'By',
      render: (r) =>
        h(
          'span',
          { class: `badge ${r.actor_type === 'agent' ? 'badge-accent' : ''}` },
          r.actor_label,
        ),
    },
    { header: 'When', render: (r) => h('span', { class: 'subtle' }, relativeTime(r.occurred_at)) },
  ],
};

// -- Deals board --------------------------------------------------------------

async function dealsView(): Promise<HTMLElement> {
  const [pipelines, deals] = await Promise.all([
    api.get('/pipelines'),
    api.get(`/deals${query({ limit: 200, sort: '-amount' })}`),
  ]);
  const pipeline = pipelines.data[0];
  if (!pipeline) return shell(empty('No pipeline', 'Create a pipeline to start tracking deals.'));

  const byStage = new Map<string, any[]>();
  for (const deal of deals.data) {
    if (deal.pipeline_id !== pipeline.id) continue;
    const bucket = byStage.get(deal.stage_id) ?? [];
    bucket.push(deal);
    byStage.set(deal.stage_id, bucket);
  }

  const columns = pipeline.stages.map((stage: any) => {
    const items = byStage.get(stage.id) ?? [];
    const total = items.reduce((sum: number, d: any) => sum + d.amount, 0);
    return h(
      'div',
      { class: 'board-col' },
      h(
        'div',
        { class: 'board-col-head' },
        h('span', { class: 'board-col-name' }, stage.name),
        h('span', { class: 'badge' }, String(items.length)),
        h('span', { class: 'board-col-sum' }, money(total)),
      ),
      ...items.map((deal: any) =>
        h(
          'div',
          { class: 'deal-card', onclick: () => navigate(`/deals/${deal.id}`) },
          h('div', { class: 'deal-title' }, deal.title),
          h(
            'div',
            { class: 'deal-meta' },
            h('span', { class: 'deal-amount' }, deal.amount_formatted),
            deal.close_date ? h('span', {}, `· ${shortDate(deal.close_date)}`) : null,
          ),
        ),
      ),
      items.length === 0
        ? h('div', { class: 'faint', style: 'padding:8px 4px;font-size:12px' }, 'Empty')
        : null,
    );
  });

  return shell(
    h(
      'div',
      {},
      pageHead(
        'Deals',
        h('a', { href: '/deals?view=list', 'data-link': '', class: 'btn' }, 'List view'),
        h('button', { class: 'btn-primary', onclick: () => openCreate('deal') }, '+ New deal'),
      ),
      h('div', { class: 'board' }, ...columns),
    ),
  );
}

const dealsListConfig: ListConfig = {
  plural: 'deals',
  title: 'Deals',
  createType: 'deal',
  emptyNote: 'Deals move through pipeline stages and drive the forecast.',
  sorts: [
    ['-created_at', 'Newest first'],
    ['-amount', 'Largest first'],
    ['close_date', 'Closing soonest'],
  ],
  filters: [
    {
      name: 'status',
      label: 'Any status',
      options: [
        ['open', 'Open'],
        ['won', 'Won'],
        ['lost', 'Lost'],
      ],
    },
  ],
  columns: [
    { header: 'Deal', render: (r) => h('span', { style: 'font-weight:550' }, r.title) },
    {
      header: 'Amount',
      render: (r) => h('span', { style: 'font-weight:600' }, r.amount_formatted),
    },
    {
      header: 'Status',
      render: (r) =>
        h(
          'span',
          {
            class: `badge ${r.status === 'won' ? 'badge-ok' : r.status === 'lost' ? 'badge-danger' : 'badge-accent'}`,
          },
          r.status,
        ),
    },
    {
      header: 'Close date',
      render: (r) => h('span', { class: 'subtle' }, shortDate(r.close_date)),
    },
  ],
};

// -- Record detail ------------------------------------------------------------

const TIMELINE_ICON: Record<string, string> = {
  note: '✎',
  call: '☎',
  email: '✉',
  meeting: '⧉',
  stage_change: '→',
  system: '⚙',
};

async function detailView(type: string, plural: string, id: string): Promise<HTMLElement> {
  const context = await api.get(`/${plural}/${id}/context`);
  const record = context.record;

  const props: [string, unknown][] =
    type === 'contact'
      ? [
          ['Email', record.email],
          ['Phone', record.phone],
          ['Title', record.title],
          ['Company', context.related.company?.name],
          ['Stage', record.lifecycle_stage],
          ['Source', record.source],
          ['LinkedIn', record.linkedin_url],
        ]
      : type === 'company'
        ? [
            ['Domain', record.domain],
            ['Industry', record.industry],
            ['Size', record.size],
            ['Phone', record.phone],
            ['Website', record.website],
            ['Address', record.address],
          ]
        : [
            ['Amount', record.amount_formatted],
            ['Status', record.status],
            ['Stage', context.related.stage?.name],
            ['Pipeline', context.related.pipeline?.name],
            ['Close date', shortDate(record.close_date)],
            ['Company', context.related.company?.name],
            ['Contact', context.related.contact?._label],
          ];

  const timeline = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, 'Timeline'),
      h(
        'button',
        { class: 'btn-sm', style: 'margin-left:auto', onclick: () => openLogActivity(type, id) },
        '+ Log activity',
      ),
    ),
    context.timeline.length === 0
      ? h('div', { class: 'empty' }, 'Nothing logged yet.')
      : h(
          'div',
          { class: 'timeline' },
          ...context.timeline.map((item: any) =>
            h(
              'div',
              { class: 'tl-item' },
              h('div', { class: 'tl-dot' }, TIMELINE_ICON[item.type] ?? '•'),
              h(
                'div',
                { class: 'tl-body' },
                h(
                  'div',
                  { class: 'tl-head' },
                  h('span', { class: 'tl-subject' }, item.subject ?? item.type),
                  h(
                    'span',
                    { class: `badge ${item.actor_type === 'agent' ? 'badge-accent' : ''}` },
                    item.actor_label,
                  ),
                  h('span', { class: 'tl-when' }, relativeTime(item.occurred_at)),
                ),
                item.body ? h('div', { class: 'tl-text' }, item.body) : null,
              ),
            ),
          ),
        ),
  );

  const sidePanels: HTMLElement[] = [];

  if (type === 'deal' && record.status === 'open') {
    const stages =
      (context.related.pipeline ? await api.get(`/pipelines/${record.pipeline_id}`) : null)
        ?.stages ?? [];
    sidePanels.push(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Move stage')),
        h(
          'div',
          { class: 'card-body' },
          h(
            'select',
            {
              onchange: async (event: Event) => {
                const stageId = (event.target as HTMLSelectElement).value;
                if (!stageId || stageId === record.stage_id) return;
                await guard(async () => {
                  await api.post(`/deals/${id}/move`, { stage_id: stageId });
                  toast('Deal moved');
                  await render();
                });
              },
            },
            ...stages.map((stage: any) =>
              h('option', { value: stage.id, selected: stage.id === record.stage_id }, stage.name),
            ),
          ),
        ),
      ),
    );
  }

  if (context.related.contacts?.length) {
    sidePanels.push(relatedList('People', context.related.contacts, 'contacts'));
  }
  if (context.related.deals?.length) {
    sidePanels.push(relatedList('Deals', context.related.deals, 'deals'));
  }
  if (context.open_tasks.length) {
    sidePanels.push(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Open tasks')),
        h(
          'div',
          {},
          ...context.open_tasks.map((task: any) =>
            h(
              'div',
              { class: 'tl-item' },
              h(
                'div',
                { class: 'tl-body' },
                h('div', { class: 'tl-subject' }, task.title),
                h(
                  'div',
                  { class: 'faint', style: 'font-size:12px' },
                  `Due ${relativeTime(task.due_at)}`,
                ),
              ),
              h(
                'button',
                {
                  class: 'btn-sm',
                  onclick: async () => {
                    await guard(async () => {
                      await api.post(`/tasks/${task.id}/complete`);
                      toast('Task completed');
                      await render();
                    });
                  },
                },
                'Done',
              ),
            ),
          ),
        ),
      ),
    );
  }

  return shell(
    h(
      'div',
      {},
      pageHead(
        record._label,
        h(
          'button',
          {
            class: 'btn-danger',
            onclick: async () => {
              await guard(async () => {
                await api.delete(`/${plural}/${id}`);
                toast('Archived — this is reversible from the audit log');
                navigate(`/${plural}`);
              });
            },
          },
          'Archive',
        ),
      ),
      h(
        'div',
        { class: 'detail' },
        h('div', { style: 'display:grid;gap:16px' }, timeline),
        h(
          'div',
          { style: 'display:grid;gap:16px' },
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', {}, 'Details')),
            h(
              'div',
              { class: 'card-body' },
              h(
                'div',
                { class: 'prop-list' },
                ...props.flatMap(([key, value]) => [
                  h('div', { class: 'prop-key' }, key),
                  h(
                    'div',
                    { class: 'prop-value' },
                    value ? String(value) : h('span', { class: 'faint' }, '—'),
                  ),
                ]),
              ),
              context.tags.length
                ? h(
                    'div',
                    { style: 'margin-top:14px;display:flex;gap:6px;flex-wrap:wrap' },
                    ...context.tags.map((tag: any) =>
                      h(
                        'span',
                        { class: 'badge' },
                        h('span', { class: 'tag-dot', style: `background:${tag.color}` }),
                        tag.name,
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { class: 'faint', style: 'margin-top:14px;font-size:11.5px' },
                h('span', { class: 'mono' }, record.id),
              ),
            ),
          ),
          ...sidePanels,
        ),
      ),
    ),
  );
}

function relatedList(title: string, records: any[], plural: string): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, title),
      h('span', { class: 'badge' }, String(records.length)),
    ),
    h(
      'div',
      {},
      ...records.slice(0, 12).map((record) =>
        h(
          'div',
          {
            class: 'tl-item',
            style: 'cursor:pointer',
            onclick: () => navigate(`/${plural}/${record.id}`),
          },
          h(
            'div',
            { class: 'tl-body' },
            h('div', { class: 'tl-subject' }, record._label),
            h(
              'div',
              { class: 'faint', style: 'font-size:12px' },
              record.amount_formatted ?? record.email ?? record.title ?? '',
            ),
          ),
        ),
      ),
    ),
  );
}

// -- Audit --------------------------------------------------------------------

async function auditView(): Promise<HTMLElement> {
  const params = new URLSearchParams(location.search);
  const result = await api.get(
    `/audit${query({ limit: 100, actor_type: params.get('actor_type') ?? undefined })}`,
  );

  const revert = async (entry: any) => {
    await guard(async () => {
      await api.post(`/audit/${entry.id}/revert`);
      toast('Change reverted');
      await render();
    });
  };

  return shell(
    h(
      'div',
      {},
      pageHead('Audit log'),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'select',
          {
            onchange: (event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              navigate(`/audit${value ? `?actor_type=${value}` : ''}`);
            },
          },
          h('option', { value: '' }, 'Everyone'),
          h(
            'option',
            { value: 'agent', selected: params.get('actor_type') === 'agent' },
            'Agents only',
          ),
          h(
            'option',
            { value: 'user', selected: params.get('actor_type') === 'user' },
            'People only',
          ),
        ),
        h(
          'span',
          { class: 'subtle', style: 'font-size:12.5px' },
          'Every change is recorded with a full before-image and can be undone.',
        ),
      ),
      h(
        'div',
        { class: 'card' },
        result.data.length === 0
          ? empty('No changes recorded', 'Mutations will appear here as they happen.')
          : h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'When'),
                  h('th', {}, 'Who'),
                  h('th', {}, 'What'),
                  h('th', {}, 'Changes'),
                  h('th', {}, ''),
                ),
              ),
              h(
                'tbody',
                {},
                ...result.data.map((entry: any) =>
                  h(
                    'tr',
                    { style: 'cursor:default' },
                    h('td', { class: 'subtle' }, relativeTime(entry.at)),
                    h(
                      'td',
                      {},
                      h(
                        'span',
                        { class: `badge ${entry.actor.type === 'agent' ? 'badge-accent' : ''}` },
                        entry.actor.label,
                      ),
                    ),
                    h(
                      'td',
                      {},
                      h(
                        'span',
                        { style: 'font-weight:550' },
                        `${entry.action} ${entry.entity_type}`,
                      ),
                      h('div', { class: 'faint mono', style: 'font-size:11px' }, entry.entity_id),
                    ),
                    h(
                      'td',
                      { class: 'diff' },
                      Object.entries(entry.changes)
                        .slice(0, 3)
                        .map(([field, change]: [string, any]) =>
                          h(
                            'div',
                            {},
                            `${field}: `,
                            h(
                              'span',
                              { class: 'diff-from' },
                              String(change.from ?? '∅').slice(0, 24),
                            ),
                            ' → ',
                            h('span', { class: 'diff-to' }, String(change.to ?? '∅').slice(0, 24)),
                          ),
                        ),
                    ),
                    h(
                      'td',
                      {},
                      entry.reversible
                        ? h('button', { class: 'btn-sm', onclick: () => revert(entry) }, 'Revert')
                        : h(
                            'span',
                            { class: 'faint', style: 'font-size:12px' },
                            entry.reverted ? 'reverted' : '—',
                          ),
                    ),
                  ),
                ),
              ),
            ),
      ),
    ),
  );
}

// -- Agents & API -------------------------------------------------------------

async function agentsView(): Promise<HTMLElement> {
  const [tokens, webhooks] = await Promise.all([api.get('/tokens'), api.get('/webhooks')]);

  const createToken = async () => {
    const name = prompt('What is this token for? (e.g. "claude-code")');
    if (!name) return;
    const scopes = prompt(
      'Scopes (comma separated). Leave blank for full access.\nExamples: contacts:write, deals:read',
      '',
    );
    await guard(async () => {
      const created = await api.post('/tokens', {
        name,
        ...(scopes?.trim()
          ? {
              scopes: scopes
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      });
      showTokenModal(created);
      await render();
    });
  };

  return shell(
    h(
      'div',
      {},
      pageHead(
        'Agents & API',
        h('button', { class: 'btn-primary', onclick: createToken }, '+ New token'),
      ),
      h(
        'div',
        { class: 'card', style: 'margin-bottom:16px' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Connect an agent')),
        h(
          'div',
          { class: 'card-body' },
          h(
            'p',
            { class: 'subtle', style: 'margin-top:0' },
            'Point any MCP client at this instance. Every action an agent takes is attributed to its token and can be reviewed or undone from the audit log.',
          ),
          h(
            'div',
            { class: 'token-value' },
            `claude mcp add open-crm --env OPEN_CRM_URL=${location.origin} --env OPEN_CRM_TOKEN=<token> -- npx open-crm-server mcp`,
          ),
          h(
            'p',
            { class: 'subtle', style: 'margin-bottom:0' },
            'Machine-readable docs: ',
            h('a', { href: '/api/v1/discover' }, '/api/v1/discover'),
            ' · ',
            h('a', { href: '/openapi.json' }, '/openapi.json'),
            ' · ',
            h('a', { href: '/llms.txt' }, '/llms.txt'),
          ),
        ),
      ),
      h(
        'div',
        { class: 'card', style: 'margin-bottom:16px' },
        h('div', { class: 'card-head' }, h('h2', {}, 'API tokens')),
        tokens.data.length === 0
          ? empty('No tokens yet', 'Create one to let an agent or script use this CRM.')
          : h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'Name'),
                  h('th', {}, 'Scopes'),
                  h('th', {}, 'Last used'),
                  h('th', {}, 'Status'),
                  h('th', {}, ''),
                ),
              ),
              h(
                'tbody',
                {},
                ...tokens.data.map((token: any) =>
                  h(
                    'tr',
                    { style: 'cursor:default' },
                    h('td', { style: 'font-weight:550' }, token.name),
                    h('td', {}, h('span', { class: 'mono subtle' }, token.scopes.join(', '))),
                    h(
                      'td',
                      { class: 'subtle' },
                      token.last_used_at ? relativeTime(token.last_used_at) : 'never',
                    ),
                    h(
                      'td',
                      {},
                      h(
                        'span',
                        { class: `badge ${token.revoked ? 'badge-danger' : 'badge-ok'}` },
                        token.revoked ? 'revoked' : 'active',
                      ),
                    ),
                    h(
                      'td',
                      {},
                      h('a', { href: `/audit`, 'data-link': '', class: 'btn btn-sm' }, 'Activity'),
                      token.revoked
                        ? null
                        : h(
                            'button',
                            {
                              class: 'btn-sm btn-danger',
                              style: 'margin-left:6px',
                              onclick: async () => {
                                if (
                                  !confirm(`Revoke "${token.name}"? It stops working immediately.`)
                                )
                                  return;
                                await guard(async () => {
                                  await api.delete(`/tokens/${token.id}`);
                                  toast('Token revoked');
                                  await render();
                                });
                              },
                            },
                            'Revoke',
                          ),
                    ),
                  ),
                ),
              ),
            ),
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', {}, 'Webhooks'),
          h(
            'button',
            {
              class: 'btn-sm',
              style: 'margin-left:auto',
              onclick: async () => {
                const url = prompt('Webhook URL (https://…)');
                if (!url) return;
                await guard(async () => {
                  await api.post('/webhooks', { url });
                  toast('Webhook created');
                  await render();
                });
              },
            },
            '+ Add',
          ),
        ),
        webhooks.data.length === 0
          ? empty('No webhooks', 'Subscribe to events like deal.won to notify another system.')
          : h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'URL'),
                  h('th', {}, 'Events'),
                  h('th', {}, 'Status'),
                  h('th', {}, ''),
                ),
              ),
              h(
                'tbody',
                {},
                ...webhooks.data.map((hook: any) =>
                  h(
                    'tr',
                    { style: 'cursor:default' },
                    h('td', { class: 'mono' }, hook.url),
                    h('td', { class: 'subtle' }, hook.events.join(', ')),
                    h(
                      'td',
                      {},
                      h(
                        'span',
                        { class: `badge ${hook.active ? 'badge-ok' : ''}` },
                        hook.active ? 'active' : 'paused',
                      ),
                    ),
                    h(
                      'td',
                      {},
                      h(
                        'button',
                        {
                          class: 'btn-sm btn-danger',
                          onclick: async () => {
                            if (!confirm('Delete this webhook?')) return;
                            await guard(async () => {
                              await api.delete(`/webhooks/${hook.id}`);
                              await render();
                            });
                          },
                        },
                        'Delete',
                      ),
                    ),
                  ),
                ),
              ),
            ),
      ),
    ),
  );
}

function showTokenModal(created: any): void {
  openModal(
    'Token created',
    h(
      'div',
      {},
      h('p', { style: 'margin-top:0' }, 'Copy this now — it will never be shown again.'),
      h('div', { class: 'token-value' }, created.token),
      h('h3', { style: 'margin-top:18px' }, 'Connect Claude Code'),
      h(
        'div',
        { class: 'token-value' },
        `claude mcp add open-crm --env OPEN_CRM_URL=${location.origin} --env OPEN_CRM_TOKEN=${created.token} -- npx open-crm-server mcp`,
      ),
    ),
    [h('button', { class: 'btn-primary', onclick: () => closeModal() }, 'Done')],
  );
}

// -- Health -------------------------------------------------------------------

async function healthView(): Promise<HTMLElement> {
  const [report, info] = await Promise.all([
    api
      .get('/system/selfcheck')
      .catch((error) => (error instanceof RequestFailed ? null : Promise.reject(error))),
    api.get('/system/info'),
  ]);

  const statusBadge = (status: string) =>
    h(
      'span',
      {
        class: `badge ${status === 'pass' ? 'badge-ok' : status === 'warn' ? 'badge-warn' : 'badge-danger'}`,
      },
      status,
    );

  return shell(
    h(
      'div',
      {},
      pageHead(
        'Health',
        h(
          'button',
          {
            class: 'btn-primary',
            onclick: async () => {
              await guard(async () => {
                const result = await api.post('/system/selfcheck?repair=true');
                toast(
                  result.repaired.length
                    ? `Repaired: ${result.repaired.join(', ')}`
                    : 'Nothing needed repair',
                );
                await render();
              });
            },
          },
          'Run check & repair',
        ),
      ),
      h(
        'div',
        { class: 'card', style: 'margin-bottom:16px' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', {}, 'Self-check'),
          report ? h('span', { style: 'margin-left:auto' }, statusBadge(report.status)) : null,
        ),
        report
          ? h(
              'div',
              {},
              ...report.checks.map((check: any) =>
                h(
                  'div',
                  { class: 'check-row' },
                  h(
                    'div',
                    { class: `check-mark check-${check.status}` },
                    check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗',
                  ),
                  h(
                    'div',
                    {},
                    h('div', { class: 'check-name' }, check.name.replace(/_/g, ' ')),
                    h('div', { class: 'check-msg' }, check.message),
                    check.remedy ? h('div', { class: 'check-remedy' }, `→ ${check.remedy}`) : null,
                  ),
                ),
              ),
            )
          : h('div', { class: 'empty' }, 'Self-check could not run.'),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Instance')),
        h(
          'div',
          { class: 'card-body' },
          h(
            'div',
            { class: 'prop-list' },
            ...(
              [
                ['Environment', info.environment],
                ['Database', info.database],
                ['Node', info.node_version],
                ['Uptime', `${Math.floor(info.uptime_s / 60)} min`],
                [
                  'Migrations',
                  info.migrations.applied
                    ? 'up to date'
                    : `pending: ${info.migrations.pending.join(', ')}`,
                ],
                [
                  'Rate limit',
                  `${info.limits.rate_limit_max} / ${info.limits.rate_limit_window_ms / 1000}s`,
                ],
              ] as [string, string][]
            ).flatMap(([key, value]) => [
              h('div', { class: 'prop-key' }, key),
              h('div', { class: 'prop-value' }, value),
            ]),
          ),
        ),
      ),
    ),
  );
}

// -- Modals -------------------------------------------------------------------

function closeModal(): void {
  $('#overlay')?.remove();
}

function openModal(title: string, body: HTMLElement, actions: HTMLElement[]): void {
  closeModal();
  const overlay = h(
    'div',
    {
      id: 'overlay',
      class: 'overlay',
      onclick: (event: MouseEvent) => {
        if (event.target === event.currentTarget) closeModal();
      },
    },
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, title)),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, ...actions),
    ),
  );
  document.body.appendChild(overlay);
}

type FieldSpec = {
  name: string;
  label: string;
  type?: string;
  options?: [string, string][];
  required?: boolean;
  hint?: string;
};

const CREATE_FORMS: Record<string, { plural: string; title: string; fields: FieldSpec[] }> = {
  contact: {
    plural: 'contacts',
    title: 'New contact',
    fields: [
      { name: 'first_name', label: 'First name' },
      { name: 'last_name', label: 'Last name' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone' },
      { name: 'title', label: 'Job title' },
      {
        name: 'lifecycle_stage',
        label: 'Stage',
        options: [
          ['lead', 'Lead'],
          ['subscriber', 'Subscriber'],
          ['qualified', 'Qualified'],
          ['opportunity', 'Opportunity'],
          ['customer', 'Customer'],
        ],
      },
    ],
  },
  company: {
    plural: 'companies',
    title: 'New company',
    fields: [
      { name: 'name', label: 'Company name', required: true },
      { name: 'domain', label: 'Domain', hint: 'e.g. acme.com' },
      { name: 'industry', label: 'Industry' },
      { name: 'size', label: 'Size', hint: 'e.g. 11-50' },
    ],
  },
  deal: {
    plural: 'deals',
    title: 'New deal',
    fields: [
      { name: 'title', label: 'Deal title', required: true },
      { name: 'amount', label: 'Amount', type: 'number', hint: 'In whole currency units' },
      { name: 'close_date', label: 'Expected close', type: 'date' },
    ],
  },
  task: {
    plural: 'tasks',
    title: 'New task',
    fields: [
      { name: 'title', label: 'Task', required: true },
      { name: 'due_at', label: 'Due', type: 'datetime-local' },
      {
        name: 'priority',
        label: 'Priority',
        options: [
          ['normal', 'Normal'],
          ['low', 'Low'],
          ['high', 'High'],
          ['urgent', 'Urgent'],
        ],
      },
    ],
  },
};

function openCreate(type: string): void {
  const spec = CREATE_FORMS[type];
  if (!spec) return;

  const form = h(
    'form',
    { id: 'create-form' },
    ...spec.fields.map((field) =>
      h(
        'div',
        { class: 'field' },
        h('label', { for: field.name }, field.label),
        field.options
          ? h(
              'select',
              { id: field.name, name: field.name },
              ...field.options.map(([value, label]) => h('option', { value }, label)),
            )
          : h('input', {
              id: field.name,
              name: field.name,
              type: field.type ?? 'text',
              required: field.required,
            }),
        field.hint
          ? h('div', { class: 'faint', style: 'font-size:11.5px;margin-top:4px' }, field.hint)
          : null,
      ),
    ),
  );

  const submit = async () => {
    const data = Object.fromEntries(new FormData(form as HTMLFormElement)) as Record<
      string,
      string
    >;
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!value) continue;
      if (key === 'amount') body[key] = Math.round(Number(value) * 100);
      else if (key === 'due_at') body[key] = new Date(value).toISOString();
      else body[key] = value;
    }
    await guard(async () => {
      const created = await api.post(`/${spec.plural}`, body, {
        // A stray double-click must not create the record twice.
        'idempotency-key': `web-${type}-${Date.now()}`,
      });
      closeModal();
      toast(`${spec.title.replace('New ', '')} created`);
      navigate(`/${spec.plural}/${created.id}`);
    });
  };

  openModal(spec.title, form, [
    h('button', { onclick: () => closeModal() }, 'Cancel'),
    h('button', { class: 'btn-primary', onclick: submit }, 'Create'),
  ]);
}

function openLogActivity(type: string, id: string): void {
  const form = h(
    'form',
    { id: 'activity-form' },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'type' }, 'Type'),
      h(
        'select',
        { id: 'type', name: 'type' },
        ...[
          ['note', 'Note'],
          ['call', 'Call'],
          ['email', 'Email'],
          ['meeting', 'Meeting'],
        ].map(([value, label]) => h('option', { value: value! }, label!)),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'subject' }, 'Subject'),
      h('input', { id: 'subject', name: 'subject' }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'body' }, 'Notes'),
      h('textarea', { id: 'body', name: 'body' }),
    ),
  );

  const submit = async () => {
    const data = Object.fromEntries(new FormData(form as HTMLFormElement)) as Record<
      string,
      string
    >;
    await guard(async () => {
      await api.post('/activities', {
        type: data['type'],
        subject: data['subject'] || null,
        body: data['body'] || null,
        [`${type}_id`]: id,
      });
      closeModal();
      toast('Activity logged');
      await render();
    });
  };

  openModal('Log activity', form, [
    h('button', { onclick: () => closeModal() }, 'Cancel'),
    h('button', { class: 'btn-primary', onclick: submit }, 'Log'),
  ]);
}

// -- Command palette ----------------------------------------------------------

const PLURAL: Record<string, string> = {
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
  task: 'tasks',
  activity: 'activities',
};

function openPalette(): void {
  closeModal();
  const results = h('div', { class: 'palette-results' });
  const input = h('input', {
    class: 'palette-input',
    type: 'search',
    placeholder: 'Search contacts, companies, deals…',
    autofocus: true,
  });

  let timer: number | undefined;
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) {
      mount(results, h('div', { class: 'palette-item faint' }, 'Type at least two characters'));
      return;
    }
    timer = window.setTimeout(async () => {
      try {
        const found = await api.get(`/search${query({ q: term, limit: 12 })}`);
        mount(
          results,
          ...(found.data.length === 0
            ? [h('div', { class: 'palette-item faint' }, 'No matches')]
            : found.data.map((hit: any) =>
                h(
                  'div',
                  {
                    class: 'palette-item',
                    onclick: () => {
                      closeModal();
                      navigate(`/${PLURAL[hit.entity_type]}/${hit.entity_id}`);
                    },
                  },
                  h(
                    'div',
                    { class: 'avatar', style: `background:${colorFor(hit.title)}` },
                    initials(hit.title),
                  ),
                  h(
                    'div',
                    {},
                    h('div', {}, hit.title),
                    h(
                      'div',
                      { class: 'faint', style: 'font-size:12px' },
                      hit.snippet.replace(/[[\]]/g, ''),
                    ),
                  ),
                  h('div', { class: 'palette-type' }, hit.entity_type),
                ),
              )),
        );
      } catch (error) {
        reportError(error);
      }
    }, 160);
  });

  const overlay = h(
    'div',
    {
      id: 'overlay',
      class: 'overlay',
      onclick: (event: MouseEvent) => {
        if (event.target === event.currentTarget) closeModal();
      },
    },
    h('div', { class: 'modal' }, input, results),
  );
  document.body.appendChild(overlay);
  input.focus();
}

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    openPalette();
  }
  if (event.key === 'Escape') closeModal();
});

// -- Render -------------------------------------------------------------------

async function render(): Promise<void> {
  const route = currentRoute();
  const [head, id] = route.segments;

  if (!state.identity) {
    const status = await api.get('/setup').catch(() => ({ complete: true }));
    mount(root(), authScreen(status.complete ? 'login' : 'setup'));
    return;
  }

  mount(root(), shell(loading()));

  try {
    let view: HTMLElement;
    switch (head) {
      case undefined:
        view = await dashboardView();
        break;
      case 'contacts':
        view = id ? await detailView('contact', 'contacts', id) : await listView(contactsConfig);
        break;
      case 'companies':
        view = id ? await detailView('company', 'companies', id) : await listView(companiesConfig);
        break;
      case 'deals':
        view = id
          ? await detailView('deal', 'deals', id)
          : new URLSearchParams(location.search).get('view') === 'list'
            ? await listView(dealsListConfig)
            : await dealsView();
        break;
      case 'tasks':
        view = await listView(tasksConfig);
        break;
      case 'activities':
        view = await listView(activitiesConfig);
        break;
      case 'audit':
        view = await auditView();
        break;
      case 'agents':
        view = await agentsView();
        break;
      case 'health':
        view = await healthView();
        break;
      default:
        view = shell(
          empty(
            'Page not found',
            `Nothing lives at ${route.path}.`,
            h('a', { href: '/', 'data-link': '', class: 'btn' }, 'Back to dashboard'),
          ),
        );
    }
    mount(root(), view);
  } catch (error) {
    if (error instanceof RequestFailed && error.status === 401) {
      state.identity = null;
      await render();
      return;
    }
    reportError(error);
    mount(
      root(),
      shell(
        empty(
          'Could not load this page',
          error instanceof RequestFailed
            ? (error.error.hint ?? error.error.message)
            : String(error),
          h('button', { onclick: () => void render() }, 'Retry'),
        ),
      ),
    );
  }
}

async function boot(): Promise<void> {
  try {
    state.identity = await api.get('/auth/me');
  } catch {
    state.identity = null;
  }
}

await boot();
await render();
