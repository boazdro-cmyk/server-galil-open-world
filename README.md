# Galilee Open World: multiplayer server (Cloudflare)

A small relay for the game's multiplayer: a Cloudflare Worker plus one Durable Object per room. Players in the same
room see each other (on foot, in cars, boats and aircraft), with names over their heads and a chat (Enter in the game).
It uses WebSocket hibernation, so a quiet room costs almost nothing. It runs on the Workers **free** plan.

## Deploy (5 minutes)

You need a free Cloudflare account and Node.js 18+.

```bash
cd server/cloudflare
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints the address, e.g. `https://galilee-open-world-mp.<your-subdomain>.workers.dev`.

## Use it in the game

- Pause menu (Esc) → **🌐 Multiplayer**: put the address in as `wss://galilee-open-world-mp.<your-subdomain>.workers.dev`.
- Pick a room name (friends use the same one) and your name, then **Connect**.
- To make one server the default for everybody, set it in `src/index.html`: `window.__MP_URL = 'wss://…workers.dev'`.

Check it is up: open `https://galilee-open-world-mp.<your-subdomain>.workers.dev/health` in a browser.

## Settings

- `ALLOWED_ORIGINS` in `wrangler.toml`: a comma-separated list of the pages allowed to connect, for example
  `https://*.crazygames.com,https://your-site.example`. Leave it empty to allow any page.
- The limits are at the top of `worker.js`:
  - 32 players per room;
  - 25 messages a second per player;
  - 600 bytes per message;
  - chat lines up to 140 characters;
  - names up to 16 characters.

## Run it on your own computer

```bash
cd server/cloudflare
npm install
npx wrangler dev --port 8787
```

The game then connects to `ws://localhost:8787`. Run `node test-client.mjs` for a quick check: it connects two
players, moves one and sends a chat line.

## Protocol (JSON over WebSocket `/ws?room=<room>&name=<name>`)

| From | Message |
|---|---|
| client | `{t:'pos', x, y, z, yaw, v, s}` 10 times a second: game position (metres), heading, vehicle type ('' on foot), speed |
| client | `{t:'chat', text}`, `{t:'look', shirt}` |
| server | `{t:'welcome', id, room, players}`, `{t:'join', id, name, shirt}`, `{t:'leave', id}` |
| server | `{t:'state', p:[[id,x,y,z,yaw,v,s],…]}` every 100 ms (only players that moved) |
| server | `{t:'chat', id, name, text}`, `{t:'look', id, shirt}`, `{t:'full'}` |

---

## בעברית בקצרה

זה שרת המולטיפלייר של המשחק. הוא רץ ב-Cloudflare, בחינם.

התקנה:

1. בתיקייה `server/cloudflare` מריצים:

   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   ```

2. את הכתובת שמתקבלת מכניסים במשחק: Esc ← 🌐 Multiplayer. היא מתחילה ב-`wss://`.
3. בוחרים שם חדר וכותבים שם שחקן. חברים שבוחרים את אותו חדר רואים זה את זה.
4. Enter פותח צ'אט.
