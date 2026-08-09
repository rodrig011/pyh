/**
 * One self-contained HTML page. No build step — it polls /api/read every few
 * seconds and repaints itself. The candlestick chart is TradingView's own
 * open-source "Lightweight Charts" library (loaded from a CDN, MIT/Apache
 * licensed) rather than hand-drawn canvas — real price/time axes, a
 * crosshair with an OHLC tooltip, zoom and pan, the genuine article instead
 * of an approximation of one. If the CDN cannot be reached the page still
 * works; the chart panel just says so instead of crashing.
 *
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
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
  :root {
    color-scheme: dark;
    --cyan: #22e0ff;
    --cyan-dim: #0b8fae;
    --up: #2bffa3;
    --down: #ff3860;
    --amber: #ffb020;
    --violet: #b98bff;
    --ink: #cfe8f0;
    --dim: #5c7a86;
    --bg: #04070a;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(ellipse 1100px 600px at 50% -10%, rgba(34,224,255,0.10), transparent 60%),
      radial-gradient(ellipse 800px 600px at 100% 100%, rgba(34,224,255,0.05), transparent 60%),
      var(--bg);
    background-attachment: fixed;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace;
    color: var(--ink);
    padding: 24px 14px;
    overflow-x: hidden;
  }
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

  .frame { position: relative; width: min(760px, 100%); z-index: 1; }
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

  .enter-row { display: flex; gap: 10px; margin-bottom: 14px; }
  .enterBtn {
    flex: 1; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 12px; letter-spacing: 0.08em;
    text-transform: uppercase; font-weight: 700; cursor: pointer; border: 1px solid; background: transparent; transition: all 0.15s ease;
  }
  .enterBtn.up { color: var(--up); border-color: rgba(43,255,163,0.4); }
  .enterBtn.up:hover { background: rgba(43,255,163,0.1); box-shadow: 0 0 14px rgba(43,255,163,0.3); }
  .enterBtn.down { color: var(--down); border-color: rgba(255,56,96,0.4); }
  .enterBtn.down:hover { background: rgba(255,56,96,0.1); box-shadow: 0 0 14px rgba(255,56,96,0.3); }
  .enterBtn:disabled { opacity: 0.4; cursor: default; }

  .clearBtn {
    display: block; margin: 8px auto 0; padding: 5px 14px; border-radius: 6px; font-family: inherit; font-size: 10px;
    letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; border: 1px solid rgba(255,255,255,0.2);
    background: rgba(255,255,255,0.04); color: var(--dim);
  }
  .clearBtn:hover { color: var(--ink); border-color: rgba(255,255,255,0.4); }

  .asset { text-align: center; font-size: 12px; letter-spacing: 0.1em; color: var(--dim); text-transform: uppercase; margin-bottom: 10px; }
  .call-wrap { position: relative; display: flex; align-items: center; justify-content: center; margin: 6px 0 4px; height: 78px; }
  .ring { position: absolute; width: 96px; height: 96px; border-radius: 50%; border: 1px solid currentColor; opacity: 0; }
  .ring.on { animation: ringpulse 2s ease-out infinite; }
  @keyframes ringpulse { 0% { opacity: 0.5; transform: scale(0.6); } 100% { opacity: 0; transform: scale(1.6); } }
  .call { position: relative; text-align: center; font-size: 46px; font-weight: 800; letter-spacing: 0.05em; }
  .call.up { color: var(--up); text-shadow: 0 0 24px rgba(43,255,163,0.55); }
  .call.down { color: var(--down); text-shadow: 0 0 24px rgba(255,56,96,0.55); }
  .call.none { color: var(--dim); font-size: 26px; letter-spacing: 0.15em; }
  .sub { text-align: center; color: var(--dim); font-size: 12px; letter-spacing: 0.04em; margin-bottom: 18px; }

  .chart-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-bottom: 6px; }
  .tf-btn {
    font-family: inherit; font-size: 10px; letter-spacing: 0.08em; padding: 4px 10px; border-radius: 5px;
    border: 1px solid rgba(34,224,255,0.2); background: transparent; color: var(--dim); cursor: pointer;
  }
  .tf-btn.active { color: var(--cyan); border-color: var(--cyan); background: rgba(34,224,255,0.1); }
  .chart-wrap {
    position: relative; border-radius: 6px; border: 1px solid rgba(34,224,255,0.15); background: rgba(2,6,9,0.6); margin-bottom: 10px; overflow: hidden;
  }
  #chartMain { width: 100%; height: 300px; }
  .ohlc-legend {
    position: absolute; top: 6px; left: 8px; z-index: 3; font-size: 10px; letter-spacing: 0.03em; color: var(--dim);
    display: flex; gap: 10px; pointer-events: none; text-shadow: 0 0 4px rgba(0,0,0,0.8);
  }
  .ohlc-legend b { color: var(--ink); font-weight: 700; }
  .ohlc-legend .up { color: var(--up); } .ohlc-legend .down { color: var(--down); }
  .rsi-wrap {
    border-radius: 6px; border: 1px solid rgba(185,139,255,0.15); background: rgba(2,6,9,0.6); margin-bottom: 18px; overflow: hidden;
    position: relative;
  }
  #chartRsi { width: 100%; height: 90px; }
  .rsi-label { position: absolute; top: 4px; left: 8px; font-size: 9px; letter-spacing: 0.1em; color: var(--violet); text-transform: uppercase; z-index: 2; }
  .chart-fallback { padding: 40px 10px; text-align: center; color: var(--dim); font-size: 11px; letter-spacing: 0.04em; }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 10px; }
  .stat { background: rgba(34,224,255,0.03); border: 1px solid rgba(34,224,255,0.12); border-radius: 8px; padding: 10px 8px; text-align: center; }
  .stat .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); margin-bottom: 6px; }
  .stat .value { font-size: 16px; font-weight: 700; color: var(--ink); }
  .stat .value.up { color: var(--up); } .stat .value.down { color: var(--down); } .stat .value.amber { color: var(--amber); } .stat .value.violet { color: var(--violet); }

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
    padding: 12px 16px; border-radius: 8px; font-size: 16px; width: min(260px, 80vw); text-align: center; font-family: inherit;
  }
  .gate input:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 12px rgba(34,224,255,0.3); }
  .gate button {
    background: rgba(34,224,255,0.12); color: var(--cyan); border: 1px solid var(--cyan); padding: 12px 22px;
    border-radius: 8px; cursor: pointer; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; font-family: inherit;
  }
  .gate button:hover { background: rgba(34,224,255,0.2); }
  .hidden { display: none; }

  /* Phones — portrait, roughly iPhone SE up to a large Android in portrait. */
  @media (max-width: 480px) {
    body { padding: 12px 8px; align-items: flex-start; }
    .card { padding: 16px 14px 16px; border-radius: 10px; }
    .corner { width: 14px; height: 14px; }

    .brand { font-size: 10px; letter-spacing: 0.14em; }
    .topbar { margin-bottom: 14px; }

    .cashout-title { font-size: 20px; }
    .cashout { padding: 12px; }
    .holding { font-size: 10px; line-height: 1.6; }

    .enter-row { flex-direction: column; gap: 8px; }
    .enterBtn { padding: 13px; font-size: 12px; }

    .call { font-size: 32px; }
    .call.none { font-size: 18px; }
    .call-wrap { height: 56px; margin: 4px 0; }
    .ring { width: 72px; height: 72px; }
    .asset { font-size: 10px; }
    .sub { font-size: 10px; margin-bottom: 14px; }

    .chart-toolbar { justify-content: center; margin-bottom: 8px; }
    .tf-btn { padding: 6px 14px; font-size: 11px; }
    #chartMain { height: 220px; }
    #chartRsi { height: 64px; }
    .ohlc-legend { font-size: 8px; gap: 6px; flex-wrap: wrap; right: 6px; }
    .rsi-label { font-size: 8px; }

    .grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .stat { padding: 9px 6px; }
    .stat .label { font-size: 8px; }
    .stat .value { font-size: 15px; }

    .clock { font-size: 16px; }
    .whale, .reason { font-size: 11px; }
  }

  /* Small/older phones — iPhone SE 1st gen and similar 320-360px widths. */
  @media (max-width: 360px) {
    .grid { grid-template-columns: repeat(2, 1fr); gap: 6px; }
    .call { font-size: 26px; }
    #chartMain { height: 190px; }
  }
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
      <button id="exitBtn" class="clearBtn hidden">Clear</button>
    </div>
    <div id="holding" class="holding hidden">
      🔵 HOLDING <span id="holdingSide"></span> · entry <span id="holdingEntry"></span> · now <span id="holdingNow"></span>
      <button id="exitBtn2" class="clearBtn hidden">Clear</button>
    </div>
    <div id="enterRow" class="enter-row hidden">
      <button id="enterUp" class="enterBtn up">I'M IN — UP</button>
      <button id="enterDown" class="enterBtn down">I'M IN — DOWN</button>
    </div>

    <div class="record" id="record"></div>

    <div class="asset" id="asset">—</div>
    <div class="call-wrap">
      <div class="ring" id="ring"></div>
      <div class="call none" id="call">SYNCING…</div>
    </div>
    <div class="sub" id="sub">—</div>

    <div class="chart-toolbar">
      <button class="tf-btn" data-tf="1">1m</button>
      <button class="tf-btn active" data-tf="5">5m</button>
      <button class="tf-btn" data-tf="15">15m</button>
    </div>
    <div class="chart-wrap">
      <div id="ohlcLegend" class="ohlc-legend"></div>
      <div id="chartMain"></div>
      <div id="chartFallback" class="chart-fallback hidden">Chart library unreachable — the read above is still live.</div>
    </div>
    <div class="rsi-wrap"><span class="rsi-label">RSI 14</span><div id="chartRsi"></div></div>

    <div class="grid">
      <div class="stat"><div class="label">Confidence</div><div class="value" id="conf">—</div></div>
      <div class="stat"><div class="label">Entry</div><div class="value" id="entry">—</div></div>
      <div class="stat"><div class="label">Flip odds</div><div class="value amber" id="flip">—</div></div>
      <div class="stat"><div class="label">Strike</div><div class="value" id="strike">—</div></div>
    </div>
    <div class="grid">
      <div class="stat"><div class="label">RSI (14)</div><div class="value violet" id="rsiVal">—</div></div>
      <div class="stat"><div class="label">Momentum</div><div class="value" id="momentum">—</div></div>
      <div class="stat"><div class="label">Trend R²</div><div class="value" id="trendR2">—</div></div>
      <div class="stat"><div class="label">Strike, in σ</div><div class="value" id="sigmaDist">—</div></div>
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
  var rawCandles = []; // always 1-minute, straight from the server
  var rawVolume = [];
  var timeframe = 5;
  var chart = null, candleSeries = null, volumeSeries = null;
  var strikeLine = null, spotLine = null, rangeHiLine = null, rangeLoLine = null;
  var rsiChart = null, rsiSeries = null;
  var lastRsiPoints = [];

  function fmtPct(p) { return Number.isFinite(p) ? Math.round(p * 100) + '%' : '—'; }
  function fmtClock(s) {
    if (!Number.isFinite(s) || s < 0) return '—';
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  // ---- Charting (TradingView Lightweight Charts) ----

  function initCharts() {
    if (typeof LightweightCharts === 'undefined') {
      document.getElementById('chartFallback').classList.remove('hidden');
      document.querySelector('.rsi-wrap').classList.add('hidden');
      return;
    }
    var common = {
      layout: { background: { color: 'transparent' }, textColor: '#7c8fa0', fontFamily: 'ui-monospace, monospace', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(34,224,255,0.06)' }, horzLines: { color: 'rgba(34,224,255,0.06)' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { borderColor: 'rgba(34,224,255,0.15)', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(34,224,255,0.15)' },
      handleScroll: true, handleScale: true,
    };

    chart = LightweightCharts.createChart(document.getElementById('chartMain'), Object.assign({
      width: document.getElementById('chartMain').clientWidth, height: 260,
    }, common));
    candleSeries = chart.addCandlestickSeries({
      upColor: '#2bffa3', downColor: '#ff3860', borderVisible: false,
      wickUpColor: '#2bffa3', wickDownColor: '#ff3860',
    });

    // Real Kalshi contract volume, sparse by nature — see buildVolume server
    // side. Squeezed into the bottom 15% of the same pane, the way a proper
    // terminal does it, rather than a whole separate chart for what is often
    // a handful of bars.
    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: 'rgba(124,143,160,0.5)',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    // A live OHLC readout under the crosshair — pure decoration, and the one
    // thing that makes a chart feel like a terminal instead of a picture.
    chart.subscribeCrosshairMove(function (param) {
      var legend = document.getElementById('ohlcLegend');
      var bar = param && param.seriesData ? param.seriesData.get(candleSeries) : null;
      if (!bar) { legend.innerHTML = ''; return; }
      var up = bar.close >= bar.open;
      var cls = up ? 'up' : 'down';
      legend.innerHTML =
        'O <b class="' + cls + '">' + bar.open.toFixed(0) + '</b> ' +
        'H <b class="' + cls + '">' + bar.high.toFixed(0) + '</b> ' +
        'L <b class="' + cls + '">' + bar.low.toFixed(0) + '</b> ' +
        'C <b class="' + cls + '">' + bar.close.toFixed(0) + '</b>';
    });

    rsiChart = LightweightCharts.createChart(document.getElementById('chartRsi'), Object.assign({
      width: document.getElementById('chartRsi').clientWidth, height: 90,
    }, common, { rightPriceScale: { borderColor: 'rgba(185,139,255,0.15)' } }));
    rsiSeries = rsiChart.addLineSeries({ color: '#b98bff', lineWidth: 2 });
    rsiSeries.createPriceLine({ price: 70, color: 'rgba(255,56,96,0.4)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '70' });
    rsiSeries.createPriceLine({ price: 30, color: 'rgba(43,255,163,0.4)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '30' });
    rsiChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });

    // Keep both time axes in step when one is panned or zoomed.
    chart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
      if (range) rsiChart.timeScale().setVisibleLogicalRange(range);
    });

    // And the crosshair itself, so reading the RSI at a given candle does not
    // need lining the two panes up by eye. RSI lives on a SEPARATE chart, so
    // its value at this timestamp has to be looked up in the last data this
    // page itself sent it, not read off the main chart's own series. Guarded
    // — a library version mismatch on this call must not take the rest of
    // the chart down with it.
    try {
      chart.subscribeCrosshairMove(function (param) {
        if (!param || !param.time) { rsiChart.clearCrosshairPosition(); return; }
        var point = lastRsiPoints.find(function (p) { return p.time === param.time; });
        if (point) rsiChart.setCrosshairPosition(point.value, param.time, rsiSeries);
        else rsiChart.clearCrosshairPosition();
      });
    } catch (e) {}

    window.addEventListener('resize', function () {
      var m = document.getElementById('chartMain'), r = document.getElementById('chartRsi');
      if (chart) chart.applyOptions({ width: m.clientWidth });
      if (rsiChart) rsiChart.applyOptions({ width: r.clientWidth });
    });
  }

  /** 1-minute candles -> N-minute candles, by folding N consecutive ones together. */
  function aggregate(candles, minutes) {
    if (minutes <= 1) return candles;
    var out = [];
    for (var i = 0; i < candles.length; i += minutes) {
      var group = candles.slice(i, i + minutes);
      if (group.length === 0) continue;
      out.push({
        time: group[0].time,
        open: group[0].open,
        high: Math.max.apply(null, group.map(function (c) { return c.high; })),
        low: Math.min.apply(null, group.map(function (c) { return c.low; })),
        close: group[group.length - 1].close,
      });
    }
    return out;
  }

  /** Same folding, for the volume bars — summed instead of OHLC'd. */
  function aggregateVolume(bars, minutes) {
    if (minutes <= 1) return bars;
    var byBucket = {};
    bars.forEach(function (b) {
      var bucket = Math.floor(b.time / (minutes * 60_000)) * (minutes * 60_000);
      byBucket[bucket] = (byBucket[bucket] || 0) + b.value;
    });
    return Object.keys(byBucket).map(function (t) { return { time: Number(t), value: byBucket[t] }; }).sort(function (a, b) { return a.time - b.time; });
  }

  function toChartTime(ms) { return Math.floor(ms / 1000); }

  function redrawChart(data) {
    if (!chart || !candleSeries) return;
    var agg = aggregate(rawCandles, timeframe);
    var points = agg.map(function (c) {
      return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
    });
    if (points.length === 0) return;
    candleSeries.setData(points);

    if (strikeLine) { candleSeries.removePriceLine(strikeLine); strikeLine = null; }
    if (Number.isFinite(data.strike)) {
      strikeLine = candleSeries.createPriceLine({
        price: data.strike, color: '#7c8fa0', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'strike',
      });
    }

    if (spotLine) { candleSeries.removePriceLine(spotLine); spotLine = null; }
    if (Number.isFinite(data.spot)) {
      spotLine = candleSeries.createPriceLine({
        price: data.spot, color: '#22e0ff', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: 'now',
      });
    }

    // The model's own uncertainty, drawn rather than left as a number — the
    // range spot is expected to land inside of by the close, at roughly a
    // two-thirds chance. A width, not a prediction of where it lands.
    if (rangeHiLine) { candleSeries.removePriceLine(rangeHiLine); rangeHiLine = null; }
    if (rangeLoLine) { candleSeries.removePriceLine(rangeLoLine); rangeLoLine = null; }
    if (data.expectedRange) {
      rangeHiLine = candleSeries.createPriceLine({
        price: data.expectedRange.high, color: 'rgba(185,139,255,0.55)', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true, title: '~68% hi',
      });
      rangeLoLine = candleSeries.createPriceLine({
        price: data.expectedRange.low, color: 'rgba(185,139,255,0.55)', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true, title: '~68% lo',
      });
    }

    if (volumeSeries) {
      var volAgg = aggregateVolume(rawVolume, timeframe);
      volumeSeries.setData(volAgg.map(function (v) { return { time: toChartTime(v.time), value: v.value }; }));
    }

    chart.timeScale().fitContent();

    if (rsiSeries && Array.isArray(data.rsiSeries)) {
      lastRsiPoints = data.rsiSeries.map(function (p) { return { time: toChartTime(p.time), value: p.value }; });
      rsiSeries.setData(lastRsiPoints);
    }
  }

  // ---- Panels ----

  function paintPosition(position) {
    var cashout = document.getElementById('cashout');
    var holding = document.getElementById('holding');
    var enterRow = document.getElementById('enterRow');
    var exitBtn = document.getElementById('exitBtn');
    var exitBtn2 = document.getElementById('exitBtn2');

    if (position && position.action === 'cash_out') {
      cashout.classList.remove('hidden');
      holding.classList.add('hidden');
      enterRow.classList.add('hidden');
      document.getElementById('cashoutSub').textContent =
        (position.side || '').toUpperCase() + ' position · entry ' + Math.round(position.entryCents) + '¢ · now ' +
        Math.round(position.nowCents) + '¢' + (position.reason ? ' · ' + position.reason : '');
      exitBtn.classList.toggle('hidden', !position.manual);
    } else if (position && (position.action === 'holding' || position.action === 'settling')) {
      cashout.classList.add('hidden');
      holding.classList.remove('hidden');
      enterRow.classList.add('hidden');
      document.getElementById('holdingSide').textContent = (position.side || '').toUpperCase();
      document.getElementById('holdingEntry').textContent = Number.isFinite(position.entryCents) ? Math.round(position.entryCents) + '¢' : '—';
      document.getElementById('holdingNow').textContent = Number.isFinite(position.nowCents) ? Math.round(position.nowCents) + '¢' : (position.action === 'settling' ? 'settling…' : '—');
      exitBtn2.classList.toggle('hidden', !position.manual);
    } else {
      cashout.classList.add('hidden');
      holding.classList.add('hidden');
      enterRow.classList.remove('hidden');
    }
  }

  function paintRecord(record) {
    var el = document.getElementById('record');
    if (!record || record.total === 0) { el.textContent = 'No settled trades yet'; return; }
    el.innerHTML = '📊 <span class="up">' + record.wins + 'W</span> – <span class="down">' + record.losses + 'L</span>' +
      (record.breakEven ? ' – ' + record.breakEven + ' push' : '') +
      (record.winRate !== null ? ' <b>(' + Math.round(record.winRate * 100) + '%)</b>' : '');
  }

  function paintIndicators(ind) {
    if (!ind) return;
    document.getElementById('rsiVal').textContent = Number.isFinite(ind.rsi) ? Math.round(ind.rsi) : '—';
    var rsiEl = document.getElementById('rsiVal');
    rsiEl.className = 'value ' + (ind.rsi >= 70 ? 'down' : ind.rsi <= 30 ? 'up' : 'violet');

    var mom = document.getElementById('momentum');
    if (Number.isFinite(ind.momentum)) {
      mom.textContent = (ind.momentum > 0 ? '+' : '') + ind.momentum.toFixed(2) + '%';
      mom.className = 'value ' + (ind.momentum > 0 ? 'up' : ind.momentum < 0 ? 'down' : '');
    } else { mom.textContent = '—'; mom.className = 'value'; }

    document.getElementById('trendR2').textContent = Number.isFinite(ind.trendR2) ? ind.trendR2.toFixed(2) : '—';
    document.getElementById('sigmaDist').textContent = Number.isFinite(ind.sigmaDistance) ? (ind.sigmaDistance > 0 ? '+' : '') + ind.sigmaDistance.toFixed(2) + 'σ' : '—';
  }

  function paint(data) {
    paintPosition(data.position);
    paintRecord(data.record);
    paintIndicators(data.indicators);
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
    rawCandles = data.candles || [];
    rawVolume = data.volume || [];
    redrawChart(data);
    closesAtMs = Number.isFinite(data.secondsLeft) ? Date.now() + data.secondsLeft * 1000 : null;
  }

  function tickClock() {
    if (closesAtMs === null) { document.getElementById('clock').textContent = '—'; return; }
    var left = (closesAtMs - Date.now()) / 1000;
    document.getElementById('clock').textContent = fmtClock(left);
  }
  setInterval(tickClock, 1000);

  var lastData = null;

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
        lastData = data;
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

  document.querySelectorAll('.tf-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      timeframe = Number(btn.getAttribute('data-tf'));
      document.querySelectorAll('.tf-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (lastData) redrawChart(lastData);
    });
  });

  function authHeaders() { return token ? { 'x-dashboard-token': token } : {}; }

  async function enter(side) {
    var buttons = document.querySelectorAll('.enterBtn');
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      var res = await fetch('/api/enter?side=' + side, { method: 'POST', headers: authHeaders() });
      var data = await res.json();
      if (!data.ok) alert(data.reason || 'Could not record that entry.');
      poll();
    } catch (e) {
      alert('Could not reach the bot.');
    } finally {
      buttons.forEach(function (b) { b.disabled = false; });
    }
  }

  async function exitManual() {
    try { await fetch('/api/exit', { method: 'POST', headers: authHeaders() }); } catch (e) {}
    poll();
  }

  document.getElementById('enterUp').addEventListener('click', function () { enter('up'); });
  document.getElementById('enterDown').addEventListener('click', function () { enter('down'); });
  document.getElementById('exitBtn').addEventListener('click', exitManual);
  document.getElementById('exitBtn2').addEventListener('click', exitManual);

  initCharts();
  frame.classList.remove('hidden');
  poll();
  setInterval(poll, 4000);
})();
</script>
</body>
</html>`;
}
