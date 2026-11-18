const repository = 'choasup/agentops';
const source = 'https://raw.githubusercontent.com/' + repository + '/main/README.md';
const maxBytes = 12_000;

export const githubConnection = {
  name:'GitHub · agentops', endpoint:source, tool:'read_agentops_readme',
  scope:repository + ' · main/README.md'
};

async function githubRead(method) {
  const response = await fetch(source, {method, redirect:'manual', signal:AbortSignal.timeout(12_000)});
  if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status);
  return response;
}

export async function verifyReadmeConnection() {
  await githubRead('HEAD');
}

export async function readReadme() {
  const start = performance.now();
  const response = await githubRead('GET');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let size = 0;
  let content = '';
  let truncated = false;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        content += decoder.decode();
        break;
      }
      const remaining = maxBytes - size;
      content += decoder.decode(value.subarray(0, remaining), {stream:true});
      size += value.length;
      if (size > maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!content.trim()) throw new Error('GitHub README is empty');
  const output = {source, content, truncated};
  while (encoder.encode(JSON.stringify(output)).length > 14_000) {
    output.content = output.content.slice(0, Math.floor(output.content.length * 0.9));
    output.truncated = true;
  }
  return {name:githubConnection.tool, type:'tool',
    input:{repository, ref:'main', path:'README.md'}, output, duration:performance.now()-start};
}
