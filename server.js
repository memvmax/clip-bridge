'use strict';

/**
 * ClipBridge — 极简跨端剪贴板
 * 零依赖 Node HTTP 服务 + 单文件前端。
 * 数据按「房间码」分区持久化到磁盘上的 store.json。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const MAX_BODY = 512 * 1024;          // 单次请求体上限
const MAX_TEXT = 20000;               // 单条文本上限（字符）
const MAX_NOTE = 240;                 // 单条备注上限（字符）
const MAX_ITEMS_PER_ROOM = 120;       // 每房间保留条数
const MAX_ROOMS = 3000;               // 房间总数上限
const ROOM_TTL_MS = 90 * 24 * 3600 * 1000;

const APP_DIR = __dirname;

/* ---------------------------------------------------------------- 存储 */

function pickDataDir() {
  const candidates = [
    process.env.CLIP_DATA_DIR,
    path.join(os.homedir(), '.clipbridge'),
    path.join(APP_DIR, 'data'),
    path.join(os.tmpdir(), 'clipbridge'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch (_) { /* try next */ }
  }
  throw new Error('ClipBridge: no writable data directory available');
}

const DATA_DIR = pickDataDir();
const DATA_FILE = path.join(DATA_DIR, 'store.json');

let store = { rooms: {} };
let dirty = false;
let writeTimer = null;

function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.rooms && typeof parsed.rooms === 'object') {
      store = parsed;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[clipbridge] load failed:', e.message);
  }
}

function flush() {
  if (!dirty) return;
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    dirty = false;
  } catch (e) {
    console.error('[clipbridge] save failed:', e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flush(); }, 400);
}

setInterval(flush, 5000);

function shutdown() {
  flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', flush);

/* ---------------------------------------------------------------- 工具 */

const ROOM_RE = /^[A-Z0-9]{4,32}$/;

function normalizeRoom(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(Object.assign(new Error('bad json'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function getRoom(code, create) {
  let room = store.rooms[code];
  if (!room && create) {
    const keys = Object.keys(store.rooms);
    if (keys.length >= MAX_ROOMS) {
      // 淘汰最久未使用的房间
      keys.sort((a, b) => (store.rooms[a].touched || 0) - (store.rooms[b].touched || 0));
      for (const k of keys.slice(0, Math.ceil(MAX_ROOMS * 0.1))) delete store.rooms[k];
    }
    room = store.rooms[code] = { seq: 0, touched: Date.now(), items: [], devices: {} };
  }
  return room || null;
}

/* ------------------------------------------------------- 设备与权限 */

const DEV_NAME_MAX = 24;
const MAX_DEVICES_PER_ROOM = 40;
const ROLES = ['admin', 'upload'];   // admin 可管理；upload 只能上传
const DEFAULT_ROLE = 'admin';

// 老数据没有 devices / pin / dev / note 字段，读的时候补齐，不落盘也可用
function ensureShape(room) {
  if (!room) return room;
  if (!room.devices || typeof room.devices !== 'object') room.devices = {};
  if (!Array.isArray(room.items)) room.items = [];
  if (typeof room.notesRev !== 'number') room.notesRev = 0;
  for (const it of room.items) {
    if (typeof it.dev !== 'string') it.dev = '';
    if (it.pin === undefined) it.pin = 0;
    if (typeof it.note !== 'string') it.note = '';
    if (!it.device) it.device = '未知设备';
  }
  return room;
}

function devKey(v) {
  return String(v || '').trim().slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '');
}

function cleanName(v) {
  return String(v || '').replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim().slice(0, DEV_NAME_MAX);
}

function registerDevice(room, dev, name) {
  const id = devKey(dev);
  if (!id) return null;
  const now = Date.now();
  let d = room.devices[id];
  if (!d) {
    d = room.devices[id] = {
      id,
      name: cleanName(name) || '未知设备',
      role: DEFAULT_ROLE,
      joined: now,
      seen: now,
    };
    pruneDevices(room);
    scheduleSave();
  } else if (now - (d.seen || 0) > 5 * 60 * 1000) {
    // 心跳时间只放内存，不值得为它频繁写盘
    d.seen = now;
  }
  return d;
}

// 设备表不能无限长：优先淘汰最久没动静的非管理设备
function pruneDevices(room) {
  const ids = Object.keys(room.devices);
  if (ids.length <= MAX_DEVICES_PER_ROOM) return;
  const victims = ids
    .map((k) => room.devices[k])
    .sort((a, b) => (a.role === 'admin' ? 1 : 0) - (b.role === 'admin' ? 1 : 0) ||
                    (a.seen || 0) - (b.seen || 0));
  const drop = ids.length - MAX_DEVICES_PER_ROOM;
  for (const d of victims.slice(0, drop)) delete room.devices[d.id];
}

function roleOf(room, dev) {
  const id = devKey(dev);
  // 没带设备标识（老客户端 / 老标签页）按管理权限放行，避免直接把人锁在外面
  if (!id) return DEFAULT_ROLE;
  const d = room && room.devices ? room.devices[id] : null;
  return d ? d.role : DEFAULT_ROLE;
}

function canManage(room, dev) {
  return roleOf(room, dev) === 'admin';
}

function pinIdsOf(room) {
  return (room.items || []).filter((it) => it.pin).map((it) => it.id);
}

// 备注跟着条目走，序列化成 id -> text 的小表；客户端靠 notesRev 判断要不要重取
function notesOf(room) {
  const out = {};
  for (const it of room.items) if (it.note) out[it.id] = it.note;
  return out;
}


function gcRooms() {
  const now = Date.now();
  let removed = 0;
  for (const [k, r] of Object.entries(store.rooms)) {
    if (now - (r.touched || 0) > ROOM_TTL_MS) { delete store.rooms[k]; removed++; }
  }
  if (removed) { scheduleSave(); console.log('[clipbridge] gc removed', removed, 'idle rooms'); }
}
setInterval(gcRooms, 60 * 60 * 1000);

/* ---------------------------------------------------------------- 静态 */

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
};

function serveStatic(req, res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  fs.readFile(path.join(APP_DIR, entry.file), (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 ' + err.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ---------------------------------------------------------------- 路由 */

async function handleApi(req, res, pathname, query) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // GET /api/pull?room=XXX&since=0&dev=XXX&name=XXX
  if (pathname === '/api/pull') {
    const code = normalizeRoom(query.get('room'));
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });

    const since = Number(query.get('since') || 0) || 0;
    const dev = devKey(query.get('dev'));
    const name = cleanName(query.get('name'));
    const nrev = Number(query.get('nrev') || -1);   // 客户端已有的备注版本

    // 带设备标识来拉取 = 这台设备要加入房间，顺手把设备登记上（房间不存在就建一个空的）
    const room = getRoom(code, !!dev);
    if (!room) {
      return json(res, 200, {
        ok: true, room: code, seq: 0, items: [], ids: [], pinIds: [],
        notes: {}, notesRev: 0,
        devices: {}, me: DEFAULT_ROLE, exists: false, now: Date.now(),
      });
    }

    ensureShape(room);
    room.touched = Date.now();
    if (dev) registerDevice(room, dev, name);

    const items = room.items.filter((it) => it.id > since);
    const payload = {
      ok: true,
      room: code,
      seq: room.seq,
      items,
      ids: room.items.map((it) => it.id),
      pinIds: pinIdsOf(room),
      notesRev: room.notesRev,
      devices: room.devices,
      me: roleOf(room, dev),
      exists: true,
      now: Date.now(),
    };
    // 备注没变就不重复下发，省流量
    if (nrev !== room.notesRev) payload.notes = notesOf(room);
    return json(res, 200, payload);
  }

  const body = await readBody(req);

  // POST /api/push {room,text,dev,name,device}
  if (pathname === '/api/push') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });

    let text = typeof body.text === 'string' ? body.text : '';
    text = text.replace(/\r\n/g, '\n');
    if (!text.trim()) return json(res, 400, { ok: false, error: 'empty' });
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

    const room = ensureShape(getRoom(code, true));
    room.touched = Date.now();
    const d = registerDevice(room, body.dev, body.name);
    room.seq = (room.seq || 0) + 1;

    const item = {
      id: room.seq,
      text,
      dev: d ? d.id : '',
      device: (d && d.name) || cleanName(body.device) || '未知设备',
      ts: Date.now(),
      pin: 0,
      note: '',
    };
    room.items.unshift(item);
    if (room.items.length > MAX_ITEMS_PER_ROOM) room.items.length = MAX_ITEMS_PER_ROOM;

    scheduleSave();
    return json(res, 200, { ok: true, room: code, item, seq: room.seq });
  }

  // POST /api/delete {room,id,dev}
  if (pathname === '/api/delete') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    if (!room) return json(res, 200, { ok: true });
    ensureShape(room);
    if (!canManage(room, body.dev)) return json(res, 403, { ok: false, error: 'forbidden' });

    const id = Number(body.id);
    const before = room.items.length;
    room.items = room.items.filter((it) => it.id !== id);
    room.touched = Date.now();
    if (room.items.length !== before) {
      room.notesRev = (room.notesRev || 0) + 1;
      scheduleSave();
    }
    return json(res, 200, { ok: true });
  }

  // POST /api/clear {room,dev}
  if (pathname === '/api/clear') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    if (room) {
      ensureShape(room);
      if (!canManage(room, body.dev)) return json(res, 403, { ok: false, error: 'forbidden' });
      room.items = [];
      room.notesRev = (room.notesRev || 0) + 1;
      room.touched = Date.now();
      scheduleSave();
    }
    return json(res, 200, { ok: true });
  }

  // POST /api/pin {room,id,pinned,dev}
  if (pathname === '/api/pin') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    if (!room) return json(res, 200, { ok: true });
    ensureShape(room);
    if (!canManage(room, body.dev)) return json(res, 403, { ok: false, error: 'forbidden' });

    const id = Number(body.id);
    const on = body.pinned ? 1 : 0;
    const it = room.items.find((x) => x.id === id);
    if (it) {
      it.pin = on;
      room.touched = Date.now();
      scheduleSave();
    }
    return json(res, 200, { ok: true, id, pin: on });
  }

  // POST /api/note {room,id,note,dev}  → 给某条记录写/改备注（空字符串 = 删除备注）
  if (pathname === '/api/note') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    if (!room) return json(res, 404, { ok: false, error: 'no_room' });
    ensureShape(room);
    if (!canManage(room, body.dev)) return json(res, 403, { ok: false, error: 'forbidden' });

    const id = Number(body.id);
    const it = room.items.find((x) => x.id === id);
    if (!it) return json(res, 404, { ok: false, error: 'no_item' });

    let note = typeof body.note === 'string' ? body.note : '';
    note = note.replace(/\r\n/g, '\n').trim();
    if (note.length > MAX_NOTE) note = note.slice(0, MAX_NOTE);

    if ((it.note || '') !== note) {
      it.note = note;
      room.notesRev = (room.notesRev || 0) + 1;
      room.touched = Date.now();
      scheduleSave();
    }
    return json(res, 200, { ok: true, id, note, notesRev: room.notesRev });
  }

  // POST /api/rename {room,target,name,dev}  → 改设备名，历史条目跟着变
  if (pathname === '/api/rename') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    if (!room) return json(res, 404, { ok: false, error: 'no_room' });
    ensureShape(room);

    const me = devKey(body.dev);
    const target = devKey(body.target);
    const name = cleanName(body.name);
    if (!name) return json(res, 400, { ok: false, error: 'bad_name' });
    if (!room.devices[target]) return json(res, 404, { ok: false, error: 'no_device' });
    if (me !== target && !canManage(room, me)) return json(res, 403, { ok: false, error: 'forbidden' });

    room.devices[target].name = name;
    // 冗余字段同步一份，兼容不认 devices 的老页面
    for (const it of room.items) if (it.dev === target) it.device = name;

    scheduleSave();
    return json(res, 200, { ok: true, devices: room.devices });
  }

  // POST /api/role {room,target,role,dev}
  if (pathname === '/api/role') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    if (!room) return json(res, 404, { ok: false, error: 'no_room' });
    ensureShape(room);

    const me = devKey(body.dev);
    const target = devKey(body.target);
    const role = String(body.role || '');
    if (!canManage(room, me)) return json(res, 403, { ok: false, error: 'forbidden' });
    if (target === me) return json(res, 400, { ok: false, error: 'self' });
    if (ROLES.indexOf(role) < 0) return json(res, 400, { ok: false, error: 'bad_role' });
    if (!room.devices[target]) return json(res, 404, { ok: false, error: 'no_device' });

    room.devices[target].role = role;
    scheduleSave();
    return json(res, 200, { ok: true, devices: room.devices });
  }

  // POST /api/device/remove {room,target,dev}  → 移除一台设备（换机/丢失的旧设备）
  if (pathname === '/api/device/remove') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    if (!room) return json(res, 404, { ok: false, error: 'no_room' });
    ensureShape(room);

    const me = devKey(body.dev);
    const target = devKey(body.target);
    if (!canManage(room, me)) return json(res, 403, { ok: false, error: 'forbidden' });
    if (target === me) return json(res, 400, { ok: false, error: 'self' });
    if (!room.devices[target]) return json(res, 404, { ok: false, error: 'no_device' });

    // 它的历史条目保留，dev 解析不到时前端会退回用冗余的 device 名
    delete room.devices[target];
    scheduleSave();
    return json(res, 200, { ok: true, devices: room.devices });
  }

  // POST /api/peek {room}  → 只读统计，用于校验房间是否存在
  if (pathname === '/api/peek') {
    const code = normalizeRoom(body.room);
    if (!ROOM_RE.test(code)) return json(res, 400, { ok: false, error: 'bad_room' });
    const room = getRoom(code, false);
    return json(res, 200, {
      ok: true,
      room: code,
      exists: !!room,
      count: room ? room.items.length : 0,
      seq: room ? room.seq : 0,
    });
  }

  return json(res, 404, { ok: false, error: 'not_found' });
}

/* ---------------------------------------------------------------- 启动 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: Object.keys(store.rooms).length });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
  } catch (e) {
    const code = e && e.code === 413 ? 413 : e && e.code === 400 ? 400 : 500;
    if (!res.headersSent) json(res, code, { ok: false, error: e.message || 'error' });
    else try { res.end(); } catch (_) { /* noop */ }
  }
});

loadStore();
server.listen(PORT, HOST, () => {
  console.log('[clipbridge] listening on http://' + HOST + ':' + PORT);
  console.log('[clipbridge] data file:', DATA_FILE);
  console.log('[clipbridge] rooms loaded:', Object.keys(store.rooms).length);
});
