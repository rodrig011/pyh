/**
 * One self-contained HTML page. No build step, no framework, no external
 * fonts or libraries — it polls /api/read every few seconds and repaints
 * itself, including the candlestick chart, which is hand-drawn on a canvas.
 * Kept as a template string rather than a static file so the brand name can
 * be baked in without a second templating layer for one variable.
 */
export function dashboardPage(brandName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${brandName} — Live Read</title>
<style>
  :root {
    color-scheme: dark;
    --cyan: #22e0ff;
    --cyan-dim: #0b8fae;
    --up: #2bffa3;
    --down: #ff3860;
    --amber: #ffb020;
    --ink: #cfe8f0;
    --dim: #5c7a86;
    --bg: #04070a;
    --panel: #060b10;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(ellipse 900px 500px at 50% -10%, rgba(34,224,255,0.10), transparent 60%),
      radial-gradient(ellipse 700px 500px at 100% 100%, rgba(34,224,255,0.05), transparent 60%),
      var(--bg);
    background-attachment: fixed;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace;
    color: var(--ink);
    padding: 24px 14px;
    overflow-x: hidden;
  }
  /* faint drifting grid, purely decorative */
  body::before {
    content: ""; position: fixed; inset: -50%; z-index: 0; pointer-events: none;
    background-image:
      linear-gradient(rgba(34,224,255,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(34,224,255,0.05) 1px, transparent 1px);
    background-size: 42px 42px;
    animation: drift 40s linear infinite;
    mask-image: radial-gradient(ellipse 60% 50% at 50% 40%, black, transparent 75%);
  }
  @keyframes drift { from { transform: translate(0,0); } to { transform: translate(42px, 42px); } }

  .frame { position: relative; width: min(560px, 100%); z-index: 1; }
  .frame::before, .frame::after,
  .frame .br-tl, .frame .br-tr, .frame .br-bl, .frame .br-br { content: ""; }
  .corner {
    position: absolute; width: 22px; height: 22px; border: 2px solid var(--cyan);
    filter: drop-shadow(0 0 6px rgba(34,224,255,0.7)); opacity: 0.85;
  }
  .corner.tl { top: -8px; left: -8px; border-right: none; border-bottom: none; }
  .corner.tr { top: -8px; right: -8px; border-left: none; border-bottom: none; }
  .corner.bl { bottom: -8px; left: -8px; border-right: none; border-top: none; }
  .corner.br { bottom: -8px; right: -8px; border-left: none; border-top: none; }

  .card {
    position: relative; border-radius: 6px; padding: 26px 26px 22px;
    background: linear-gradient(180deg, rgba(15,30,38,0.55), rgba(4,8,11,0.85));
    border: 1px solid rgba(34,224,255,0.25);
    box-shadow: 0 0 0 1px rgba(34,224,255,0.04) inset, 0 40px 90px rgba(0,0,0,0.6), 0 0 40px rgba(34,224,255,0.05);
    backdrop-filter: blur(6px);
  }

  .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .brand { font-size: 12px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cyan); text-shadow: 0 0 12px rgba(34,224,255,0.5); }
  .live { display: flex; align-items: center; gap: 6px; font-size: 10px; letter-spacing: 0.15em; color: var(--dim); text-transform: uppercase; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--up); box-shadow: 0 0 8px var(--up); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }

  .cashout {
    text-align: center; margin-bottom: 14px; padding: 14px; border-radius: 10px;
    border: 1px solid rgba(255,176,32,0.5); background: rgba(255,176,32,0.1);
    animation: cashoutPulse 1.1s ease-in-out infinite;
  }
  .cashout-title { font-size: 26px; font-weight: 800; letter-spacing: 0.06em; color: var(--amber); text-shadow: 0 0 18px rgba(255,176,32,0.7); }
  .cashout-sub { font-size: 11px; color: var(--amber); opacity: 0.85; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  @keyframes cashoutPulse {
    0%,100% { box-shadow: 0 0 0px rgba(255,176,32,0.0); border-color: rgba(255,176,32,0.4); }
    50% { box-shadow: 0 0 26px rgba(255,176,32,0.5); border-color: rgba(255,176,32,0.9); }
  }
  .holding {
    text-align: center; margin-bottom: 14px; padding: 8px; border-radius: 8px; font-size: 11px;
    letter-spacing: 0.05em; color: var(--cyan); border: 1px solid rgba(34,224,255,0.2); background: rgba(34,224,255,0.04);
  }
  .record { text-align: center; font-size: 11px; letter-spacing: 0.05em; color: var(--dim); margin-bottom: 8px; text-transform: uppercase; }
  .record b { color: var(--ink); }
  .record .up { color: var(--up); } .record .down { color: var(--down); }

  .asset { text-align: center; font-size: 12px; letter-spacing: 0.1em; color: var(--dim); text-transform: uppercase; margin-bottom: 10px; }
  .call-wrap { position: relative; display: flex; align-items: center; justify-content: center; margin: 6px 0 4px; height: 78px; }
  .ring { position: absolute; width: 96px; height: 96px; border-radius: 50%; border: 1px solid currentColor; opacity: 0; }
  .ring.on { animation: ringpulse 2s ease-out infinite; }
  @keyframes ringpulse { 0% { opacity: 0.5; transform: scale(0.6); } 100% { opacity: 0; transform: scale(1.6); } }
  .call { position: relative; text-align: center; font-size: 46px; font-weight: 800; letter-spacing: 0.05em; }
  .call.up { color: var(--up); text-shadow: 0 0 24px rgba(43,255,163,0.55); }
  .call.down { color: var(--down); text-shadow: 0 0 24px rgba(255,56,96,0.55); }
  .call.none { color: var(--dim); font-size: 26px; letter-spacing: 0.15em; }
  .sub { text-align: center; color: var(--dim); font-size: 12px; letter-spacing: 0.04em; margin-bottom: 20px; }

  canvas#chart { width: 100%; height: 140px; display: block; border-radius: 6px; border: 1px solid rgba(34,224,255,0.15); background: rgba(2,6,9,0.6); margin-bottom: 18px; }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
  .stat { background: rgba(34,224,255,0.03); border: 1px solid rgba(34,224,255,0.12); border-radius: 8px; padding: 10px 8px; text-align: center; }
  .stat .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); margin-bottom: 6px; }
  .stat .value { font-size: 16px; font-weight: 700; color: var(--ink); }
  .stat .value.up { color: var(--up); } .stat .value.down { color: var(--down); } .stat .value.amber { color: var(--amber); }

  .bar-row { margin-bottom: 8px; }
  .bar-row .labels { display: flex; justify-content: space-between; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  .bar { height: 6px; border-radius: 4px; background: rgba(255,255,255,0.06); overflow: hidden; position: relative; }
  .bar .fill { position: absolute; inset: 0; border-radius: 4px; transition: width 0.4s ease; }
  .bar .fill.model { background: linear-gradient(90deg, var(--cyan-dim), var(--cyan)); box-shadow: 0 0 8px rgba(34,224,255,0.5); }
  .bar .fill.market { background: linear-gradient(90deg, #46586a, #7c8fa0); }

  .whale { margin-top: 14px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(255,176,32,0.0); background: rgba(255,176,32,0.0); font-size: 12px; color: var(--dim); transition: all 0.3s ease; min-height: 16px; }
  .whale.active { border-color: rgba(255,176,32,0.35); background: rgba(255,176,32,0.06); color: var(--amber); }

  .reason { text-align: center; font-size: 11px; color: var(--dim); margin-top: 10px; letter-spacing: 0.02em; }
  .clock-row { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(34,224,255,0.1); }
  .clock-row .label { font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--dim); }
  .clock { font-size: 18px; font-weight: 700; color: var(--cyan); font-variant-numeric: tabular-nums; text-shadow: 0 0 10px rgba(34,224,255,0.4); }
  .stale { text-align: center; margin-top: 10px; font-size: 11px; color: var(--down); visibility: hidden; letter-spacing: 0.05em; }

  .gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 16px; z-index: 1; position: relative; }
  .gate input {
    background: rgba(34,224,255,0.05); border: 1px solid rgba(34,224,255,0.3); color: var(--ink);
    padding: 12px 16px; border-radius: 8px; font-size: 14px; width: 260px; text-align: center; font-family: inherit;
  }
  .gate input:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 12px rgba(34,224,255,0.3); }
  .gate button {
    background: rgba(34,224,255,0.12); color: var(--cyan); border: 1px solid var(--cyan); padding: 10px 22px;
    border-radius: 8px; cursor: pointer; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; font-family: inherit;
  }
  .gate button:hover { background: rgba(34,224,255,0.2); }
  .hidden { display: none; }
</style>
</head>
<body>
<div id="gate" class="gate hidden">
  <div class="brand">${brandName}</div>
  <input id="tokenInput" type="password" placeholder="ACCESS CODE" />
  <button id="tokenSubmit">Unlock</button>
  <div id="gateError" style="color:var(--down);font-size:12px;"></div>
</div>

<div id="frame" class="frame hidden">
  <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
  <div class="card">
    <div class="topbar">
      <div class="brand">${brandName}</div>
      <div class="live"><span class="dot"></span>LIVE</div>
    </div>

    <div id="cashout" class="cashout hidden">
      <div class="cashout-title">💸 CASH OUT</div>
      <div class="cashout-sub" id="cashoutSub">—</div>
    </div>
    <div id="holding" class="holding hidden">🔵 HOLDING <span id="holdingSide"></span> · entry <span id="holdingEntry"></span> · now <span id="holdingNow"></span></div>

    <div class="record" id="record"></div>

    <div class="asset" id="asset">—</div>
    <div class="call-wrap">
      <div class="ring" id="ring"></div>
      <div class="call none" id="call">SYNCING…</div>
    </div>
    <div class="sub" id="sub">—</div>

    <canvas id="chart" width="600" height="280"></canvas>

    <div class="grid">
      <div class="stat"><div class="label">Confidence</div><div class="value" id="conf">—</div></div>
      <div class="stat"><div class="label">Entry</div><div class="value" id="entry">—</div></div>
      <div class="stat"><div class="label">Flip odds</div><div class="value amber" id="flip">—</div></div>
      <div class="stat"><div class="label">Strike</div><div class="value" id="strike">—</div></div>
    </div>

    <div class="bar-row">
      <div class="labels"><span>Model</span><span id="modelPct">—</span></div>
      <div class="bar"><div class="fill model" id="modelBar" style="width:0%"></div></div>
    </div>
    <div class="bar-row">
      <div class="labels"><span>Market</span><span id="marketPct">—</span></div>
      <div class="bar"><div class="fill market" id="marketBar" style="width:0%"></div></div>
    </div>

    <div class="whale" id="whale"></div>
    <div class="reason" id="reason"></div>

    <div class="clock-row"><span class="label">Closes in</span><span class="clock" id="clock">—</span></div>
    <div class="stale" id="stale">◆ FEED STALE — RECONNECTING…</div>
  </div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'dashboard_token';
  var token = localStorage.getItem(TOKEN_KEY) || '';
  var gate = document.getElementById('gate');
  var frame = document.getElementById('frame');
  var closesAtMs = null;
  var lastOkAt = 0;
  var candles = [];

  function fmtPct(p) { return Number.isFinite(p) ? Math.round(p * 100) + '%' : '—'; }
  function fmtClock(s) {
    if (!Number.isFinite(s) || s < 0) return '—';
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function drawChart(list) {
    var canvas = document.getElementById('chart');
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!list || list.length < 2) {
      ctx.fillStyle = '#5c7a86'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
      ctx.fillText('GATHERING PRICE HISTORY…', w / 2, h / 2);
      return;
    }

    var pad = 8;
    var lo = Math.min.apply(null, list.map(function (c) { return c.low; }));
    var hi = Math.max.apply(null, list.map(function (c) { return c.high; }));
    if (hi === lo) { hi += 1; lo -= 1; }
    var span = hi - lo;
    var slot = (w - pad * 2) / list.length;
    var bodyW = Math.max(2, slot * 0.55);

    // faint grid
    ctx.strokeStyle = 'rgba(34,224,255,0.08)'; ctx.lineWidth = 1;
    for (var g = 1; g < 4; g++) {
      var y = pad + ((h - pad * 2) / 4) * g;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    function yFor(price) { return pad + (h - pad * 2) * (1 - (price - lo) / span); }

    list.forEach(function (c, i) {
      var x = pad + slot * i + slot / 2;
      var up = c.close >= c.open;
      var color = up ? '#2bffa3' : '#ff3860';
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = 5;

      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yFor(c.high)); ctx.lineTo(x, yFor(c.low)); ctx.stroke();

      var openY = yFor(c.open), closeY = yFor(c.close);
      var top = Math.min(openY, closeY), bh = Math.max(1, Math.abs(closeY - openY));
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
    });
    ctx.shadowBlur = 0;
  }

  function paintPosition(position) {
    var cashout = document.getElementById('cashout');
    var holding = document.getElementById('holding');
    if (position && position.action === 'cash_out') {
      cashout.classList.remove('hidden');
      holding.classList.add('hidden');
      document.getElementById('cashoutSub').textContent =
        (position.side || '').toUpperCase() + ' position · entry ' + Math.round(position.entryCents) + '¢ · now ' +
        Math.round(position.nowCents) + '¢' + (position.reason ? ' · ' + position.reason : '');
    } else if (position && (position.action === 'holding' || position.action === 'settling')) {
      cashout.classList.add('hidden');
      holding.classList.remove('hidden');
      document.getElementById('holdingSide').textContent = (position.side || '').toUpperCase();
      document.getElementById('holdingEntry').textContent = Number.isFinite(position.entryCents) ? Math.round(position.entryCents) + '¢' : '—';
      document.getElementById('holdingNow').textContent = Number.isFinite(position.nowCents) ? Math.round(position.nowCents) + '¢' : (position.action === 'settling' ? 'settling…' : '—');
    } else {
      cashout.classList.add('hidden');
      holding.classList.add('hidden');
    }
  }

  function paintRecord(record) {
    var el = document.getElementById('record');
    if (!record || record.total === 0) { el.textContent = 'No settled trades yet'; return; }
    el.innerHTML = '📊 <span class="up">' + record.wins + 'W</span> – <span class="down">' + record.losses + 'L</span>' +
      (record.breakEven ? ' – ' + record.breakEven + ' push' : '') +
      (record.winRate !== null ? ' <b>(' + Math.round(record.winRate * 100) + '%)</b>' : '');
  }

  function paint(data) {
    paintPosition(data.position);
    paintRecord(data.record);
    document.getElementById('asset').textContent = data.asset + (data.ticker ? ' · ' + data.ticker : '');
    var callEl = document.getElementById('call');
    var ring = document.getElementById('ring');
    if (data.call === 'up') {
      callEl.textContent = '▲ UP'; callEl.className = 'call up';
      ring.style.color = '#2bffa3'; ring.className = 'ring' + (data.tradeable ? ' on' : '');
    } else if (data.call === 'down') {
      callEl.textContent = '▼ DOWN'; callEl.className = 'call down';
      ring.style.color = '#ff3860'; ring.className = 'ring' + (data.tradeable ? ' on' : '');
    } else {
      callEl.textContent = 'NO READ'; callEl.className = 'call none'; ring.className = 'ring';
    }

    document.getElementById('sub').textContent = data.tradeable
      ? 'ENGINE WOULD TAKE THIS'
      : 'NOT CLEARING THE BAR';
    document.getElementById('conf').textContent = (data.likelihood || '—').toUpperCase();
    document.getElementById('entry').textContent = Number.isFinite(data.entryCents) ? Math.round(data.entryCents) + '¢' : '—';
    document.getElementById('flip').textContent = fmtPct(data.flipProbability);
    document.getElementById('strike').textContent = Number.isFinite(data.strike) ? '$' + Math.round(data.strike).toLocaleString('en-US') : '—';

    document.getElementById('modelPct').textContent = fmtPct(data.winProbability);
    document.getElementById('marketPct').textContent = fmtPct(data.marketWinProbability);
    document.getElementById('modelBar').style.width = fmtPct(data.winProbability);
    document.getElementById('marketBar').style.width = fmtPct(data.marketWinProbability);

    var whaleEl = document.getElementById('whale');
    if (data.whales && data.whales.line) {
      whaleEl.textContent = '🐋 ' + data.whales.line.replace(/\\*\\*/g, '').replace(/^🐋 /, '');
      whaleEl.className = 'whale active';
    } else {
      whaleEl.textContent = 'No large prints on the tape right now.';
      whaleEl.className = 'whale';
    }

    document.getElementById('reason').textContent = data.reason || '';
    candles = data.candles || [];
    drawChart(candles);
    closesAtMs = Number.isFinite(data.secondsLeft) ? Date.now() + data.secondsLeft * 1000 : null;
  }

  function tickClock() {
    if (closesAtMs === null) { document.getElementById('clock').textContent = '—'; return; }
    var left = (closesAtMs - Date.now()) / 1000;
    document.getElementById('clock').textContent = fmtClock(left);
  }
  setInterval(tickClock, 1000);

  async function poll() {
    try {
      var res = await fetch('/api/read', { headers: token ? { 'x-dashboard-token': token } : {} });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        showGate('Wrong access code.');
        return;
      }
      var data = await res.json();
      gate.classList.add('hidden');
      frame.classList.remove('hidden');
      if (data.ok) {
        paint(data);
        lastOkAt = Date.now();
        document.getElementById('stale').style.visibility = 'hidden';
      } else {
        document.getElementById('call').textContent = (data.reason || 'NO READ').toUpperCase();
        document.getElementById('call').className = 'call none';
        document.getElementById('ring').className = 'ring';
      }
    } catch (e) {
      if (Date.now() - lastOkAt > 15000) document.getElementById('stale').style.visibility = 'visible';
    }
  }

  function showGate(message) {
    frame.classList.add('hidden');
    gate.classList.remove('hidden');
    document.getElementById('gateError').textContent = message || '';
  }

  document.getElementById('tokenSubmit').addEventListener('click', function () {
    token = document.getElementById('tokenInput').value.trim();
    localStorage.setItem(TOKEN_KEY, token);
    poll();
  });
  document.getElementById('tokenInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('tokenSubmit').click();
  });

  frame.classList.remove('hidden');
  poll();
  setInterval(poll, 4000);
  window.addEventListener('resize', function () { drawChart(candles); });
})();
</script>
</body>
</html>`;
}
