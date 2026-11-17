import { DurableObject } from 'cloudflare:workers';

const environments = ['local', 'development', 'staging', 'production'];
const noStore = {'Cache-Control': 'no-store'};
const json = (body, status = 200) => Response.json(body, {status, headers: noStore});
const id = () => crypto.randomUUID().replaceAll('-', '');

class InputError extends Error {}

function publicRecord(record) {
  const {api_key, ...visible} = record;
  return record.kind === 'model' ? {...visible, has_api_key:Boolean(api_key)} : visible;
}

function requiredText(data, key) {
  const value = data[key];
  if (typeof value !== 'string' || !value.trim()) throw new InputError(key + ' is required');
  return value.trim();
}

async function equal(left, right) {
  const encoder = new TextEncoder();
  const hashes = await Promise.all([left, right].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(hashes[0], hashes[1]);
}

export default {
  async fetch(request, env) {
    const {pathname, origin} = new URL(request.url);
    if (pathname === '/healthz' && request.method === 'GET') return json({status:'ok'});
    if (!env.AGENTOPS_PASSWORD) return json({error:'Workspace access has not been configured'}, 503);
    const authorization = request.headers.get('Authorization') ?? '';
    const ingestion = pathname === '/api/traces' && request.method === 'POST';
    const access = await equal(authorization, 'Basic ' + btoa('agentops:' + env.AGENTOPS_PASSWORD));
    const token = ingestion && env.AGENTOPS_INGEST_TOKEN &&
      await equal(authorization, 'Bearer ' + env.AGENTOPS_INGEST_TOKEN);
    if (!access && !token) {
      return new Response('Sign in to AgentOps', {
        status:401, headers:{...noStore, 'WWW-Authenticate':'Basic realm="AgentOps", charset="UTF-8"'}
      });
    }
    if (request.method === 'POST' && !token) {
      const source = request.headers.get('Origin');
      if ((source && source !== origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        return json({error:'Cross-origin write rejected'}, 403);
      }
    }
    if (pathname.startsWith('/api/')) return env.WORKSPACE.getByName('default').fetch(request);
    return env.ASSETS.fetch(request);
  }
};

export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT, payload TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS traces (payload TEXT NOT NULL)');
  }

  rows(table) {
    return this.sql.exec('SELECT payload FROM ' + table + ' ORDER BY rowid DESC')
      .toArray().map(({payload}) => JSON.parse(payload));
  }

  save(kind, fields) {
    const record = {...fields, kind, id:id(), at:new Date().toISOString()};
    this.sql.exec('INSERT INTO records VALUES (?, ?, ?)', record.id, kind, JSON.stringify(record));
    return record;
  }

  saveTrace(fields) {
    const trace = {...fields, id:id(), at:new Date().toISOString()};
    this.sql.exec('INSERT INTO traces VALUES (?)', JSON.stringify(trace));
    return trace;
  }

  ingest(data) {
    const trace = {project:'default', status:'success', duration:0, tokens:0, cost:0, steps:[], ...data};
    trace.name = requiredText(trace, 'name');
    trace.project = requiredText(trace, 'project');
    if ('agent_id' in trace || 'environment' in trace) {
      trace.environment = requiredText(trace, 'environment').toLowerCase();
      if (!environments.includes(trace.environment)) throw new InputError('Invalid environment');
      const agent = this.rows('records').find(record => record.kind === 'agent' && record.identifier &&
        record.identifier === trace.agent_id);
      if (!agent) throw new InputError('Agent identifier was not found');
      trace.project = 'agent:' + agent.identifier;
    }
    if (!['success', 'error'].includes(trace.status)) throw new InputError('Invalid status');
    for (const key of ['duration', 'tokens', 'cost']) {
      if (!Number.isFinite(trace[key]) || trace[key] < 0) throw new InputError('Invalid ' + key);
    }
    if (!Array.isArray(trace.steps) || trace.steps.some(step => typeof step?.name !== 'string')) {
      throw new InputError('steps must contain objects with names');
    }
    return this.saveTrace(trace);
  }

  async execute(prompt, value, instructions, provider) {
    let content = value;
    if (instructions) {
      if (typeof value !== 'string' || !value.trim()) throw new InputError('Enter a message');
    } else {
      const variables = value && typeof value === 'object' && !Array.isArray(value) ? value : {input:value};
      content = prompt.template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
        if (!Object.hasOwn(variables, key)) throw new InputError('Missing prompt variable: ' + key);
        return typeof variables[key] === 'string' ? variables[key] : JSON.stringify(variables[key]);
      });
    }
    const model = provider?.model ?? this.env.TRACE_STUDIO_MODEL;
    if (!model) {
      if (instructions) throw new InputError('Configure a model service before running this agent');
      return {output:content, tokens:0};
    }
    const endpoint = provider?.url ?? this.env.TRACE_STUDIO_MODEL_URL;
    if (!endpoint) throw new InputError('Model URL is missing');
    const messages = [{role:'user', content}];
    if (instructions) messages.unshift({role:'system', content:instructions});
    const headers = {'Content-Type':'application/json'};
    const apiKey = provider ? provider.api_key : this.env.TRACE_STUDIO_MODEL_KEY;
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    try {
      const response = await fetch(endpoint, {
        method:'POST', headers, body:JSON.stringify({model, messages}),
        signal:AbortSignal.timeout(30000), redirect:'error'
      });
      if (!response.ok) throw new InputError('Model service returned HTTP ' + response.status);
      const result = await response.json();
      const output = result.choices?.[0]?.message?.content;
      if (typeof output !== 'string') throw new Error();
      return {output, tokens:result.usage?.total_tokens ?? 0};
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('Could not read a response from the model service');
    }
  }

  async action(action, data) {
    const records = this.rows('records');
    const find = (key, kind) => {
      const identifier = requiredText(data, key);
      const record = records.find(item => item.kind === kind && item.id === identifier);
      if (!record) throw new InputError(kind + ' was not found');
      return record;
    };
    if (action === 'models') {
      const name = requiredText(data, 'name');
      const model = requiredText(data, 'model');
      let url;
      try { url = new URL(requiredText(data, 'url')); }
      catch { throw new InputError('Enter a valid HTTPS Chat Completions endpoint'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new InputError('Use an HTTPS endpoint without embedded credentials or a fragment');
      }
      const apiKey = typeof data.api_key === 'string' ? data.api_key.trim() : '';
      return publicRecord(this.save('model', {name, model, url:url.href, api_key:apiKey}));
    }
    if (action === 'model-test') {
      const provider = find('provider', 'model');
      return this.execute(null, requiredText(data, 'message'), 'Reply briefly.', provider);
    }
    if (action === 'datasets') return this.save('dataset', {name:requiredText(data, 'name')});
    if (action === 'examples') {
      const dataset = find('dataset', 'dataset');
      if (!('input' in data) || !('expected' in data)) throw new InputError('input and expected are required');
      return this.save('example', {dataset:dataset.id, input:data.input, expected:data.expected});
    }
    if (action === 'prompts') return this.save('prompt', {
      name:requiredText(data, 'name'), template:requiredText(data, 'template')
    });
    if (action === 'agents') {
      const name = requiredText(data, 'name');
      const source = data.source ?? 'studio';
      if (!['studio', 'external'].includes(source)) throw new InputError('Invalid agent source');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
      const agent = {name, source, identifier:slug + '-' + id().slice(0, 12)};
      if (source === 'studio') {
        agent.instructions = requiredText(data, 'instructions');
        if (data.provider) agent.provider = find('provider', 'model').id;
        else if (!this.env.TRACE_STUDIO_MODEL) throw new InputError('Choose a model before creating the agent');
      }
      return this.save('agent', agent);
    }
    if (action === 'deployments') return this.save('deployment', {
      name:requiredText(data, 'name'), prompt:find('prompt', 'prompt').id
    });
    if (action === 'feedback') {
      const trace = requiredText(data, 'trace');
      if (!this.rows('traces').some(item => item.id === trace)) throw new InputError('Trace was not found');
      if (![0, 1].includes(data.score)) throw new InputError('Invalid score');
      return this.save('feedback', {trace, score:data.score, comment:requiredText(data, 'comment')});
    }
    if (action === 'playground') return this.execute(find('prompt', 'prompt'), data.input);
    if (action === 'experiments') {
      const name = requiredText(data, 'name');
      const prompt = find('prompt', 'prompt');
      const dataset = find('dataset', 'dataset');
      const examples = records.filter(item => item.kind === 'example' && item.dataset === dataset.id).reverse();
      if (!examples.length) throw new InputError('Add at least one example to the dataset');
      const results = [];
      for (const {input, expected} of examples) {
        try {
          const {output} = await this.execute(prompt, input);
          results.push({input, expected, output, passed:output === expected});
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          results.push({input, expected, error:error.message, passed:false});
        }
      }
      return this.save('experiment', {name, dataset:dataset.id, prompt:prompt.id, results});
    }
    if (action === 'runs') {
      const kind = data.target_kind;
      if (!['agent', 'deployment'].includes(kind)) throw new InputError('Invalid target kind');
      const target = find('target', kind);
      if (target.source === 'external') throw new InputError('External agents run in your application');
      const prompt = records.find(item => item.id === target.prompt);
      const provider = records.find(item => item.kind === 'model' && item.id === target.provider);
      const model = target.instructions || this.env.TRACE_STUDIO_MODEL;
      const step = {name:model ? 'generate' : 'render_prompt', type:model ? 'llm' : 'template', input:data.input};
      const start = performance.now();
      let tokens = 0;
      try {
        const result = await this.execute(prompt, data.input, target.instructions, provider);
        step.output = result.output;
        tokens = result.tokens;
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        step.error = error.message;
      }
      step.duration = performance.now() - start;
      const trace = {...step, name:target.name, project:kind + ':' + target.name,
        status:step.error ? 'error' : 'success', tokens, cost:0, steps:[step]};
      if (target.identifier) Object.assign(trace, {
        agent_id:target.identifier, environment:'local', project:'agent:' + target.identifier
      });
      return this.saveTrace(trace);
    }
    throw new InputError('Unknown action');
  }

  async fetch(request) {
    const {pathname} = new URL(request.url);
    if (request.method === 'GET') {
      if (pathname === '/api/traces') return json(this.rows('traces'));
      if (pathname === '/api/platform') return json(this.rows('records').map(publicRecord));
    }
    if (request.method === 'POST') {
      try {
        const reader = request.body?.getReader();
        if (!reader) throw new InputError('Expected a JSON object');
        const decoder = new TextDecoder('utf-8', {fatal:true});
        let size = 0;
        let body = '';
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_000_000) {
            await reader.cancel();
            return json({error:'Request body exceeds 1 MB'}, 413);
          }
          body += decoder.decode(value, {stream:true});
        }
        const data = JSON.parse(body + decoder.decode());
        if (!data || Array.isArray(data) || typeof data !== 'object') throw new InputError('Expected a JSON object');
        if (pathname === '/api/traces') return json(this.ingest(data), 201);
        if (pathname.startsWith('/api/platform/')) return json(await this.action(pathname.slice(14), data), 201);
      } catch (error) {
        if (error instanceof InputError || error instanceof SyntaxError) return json({error:error.message}, 400);
        console.error('Workspace request failed', error.name);
        return json({error:'Workspace request failed'}, 500);
      }
    }
    return json({error:'Unknown endpoint'}, 404);
  }
}
