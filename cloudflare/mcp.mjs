export const docsConnection = {
  name:'Cloudflare Documentation', endpoint:'https://docs.mcp.cloudflare.com/mcp',
  tool:'search_cloudflare_documentation'
};

async function decode(response, id) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 512_000) throw new Error('MCP response exceeded limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = await new Blob(chunks).text();
  const messages = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
      .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
    : [body];
  for (const message of messages) {
    const reply = JSON.parse(message);
    if (reply.id !== id) continue;
    if (reply.error || !reply.result) break;
    return reply.result;
  }
  throw new Error('MCP returned no matching result');
}

async function docsRequest(method, params) {
  let session;
  let protocol;
  let id = 0;
  const signal = AbortSignal.timeout(15_000);
  async function post(name, params, notification = false) {
    const requestId = notification ? undefined : ++id;
    const headers = {'Content-Type':'application/json', Accept:'application/json, text/event-stream'};
    if (session) headers['Mcp-Session-Id'] = session;
    if (protocol) headers['MCP-Protocol-Version'] = protocol;
    const response = await fetch(docsConnection.endpoint, {
      method:'POST', headers, redirect:'manual', signal,
      body:JSON.stringify({jsonrpc:'2.0', id:requestId, method:name, params})
    });
    if (!response.ok) throw new Error('MCP returned HTTP ' + response.status);
    if (notification) { await response.body?.cancel(); return; }
    if (name === 'initialize') session = response.headers.get('Mcp-Session-Id');
    return decode(response, requestId);
  }
  const greeting = await post('initialize', {
    protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'Agent Deck', version:'1'}
  });
  if (greeting.protocolVersion !== '2025-06-18' || !greeting.capabilities?.tools) {
    throw new Error('Unsupported MCP tool protocol');
  }
  protocol = greeting.protocolVersion;
  await post('notifications/initialized', {}, true);
  return post(method, params);
}

export async function verifyDocsConnection() {
  const {tools} = await docsRequest('tools/list', {});
  if (!tools?.some(tool => tool.name === docsConnection.tool && tool.annotations?.readOnlyHint === true)) {
    throw new Error('Read-only documentation tool was not advertised');
  }
}

export async function searchDocs(query) {
  const start = performance.now();
  const result = await docsRequest('tools/call', {name:docsConnection.tool, arguments:{query}});
  if (result.isError) throw new Error('MCP documentation search failed');
  const hits = result.structuredContent?.results;
  const output = Array.isArray(hits)
    ? hits.slice(0, 3).map(hit => ({title:String(hit.title ?? '').slice(0, 200),
      url:String(hit.url ?? '').slice(0, 500), text:String(hit.text ?? '').slice(0, 1000)}))
    : (result.content ?? []).filter(part => part.type === 'text').slice(0, 3)
      .map(part => String(part.text ?? '').slice(0, 1000));
  if (!output.length) throw new Error('MCP documentation search returned no results');
  return {name:docsConnection.tool, type:'tool', input:{query}, output, duration:performance.now()-start};
}
