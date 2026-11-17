const byId = id => document.getElementById(id);
const number = new Intl.NumberFormat();
const demoNames = ['support_agent', 'research_assistant', 'document_qa', 'summarize_ticket'];
const demo = Array.from({length: 14}, (_, day) => {
  const at = new Date();
  at.setDate(at.getDate() - day);
  return Array.from({length: [16, 27, 22, 31, 35, 23, 29][day % 7] + (day % 3) * 3}, (_, index) => {
    const name = demoNames[(day + index) % demoNames.length];
    const error = (day * 13 + index) % 23 === 0;
    const input = {query: 'How do I update my billing details?'};
    const output = {answer: 'Open Settings, then select Billing.'};
    const duration = 750 + ((day + 1) * (index + 17) * 137) % 2300;
    return {
      id: 'demo-' + day + '-' + index, name, project: index % 4 ? 'customer-support' : 'knowledge-base',
      at: at.toISOString(), status: error ? 'error' : 'success', duration,
      tokens: 420 + index * 31, cost: (420 + index * 31) * 0.000004,
      input, output: error ? null : output, error: error ? 'Upstream model request timed out' : undefined,
      steps: [
        {name: 'retrieve_documents', type: 'retriever', duration: 180, input, output: {documents: 3}},
        {name: 'generate_response', type: 'llm', duration: duration - 180, output: error ? null : output,
          error: error ? 'Upstream model request timed out' : undefined}
      ]
    };
  });
}).flat();

let traces = demo;
let view = 'overview';
let scopedAgent;
let tracesReady = false;
const money = amount => '$' + amount.toFixed(4);
const latency = duration => (duration / 1000).toFixed(2) + ' s';

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function openModal(title, children) {
  byId('modal-title').textContent = title;
  byId('modal-body').replaceChildren(...children);
  if (!byId('modal').open) byId('modal').showModal();
}

function payload(label, data) {
  const block = element('section', undefined, 'modal-section');
  const value = typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2);
  block.append(element('h2', label), element('pre', value));
  return block;
}

function runStatus(run) {
  if (run.status === 'error' || run.error != null) return 'error';
  return run.status === 'success' || run.output != null ? 'success' : '';
}

function statusPill(status) {
  return element('span', status === 'error' ? 'Error' : status === 'success' ? 'Success' : 'Recorded',
    'pill ' + status);
}

function showTrace(trace, linked = false) {
  const inspector = byId('trace-inspector');
  const metadata = element('div', undefined, 'trace-meta');
  metadata.append(statusPill(runStatus(trace)), element('span', latency(trace.duration), 'pill'),
    element('span', number.format(trace.tokens) + ' tokens', 'pill'));
  if (trace.environment) metadata.append(element('span', trace.environment, 'pill'));
  if (typeof trace.cost_nanos === 'number') metadata.append(element('span', billingMoney(trace.cost_nanos), 'pill'));

  const summary = element('div', undefined, 'inspector-summary');
  const identity = element('div');
  identity.append(metadata, element('p', traceScope(trace) + ' · ' + trace.id, 'trace-id'));
  const link = element('button', 'Copy link', 'button');
  const shareUrl = new URL('/', location.origin);
  shareUrl.searchParams.set('trace', trace.id);
  link.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl.href);
      link.textContent = 'Copied';
    } catch {
      const field = element('input');
      field.readOnly = true;
      field.value = shareUrl.href;
      field.setAttribute('aria-label', 'Trace link');
      link.replaceWith(field);
      field.select();
    }
  });
  summary.append(identity, link);

  const split = element('div', undefined, 'inspector-split');
  const tree = element('nav', undefined, 'step-tree');
  tree.setAttribute('aria-label', 'Trace runs');
  const treeHead = element('h3', 'Execution tree', 'inspector-label');
  const list = element('div');
  tree.append(treeHead, list);
  const detail = element('section', undefined, 'step-detail');
  const stepTitle = element('h3');
  const tabs = element('div', undefined, 'trace-tabs');
  const content = element('div', undefined, 'step-content');
  detail.append(stepTitle, tabs, content);
  split.append(tree, detail);

  let selectedButton;
  let selectedRun;
  let selectedTab;
  const tabButtons = new Map();
  function display(tab) {
    selectedTab = tab;
    for (const [name, button] of tabButtons) button.setAttribute('aria-pressed', String(name === tab));
    const run = selectedRun;
    if (tab === 'Details') {
      const details = element('dl', undefined, 'run-facts');
      const items = [
        ['Type', run.type ?? (run === trace ? 'trace' : 'run')],
        ['Duration', typeof run.duration === 'number' ? latency(run.duration) : '—'],
        ['Tokens', typeof run.tokens === 'number' ? number.format(run.tokens) : '—'],
        ['Started', run.at ? new Date(run.at).toLocaleString() : '—'],
        ['ID', run.id ?? '—']
      ];
      if (run.model) items.splice(1, 0, ['Model', run.model]);
      if (run.key_id && typeof run.cost_nanos === 'number') {
        items.push(['API Key ID', run.key_id], ['Charge', billingMoney(run.cost_nanos)]);
      }
      for (const [key, value] of items) details.append(element('dt', key), element('dd', value));
      content.replaceChildren(details);
    } else {
      const value = tab === 'Error' ? run.error : run[tab.toLowerCase()];
      content.replaceChildren(value === undefined
        ? element('p', 'No ' + tab.toLowerCase() + ' recorded.')
        : element('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
    }
  }

  function select(run, button) {
    selectedButton?.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    selectedButton = button;
    selectedRun = run;
    stepTitle.textContent = run === trace ? 'Trace overview' : run.name;
    const available = ['Input', 'Output', ...(run.error != null ? ['Error'] : []), 'Details'];
    tabButtons.clear();
    tabs.replaceChildren(...available.map(tab => {
      const toggle = element('button', tab, 'trace-tab');
      toggle.addEventListener('click', () => display(tab));
      tabButtons.set(tab, toggle);
      return toggle;
    }));
    display(run.error != null ? 'Error' : available.includes(selectedTab) && selectedTab !== 'Error'
      ? selectedTab : run.output !== undefined ? 'Output' : 'Input');
  }

  function addRun(run, depth) {
    const button = element('button', undefined, 'step-row');
    button.style.setProperty('--depth', Math.min(depth, 8));
    const name = element('span', run === trace ? 'Trace overview' : run.name, 'step-name');
    const status = element('i', undefined, 'step-dot ' + runStatus(run));
    status.setAttribute('aria-hidden', 'true');
    const time = typeof run.duration === 'number' ? latency(run.duration) : '—';
    button.append(status, name, element('span', time, 'step-time'));
    button.addEventListener('click', () => select(run, button));
    list.append(button);
    if (run === trace) select(run, button);
    if (Array.isArray(run.steps)) {
      for (const step of run.steps) if (step && typeof step.name === 'string') addRun(step, depth + 1);
    }
  }

  addRun(trace, 0);
  byId('trace-title').textContent = trace.name;
  byId('trace-body').replaceChildren(summary, split);
  if (!inspector.open) inspector.showModal();
  if (linked) inspector.dataset.fromLink = 'true';
}

byId('trace-inspector').addEventListener('close', event => {
  if (!event.currentTarget.dataset.fromLink) return;
  delete event.currentTarget.dataset.fromLink;
  const url = new URL(location.href);
  url.searchParams.delete('trace');
  history.replaceState(null, '', url);
});

function closeWorkspaceMenu() {
  document.querySelector('.sidebar').classList.remove('menu-open');
  byId('menu-toggle').setAttribute('aria-expanded', 'false');
}

byId('menu-toggle').addEventListener('click', () => {
  const expanded = document.querySelector('.sidebar').classList.toggle('menu-open');
  byId('menu-toggle').setAttribute('aria-expanded', String(expanded));
});

function renderChart(scope) {
  const days = Array.from({length: 14}, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - 13 + index);
    return {date, success: 0, error: 0};
  });
  const lookup = new Map(days.map(day => [day.date.toDateString(), day]));
  for (const trace of scope) {
    const day = lookup.get(new Date(trace.at).toDateString());
    if (day) day[trace.status]++;
  }
  const max = Math.max(4, Math.ceil(Math.max(...days.map(day => day.success + day.error)) / 4) * 4);
  byId('axis').replaceChildren(...[1, .75, .5, .25, 0].map(part => element('span', max * part)));
  byId('bars').replaceChildren(...days.map(day => {
    const column = element('div', undefined, 'day');
    const label = day.date.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
    const stack = element('div', undefined, 'stack');
    stack.setAttribute('role', 'img');
    stack.setAttribute('aria-label', label + ': ' + day.success + ' successful, ' + day.error + ' errors');
    column.title = stack.getAttribute('aria-label');
    for (const count of [day.error, day.success]) {
      const bar = element('i');
      bar.style.height = (100 * count / max) + '%';
      stack.append(bar);
    }
    column.append(stack, element('span', label));
    return column;
  }));
}

function updateTraceProjects() {
  const projects = new Map(traces.map(trace => [traceScope(trace), traceScope(trace)]));
  if (scopedAgent) projects.set(scopedAgent.identifier, scopedAgent.name);
  const selected = byId('project').value;
  byId('project').replaceChildren(new Option('All agents and projects', ''),
    ...[...projects].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => new Option(label, value)));
  byId('project').value = projects.has(selected) ? selected : '';
}

function render() {
  const project = byId('project').value;
  const environment = byId('environment').value;
  const scope = traces.filter(trace =>
    (!project || traceScope(trace) === project) && (!environment || trace.environment === environment));
  const durations = scope.map(trace => trace.duration).sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * .95) - 1];
  const ratio = scope.length ? 100 * scope.filter(trace => trace.status === 'error').length / scope.length : 0;
  const metrics = [
    ['Total traces', number.format(scope.length)],
    ['Error rate', ratio.toFixed(1) + '%'],
    ['P95 latency', p95 === undefined ? '—' : latency(p95)],
    ['Total cost', money(scope.reduce((sum, trace) => sum + trace.cost, 0))]
  ];
  byId('metrics').replaceChildren(...metrics.map(([label, value]) => {
    const card = element('div', undefined, 'metric');
    card.append(element('span', label), element('strong', value));
    return card;
  }));
  renderChart(scope);
  const query = byId('search').value.trim().toLowerCase();
  const status = byId('status').value;
  const filtered = scope.filter(trace =>
    (!status || trace.status === status) &&
    (!query || [trace.name, trace.project, trace.id, JSON.stringify(trace.input), JSON.stringify(trace.error)]
      .some(value => value?.toLowerCase().includes(query)))
  );
  const limit = view === 'overview' ? 8 : filtered.length;
  byId('count').textContent = number.format(Math.min(limit, filtered.length)) + ' of ' + number.format(filtered.length) +
    (traces === demo ? ' demo runs' : ' runs');
  const rows = filtered.slice(0, limit).map(trace => {
    const row = element('tr');
    const open = element('button', trace.name, 'trace');
    open.addEventListener('click', () => showTrace(trace));
    const values = [open, traceScope(trace), trace.environment ?? '—', element('span', trace.status, 'pill ' + trace.status),
      latency(trace.duration), number.format(trace.tokens), typeof trace.cost_nanos === 'number' ? billingMoney(trace.cost_nanos) : money(trace.cost),
      new Date(trace.at).toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})];
    for (const value of values) {
      const cell = element('td');
      cell.append(value);
      row.append(cell);
    }
    return row;
  });
  if (!rows.length) {
    const row = element('tr');
    const cell = element('td', 'No matching traces', 'empty');
    cell.colSpan = 8;
    row.append(cell);
    rows.push(row);
  }
  byId('rows').replaceChildren(...rows);
}

const traceScope = trace => trace.agent_id ?? trace.project;

async function refresh() {
  try {
    const response = await fetch('/api/traces', {cache: 'no-store'});
    if (!response.ok) throw new Error('Trace API unavailable');
    const saved = await response.json();
    traces = saved.length ? saved : demo;
    tracesReady = true;
    updateTraceProjects();
    byId('notice').textContent = '';
    render();
    document.dispatchEvent(new Event('tracesupdated'));
    return true;
  } catch {
    byId('notice').textContent = 'Could not refresh traces. The last available data is displayed.';
  }
}

document.querySelectorAll('.nav[data-view]').forEach(button => button.addEventListener('click', () => {
  closeWorkspaceMenu();
  activeModule = null;
  byId('platform-content').hidden = true;
  byId('tracing-content').hidden = false;
  view = button.dataset.view;
  document.querySelectorAll('.nav').forEach(item => {
    item.classList.toggle('active', item === button);
    if (item === button) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  const overview = view === 'overview';
  byId('overview').hidden = !overview;
  byId('crumb').textContent = overview ? 'Dashboards' : 'Traces';
  byId('title').textContent = overview ? 'Observability' : 'Traces';
  byId('description').textContent = overview ? 'Monitor performance and debug your agent runs.' : 'Search runs and inspect execution steps.';
  document.querySelector('.table-panel h2').textContent = overview ? 'Recent traces' : 'Trace explorer';
  render();
  refresh();
}));

function openAgentTraces(agent) {
  scopedAgent = agent;
  updateTraceProjects();
  byId('project').value = agent.identifier;
  for (const id of ['search', 'status', 'environment']) byId(id).value = '';
  document.querySelector('.nav[data-view="traces"]').click();
}

for (const id of ['project', 'environment', 'status', 'search']) byId(id).addEventListener('input', render);

function startTraceMonitoring() {
  render();
  refresh().then(loaded => {
    const id = new URL(location.href).searchParams.get('trace');
    if (!id || !loaded) return;
    document.querySelector('.nav[data-view="traces"]').click();
    const trace = traces.find(item => item.id === id);
    if (trace) showTrace(trace, true);
    else byId('notice').textContent = 'This trace is unavailable in your workspace.';
  });
  setInterval(() => {
    if (!byId('tracing-content').hidden && !byId('trace-inspector').open && !document.hidden) refresh();
  }, 5000);
}
