
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

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RX link PTT listening on port ${PORT}`);
});
