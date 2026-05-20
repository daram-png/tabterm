import { sessions } from './sessions.js';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function registerWs(app, { auth }) {
  app.get('/ws/pty', { websocket: true }, (socket, req) => {
    const ws = socket;
    const cookieName = process.env.COOKIE_NAME || 'tabterm.sid';
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[cookieName];

    if (!auth.verifySid(sid)) {
      try { ws.close(1008, 'unauthorized'); } catch {}
      return;
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    const xfHost = req.headers['x-forwarded-host'];
    const publicOrigin = process.env.PUBLIC_ORIGIN;
    if (origin) {
      try {
        const u = new URL(origin);
        const allowed = [host, xfHost].filter(Boolean);
        if (publicOrigin) {
          try { allowed.push(new URL(publicOrigin).host); } catch {}
        }
        if (allowed.length && !allowed.includes(u.host)) {
          ws.close(1008, 'bad-origin');
          return;
        }
      } catch {
        ws.close(1008, 'bad-origin');
        return;
      }
    }

    const url = new URL(req.url, `http://${host || 'x'}`);
    const sessionId = url.searchParams.get('sessionId');
    const session = sessions.get(sessionId);
    if (!session) {
      try { ws.close(1008, 'no-session'); } catch {}
      return;
    }

    session.attach(ws);
    const pingTimer = setInterval(() => {
      if (ws.readyState !== 1) return;
      try { ws.ping(); } catch {}
    }, 30_000);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        session.write(raw);
        return;
      }
      const text = raw.toString('utf8');
      if (text.length && text[0] === '{') {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'input' && typeof msg.data === 'string') {
            session.write(msg.data);
            return;
          }
          if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
            const c = Math.min(Math.max(msg.cols, 20), 400);
            const r = Math.min(Math.max(msg.rows, 8), 200);
            session.resize(c, r);
            return;
          }
          if (msg.type === 'signal' && msg.name === 'SIGINT') {
            session.softStop();
            return;
          }
          if (msg.type === 'ping') {
            try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch {}
            return;
          }
        } catch {}
      }
      session.write(text);
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      session.detach(ws);
    });
    ws.on('error', () => {
      clearInterval(pingTimer);
      session.detach(ws);
    });
  });
}
