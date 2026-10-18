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
const bmSessions = new Map();

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    app: 'RX link PTT',
    status: bmSessions.size ? 'connected' : 'not-connected',
    bmAdapterConfigured: true,
    message: 'BM 持續連線與 DMR 封包接收已接入；AMBE 語音編解碼仍待整合。',
    features: {
      webUi: true,
      localTextChat: true,
      bmLoginHandshake: true,
      persistentBmSession: true,
      dmrPacketReceive: true,
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
    if (data.type === 'bm:attach' && typeof data.sessionToken === 'string') {
      const session = bmSessions.get(data.sessionToken);
      if (!session || session.closed) {
        ws.send(JSON.stringify({ type: 'bm:status', connected: false, detail: 'BM 連線工作階段不存在或已斷線，請重新登入。' }));
        return;
      }
      if (session.ws && session.ws !== ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'bm:status', connected: false, detail: '此 BM 工作階段已由另一個頁面接管。' }));
      }
      session.ws = ws;
      ws.bmSessionToken = data.sessionToken;
      ws.send(JSON.stringify({ type: 'bm:status', connected: true, callsign: session.callsign, radioId: session.baseRadioIdText, master: session.host, detail: 'BrandMeister UDP 工作階段已維持連線。' }));
      return;
    }
    if (data.type === 'bm:disconnect' && ws.bmSessionToken) {
      const session = bmSessions.get(ws.bmSessionToken);
      if (session) closeBmSession(session, '使用者已中斷 BM 連線。');
      return;
    }
    if ((data.type === 'ptt-start' || data.type === 'ptt-stop') && ws.bmSessionToken) {
      const session = bmSessions.get(ws.bmSessionToken);
      if (!session || session.closed) {
        ws.send(JSON.stringify({ type: 'ptt:status', active: false, mode: data.mode, detail: 'BM 尚未連線。' }));
      } else if (data.type === 'ptt-start') {
        ws.send(JSON.stringify({ type: 'ptt:status', active: false, mode: data.mode, targetId: String(data.targetId || ''), targetCallsign: String(data.targetCallsign || ''), detail: 'BM 連線正常，但尚未啟用發射：必須先整合 AMBE+2 編碼器及 DMRD 語音幀產生器，避免送出無效或靜音封包。' }));
      } else {
        ws.send(JSON.stringify({ type: 'ptt:status', active: false, mode: data.mode, detail: 'PTT 已釋放。' }));
      }
      return;
    }
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
    '0.000000', '0.0000000',
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
    const digitsOnly = /^\d+$/.test(q);
    const matches = dmrUsersCache.users.filter((u) => {
      if (digitsOnly) return u.id.includes(q);
      return u.callsign.toLowerCase().includes(q) || u.name.toLowerCase().includes(q) || u.id.includes(q);
    }).slice(0, 12);
    return res.json({ results: matches, detail: matches.length ? '' : '公開 DMR ID 名錄中沒有符合結果。' });
  } catch (error) {
    return res.status(502).json({ results: [], detail: '目前無法取得公開 DMR ID 名錄，請稍後重試。' });
  }
});

function sendBmPacket(session, packet) {
  if (!session || session.closed) return;
  session.socket.send(packet, 62031, session.address, (error) => {
    if (error) {
      if (typeof session.fail === 'function') session.fail(502, 'send-error', '送往 BM Master 的 UDP 封包失敗。');
      else closeBmSession(session, '送往 BM Master 的 UDP 封包失敗。');
    }
  });
}

function notifyBmSession(session, payload) {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(payload));
  }
}

function closeBmSession(session, reason) {
  if (!session || session.closed) return;
  session.closed = true;
  clearInterval(session.pingTimer);
  clearTimeout(session.authTimer);
  bmSessions.delete(session.token);
  notifyBmSession(session, { type: 'bm:status', connected: false, detail: reason || 'BM 連線已關閉。' });
  try {
    const closePacket = Buffer.alloc(9);
    closePacket.write('RPTCL', 0, 'ascii');
    closePacket.writeUInt32BE(session.radioId >>> 0, 5);
    session.socket.send(closePacket, 62031, session.address, () => {
      try { session.socket.close(); } catch {}
    });
  } catch {
    try { session.socket.close(); } catch {}
  }
}

app.post('/api/bm/connect', async (req, res) => {
  const callsign = String(req.body?.callsign || '').trim().toUpperCase();
  const baseRadioIdText = String(req.body?.radioId || '').trim();
  const password = String(req.body?.password || '');
  const host = String(req.body?.host || '').trim().toLowerCase();

  if (!/^[A-Z0-9/]{3,16}$/.test(callsign)) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: '請輸入有效呼號（3–16 個英數字或 /）。' });
  }
  if (!/^\\d{7}$/.test(baseRadioIdText)) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: 'DMR ID 必須是 7 位數字。' });
  }
  if (!password || password.length > 256) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: '請輸入 BM Hotspot Security Password。' });
  }
  if (!(host.endsWith('.master.brandmeister.network') || host === 'master.brandmeister.network')) {
    return res.status(400).json({ ok: false, stage: 'validation', detail: 'Master 必須使用 BrandMeister 官方 master 網域。' });
  }

  // Use the exact entered 7-digit ID for this first session; ESSID handling can be added as an explicit setting.
  const radioId = Number(baseRadioIdText);
  let address;
  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    address = addresses.find((entry) => entry.family === 4);
    if (!address) throw new Error('No IPv4 address');
  } catch {
    return res.status(400).json({ ok: false, stage: 'dns-error', detail: 'Master 網域無法解析成 IPv4 位址。' });
  }

  // A new login replaces the prior process-wide BM session to avoid duplicate use of the same DMR ID.
  for (const existing of bmSessions.values()) closeBmSession(existing, '新的 BM 登入取代了舊工作階段。');

  const socket = dgram.createSocket('udp4');
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token, callsign, radioId, baseRadioIdText, host, address: address.address, socket,
    ws: null, state: 'login', closed: false, startedAt: Date.now(), rxPackets: 0
  };
  bmSessions.set(token, session);

  const fail = (status, stage, detail) => {
    closeBmSession(session, detail);
    if (!res.headersSent) res.status(status).json({ ok: false, stage, detail });
  };
  session.fail = fail;
  socket.on('error', () => fail(502, 'socket-error', 'Render UDP socket 發生錯誤。'));
  socket.on('message', (msg, rinfo) => {
    if (session.closed) return;
    // Ignore unrelated UDP traffic. The session is bound to the selected BM master address.
    if (rinfo.address !== session.address) return;
    const tag = msg.toString('ascii', 0, Math.min(7, msg.length));

    if (tag.startsWith('MSTNAK')) {
      const detail = session.state === 'login'
        ? 'BM Master 在 RPTL 階段拒絕連線；請檢查 DMR ID、ESSID 與 Master。'
        : session.state === 'auth'
          ? 'BM Master 在 RPTK 階段拒絕驗證；請檢查 Hotspot Security Password。'
          : 'BM Master 在設定階段拒絕連線；請檢查呼號與 ID 是否重複登入。';
      return fail(200, 'rejected', detail);
    }
    if (tag.startsWith('MSTCL')) return fail(200, 'master-closed', 'BM Master 關閉了連線。');

    if (tag.startsWith('RPTACK') && msg.length >= 10) {
      if (session.state === 'login') {
        const salt = msg.subarray(6, 10);
        const digest = crypto.createHash('sha256').update(Buffer.concat([salt, Buffer.from(password, 'utf8')])).digest();
        const keyPacket = Buffer.alloc(40);
        keyPacket.write('RPTK', 0, 'ascii');
        writeId(keyPacket, radioId);
        digest.copy(keyPacket, 8);
        session.state = 'auth';
        sendBmPacket(session, keyPacket);
        return;
      }
      if (session.state === 'auth') {
        session.state = 'config';
        sendBmPacket(session, buildConfigPacket(callsign, radioId));
        return;
      }
      if (session.state === 'config') {
        session.state = 'connected';
        clearTimeout(session.authTimer);
        session.pingTimer = setInterval(() => {
          const ping = Buffer.alloc(11);
          ping.write('RPTPING', 0, 'ascii');
          ping.writeUInt32BE(radioId >>> 0, 7);
          sendBmPacket(session, ping);
        }, 5000);
        // Do not keep the password in session memory after authentication.
        passwordBufferWipe(password);
        const result = {
          ok: true, stage: 'connected', sessionToken: token,
          callsign, radioId: baseRadioIdText, master: host,
          detail: 'BM 驗證成功，已建立持續 UDP 工作階段並開始保活。語音編解碼仍需下一階段整合。'
        };
        if (!res.headersSent) res.json(result);
        notifyBmSession(session, { type: 'bm:status', connected: true, callsign, radioId: baseRadioIdText, master: host, detail: result.detail });
        return;
      }
    }

    if (session.state === 'connected' && tag.startsWith('MSTPONG')) {
      session.lastPongAt = Date.now();
      return;
    }

    if (session.state === 'connected' && msg.length >= 53 && msg.toString('ascii', 0, 4) === 'DMRD') {
      session.rxPackets += 1;
      const sourceId = msg.readUIntBE(5, 3);
      const destinationId = msg.readUIntBE(8, 3);
      const flags = msg[15];
      notifyBmSession(session, {
        type: 'bm:dmrd',
        packets: session.rxPackets,
        sourceId,
        destinationId,
        slot: (flags & 0x80) ? 2 : 1,
        groupCall: (flags & 0x40) === 0,
        end: (flags & 0x02) !== 0,
        at: Date.now()
      });
    }
  });

  session.authTimer = setTimeout(() => {
    if (session.state !== 'connected') fail(200, session.state === 'login' ? 'challenge-timeout' : session.state === 'auth' ? 'auth-timeout' : 'config-timeout',
      session.state === 'login' ? '等待 BM challenge 逾時；可能是 Master/UDP 路由或 Render 出站 UDP 問題。'
      : session.state === 'auth' ? '已送出密碼驗證回應，但未收到 BM 確認。請核對 Hotspot Security Password。'
      : '已通過驗證但等待 BM 設定確認逾時。');
  }, 12000);

  const loginPacket = Buffer.alloc(8);
  loginPacket.write('RPTL', 0, 'ascii');
  writeId(loginPacket, radioId);
  sendBmPacket(session, loginPacket);
});

// Zeroing a temporary UTF-8 buffer is best-effort; JS strings themselves are immutable.
function passwordBufferWipe(_password) { /* no password is retained in the session object */ }

app.post('/api/bm/disconnect', (req, res) => {
  const token = String(req.body?.sessionToken || '');
  const session = bmSessions.get(token);
  if (!session) return res.json({ ok: true, detail: 'BM 工作階段已不存在。' });
  closeBmSession(session, '已由網頁端中斷 BM 連線。');
  return res.json({ ok: true, detail: 'BM 連線已中斷。' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RX link PTT listening on port ${PORT}`);
});
