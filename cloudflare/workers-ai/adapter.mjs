const model = '@cf/meta/llama-3.1-8b-instruct-fp8';

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/v1/chat/completions' || request.method !== 'POST') {
      return Response.json({error:'Not found'}, {status:404});
    }
    if (!env.ADAPTER_KEY) return Response.json({error:'Not configured'}, {status:503});
    const encoder = new TextEncoder();
    const requireHash = crypto.subtle.digest('SHA-256', encoder.encode('Bearer ' + env.ADAPTER_KEY));
    const submittedHash = crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization') || ''));
    if (!crypto.subtle.timingSafeEqual(await requireHash, await submittedHash)) {
      return Response.json({error:'Unauthorized'}, {status:401});
    }
    let body;
    try { body = await request.json(); }
    catch { return Response.json({error:'Invalid JSON'}, {status:400}); }
    if (body?.model !== model || !Array.isArray(body.messages) || body.messages.length < 1 ||
        body.messages.length > 2 || body.messages.some(message =>
          !['system', 'user'].includes(message?.role) ||
          typeof message.content !== 'string' || message.content.length > 1500)) {
      return Response.json({error:'Use the configured model and a short message'}, {status:400});
    }
    try {
      const result = await env.AI.run(model, {messages:body.messages, max_tokens:128});
      if (typeof result.response !== 'string') throw new Error('Invalid model response');
      return Response.json({choices:[{message:{role:'assistant', content:result.response}}], usage:result.usage});
    } catch (error) {
      console.error('Workers AI inference failed', error.name);
      return Response.json({error:'Model inference failed'}, {status:502});
    }
  }
};
