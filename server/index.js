require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const PORT = Number(process.env.PORT || 3000);
const clients = new Set();
const loginAttempts = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function encryptionKey() {
  const value = process.env.BM_CONFIG_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  return Buffer.from(value, 'hex');
}

function settingsStoragePath() {
  if (process.env.NODE_ENV === 'production' && !process.env.BM_CONFIG_FILE) return null;
  return process.env.BM_CONFIG_FILE || path.join(__dirname, '..', 'data', 'bm-config.enc');
}

function settingsReady() {
  return Boolean(
    process.env.RX_ADMIN_PASSWORD &&
    (process.env.RX_ADMIN_SESSION_SECRET || '').length >= 32 &&
    encryptionKey() &&
    settingsStoragePath()
  );
}

function cookieSecure(req) {
  return process.env.NODE_ENV === 'production' || req.secure || req.get('x-forwarded-proto') === 'https';
}

function sessionCookieValue(expiresAt) {
  const payload = String(expiresAt);
  const signature = crypto.createHmac('sha256', process.env.RX_ADMIN_SESSION_SECRET).update(payload).digest('hex');
  return payload + '.' + signature;
}

function hasAdminSession(req) {
  if (!settingsReady()) return false;
  const cookies = String(req.headers.cookie || '').split(';').map(x => x.trim());
  const entry = cookies.find(x => x.startsWith('rx_admin='));
  if (!entry) return false;
  const value = decodeURIComponent(entry.slice('rx_admin='.length));
  const parts = value.split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false;
  const expected = crypto.createHmac('sha256', process.env.RX_ADMIN_SESSION_SECRET).update(parts[0]).digest('hex');
  return safeEqual(parts[1], expected);
}

function requireAdmin(req, res, next) {
  if (!hasAdminSession(req)) return res.status(401).json({ error: '請先登入管理設定。' });
  next();
}

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const parsed = new URL(origin);
    if (parsed.host !== req.get('host') || parsed.protocol.replace(':', '') !== req.protocol) {
      return res.status(403).json({ error: '拒絕跨來源請求。' });
    }
  } catch {
    return res.status(403).json({ error: '來源無效。' });
  }
  next();
}

function loadEncryptedConfig() {
  const file = settingsStoragePath();
  const key = encryptionKey();
  if (!file || !key || !fs.existsSync(file)) return null;
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (envelope.version !== 1) throw new Error('Unsupported encrypted config version');
  const iv = Buffer.from(envelope.iv, 'hex');
  const tag = Buffer.from(envelope.tag, 'hex');
  const data = Buffer.from(envelope.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(clear);
}

function saveEncryptedConfig(config) {
  const file = settingsStoragePath();
  const key = encryptionKey();
  if (!file || !key) throw new Error('Secure storage is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  const envelope = JSON.stringify({
    version: 1,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: encrypted.toString('base64')
  });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, envelope, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function validMasterHost(host) {
  return typeof host === 'string' && host.length <= 253 &&
    /^[a-z0-9.-]+$/i.test(host) &&
    !host.startsWith('.') && !host.endsWith('.') &&
    !host.includes('..');
}

app.get('/api/status', (_req, res) => {
  res.json({
    app: 'RX link PTT',
    status: 'not-connected',
    bmAdapterConfigured: false,
    settingsReady: settingsReady(),
    message: '設定介面與加密儲存準備中；DMR gateway 尚未整合，不能收發 BM 語音。',
    features: { webUi: true, encryptedSettings: settingsReady(), liveDmrAudio: false, callAlert: false }
  });
});

app.get('/api/settings/status', (req, res) => {
  const authenticated = hasAdminSession(req);
  let saved = false;
  let callsign = '';
  let radioId = '';
  let masterHost = '2322.master.brandmeister.network';
  if (authenticated) {
    try {
      const config = loadEncryptedConfig();
      if (config) {
        saved = true;
        callsign = config.callsign || '';
        radioId = config.radioId || '';
        masterHost = config.masterHost || masterHost;
      }
    } catch {
      return res.status(500).json({ error: '無法讀取加密設定；請確認伺服器的加密金鑰未變更。' });
    }
  }
  res.json({
    ready: settingsReady(),
    authenticated,
    saved,
    callsign,
    radioId,
    masterHost,
    hasPassword: authenticated && saved ? Boolean((() => { try { return loadEncryptedConfig()?.hotspotPassword; } catch { return false; } })()) : false,
    storageNote: process.env.NODE_ENV === 'production'
      ? '正式環境必須將 BM_CONFIG_FILE 指向持久化磁碟；否則重新部署可能遺失加密設定。'
      : '本機開發環境使用 data/bm-config.enc。'
  });
});

app.post('/api/settings/login', sameOrigin, (req, res) => {
  if (!settingsReady()) return res.status(503).json({ error: '管理登入或加密儲存尚未設定，請先設定伺服器環境變數。' });
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = loginAttempts.get(ip) || { count: 0, since: now };
  if (now - attempt.since > 15 * 60 * 1000) {
    attempt.count = 0;
    attempt.since = now;
  }
  if (attempt.count >= 10) return res.status(429).json({ error: '登入嘗試過多，請 15 分鐘後再試。' });
  if (!safeEqual(req.body?.password, process.env.RX_ADMIN_PASSWORD)) {
    attempt.count += 1;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: '管理密碼不正確。' });
  }
  loginAttempts.delete(ip);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const cookie = 'rx_admin=' + encodeURIComponent(sessionCookieValue(expiresAt)) +
    '; Path=/api; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) +
    (cookieSecure(req) ? '; Secure' : '');
  res.setHeader('Set-Cookie', cookie);
  res.json({ ok: true, expiresAt });
});

app.post('/api/settings/logout', sameOrigin, (_req, res) => {
  res.setHeader('Set-Cookie', 'rx_admin=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0' +
    (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
  res.json({ ok: true });
});

app.get('/api/bm-config', requireAdmin, (_req, res) => {
  try {
    const config = loadEncryptedConfig();
    if (!config) return res.json({ saved: false, callsign: '', radioId: '', masterHost: '2322.master.brandmeister.network', hasPassword: false });
    res.json({
      saved: true,
      callsign: config.callsign,
      radioId: config.radioId,
      masterHost: config.masterHost,
      hasPassword: Boolean(config.hotspotPassword)
    });
  } catch {
    res.status(500).json({ error: '無法解密設定；請確認 BM_CONFIG_ENCRYPTION_KEY 與儲存檔相符。' });
  }
});

app.put('/api/bm-config', sameOrigin, requireAdmin, (req, res) => {
  const callsign = String(req.body?.callsign || '').trim().toUpperCase();
  const radioId = String(req.body?.radioId || '').trim();
  const masterHost = String(req.body?.masterHost || '').trim();
  const hotspotPassword = String(req.body?.hotspotPassword || '');
  if (!/^[A-Z0-9/]{1,16}$/.test(callsign)) return res.status(400).json({ error: '呼號格式不正確（最多 16 個英數字或 /）。' });
  if (!/^\d{1,9}$/.test(radioId)) return res.status(400).json({ error: 'DMR ID 必須是 1 至 9 位數字。' });
  if (!validMasterHost(masterHost)) return res.status(400).json({ error: 'Master Host 格式不正確。' });
  if (hotspotPassword.length > 256) return res.status(400).json({ error: 'Hotspot Security Password 長度不可超過 256 字元。' });
  try {
    const existing = loadEncryptedConfig();
    const password = hotspotPassword || existing?.hotspotPassword || '';
    if (!password) return res.status(400).json({ error: '第一次儲存時必須輸入 Hotspot Security Password。' });
    saveEncryptedConfig({
      callsign,
      radioId,
      masterHost,
      hotspotPassword: password,
      updatedAt: new Date().toISOString()
    });
    res.json({ ok: true, saved: true, callsign, radioId, masterHost, hasPassword: true,
      message: '認證資料已在伺服器端加密儲存；目前尚未連接 BrandMeister，不能收發語音。' });
  } catch {
    res.status(500).json({ error: '安全儲存失敗；請確認伺服器磁碟可寫入且加密金鑰設定正確。' });
  }
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'system', text: '已連接 RX link PTT 網頁服務；目前尚未連接 BM。' }));
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type !== 'chat' || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 500);
    const callsign = String(data.callsign || 'WEB USER').trim().slice(0, 32);
    if (!text) return;
    const packet = JSON.stringify({ type: 'chat', callsign, text, time: new Date().toISOString() });
    for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(packet);
  });
  ws.on('close', () => clients.delete(ws));
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log('RX link PTT listening on port ' + PORT));
