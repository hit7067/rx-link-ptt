
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

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
    bmAdapterConfigured: false,
    message: '目前是介面測試模式，尚未連接 BrandMeister。',
    features: {
      webUi: true,
      localTextChat: true,
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
    text: '已連接 RX link PTT 網頁服務；目前尚未連接 BM。'
  }));

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type !== 'chat' || typeof data.text !== 'string') return;

    const text = data.text.trim().slice(0, 500);
    const callsign = String(data.callsign || 'WEB USER').trim().slice(0, 32);
    if (!text) return;

    const packet = JSON.stringify({
      type: 'chat',
      callsign,
      text,
      time: new Date().toISOString()
    });

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(packet);
      }
    }
  });

  ws.on('close', () => clients.delete(ws));
});


app.post('/api/bm/probe', async (req, res) => {
  const radioId = Number(req.body?.radioId);
  const host = String(req.body?.host || '').trim().toLowerCase();
  if (!Number.isInteger(radioId) || radioId < 1 || radioId > 999999999) {
    return res.status(400).json({ ok: false, detail: 'DMR ID 格式不正確' });
  }
  if (!(host.endsWith('.master.brandmeister.network') || host === 'master.brandmeister.network')) {
    return res.status(400).json({ ok: false, detail: 'Master 必須是 BrandMeister 官方 master 網域' });
  }
  try {
    const address = await dns.lookup(host);
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      res.json({ ok: false, stage: 'timeout', detail: 'Render 未在 5 秒內收到 BM challenge；尚不能判定是出站 UDP、Master 或路由問題。' });
    }, 5000);
    socket.on('error', () => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (!res.headersSent) res.json({ ok: false, stage: 'socket-error', detail: 'Render UDP socket 發生錯誤。' });
    });
    socket.on('message', (msg) => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      const tag = msg.toString('ascii', 0, Math.min(7, msg.length));
      const challenge = (tag.startsWith('RPTACK') || tag.startsWith('RPTL')) && msg.length >= 8;
      res.json({
        ok: challenge,
        stage: challenge ? 'challenge-received' : 'udp-reply-received',
        detail: challenge ? '已從 BM Master 收到 Homebrew challenge；Render 出站與回程 UDP 初步可用。尚未驗證密碼或完成登入。' : '收到 UDP 回應，但不是可辨識的 Homebrew challenge。',
        responseTag: tag.slice(0, 7)
      });
    });
    socket.connect(62031, address.address, () => {
      const packet = Buffer.alloc(8);
      packet.write('RPTL', 0, 'ascii');
      packet.writeUInt32BE(radioId, 4);
      socket.send(packet);
    });
  } catch {
    res.status(400).json({ ok: false, stage: 'dns-error', detail: 'Master 網域無法解析。' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RX link PTT listening on port ${PORT}`);
});
