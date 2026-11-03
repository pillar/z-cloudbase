// LOCAL-ONLY gateway (see wrangler.jsonc). One port, two origins:
//   http://127.0.0.1:<port>  -> api worker      (API_ORIGIN)
//   http://localhost:<port>  -> identity worker (ISSUER)
// The request (URL, Host, headers, body) is forwarded unchanged, so each worker sees its own origin.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function local(request, env, path) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const body = await request.json();
  try {
    if (path === '/__local/dlq/replay') return json({ replayed: await env.CONSUMER_OPS.replayDlq(body.dlq, body.date ? { date: body.date } : {}) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return json({ error: 'local only' }, 404);
    if (url.pathname.startsWith('/__local/')) return local(request, env, url.pathname);
    return (url.hostname === '127.0.0.1' ? env.API : env.IDENTITY).fetch(request);
  },
};
