const platformContent = byId('platform-content');
const modules = {
  models: ['Models', 'Connect and test an OpenAI-compatible model for your agents.'],
  datasets: ['Datasets', 'Curate examples and reference outputs for evaluation.'],
  experiments: ['Experiments', 'Evaluate prompt versions against a dataset and compare scores.'],
  feedback: ['Review Queue', 'Score ingested traces and record reviewer feedback.'],
  prompts: ['Prompts', 'Save and reuse prompt template versions.'],
  playground: ['Playground', 'Test prompt versions with sample inputs.'],
  deployments: ['Deployments', 'Pin a prompt version to a local execution target.'],
  agents: ['All agents', 'Build an agent in Studio or connect one that runs in your application.'],
  studio: ['Studio', 'Run a local agent or deployment and inspect its trace.']
};
let activeModule;
let records = [];

const ofKind = kind => records.filter(record => record.kind === kind);
const recordName = id => records.find(record => record.id === id)?.name ?? id;
const promptOptions = () => ofKind('prompt').map(record => {
  const history = ofKind('prompt').filter(item => item.name === record.name);
  return [record.id, record.name + ' · v' + (history.length - history.indexOf(record))];
});

async function platformRequest(path = '', data) {
  const response = await fetch('/api/platform' + path, data === undefined ? {cache:'no-store'} : {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
}

function field(name, label, type = 'text', value = '') {
  const wrapper = element('label', label);
  let input;
  if (Array.isArray(type)) {
    input = element('select');
    input.append(new Option(type.length ? 'Select…' : 'No available options', ''));
    for (const [id, text] of type) input.append(new Option(text, id));
  } else {
    input = element(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.value = value;
  }
  input.name = name;
  input.required = true;
  wrapper.append(input);
  return wrapper;
}

function formPanel(title, fields, label, action) {
  const section = element('section', undefined, 'panel module-panel');
  const form = element('form', undefined, 'module-form');
  const submit = element('button', label, 'button primary');
  const message = element('p');
  message.setAttribute('role', 'status');
  form.append(...fields, submit, message);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    message.textContent = '';
    try {
      await action(Object.fromEntries(new FormData(form)), section);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  section.append(element('h2', title), form);
  return section;
}

function listPanel(title, entries) {
  const section = element('section', undefined, 'panel module-panel');
  section.append(element('h2', title), ...(entries.length ? entries : [element('p', 'No records yet.')]));
  return section;
}

function expandable(label, data) {
  const item = element('details');
  item.append(element('summary', label), element('pre', JSON.stringify(data, null, 2)));
  return item;
}

function jsonInput(value) {
  try { return JSON.parse(value); }
  catch { throw new Error('Enter valid JSON. Use double quotes for a string.'); }
}

async function create(module, data) {
  await platformRequest('/' + module, data);
  await loadModule(module === 'examples' ? 'datasets' : module);
}

function renderModule(module, selectedTarget) {
  const [title, description] = modules[module];
  const heading = element('div', undefined, 'module-heading');
  heading.append(element('h1', title), element('p', description));
  const panels = [];
  const nameField = () => field('name', 'Name');
  const options = kind => ofKind(kind).map(item => [item.id, item.name]);
  const promptField = () => field('prompt', 'Prompt version', promptOptions());
  const inputField = () => field('input', 'Input JSON', 'textarea', '{"input":"Hello"}');

  if (module === 'models') {
    const keyField = field('api_key', 'API key (optional)', 'password');
    const keyInput = keyField.querySelector('input');
    keyInput.required = false;
    keyInput.autocomplete = 'off';
    const urlField = field('url', 'Chat Completions URL', 'url');
    urlField.querySelector('input').placeholder = 'https://api.example.com/v1/chat/completions';
    panels.push(formPanel('Connect a model', [
      nameField(), urlField, field('model', 'Model ID'), keyField
    ], 'Save model', data => create(module, data)));
    if (ofKind('model').length) {
      panels.push(formPanel('Test connection', [
        field('provider', 'Model', options('model')), field('message', 'Message', 'textarea', 'Reply with OK.')
      ], 'Test model', async (data, section) => {
        section.querySelector('.module-result')?.remove();
        const result = await platformRequest('/model-test', data);
        section.append(element('pre', result.output, 'module-result'));
      }));
    }
    panels.push(listPanel('Connected models', ofKind('model').map(record =>
      expandable(record.name + ' · ' + record.model, {
        endpoint:record.url, credential:record.has_api_key ? 'API key saved' : 'No API key'
      }))));
  }

  if (module === 'datasets') {
    panels.push(formPanel('Create dataset', [nameField()], 'Create dataset', data => create(module, data)));
    if (ofKind('dataset').length) panels.push(formPanel('Add example', [
      field('dataset', 'Dataset', options('dataset')), inputField(),
      field('expected', 'Reference output JSON', 'textarea', '"Hello"')
    ], 'Add example', data => create('examples', {...data, input:jsonInput(data.input), expected:jsonInput(data.expected)})));
    panels.push(listPanel('Datasets', ofKind('dataset').map(dataset => {
      const examples = ofKind('example').filter(item => item.dataset === dataset.id);
      return expandable(dataset.name + ' · ' + examples.length + ' examples',
        examples.map(({input, expected}) => ({input, expected})));
    })));
  }

  if (module === 'prompts') {
    panels.push(formPanel('Save prompt version', [
      nameField(), field('template', 'Template', 'textarea', '{{input}}')
    ], 'Save version', data => create(module, data)));
    panels.push(listPanel('Saved versions', promptOptions().map(([id, label]) =>
      expandable(label, records.find(item => item.id === id).template))));
  }

  if (module === 'experiments') {
    panels.push(formPanel('Run exact-match evaluation', [
      nameField(), field('dataset', 'Dataset', options('dataset')), promptField()
    ], 'Run experiment', data => create(module, data)));
    panels.push(listPanel('Experiment results', ofKind('experiment').map(record => {
      const passed = record.results.filter(result => result.passed).length;
      return expandable(record.name + ' · ' + recordName(record.dataset) + ' · ' + passed + '/' + record.results.length,
        record.results);
    })));
  }

  if (module === 'feedback') {
    const available = traces.filter(trace => !trace.id.startsWith('demo-'));
    panels.push(formPanel('Record feedback', [
      field('trace', 'Trace', available.map(trace => [trace.id, trace.name + ' · ' + trace.project + ' · ' + trace.id.slice(0, 8)])),
      field('score', 'Score', [['1', 'Pass'], ['0', 'Fail']]), field('comment', 'Comment', 'textarea')
    ], 'Save feedback', data => create(module, {...data, score:Number(data.score)})));
    panels.push(listPanel('Reviewed traces', ofKind('feedback').map(record =>
      expandable((record.score ? 'Pass' : 'Fail') + ' · ' + record.trace.slice(0, 8), record.comment))));
  }

  if (module === 'playground') {
    panels.push(formPanel('Run prompt', [promptField(), inputField()], 'Run', async (data, section) => {
      const result = await platformRequest('/playground', {...data, input:jsonInput(data.input)});
      section.querySelector('.module-result')?.remove();
      section.append(element('pre', result.output, 'module-result'));
    }));
  }

  if (module === 'deployments') {
    panels.push(formPanel('Register deployment', [nameField(), promptField()], 'Register',
      data => create(module, data)));
    panels.push(listPanel(title, ofKind('deployment').map(record =>
      expandable(record.name, {prompt: promptOptions().find(([id]) => id === record.prompt)?.[1], id:record.id}))));
  }

  if (module === 'agents') {
    if (ofKind('model').length) {
      panels.push(formPanel('Build in Studio', [
        nameField(), field('provider', 'Model', options('model')),
        field('instructions', 'Agent instructions', 'textarea')
      ], 'Create agent', async data => {
        const agent = await platformRequest('/agents', {...data, source:'studio'});
        if (!platformContent.hidden && activeModule === 'agents') await loadModule('studio', agent.id);
      }));
    } else {
      const connect = element('button', 'Connect a model', 'button primary module-result');
      connect.addEventListener('click', () => loadModule('models'));
      const section = element('section', undefined, 'panel module-panel');
      section.append(element('h2', 'Build in Studio'), element('p', 'Connect a model to create your first Studio agent.'), connect);
      panels.push(section);
    }
    panels.push(formPanel('Connect an external agent', [nameField()], 'Create external agent',
      data => create(module, {...data, source:'external'})));
    gridEntries(panelForAgents());
  }

  function gridEntries(panel) {
    panel.classList.add('wide');
    panels.push(panel);
  }

  function panelForAgents() {
    return listPanel('Agent registry', ofKind('agent').map(agent => {
      const item = element('details');
      item.append(element('summary', agent.name + ' · ' + (agent.source === 'external' ? 'External' : 'Studio')));
      if (agent.provider) item.append(element('p', 'Model · ' + recordName(agent.provider)));
      if (agent.identifier) {
        item.append(element('p', 'Identifier · ' + agent.identifier));
        const example = {
          agent_id:agent.identifier, environment:'local', name:'handle_request',
          input:{message:'Hello'}, output:{message:'Hi'}
        };
        item.append(element('p', 'POST /api/traces'), element('pre', JSON.stringify(example, null, 2)));
        if (location.protocol === 'https:') {
          const reveal = element('button', 'Show ingestion token', 'button');
          const token = element('pre');
          token.hidden = true;
          reveal.addEventListener('click', async () => {
            reveal.disabled = true;
            try {
              const response = await fetch('/api/workspace', {cache:'no-store'});
              const config = await response.json();
              if (!response.ok) throw new Error(config.error);
              token.textContent = 'Authorization: Bearer ' + config.ingest_token;
            } catch (error) {
              token.textContent = error.message;
            } finally {
              token.hidden = false;
              reveal.disabled = false;
            }
          });
          item.append(reveal, token);
        }
      }
      if (agent.source !== 'external') {
        const open = element('button', 'Open in Studio', 'button');
        open.addEventListener('click', () => loadModule('studio', agent.id));
        item.append(open);
      }
      return item;
    }));
  }

  if (module === 'studio') {
    const targets = records.filter(record =>
      record.kind === 'deployment' || (record.kind === 'agent' && record.source !== 'external'));
    const targetField = field('target', 'Target', targets.map(record => [record.id, record.name + ' · ' + record.kind]));
    if (selectedTarget) targetField.querySelector('select').value = selectedTarget;
    const messageField = field('input', 'Message or input JSON', 'textarea', 'Hello');
    panels.push(formPanel('Run local target', [
      targetField, messageField
    ], 'Run in Studio', async (data, section) => {
      const target = targets.find(record => record.id === data.target);
      const input = target.instructions ? data.input : jsonInput(data.input);
      const trace = await platformRequest('/runs', {...data, target_kind:target.kind, input});
      section.querySelector('.module-result')?.remove();
      const inspect = element('button', 'Inspect trace', 'button module-result');
      inspect.addEventListener('click', () => showTrace(trace));
      section.append(inspect);
      showTrace(trace);
      await refresh();
    }));
  }

  const grid = element('div', undefined, 'module-grid');
  grid.append(...panels);
  platformContent.replaceChildren(heading, grid);
}

async function loadModule(module, selectedTarget) {
  activeModule = module;
  byId('tracing-content').hidden = true;
  platformContent.hidden = false;
  byId('crumb').textContent = modules[module][0];
  platformContent.replaceChildren(element('p', 'Loading…'));
  document.querySelectorAll('.nav').forEach(button => {
    button.classList.toggle('active', button.dataset.module === module);
    if (button.dataset.module === module) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  try {
    const next = await platformRequest();
    if (activeModule !== module || platformContent.hidden) return;
    records = next;
    renderModule(module, selectedTarget);
  } catch (error) {
    if (activeModule === module) platformContent.replaceChildren(element('p', error.message));
  }
}

document.querySelectorAll('[data-module]').forEach(button => {
  button.addEventListener('click', () => loadModule(button.dataset.module));
});

byId('connect').addEventListener('click', () => loadModule('agents'));

loadModule('agents');
