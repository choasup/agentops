import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return {url:'data:text/javascript,export class DurableObject { constructor(context, env) { this.env = env } }', shortCircuit:true};
    }
    return next(specifier, context);
  }
});
const {default:worker, Workspace} = await import('../cloudflare/worker.mjs');

function workspaceStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql:{exec(query, ...args) {
      const statement = db.prepare(query);
      if (/^SELECT| RETURNING /i.test(query)) return {toArray:() => statement.all(...args)};
      statement.run(...args);
    }},
    transactionSync(callback) {
      db.exec('BEGIN');
      try {
        const value = callback();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

test('published Agent configuration is isolated by workspace and environment and can be rolled back', async t => {
  const workspace = 'a'.repeat(32);
  const otherWorkspace = 'b'.repeat(32);
  const origin = 'https://agentdeck.cloudmoro.com';
  const instances = new Map();
  const env = {
    REQUIRE_LOGIN:'true', DEEPSEEK_API_KEY:'fixture-provider-key', AGENTOPS_INGEST_TOKEN:'fixture-secret',
    ACCOUNTS:{getByName:() => ({fetch:request => {
      const session = request.headers.get('X-AgentOps-Session');
      const guest = request.headers.get('X-AgentOps-Guest');
      return Response.json(session ? {user:{email:'t***@example.test'},
        workspace:session === 'other-session' ? otherWorkspace : workspace} : {claimed:Boolean(guest)});
    }})},
    WORKSPACE:{getByName(name) {
      if (!instances.has(name)) instances.set(name, new Workspace({storage:workspaceStorage()}, env));
      return instances.get(name);
    }}
  };

  const modelCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fixture-provider-key');
    const body = JSON.parse(options.body);
    modelCalls.push(body);
    return Response.json({id:'fixture-completion', choices:[{message:{content:body.messages[0].content}}],
      usage:{prompt_tokens:20, completion_tokens:4, total_tokens:24}});
  });

  async function request(path, {data, token, session = 'workspace-session'} = {}) {
    const headers = {'Content-Type':'application/json'};
    if (token) headers.Authorization = 'Bearer ' + token;
    else headers.Cookie = '__Host-agentops-session=' + session;
    const response = await worker.fetch(new Request(origin + path, {headers,
      method:data ? 'POST' : 'GET', body:data ? JSON.stringify(data) : undefined}), env);
    return {status:response.status, data:await response.json()};
  }

  const action = (name, data, options) => request('/api/platform/' + name, {data, ...options});
  const create = async (name, data, options) => {
    const result = await action(name, data, options);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  };

  env.WORKSPACE.getByName('browser:' + workspace).billing.credit('test-credit:test-releases', 100);
  const key = (await request('/api/keys', {data:{name:'Agent runner', scopes:['agents:run','models:invoke']}})).data;
  const telemetryKey = (await request('/api/keys', {data:{name:'Telemetry only', scopes:['traces:write']}})).data;
  const profile = {name:'Support agent', provider:'hosted:deepseek'};
  const agent = await create('agents', {...profile, instructions:'Version one', max_tokens:80});
  const first = await create('agent-versions', {agent:agent.id,label:'v1'});
  const firstRelease = await create('agent-releases', {version:first.id,environment:'staging'});
  const duplicate = await create('agent-releases', {version:first.id,environment:'staging'});
  assert.equal(duplicate.id, firstRelease.id);
  await create('agent-update', {...profile, agent:agent.id, instructions:'Version two', max_tokens:40});
  const second = await create('agent-versions', {agent:agent.id,label:'v2'});
  assert.equal((await action('agent-releases', {version:second.id,environment:'production'}, {session:'other-session'})).status,400);
  assert.equal((await action('agent-releases', {version:second.id,environment:'production'})).status,400);
  const dataset = await create('datasets', {name:'Release checks'});
  await create('examples', {dataset:dataset.id,input:'Question',expected:'Version two'});
  const comparison = await create('agent-evaluations',
    {baseline:first.id,candidate:second.id,dataset:dataset.id,billing_key:key.id});
  assert.deepEqual(comparison.variants.map(variant => [variant.version, variant.passed]), [[first.id,false], [second.id,true]]);
  assert.equal((await action('agent-releases', {version:first.id,environment:'production'})).status,400);
  const productionRelease = await create('agent-releases', {version:second.id,environment:'production'});
  assert.equal(productionRelease.evaluation,comparison.id);
  const run = (environment, token = key.token) => action('runs',
    {target_kind:'agent_release',target:agent.id,environment,input:'Question'}, {token});
  assert.equal((await run('staging', telemetryKey.token)).status,403);
  const staged = await run('staging');
  assert.equal(staged.status,201);
  assert.equal(staged.data.output,'Version one');
  assert.equal(staged.data.agent_version,first.id);
  assert.equal(staged.data.environment,'staging');
  assert.equal(modelCalls.at(-1).max_tokens,80);
  const production = await run('production');
  assert.equal(production.data.output,'Version two');
  assert.equal(modelCalls.at(-1).max_tokens,40);
  const secondRelease = await create('agent-releases', {version:second.id,environment:'staging'});
  assert.equal(secondRelease.previous,first.id);
  assert.equal((await action('agent-releases', {version:first.id,environment:'staging',expected_release:firstRelease.id})).status,400);
  const rollback = await create('agent-releases', {version:first.id,environment:'staging',expected_release:secondRelease.id});
  const rolledBack = await run('staging');
  assert.equal(rolledBack.data.agent_release,rollback.id);
  assert.equal(rolledBack.data.output,'Version one');
  const balance = (await request('/api/billing')).data;
  assert.equal(balance.entries.find(row => row.reference === rolledBack.data.id).nanos, -rolledBack.data.cost_nanos);
});
