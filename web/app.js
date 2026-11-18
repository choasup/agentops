const byId = id => document.getElementById(id);
const number = new Intl.NumberFormat();
let traces = [];
let view = 'overview';
let scopedAgent;
let tracesReady = false;
let traceMode = 'sessions';
let openSession;
const money = amount => '$' + amount.toFixed(4);
const latency = duration => (duration / 1000).toFixed(2) + ' s';

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('class', 'ui-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(namespace, 'use');
  use.setAttribute('href', 'icons.svg#' + name);
  svg.append(use);
  return svg;
}

function iconButton(name, label, className = 'button') {
  const button = element('button', undefined, className);
  button.append(icon(name), element('span', label));
  return button;
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

function deliveryLabel(trace) {
  return {replied:'WeCom confirmed reply', fallback_replied:'WeCom confirmed fallback',
    reply_failed:'WeCom reply failed'}[trace.delivery] ??
    (trace.session_id && trace.channel === 'wecom' ? 'WeCom delivery unconfirmed' : '');
}

function showTrace(trace, linked = false) {
  const inspector = byId('trace-inspector');
  const metadata = element('div', undefined, 'trace-meta');
  metadata.append(statusPill(runStatus(trace)), element('span', latency(trace.duration), 'pill'),
    element('span', number.format(trace.tokens) + ' tokens', 'pill'));
  if (trace.channel === 'wecom') metadata.append(element('span', 'WeCom', 'pill'));
  if (deliveryLabel(trace)) metadata.append(element('span', deliveryLabel(trace), 'pill'));
  if (trace.environment) metadata.append(element('span', trace.environment, 'pill'));
  if (typeof trace.cost_nanos === 'number') metadata.append(element('span', billingMoney(trace.cost_nanos), 'pill'));

  const summary = element('div', undefined, 'inspector-summary');
  const identity = element('div');
  identity.append(metadata, element('p', traceScope(trace) + ' · ' + trace.id, 'trace-id'));
  const link = iconButton('copy', 'Copy link');
  const shareUrl = new URL('/', location.origin);
  shareUrl.searchParams.set('trace', trace.id);
  link.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl.href);
      link.querySelector('span').textContent = 'Copied';
    } catch {
      const field = element('input');
      field.readOnly = true;
      field.value = shareUrl.href;
      field.setAttribute('aria-label', 'Trace link');
      link.replaceWith(field);
      field.select();
    }
  });
  const actions = element('div', undefined, 'trace-mode');
  const addExample = iconButton('plus', 'Add to dataset');
  addExample.disabled = typeof trace.input !== 'string' || !trace.input.trim();
  addExample.addEventListener('click', () => addTraceExample(trace));
  actions.append(addExample, link);
  summary.append(identity, actions);

  const split = element('div', undefined, 'inspector-split');
  const detail = element('section', undefined, 'step-detail');
  const tree = element('nav', undefined, 'step-tree');
  tree.setAttribute('aria-label', 'Trace steps');
  const list = element('div');
  tree.append(element('h3', 'Execution steps', 'inspector-label'), list);
  split.append(detail, tree);
  let selectedButton;

  function contentSection(label, value, className) {
    const section = element('section', undefined, 'trace-payload-section ' + (className ?? ''));
    section.append(element('h4', label));
    if (value === undefined) section.append(element('p', 'Not recorded', 'step-time'));
    else if (typeof value === 'string') section.append(element('p', value, 'trace-text'));
    else section.append(element('pre', JSON.stringify(value, null, 2)));
    return section;
  }

  function select(run, button) {
    selectedButton?.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    selectedButton = button;
    const title = element('header', undefined, 'trace-step-heading');
    title.append(element('h3', run === trace ? 'Run overview' : run.name), statusPill(runStatus(run)));
    const facts = element('dl', undefined, 'run-facts');
    const values = [
      ['Type', run.type ?? (run === trace ? 'trace' : 'run')],
      ['Model', run.model],
      ['Duration', typeof run.duration === 'number' ? latency(run.duration) : undefined],
      ['Tokens', typeof run.tokens === 'number' ? number.format(run.tokens) : undefined],
      ['Started', run.at ? new Date(run.at).toLocaleString() : undefined],
      ['ID', run.id],
      ['Connection ID', run.connection_id],
      ['Access', run.type === 'tool' && run.connection_id ? 'Read-only' : undefined],
      ['Resource scope', run.connection_scope],
      ['Skill ID', run.skill_id],
      ['Version ID', run.agent_version],
      ['API Key ID', run.key_id],
      ['Charge', typeof run.cost_nanos === 'number' ? billingMoney(run.cost_nanos) : undefined]
    ];
    for (const [label, value] of values) {
      if (value != null) facts.append(element('dt', label), element('dd', value));
    }
    const metadata = element('details', undefined, 'trace-step-facts');
    metadata.append(element('summary', 'Run details'), facts);
    const payloads = element('div', undefined, 'trace-payloads');
    payloads.append(contentSection('Input', run.input), contentSection('Output', run.output));
    detail.replaceChildren(title, ...(run.error != null ? [contentSection('Error', run.error, 'trace-error')] : []),
      payloads, metadata);
  }

  function addRun(run, depth) {
    const button = element('button', undefined, 'step-row');
    button.style.setProperty('--depth', Math.min(depth, 5));
    const name = element('span', run === trace ? 'Run overview' : run.name, 'step-name');
    const state = runStatus(run);
    const status = element('span', undefined, 'step-state ' + state);
    status.append(icon(state === 'error' ? 'error' : state === 'success' ? 'check' : 'traces'),
      element('span', state === 'error' ? 'Error' : state === 'success' ? 'Success' : 'Recorded', 'sr'));
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
    if (day && ['error','success'].includes(trace.status)) day[trace.status]++;
  }
  const hasActivity = days.some(day => day.success + day.error > 0);
  byId('trace-graph').hidden = !hasActivity;
  byId('trace-chart-empty').hidden = hasActivity;
  if (!hasActivity) return;
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

const sessionDate = new Intl.DateTimeFormat(undefined, {
  month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
});
const turnTime = new Intl.DateTimeFormat(undefined, {hour:'2-digit', minute:'2-digit', second:'2-digit'});

function sessionTurns(turns) {
  const wrap = element('div', undefined, 'table-wrap session-turn-table');
  const table = element('table');
  table.setAttribute('aria-label', 'Session turns');
  const headers = table.createTHead().insertRow();
  for (const label of ['Time', 'Input', 'Response', 'Status', 'Usage']) {
    const cell = element('th', label);
    cell.scope = 'col';
    headers.append(cell);
  }
  const body = table.createTBody();
  function preview(value) {
    return element('span', typeof value === 'string' ? value : value == null ? '—' : JSON.stringify(value),
      'session-turn-preview');
  }
  for (const trace of [...turns].reverse()) {
    const row = body.insertRow();
    const time = element('time', turnTime.format(new Date(trace.at)));
    time.dateTime = trace.at;
    time.title = new Date(trace.at).toLocaleString();
    row.insertCell().append(time);
    const input = preview(trace.input);
    const open = traceLink(trace.id, '');
    open.className = 'session-turn-link';
    open.append(input, element('span', ' (view trace at ' + time.textContent + ')', 'sr'));
    open.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      showTrace(trace);
    });
    row.insertCell().append(open);
    row.insertCell().append(preview(trace.error ?? trace.output));
    const status = row.insertCell();
    status.append(statusPill(runStatus(trace)));
    const delivery = deliveryLabel(trace);
    if (delivery) {
      const short = {replied:'Delivered', fallback_replied:'Fallback sent', reply_failed:'Delivery failed'};
      const label = element('small', short[trace.delivery] ?? 'Unconfirmed', 'session-delivery');
      label.title = delivery;
      status.append(label);
    }
    const usage = row.insertCell();
    usage.append(element('span', latency(trace.duration) + ' · ' + number.format(trace.tokens) + ' tokens'),
      element('small', typeof trace.cost_nanos === 'number' ? billingMoney(trace.cost_nanos) : money(trace.cost)));
  }
  wrap.append(table);
  return wrap;
}

function renderSessions(scope, matches) {
  const sessions = new Map();
  const matching = new Set(matches.map(trace => trace.session_id).filter(Boolean));
  for (const trace of scope) {
    if (!matching.has(trace.session_id)) continue;
    if (!sessions.has(trace.session_id)) sessions.set(trace.session_id, []);
    sessions.get(trace.session_id).push(trace);
  }
  byId('count').textContent = sessions.size + (sessions.size === 1 ? ' session' : ' sessions');
  const list = byId('trace-session-list');
  const notice = element('p', 'Runs without a session are available in Runs.', 'empty');
  if (!sessions.size) {
    list.replaceChildren(element('p', 'No matching sessions.', 'empty'), notice);
    return;
  }
  if (openSession === undefined && sessions.size === 1) openSession = sessions.keys().next().value;
  list.replaceChildren(...[...sessions].map(([id, turns]) => {
    const latest = turns[0];
    const section = element('details', undefined, 'trace-session');
    const heading = element('summary');
    const preview = typeof latest.input === 'string' ? latest.input.trim() : '';
    const identity = element('span', undefined, 'session-identity');
    identity.append(element('strong', latest.name), ...(preview ? [element('span', preview)] : []));
    const context = element('span', [latest.channel === 'wecom' ? 'WeCom' : latest.channel,
      latest.environment].filter(Boolean).join(' · '), 'session-context');
    const errors = turns.filter(trace => runStatus(trace) === 'error' || trace.delivery === 'reply_failed').length;
    const count = element('span', turns.length + (turns.length === 1 ? ' turn' : ' turns'), 'session-count');
    if (errors) count.append(element('span', errors + (errors === 1 ? ' issue' : ' issues'), 'pill error'));
    const date = element('time', sessionDate.format(new Date(latest.at)));
    date.dateTime = latest.at;
    heading.append(identity, context, count, date);
    section.open = openSession === id;
    heading.addEventListener('click', () => {openSession = section.open ? null : id;});
    section.name = 'trace-session';
    section.append(heading);
    const renderTurns = () => {
      if (section.open && section.childElementCount === 1) section.append(sessionTurns(turns));
    };
    section.addEventListener('toggle', renderTurns);
    renderTurns();
    return section;
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
    ['Error rate', scope.length ? ratio.toFixed(1) + '%' : '—'],
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
    (!query || [trace.name, trace.project, trace.id, trace.channel, trace.session_id, JSON.stringify(trace.input), JSON.stringify(trace.error)]
      .some(value => value?.toLowerCase().includes(query)))
  );
  const sessions = view === 'traces' && traceMode === 'sessions';
  byId('trace-mode').hidden = view !== 'traces';
  byId('trace-session-list').hidden = !sessions;
  byId('trace-run-list').hidden = sessions;
  if (sessions) {
    renderSessions(scope, filtered);
    return;
  }
  const limit = view === 'overview' ? 8 : filtered.length;
  byId('count').textContent = number.format(Math.min(limit, filtered.length)) + ' of ' + number.format(filtered.length) + ' runs';
  const rows = filtered.slice(0, limit).map(trace => {
    const row = element('tr');
    const open = element('button', trace.name, 'trace');
    open.addEventListener('click', () => showTrace(trace));
    const identity = element('div', undefined, 'trace-row-identity');
    identity.append(open);
    if (typeof trace.input === 'string' && trace.input.trim()) {
      identity.append(element('small', trace.input.trim().slice(0, 140), 'trace-input-preview'));
    }
    if (trace.channel === 'wecom') identity.append(element('span', 'WeCom', 'pill'));
    const values = [identity, traceScope(trace), trace.environment ?? '—', element('span', trace.status, 'pill ' + trace.status),
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
    const cell = element('td', traces.length ? 'No matching traces' : 'No traces yet. Run an agent in Studio or send a trace through the API.', 'empty');
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
    if (tracesReady && saved.length === traces.length && saved.every((item, index) => item.id === traces[index].id && item.delivery === traces[index].delivery)) {
      byId('notice').textContent = '';
      return true;
    }
    traces = saved;
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

let workspaceArea = 'home';

function showWorkspaceArea(area) {
  workspaceArea = area;
  byId('workspace-area').textContent = area === 'home' ? 'Home' : 'Console';
  document.querySelectorAll('[data-area-nav]').forEach(group => {
    group.hidden = group.dataset.areaNav !== area;
  });
  document.querySelectorAll('[data-area-switch]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.areaSwitch === area));
  });
}

document.querySelectorAll('[data-area-switch]').forEach(button => button.addEventListener('click', () => {
  const area = button.dataset.areaSwitch;
  if (area === workspaceArea) return;
  if (area === 'home') loadModule('agents');
  else document.querySelector('.nav[data-view="overview"]').click();
}));

function openConsoleTrace(trace) {
  if (workspaceArea === 'home') document.querySelector('.nav[data-view="traces"]').click();
  showTrace(trace);
}

document.querySelectorAll('.nav[data-view]').forEach(button => button.addEventListener('click', () => {
  showWorkspaceArea('console');
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
  byId('description').textContent = overview ? 'Monitor performance and debug your agent runs.' : '';
  document.querySelector('.table-panel h2').textContent = overview ? 'Recent traces' : 'Trace explorer';
  render();
  refresh();
}));

function openAgentTraces(agent) {
  scopedAgent = agent;
  updateTraceProjects();
  byId('project').value = agent.identifier;
  for (const id of ['search', 'status', 'environment']) byId(id).value = '';
  for (const id of ['project', 'status', 'environment']) syncSelect(byId(id));
  document.querySelector('.nav[data-view="traces"]').click();
}

for (const id of ['project', 'environment', 'status', 'search']) byId(id).addEventListener('input', render);

for (const mode of ['sessions', 'runs']) {
  byId('trace-' + mode).addEventListener('click', () => {
    traceMode = mode;
    for (const option of ['sessions', 'runs']) {
      byId('trace-' + option).setAttribute('aria-pressed', String(option === traceMode));
    }
    render();
  });
}

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
