require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const dns = require('node:dns').promises;
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const DMRLib = require('dmr-lib');

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
    message: 'BM ODTP 語音與 Motorola TMS over DMR IP/UDP 簡訊管線已接入；實際通聯及送達尚未驗證。',
    features: {
      webUi: true,
      localTextChat: true,
      bmLoginHandshake: true,
      persistentBmSession: true,
      dmrPacketReceive: true,
      liveDmrAudio: true,
      voiceTxPipeline: true,
      privateCall: false,
      dmrSms: true,
      dmrSmsDeliveryConfirmed: false
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
      if (!tx || tx.ending || raw.length !== 320) return;
      if (tx.pending || !tx.encoder) {
        if (!tx.pendingPcm) tx.pendingPcm = [];
        if (tx.pendingPcm.length < 100) tx.pendingPcm.push(Buffer.from(raw));
        return;
      }
      if (tx.encoder.stdin.destroyed) return;
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
    if (data.type === 'bm:unsubscribe' && ws.bmSessionToken) {
      const session = bmSessions.get(ws.bmSessionToken);
      if (!session || session.closed || session.state !== 'connected') {
        ws.send(JSON.stringify({ type: 'bm:rx-status', ok: false, detail: '無法解除訂閱：BM 尚未連線。' }));
      } else {
        cancelTalkgroupSubscriptions(session);
        notifyBmSession(session, { type: 'bm:rx-status', ok: true, unsubscribed: true, detail: '已送出解除所有 Talkgroup 訂閱的要求。' });
      }
      return;
    }
    if (data.type === 'bm:subscribe' && ws.bmSessionToken) {
      const session = bmSessions.get(ws.bmSessionToken);
      const targetId = Number(String(data.targetId || ''));
      if (!session || session.closed || session.state !== 'connected' || !Number.isInteger(targetId) || targetId < 1 || targetId > 16777215) {
        ws.send(JSON.stringify({ type: 'bm:rx-status', ok: false, detail: '無法訂閱：請確認 BM 已連線及 Talkgroup 編號。' }));
      } else {
        if (session.subscriptions && session.subscriptions.has(targetId)) {
          notifyBmSession(session, { type: 'bm:rx-status', ok: true, targetId, detail: '目前已訂閱接收 TG ' + targetId + '。' });
        } else {
          cancelTalkgroupSubscriptions(session);
          ensureTalkgroupSubscribed(session, targetId).then(() => {
            notifyBmSession(session, { type: 'bm:rx-status', ok: true, targetId, detail: '已訂閱接收 TG ' + targetId + '；等待語音封包。' });
          }).catch((error) => {
            notifyBmSession(session, { type: 'bm:rx-status', ok: false, targetId, detail: error.message || 'Talkgroup 訂閱失敗。' });
          });
        }
      }
      return;
    }
    if (data.type === 'bm:sms:send') {
      const session = ws.bmSessionToken ? bmSessions.get(ws.bmSessionToken) : null;
      const targetId = Number(String(data.targetId || ''));
      const messageText = String(data.text || '').trim();
      if (!session || session.closed || session.state !== 'connected') {
        ws.send(JSON.stringify({ type: 'bm:sms:status', ok: false, detail: '請先連線 BrandMeister。' }));
      } else if (!Number.isInteger(targetId) || targetId < 1 || targetId > 16777215) {
        ws.send(JSON.stringify({ type: 'bm:sms:status', ok: false, detail: '目標 DMR ID 格式不正確。' }));
      } else if (!messageText || messageText.length > 160) {
        ws.send(JSON.stringify({ type: 'bm:sms:status', ok: false, detail: '簡訊請輸入 1–160 個字元。' }));
      } else if (session.tx) {
        ws.send(JSON.stringify({ type: 'bm:sms:status', ok: false, detail: '目前正在發射語音，請先釋放 PTT 再傳簡訊。' }));
      } else if (session.smsTx) {
        ws.send(JSON.stringify({ type: 'bm:sms:status', ok: false, detail: '上一則簡訊仍在傳送，請稍候。' }));
      } else {
        session.smsTx = true;
        sendDmrSms(session, targetId, messageText).then((result) => {
          notifyBmSession(session, {
            type: 'bm:sms:status',
            ok: true,
            targetId,
            packets: result.packets,
            detail: '已將 DMR 數據封包送入 BrandMeister ODTP 傳輸佇列（' + result.packets + ' 個封包）。這是送出確認，並非對方已讀或已送達回條。'
          });
        }).catch((error) => {
          notifyBmSession(session, { type: 'bm:sms:status', ok: false, detail: error.message || 'DMR 簡訊封包建立失敗。' });
        }).finally(() => {
          session.smsTx = false;
        });
      }
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
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2 || q.length > 80) {
    return res.status(400).json({ results: [], detail: '請輸入 2–80 個字元。' });
  }
  try {
    // Use RadioID's documented query API instead of downloading the entire
    // static database for every cold start. This makes lookup work with exact
    // DMR IDs and callsign/name searches, and avoids silently parsing an
    // unexpected static-dump response shape.
    const params = new URLSearchParams({ page: '1', per_page: '12' });
    if (/^\d+$/.test(q)) {
      params.set('id', q);
      params.set('id_sel', '=');
    } else {
      params.set('callsign', '%' + q.toUpperCase() + '%');
      params.set('callsign_sel', 'L');
    }
    const response = await fetch('https://radioid.net/api/users?' + params.toString(), {
      headers: { 'Accept': 'application/json', 'User-Agent': 'RX-link-PTT/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('RadioID API returned ' + response.status);
    const raw = await response.json();
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.results) ? raw.results : [];
    const matches = list.map(normalizeDmrUser).filter((u) => u.id || u.callsign);
    if (/^\d+$/.test(q)) {
      matches.sort((a, b) => Number(b.id === q) - Number(a.id === q));
    }
    return res.json({
      results: matches.slice(0, 12),
      detail: matches.length ? '' : '公開 DMR ID 名錄中沒有符合結果。'
    });
  } catch (error) {
    console.error('[dmrid-search] ' + (error && error.message ? error.message : String(error)));
    return res.status(502).json({ results: [], detail: 'RadioID 查詢失敗，請稍後重試。' });
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

async function sendDmrSms(session, targetId, text) {
  // Motorola TMS SMS over the standard DMR IP/UDP bearer (UDP port 4007).
  // dmr-lib is MIT-licensed and builds the TMS, IPv4/UDP, DMR Data Header,
  // CRC32 and unconfirmed data continuation PDUs.
  const tms = new DMRLib.Protocols.TMS();
  tms.text = text;
  // Motorola TMS examples use the high bit of the message ID (e.g. 0x88).
  // Preserve the 7-bit sequence number while setting the TMS charset/format flag.
  tms.msgId = 0x80 | crypto.randomInt(0, 128);

  const ipPacket = new DMRLib.IP.IPUDPPacket();
  ipPacket.src_addr = ((DMRLib.Motorola.Network.NETWORK_SERVER << 24) | session.radioId) >>> 0;
  ipPacket.dst_addr = ((DMRLib.Motorola.Network.NETWORK_RADIO << 24) | targetId) >>> 0;
  ipPacket.src_port = DMRLib.Motorola.Network.PORT_TMS;
  ipPacket.dst_port = DMRLib.Motorola.Network.PORT_TMS;
  ipPacket.payload = tms.getBuffer();
  const ipBuffer = ipPacket.getBuffer();

  const pdus = DMRLib.DMR.Util.DataBlock.createDataBlock(ipBuffer, session.radioId, targetId, false);
  if (!pdus.length || pdus.length > 64) throw new Error('簡訊封包數量超出安全範圍。');

  // Motorola-style data calls use CSBK preambles before the data header.
  // Match node-dmr-lib's DMRIPGateway.sendIPPacket(..., csbkCount=8):
  // send the countdown in descending order, then the header and continuation blocks.
  const preambleCount = 8;
  for (let i = preambleCount - 1; i >= 0; i--) {
    if (session.closed || session.state !== 'connected') throw new Error('BrandMeister 工作階段已中斷，簡訊未送完。');
    const csbk = new DMRLib.DMR.CSBK.PreCSBK();
    csbk.src_id = session.radioId;
    csbk.dst_id = targetId;
    csbk.dstIsGroup = false;
    csbk.dataNext = true;
    csbk.blocksToFollow = pdus.length + i;
    const payload = csbk.getBuffer();
    if (!Buffer.isBuffer(payload) || payload.length !== 12) throw new Error('DMR CSBK 前導封包長度不正確。');
    console.log('[dmr-sms-tx-preamble] index=' + (preambleCount - i) + '/' + preambleCount +
      ' odtpType=0x0913 blocksToFollow=' + csbk.blocksToFollow +
      ' bytes=' + payload.length + ' hex=' + payload.toString('hex'));
    session.sendRewind(0x0913, payload, 0x01, true);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  for (let i = 0; i < pdus.length; i++) {
    if (session.closed || session.state !== 'connected') throw new Error('BrandMeister 工作階段已中斷，簡訊未送完。');
    const pdu = pdus[i];
    const type = 0x0910 + pdu.dataType;
    const payload = pdu.getBuffer();
    if (!Buffer.isBuffer(payload) || payload.length !== 12) throw new Error('DMR 數據 PDU 長度不正確。');
    console.log('[dmr-sms-tx-pdu] index=' + (i + 1) + '/' + pdus.length +
      ' odtpType=0x' + type.toString(16).padStart(4, '0') +
      ' dataType=' + pdu.dataType +
      ' bytes=' + payload.length +
      ' hex=' + payload.toString('hex'));
    session.sendRewind(type, payload, 0x01, true);
    if (i + 1 < pdus.length) await new Promise((resolve) => setTimeout(resolve, 60));
  }
  console.log('[dmr-sms-tx] target=' + targetId + ' source=' + session.radioId +
    ' chars=' + text.length + ' pdus=' + pdus.length +
    ' preambles=' + preambleCount +
    ' tmsBytes=' + tms.getBuffer().length +
    ' ipBytes=' + ipBuffer.length +
    ' types=' + pdus.map((pdu) => '0x' + (0x0910 + pdu.dataType).toString(16).padStart(4, '0')).join(','));
  return { packets: pdus.length };
}

function cancelTalkgroupSubscriptions(session) {
  if (!session || session.closed) return;
  // ODTP type 0x0902 cancels subscriptions; an empty payload clears all targets.
  if (session.pendingSubscription) {
    session.pendingSubscription.reject(new Error('訂閱已取消。'));
  }
  session.sendRewind(0x0902, Buffer.alloc(0), 0, false);
  if (session.subscriptions) session.subscriptions.clear();
  console.log('[dmr-rx] unsubscribe-all sent');
}

function ensureTalkgroupSubscribed(session, targetId) {
  if (session.subscriptions && session.subscriptions.has(targetId)) return Promise.resolve();
  if (session.pendingSubscription) {
    if (session.pendingSubscription.targetId === targetId) return session.pendingSubscription.promise;
    return Promise.reject(new Error('另一個 Talkgroup 訂閱仍在確認中。'));
  }
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(7, 0); // ODTP subscription type: talkgroup
  payload.writeUInt32LE(targetId >>> 0, 4);
  let resolvePending;
  let rejectPending;
  const promise = new Promise((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
  });
  const timer = setTimeout(() => {
    if (session.pendingSubscription && session.pendingSubscription.targetId === targetId) {
      session.pendingSubscription = null;
      rejectPending(new Error('BrandMeister 未確認 Talkgroup 訂閱；未開始發射。'));
    }
  }, 2000);
  session.pendingSubscription = {
    targetId, promise,
    resolve: () => {
      clearTimeout(timer);
      if (!session.subscriptions) session.subscriptions = new Set();
      session.subscriptions.add(targetId);
      session.pendingSubscription = null;
      resolvePending();
    },
    reject: (error) => {
      clearTimeout(timer);
      session.pendingSubscription = null;
      rejectPending(error);
    }
  };
  // Subscribe only on PTT, never during login.
  session.sendRewind(0x0901, payload, 0, false);
  return promise;
}

async function startVoiceTx(session, options, ws) {
  if (session.tx) {
    notifyBmSession(session, { type: 'ptt:status', active: false, mode: options.mode, detail: '目前已有一個 PTT 傳輸工作階段。' });
    return;
  }
  const tx = {
    encoder: null, mode: options.mode, targetId: options.targetId, targetCallsign: options.targetCallsign,
    frames: [], output: Buffer.alloc(0), ending: false, pending: true, pendingPcm: [], startedAt: Date.now(), owner: ws, audioPacketsSent: 0
  };
  session.tx = tx;
  try {
    if (options.mode === 'group') {
      if (!session.subscriptions || !session.subscriptions.has(options.targetId)) cancelTalkgroupSubscriptions(session);
      await ensureTalkgroupSubscribed(session, options.targetId);
    } else {
      cancelTalkgroupSubscriptions(session);
    }
  } catch (error) {
    if (session.tx === tx) session.tx = null;
    notifyBmSession(session, { type: 'ptt:status', active: false, mode: tx.mode, detail: error.message || 'Talkgroup 訂閱失敗；未開始發射。' });
    return;
  }
  if (session.closed || session.tx !== tx || tx.ending) return;
  tx.pending = false;
  const encoder = spawn('/app/ambe-encoder', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  tx.encoder = encoder;
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
  // Replay PCM captured while the on-demand TG subscription was awaiting its ACK.
  for (const pcm of tx.pendingPcm || []) {
    tx.pcmFramesReceived = (tx.pcmFramesReceived || 0) + 1;
    encoder.stdin.write(pcm);
  }
  tx.pendingPcm = [];

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
  if (tx.pending || !tx.encoder) {
    if (session.pendingSubscription && session.pendingSubscription.targetId === tx.targetId) {
      session.pendingSubscription.reject(new Error('PTT 已在訂閱確認前釋放。'));
    }
    if (session.tx === tx) session.tx = null;
    notifyBmSession(session, { type: 'ptt:status', active: false, mode: tx.mode, detail: reason || 'PTT 已釋放。' });
    return;
  }
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

  // Each browser login owns an independent BM UDP session. Never close other users' sessions here.

  // Software terminals use BrandMeister ODTP/REWIND on UDP 54006, not Homebrew RPTL/RPTK/RPTC.
  const socket = dgram.createSocket('udp4');
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token, callsign, radioId, baseRadioIdText, host, address: address.address, socket,
    ws: null, state: 'challenge', closed: false, startedAt: Date.now(), rxPackets: 0,
    protocol: 'odtp',
    subscriptions: new Set(),
    pendingSubscription: null
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
    const packetSequence = packet.readUInt32LE(12);
    socket.send(packet, 54006, session.address, (error) => {
      if (type === 0x0913 || type === 0x0916 || type === 0x0917 || type === 0x0918) {
        console.log('[bm-tx-udp] type=0x' + type.toString(16).padStart(4, '0') +
          ' payload=' + payload.length + ' sequence=' + packetSequence +
          ' realtime=' + Boolean(realtime) +
          ' result=' + (error ? 'error:' + error.message : 'sent-to-kernel'));
      }
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
    if (session.rxDecoder) { try { session.rxDecoder.stdin.end(); } catch {} try { session.rxDecoder.kill(); } catch {} }
    session.closed = true;
    if (session.rxDecoder) { try { session.rxDecoder.stdin.end(); } catch {} try { session.rxDecoder.kill(); } catch {} }
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

    // Capture the opaque 0x0a10 application/control payload for protocol identification.
    // The previous logs only exposed the outer REWIND type and total datagram length,
    // which is insufficient to distinguish a TMS ACK from unrelated control traffic.
    if (type === 0x0a10) {
      console.log('[bm-control-rx] type=0x0a10 payload=' + payload.length + 'B hex=' + payload.toString('hex'));
      // Decode observed BM control payloads conservatively. Text may be UTF-16LE/BE or UTF-8;
      // ASCII-only extraction silently drops Chinese because its UTF-16 high bytes are non-zero.
      if (payload.length >= 16) {
        const sourceId = payload.readUInt32LE(4) & 0xffffff;
        const destinationId = payload.readUInt32LE(8) & 0xffffff;
        const candidates = [];
        const addCandidate = (encoding, offset, text) => {
          const cleaned = String(text || '').replace(/\u0000/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
          if (!cleaned) return;
          const chars = Array.from(cleaned);
          const useful = chars.filter(ch => /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(ch)).length;
          const replacements = (cleaned.match(/\uFFFD/g) || []).length;
          const score = useful - replacements * 5;
          if (score > 0) candidates.push({ encoding, offset, text: cleaned, score });
        };
        for (let offset = 12; offset < payload.length; offset++) {
          const remaining = payload.length - offset;
          if (remaining >= 2 && remaining % 2 === 0) {
            try { addCandidate('utf-16le', offset, payload.toString('utf16le', offset)); } catch {}
            try {
              const be = Buffer.from(payload.subarray(offset));
              for (let i = 0; i + 1 < be.length; i += 2) { const b = be[i]; be[i] = be[i + 1]; be[i + 1] = b; }
              addCandidate('utf-16be', offset, be.toString('utf16le'));
            } catch {}
          }
          try { addCandidate('utf-8', offset, new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(offset))); } catch {}
        }
        candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
        const best = candidates[0];
        if (sourceId > 0 && destinationId > 0 && best && best.text.length >= 1) {
          console.log('[bm-control-rx] decoded-candidate source=' + sourceId + ' destination=' + destinationId +
            ' encoding=' + best.encoding + ' textOffset=' + best.offset +
            ' chars=' + best.text.length + ' text=' + JSON.stringify(best.text) + ' status=control-payload-only');
          notifyBmSession(session, {
            type: 'bm:sms:control-candidate', sourceId, destinationId,
            text: best.text, encoding: best.encoding, textOffset: best.offset,
            receivedAt: Date.now(), deliveryConfirmed: false
          });
        }
      }
    }

    // REWIND DMR Header-with-FLC / Terminator-with-FLC identifies the active
    // caller. FLC carries FLCO, destination ID (24-bit BE), then source ID.
    // This metadata is independent of whether the destination is a talkgroup
    // or a private DMR ID.
    if ((type === 0x0911 || type === 0x0912) && payload.length >= 9) {
      const callType = payload[0] === 0x03 ? 'private' : 'group';
      const destinationId = payload.readUIntBE(3, 3);
      const sourceId = payload.readUIntBE(6, 3);
      const active = type === 0x0911;
      notifyBmSession(session, {
        type: 'bm:talker',
        active,
        callType,
        sourceId,
        destinationId,
        receivedAt: Date.now()
      });
      console.log('[dmr-rx] ' + (active ? 'talker-start' : 'talker-end') +
        ' source=' + sourceId + ' destination=' + destinationId + ' callType=' + callType);
      return;
    }

    if (type >= 0x0910 && type <= 0x091f && type !== 0x0911 && type !== 0x0912) {
      // DMR Data Header (0x0916) and continuation PDUs (0x0917/0x0918)
      // are exposed as their PDU bytes by ODTP, not as full 33-byte RF bursts.
      session.rxDataFrames = (session.rxDataFrames || 0) + 1;
      const frameType = type & 0x0f;
      const diagnostic = {
        type: 'bm:data-frame',
        frameType: '0x' + type.toString(16).padStart(4, '0'),
        bytes: payload.length,
        payloadHex: payload.subarray(0, 96).toString('hex'),
        receivedAt: Date.now(),
        packetNumber: session.rxDataFrames
      };

      try {
        if (type === 0x0916 && payload.length === 12) {
          const header = DMRLib.DMR.DataHeader.from(payload);
          if (header) {
            session.rxDataAssembly = new DMRLib.DMR.Util.DataBlock(header);
            session.rxDataHeader = header;
            notifyBmSession(session, {
              type: 'bm:data-header',
              sourceId: header.src_id,
              destinationId: header.dst_id,
              callType: header.dstIsGroup ? '組呼' : '個呼',
              packetFormat: header.DPF,
              blocksToFollow: header.blocksToFollow || 0,
              receivedAt: Date.now()
            });
            diagnostic.sourceId = header.src_id;
            diagnostic.destinationId = header.dst_id;
          }
        } else if ((type === 0x0917 || type === 0x0918) && payload.length !== 12) {
          // A DMR data continuation PDU is exactly 12 bytes in this ODTP mapping.
          // BM can also emit empty ODTP notifications (18-byte REWIND datagram = 0-byte payload);
          // those are not data blocks and must never reach Raw/addPacket, which reads byte 0.
          diagnostic.error = 'ignored-non-pdu-payload-length';
          console.warn('[dmr-data-rx] ignored non-PDU type=0x' + type.toString(16).padStart(4, '0') +
            ' payload=' + payload.length + 'B expected=12B; assembly-preserved=' + Boolean(session.rxDataAssembly));
        } else if ((type === 0x0917 || type === 0x0918) && session.rxDataAssembly) {
          const header = session.rxDataHeader;
          const pdu = new DMRLib.DMR.Raw(payload, frameType);
          const accepted = session.rxDataAssembly.addPacket(pdu);
          diagnostic.sourceId = header ? header.src_id : null;
          diagnostic.destinationId = header ? header.dst_id : null;
          diagnostic.accepted = accepted;
          if (accepted && session.rxDataAssembly.remainPackets === 0) {
            const ipBytes = session.rxDataAssembly.getBuffer();
            session.rxDataAssembly = null;
            session.rxDataHeader = null;
            if (ipBytes) {
              const ipPacket = DMRLib.IP.IP4Packet.from(ipBytes);
              if (ipPacket && ipPacket.dst_port === DMRLib.Motorola.Network.PORT_TMS &&
                  ipPacket.src_port === DMRLib.Motorola.Network.PORT_TMS) {
                const sms = DMRLib.Protocols.TMS.from(ipPacket.payload);
                // Decode the actual TMS text bytes as UTF-16LE. The upstream helper has a
                // hand-written UTF-16 decoder with broken surrogate-pair handling; use Node's
                // native decoder and retain the raw bytes in logs for field diagnosis.
                const tmsPayload = Buffer.from(ipPacket.payload);
                let decodedText = '';
                if (tmsPayload.length > 6) {
                  decodedText = tmsPayload.subarray(6).toString('utf16le')
                    .replace(/^\r\n/, '')
                    .replace(/\u0000+$/g, '')
                    .trim();
                }
                if (!decodedText && sms && sms.text) decodedText = String(sms.text).replace(/^\r\n/, '').trim();
                if (decodedText) {
                  notifyBmSession(session, {
                    type: 'bm:sms:received',
                    sourceId: header.src_id,
                    destinationId: header.dst_id,
                    text: decodedText,
                    receivedAt: Date.now()
                  });
                  console.log('[dmr-sms-rx] source=' + header.src_id + ' destination=' + header.dst_id +
                    ' chars=' + decodedText.length + ' tmsMsgId=0x' + (tmsPayload[4] || 0).toString(16).padStart(2, '0') +
                    ' rawTextHex=' + tmsPayload.subarray(6).toString('hex') +
                    ' text=' + JSON.stringify(decodedText));
                } else {
                  console.log('[dmr-data-rx] reassembled TMS payload did not decode as text; tmsHex=' + tmsPayload.toString('hex'));
                }
              } else {
                console.log('[dmr-data-rx] reassembled payload is not a recognized TMS UDP/IP packet');
              }
            } else {
              console.warn('[dmr-data-rx] data block CRC32 or padding validation failed');
            }
            // A requested data-layer response is required for BrandMeister TextCapture
            // store-and-forward. Respond only when the received header asks for it.
            if (header && header.responseRequested && header.DPF === DMRLib.DMR.DataHeader.DPF_CONFIRMED) {
              try {
                const response = new DMRLib.DMR.DataHeader.Response();
                response.dst_id = header.src_id;
                response.src_id = session.radioId;
                response.serviceAccessPoint = header.serviceAccessPoint;
                response.blocksToFollow = 0;
                response.type = 1; // ETSI response type ACK
                session.sendRewind(0x0916, response.getBuffer(), 0x01, true);
                console.log('[dmr-sms-rx] sent requested data ACK to=' + header.src_id);
              } catch (ackError) {
                console.error('[dmr-sms-rx] ACK construction failed=' + ackError.message);
              }
            }
          }
        }
      } catch (error) {
        console.error('[dmr-data-rx] parse error=' + error.message);
      }

      // Keep bounded raw diagnostics even for malformed or non-TMS data.
      notifyBmSession(session, diagnostic);
      if (session.rxDataFrames === 1 || session.rxDataFrames % 20 === 0) {
        console.log('[dmr-data-rx] packet=' + session.rxDataFrames +
          ' type=0x' + type.toString(16).padStart(4, '0') +
          ' payload=' + payload.length + 'B hex=' + payload.subarray(0, 24).toString('hex'));
      }
      return;
    }

    if (type === 0x0920) {
      // One ODTP voice datagram carries 3 AMBE frames = 60 ms of audio.
      // Record packet arrival gaps to distinguish network jitter from browser playback jitter.
      const packetNow = Date.now();
      const packetGapMs = session.rxLastAudioPacketAt ? packetNow - session.rxLastAudioPacketAt : 0;
      session.rxLastAudioPacketAt = packetNow;
      session.rxAudioPackets = (session.rxAudioPackets || 0) + 1;
      if (session.rxAudioPackets === 1 || session.rxAudioPackets % 20 === 0 || packetGapMs >= 75) {
        console.log('[dmr-rx] packet=' + session.rxAudioPackets + ' payload=' + payload.length +
          ' frames=' + (payload.length === 27 ? 3 : 0) + ' packetGapMs=' + packetGapMs +
          ' decodedFrames=' + (session.rxDecodedFrames || 0) +
          ' decodeRemainderBytes=' + (session.rxDecoderOutput ? session.rxDecoderOutput.length : 0) +
          ' ws=' + Boolean(session.ws && session.ws.readyState === WebSocket.OPEN));
      }
      // BrandMeister ODTP audio payload: three consecutive 9-byte AMBE+2 frames.
      if (payload.length === 27 && session.ws && session.ws.readyState === WebSocket.OPEN) {
        if (!session.rxDecoder) {
          try {
            session.rxDecoder = spawn('/app/ambe-encoder', ['--decode'], { stdio: ['pipe', 'pipe', 'pipe'] });
            session.rxDecoderOutput = Buffer.alloc(0);
            session.rxDecodedFrames = 0;
            session.rxDecodeOutputBytes = 0;
            session.rxDecoder.on('error', (error) => console.error('[dmr-rx] decoder error=' + error.message));
            session.rxDecoder.stderr.on('data', (chunk) => console.error('[ambe-decoder]', chunk.toString().trim()));
            session.rxDecoder.on('close', (code) => console.log('[dmr-rx] decoder closed code=' + code +
              ' packets=' + (session.rxAudioPackets || 0) +
              ' decodedFrames=' + (session.rxDecodedFrames || 0) +
              ' outputBytes=' + (session.rxDecodeOutputBytes || 0) +
              ' remainderBytes=' + (session.rxDecoderOutput ? session.rxDecoderOutput.length : 0)));
            session.rxDecoder.stdout.on('data', (chunk) => {
              session.rxDecodeOutputBytes += chunk.length;
              session.rxDecoderOutput = Buffer.concat([session.rxDecoderOutput, chunk]);
              while (session.rxDecoderOutput.length >= 320) {
                const pcm = session.rxDecoderOutput.subarray(0, 320);
                session.rxDecoderOutput = session.rxDecoderOutput.subarray(320);
                session.rxDecodedFrames++;
                if (session.rxDecodedFrames === 1 || session.rxDecodedFrames % 100 === 0) {
                  console.log('[dmr-rx] decode-progress packets=' + (session.rxAudioPackets || 0) +
                    ' decodedFrames=' + session.rxDecodedFrames +
                    ' expectedFrames=' + ((session.rxAudioPackets || 0) * 3) +
                    ' outputBytes=' + session.rxDecodeOutputBytes +
                    ' remainderBytes=' + session.rxDecoderOutput.length +
                    ' ws=' + Boolean(session.ws && session.ws.readyState === WebSocket.OPEN));
                }
                if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(pcm, { binary: true });
              }
            });
            console.log('[dmr-rx] AMBE decoder started');
          } catch (error) {
            console.error('[dmr-rx] cannot start decoder=' + error.message);
            return;
          }
        }
        try {
          session.rxDecoder.stdin.write(payload);
        } catch (error) {
          console.error('[dmr-rx] decoder input error=' + error.message);
        }
      }
      return;
    }

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
    if (type === 0x0901) {
      // pyspot_rx confirms a successful subscription with an incoming 0x0901 frame.
      if (session.pendingSubscription) session.pendingSubscription.resolve();
      return;
    }
    if (type === 0x0929) {
      console.error('[bm-rx] failure code payload=' + msg.subarray(18).toString('hex'));
      return fail(200, 'rejected', 'BM ODTP 回覆失敗碼；請查看 Render 日誌中的 failure payload。');
    }

    if (type === 0x0000 && authSent && !provisioned) {
      // The reference ODTP client treats the post-auth keepalive as the login confirmation.
      // Send terminal configuration, but do not subscribe to any talkgroup at login.
      provisioned = true;
      // Use BrandMeister's default AMBE frame mode. OpenDMR encodes and decodes
      // standard 72-bit AMBE+2 frames with A/B/C FEC blocks. REWIND option 0x02
      // requests linear AMBE without FEC and is not compatible with that format.
      const config = Buffer.alloc(4);
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
