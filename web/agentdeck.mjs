#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const usage = `Agent Deck CLI (Node.js 20+)
  node agentdeck.mjs models list
  node agentdeck.mjs agents list
  node agentdeck.mjs agents create --name NAME --model MODEL (--prompt TEXT | --prompt-file PATH)
  node agentdeck.mjs agents create --name NAME --external

Set AGENT_DECK_API_KEY to your workspace API key. MODEL is the ID from models list.
Use --model default to select the workspace default if shown in models list.`;

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(usage);
} else {
  try {
    await main(args);
  } catch (error) {
    console.error('Agent Deck CLI: ' + error.message);
    process.exitCode = 1;
  }
}

async function main(args) {
  const [resource, command, ...rest] = args;
  let payload;
  if (resource === 'agents' && command === 'create') {
    const {values} = parseArgs({args:rest, options:{
      name:{type:'string'}, model:{type:'string'}, prompt:{type:'string'},
      'prompt-file':{type:'string'}, external:{type:'boolean'}
    }});
    if (!values.name?.trim()) throw new Error('Supply --name.');
    if (values.external) {
      if (values.model !== undefined || values.prompt !== undefined || values['prompt-file'] !== undefined) {
        throw new Error('--external only accepts --name.');
      }
      payload = {name:values.name, source:'external'};
    } else {
      const promptFile = values['prompt-file'];
      if ((values.prompt === undefined) === (promptFile === undefined)) {
        throw new Error('Supply exactly one of --prompt or --prompt-file.');
      }
      if (!values.model?.trim()) throw new Error('Supply --model. Run models list for available IDs.');
      const instructions = (values.prompt ?? await readFile(promptFile, 'utf8')).trim();
      if (!instructions) throw new Error('The prompt is empty.');
      payload = {
        name:values.name, source:'studio', instructions,
        provider:values.model === 'default' ? null : values.model
      };
    }
  } else if (!['agents', 'models'].includes(resource) || command !== 'list' || rest.length) {
    throw new Error('Unknown command. Use --help for usage.');
  }
  const token = process.env.AGENT_DECK_API_KEY?.trim();
  if (!token) throw new Error('Set AGENT_DECK_API_KEY.');
  const response = await fetch('https://agentdeck.cloudmoro.com/api/' + resource, {
    method:payload ? 'POST' : 'GET',
    redirect:'error',
    signal:AbortSignal.timeout(30000),
    headers:{Authorization:'Bearer ' + token, ...(payload && {'Content-Type':'application/json'})},
    body:payload ? JSON.stringify(payload) : undefined
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? 'HTTP ' + response.status);
  if (result === null) throw new Error('Expected a JSON response from Agent Deck.');
  console.log(JSON.stringify(result, null, 2));
}
