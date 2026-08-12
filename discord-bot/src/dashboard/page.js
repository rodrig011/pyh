/**
 * One self-contained HTML page. No build step — it polls /api/read every few
 * seconds and repaints itself. The candlestick chart is TradingView's own
 * open-source "Lightweight Charts" library (loaded from a CDN, MIT/Apache
 * licensed) rather than hand-drawn canvas — real price/time axes, a
 * crosshair with an OHLC tooltip, zoom and pan, the genuine article instead
 * of an approximation of one. If the CDN cannot be reached the page still
 * works; the chart panel just says so instead of crashing.
 *
 * Visual language: a plain, restrained "verified ledger" report rather than a
 * sci-fi HUD — hairline-bordered sections with a small label and status badge
 * each, muted state colors, no glow or motion for its own sake. The data
 * earns the attention, not the chrome around it.
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%AF%3C/text%3E%3C/svg%3E" />
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0b0d;
    --card: #17181b;
    --panel: #1c1e22;
    --border: rgba(255,255,255,0.09);
    --border-soft: rgba(255,255,255,0.06);
    --ink: #f2f3f4;
    --dim: #90959d;
    --dim2: #5a5f68;
    --up: #3ecf8e;
    --down: #f2555a;
    --blue: #5b9df5;
    --amber: #e2a63f;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg);
    font-family: var(--sans);
    color: var(--ink);
    padding: 28px 14px;
    overflow-x: hidden;
  }

  .frame { width: min(720px, 100%); }

  .card {
    border-radius: 14px; padding: 22px 22px 18px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  }

  .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .brand { font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
  .live { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; color: var(--dim); text-transform: uppercase; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--up); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* A bordered block with a small label + optional status badge — the
     repeated unit the whole page is built from, the same way the reference
     report is a stack of labelled cards rather than one continuous screen. */
  .section { border: 1px solid var(--border-soft); border-radius: 10px; padding: 14px 16px 16px; margin-bottom: 10px; background: rgba(255,255,255,0.012); }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
  .badge { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 700; padding: 3px 9px; border-radius: 20px; background: rgba(255,255,255,0.07); color: var(--ink); }
  .badge.up { color: var(--up); background: rgba(62,207,142,0.12); }
  .badge.down { color: var(--down); background: rgba(242,85,90,0.12); }
  .badge.blue { color: var(--blue); background: rgba(91,157,245,0.12); }
  .badge.amber { color: var(--amber); background: rgba(226,166,63,0.12); }

  .cashout {
    text-align: center; margin-bottom: 12px; padding: 14px; border-radius: 10px;
    border: 1px solid rgba(226,166,63,0.4); background: rgba(226,166,63,0.08);
  }
  .cashout-title { font-size: 22px; font-weight: 800; letter-spacing: 0.02em; color: var(--amber); }
  .cashout-sub { font-family: var(--mono); font-size: 11px; color: var(--amber); opacity: 0.85; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.03em; }
  .holding {
    text-align: center; margin-bottom: 12px; padding: 9px; border-radius: 8px; font-family: var(--mono); font-size: 11px;
    letter-spacing: 0.03em; color: var(--blue); border: 1px solid var(--border); background: rgba(91,157,245,0.06);
  }
  .record { text-align: center; font-family: var(--mono); font-size: 11px; letter-spacing: 0.03em; color: var(--dim); margin-bottom: 10px; text-transform: uppercase; }
  .record b { color: var(--ink); }
  .record .up { color: var(--up); } .record .down { color: var(--down); }

  .order-list { display: flex; flex-direction: column; gap: 1px; }
  .order-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 7px 2px; border-bottom: 1px solid var(--border-soft); font-family: var(--mono); font-size: 11px;
  }
  .order-row:last-child { border-bottom: none; }
  .order-left { display: flex; align-items: center; gap: 8px; color: var(--dim); min-width: 0; }
  .order-side { text-transform: uppercase; letter-spacing: 0.03em; font-weight: 600; color: var(--ink); }
  .order-side.down { color: var(--down); }
  .order-side.up { color: var(--up); }
  .order-forced { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--amber); border: 1px solid rgba(226,166,63,0.35); border-radius: 4px; padding: 1px 4px; }
  .order-right { font-weight: 600; white-space: nowrap; }
  .order-empty { color: var(--dim2); font-family: var(--mono); font-size: 11px; text-align: center; padding: 10px 0; }

  .enter-row { display: flex; gap: 10px; margin-bottom: 12px; }
  .enterBtn {
    flex: 1; padding: 12px; border-radius: 8px; font-family: var(--sans); font-size: 12px; letter-spacing: 0.04em;
    text-transform: uppercase; font-weight: 700; cursor: pointer; border: 1px solid; background: transparent; transition: background 0.15s ease;
  }
  .enterBtn.up { color: var(--up); border-color: rgba(62,207,142,0.4); }
  .enterBtn.up:hover { background: rgba(62,207,142,0.08); }
  .enterBtn.down { color: var(--down); border-color: rgba(242,85,90,0.4); }
  .enterBtn.down:hover { background: rgba(242,85,90,0.08); }
  .enterBtn:disabled { opacity: 0.4; cursor: default; }

  .clearBtn {
    display: block; margin: 8px auto 0; padding: 5px 14px; border-radius: 6px; font-family: var(--sans); font-size: 10px;
    letter-spacing: 0.05em; text-transform: uppercase; cursor: pointer; border: 1px solid var(--border);
    background: rgba(255,255,255,0.03); color: var(--dim);
  }
  .clearBtn:hover { color: var(--ink); border-color: var(--dim2); }

  .asset { text-align: center; font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; color: var(--dim); text-transform: uppercase; margin-bottom: 8px; }
  .call-wrap { display: flex; align-items: center; justify-content: center; margin: 4px 0; }
  .ring { display: none; }
  .call { text-align: center; font-size: 34px; font-weight: 800; letter-spacing: 0.01em; }
  .call.up { color: var(--up); } .call.down { color: var(--down); }
  .call.none { color: var(--dim); font-size: 20px; letter-spacing: 0.1em; }
  .sub { text-align: center; color: var(--dim); font-size: 11px; letter-spacing: 0.03em; margin-bottom: 14px; text-transform: uppercase; }

  .chart-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-bottom: 6px; }
  .tf-btn {
    font-family: var(--mono); font-size: 10px; letter-spacing: 0.05em; padding: 4px 10px; border-radius: 5px;
    border: 1px solid var(--border); background: transparent; color: var(--dim); cursor: pointer;
  }
  .tf-btn.active { color: var(--ink); border-color: var(--dim2); background: rgba(255,255,255,0.06); }
  .chart-wrap {
    position: relative; border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel); margin-bottom: 10px; overflow: hidden;
  }
  #chartMain { width: 100%; height: 300px; }
  .ohlc-legend {
    position: absolute; top: 6px; left: 8px; z-index: 3; font-family: var(--mono); font-size: 10px; letter-spacing: 0.02em; color: var(--dim);
    display: flex; gap: 10px; pointer-events: none;
  }
  .ohlc-legend b { color: var(--ink); font-weight: 700; }
  .ohlc-legend .up { color: var(--up); } .ohlc-legend .down { color: var(--down); }
  .rsi-wrap {
    border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel); margin-bottom: 14px; overflow: hidden;
    position: relative;
  }
  #chartRsi { width: 100%; height: 90px; }
  .rsi-label { position: absolute; top: 4px; left: 8px; font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; color: var(--dim); text-transform: uppercase; z-index: 2; }
  .chart-fallback { padding: 40px 10px; text-align: center; color: var(--dim); font-size: 11px; letter-spacing: 0.02em; }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px; }
  .stat { background: var(--panel); border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px 8px; text-align: center; }
  .stat .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin-bottom: 6px; }
  .stat .value { font-size: 16px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  .stat .value.up { color: var(--up); } .stat .value.down { color: var(--down); } .stat .value.amber { color: var(--amber); } .stat .value.violet { color: var(--blue); }

  .view-tabs { display: flex; gap: 4px; margin-bottom: 14px; padding: 3px; background: var(--panel); border: 1px solid var(--border-soft); border-radius: 9px; }
  .view-tab {
    flex: 1; font-family: var(--sans); font-size: 11px; letter-spacing: 0.02em; font-weight: 600; padding: 7px 6px;
    border-radius: 6px; border: none; background: transparent; color: var(--dim); cursor: pointer;
  }
  .view-tab.active { color: var(--ink); background: var(--card); }
  .view.hidden { display: none; }

  .panel-title { font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--dim); margin: 14px 0 8px; font-weight: 600; }
  .panel-title:first-child { margin-top: 0; }

  .lean-wrap { text-align: center; margin-bottom: 8px; }
  .lean { font-size: 22px; font-weight: 800; letter-spacing: 0.01em; }
  .lean.up { color: var(--up); } .lean.down { color: var(--down); }
  .lean.none { color: var(--dim); font-size: 16px; letter-spacing: 0.08em; }
  .lean-score { font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 2px; }
  .lean-reasons { font-family: var(--mono); font-size: 11px; color: var(--dim); line-height: 1.7; margin: 8px 0 4px; }
  .agree-row { display: flex; gap: 8px; margin-top: 10px; }
  .agree-stat { flex: 1; text-align: center; padding: 8px 4px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border-soft); }
  .agree-stat .label { font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); margin-bottom: 4px; }
  .agree-stat .value { font-size: 13px; font-weight: 700; color: var(--ink); }
  .agree-stat .n { font-family: var(--mono); font-size: 9px; color: var(--dim2); }

  .rails { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 12px; padding: 10px; border-radius: 8px; }
  .rails.armed { background: rgba(242,85,90,0.08); border: 1px solid rgba(242,85,90,0.35); }
  .rails.disarmed { background: var(--panel); border: 1px solid var(--border-soft); }
  .rails.killed { background: rgba(226,166,63,0.08); border: 1px solid rgba(226,166,63,0.35); }
  .rails-label { font-size: 13px; font-weight: 800; letter-spacing: 0.02em; }
  .rails.armed .rails-label { color: var(--down); }
  .rails.disarmed .rails-label { color: var(--dim); }
  .rails.killed .rails-label { color: var(--amber); }
  .budget-bar { height: 6px; border-radius: 4px; background: var(--panel); overflow: hidden; margin: 4px 0 14px; }
  .budget-bar .fill { height: 100%; background: var(--blue); transition: width 0.4s ease; }
  .live-note { text-align: center; font-family: var(--mono); font-size: 10px; color: var(--dim); margin-top: 10px; letter-spacing: 0.01em; line-height: 1.6; }

  .bar-row { margin-bottom: 8px; }
  .bar-row .labels { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; letter-spacing: 0.03em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  .bar { height: 6px; border-radius: 4px; background: var(--panel); overflow: hidden; position: relative; }
  .bar .fill { position: absolute; inset: 0; border-radius: 4px; transition: width 0.4s ease; }
  .bar .fill.model { background: var(--blue); }
  .bar .fill.market { background: var(--dim2); }

  .whale { margin-top: 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel); font-family: var(--mono); font-size: 12px; color: var(--dim); transition: all 0.3s ease; min-height: 16px; }
  .whale.active { border-color: rgba(226,166,63,0.3); background: rgba(226,166,63,0.05); color: var(--amber); }

  .reason { text-align: center; font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 10px; letter-spacing: 0.01em; }
  .clock-row { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-soft); }
  .clock-row .label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
  .clock { font-family: var(--mono); font-size: 17px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  .stale { text-align: center; margin-top: 10px; font-family: var(--mono); font-size: 11px; color: var(--down); visibility: hidden; letter-spacing: 0.03em; }

  .gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 16px; }
  .gate input {
    background: var(--panel); border: 1px solid var(--border); color: var(--ink);
    padding: 12px 16px; border-radius: 8px; font-size: 16px; width: min(260px, 80vw); text-align: center; font-family: var(--sans);
  }
  .gate input:focus { outline: none; border-color: var(--dim2); }
  .gate button {
    background: var(--panel); color: var(--ink); border: 1px solid var(--border); padding: 12px 22px;
    border-radius: 8px; cursor: pointer; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; font-family: var(--sans); font-weight: 600;
  }
  .gate button:hover { background: rgba(255,255,255,0.08); }
  .hidden { display: none; }

  /* Phones — portrait, roughly iPhone SE up to a large Android in portrait. */
  @media (max-width: 480px) {
    body { padding: 12px 8px; align-items: flex-start; }
    .card { padding: 16px 14px 16px; border-radius: 12px; }

    .brand { font-size: 10px; letter-spacing: 0.1em; }
    .topbar { margin-bottom: 14px; }

    .cashout-title { font-size: 18px; }
    .cashout { padding: 12px; }
    .holding { font-size: 10px; line-height: 1.6; }

    .enter-row { flex-direction: column; gap: 8px; }
    .enterBtn { padding: 13px; font-size: 12px; }

    .call { font-size: 26px; }
    .call.none { font-size: 16px; }
    .asset { font-size: 10px; }
    .sub { font-size: 10px; margin-bottom: 12px; }

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

    .view-tab { font-size: 10px; padding: 8px 4px; }
    .lean { font-size: 19px; }
    .agree-row { flex-wrap: wrap; }
    .agree-stat { min-width: calc(50% - 4px); }
  }

  /* Small/older phones — iPhone SE 1st gen and similar 320-360px widths. */
  @media (max-width: 360px) {
    .grid { grid-template-columns: repeat(2, 1fr); gap: 6px; }
    .call { font-size: 22px; }
    #chartMain { height: 190px; }
  }
</style>
</head>
<body>
<div id="gate" class="gate hidden">
  <div class="brand">${brandName}</div>
  <input id="tokenInput" type="password" placeholder="ACCESS CODE" />
  <button id="tokenSubmit">Unlock</button>
  <div id="gateError" style="color:var(--down);font-size:12px;font-family:var(--sans);"></div>
</div>

<div id="frame" class="frame hidden">
  <div class="card">
    <div class="topbar">
      <div class="brand">${brandName} / Live Read</div>
      <div class="live"><span class="dot"></span>LIVE</div>
    </div>

    <div class="view-tabs">
      <button class="view-tab active" data-view="viewSignal">Signal</button>
      <button class="view-tab" data-view="viewIndicators">Indicators</button>
      <button class="view-tab" data-view="viewLive">Live $</button>
    </div>

    <div id="viewSignal" class="view">
    <div id="cashout" class="cashout hidden">
      <div class="cashout-title">CASH OUT</div>
      <div class="cashout-sub" id="cashoutSub">—</div>
      <button id="exitBtn" class="clearBtn hidden">Clear</button>
    </div>
    <div id="holding" class="holding hidden">
      HOLDING <span id="holdingSide"></span> · entry <span id="holdingEntry"></span> · now <span id="holdingNow"></span>
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

    <div class="section">
      <div class="section-head"><span class="section-title">Read</span></div>
      <div class="grid">
        <div class="stat"><div class="label">Confidence</div><div class="value" id="conf">—</div></div>
        <div class="stat"><div class="label">Entry</div><div class="value" id="entry">—</div></div>
        <div class="stat"><div class="label">Flip odds</div><div class="value amber" id="flip">—</div></div>
        <div class="stat"><div class="label">Strike</div><div class="value" id="strike">—</div></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Trend &amp; momentum</span></div>
      <div class="grid">
        <div class="stat"><div class="label">RSI (14)</div><div class="value violet" id="rsiVal">—</div></div>
        <div class="stat"><div class="label">Momentum</div><div class="value" id="momentum">—</div></div>
        <div class="stat"><div class="label">Trend R²</div><div class="value" id="trendR2">—</div></div>
        <div class="stat"><div class="label">Strike, in σ</div><div class="value" id="sigmaDist">—</div></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Model vs. market</span></div>
      <div class="bar-row">
        <div class="labels"><span>Model</span><span id="modelPct">—</span></div>
        <div class="bar"><div class="fill model" id="modelBar" style="width:0%"></div></div>
      </div>
      <div class="bar-row" style="margin-bottom:0">
        <div class="labels"><span>Market</span><span id="marketPct">—</span></div>
        <div class="bar"><div class="fill market" id="marketBar" style="width:0%"></div></div>
      </div>
    </div>

    <div class="whale" id="whale"></div>
    <div class="reason" id="reason"></div>
    </div>

    <div id="viewIndicators" class="view hidden">
      <div class="section">
        <div class="section-head">
          <span class="section-title">Model track record</span>
          <span class="badge amber" id="trackBadge">COLLECTING</span>
        </div>
        <div class="grid" style="margin-bottom:0">
          <div class="stat"><div class="label">Settled</div><div class="value" id="trackSettled">—</div></div>
          <div class="stat"><div class="label">Markets</div><div class="value" id="trackMarkets">—</div></div>
          <div class="stat"><div class="label">Model Brier</div><div class="value" id="trackModelBrier">—</div></div>
          <div class="stat"><div class="label">Market Brier</div><div class="value" id="trackMarketBrier">—</div></div>
        </div>
        <div class="live-note" id="trackNote">Not enough settled markets yet — this fills in on its own as windows close.</div>
      </div>

      <div class="section">
        <div class="section-head"><span class="section-title">Trend &amp; momentum</span></div>
        <div class="grid">
          <div class="stat"><div class="label">EMA 9/21/50</div><div class="value" id="emaStack">—</div></div>
          <div class="stat"><div class="label">MACD hist.</div><div class="value" id="macdHist">—</div></div>
          <div class="stat"><div class="label">Bollinger width</div><div class="value" id="bbWidth">—</div></div>
          <div class="stat"><div class="label">ATR</div><div class="value" id="atrVal">—</div></div>
        </div>
        <div class="grid" style="margin-bottom:0">
          <div class="stat"><div class="label">RSI (14)</div><div class="value violet" id="rsiVal2">—</div></div>
          <div class="stat"><div class="label">Momentum</div><div class="value" id="momentum2">—</div></div>
          <div class="stat"><div class="label">Trend R²</div><div class="value" id="trendR2b">—</div></div>
          <div class="stat"><div class="label">Session</div><div class="value" id="session">—</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-title">Confluence — a second, independent read</span>
          <span class="badge blue" id="confBadge">EVALUATING</span>
        </div>
        <div class="lean-wrap">
          <div class="lean none" id="confLean">NO LEAN</div>
          <div class="lean-score" id="confScore">—</div>
        </div>
        <div class="lean-reasons" id="confReasons"></div>
        <div class="agree-row">
          <div class="agree-stat"><div class="label">Overall</div><div class="value" id="confOverall">—</div><div class="n" id="confOverallN"></div></div>
          <div class="agree-stat"><div class="label">Agrees w/ model</div><div class="value" id="confAgrees">—</div><div class="n" id="confAgreesN"></div></div>
          <div class="agree-stat"><div class="label">Disagrees</div><div class="value" id="confDisagrees">—</div><div class="n" id="confDisagreesN"></div></div>
        </div>
        <div class="live-note">Never fed into the call above — kept separate so it can be checked against the model, not blended into it. Needs a fortnight of settled windows before either number means anything.</div>
      </div>
    </div>

    <div id="viewLive" class="view hidden">
      <div class="rails disarmed" id="railsBox">
        <span class="rails-label" id="railsLabel">DISARMED</span>
      </div>
      <div class="section">
        <div class="section-head"><span class="section-title">Today</span></div>
        <div class="grid">
          <div class="stat"><div class="label">Spent today</div><div class="value" id="liveSpent">—</div></div>
          <div class="stat"><div class="label">Remaining</div><div class="value" id="liveRemaining">—</div></div>
          <div class="stat"><div class="label">Orders today</div><div class="value" id="liveTrades">—</div></div>
          <div class="stat"><div class="label">Realised</div><div class="value" id="liveRealised">—</div></div>
        </div>
        <div class="budget-bar" style="margin-bottom:0"><div class="fill" id="liveBudgetFill" style="width:0%"></div></div>
      </div>
      <div class="section">
        <div class="section-head"><span class="section-title">Today's orders</span></div>
        <div class="order-list" id="liveOrders"></div>
      </div>
      <div class="live-note" id="liveNote">Arming and disarming real money only happens in Discord — /picks live — never from this page, on purpose.</div>
    </div>

    <div class="clock-row"><span class="label">Closes in</span><span class="clock" id="clock">—</span></div>
    <div class="stale" id="stale">FEED STALE — RECONNECTING…</div>
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
      layout: { background: { color: 'transparent' }, textColor: '#90959d', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      handleScroll: true, handleScale: true,
    };

    chart = LightweightCharts.createChart(document.getElementById('chartMain'), Object.assign({
      width: document.getElementById('chartMain').clientWidth, height: 260,
    }, common));
    candleSeries = chart.addCandlestickSeries({
      upColor: '#3ecf8e', downColor: '#f2555a', borderVisible: false,
      wickUpColor: '#3ecf8e', wickDownColor: '#f2555a',
    });

    // Real Kalshi contract volume, sparse by nature — see buildVolume server
    // side. Squeezed into the bottom 15% of the same pane, the way a proper
    // terminal does it, rather than a whole separate chart for what is often
    // a handful of bars.
    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: 'rgba(144,149,157,0.45)',
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
    }, common, { rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' } }));
    rsiSeries = rsiChart.addLineSeries({ color: '#5b9df5', lineWidth: 2 });
    rsiSeries.createPriceLine({ price: 70, color: 'rgba(242,85,90,0.4)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '70' });
    rsiSeries.createPriceLine({ price: 30, color: 'rgba(62,207,142,0.4)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '30' });
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
        price: data.strike, color: '#90959d', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'strike',
      });
    }

    if (spotLine) { candleSeries.removePriceLine(spotLine); spotLine = null; }
    if (Number.isFinite(data.spot)) {
      spotLine = candleSeries.createPriceLine({
        price: data.spot, color: '#5b9df5', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
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
        price: data.expectedRange.high, color: 'rgba(91,157,245,0.5)', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true, title: '~68% hi',
      });
      rangeLoLine = candleSeries.createPriceLine({
        price: data.expectedRange.low, color: 'rgba(91,157,245,0.5)', lineWidth: 1,
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
    el.innerHTML = '<span class="up">' + record.wins + 'W</span> – <span class="down">' + record.losses + 'L</span>' +
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

    // The Indicators tab — same numbers where they overlap (RSI, momentum,
    // trend), plus the ones that only fit there: EMA stack, MACD, Bollinger
    // width, ATR, session. Two IDs for RSI/momentum/trend on purpose, one per
    // tab, so painting one tab never silently touches the other's DOM.
    var stackEl = document.getElementById('emaStack');
    stackEl.textContent = ind.emaStack ? ind.emaStack.toUpperCase() : '—';
    stackEl.className = 'value ' + (ind.emaStack === 'bullish' ? 'up' : ind.emaStack === 'bearish' ? 'down' : '');

    var macdEl = document.getElementById('macdHist');
    if (Number.isFinite(ind.macdHistogram)) {
      macdEl.textContent = (ind.macdHistogram > 0 ? '+' : '') + ind.macdHistogram.toFixed(1);
      macdEl.className = 'value ' + (ind.macdHistogram > 0 ? 'up' : ind.macdHistogram < 0 ? 'down' : '');
    } else { macdEl.textContent = '—'; macdEl.className = 'value'; }

    document.getElementById('bbWidth').textContent = Number.isFinite(ind.bollingerWidthPercent) ? ind.bollingerWidthPercent.toFixed(2) + '%' : '—';
    document.getElementById('atrVal').textContent = Number.isFinite(ind.atr) ? '$' + Math.round(ind.atr).toLocaleString('en-US') : '—';
    document.getElementById('session').textContent = ind.session ? ind.session.replace(/_/g, ' ').toUpperCase() : '—';

    var rsiEl2 = document.getElementById('rsiVal2');
    rsiEl2.textContent = Number.isFinite(ind.rsi) ? Math.round(ind.rsi) : '—';
    rsiEl2.className = 'value ' + (ind.rsi >= 70 ? 'down' : ind.rsi <= 30 ? 'up' : 'violet');

    var mom2 = document.getElementById('momentum2');
    if (Number.isFinite(ind.momentum)) {
      mom2.textContent = (ind.momentum > 0 ? '+' : '') + ind.momentum.toFixed(2) + '%';
      mom2.className = 'value ' + (ind.momentum > 0 ? 'up' : ind.momentum < 0 ? 'down' : '');
    } else { mom2.textContent = '—'; mom2.className = 'value'; }

    document.getElementById('trendR2b').textContent = Number.isFinite(ind.trendR2) ? ind.trendR2.toFixed(2) : '—';
  }

  function paintConfluence(confluence, measured) {
    var leanEl = document.getElementById('confLean');
    var badge = document.getElementById('confBadge');
    if (confluence && confluence.lean === 'up') {
      leanEl.textContent = '▲ LEANING UP'; leanEl.className = 'lean up';
      badge.textContent = 'UP'; badge.className = 'badge up';
    } else if (confluence && confluence.lean === 'down') {
      leanEl.textContent = '▼ LEANING DOWN'; leanEl.className = 'lean down';
      badge.textContent = 'DOWN'; badge.className = 'badge down';
    } else {
      leanEl.textContent = confluence && confluence.squeeze ? 'SQUEEZE — NO LEAN' : 'NO LEAN';
      leanEl.className = 'lean none';
      badge.textContent = confluence && confluence.squeeze ? 'SQUEEZE' : 'NEUTRAL';
      badge.className = 'badge';
    }
    document.getElementById('confScore').textContent = confluence && Number.isFinite(confluence.score) ? 'score ' + (confluence.score > 0 ? '+' : '') + confluence.score : '—';
    var reasons = (confluence && confluence.reasons) || [];
    document.getElementById('confReasons').textContent = reasons.length ? reasons.join(' · ') : 'Nothing lining up right now.';

    function paintBucket(bucket, valueId, nId) {
      var valueEl = document.getElementById(valueId);
      var nEl = document.getElementById(nId);
      if (!bucket || !bucket.enough) {
        valueEl.textContent = bucket ? bucket.settled + '/20' : '—';
        valueEl.className = 'value';
        nEl.textContent = 'need 20+';
        return;
      }
      var pct = Math.round(bucket.winRate * 100);
      valueEl.textContent = pct + '%';
      valueEl.className = 'value ' + (pct > 55 ? 'up' : pct < 45 ? 'down' : '');
      nEl.textContent = bucket.settled + ' settled';
    }

    var byBucket = {};
    (measured || []).forEach(function (row) { byBucket[row.bucket] = row; });
    paintBucket(byBucket.overall, 'confOverall', 'confOverallN');
    paintBucket(byBucket.agrees_with_model, 'confAgrees', 'confAgreesN');
    paintBucket(byBucket.disagrees_with_model, 'confDisagrees', 'confDisagreesN');
  }

  function paintLiveTrading(lt) {
    var box = document.getElementById('railsBox');
    var label = document.getElementById('railsLabel');
    if (!lt) return;

    if (lt.killed) {
      box.className = 'rails killed';
      label.textContent = 'KILLED' + (lt.killedReason ? ' — ' + lt.killedReason : '');
    } else if (lt.armed) {
      box.className = 'rails armed';
      label.textContent = 'ARMED — REAL MONEY';
    } else {
      box.className = 'rails disarmed';
      label.textContent = 'DISARMED';
    }

    var money = function (n) { return Number.isFinite(n) ? '$' + n.toFixed(2) : '—'; };
    document.getElementById('liveSpent').textContent = money(lt.spent);
    document.getElementById('liveRemaining').textContent = money(lt.remaining);
    document.getElementById('liveTrades').textContent = Number.isFinite(lt.trades) ? String(lt.trades) : '—';
    var realisedEl = document.getElementById('liveRealised');
    realisedEl.textContent = Number.isFinite(lt.realised) ? (lt.realised >= 0 ? '+' : '') + money(lt.realised) : '—';
    realisedEl.className = 'value ' + (lt.realised > 0 ? 'up' : lt.realised < 0 ? 'down' : '');

    var pct = lt.limit > 0 ? Math.min(100, (lt.spent / lt.limit) * 100) : 0;
    document.getElementById('liveBudgetFill').style.width = pct + '%';

    var list = document.getElementById('liveOrders');
    var orders = lt.recentOrders || [];
    if (!orders.length) {
      list.innerHTML = '<div class="order-empty">No orders yet today.</div>';
    } else {
      list.innerHTML = orders.map(function (o) {
        var time = o.at ? new Date(o.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
        var side = o.side === 'yes' ? 'UP' : o.side === 'no' ? 'DOWN' : (o.side || '—').toUpperCase();
        var sideClass = o.side === 'yes' ? 'up' : o.side === 'no' ? 'down' : '';
        var forced = o.forced ? '<span class="order-forced">forced</span>' : '';
        var right;
        if (Number.isFinite(o.profitDollars)) {
          right = '<span class="' + (o.profitDollars > 0 ? 'up' : o.profitDollars < 0 ? 'down' : '') + '">' +
            (o.profitDollars >= 0 ? '+' : '') + money(o.profitDollars) + '</span>';
        } else if (o.status === 'unknown') {
          right = '<span style="color:var(--amber)">unknown</span>';
        } else {
          right = '<span style="color:var(--dim)">open</span>';
        }
        return '<div class="order-row">' +
          '<div class="order-left">' +
            '<span>' + time + '</span>' +
            '<span class="order-side ' + sideClass + '">' + side + '</span>' +
            '<span>' + (Number.isFinite(o.contracts) ? o.contracts + 'x @ ' + o.limitCents + '%' : '') + '</span>' +
            forced +
          '</div>' +
          '<div class="order-right">' + right + '</div>' +
        '</div>';
      }).join('');
    }
  }

  function paintTrackRecord(tr) {
    var badge = document.getElementById('trackBadge');
    var note = document.getElementById('trackNote');

    document.getElementById('trackSettled').textContent = tr && Number.isFinite(tr.settled) ? String(tr.settled) : '—';
    document.getElementById('trackMarkets').textContent = tr && tr.ready ? String(tr.markets) : '—';
    document.getElementById('trackModelBrier').textContent = tr && Number.isFinite(tr.modelBrier) ? tr.modelBrier.toFixed(3) : '—';
    document.getElementById('trackMarketBrier').textContent = tr && Number.isFinite(tr.marketBrier) ? tr.marketBrier.toFixed(3) : '—';

    if (!tr || !tr.ready) {
      badge.textContent = 'COLLECTING'; badge.className = 'badge amber';
      note.textContent = 'Not enough settled markets yet — this fills in on its own as windows close.';
      return;
    }

    if (tr.modelBeatsMarket === true) {
      badge.textContent = 'MODEL AHEAD'; badge.className = 'badge up';
      note.textContent = 'The model is the better forecaster here, by more than the noise between them.';
    } else if (tr.modelBeatsMarket === false) {
      badge.textContent = 'MARKET AHEAD'; badge.className = 'badge down';
      note.textContent = 'The market is the better forecaster on what has settled so far — no measured edge to trade.';
    } else {
      badge.textContent = 'TOO CLOSE'; badge.className = 'badge blue';
      note.textContent = 'The gap between model and market has not cleared the noise yet. Same measurement as /picks edge in Discord.';
    }
  }

  function paint(data) {
    paintPosition(data.position);
    paintRecord(data.record);
    paintIndicators(data.indicators);
    paintConfluence(data.confluence, data.confluenceMeasured);
    paintLiveTrading(data.liveTrading);
    paintTrackRecord(data.trackRecord);
    document.getElementById('asset').textContent = data.asset + (data.ticker ? ' · ' + data.ticker : '');
    var callEl = document.getElementById('call');
    if (data.call === 'up') {
      callEl.textContent = '▲ UP'; callEl.className = 'call up';
    } else if (data.call === 'down') {
      callEl.textContent = '▼ DOWN'; callEl.className = 'call down';
    } else {
      callEl.textContent = 'NO READ'; callEl.className = 'call none';
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
      whaleEl.textContent = data.whales.line.replace(/\\*\\*/g, '').replace(/^🐋 /, '');
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

  document.querySelectorAll('.view-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-view');
      document.querySelectorAll('.view-tab').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
      btn.classList.add('active');
      document.getElementById(target).classList.remove('hidden');
      // The chart only sizes itself correctly against a panel that is
      // actually visible — switching back to Signal after another tab was
      // showing left it squashed to zero width until the next resize.
      if (target === 'viewSignal' && chart) {
        chart.applyOptions({ width: document.getElementById('chartMain').clientWidth });
        if (lastData) redrawChart(lastData);
      }
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

  // The frame has to be visible BEFORE the chart is created — Lightweight
  // Charts measures its container's clientWidth once, at creation time, and
  // a display:none ancestor measures as zero. Creating the chart first and
  // unhiding the frame a line later was the actual bug behind "candles never
  // show on desktop": a real chart, correctly fed real data, permanently
  // sized to zero pixels wide.
  frame.classList.remove('hidden');
  initCharts();
  poll();
  setInterval(poll, 4000);
})();
</script>
</body>
</html>`;
}
