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
  const configured = Boolean(
    process.env.BM_ADAPTER_ENABLED === 'true' &&
    process.env.BM_RADIO_ID &&
    process.env.BM_HOTSPOT_PASSWORD &&
    process.env.BM_MASTER_HOST &&
    process.env.BM_MASTER_PORT
  );
  res.json({
    app: 'RX link PTT',
    status: configured ? 'adapter-configured' : 'not-connected',
    bmAdapterConfigured: configured,
    message: configured
      ? '設定值已存在；仍需由相容的 DMR gateway adapter 實際連線驗證。'
      : '尚未設定 BM gateway adapter。此版本不會假裝已連上 BrandMeister。',
    features: { webUi: true, localTextChat: true, liveDmrAudio: false, privateCall: false, dmrSms: false }
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'system', text: '已連接 RX link PTT 網頁服務；目前是介面測試模式，尚未連接 BM。' }));
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
server.listen(PORT, '0.0.0.0', () => console.log(`RX link PTT listening on http://0.0.0.0:${PORT}`));
