// The studio's browser side. Plain modules, no framework and no build step: every value that came
// from a trace, a model, or a person is inserted with textContent, never as HTML.

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let session = { token: '', actor: 'studio' };
let overview = { sources: {} };

// ── Small helpers ───────────────────────────────────────────────────

function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else if (key === 'value') element.value = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  append(element, children);
  return element;
}

function s(tag, attrs = {}, ...children) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function pretty(value) {
  return h('pre', {}, value === undefined ? '' : JSON.stringify(value, null, 2));
}

function badge(value) {
  return h('span', { class: `badge ${String(value ?? '').replace(/[^a-z_-]/gi, '')}` }, String(value ?? '—'));
}

function money(value) {
  return value === undefined || value === null ? '—' : `$${Number(value).toFixed(4)}`;
}

function ms(value) {
  return value === undefined || value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function when(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function notice(message, kind = '') {
  return h('div', { class: `notice ${kind}` }, message);
}

function table(columns, rows, onRow) {
  return h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        columns.map((column) => h('th', { class: column.num ? 'num' : '' }, column.label)),
      ),
    ),
    h(
      'tbody',
      {},
      rows.length === 0
        ? h('tr', {}, h('td', { colspan: columns.length, class: 'muted' }, 'Nothing here yet.'))
        : rows.map((row) =>
            h(
              'tr',
              { class: onRow ? 'clickable' : '', onclick: onRow ? () => onRow(row) : undefined },
              columns.map((column) => h('td', { class: column.num ? 'num' : '' }, column.value(row))),
            ),
          ),
    ),
  );
}

function parseJson(text, fallback) {
  if (!text.trim()) return fallback;
  return JSON.parse(text);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(session.token ? { 'x-studio-token': session.token } : {}),
    },
    credentials: 'same-origin',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    error.detail = body?.error?.detail;
    throw error;
  }
  return body;
}

function post(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

/** Runs an action from a form, showing its result or its error beneath it. */
function action(output, run) {
  return async (event) => {
    event?.preventDefault?.();
    output.replaceChildren(h('p', { class: 'muted' }, 'Working…'));
    try {
      const result = await run();
      output.replaceChildren(notice('Done.'), result === undefined ? '' : pretty(result));
    } catch (error) {
      output.replaceChildren(notice(error.message, 'error'), error.detail ? pretty(error.detail) : '');
    }
  };
}

function go(hash) {
  location.hash = hash;
}

// ── Navigation ──────────────────────────────────────────────────────

const VIEWS = [
  { id: 'traces', label: 'Traces', show: (s) => s.traces, render: renderTraces },
  { id: 'threads', label: 'Threads', show: (s) => s.graphs?.length, render: renderThreads },
  { id: 'inbox', label: 'Inbox', show: (s) => s.graphs?.length || s.reviews?.length, render: renderInbox },
  { id: 'experiments', label: 'Experiments', show: (s) => s.experiments || s.datasets, render: renderExperiments },
  { id: 'prompts', label: 'Prompts', show: (s) => s.prompts, render: renderPrompts },
  { id: 'costs', label: 'Costs', show: (s) => s.costs, render: renderCosts },
  { id: 'health', label: 'Health', show: (s) => s.health, render: renderHealth },
  { id: 'operations', label: 'Operations', show: (s) => s.operations || s.assets, render: renderOperations },
];

function available() {
  return VIEWS.filter((entry) => entry.show(overview.sources));
}

function renderNav(active) {
  nav.replaceChildren(
    ...available().map((entry) =>
      h('a', { href: `#/${entry.id}`, class: entry.id === active ? 'active' : '' }, entry.label),
    ),
  );
}

async function route() {
  const [, id = '', ...rest] = location.hash.replace(/^#/, '').split('/');
  const views = available();
  const current = views.find((entry) => entry.id === id) ?? views[0];
  renderNav(current?.id);
  if (!current) {
    view.replaceChildren(
      h('h1', {}, 'Nothing to show'),
      notice('The studio was started without any sources. Pass traces, graphs, prompts, or experiments in the config.'),
    );
    return;
  }
  view.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    await current.render(rest.map(decodeURIComponent));
  } catch (error) {
    view.replaceChildren(h('h1', {}, current.label), notice(error.message, 'error'));
  }
  view.focus();
}

// ── Traces ──────────────────────────────────────────────────────────

async function renderTraces([traceId]) {
  if (traceId) return renderTrace(traceId);
  const filters = {
    status: h(
      'select',
      {},
      ['', 'ok', 'error'].map((value) => h('option', { value }, value || 'any status')),
    ),
    kind: h(
      'select',
      {},
      ['', 'chain', 'graph', 'agent', 'node', 'model', 'tool', 'retriever'].map((value) =>
        h('option', { value }, value || 'any kind'),
      ),
    ),
    name: h('input', { placeholder: 'name' }),
    model: h('input', { placeholder: 'model' }),
    since: h('input', { type: 'datetime-local' }),
  };
  const results = h('div');
  const load = async (event) => {
    event?.preventDefault?.();
    const query = new URLSearchParams({ limit: '100' });
    for (const [key, input] of Object.entries(filters)) {
      if (!input.value) continue;
      query.set(key, key === 'since' ? new Date(input.value).toISOString() : input.value);
    }
    const { runs } = await api(`/api/traces?${query}`);
    results.replaceChildren(
      table(
        [
          { label: 'Started', value: (run) => when(run.startedAt) },
          { label: 'Name', value: (run) => run.name },
          { label: 'Kind', value: (run) => run.kind },
          { label: 'Status', value: (run) => badge(run.status) },
          { label: 'Model', value: (run) => run.model ?? '' },
          { label: 'Latency', num: true, value: (run) => ms(run.latencyMs) },
          { label: 'Cost', num: true, value: (run) => money(run.cost) },
          { label: 'Feedback', num: true, value: (run) => run.feedback || '' },
        ],
        runs,
        (run) => go(`#/traces/${encodeURIComponent(run.traceId)}`),
      ),
    );
  };
  view.replaceChildren(
    h('h1', {}, 'Traces'),
    h('form', { class: 'inline', onsubmit: load }, Object.values(filters), h('button', { class: 'primary' }, 'Filter')),
    results,
  );
  await load();
}

async function renderTrace(traceId) {
  const { tree, text } = await api(`/api/traces/${encodeURIComponent(traceId)}`);
  const detail = h('div');
  let selected;

  const select = (run, element) => {
    selected?.classList.remove('selected');
    selected = element;
    element.classList.add('selected');
    const output = h('div');
    const key = h('input', { placeholder: 'key, such as correctness', required: true });
    const score = h('input', { type: 'number', step: 'any', placeholder: 'score', required: true });
    const comment = h('input', { placeholder: 'comment' });
    detail.replaceChildren(
      h('h2', {}, run.name, ' ', badge(run.status)),
      h(
        'p',
        { class: 'muted' },
        `${run.kind} · ${ms(run.latencyMs)} · ${money(run.cost)}${run.model ? ` · ${run.model}` : ''}`,
      ),
      run.error ? notice(`${run.error.name}: ${run.error.message}`, 'error') : '',
      h('h2', {}, 'Inputs'),
      pretty(run.inputs),
      h('h2', {}, 'Outputs'),
      pretty(run.outputs),
      run.metadata ? [h('h2', {}, 'Metadata'), pretty(run.metadata)] : '',
      run.feedback?.length ? [h('h2', {}, 'Feedback'), pretty(run.feedback)] : '',
      h('h2', {}, 'Add feedback'),
      h(
        'form',
        {
          class: 'inline',
          onsubmit: action(output, () =>
            post(`/api/runs/${encodeURIComponent(run.id)}/feedback`, {
              key: key.value,
              score: Number(score.value),
              comment: comment.value || undefined,
            }),
          ),
        },
        key,
        score,
        comment,
        h('button', { class: 'primary' }, 'Record'),
      ),
      output,
    );
  };

  const renderNode = (node) => {
    const label = h(
      'span',
      { class: 'tree-node' },
      `${node.kind}: ${node.name}`,
      ' ',
      badge(node.status),
      h('span', { class: 'muted' }, ` ${ms(node.latencyMs)}${node.cost ? ` · ${money(node.cost)}` : ''}`),
    );
    label.addEventListener('click', () => select(node, label));
    return h('li', {}, label, node.children?.length ? h('ul', { class: 'tree' }, node.children.map(renderNode)) : '');
  };

  const other = h('input', { placeholder: 'another trace id' });
  const comparison = h('div');
  view.replaceChildren(
    h('p', {}, h('a', { href: '#/traces' }, '← Traces')),
    h('h1', {}, `Trace ${traceId}`),
    h(
      'div',
      { class: 'row' },
      h('div', {}, h('ul', { class: 'tree root' }, renderNode(tree)), h('h2', {}, 'As text'), h('pre', {}, text)),
      detail,
    ),
    h('h2', {}, 'Compare with another trace'),
    h(
      'form',
      {
        class: 'inline',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const { comparison: result } = await api(
              `/api/compare/traces?left=${encodeURIComponent(traceId)}&right=${encodeURIComponent(other.value)}`,
            );
            comparison.replaceChildren(renderTraceComparison(result));
          } catch (error) {
            comparison.replaceChildren(notice(error.message, 'error'));
          }
        },
      },
      other,
      h('button', { class: 'primary' }, 'Compare'),
    ),
    comparison,
  );
  const first = view.querySelector('.tree-node');
  if (first) select(tree, first);
}

function renderTraceComparison(result) {
  return h(
    'div',
    {},
    h(
      'p',
      {},
      h('span', { class: 'stat' }, h('b', {}, ms(result.latencyMsDelta)), 'latency change'),
      h('span', { class: 'stat' }, h('b', {}, money(result.costDelta)), 'cost change'),
    ),
    result.onlyLeft.length ? [h('h2', {}, 'Only in this trace'), pretty(result.onlyLeft)] : '',
    result.onlyRight.length ? [h('h2', {}, 'Only in the other'), pretty(result.onlyRight)] : '',
    h('h2', {}, 'Runs that changed'),
    table(
      [
        { label: 'Path', value: (item) => item.path },
        { label: 'Differences', value: (item) => item.differences.map((difference) => difference.path).join(', ') },
      ],
      result.matched.filter((item) => item.differences.length > 0),
    ),
  );
}

// ── Threads ─────────────────────────────────────────────────────────

let graphsCache;
async function graphs() {
  graphsCache ??= (await api('/api/graphs')).graphs;
  return graphsCache;
}

function diagram(layout, highlight = []) {
  const pad = 20;
  const marked = new Set(highlight);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const width = layout.width + pad * 2 + 60;
  const height = layout.height + pad * 2;
  const svgElement = s('svg', { class: 'diagram', viewBox: `0 0 ${width} ${height}`, width, role: 'img' });
  svgElement.append(
    s(
      'defs',
      {},
      s(
        'marker',
        { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' },
        s('polygon', { points: '0,0 10,5 0,10' }),
      ),
    ),
  );
  for (const edge of layout.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const x1 = pad + from.x + from.width / 2;
    const y1 = pad + from.y + from.height;
    const x2 = pad + to.x + to.width / 2;
    const y2 = pad + to.y;
    const d = edge.back
      ? `M ${pad + from.x + from.width} ${pad + from.y + from.height / 2} C ${pad + layout.width + 50} ${pad + from.y}, ${pad + layout.width + 50} ${pad + to.y + to.height}, ${pad + to.x + to.width} ${pad + to.y + to.height / 2}`
      : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
    svgElement.append(
      s('path', {
        d,
        class: `${edge.conditional ? 'conditional' : ''} ${edge.back ? 'back' : ''}`,
        'marker-end': 'url(#arrow)',
      }),
    );
    if (edge.label) {
      svgElement.append(s('text', { x: (x1 + x2) / 2 + 4, y: (y1 + y2) / 2 }, edge.label));
    }
  }
  for (const node of layout.nodes) {
    const terminal = node.kind !== 'node';
    svgElement.append(
      s('rect', {
        x: pad + node.x,
        y: pad + node.y,
        width: node.width,
        height: node.height,
        rx: terminal ? node.height / 2 : 6,
        class: `${terminal ? 'terminal' : ''} ${marked.has(node.id) ? 'highlight' : ''}`,
      }),
      s(
        'text',
        { x: pad + node.x + node.width / 2, y: pad + node.y + node.height / 2 + 4, 'text-anchor': 'middle' },
        node.kind === 'start'
          ? 'start'
          : node.kind === 'end'
            ? 'end'
            : `${node.id}${node.defer ? ' ⏸' : ''}${node.cache ? ' ⟳' : ''}`,
      ),
    );
  }
  return svgElement;
}

async function renderThreads([graphName, threadId]) {
  if (graphName && threadId) return renderThread(graphName, threadId);
  const all = await graphs();
  const chosen = all.find((graph) => graph.name === graphName) ?? all[0];
  const { threads, listed } = await api(`/api/graphs/${encodeURIComponent(chosen.name)}/threads`);
  const open = h('input', { placeholder: 'thread id' });
  view.replaceChildren(
    h('h1', {}, 'Threads'),
    h(
      'div',
      { class: 'toolbar' },
      all.map((graph) =>
        h(
          'button',
          {
            class: graph.name === chosen.name ? 'primary' : '',
            onclick: () => go(`#/threads/${encodeURIComponent(graph.name)}`),
          },
          graph.name,
        ),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      h('div', {}, diagram(chosen.layout)),
      h('div', {}, h('h2', {}, 'Mermaid'), h('pre', {}, chosen.mermaid)),
    ),
    h('h2', {}, 'Threads'),
    listed
      ? table(
          [
            { label: 'Thread', value: (thread) => thread.threadId },
            { label: 'Step', num: true, value: (thread) => thread.step },
            { label: 'Status', value: (thread) => badge(thread.status) },
            { label: 'Next', value: (thread) => (thread.next ?? []).join(', ') },
            { label: 'Waiting on', num: true, value: (thread) => thread.interrupts || '' },
            { label: 'Updated', value: (thread) => when(thread.createdAt) },
          ],
          threads,
          (thread) => go(`#/threads/${encodeURIComponent(chosen.name)}/${encodeURIComponent(thread.threadId)}`),
        )
      : notice('This graph was given without a way to list threads. Pass its checkpointer, or open a thread by id.'),
    h(
      'form',
      {
        class: 'inline',
        onsubmit: (event) => {
          event.preventDefault();
          if (open.value) go(`#/threads/${encodeURIComponent(chosen.name)}/${encodeURIComponent(open.value)}`);
        },
      },
      open,
      h('button', {}, 'Open thread'),
    ),
  );
}

async function renderThread(graphName, threadId, step) {
  const all = await graphs();
  const graph = all.find((entry) => entry.name === graphName);
  if (!graph) throw new Error(`No graph named ${graphName}`);
  const base = `/api/graphs/${encodeURIComponent(graphName)}/threads/${encodeURIComponent(threadId)}`;
  const { checkpoint: latest, history } = await api(base);
  const checkpoint = step === undefined ? latest : (await api(`${base}/steps/${step}`)).checkpoint;
  const pending = latest.interrupts ?? (latest.interrupt ? [latest.interrupt] : []);
  const output = h('div');

  const resumeValue = h('textarea', { placeholder: 'The answer, as JSON: true, "approved", { "approved": true }' });
  const editValues = h('textarea', {}, JSON.stringify(checkpoint.state, null, 2));
  const asNode = h('input', { placeholder: 'as node (optional)' });

  view.replaceChildren(
    h('p', {}, h('a', { href: `#/threads/${encodeURIComponent(graphName)}` }, `← ${graphName}`)),
    h('h1', {}, `Thread ${threadId} `, badge(latest.status)),
    h(
      'div',
      { class: 'row' },
      h(
        'div',
        {},
        diagram(graph.layout, checkpoint.next),
        h('p', { class: 'muted' }, `Step ${checkpoint.step}. Next: ${checkpoint.next.join(', ') || 'nothing'}.`),
      ),
      h(
        'div',
        {},
        h('h2', {}, step === undefined ? 'Current state' : `State at step ${step}`),
        pretty(checkpoint.state),
      ),
    ),
    pending.length && latest.status === 'awaiting_input'
      ? h(
          'div',
          { class: 'card' },
          h('h2', {}, 'Waiting for input'),
          pending.map((item) =>
            h(
              'div',
              {},
              h('p', {}, h('b', {}, item.node), ': ', item.reason ?? ''),
              item.payload === undefined ? '' : pretty(item.payload),
            ),
          ),
          graph.supports.resume
            ? h(
                'form',
                {
                  onsubmit: action(output, async () => {
                    const result = await post(`${base}/resume`, { value: parseJson(resumeValue.value, null) });
                    graphsCache = undefined;
                    return result;
                  }),
                },
                resumeValue,
                h('button', { class: 'primary' }, 'Answer and resume'),
              )
            : notice('This graph was given without resume support.'),
        )
      : '',
    h('h2', {}, 'History'),
    table(
      [
        { label: 'Step', num: true, value: (entry) => entry.step },
        { label: 'Status', value: (entry) => badge(entry.status) },
        { label: 'Next', value: (entry) => (entry.next ?? []).join(', ') },
        { label: 'Written', value: (entry) => when(entry.createdAt) },
        {
          label: '',
          value: (entry) =>
            graph.supports.fork
              ? h(
                  'button',
                  {
                    onclick: action(output, async () => {
                      const { threadId: forked } = await post(`${base}/fork`, { step: entry.step });
                      go(`#/threads/${encodeURIComponent(graphName)}/${encodeURIComponent(forked)}`);
                      return { forked };
                    }),
                  },
                  'Fork from here',
                )
              : '',
        },
      ],
      history,
      (entry) => renderThread(graphName, threadId, entry.step),
    ),
    graph.supports.edit
      ? h(
          'div',
          {},
          h('h2', {}, 'Edit state'),
          h(
            'p',
            { class: 'muted' },
            'Writes these values as a new checkpoint, as if a node had produced them. History is kept.',
          ),
          h(
            'form',
            {
              onsubmit: action(output, () =>
                post(`${base}/state`, { values: parseJson(editValues.value, {}), asNode: asNode.value || undefined }),
              ),
            },
            editValues,
            h('div', { class: 'toolbar' }, asNode, h('button', { class: 'primary' }, 'Save state')),
          ),
        )
      : '',
    output,
  );
}

// ── Inbox ───────────────────────────────────────────────────────────

async function renderInbox() {
  const { interrupts, reviews } = await api('/api/inbox');
  const waiting = reviews.reduce((total, queue) => total + queue.items.length, interrupts.length);
  view.replaceChildren(
    h('h1', {}, `Inbox (${waiting})`),
    h('h2', {}, 'Threads waiting for an answer'),
    interrupts.length === 0 ? h('p', { class: 'muted' }, 'No thread is waiting.') : '',
    interrupts.map((entry) => {
      const output = h('div');
      const answer = h('textarea', { placeholder: 'The answer, as JSON' });
      const base = `/api/graphs/${encodeURIComponent(entry.graph)}/threads/${encodeURIComponent(entry.threadId)}`;
      return h(
        'div',
        { class: 'card' },
        h(
          'p',
          {},
          h(
            'a',
            { href: `#/threads/${encodeURIComponent(entry.graph)}/${encodeURIComponent(entry.threadId)}` },
            `${entry.graph} / ${entry.threadId}`,
          ),
          h('span', { class: 'muted' }, ` · step ${entry.step} · ${when(entry.createdAt)}`),
        ),
        entry.interrupts.map((item) =>
          h(
            'div',
            {},
            h('p', {}, h('b', {}, item.node), ': ', item.reason ?? ''),
            item.payload === undefined ? '' : pretty(item.payload),
          ),
        ),
        h(
          'form',
          { onsubmit: action(output, () => post(`${base}/resume`, { value: parseJson(answer.value, null) })) },
          answer,
          h('button', { class: 'primary' }, 'Answer'),
        ),
        output,
      );
    }),
    h('h2', {}, 'Review queues'),
    reviews.length === 0 ? h('p', { class: 'muted' }, 'No review queue was configured.') : '',
    reviews.map((queue) =>
      h(
        'div',
        {},
        h('h2', {}, queue.queue, ` (${queue.items.length})`),
        queue.items.map((item) => reviewCard(queue.queue, item)),
      ),
    ),
  );
}

function reviewCard(queue, item) {
  const output = h('div');
  const inputs = item.rubric.map((question) => {
    const input =
      question.type === 'boolean'
        ? h('select', {}, h('option', { value: '1' }, 'yes'), h('option', { value: '0' }, 'no'))
        : question.type === 'choice'
          ? h(
              'select',
              {},
              (question.choices ?? []).map((choice, index) => h('option', { value: String(index) }, choice)),
            )
          : question.type === 'text'
            ? h('input', {})
            : h('input', { type: 'number', min: '0', max: '1', step: '0.1', value: '1' });
    return { question, input };
  });
  const note = h('input', { placeholder: 'note' });
  const submit = action(output, () =>
    post(`/api/reviews/${encodeURIComponent(queue)}/items/${encodeURIComponent(item.id)}`, {
      scores: inputs.map(({ question, input }) => ({
        key: question.key,
        score: question.type === 'text' ? 1 : Number(input.value),
        ...(question.type === 'text' || question.type === 'choice'
          ? { comment: question.type === 'text' ? input.value : question.choices?.[Number(input.value)] }
          : {}),
      })),
      note: note.value || undefined,
    }),
  );
  return h(
    'div',
    { class: 'card' },
    h(
      'p',
      {},
      badge(item.status),
      ' ',
      h('span', { class: 'muted' }, `${item.id} · ${when(item.enqueuedAt)} · ${item.answers.length} answers`),
    ),
    pretty(item.subject),
    h(
      'form',
      { onsubmit: submit },
      inputs.map(({ question, input }) => h('label', {}, question.prompt, input)),
      note,
      h('button', { class: 'primary' }, 'Submit review'),
    ),
    output,
  );
}

// ── Experiments ─────────────────────────────────────────────────────

async function renderExperiments([id]) {
  if (id) {
    const { experiment } = await api(`/api/experiments/${encodeURIComponent(id)}`);
    view.replaceChildren(
      h('p', {}, h('a', { href: '#/experiments' }, '← Experiments')),
      h('h1', {}, experiment.name),
      pretty(experiment.metrics),
      h('h2', {}, 'Results'),
      pretty(experiment.results),
    );
    return;
  }
  const [{ experiments }, datasets] = await Promise.all([
    overview.sources.experiments ? api('/api/experiments?limit=100') : { experiments: [] },
    overview.sources.datasets ? api('/api/datasets').then((body) => body.datasets) : [],
  ]);
  const baseline = h(
    'select',
    {},
    experiments.map((experiment) => h('option', { value: experiment.id }, `${experiment.name} (${experiment.id})`)),
  );
  const candidate = h(
    'select',
    {},
    experiments.map((experiment) => h('option', { value: experiment.id }, `${experiment.name} (${experiment.id})`)),
  );
  if (experiments.length > 1) {
    candidate.value = experiments[0].id;
    baseline.value = experiments[1].id;
  }
  const result = h('div');
  view.replaceChildren(
    h('h1', {}, 'Experiments'),
    datasets.length
      ? [
          h('h2', {}, 'Datasets'),
          table(
            [
              { label: 'Name', value: (d) => d.name },
              { label: 'Versions', value: (d) => d.versions.join(', ') },
            ],
            datasets,
          ),
        ]
      : '',
    h('h2', {}, 'Compare'),
    h(
      'form',
      {
        class: 'inline',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const { comparison, text } = await api(
              `/api/compare/experiments?baseline=${encodeURIComponent(baseline.value)}&candidate=${encodeURIComponent(candidate.value)}`,
            );
            result.replaceChildren(renderExperimentComparison(comparison, text));
          } catch (error) {
            result.replaceChildren(notice(error.message, 'error'));
          }
        },
      },
      h('label', {}, 'Baseline', baseline),
      h('label', {}, 'Candidate', candidate),
      h('button', { class: 'primary', disabled: experiments.length < 2 }, 'Compare'),
    ),
    result,
    h('h2', {}, 'All experiments'),
    table(
      [
        { label: 'Started', value: (e) => when(e.startedAt) },
        { label: 'Name', value: (e) => e.name },
        { label: 'Dataset', value: (e) => `${e.dataset.name}@${e.dataset.version}` },
        { label: 'Examples', num: true, value: (e) => e.examples },
        { label: 'Errors', num: true, value: (e) => e.errors },
        { label: 'Metrics', value: (e) => e.metrics.map((m) => `${m.key} ${m.mean.toFixed(3)}`).join(' · ') },
      ],
      experiments,
      (e) => go(`#/experiments/${encodeURIComponent(e.id)}`),
    ),
  );
}

function renderExperimentComparison(comparison, text) {
  return h(
    'div',
    {},
    comparison.datasetMismatch
      ? notice('The two experiments ran over different dataset versions; the comparison is not like for like.', 'error')
      : '',
    h(
      'p',
      {},
      comparison.regressed
        ? h('b', { class: 'bad' }, 'Regressed.')
        : h('b', { class: 'good' }, 'No regression beyond noise.'),
    ),
    table(
      [
        { label: 'Metric', value: (m) => m.key },
        { label: 'Baseline', num: true, value: (m) => m.baseline.toFixed(3) },
        { label: 'Candidate', num: true, value: (m) => m.candidate.toFixed(3) },
        { label: 'Change', num: true, value: (m) => `${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(3)}` },
        { label: '95% interval', num: true, value: (m) => `${m.ci95[0].toFixed(3)} … ${m.ci95[1].toFixed(3)}` },
        { label: 'Verdict', value: (m) => badge(m.verdict) },
      ],
      comparison.metrics,
    ),
    comparison.newErrors.length ? [h('h2', {}, 'New failures'), pretty(comparison.newErrors)] : '',
    comparison.regressions.length ? [h('h2', {}, 'Examples that got worse'), pretty(comparison.regressions)] : '',
    h('h2', {}, 'As text'),
    h('pre', {}, text),
  );
}

// ── Prompts ─────────────────────────────────────────────────────────

async function renderPrompts([name]) {
  if (name) return renderPrompt(name);
  const { prompts } = await api('/api/prompts');
  view.replaceChildren(
    h('h1', {}, 'Prompts'),
    table(
      [
        { label: 'Prompt', value: (p) => p.name },
        {
          label: 'Labels',
          value: (p) =>
            p.labels
              .map(
                (label) =>
                  `${label.label} → ${label.version}${label.variants ? ` (${label.variants.length} arms)` : ''}`,
              )
              .join(' · '),
        },
      ],
      prompts,
      (p) => go(`#/prompts/${encodeURIComponent(p.name)}`),
    ),
  );
}

async function renderPrompt(name) {
  const base = `/api/prompts/${encodeURIComponent(name)}`;
  const { versions, labels, history } = await api(base);
  const refs = [...labels.map((label) => label.label), ...versions.map((version) => version.version)];
  const options = () => refs.map((ref) => h('option', { value: ref }, ref));

  const diffFrom = h('select', {}, options());
  const diffTo = h('select', {}, options());
  if (versions[1]) diffFrom.value = versions[1].version;
  if (versions[0]) diffTo.value = versions[0].version;
  const diffOutput = h('div');

  const promoteFrom = h('select', {}, options());
  const promoteTo = h('input', { placeholder: 'to label, such as production', required: true });
  const promoteForce = h('input', { type: 'checkbox' });
  const promoteNote = h('input', { placeholder: 'note' });
  const promoteOutput = h('div');

  const rollbackLabel = h(
    'select',
    {},
    labels.map((label) => h('option', { value: label.label }, label.label)),
  );
  const rollbackOutput = h('div');

  const playRef = h('select', {}, options());
  const playVariables = h('textarea', { placeholder: '{ "topic": "batteries" }' });
  const playModel = h('input', { placeholder: 'model override' });
  const playOutput = h('div');

  view.replaceChildren(
    h('p', {}, h('a', { href: '#/prompts' }, '← Prompts')),
    h('h1', {}, name),
    h('h2', {}, 'Labels'),
    table(
      [
        { label: 'Label', value: (l) => l.label },
        { label: 'Version', value: (l) => l.version },
        {
          label: 'Split',
          value: (l) => (l.variants ? l.variants.map((v) => `${v.version} × ${v.weight}`).join(', ') : ''),
        },
        { label: 'Moved', value: (l) => `${when(l.updatedAt)}${l.by ? ` by ${l.by}` : ''}` },
      ],
      labels,
    ),
    h('h2', {}, 'Versions'),
    table(
      [
        { label: 'Version', value: (v) => v.version },
        { label: 'Committed', value: (v) => when(v.createdAt) },
        { label: 'By', value: (v) => v.author ?? '' },
        { label: 'Message', value: (v) => v.message ?? '' },
        { label: 'Variables', value: (v) => (v.variables ?? []).join(', ') },
      ],
      versions,
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'div',
        {},
        h('h2', {}, 'Compare versions'),
        h(
          'form',
          {
            class: 'inline',
            onsubmit: async (event) => {
              event.preventDefault();
              try {
                const { diff } = await api(
                  `${base}/diff?from=${encodeURIComponent(diffFrom.value)}&to=${encodeURIComponent(diffTo.value)}`,
                );
                diffOutput.replaceChildren(renderPromptDiff(diff));
              } catch (error) {
                diffOutput.replaceChildren(notice(error.message, 'error'));
              }
            },
          },
          h('label', {}, 'From', diffFrom),
          h('label', {}, 'To', diffTo),
          h('button', { class: 'primary' }, 'Diff'),
        ),
        diffOutput,
      ),
      h(
        'div',
        {},
        h('h2', {}, 'Promote'),
        h(
          'form',
          {
            class: 'inline',
            onsubmit: action(promoteOutput, () =>
              post(`${base}/promote`, {
                to: promoteTo.value,
                ...(versions.some((v) => v.version === promoteFrom.value)
                  ? { version: promoteFrom.value }
                  : { from: promoteFrom.value }),
                force: promoteForce.checked,
                note: promoteNote.value || undefined,
              }),
            ),
          },
          h('label', {}, 'From', promoteFrom),
          h('label', {}, 'To', promoteTo),
          promoteNote,
          h('label', {}, 'Force past gates', promoteForce),
          h('button', { class: 'primary' }, 'Promote'),
        ),
        promoteOutput,
        labels.length
          ? [
              h('h2', {}, 'Roll back'),
              h(
                'form',
                {
                  class: 'inline',
                  onsubmit: action(rollbackOutput, () => post(`${base}/rollback`, { label: rollbackLabel.value })),
                },
                rollbackLabel,
                h('button', {}, 'Roll back'),
              ),
              rollbackOutput,
            ]
          : '',
      ),
    ),
    h('h2', {}, 'Playground'),
    h(
      'p',
      { class: 'muted' },
      overview.sources.playground
        ? 'Renders the prompt and runs it through the configured client.'
        : 'Renders the prompt. Give the studio a client to run it too.',
    ),
    h(
      'form',
      {
        onsubmit: action(playOutput, async () => {
          const result = await post(`${base}/playground`, {
            ref: playRef.value,
            variables: parseJson(playVariables.value, {}),
            model: playModel.value || undefined,
          });
          playOutput.replaceChildren();
          return result;
        }),
      },
      h('div', { class: 'toolbar' }, h('label', {}, 'Version or label', playRef), playModel),
      playVariables,
      h('button', { class: 'primary' }, 'Run'),
    ),
    playOutput,
    h('h2', {}, 'History'),
    table(
      [
        { label: 'When', value: (e) => when(e.at) },
        { label: 'Action', value: (e) => e.action },
        { label: 'Label', value: (e) => e.label ?? '' },
        { label: 'Version', value: (e) => e.version ?? '' },
        { label: 'Previous', value: (e) => e.previous ?? '' },
        { label: 'By', value: (e) => e.by ?? '' },
        { label: 'Note', value: (e) => e.note ?? '' },
      ],
      history,
    ),
  );
}

function renderPromptDiff(diff) {
  if (!diff.changed) return notice('The two references are the same content.');
  const lines = [];
  for (const message of diff.messages) {
    if (message.change === 'unchanged') continue;
    lines.push(h('div', { class: 'muted' }, `@@ message ${message.index} (${message.role}) ${message.change}`));
    for (const line of message.lines) {
      lines.push(
        h(
          'div',
          { class: line.op === '+' ? 'diff-add' : line.op === '-' ? 'diff-del' : '' },
          `${line.op === '=' ? ' ' : line.op} ${line.text}`,
        ),
      );
    }
  }
  for (const [section, changes] of [
    ['config', diff.config],
    ['partials', diff.partials],
    ['defaults', diff.defaults],
  ]) {
    for (const change of changes) {
      lines.push(
        h('div', {}, `@@ ${section}.${change.key}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`),
      );
    }
  }
  return h('pre', {}, lines);
}

// ── Costs ───────────────────────────────────────────────────────────

async function renderCosts([days = '7']) {
  const report = await api(`/api/costs?days=${encodeURIComponent(days)}`);
  const max = Math.max(0.000001, ...report.byDay.map((day) => day.cost));
  const barWidth = 36;
  const chart = s('svg', {
    class: 'bars',
    viewBox: `0 0 ${Math.max(1, report.byDay.length) * (barWidth + 8)} 140`,
    width: Math.max(1, report.byDay.length) * (barWidth + 8),
    role: 'img',
  });
  report.byDay.forEach((day, index) => {
    const height = (day.cost / max) * 110;
    chart.append(
      s(
        'rect',
        { x: index * (barWidth + 8), y: 115 - height, width: barWidth, height },
        s('title', {}, `${day.day}: ${money(day.cost)} over ${day.runs} runs`),
      ),
      s('text', { x: index * (barWidth + 8), y: 132 }, day.day.slice(5)),
    );
  });
  view.replaceChildren(
    h('h1', {}, 'Costs'),
    h(
      'div',
      { class: 'toolbar' },
      ['1', '7', '30'].map((value) =>
        h('button', { class: value === days ? 'primary' : '', onclick: () => go(`#/costs/${value}`) }, `${value} days`),
      ),
    ),
    h('p', {}, h('span', { class: 'stat' }, h('b', {}, money(report.total)), `in the last ${report.days} days`)),
    chart,
    report.budgets.length
      ? [
          h('h2', {}, 'Budgets'),
          report.budgets.map((budget) => {
            const share = Math.min(1, budget.spent / Math.max(budget.limit, 0.000001));
            return h(
              'div',
              { class: 'card' },
              h(
                'p',
                {},
                h('b', {}, budget.name),
                ` · ${money(budget.spent)} of ${money(budget.limit)} this ${budget.period}`,
                budget.exceeded ? h('b', { class: 'bad' }, ' · over') : '',
              ),
              s(
                'svg',
                { class: 'meter', viewBox: '0 0 300 12', width: 300, role: 'img' },
                s('rect', { class: 'track', x: 0, y: 0, width: 300, height: 12, rx: 6 }),
                s('rect', {
                  class: `fill ${budget.exceeded ? 'over' : ''}`,
                  x: 0,
                  y: 0,
                  width: 300 * share,
                  height: 12,
                  rx: 6,
                }),
              ),
            );
          }),
        ]
      : '',
    h(
      'div',
      { class: 'row' },
      h(
        'div',
        {},
        h('h2', {}, 'By model'),
        table(
          [
            { label: 'Model', value: (m) => m.model },
            { label: 'Runs', num: true, value: (m) => m.runs },
            { label: 'Cost', num: true, value: (m) => money(m.cost) },
          ],
          report.byModel,
        ),
      ),
      h(
        'div',
        {},
        h('h2', {}, 'Most expensive runs'),
        table(
          [
            { label: 'Run', value: (r) => r.name },
            { label: 'Model', value: (r) => r.model ?? '' },
            { label: 'Cost', num: true, value: (r) => money(r.cost) },
          ],
          report.top,
          (r) => go(`#/traces/${encodeURIComponent(r.traceId)}`),
        ),
      ),
    ),
  );
}

// ── Health ──────────────────────────────────────────────────────────

async function renderHealth() {
  const health = await api('/api/health');
  const providers = Array.isArray(health.providers) ? health.providers : [];
  const circuits = Array.isArray(health.circuits) ? health.circuits : [];
  view.replaceChildren(
    h('h1', {}, 'Health'),
    providers.length
      ? [
          h('h2', {}, 'Providers'),
          table(
            [
              { label: 'Provider', value: (p) => p.providerName },
              { label: 'Healthy', value: (p) => badge(p.healthy ? 'ok' : 'error') },
              { label: 'Score', num: true, value: (p) => p.score },
              { label: 'Successes', num: true, value: (p) => p.successes },
              { label: 'Failures', num: true, value: (p) => p.failures },
              { label: 'Latency', num: true, value: (p) => ms(p.avgLatencyMs) },
              { label: 'Last error', value: (p) => p.lastError ?? '' },
            ],
            providers,
          ),
        ]
      : '',
    circuits.length
      ? [
          h('h2', {}, 'Circuits'),
          table(
            [
              { label: 'Provider', value: (c) => c.providerName },
              { label: 'State', value: (c) => badge(c.state) },
              { label: 'Failures in a row', num: true, value: (c) => c.consecutiveFailures },
              {
                label: 'Failure rate',
                num: true,
                value: (c) => (c.failureRate === undefined ? '' : `${(c.failureRate * 100).toFixed(0)}%`),
              },
              { label: 'Opened', value: (c) => when(c.openedAt) },
              { label: 'Last error', value: (c) => c.lastError ?? '' },
            ],
            circuits,
          ),
        ]
      : '',
    health.shared ? [h('h2', {}, 'Shared circuit state'), pretty(health.shared)] : '',
    health.cache ? [h('h2', {}, 'Response cache'), pretty(health.cache)] : '',
    health.metrics ? [h('h2', {}, 'Metrics'), pretty(health.metrics)] : '',
    !providers.length && !circuits.length && !health.shared && !health.metrics
      ? notice('Nothing recorded yet. Health and circuits fill in as the client makes requests.')
      : '',
  );
}

// ── Operations ──────────────────────────────────────────────────────

async function renderOperations([status = '']) {
  const [operations, assets] = await Promise.all([
    overview.sources.operations
      ? api(`/api/operations?limit=200${status ? `&status=${encodeURIComponent(status)}` : ''}`)
      : null,
    overview.sources.assets ? api('/api/assets') : null,
  ]);
  view.replaceChildren(
    h('h1', {}, 'Operations'),
    operations
      ? [
          h(
            'div',
            { class: 'toolbar' },
            ['', 'queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled', 'expired'].map((value) =>
              h(
                'button',
                { class: value === status ? 'primary' : '', onclick: () => go(`#/operations/${value}`) },
                value || 'all',
              ),
            ),
          ),
          h(
            'p',
            {},
            Object.entries(operations.counts).map(([key, count]) =>
              h('span', { class: 'stat' }, h('b', {}, count), key),
            ),
          ),
          table(
            [
              { label: 'Updated', value: (o) => when(o.updatedAt) },
              { label: 'Id', value: (o) => o.id },
              { label: 'Kind', value: (o) => o.kind ?? '' },
              { label: 'Status', value: (o) => badge(o.status) },
              { label: 'Attempt', num: true, value: (o) => `${o.attempt}/${o.maxAttempts}` },
              { label: 'Lease', value: (o) => (o.lease ? `${o.lease.owner} until ${when(o.lease.expiresAt)}` : '') },
              { label: 'Error', value: (o) => o.error?.message ?? '' },
            ],
            operations.operations,
          ),
        ]
      : '',
    assets
      ? [
          h('h2', {}, 'Assets'),
          assets.snapshot ? pretty(assets.snapshot) : '',
          assets.assets ? pretty(assets.assets) : '',
        ]
      : '',
  );
}

// ── Start ───────────────────────────────────────────────────────────

async function start() {
  try {
    session = await api('/api/session');
    overview = await api('/api/overview');
  } catch (error) {
    view.replaceChildren(
      h('h1', {}, 'Nexus studio'),
      notice(`The studio could not start: ${error.message}. Open the link it printed.`, 'error'),
    );
    return;
  }
  window.addEventListener('hashchange', route);
  await route();
}

start();
