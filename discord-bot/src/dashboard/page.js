/**
 * One self-contained HTML page. No build step, no framework — it polls
 * /api/read every few seconds and repaints itself. Kept as a template string
 * rather than a static file so the brand name can be baked in without a
 * second templating layer for one variable.
 */
export function dashboardPage(brandName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${brandName} — Live Read</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 50% 0%, #131a2b 0%, #05070c 70%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e8ecf4;
  }
  .card {
    width: min(480px, 92vw); border-radius: 20px; padding: 32px;
    background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01));
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 30px 80px rgba(0,0,0,0.5);
  }
  .brand { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: #7c88a6; text-align: center; margin-bottom: 4px; }
  .asset { text-align: center; font-size: 15px; color: #a9b4cc; margin-bottom: 20px; }
  .call { text-align: center; font-size: 56px; font-weight: 800; letter-spacing: 0.04em; margin: 4px 0 6px; transition: color 0.3s; }
  .call.up { color: #33e58c; text-shadow: 0 0 30px rgba(51,229,140,0.35); }
  .call.down { color: #ff5470; text-shadow: 0 0 30px rgba(255,84,112,0.35); }
  .call.none { color: #7c88a6; font-size: 32px; }
  .sub { text-align: center; color: #a9b4cc; font-size: 14px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
  .stat { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 14px; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #7c88a6; margin-bottom: 6px; }
  .stat .value { font-size: 20px; font-weight: 700; }
  .bar-row { margin-bottom: 8px; }
  .bar-row .labels { display: flex; justify-content: space-between; font-size: 12px; color: #a9b4cc; margin-bottom: 4px; }
  .bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,0.07); overflow: hidden; position: relative; }
  .bar .fill { position: absolute; inset: 0; border-radius: 6px; }
  .bar .fill.model { background: linear-gradient(90deg, #3b82f6, #60a5fa); }
  .bar .fill.market { background: linear-gradient(90deg, #a9b4cc, #7c88a6); opacity: 0.6; }
  .clock { text-align: center; font-size: 13px; color: #7c88a6; margin-top: 20px; }
  .clock b { color: #e8ecf4; font-variant-numeric: tabular-nums; }
  .stale { text-align: center; margin-top: 12px; font-size: 12px; color: #ff5470; visibility: hidden; }
  .reason { text-align: center; font-size: 13px; color: #7c88a6; margin-top: 8px; }
  .gate {
    display: flex; align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 16px;
  }
  .gate input {
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); color: #e8ecf4;
    padding: 12px 16px; border-radius: 10px; font-size: 15px; width: 260px; text-align: center;
  }
  .gate button {
    background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 10px; cursor: pointer; font-size: 14px;
  }
  .hidden { display: none; }
</style>
</head>
<body>
<div id="gate" class="gate hidden">
  <div class="brand">${brandName}</div>
  <input id="tokenInput" type="password" placeholder="Access code" />
  <button id="tokenSubmit">Unlock</button>
  <div id="gateError" style="color:#ff5470;font-size:13px;"></div>
</div>

<div id="card" class="card hidden">
  <div class="brand">${brandName}</div>
  <div class="asset" id="asset">—</div>
  <div class="call none" id="call">Loading…</div>
  <div class="sub" id="sub">—</div>

  <div class="grid">
    <div class="stat"><div class="label">Model confidence</div><div class="value" id="conf">—</div></div>
    <div class="stat"><div class="label">Entry</div><div class="value" id="entry">—</div></div>
  </div>

  <div class="bar-row">
    <div class="labels"><span>Model</span><span id="modelPct">—</span></div>
    <div class="bar"><div class="fill model" id="modelBar" style="width:0%"></div></div>
  </div>
  <div class="bar-row">
    <div class="labels"><span>Market</span><span id="marketPct">—</span></div>
    <div class="bar"><div class="fill market" id="marketBar" style="width:0%"></div></div>
  </div>

  <div class="reason" id="reason"></div>
  <div class="clock">Closes in <b id="clock">—</b></div>
  <div class="stale" id="stale">Feed is stale — reconnecting…</div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'dashboard_token';
  var token = localStorage.getItem(TOKEN_KEY) || '';
  var gate = document.getElementById('gate');
  var card = document.getElementById('card');
  var closesAtMs = null;
  var lastOkAt = 0;

  function fmtPct(p) { return Number.isFinite(p) ? Math.round(p * 100) + '%' : '—'; }
  function fmtClock(s) {
    if (!Number.isFinite(s) || s < 0) return '—';
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function paint(data) {
    document.getElementById('asset').textContent = data.asset + (data.ticker ? ' · ' + data.ticker : '');
    var callEl = document.getElementById('call');
    if (data.call === 'up') { callEl.textContent = '▲ UP'; callEl.className = 'call up'; }
    else if (data.call === 'down') { callEl.textContent = '▼ DOWN'; callEl.className = 'call down'; }
    else { callEl.textContent = 'NO READ'; callEl.className = 'call none'; }

    document.getElementById('sub').textContent = data.tradeable
      ? 'The engine would actually take this'
      : 'Not tradeable right now';
    document.getElementById('conf').textContent = data.likelihood || '—';
    document.getElementById('entry').textContent = Number.isFinite(data.entryCents) ? Math.round(data.entryCents) + '¢' : '—';

    document.getElementById('modelPct').textContent = fmtPct(data.winProbability);
    document.getElementById('marketPct').textContent = fmtPct(data.marketWinProbability);
    document.getElementById('modelBar').style.width = fmtPct(data.winProbability);
    document.getElementById('marketBar').style.width = fmtPct(data.marketWinProbability);

    document.getElementById('reason').textContent = data.reason || '';
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
      card.classList.remove('hidden');
      if (data.ok) {
        paint(data);
        lastOkAt = Date.now();
        document.getElementById('stale').style.visibility = 'hidden';
      } else {
        document.getElementById('call').textContent = data.reason || 'No read';
        document.getElementById('call').className = 'call none';
      }
    } catch (e) {
      if (Date.now() - lastOkAt > 15000) document.getElementById('stale').style.visibility = 'visible';
    }
  }

  function showGate(message) {
    card.classList.add('hidden');
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

  card.classList.remove('hidden');
  poll();
  setInterval(poll, 4000);
})();
</script>
</body>
</html>`;
}
