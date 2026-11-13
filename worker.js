// Galilee Open World: multiplayer relay on Cloudflare Workers + Durable Objects (one Durable Object per room).
// Players connect with a WebSocket to  wss://<your-worker>.workers.dev/ws?room=<room>&name=<name>
// The room keeps who is there, relays positions 10 times a second in one batched message, and passes chat on.
// It uses the WebSocket Hibernation API, so an empty or quiet room costs (almost) nothing.
//
// Messages (JSON):
//   client -> server  {t:'pos', x, y, z, yaw, v, s}        position (game metres), heading, vehicle type or '', speed m/s
//                     {t:'chat', text}                      a chat line (max 140 chars)
//                     {t:'look', shirt}                     shirt colour (0xRRGGBB)
//   server -> client  {t:'welcome', id, room, players:[{id,name,shirt}]}
//                     {t:'join', id, name, shirt}  {t:'leave', id}  {t:'look', id, shirt}
//                     {t:'state', p:[[id,x,y,z,yaw,v,s], ...]}   (every 100 ms, only players that moved)
//                     {t:'chat', id, name, text}   {t:'full'}  {t:'err', msg}

const MAX_PLAYERS = 32, MAX_MSG = 600, MAX_RATE = 25, TICK_MS = 100;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/' || url.pathname === '/health') return new Response(JSON.stringify({ ok: true, game: 'galilee-open-world', ws: '/ws?room=<room>&name=<name>' }), { headers: cors });
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    if (allowed.length && !allowed.some((a) => origin === a || (a.startsWith('*.') && origin.endsWith(a.slice(1))))) return new Response('origin not allowed', { status: 403 });
    const room = clean(url.searchParams.get('room') || 'lobby', 32).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'lobby';
    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(req);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state; this.env = env; this.dirty = new Set(); this.ticking = false;
    // after hibernation the sockets come back with their attachments: rebuild the player list from them
    this.players = new Map();
    for (const ws of this.state.getWebSockets()) { const a = ws.deserializeAttachment(); if (a) this.players.set(a.id, { ws, x: 0, y: 0, z: 0, yaw: 0, v: '', s: 0, n: 0, win: Date.now(), ...a }); }
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (this.players.size >= MAX_PLAYERS) { const [c, s] = Object.values(new WebSocketPair()); this.state.acceptWebSocket(s); s.send(JSON.stringify({ t: 'full' })); s.close(1013, 'room full'); return new Response(null, { status: 101, webSocket: c }); }
    const [client, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8), name = clean(url.searchParams.get('name'), 16) || 'Player ' + id.slice(0, 3).toUpperCase();
    const p = { id, name, shirt: 0x3b6ea5, x: 0, y: 0, z: 0, yaw: 0, v: '', s: 0, n: 0, win: Date.now() };
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, name, shirt: p.shirt });
    this.players.set(id, { ws: server, ...p });
    server.send(JSON.stringify({ t: 'welcome', id, room: url.searchParams.get('room') || 'lobby', players: [...this.players.values()].filter((q) => q.id !== id).map((q) => ({ id: q.id, name: q.name, shirt: q.shirt, x: q.x, y: q.y, z: q.z })) }));
    this.broadcast({ t: 'join', id, name, shirt: p.shirt }, id);
    return new Response(null, { status: 101, webSocket: client });
  }
  who(ws) { const a = ws.deserializeAttachment(); return a && this.players.get(a.id); }
  async webSocketMessage(ws, msg) {
    const p = this.who(ws); if (!p) return;
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    const now = Date.now(); if (now - p.win > 1000) { p.win = now; p.n = 0; } if (++p.n > MAX_RATE) return; // (flooding: dropped)
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    if (m.t === 'pos') {
      const num = (v, lim) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < lim ? v : 0);
      p.x = num(m.x, 2e7); p.y = num(m.y, 1e5); p.z = num(m.z, 2e7); p.yaw = num(m.yaw, 100); p.s = num(m.s, 2000); p.v = clean(m.v, 24);
      this.dirty.add(p.id); this.tick();
    } else if (m.t === 'chat') {
      const text = clean(m.text, 140); if (text) this.broadcast({ t: 'chat', id: p.id, name: p.name, text });
    } else if (m.t === 'look') {
      p.shirt = (m.shirt >>> 0) & 0xffffff; ws.serializeAttachment({ id: p.id, name: p.name, shirt: p.shirt }); this.broadcast({ t: 'look', id: p.id, shirt: p.shirt }, p.id);
    }
  }
  // one batched state message every 100 ms while anyone moves
  tick() {
    if (this.ticking) return; this.ticking = true;
    setTimeout(() => {
      this.ticking = false; if (!this.dirty.size) return;
      const r = (v) => Math.round(v * 100) / 100;
      const list = [...this.dirty].map((id) => this.players.get(id)).filter(Boolean).map((p) => [p.id, r(p.x), r(p.y), r(p.z), r(p.yaw), p.v, r(p.s)]);
      this.dirty.clear(); this.broadcast({ t: 'state', p: list });
    }, TICK_MS);
  }
  broadcast(obj, except) { const s = JSON.stringify(obj); for (const p of this.players.values()) { if (p.id === except) continue; try { p.ws.send(s); } catch (e) { /* closing */ } } }
  async webSocketClose(ws) { this.drop(ws); }
  async webSocketError(ws) { this.drop(ws); }
  drop(ws) { const p = this.who(ws); if (!p) return; this.players.delete(p.id); this.dirty.delete(p.id); this.broadcast({ t: 'leave', id: p.id }); try { ws.close(1000, 'bye'); } catch (e) { /* closed */ } }
}
