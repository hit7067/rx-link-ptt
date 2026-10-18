require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const dns = require('node:dns').promises;
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

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
    message: 'BM 連線與 AMBE+2／ODTP 語音發射管線已接入；實際通聯尚未驗證。',
    features: {
      webUi: true,
      localTextChat: true,
      bmLoginHandshake: true,
      persistentBmSession: true,
      dmrPacketReceive: true,
      liveDmrAudio: false,
      voiceTxPipeline: true,
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

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const session = ws.bmSessionToken ? bmSessions.get(ws.bmSessionToken) : null;
      const tx = session && session.tx;
      if (!tx || tx.ending || tx.encoder.stdin.destroyed || raw.length !== 320) return;
      tx.pcmFramesReceived = (tx.pcmFramesReceived || 0) + 1;
      if (tx.pcmFramesReceived === 1) console.log('[dmr-tx] first PCM frame received');
      if (!tx.encoder.stdin.write(raw)) {
        // TCP/WebSocket backpressure is handled by the browser pacing audio at 20 ms/frame.
      }
      return;
    }
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
      if (!session || session.closed || session.state !== 'connected') {
        ws.send(JSON.stringify({ type: 'ptt:status', active: false, mode: data.mode, detail: 'BM 尚未完成連線。' }));
      } else if (data.type === 'ptt-start') {
        const targetId = Number(String(data.targetId || ''));
        const mode = data.mode === 'private' ? 'private' : 'group';
        if (!Number.isInteger(targetId) || targetId < 1 || targetId > 16777215) {
          ws.send(JSON.stringify({ type: 'ptt:status', active: false, mode, detail: '請輸入有效的 Talkgroup 或目標 DMR ID。' }));
        } else {
          startVoiceTx(session, { mode, targetId, targetCallsign: String(data.targetCallsign || '').slice(0, 10) }, ws);
        }
      } else {
        stopVoiceTx(session, 'PTT 已釋放。');
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
  ws.on('close', () => {
    clients.delete(ws);
    if (ws.bmSessionToken) {
      const session = bmSessions.get(ws.bmSessionToken);
      if (session && session.tx && session.tx.owner === ws) stopVoiceTx(session, '網頁斷線，PTT 已自動釋放。');
    }
  });
});

function writeId(packet, id) {
  packet.writeUInt32BE(id >>> 0, 4);
}

function fixed(value, width) {
  return String(value ?? '').slice(0, width).padEnd(width, ' ');
}

function buildConfigPacket(callsign, radioId) {
  // Restore the earlier RX link PTT packet layout used before the RPTC regression:
  // 8-byte header (RPTC + 4-byte ID) followed by the 294-byte configuration payload.
  const header = Buffer.alloc(8);
  header.write('RPTC', 0, 'ascii');
  writeId(header, radioId);
  const fields = [
    fixed(callsign.toUpperCase(), 8),
    '438800000', '438800000',
    '01', '01',
    '0.000000', '0.0000000',
    '000',
    fixed('RX link Web PTT', 20),
    fixed('RX link', 19),
    '4',
    fixed('https://rx-link-ptt.onrender.com', 124),
    fixed('RXLINKWEB', 40),
    fixed('RXLINKWEB', 40)
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

function sendVoiceFrames(session, tx, frames) {
  if (!session || session.closed || !tx || frames.length !== 3) return;
  // Match the public pyspot_rx ODTP implementation: 3 packed AMBE frames = 27-byte payload.
  const payload = Buffer.concat(frames);
  session.sendRewind(0x0920, payload, 0x01, true);
  tx.audioPacketsSent = (tx.audioPacketsSent || 0) + 1;
  if (tx.audioPacketsSent === 1 || tx.audioPacketsSent % 20 === 0) {
    console.log('[dmr-tx] audio packets sent=' + tx.audioPacketsSent + ' target=' + tx.targetId + ' mode=' + tx.mode);
  }
}

function startVoiceTx(session, options, ws) {
  if (session.tx) {
    notifyBmSession(session, { type: 'ptt:status', active: false, mode: options.mode, detail: '目前已有一個 PTT 傳輸工作階段。' });
    return;
  }
  const encoder = spawn('/app/ambe-encoder', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const tx = {
    encoder, mode: options.mode, targetId: options.targetId, targetCallsign: options.targetCallsign,
    frames: [], output: Buffer.alloc(0), ending: false, startedAt: Date.now(), owner: ws, audioPacketsSent: 0
  };
  session.tx = tx;
  encoder.on('error', () => {
    notifyBmSession(session, { type: 'ptt:status', active: false, mode: tx.mode, detail: 'AMBE 編碼器無法啟動；請檢查 Render 建置日誌。' });
    stopVoiceTx(session, '編碼器錯誤。');
  });
  encoder.stderr.on('data', (chunk) => console.error('[ambe-encoder]', chunk.toString().trim()));
  encoder.on('close', (code, signal) => console.log('[dmr-tx] encoder closed code=' + code + ' signal=' + signal + ' pcmFrames=' + (tx.pcmFramesReceived || 0) + ' ambeFrames=' + (tx.encodedFrames || 0)));
  encoder.stdout.on('data', (chunk) => {
    tx.output = Buffer.concat([tx.output, chunk]);
    while (tx.output.length >= 9) {
      tx.frames.push(tx.output.subarray(0, 9));
      tx.encodedFrames = (tx.encodedFrames || 0) + 1;
      if (tx.encodedFrames === 1) console.log('[dmr-tx] first AMBE frame encoded');
      tx.output = tx.output.subarray(9);
      if (tx.frames.length === 3) {
        sendVoiceFrames(session, tx, tx.frames);
        tx.frames = [];
      }
    }
  });
  // ODTP DMR header-with-FLC from pyspot_rx: 12-byte FLC, realtime flag 0x01.
  // FLC = FLCO, FID/service bytes, 24-bit destination ID, 24-bit source ID, and 3 trailing zero bytes.
  const header = Buffer.alloc(12);
  header[0] = options.mode === 'private' ? 0x03 : 0x00;
  header[1] = 0x00;
  header[2] = 0x04;
  header.writeUIntBE(options.targetId >>> 0, 3, 3);
  header.writeUIntBE((session.radioId % 10000000) >>> 0, 6, 3);
  session.sendRewind(0x0911, header, 0x01, true);
  console.log('[dmr-tx] start target=' + tx.targetId + ' source=' + session.radioId + ' mode=' + tx.mode + ' header=0x0911/12B flags=1');
  notifyBmSession(session, { type: 'ptt:status', active: true, mode: tx.mode, targetId: tx.targetId, detail: '已送出 DMR 通話標頭；正在送出語音封包。' });
}

function stopVoiceTx(session, reason) {
  const tx = session && session.tx;
  if (!tx || tx.ending) return;
  tx.ending = true;
  try { tx.encoder.stdin.end(); } catch {}
  tx.encoder.once('close', () => {
    if (session.tx !== tx) return;
    if (tx.frames.length > 0) {
      while (tx.frames.length < 3) tx.frames.push(tx.frames[tx.frames.length - 1]);
      sendVoiceFrames(session, tx, tx.frames);
    }
    // ODTP terminator-with-FLC also carries the full 12-byte FLC and realtime flag.
    const terminator = Buffer.alloc(12);
    terminator[0] = tx.mode === 'private' ? 0x03 : 0x00;
    terminator[1] = 0x00;
    terminator[2] = 0x04;
    terminator.writeUIntBE(tx.targetId >>> 0, 3, 3);
    terminator.writeUIntBE((session.radioId % 10000000) >>> 0, 6, 3);
    session.sendRewind(0x0912, terminator, 0x01, true);
    session.tx = null;
    console.log('[dmr-tx] stop target=' + tx.targetId + ' audioPackets=' + tx.audioPacketsSent);
    notifyBmSession(session, { type: 'ptt:status', active: false, mode: tx.mode, detail: 'PTT 已釋放；伺服器送出 ' + tx.audioPacketsSent + ' 個語音封包。' });
  });
}

function closeBmSession(session, reason) {
  if (!session || session.closed) return;
  if (typeof session.closeFn === 'function') return session.closeFn(reason);
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
  let password = String(req.body?.password || '');
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

  const radioId = Number(baseRadioIdText);
  let address;
  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    address = addresses.find((entry) => entry.family === 4);
    if (!address) throw new Error('No IPv4 address');
  } catch {
    return res.status(400).json({ ok: false, stage: 'dns-error', detail: 'Master 網域無法解析成 IPv4 位址。' });
  }

  for (const existing of bmSessions.values()) closeBmSession(existing, '新的 BM 登入取代了舊工作階段。');

  // Software terminals use BrandMeister ODTP/REWIND on UDP 54006, not Homebrew RPTL/RPTK/RPTC.
  const socket = dgram.createSocket('udp4');
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token, callsign, radioId, baseRadioIdText, host, address: address.address, socket,
    ws: null, state: 'challenge', closed: false, startedAt: Date.now(), rxPackets: 0,
    protocol: 'odtp'
  };
  bmSessions.set(token, session);

  let sequence = 0;
  let realtimeSequence = 0;
  let authSent = false;
  let provisioned = false;
  let responseSent = false;

  const frame = (type, payload = Buffer.alloc(0), flags = 0, realtime = false) => {
    const packet = Buffer.alloc(18 + payload.length);
    packet.write('REWIND01', 0, 'ascii');
    packet.writeUInt16LE(type, 8);
    packet.writeUInt16LE(flags, 10);
    packet.writeUInt32LE(((realtime ? realtimeSequence++ : sequence++) >>> 0), 12);
    packet.writeUInt16LE(payload.length, 16);
    payload.copy(packet, 18);
    return packet;
  };
  const sendRewind = (type, payload = Buffer.alloc(0), flags = 0, realtime = false) => {
    if (session.closed) return;
    const packet = frame(type, payload, flags, realtime);
    if (type === 0x0928 || type === 0x0911 || type === 0x0920 || type === 0x0912 || type === 0x0900 || type === 0x0901) {
      console.log('[bm-tx] type=0x' + type.toString(16).padStart(4, '0') +
        ' payload=' + payload.length + ' datagram=' + packet.length +
        ' dest=' + session.address + ':54006' +
        (type === 0x0928 && payload.length >= 12
          ? ' source=' + payload.readUInt32LE(4) + ' target=' + payload.readUInt32LE(8)
          : ''));
    }
    socket.send(packet, 54006, session.address, (error) => {
      if (error) {
        console.error('[bm-tx] UDP send error type=0x' + type.toString(16) + ' message=' + error.message);
        fail(502, 'send-error', '送往 BM ODTP 服務的 UDP 封包失敗。');
      }
    });
  };
  const keepAlivePayload = () => {
    const description = Buffer.from('RX link PTT Web/1.0', 'ascii');
    const payload = Buffer.alloc(5 + description.length);
    payload.writeUInt32LE(radioId >>> 0, 0);
    payload[4] = 0x21;
    description.copy(payload, 5);
    return payload;
  };
  const sendKeepAlive = () => sendRewind(0x0000, keepAlivePayload());
  const fail = (status, stage, detail) => {
    closeBmSession(session, detail);
    if (!res.headersSent) res.status(status).json({ ok: false, stage, detail });
  };
  session.fail = fail;
  session.sendRewind = sendRewind;
  session.closeFn = (reason) => {
    if (session.closed) return;
    stopVoiceTx(session, reason || 'BM 連線已關閉。');
    session.closed = true;
    clearInterval(session.pingTimer);
    clearTimeout(session.authTimer);
    bmSessions.delete(session.token);
    notifyBmSession(session, { type: 'bm:status', connected: false, detail: reason || 'BM 連線已關閉。' });
    try {
      const packet = frame(0x0001);
      socket.send(packet, 54006, session.address, () => { try { socket.close(); } catch {} });
    } catch { try { socket.close(); } catch {} }
  };

  socket.on('error', () => fail(502, 'socket-error', 'Render UDP socket 發生錯誤。'));
  socket.on('message', (msg, rinfo) => {
    if (session.closed) return;
    // Log every UDP datagram before filtering the source IP. Some masters may answer
    // from a different address than the DNS A record used for the initial request.
    if (msg.length >= 18 && msg.toString('ascii', 0, 8) === 'REWIND01') {
      const incomingType = msg.readUInt16LE(8);
      session.rxPackets = (session.rxPackets || 0) + 1;
      console.log('[bm-rx] datagram=' + session.rxPackets + ' type=0x' + incomingType.toString(16).padStart(4, '0') + ' bytes=' + msg.length + ' from=' + rinfo.address + ':' + rinfo.port + ' expected=' + session.address + ':54006' + ' state=' + session.state + (incomingType === 0x0929 ? ' failurePayload=' + msg.subarray(18).toString('hex') : ''));
    } else {
      console.log('[bm-rx] non-REWIND datagram bytes=' + msg.length + ' from=' + rinfo.address + ':' + rinfo.port);
    }
    if (rinfo.address !== session.address) {
      console.log('[bm-rx] ignored unexpected source=' + rinfo.address + ' expected=' + session.address);
      return;
    }
    if (msg.length < 18 || msg.toString('ascii', 0, 8) !== 'REWIND01') return;
    const type = msg.readUInt16LE(8);
    const payloadLength = msg.readUInt16LE(16);
    if (msg.length < 18 + payloadLength) return;
    const payload = msg.subarray(18, 18 + payloadLength);

    if (type === 0x0002 && !authSent) {
      if (payload.length < 4) return fail(200, 'bad-challenge', 'BM ODTP challenge 格式不正確。');
      const passwordBytes = Buffer.from(password, 'utf8');
      const digest = crypto.createHash('sha256').update(Buffer.concat([payload, passwordBytes])).digest();
      passwordBytes.fill(0);
      password = '';
      authSent = true;
      sendRewind(0x0003, digest);
      return;
    }

    if (type === 0x0001) return fail(200, 'master-closed', 'BM ODTP Master 關閉了連線。');
    if (type === 0x0929) {
      console.error('[bm-rx] failure code payload=' + msg.subarray(18).toString('hex'));
      return fail(200, 'rejected', 'BM ODTP 回覆失敗碼；請查看 Render 日誌中的 failure payload。');
    }

    if (type === 0x0000 && authSent && !provisioned) {
      // The reference ODTP client treats the post-auth keepalive as the login confirmation.
      // Send terminal configuration, but do not subscribe to any talkgroup at login.
      provisioned = true;
      const config = Buffer.alloc(4);
      // We use 0x0911 Header-with-FLC, not the optional 0x0928 SuperHeader format.
      config.writeUInt32LE(0, 0);
      sendRewind(0x0900, config);

      responseSent = true;
      session.state = 'connected';
      clearTimeout(session.authTimer);
      session.pingTimer = setInterval(sendKeepAlive, 5000);
      const result = {
        ok: true, stage: 'connected', sessionToken: token,
        callsign, radioId: baseRadioIdText, master: host,
        detail: 'BrandMeister ODTP 密碼驗證成功，已送出終端設定；登入不會自動訂閱 Talkgroup。'
      };
      if (!res.headersSent) res.json(result);
      notifyBmSession(session, { type: 'bm:status', connected: true, callsign, radioId: baseRadioIdText, master: host, detail: result.detail });
      return;
    }
  });

  session.authTimer = setTimeout(() => {
    if (!session.closed && session.state !== 'connected') {
      const stage = !authSent ? 'challenge-timeout' : !provisioned ? 'auth-timeout' : 'configuration-timeout';
      fail(200, stage, !authSent
        ? '等待 BM ODTP challenge 逾時；請確認 Master 網域、UDP 54006 與 Render 出站 UDP。'
        : !provisioned
          ? '已送出 ODTP 密碼驗證回應，但未收到登入確認；請核對 Hotspot Security Password。'
          : 'ODTP 密碼已驗證，但未收到登入後的 keepalive 確認封包。');
    }
  }, 15000);

  sendKeepAlive();
});
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
