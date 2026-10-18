require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const dgram = require('dgram');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const PORT = Number(process.env.PORT || 3000);
const clients = new Set();

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/udp-probe', (_req, res) => {
  const socket = dgram.createSocket('udp4');
  const id = 0x5258;
  const name = Buffer.from('google.com');
  const qname = Buffer.concat([Buffer.from([6]), name.subarray(0, 6), Buffer.from([3]), name.subarray(7), Buffer.from([0])]);
  const header = Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const question = Buffer.from([0, 1, 0, 1]);
  const packet = Buffer.concat([header, qname, question]);
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { socket.close(); } catch {}
    res.json(result);
  };
  const timer = setTimeout(() => finish({ udpOutbound: false, responseReceived: false, test: 'UDP DNS probe', detail: 'No UDP reply received within 2500 ms; this does not by itself prove all UDP destinations are blocked.' }), 2500);
  socket.on('message', (msg) => {
    if (msg.length >= 12 && msg.readUInt16BE(0) === id && (msg[2] & 0x80)) {
      finish({ udpOutbound: true, responseReceived: true, test: 'UDP DNS probe', detail: 'A UDP reply reached the Render service. This tests DNS UDP only, not BrandMeister protocol compatibility.' });
    }
  });
  socket.on('error', (err) => finish({ udpOutbound: false, responseReceived: false, test: 'UDP DNS probe', detail: err.code || 'UDP socket error' }));
  socket.send(packet, 53, '1.1.1.1', (err) => {
    if (err) finish({ udpOutbound: false, responseReceived: false, test: 'UDP DNS probe', detail: err.code || 'UDP send failed' });
  });
});

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
