const statusEl = document.getElementById('status');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatText = document.getElementById('chatText');
const pttButton = document.getElementById('pttButton');
const pttNote = document.getElementById('pttNote');
const micLevelFill = document.getElementById('micLevelFill');
const micLevelText = document.getElementById('micLevelText');
const privateMicLevelFill = document.getElementById('privateMicLevelFill');
const privateMicLevelText = document.getElementById('privateMicLevelText');
const groupGain = document.getElementById('groupGain');
const groupGainValue = document.getElementById('groupGainValue');
const groupCompressor = document.getElementById('groupCompressor');
const privateGain = document.getElementById('privateGain');
const privateGainValue = document.getElementById('privateGainValue');
const privateCompressor = document.getElementById('privateCompressor');
const privatePttButton = document.getElementById('privatePttButton');
const privatePttNote = document.getElementById('privatePttNote');
const callsignSetting = document.getElementById('bmCallsign');
const radioIdSetting = document.getElementById('bmRadioId');
const identityCallsign = document.getElementById('identityCallsign');
const identityRadioId = document.getElementById('identityRadioId');
const privateSearch = document.getElementById('privateSearch');
const privateResults = document.getElementById('privateResults');
const privateId = document.getElementById('privateId');
const privateTarget = document.getElementById('privateTarget');
const rxOutputVolumeInput = document.getElementById('rxOutputVolume');
const rxOutputVolumeValue = document.getElementById('rxOutputVolumeValue');
const rxLevelFill = document.getElementById('rxLevelFill');
const rxLevelText = document.getElementById('rxLevelText');
const rxTalkerName = document.getElementById('rxTalkerName');
const rxTalkerDetail = document.getElementById('rxTalkerDetail');
let rxTalkerLookupId = '';
let rxTalkerLookupSequence = 0;

let socket = null;
let reconnectTimer = null;
let lookupTimer = null;
let bmSessionToken = null;
let selectedPrivateContact = null;
let pttPressed = false;
let micCapture = null;
let micStartPromise = null;
let micGainNode = null;
let micCompressorNode = null;
let activeAudioMode = 'group';
let rxAudioContext = null;
let rxOutputGainNode = null;
let rxOutputVolumeLevel = 1;
let rxLastMeterUpdate = 0;
const RX_FRAME_MS = 20;
const RX_FRAME_SAMPLES = 160;
const RX_FRAME_BYTES = RX_FRAME_SAMPLES * 2;
const RX_JITTER_TARGET_FRAMES = 15; // 300 ms startup/rebuffer target; Render logs showed RX packet gaps up to ~257 ms
const RX_SCHEDULE_AHEAD_SECONDS = 0.3;
const rxPcmQueue = [];
let rxPlaybackStarted = false;
let rxNextPlayTime = 0;
let rxAudioFrames = 0;
let rxFramesDropped = 0;
let rxScheduler = null;

function ensureRxAudioGraph() {
  if (!rxAudioContext) rxAudioContext = new AudioContext();
  if (!rxOutputGainNode) {
    rxOutputGainNode = rxAudioContext.createGain();
    rxOutputGainNode.gain.value = rxOutputVolumeLevel;
    rxOutputGainNode.connect(rxAudioContext.destination);
  }
  return rxAudioContext;
}
function applyRxOutputVolume() {
  const parsed = Number(rxOutputVolumeInput.value);
  rxOutputVolumeLevel = Number.isFinite(parsed) ? Math.max(0, Math.min(2, parsed)) : 1;
  if (rxOutputGainNode && rxAudioContext) {
    rxOutputGainNode.gain.setTargetAtTime(rxOutputVolumeLevel, rxAudioContext.currentTime, 0.025);
  }
  if (rxOutputVolumeValue) rxOutputVolumeValue.textContent = Math.round(rxOutputVolumeLevel * 100) + '%';
  try { localStorage.setItem('rxlink.rxOutputVolume', String(rxOutputVolumeLevel)); } catch {}
}
try {
  // Version the setting to recover from the first release, which accidentally
  // converted a missing localStorage value (null) into 0 and saved a muted level.
  const rxVolumeSettingVersion = localStorage.getItem('rxlink.rxOutputVolumeVersion');
  const savedRxVolumeText = localStorage.getItem('rxlink.rxOutputVolume');
  if (rxVolumeSettingVersion !== '1') {
    rxOutputVolumeLevel = 1;
    localStorage.setItem('rxlink.rxOutputVolumeVersion', '1');
    localStorage.setItem('rxlink.rxOutputVolume', '1');
  } else if (savedRxVolumeText !== null) {
    const savedRxVolume = Number(savedRxVolumeText);
    if (Number.isFinite(savedRxVolume)) rxOutputVolumeLevel = Math.max(0, Math.min(2, savedRxVolume));
  }
} catch {}
if (rxOutputVolumeInput) {
  rxOutputVolumeInput.value = String(rxOutputVolumeLevel);
  rxOutputVolumeInput.addEventListener('input', applyRxOutputVolume);
}
applyRxOutputVolume();

async function resumeRxAudio() {
  try {
    ensureRxAudioGraph();
    if (rxAudioContext.state !== 'running') await rxAudioContext.resume();
    startRxScheduler();
  } catch (error) {
    console.warn('[dmr-rx] audio output unavailable', error);
  }
}

function startRxScheduler() {
  if (rxScheduler !== null) return;
  rxScheduler = setInterval(pumpRxJitterBuffer, 5);
}

function playRxPcmFrame(buffer, startAt) {
  const context = rxAudioContext;
  const audio = context.createBuffer(1, RX_FRAME_SAMPLES, 8000);
  const channel = audio.getChannelData(0);
  const view = new DataView(buffer);
  for (let i = 0; i < RX_FRAME_SAMPLES; i++) {
    channel[i] = view.getInt16(i * 2, true) / 32768;
  }
  const source = context.createBufferSource();
  source.buffer = audio;
  source.connect(rxOutputGainNode || context.destination);
  // Measure the PCM frame for diagnostics, but update the meter when the
  // scheduled audio has actually finished playing—not when it is merely queued.
  let sumSquares = 0;
  for (let i = 0; i < channel.length; i++) sumSquares += channel[i] * channel[i];
  const level = Math.min(1, Math.sqrt(sumSquares / Math.max(1, channel.length)));
  source.onended = () => {
    if (rxPcmQueue.length === 0 && rxNextPlayTime <= rxAudioContext.currentTime + 0.025) {
      if (rxLevelFill) rxLevelFill.style.width = '0%';
      if (rxLevelText) rxLevelText.textContent = '接收音量 0%';
      return;
    }
    const nowMs = performance.now();
    if (nowMs - rxLastMeterUpdate >= 50) {
      if (rxLevelFill) rxLevelFill.style.width = Math.round(level * 100) + '%';
      if (rxLevelText) rxLevelText.textContent = '接收音量 ' + Math.round(level * 100) + '%';
      rxLastMeterUpdate = nowMs;
    }
  };
  source.start(startAt);
  rxAudioFrames++;
  if (rxAudioFrames === 1 || rxAudioFrames % 100 === 0) {
    const traffic = document.getElementById('bmTrafficStatus');
    if (traffic) {
      traffic.textContent = '接收播放 ' + rxAudioFrames + ' 幀 · 每幀 20 ms · 緩衝 ' +
        rxPcmQueue.length + ' 幀 · 丟棄 ' + rxFramesDropped + ' 幀';
    }
  }
}

function pumpRxJitterBuffer() {
  if (!rxAudioContext || rxAudioContext.state !== 'running') return;
  const now = rxAudioContext.currentTime;

  // If the queue drained and all scheduled audio has played, rebuffer instead of
  // starting the next isolated frame immediately (which sounds like a dropout).
  if (rxPlaybackStarted && rxPcmQueue.length === 0 && rxNextPlayTime <= now + 0.001) {
    rxPlaybackStarted = false;
    // Clear the receive meter only after the final scheduled PCM frame has played.
    if (rxLevelFill) rxLevelFill.style.width = '0%';
    if (rxLevelText) rxLevelText.textContent = '接收音量 0%';
  }
  if (!rxPlaybackStarted) {
    if (rxPcmQueue.length < RX_JITTER_TARGET_FRAMES) return;
    rxPlaybackStarted = true;
    // Start scheduling immediately, then fill the 300 ms horizon below. Starting at the horizon itself starves the scheduler and defeats pre-buffering.
    rxNextPlayTime = now + 0.005;
  }

  // Schedule PCM at exact 20 ms intervals against AudioContext time. Incoming
  // WebSocket messages may arrive in bursts (three frames per 60 ms DMR packet).
  const scheduleLimit = now + RX_SCHEDULE_AHEAD_SECONDS;
  while (rxPcmQueue.length > 0 && rxNextPlayTime < scheduleLimit) {
    const frame = rxPcmQueue.shift();
    playRxPcmFrame(frame, Math.max(rxNextPlayTime, now + 0.005));
    rxNextPlayTime = Math.max(rxNextPlayTime, now + 0.005) + RX_FRAME_MS / 1000;
  }
}

function enqueueRxPcmFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== RX_FRAME_BYTES) {
    console.warn('[dmr-rx] discarded invalid PCM frame', buffer?.byteLength);
    return;
  }
  ensureRxAudioGraph();
  if (rxAudioContext.state !== 'running') rxAudioContext.resume().catch(() => {});
  startRxScheduler();

  // Bound memory if the browser falls behind. Drop oldest frames to keep latency
  // bounded rather than playing seconds of stale audio.
  const MAX_RX_QUEUE_FRAMES = 150;
  if (rxPcmQueue.length >= MAX_RX_QUEUE_FRAMES) {
    const excess = rxPcmQueue.length - MAX_RX_QUEUE_FRAMES + 1;
    rxPcmQueue.splice(0, excess);
    rxFramesDropped += excess;
    console.warn('[dmr-rx] jitter queue overflow; dropped frames=' + excess);
  }
  rxPcmQueue.push(buffer);
}

function subscribeCurrentTalkgroup() {
  // Do not silently rejoin a group while the Private Call panel is active.
  if (document.getElementById('private') && !document.getElementById('private').classList.contains('hidden')) return;
  const targetId = document.getElementById('talkgroup')?.value?.trim();
  if (bmSessionToken && targetId && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'bm:subscribe', sessionToken: bmSessionToken, targetId }));
  }
}

function unsubscribeCurrentTalkgroup() {
  if (bmSessionToken && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'bm:unsubscribe', sessionToken: bmSessionToken }));
  }
  rxPcmQueue.length = 0;
  rxPlaybackStarted = false;
  rxNextPlayTime = 0;
  const traffic = document.getElementById('bmTrafficStatus');
  if (traffic) traffic.textContent = '已要求解除所有 Talkgroup 訂閱。';
}

function getAudioSettings(mode) {
  const gainInput = mode === 'private' ? privateGain : groupGain;
  const compressorInput = mode === 'private' ? privateCompressor : groupCompressor;
  return { gain: Number(gainInput.value) || 1, compressor: compressorInput.checked };
}
function syncAudioSettings(sourceMode) {
  const sourceGain = sourceMode === 'private' ? privateGain : groupGain;
  const sourceComp = sourceMode === 'private' ? privateCompressor : groupCompressor;
  const gain = Number(sourceGain.value);
  [groupGain, privateGain].forEach((input) => { input.value = String(gain); });
  [groupGainValue, privateGainValue].forEach((label) => { label.textContent = gain.toFixed(1) + '×'; });
  [groupCompressor, privateCompressor].forEach((input) => { input.checked = sourceComp.checked; });
  try {
    localStorage.setItem('rxlink.micGain', String(gain));
    localStorage.setItem('rxlink.micCompressor', String(sourceComp.checked));
  } catch {}
  applyLiveAudioSettings();
}
function applyLiveAudioSettings() {
  if (!micGainNode || !micCompressorNode) return;
  const settings = getAudioSettings(activeAudioMode);
  micGainNode.gain.setTargetAtTime(settings.gain, micGainNode.context.currentTime, 0.025);
  micCompressorNode.threshold.setTargetAtTime(settings.compressor ? -20 : 0, micCompressorNode.context.currentTime, 0.025);
  micCompressorNode.ratio.setTargetAtTime(settings.compressor ? 3 : 1, micCompressorNode.context.currentTime, 0.025);
}
try {
  const savedGain = localStorage.getItem('rxlink.micGain');
  const savedComp = localStorage.getItem('rxlink.micCompressor');
  if (savedGain !== null) { const parsedGain = Number(savedGain); const initialGain = Number.isFinite(parsedGain) ? Math.max(0.5, Math.min(3, parsedGain)) : 1; groupGain.value = String(initialGain); privateGain.value = String(initialGain); }
  if (savedComp !== null) { groupCompressor.checked = savedComp === 'true'; privateCompressor.checked = savedComp === 'true'; }
} catch {}
[groupGain, privateGain].forEach((input) => input.addEventListener('input', () => syncAudioSettings(input === privateGain ? 'private' : 'group')));
[groupCompressor, privateCompressor].forEach((input) => input.addEventListener('change', () => syncAudioSettings(input === privateCompressor ? 'private' : 'group')));
syncAudioSettings('group');

function addMessage(text, callsign = 'SYSTEM', time = '') {
  if (!messagesEl) return;
  const item = document.createElement('div');
  item.className = 'message';
  const name = document.createElement('strong');
  name.textContent = callsign;
  const body = document.createElement('div');
  body.textContent = text;
  item.append(name, body);
  if (time) {
    const date = new Date(time);
    const small = document.createElement('small');
    small.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
    item.appendChild(small);
  }
  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function showRxTalker(data) {
  if (!rxTalkerName || !rxTalkerDetail) return;
  const sourceId = String(data.sourceId || '');
  const destinationId = String(data.destinationId || '');
  const callType = data.callType === 'private' ? '個呼' : '組呼';
  const destinationLabel = data.callType === 'private' ? '目標 DMR ID ' : '目標 TG ';
  const seq = ++rxTalkerLookupSequence;

  if (!data.active) {
    rxTalkerName.textContent = sourceId ? '通話結束 · DMR ID ' + sourceId : '目前沒有接收中的通話';
    rxTalkerDetail.textContent = sourceId
      ? callType + ' · ' + destinationLabel + destinationId + ' · 已收到通話結束標頭'
      : '等待 BrandMeister 語音通話標頭。';
    return;
  }

  rxTalkerLookupId = sourceId;
  // Source and destination IDs come directly from BM's FLC; never wait for a directory lookup to show them.
  rxTalkerName.textContent = '正在接收：DMR ID ' + sourceId;
  rxTalkerDetail.textContent = callType + ' · ' + destinationLabel + destinationId + ' · BM 已提供 ID，補查呼號中…';

  // Resolve the source DMR ID against the public RadioID directory. If the
  // directory is unavailable, the numeric ID remains visible immediately.
  try {
    const response = await fetch('/api/dmrid/search?q=' + encodeURIComponent(sourceId));
    if (!response.ok) throw new Error('lookup failed');
    const result = await response.json();
    if (seq !== rxTalkerLookupSequence || rxTalkerLookupId !== sourceId) return;
    const user = (result.results || []).find((entry) => String(entry.id) === sourceId);
    if (user && user.callsign) {
      rxTalkerName.textContent = user.callsign + '（DMR ID ' + sourceId + '）正在發射';
      const person = user.name ? ' · ' + user.name : '';
      const qth = user.city ? ' · ' + user.city : '';
      rxTalkerDetail.textContent = callType + ' · ' + destinationLabel + destinationId + person + qth;
    } else {
      rxTalkerName.textContent = 'DMR ID ' + sourceId + ' 正在發射';
      rxTalkerDetail.textContent = callType + ' · ' + destinationLabel + destinationId + ' · 公開名錄沒有精確呼號資料';
    }
  } catch {
    if (seq !== rxTalkerLookupSequence || rxTalkerLookupId !== sourceId) return;
    rxTalkerName.textContent = 'DMR ID ' + sourceId + ' 正在發射';
    rxTalkerDetail.textContent = callType + ' · ' + destinationLabel + destinationId + ' · 呼號查詢暫時不可用';
  }
}

function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    statusEl.textContent = '網頁已連線';
    statusEl.classList.add('online');
    if (bmSessionToken) {
      socket.send(JSON.stringify({ type: 'bm:attach', sessionToken: bmSessionToken }));
      subscribeCurrentTalkgroup();
    }
  });
  socket.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) { enqueueRxPcmFrame(event.data); return; }
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'system') addMessage(data.text, 'SYSTEM');
    else if (data.type === 'chat') addMessage(data.text, data.callsign, data.time);
    else if (data.type === 'bm:status') {
      const status = document.getElementById('bmConnectionStatus');
      const result = document.getElementById('bmLoginResult');
      status.textContent = data.connected ? ('BM 已連線：' + data.callsign + ' · ' + data.master) : (data.detail || 'BM 已斷線');
      result.textContent = data.detail || '';
      document.getElementById('bmDisconnectButton').disabled = !data.connected;
      statusEl.textContent = data.connected ? 'BM 已連線' : '網頁已連線';
      statusEl.classList.toggle('online', Boolean(data.connected));
      if (!data.connected) bmSessionToken = null;
    } else if (data.type === 'bm:talker') {
      showRxTalker(data);
    } else if (data.type === 'bm:dmrd') {
      document.getElementById('bmTrafficStatus').textContent =
        '已收到 DMR 封包 ' + data.packets + ' 個 · 來源 ' + data.sourceId + ' → 目的 ' + data.destinationId + ' · TS' + data.slot + (data.end ? ' · 通話結束' : '');
    } else if (data.type === 'bm:rx-status') {
      document.getElementById('bmTrafficStatus').textContent = data.detail || '接收訂閱狀態更新。';
    } else if (data.type === 'ptt:status') {
      (data.mode === 'private' ? privatePttNote : pttNote).textContent = data.detail || '';
    }
  });
  socket.addEventListener('close', () => {
    statusEl.textContent = '連線中斷';
    statusEl.classList.remove('online');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 3000);
  });
  socket.addEventListener('error', () => {
    statusEl.textContent = '連線異常';
    statusEl.classList.remove('online');
  });
}

function showPanel(panelId) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panelId));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== panelId));
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    showPanel(button.dataset.panel);
    if (button.dataset.panel === 'private') unsubscribeCurrentTalkgroup();
    else if (button.dataset.panel === 'ptt') subscribeCurrentTalkgroup();
  });
});
document.getElementById('goSettings').addEventListener('click', () => showPanel('settings'));

function updateIdentity() {
  const callsign = callsignSetting.value.trim().toUpperCase();
  const radioId = radioIdSetting.value.trim();
  identityCallsign.textContent = callsign || '尚未設定';
  identityRadioId.textContent = radioId || '尚未設定';
  try {
    localStorage.setItem('rxlink.callsign', callsign);
    localStorage.setItem('rxlink.radioId', radioId);
  } catch {}
}
try {
  callsignSetting.value = localStorage.getItem('rxlink.callsign') || '';
  radioIdSetting.value = localStorage.getItem('rxlink.radioId') || '';
} catch {}
updateIdentity();
callsignSetting.addEventListener('input', updateIdentity);
radioIdSetting.addEventListener('input', updateIdentity);

function updateMicMeter(level) {
  const percent = Math.max(0, Math.min(100, Math.round(level * 100)));
  [micLevelFill, privateMicLevelFill].forEach((fill) => {
    if (fill) fill.style.width = percent + '%';
  });
  [micLevelText, privateMicLevelText].forEach((label) => {
    if (label) label.textContent = pttPressed ? ('麥克風音量 ' + percent + '%') : '麥克風未啟用';
  });
}

function setPttPressed(button, note, pressed) {
  button.classList.toggle('pressed', pressed);
  button.textContent = pressed ? 'PTT 按下中' : '按住 PTT';
  note.textContent = pressed
    ? '正在啟用麥克風並傳送 AMBE+2 語音…'
    : (bmSessionToken ? 'PTT 已釋放。' : '請先在設定頁連線 BM。');
}

async function startMicCapture(note, mode) {
  if (micStartPromise) return micStartPromise;
  micStartPromise = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false
    });
    if (!pttPressed || !bmSessionToken) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    // Browser input is commonly 48 kHz. Low-pass before decimating to 8 kHz
    // so out-of-band audio does not alias into speech frequencies.
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = Math.min(3400, context.sampleRate * 0.42);
    lowpass.Q.value = 0.707;
    const gainNode = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.knee.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.22;
    const processor = context.createScriptProcessor(256, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    let samples = new Int16Array(160);
    let sampleCount = 0;
    let resamplePosition = 0;
    const inputRate = context.sampleRate;
    processor.onaudioprocess = (event) => {
      if (!pttPressed || !socket || socket.readyState !== WebSocket.OPEN || !bmSessionToken) return;
      const input = event.inputBuffer.getChannelData(0);
      let sumSquares = 0;
      for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i];
      // Scale RMS into a useful visual range while retaining headroom.
      updateMicMeter(Math.min(1, Math.sqrt(sumSquares / Math.max(1, input.length)) * 3.2));
      while (resamplePosition < input.length) {
        const index = Math.floor(resamplePosition);
        const fraction = resamplePosition - index;
        const first = input[Math.min(input.length - 1, index)] || 0;
        const second = input[Math.min(input.length - 1, index + 1)] || 0;
        const sample = first + (second - first) * fraction;
        // Use a soft limiter instead of hard clipping. The old 3x–8x default gain
        // frequently slammed speech peaks against +/-32767, producing harsh distortion.
        const scaled = Math.tanh(sample);
        samples[sampleCount++] = scaled < 0 ? Math.round(scaled * 32768) : Math.round(scaled * 32767);
        if (sampleCount === 160) {
          const frame = new ArrayBuffer(320);
          const view = new DataView(frame);
          for (let j = 0; j < 160; j++) view.setInt16(j * 2, samples[j], true);
          socket.send(frame);
          samples = new Int16Array(160);
          sampleCount = 0;
        }
        resamplePosition += inputRate / 8000;
      }
      resamplePosition -= input.length;
    };
    activeAudioMode = mode;
    const settings = getAudioSettings(mode);
    gainNode.gain.value = settings.gain;
    compressor.threshold.value = settings.compressor ? -20 : 0;
    compressor.ratio.value = settings.compressor ? 3 : 1;
    source.connect(lowpass);
    // Apply user gain before compression so loud peaks are controlled instead of
    // amplifying an already-compressed signal into clipping.
    lowpass.connect(gainNode);
    gainNode.connect(compressor);
    compressor.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    micGainNode = gainNode;
    micCompressorNode = compressor;
    micCapture = { stream, context, source, lowpass, gainNode, compressor, processor, silent };
    const trackSettings = stream.getAudioTracks()[0]?.getSettings?.() || {};
    note.textContent = `麥克風已啟用：輸入 ${context.sampleRate} Hz → 重取樣 8 kHz → AMBE+2。${trackSettings.autoGainControl ? ' AGC 開' : ' AGC 關'}／${trackSettings.noiseSuppression ? '降噪開' : '降噪關'}`;
  })().catch((error) => {
    note.textContent = '無法啟用麥克風：' + (error && error.message ? error.message : '請確認瀏覽器麥克風權限。');
    if (socket && socket.readyState === WebSocket.OPEN && bmSessionToken) {
      socket.send(JSON.stringify({ type: 'ptt-stop', sessionToken: bmSessionToken, mode }));
    }
    throw error;
  }).finally(() => { micStartPromise = null; });
  return micStartPromise;
}

function stopMicCapture() {
  if (!micCapture) return;
  const capture = micCapture;
  micCapture = null;
  capture.processor.onaudioprocess = null;
  try { capture.source.disconnect(); } catch {}
  try { capture.lowpass.disconnect(); } catch {}
  try { capture.gainNode.disconnect(); } catch {}
  try { capture.compressor.disconnect(); } catch {}
  try { capture.processor.disconnect(); } catch {}
  micGainNode = null;
  micCompressorNode = null;
  try { capture.silent.disconnect(); } catch {}
  capture.stream.getTracks().forEach((track) => track.stop());
  capture.context.close().catch(() => {});
  updateMicMeter(0);
}
function wirePtt(button, note, mode) {
  const press = () => {
    if (pttPressed) return;
    pttPressed = true;
    setPttPressed(button, note, true);
    if (socket && socket.readyState === WebSocket.OPEN && bmSessionToken) {
      const targetId = mode === 'private' ? privateId.value.trim() : document.getElementById('talkgroup').value.trim();
      const targetCallsign = mode === 'private' && selectedPrivateContact ? selectedPrivateContact.callsign : '';
      socket.send(JSON.stringify({ type: 'ptt-start', sessionToken: bmSessionToken, mode, targetId, targetCallsign }));
      startMicCapture(note, mode).catch(() => {});
    } else {
      note.textContent = '尚未建立 BM 持續連線；請先到設定頁登入。';
    }
  };
  const release = () => {
    if (!pttPressed) return;
    pttPressed = false;
    stopMicCapture();
    setPttPressed(button, note, false);
    if (socket && socket.readyState === WebSocket.OPEN && bmSessionToken) {
      socket.send(JSON.stringify({ type: 'ptt-stop', sessionToken: bmSessionToken, mode }));
    }
  };
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); press(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => button.addEventListener(name, release));
  button.addEventListener('keydown', (event) => {
    if (event.repeat || (event.code !== 'Space' && event.code !== 'Enter')) return;
    event.preventDefault(); press();
  });
  button.addEventListener('keyup', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') release();
  });
}
wirePtt(pttButton, pttNote, 'group');
document.getElementById('talkgroup').addEventListener('change', subscribeCurrentTalkgroup);
document.getElementById('unsubscribeButton').addEventListener('click', unsubscribeCurrentTalkgroup);
wirePtt(privatePttButton, privatePttNote, 'private');

document.getElementById('smsButton').addEventListener('click', () => {
  alert('目前是介面原型，DMR 簡訊後端尚未接通。');
});

function renderPrivateResults(items, message) {
  privateResults.replaceChildren();
  if (!items || !items.length) {
    const p = document.createElement('p');
    p.className = 'muted-text';
    p.textContent = message || '沒有找到符合的 DMR ID。';
    privateResults.appendChild(p);
    return;
  }
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lookup-result';
    const title = document.createElement('strong');
    title.textContent = `${item.callsign || '未知呼號'} · ${item.id || ''}`;
    const detail = document.createElement('span');
    detail.textContent = [item.name, item.city, item.country].filter(Boolean).join(' · ') || '公開 DMR ID 名錄';
    button.append(title, detail);
    button.addEventListener('click', () => {
      selectedPrivateContact = item;
      privateId.value = String(item.id || '');
      privateTarget.textContent = [item.callsign, item.name, item.id].filter(Boolean).join(' · ');
      document.getElementById('privatePttTarget').textContent = '個呼目標：' + (item.callsign || '未知呼號') + ' · DMR ID ' + item.id;
      privateResults.querySelectorAll('.lookup-result').forEach((node) => node.classList.toggle('selected', node === button));
    });
    privateResults.appendChild(button);
  });
}

async function searchPrivateContact() {
  const q = privateSearch.value.trim();
  if (q.length < 2) {
    renderPrivateResults([], '請輸入至少 2 個字元再查詢。');
    return;
  }
  privateResults.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'muted-text';
  loading.textContent = '正在查詢公開 DMR ID 名錄…';
  privateResults.appendChild(loading);
  try {
    const response = await fetch('/api/dmrid/search?q=' + encodeURIComponent(q));
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || '查詢失敗');
    renderPrivateResults(data.results || [], data.detail);
  } catch (error) {
    renderPrivateResults([], error.message || '查詢失敗，請稍後重試。');
  }
}
document.getElementById('privateSearchButton').addEventListener('click', searchPrivateContact);
privateSearch.addEventListener('input', () => {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(searchPrivateContact, 450);
});
privateId.addEventListener('input', () => {
  const typed = privateId.value.trim();
  if (!typed) {
    selectedPrivateContact = null;
    privateTarget.textContent = '尚未選擇個呼對象';
    document.getElementById('privatePttTarget').textContent = '選取查詢結果後，這裡會顯示個呼目標。';
  } else if (/^\d{7}$/.test(typed)) {
    if (!selectedPrivateContact || String(selectedPrivateContact.id) !== typed) selectedPrivateContact = null;
    privateTarget.textContent = selectedPrivateContact
      ? [selectedPrivateContact.callsign, selectedPrivateContact.name, typed].filter(Boolean).join(' · ')
      : '目標 DMR ID：' + typed;
    document.getElementById('privatePttTarget').textContent = selectedPrivateContact
      ? '個呼目標：' + (selectedPrivateContact.callsign || '未知呼號') + ' · DMR ID ' + typed
      : '個呼目標 DMR ID：' + typed + '（尚未選取名錄呼號）';
  }
});

const bmLoginButton = document.getElementById('bmLoginButton');
bmLoginButton.addEventListener('click', async () => {
  const callsign = callsignSetting.value.trim().toUpperCase();
  const radioId = radioIdSetting.value.trim();
  const passwordInput = document.getElementById('bmPassword');
  const password = passwordInput.value;
  const host = document.getElementById('bmMaster').value.trim();
  const resultEl = document.getElementById('bmLoginResult');

  if (!callsign || !radioId || !password || !host) {
    resultEl.textContent = '請填寫呼號、本機 DMR ID、BM Hotspot Security Password 與 BM Server/Master。';
    return;
  }
  if (!/^\d{7}$/.test(radioId)) {
    resultEl.textContent = '本機 DMR ID 必須是 7 位數字。';
    return;
  }

  bmLoginButton.disabled = true;
  resultEl.textContent = '正在登入 BM，成功後會維持連線並啟動保活…';
  // Resume playback directly from the login-button gesture for iOS/Safari autoplay rules.
  await resumeRxAudio();
  try {
    const response = await fetch('/api/bm/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign, radioId, password, host })
    });
    const data = await response.json();
    resultEl.textContent = data.detail || '未取得登入結果。';
    if (data.stage) resultEl.textContent += '（階段：' + data.stage + '）';
    if (data.ok && data.sessionToken) {
      bmSessionToken = data.sessionToken;
      await resumeRxAudio();
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'bm:attach', sessionToken: bmSessionToken }));
        subscribeCurrentTalkgroup();
      }
      document.getElementById('bmDisconnectButton').disabled = false;
      document.getElementById('bmConnectionStatus').textContent = 'BM 已連線：' + callsign + ' · ' + host;
      statusEl.textContent = 'BM 已連線';
      statusEl.classList.add('online');
    }
  } catch {
    resultEl.textContent = '無法連到 RX link 伺服器，請稍後重試。';
  } finally {
    passwordInput.value = '';
    bmLoginButton.disabled = false;
  }
});

fetch('/api/status')
  .then((response) => response.json())
  .then((data) => {
    if (data.status !== 'not-connected') statusEl.textContent = '服務正常';
  })
  .catch(() => { statusEl.textContent = '服務狀態未知'; });

connectSocket();


document.getElementById('bmDisconnectButton').addEventListener('click', async () => {
  const token = bmSessionToken;
  if (!token) return;
  const button = document.getElementById('bmDisconnectButton');
  button.disabled = true;
  try {
    await fetch('/api/bm/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token })
    });
  } catch {}
  bmSessionToken = null;
  document.getElementById('bmConnectionStatus').textContent = 'BM 尚未連線';
  document.getElementById('bmLoginResult').textContent = '已中斷 BM 連線。';
  statusEl.textContent = '網頁已連線';
});
