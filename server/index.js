require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const dns = require('node:dns').promises;
const dgram = require('node:dgram');
const crypto = require('node:crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const PORT = Number(process.env.PORT || 3000);
const clients = new Set();

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    app: 'RX link PTT',
    status: 'not-connected',
    bmAdapterConfigured: true,
    message: 'BM 登入握手測試已加入；語音/DMR 封包傳輸尚未完成。',
    features: {
      webUi: true,
      localTextChat: true,
      bmLoginHandshake: true,
      liveDmrAudio: false,
      privateCall: false,
      dmrSms: false
    }
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'system',
    text: '已連接 RX link PTT 網頁服務；BM 登入與語音功能狀態請以 BM 設定頁測試結果為準。'
  }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type !== 'chat' || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 500);
    const callsign = String(data.callsign || 'WEB USER').trim().slice(0, 32);
    if (!text) return;
    const packet = JSON.stringify({ type: 'chat', callsign, text, time: new Date().toISOString() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(packet);
    }
  });
  ws.on('close', () => clients.delete(ws));
});

function writeId(packet, id) {
  packet.writeUInt32BE(id >>> 0, 4);
}

function fixed(value, width) {
  return String(value ?? '').slice(0, width).padEnd(width, ' ');
}

function buildConfigPacket(callsign, radioId) {
  const header = Buffer.alloc(8);
  header.write('RPTC', 0, 'ascii');
  writeId(header, radioId);
  // DroidStar-compatible Homebrew RPTC payload (294 bytes after the 8-byte header).
  const fields = [
    fixed(callsign.toUpperCase(), 8),
    '438800000', '438800000',
    '01', '01',
    '0.000000', ' 0.000000',
    '000',
    fixed('', 20),
    fixed('', 19),
    '4',
    fixed('www.qrz.com', 124),
    fixed('20200922', 40),
    fixed('MMDVM_MMDVM_HS_Hat', 40)
  ];
  const payload = Buffer.from(fields.join(''), 'ascii');
  if (payload.length !== 294) throw new Error('Invalid RPTC configuration length');
  return Buffer.concat([header, payload]);
}


let dmrUsersCache = { expiresAt: 0, users: [] };

function normalizeDmrUser(user) {
  const id = String(user.id ?? user.radio_id ?? user.dmr_id ?? '').trim();
  const callsign = String(user.callsign ?? user.call ?? '').trim().toUpperCase();
  const name = [user.fname ?? user.first_name, user.surname ?? user.last_name].filter(Boolean).join(' ').trim()
    || String(user.name ?? '').trim();
  return {
    id,
    callsign,
    name,
    city: String(user.city ?? user.qth ?? '').trim(),
    country: String(user.country ?? user.country_name ?? '').trim()
  };
}

app.get('/api/dmrid/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q.length < 2 || q.length > 80) {
    return res.status(400).json({ results: [], detail: '請輸入 2–80 個字元。' });
  }
  try {
    if (dmrUsersCache.expiresAt < Date.now() || !dmrUsersCache.users.length) {
      const response = await fetch('https://radioid.net/static/users.json', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'RX-link-PTT/1.0' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error('DMR ID directory returned ' + response.status);
      const raw = await response.json();
      const list = Array.isArray(raw) ? raw : Array.isArray(raw.users) ? raw.users : Array.isArray(raw.results) ? raw.results : [];
      if (!list.length) throw new Error('DMR ID directory format was empty or unexpected');
      dmrUsersCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, users: list.map(normalizeDmrUser).filter((u) => u.id || u.callsign) };
    }
    const digitsOnly = /^\\d+$/.test(q);
    const matches = dmrUsersCache.users.filter((u) => {
      if (digitsOnly) return u.id.includes(q);
      return u.callsign.toLowerCase().includes(q) || u.name.toLowerCase().includes(q) || u.id.includes(q);
    }).slice(0, 12);
    return res.json({ results: matches, detail: matches.length ? '' : '公開 DMR ID 名錄中沒有符合結果。' });
  } catch (error) {
    return res.status(502).json({ results: [], detail: '目前無法取得公開 DMR ID 名錄，請稍後重試。' });
  }
});

app.post('/api/bm/login-test', async (req, res) => {
  const callsign = String(req.body?.callsign || '').trim().toUpperCase();
  const baseRadioIdText = String(req.body?.radioId || '').trim();
  const password = String(req.body?.password || '');
  const host = String(req.body?.host || '').trim().toLowerCase();

  if (!/^[A-Z0-9/]{3,16}$/.test(callsign)) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: '請輸入有效呼號（3–16 個英數字或 /）。' });
  }
  if (!/^\d{7}$/.test(baseRadioIdText)) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: 'DMR ID 必須是 7 位數字。' });
  }
  if (!password || password.length > 256) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: '請輸入 BM Hotspot Security Password。' });
  }
  if (!(host.endsWith('.master.brandmeister.network') || host === 'master.brandmeister.network')) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: 'Master 必須使用 BrandMeister 官方 master 網域。' });
  }

  // First attempt uses the exact 7-digit DMR ID entered by the user.
  // Do not silently append an ESSID: DroidStar supports ESSID=0 (base ID) as well,
  // and an unrequested suffix can cause an immediate MSTNAK at the RPTL stage.
  const radioId = Number(baseRadioIdText);
  let address;
  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    address = addresses.find((entry) => entry.family === 4);
    if (!address) throw new Error('No IPv4 address');
  } catch {
    return res.status(400).json({ ok: false, stage: 'dns-error', detail: 'Master 網域無法解析成 IPv4 位址。' });
  }

  const socket = dgram.createSocket('udp4');
  let state = 'login';
  let finished = false;
  let timer;

  const finish = (status, payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { socket.close(); } catch {}
    if (!res.headersSent) res.status(status).json(payload);
  };
  const send = (packet) => socket.send(packet, 62031, address.address, (error) => {
    if (error) finish(502, { ok: false, stage: 'send-error', detail: '送往 BM Master 的 UDP 封包失敗；請稍後重試。' });
  });

  socket.on('error', () => finish(502, { ok: false, stage: 'socket-error', detail: 'Render UDP socket 發生錯誤。' }));
  socket.on('message', (msg) => {
    if (finished) return;
    const tag = msg.toString('ascii', 0, Math.min(6, msg.length));

    if (tag === 'MSTNAK') {
      const rejectedAt = state === 'login' ? 'login' : state === 'auth' ? 'authentication' : 'configuration';
      const detail = state === 'login'
        ? 'BM Master 在收到 RPTL 後立即回覆 MSTNAK，尚未進入密碼驗證。優先檢查 DMR ID／ESSID 格式、該 ID 是否有效，以及選擇的 Master。這次回覆不能證明 BM Password 錯誤。'
        : state === 'auth'
          ? 'BM Master 在收到 RPTK 後回覆 MSTNAK，通常表示 BM Hotspot Security Password 不正確，或該 ID 的驗證未獲允許。'
          : 'BM Master 在收到 RPTC 設定封包後回覆 MSTNAK，可能是呼號、ID 重複登入或設定欄位遭拒絕。';
      return finish(200, { ok: false, stage: 'rejected-' + rejectedAt, detail });
    }
    if (tag === 'MSTCL') {
      return finish(200, { ok: false, stage: 'master-closed', detail: 'BM Master 關閉了連線。' });
    }
    if (tag !== 'RPTACK' || msg.length < 10) return;

    if (state === 'login') {
      // RPTACK challenge: 6-byte tag + 4-byte salt. Digest is SHA256(salt || UTF-8 password).
      const salt = msg.subarray(6, 10);
      const digest = crypto.createHash('sha256').update(Buffer.concat([salt, Buffer.from(password, 'utf8')])).digest();
      const keyPacket = Buffer.alloc(40);
      keyPacket.write('RPTK', 0, 'ascii');
      writeId(keyPacket, radioId);
      digest.copy(keyPacket, 8);
      state = 'auth';
      send(keyPacket);
      return;
    }

    if (state === 'auth') {
      // Authentication accepted; send repeater configuration.
      state = 'config';
      send(buildConfigPacket(callsign, radioId));
      return;
    }

    if (state === 'config') {
      // BM acknowledged configuration. This confirms login handshake only; socket is closed
      // because persistent session/audio and DMRD packet transport are not implemented yet.
      return finish(200, {
        ok: true,
        stage: 'authenticated',
        callsign,
        radioId: baseRadioIdText,
        master: host,
        detail: 'BM 已回覆登入與設定確認（RPTACK）。這代表驗證握手成功；目前尚未維持常駐連線，也尚未實作語音/PTT 封包傳輸。'
      });
    }
  });

  timer = setTimeout(() => {
    const stage = state === 'login' ? 'challenge-timeout' : state === 'auth' ? 'auth-timeout' : 'config-timeout';
    const detail = state === 'login'
      ? '等待 BM challenge 逾時。可能是 Master/UDP 路由或 Render 出站 UDP 問題。'
      : state === 'auth'
        ? '已收到 challenge 並送出驗證回應，但未收到 BM 驗證確認。請核對 BM Hotspot Security Password、DMR ID 與 ESSID。'
        : '驗證回覆已收到，但等待 BM 設定確認逾時。';
    finish(200, { ok: false, stage, detail });
  }, 12000);

  const loginPacket = Buffer.alloc(8);
  loginPacket.write('RPTL', 0, 'ascii');
  writeId(loginPacket, radioId);
  send(loginPacket);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RX link PTT listening on port ${PORT}`);
});
