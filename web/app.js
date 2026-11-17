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

function showTrace(trace) {
  const metadata = element('div', undefined, 'trace-meta');
  metadata.append(
    element('span', trace.status === 'success' ? 'Success' : 'Error', 'pill ' + trace.status),
    element('span', latency(trace.duration), 'pill'),
    element('span', number.format(trace.tokens) + ' tokens', 'pill')
  );
  if (trace.environment) metadata.append(element('span', trace.environment, 'pill'));

  const steps = element('section', undefined, 'modal-section');
  steps.append(element('h2', 'Execution steps'));
  const tree = element('div', undefined, 'run-tree');
  function addSteps(container, runs) {
    for (const run of runs) {
      const item = element('details');
      const duration = typeof run.duration === 'number' ? latency(run.duration) : '';
      item.append(element('summary', [run.name, run.type, duration].filter(Boolean).join(' · ')));
      for (const key of ['input', 'output', 'error']) {
        if (key in run) item.append(payload(key.charAt(0).toUpperCase() + key.slice(1), run[key]));
      }
      if (Array.isArray(run.steps)) addSteps(item, run.steps.filter(step => step && typeof step.name === 'string'));
      container.append(item);
    }
  }
  addSteps(tree, trace.steps);
  if (trace.steps.length) steps.append(tree);
  else steps.append(element('p', 'No execution steps recorded.'));

  const children = [metadata, element('p', traceScope(trace) + ' · ' + trace.id, 'trace-id')];
  if (trace.error != null) children.push(payload('Error', trace.error));
  else if (trace.output != null) children.push(payload('Output', trace.output));
  children.push(payload('Input', trace.input), steps);
  byId('trace-title').textContent = trace.name;
  byId('trace-body').replaceChildren(...children);
  if (!byId('trace-inspector').open) byId('trace-inspector').showModal();
}

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
      latency(trace.duration), number.format(trace.tokens), money(trace.cost),
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
    const project = byId('project').value;
    const projects = [...new Set(traces.map(traceScope))].sort();
    byId('project').replaceChildren(new Option('All agents and projects', ''), ...projects.map(name => new Option(name, name)));
    byId('project').value = projects.includes(project) ? project : '';
    byId('notice').textContent = '';
    render();
  } catch {
    byId('notice').textContent = 'Could not refresh traces. The last available data is displayed.';
  }
}

document.querySelectorAll('.nav[data-view]').forEach(button => button.addEventListener('click', () => {
  closeWorkspaceMenu();
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
}));

for (const id of ['project', 'environment', 'status', 'search']) byId(id).addEventListener('input', render);

function startTraceMonitoring() {
  render();
  refresh();
  setInterval(() => {
    if (!byId('tracing-content').hidden && !document.hidden) refresh();
  }, 5000);
}
