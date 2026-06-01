// ---- opencode API proxy ----
// Read-only GET proxy: /api/sessions/:id/dp/<sub-path> → http://127.0.0.1:<apiPort>/<sub-path>.
// Only sessions created with engine='opencode' have meta.apiPort set.
// GET-only is intentional: the upstream API exposes destructive routes (DELETE /session/:id,
// POST /instance/dispose, POST /tui/*). Exposing only GET keeps the right-side sidebar
// read-only. If we ever need to drive the TUI from the sidebar, add a separate explicit
// allow-list route per action.
//
// Extracted from server/index.js into a registerable module so the routes can be
// unit/e2e-tested against an isolated Fastify instance with a fake upstream and a
// fake `sessions` store — without booting the full server (watchdog/hydra/PTY spawns).
//
// deps:
//   sessions    — object with .get(id) → { meta?: { apiPort } } | undefined
//   fetchImpl   — optional fetch implementation (defaults to global fetch); injectable for tests
//   requireAuth — optional (req, reply) => boolean guard; returns false + sends 401 when
//                 unauthorized. Defaults to allow-all so isolated unit/e2e tests that boot
//                 this module standalone keep working; the real server passes its
//                 session-cookie guard so /dp routes are not reachable unauthenticated.
export function registerDpProxy(app, { sessions, fetchImpl, requireAuth } = {}) {
  if (!sessions || typeof sessions.get !== 'function') {
    throw new Error('registerDpProxy: sessions store with .get(id) is required');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  const guard = typeof requireAuth === 'function' ? requireAuth : () => true;

  // SSE relay: forward opencode /event stream to the browser. Registered first so
  // Fastify's more-specific path beats the wildcard proxy below. Aborts the upstream
  // fetch when the browser disconnects so the opencode server doesn't keep zombie
  // subscribers.
  app.get('/api/sessions/:id/dp/event', async (req, reply) => {
    if (!guard(req, reply)) return;
    const s = sessions.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'session-not-found' });
    const port = s.meta?.apiPort ?? null;
    if (!port) return reply.code(503).send({ error: 'no-api-port' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': ok\n\n');

    const controller = new AbortController();
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { controller.abort(); } catch {}
      try { reply.raw.end(); } catch {}
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    try {
      const upstream = await doFetch(`http://127.0.0.1:${port}/event`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        try { reply.raw.write(`event: error\ndata: {"status":${upstream.status}}\n\n`); } catch {}
        cleanup();
        return;
      }
      const reader = upstream.body.getReader();
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          try { reply.raw.write(Buffer.from(value)); } catch { break; }
        }
      }
    } catch (e) {
      if (!closed) {
        try { reply.raw.write(`event: error\ndata: ${JSON.stringify({ msg: String(e?.message || e) })}\n\n`); } catch {}
      }
    } finally {
      cleanup();
    }
  });

  app.get('/api/sessions/:id/dp/*', async (req, reply) => {
    if (!guard(req, reply)) return;
    const s = sessions.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'session-not-found' });
    const port = s.meta?.apiPort ?? null;
    if (!port) {
      return reply.code(503).send({
        error: 'no-api-port',
        reason: 'not-a-opencode-session-or-port-alloc-failed',
      });
    }
    const subPath = req.params['*'] || '';
    // Reject any sub-path that tries to navigate or escape via control chars.
    if (subPath.includes('..') || /[\x00-\x1f]/.test(subPath)) {
      return reply.code(400).send({ error: 'bad-path' });
    }
    const qs = (req.raw.url || '').split('?')[1];
    const target = `http://127.0.0.1:${port}/${subPath}${qs ? '?' + qs : ''}`;
    try {
      const upstream = await doFetch(target, {
        method: 'GET',
        headers: { accept: req.headers.accept || 'application/json' },
      });
      reply.code(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) reply.header('content-type', ct);
      const buf = Buffer.from(await upstream.arrayBuffer());
      return reply.send(buf);
    } catch (e) {
      app.log?.warn?.({ err: String(e?.message || e), target }, '[dp-proxy] upstream fetch failed');
      return reply.code(502).send({ error: 'upstream', message: String(e?.message || e) });
    }
  });
}
