import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GameError } from './hand.js';
import {
  openDatabase,
  createUser,
  getUserByName,
  verifyPassword,
  createSession,
  userForToken,
  deleteSession,
  accountsFrom,
  STARTING_CHIPS,
} from './db.js';
import { Table } from './table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const PORT = Number(process.env.PORT) || 3000;
const NAME_RE = /^[\p{L}\p{N}_]{2,12}$/u;

const db = openDatabase(path.join(rootDir, 'data', 'qingzhan.db'));
const accounts = accountsFrom(db);
const table = new Table(accounts);
const sockets = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function publicUser(user) {
  return { id: user.id, username: user.username, chips: user.chips };
}

function tokenFrom(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(Object.assign(new Error('请求过大'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求格式不正确'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validateCredentials(body) {
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!NAME_RE.test(username)) {
    throw Object.assign(new Error('用户名需要 2 到 12 位字母、数字或汉字'), { status: 400 });
  }
  if (password.length < 6 || password.length > 64) {
    throw Object.assign(new Error('密码需要 6 到 64 位'), { status: 400 });
  }
  return { username, password };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, name: '青毡' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/register') {
    const { username, password } = validateCredentials(await readJson(req));
    if (getUserByName(db, username)) {
      sendJson(res, 409, { error: '用户名已被占用' });
      return;
    }
    let user;
    try {
      user = createUser(db, username, password);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        sendJson(res, 409, { error: '用户名已被占用' });
        return;
      }
      throw error;
    }
    const token = createSession(db, user.id);
    sendJson(res, 201, { token, user: publicUser(user), startingChips: STARTING_CHIPS });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const { username, password } = validateCredentials(await readJson(req));
    const row = getUserByName(db, username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      sendJson(res, 401, { error: '用户名或密码不正确' });
      return;
    }
    const token = createSession(db, row.id);
    sendJson(res, 200, {
      token,
      user: { id: row.id, username: row.username, chips: row.chips },
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    deleteSession(db, tokenFrom(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const user = userForToken(db, tokenFrom(req));
    if (!user) {
      sendJson(res, 401, { error: '请先登录' });
      return;
    }
    sendJson(res, 200, { user });
    return;
  }

  sendJson(res, 404, { error: '没有这个接口' });
}

async function handleStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: '没有找到页面' });
  }
}

async function onRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: '不支持的方法' });
      return;
    }
    await handleStatic(req, res, url.pathname);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: status === 500 ? '服务器出错了' : error.message });
  }
}

const server = createServer(onRequest);
const server6 = createServer(onRequest);

function broadcast() {
  for (const [userId, ws] of sockets) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(JSON.stringify({ type: 'state', ...table.view(userId) }));
    } catch (error) {
      console.error(error);
    }
  }
}

table.onUpdate = broadcast;

function sendError(ws, error) {
  const known = error instanceof GameError || error.name === 'GameError';
  ws.send(JSON.stringify({ type: 'error', error: known ? error.message : '操作失败' }));
}

const wss = new WebSocketServer({ noServer: true });

function attachWebSocket(httpServer) {
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
}

attachWebSocket(server);
attachWebSocket(server6);

wss.on('connection', (ws, req) => {
  let user = null;
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    user = userForToken(db, url.searchParams.get('token'));
  } catch {
    user = null;
  }
  if (!user) {
    ws.close(4401, 'unauthorized');
    return;
  }
  const previous = sockets.get(user.id);
  sockets.set(user.id, ws);
  if (previous && previous !== ws) previous.close(4400, 'replaced');
  table.setConnected(user.id, true);
  ws.send(JSON.stringify({ type: 'state', ...table.view(user.id) }));

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      sendError(ws, new GameError('消息格式不正确'));
      return;
    }
    try {
      if (message.type === 'sit') table.sit(user, message.buyIn, message.seat);
      else if (message.type === 'leave') table.leave(user.id);
      else if (message.type === 'rebuy') table.rebuy(user.id, message.amount);
      else if (message.type === 'action') table.action(user.id, message.action, message.amount);
      else sendError(ws, new GameError('未知消息'));
    } catch (error) {
      sendError(ws, error);
    }
  });

  ws.on('close', () => {
    if (sockets.get(user.id) === ws) {
      sockets.delete(user.id);
      table.setConnected(user.id, false);
    }
  });
});

let ready = 0;
function announce() {
  ready += 1;
  if (ready === 1) console.log(`青毡已打开 http://localhost:${PORT}`);
}

// 同时监听 IPv4 和 IPv6。只绑其中一边时，浏览器或端口转发访问 localhost 会得到 -102。
server.listen({ port: PORT, host: '0.0.0.0' }, announce);
server6.listen({ port: PORT, host: '::', ipv6Only: true }, announce);
