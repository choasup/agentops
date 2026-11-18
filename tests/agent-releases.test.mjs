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
  const kv = new Map();
  return {
    async put(key, value) {kv.set(key, value);},
    async get(key) {return kv.get(key);},
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
      if (!instances.has(name)) instances.set(name, new Workspace({id:name, storage:workspaceStorage()}, env));
      return instances.get(name);
    }}
  };

  const modelCalls = [];
  const toolCalls = [];
  const githubCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://raw.githubusercontent.com/choasup/agentops/main/README.md') {
      assert.equal(options.headers, undefined);
      assert.equal(options.body, undefined);
      githubCalls.push(options.method);
      return new Response(options.method === 'HEAD' ? null : '# Agent Deck\n\nAn Agent workspace.');
    }
    if (url === 'https://docs.mcp.cloudflare.com/mcp') {
      const body = JSON.parse(options.body);
      assert.equal(options.headers.Authorization, undefined);
      if (body.method === 'initialize') return Response.json({id:body.id, result:{
        protocolVersion:'2025-06-18', capabilities:{tools:{}}
      }});
      if (body.method === 'notifications/initialized') return new Response(null, {status:202});
      const name = 'search_cloudflare_documentation';
      if (body.method === 'tools/list') return Response.json({id:body.id, result:{
        tools:[{name, annotations:{readOnlyHint:true}}]
      }});
      assert.equal(body.method,'tools/call');
      assert.equal(body.params.name,name);
      toolCalls.push(body.params.arguments.query);
      return Response.json({id:body.id,result:{structuredContent:{results:[
        {title:'Test documentation', url:'https://developers.cloudflare.com/workers/',text:'A fixture.'}
      ]}}});
    }
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fixture-provider-key');
    const body = JSON.parse(options.body);
    modelCalls.push(body);
    return Response.json({id:'fixture-completion', choices:[{message:{content:body.messages[0].content}}],
      usage:{prompt_tokens:20, completion_tokens:4, total_tokens:24}});
  });

  async function request(path, {data, token, session = 'workspace-session', extraHeaders} = {}) {
    const headers = {'Content-Type':'application/json', ...extraHeaders};
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
  const cliKey = (await request('/api/keys', {data:{name:'CLI', scopes:['agents:create']}})).data;
  const cli = {token:cliKey.token};
  const createPayload = {name:'CLI agent', provider:'hosted:deepseek', instructions:'Read and summarize.'};
  assert.equal((await request('/api/agents', {data:createPayload, token:key.token})).status, 403);
  assert.equal((await request('/api/models', {token:telemetryKey.token})).status, 403);
  assert.equal((await request('/api/agents', cli)).status, 403);
  assert.equal((await action('agents', createPayload, cli)).status, 403);
  assert.deepEqual(await request('/api/models', cli),
    {status:200, data:[{id:'hosted:deepseek', name:'DeepSeek Flash · Hosted'}]});
  const fromCli = await request('/api/agents', {...cli, data:createPayload});
  assert.equal(fromCli.status, 201);
  assert.equal(fromCli.data.instructions, createPayload.instructions);
  assert.ok((await request('/api/agents')).data.some(agent => agent.id === fromCli.data.id));
  assert.ok(!(await request('/api/agents', {session:'other-session'})).data.some(agent => agent.id === fromCli.data.id));
  const externalCli = await request('/api/agents', {...cli, data:{name:'CLI external', source:'external'}});
  assert.equal(externalCli.status, 201);
  assert.equal(externalCli.data.source, 'external');
  assert.ok(externalCli.data.identifier);
  const profile = {name:'Support agent', provider:'hosted:deepseek'};
  const agent = await create('agents', {...profile, instructions:'Version one', max_tokens:80});
  const studioInput = {target_kind:'agent', target:agent.id, input:'Studio test'};
  const runOnly = (await request('/api/keys', {data:{name:'Run only', scopes:['agents:run']}})).data;
  const claimedStudio = {'X-AgentOps-Studio-Session':'1'};
  assert.equal((await action('runs', studioInput, {token:runOnly.token, extraHeaders:claimedStudio})).status,403);
  assert.equal((await action('runs', studioInput, {extraHeaders:{...claimedStudio, Origin:'https://other.cloudmoro.com'}})).status,403);
  const noBalanceAgent = await create('agents', {...profile, instructions:'No credit'}, {session:'other-session'});
  assert.equal((await action('runs', {...studioInput,target:noBalanceAgent.id}, {session:'other-session'})).status,402);
  const beforeStudio = (await request('/api/billing')).data.balance_nanos;
  const studio = await action('runs', studioInput, {extraHeaders:{Origin:origin}});
  assert.equal(studio.status,201,JSON.stringify(studio.data));
  assert.equal(studio.data.output,'Version one');
  assert.equal(studio.data.key_id,null);
  const afterStudio = (await request('/api/billing')).data;
  assert.equal(beforeStudio - afterStudio.balance_nanos, studio.data.cost_nanos);
  const studioEntry = afterStudio.entries.find(row => row.reference === studio.data.id);
  assert.equal(studioEntry.key_id,null);
  assert.equal(studioEntry.nanos,-studio.data.cost_nanos);
  assert.equal(studioEntry.model,'deepseek-flash');
  assert.ok((await request('/api/keys')).data.every(key => key.requests === 0));
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
  const sourced = await create('examples', {dataset:dataset.id, input:'Redacted question', expected:'two',
    match:'contains', source_trace:studio.data.id});
  assert.equal(sourced.source_trace, studio.data.id);
  assert.equal((await action('examples', {dataset:dataset.id, input:'Question', expected:'two',
    source_trace:'missing'})).status, 400);
  const comparison = await create('agent-evaluations',
    {baseline:first.id,candidate:second.id,dataset:dataset.id,billing_key:key.id});
  assert.equal(comparison.variants[1].results.find(result => result.example === sourced.id).source_trace, studio.data.id);
  assert.equal(comparison.variants[1].results.find(result => result.example === sourced.id).passed, true);
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
  const chatPayload = {target_kind:'agent_release',target:agent.id,environment:'staging',input:'Follow-up',
    history:[{role:'user',content:'Question'},{role:'assistant',content:'Previous answer'}]};
  const chat = await action('runs', chatPayload, {extraHeaders:{Origin:origin}});
  assert.equal(chat.status,201);
  assert.equal(chat.data.key_id,null);
  assert.equal(chat.data.agent_version,first.id);
  assert.deepEqual(modelCalls.at(-1).messages.slice(1), [...chatPayload.history,{role:'user',content:'Follow-up'}]);
  assert.equal((await action('runs', {...chatPayload, history:[{role:'system',content:'Invalid'}]})).status,400);
  assert.equal((await action('runs', chatPayload, {token:runOnly.token})).status,403);
  const production = await run('production');
  assert.equal(production.data.output,'Version two');
  assert.equal(modelCalls.at(-1).max_tokens,40);
  const preserveStaging = await create('agent-releases', {version:second.id,environment:'staging',only_if_unpublished:true});
  assert.equal(preserveStaging.id,firstRelease.id);
  const secondRelease = await create('agent-releases', {version:second.id,environment:'staging'});
  assert.equal(secondRelease.previous,first.id);
  assert.equal((await action('agent-releases', {version:first.id,environment:'staging',expected_release:firstRelease.id})).status,400);
  const rollback = await create('agent-releases', {version:first.id,environment:'staging',expected_release:secondRelease.id});
  const rolledBack = await run('staging');
  assert.equal(rolledBack.data.agent_release,rollback.id);
  assert.equal(rolledBack.data.output,'Version one');
  const balance = (await request('/api/billing')).data;
  assert.equal(balance.entries.find(row => row.reference === rolledBack.data.id).nanos, -rolledBack.data.cost_nanos);
  const connection = await create('mcp-connect', {provider:'cloudflare-docs'});
  const runDraft = () => action('runs', {target_kind:'agent',target:agent.id,input:'What are Workers?'}, {token:key.token});
  assert.equal((await runDraft()).status,201);
  assert.equal(toolCalls.length,0);
  assert.equal((await action('agent-update', {...profile,agent:agent.id,instructions:'MCP test',
    mcp_connection:'wrong'})).status,400);
  await create('agent-update', {...profile,agent:agent.id,instructions:'MCP test',mcp_connection:connection.id});
  const withTool = await runDraft();
  assert.equal(withTool.status,201,JSON.stringify(withTool.data));
  assert.deepEqual(toolCalls,['What are Workers?']);
  assert.equal(withTool.data.steps[0].connection_id, connection.id);
  assert.equal(withTool.data.steps[0].output[0].title,'Test documentation');
  assert.match(modelCalls.at(-1).messages[1].content,/Test documentation/);
  await create('mcp-disconnect',{connection:connection.id});
  assert.equal((await runDraft()).status,400);
  assert.equal(toolCalls.length,1);
  const git = await create('mcp-connect', {provider:'github-agentops'});
  assert.notEqual(git.id,connection.id);
  assert.deepEqual(githubCalls,['HEAD']);
  await create('agent-update', {...profile,agent:agent.id,instructions:'Summarize the README',mcp_connection:git.id});
  const githubRun = await runDraft();
  assert.equal(githubRun.status,201,JSON.stringify(githubRun.data));
  assert.deepEqual(githubCalls,['HEAD','GET']);
  assert.equal(githubRun.data.steps[0].connection_scope,'choasup/agentops · main/README.md');
  assert.equal(githubRun.data.steps[0].input.repository,'choasup/agentops');
  assert.match(githubRun.data.steps[0].output.content,/# Agent Deck/);
  assert.match(modelCalls.at(-1).messages[1].content,/An Agent workspace/);
  const listed = (await request('/api/platform')).data.filter(item => item.builtin);
  assert.equal(listed.length, 6);
  assert.deepEqual((await request('/api/platform', {session:'other-session'})).data.filter(item => item.builtin), listed);
  const builtin = listed.find(item => item.id === 'builtin:doc-coauthoring:v1');
  const builtinAgent = await create('agents', {...profile,instructions:'Write a document',skill:builtin.id});
  const builtinRun = await action('runs', {target_kind:'agent',target:builtinAgent.id,input:'Draft a proposal'}, {token:key.token});
  assert.equal(builtinRun.status,201);
  assert.equal(builtinRun.data.steps[0].skill_id,builtin.id);
  assert.ok(modelCalls.at(-1).messages[0].content.includes(builtin.instructions));
  const builtinVersion = await create('agent-versions', {agent:builtinAgent.id,label:'With built-in Skill'});
  assert.equal(builtinVersion.skill,builtin.id);
  const imported = await create('skills', {name:'Summarizer', instructions:'Summarize in bullets.', requires:null});
  const importAgent = await create('agents', {...profile,instructions:'Summarize',skill:imported.id});
  const importRun = await action('runs', {target_kind:'agent',target:importAgent.id,input:'Summarize this text'}, {token:key.token});
  assert.equal(importRun.status,201);
  assert.equal(importRun.data.steps[0].skill_id,imported.id);
  assert.equal((await action('skills', {name:'Invalid dependency',instructions:'Test',requires:'unknown'})).status,400);
  const skill = await create('skills', {name:'Repository quickstart', instructions:'Summarize the startup steps.'});
  assert.equal((await action('agents', {...profile,instructions:'Test',skill:skill.id})).status,400);
  const skillAgent = await create('agents', {...profile,instructions:'Answer from sources',
    mcp_connection:git.id,skill:skill.id});
  await create('agent-update', {...profile,agent:agent.id,instructions:'Summarize the README',
    mcp_connection:git.id,skill:skill.id});
  const skillRun = await action('runs', {target_kind:'agent',target:skillAgent.id,input:'How do I start?'}, {token:key.token});
  assert.equal(skillRun.status,201);
  assert.deepEqual(skillRun.data.steps.map(step => step.type), ['skill','tool','llm']);
  assert.equal(skillRun.data.steps[0].skill_id,skill.id);
  assert.equal(skillRun.data.steps[1].connection_id,git.id);
  assert.match(modelCalls.at(-1).messages[0].content,/Summarize the startup steps/);
  const savedSkill = await create('agent-versions', {agent:skillAgent.id,label:'With reusable skill'});
  assert.equal(savedSkill.skill,skill.id);
  await create('mcp-disconnect',{connection:git.id});
  assert.equal((await runDraft()).status,400);
  assert.deepEqual(githubCalls,['HEAD','GET','GET']);
  const gateway = instances.get('browser:' + workspace).wecom;
  gateway.socket = {};
  gateway.status = 'connected';
  const replies = [];
  t.mock.method(gateway, 'reply', async (_socket, _request, _id, content, final) => {
    if (final) replies.push(content);
  });
  const bot = {agent:agent.id, environment:'staging', botId:'fixture-bot'};
  const wecomTurn = async (msgid, chattype, chatid, userid) => {
    await gateway.onMessage(gateway.socket, bot, JSON.stringify({cmd:'aibot_msg_callback',
      headers:{req_id:msgid}, body:{msgid, msgtype:'text', chattype, chatid, from:{userid}, text:{content:msgid}}}));
    return (await request('/api/traces')).data.find(item => item.input === msgid);
  };
  const direct = await wecomTurn('direct-one', 'single', undefined, 'sender-one');
  const followup = await wecomTurn('direct-two', 'single', undefined, 'sender-one');
  const group = await wecomTurn('group-one', 'group', 'shared-chat', 'sender-one');
  const groupFollowup = await wecomTurn('group-two', 'group', 'shared-chat', 'sender-two');
  assert.match(direct.session_id, /^[0-9a-f]{64}$/);
  assert.equal(direct.session_id, followup.session_id);
  assert.equal(group.session_id, groupFollowup.session_id);
  assert.notEqual(direct.session_id, group.session_id);
  assert.equal(direct.delivery, 'replied');
  assert.equal(direct.output, replies[0]);
  await gateway.onMessage(gateway.socket, bot, JSON.stringify({cmd:'aibot_msg_callback',
    headers:{req_id:'test-image'}, body:{msgtype:'image', image:{url:'private fixture'}}}));
  assert.deepEqual(gateway.diagnostics.slice(-3), [
    {event:'message:text', result:'accepted'},
    {event:'message:text', result:'replied'},
    {event:'message:image', result:'no_supported_text'}
  ]);
  assert.equal(gateway.diagnostics.length, 9);
  await gateway.ctx.storage.put('wecom-bot', bot);
  const discovery = await create('wecom-topic-discover', {agent:agent.id, marker:'DISCOVER-42'});
  const callsBeforeDiscovery = modelCalls.length;
  await gateway.onMessage(gateway.socket, bot, JSON.stringify({cmd:'aibot_msg_callback',
    headers:{req_id:'discovery-request'}, body:{msgid:'discovery-message', msgtype:'text',
      text:{content:'@Bot DISCOVER-42'}, compat_info:{source:'channel', channel:{topic_id:'fixture-topic'}}}}));
  const discovered = (await request('/api/platform/wecom-status')).data.topicDiscovery;
  assert.deepEqual(discovered, {id:discovery.id, state:'found', topicId:'fixture-topic'});
  assert.equal(modelCalls.length, callsBeforeDiscovery);
  const socket = {send(raw) {
    const request = JSON.parse(raw);
    assert.equal(request.cmd, 'aibot_topic_get_post_list');
    assert.equal(request.body.topic_id, 'fixture-topic');
    assert.equal(request.body.limit, 5);
    assert.equal(request.body.end_time - request.body.begin_time, 900);
    queueMicrotask(() => gateway.onMessage(socket, bot, JSON.stringify({headers:request.headers,
      errcode:0, body:{post_list:[{content:'test-MARKER-42', inline_file_list:[{cookie_value:'private fixture'}]}]}})));
  }};
  gateway.socket = socket;
  const access = await create('wecom-topic-probe', {agent:agent.id, topic_id:'fixture-topic', marker:'MARKER-42'});
  assert.deepEqual(access, {state:'matched', checked:1, has_more:false});
  assert.deepEqual(gateway.diagnostics.at(-1), {event:'topic_posts', result:'matched'});
  const channel = await create('mcp-connect', {provider:'wecom-channel',
    name:'Fixture channel', topic_id:'fixture-topic'});
  assert.equal(channel.wecom_bot_id, undefined);
  const connectedAgent = await create('agents', {...profile, instructions:'Summarize recent posts', mcp_connection:channel.id});
  const channelRun = {target_kind:'agent', target:connectedAgent.id, input:'Read recent posts'};
  assert.equal((await action('runs', channelRun, {token:key.token})).status,403);
  const read = await create('runs', channelRun);
  assert.deepEqual(read.steps[0].output, {channel:'Fixture channel', posts:[{content:'test-MARKER-42'}]});
  assert.match(JSON.stringify(modelCalls.at(-1).messages), /test-MARKER-42/);
  assert.doesNotMatch(JSON.stringify(read), /private fixture/);
  const privateVersion = await create('agent-versions', {agent:connectedAgent.id,label:'Channel Studio'});
  assert.equal((await action('agent-releases', {version:privateVersion.id,environment:'staging'})).status,400);
  await gateway.ctx.storage.put('wecom-bot', {...bot, botId:'other-bot'});
  assert.equal((await action('runs', channelRun)).status,502);
});
