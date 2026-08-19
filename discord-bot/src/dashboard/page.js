/**
 * One self-contained HTML page. No build step — it polls /api/read every few
 * seconds and repaints itself. The candlestick chart is TradingView's own
 * open-source "Lightweight Charts" library (loaded from a CDN, MIT/Apache
 * licensed) rather than hand-drawn canvas — real price/time axes, a
 * crosshair with an OHLC tooltip, zoom and pan, the genuine article instead
 * of an approximation of one. If the CDN cannot be reached the page still
 * works; the chart panel just says so instead of crashing.
 *
 * Visual language: a dark HUD/terminal look — glowing hairline borders, a
 * mono-heavy type rhythm, cyan/pink/amber accents on top of near-black.
 * Every number on the page is still something the bot actually computed;
 * the glow changed, the honesty rule that earned this dashboard its content
 * did not — see read.js and its refusal to report anything the trading
 * path itself would not stand behind.
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
    --bg: #05070a;
    --card: #0b0e14;
    --panel: #0e121a;
    --border: rgba(34,211,238,0.22);
    --border-soft: rgba(34,211,238,0.12);
    --ink: #eaf2f7;
    --dim: #7c8aa0;
    --dim2: #4a5568;
    --up: #21e6a1;
    --down: #ff4d6d;
    --blue: #22d3ee;
    --amber: #ffb020;
    --violet: #a78bfa;
    --glow-cyan: rgba(34,211,238,0.35);
    --glow-up: rgba(33,230,161,0.35);
    --glow-down: rgba(255,77,109,0.4);
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(circle at 15% 0%, rgba(34,211,238,0.08), transparent 45%),
      radial-gradient(circle at 100% 20%, rgba(167,139,250,0.06), transparent 40%),
      var(--bg);
    font-family: var(--sans);
    color: var(--ink);
    padding: 28px 14px;
    overflow-x: hidden;
  }

  .frame { width: min(720px, 100%); }
  @media (min-width: 860px) { .frame { width: min(880px, 94vw); } }
  @media (min-width: 1180px) { .frame { width: min(1180px, 92vw); } }

  /* Below the desktop breakpoint these are just two stacked blocks in
     document order — identical to how the page has always laid out. Above
     it, the chart gets the wide left column a real screen has room for, and
     the read/trend/model sections become a sidebar instead of more scroll. */
  @media (min-width: 980px) {
    .signal-layout { display: grid; grid-template-columns: 1.5fr 1fr; gap: 18px; align-items: start; }
    .side-col .section:last-of-type { margin-bottom: 0; }

    /* Each of these tabs is already just a sequence of self-contained
       .section blocks, so a real multi-column flow (not a grid, which would
       pair a tall block with a short one and leave a gap) fills the width
       the same way a normal site's sidebar-free dashboard page would. */
    #viewIndicators, #viewFlow, #viewLive {
      column-count: 2; column-gap: 18px;
    }
    #viewIndicators .section, #viewFlow .section, #viewLive .section,
    #viewLive .rails, #viewFlow .order-list, #viewLive .order-list {
      break-inside: avoid;
    }
  }

  .card {
    border-radius: 14px; padding: 22px 22px 18px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: 0 0 0 1px rgba(34,211,238,0.05), 0 24px 60px rgba(0,0,0,0.6), 0 0 40px -20px var(--glow-cyan);
  }

  .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .brand { font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
  .live { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; color: var(--up); text-transform: uppercase; text-shadow: 0 0 10px var(--glow-up); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--up); box-shadow: 0 0 8px 1px var(--glow-up); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* A bordered block with a small label + optional status badge — the
     repeated unit the whole page is built from, each one a small HUD panel
     with a faint cyan edge rather than a flat divider. */
  .section {
    border: 1px solid var(--border-soft); border-radius: 10px; padding: 14px 16px 16px; margin-bottom: 10px;
    background: linear-gradient(180deg, rgba(34,211,238,0.03), transparent 40%), rgba(255,255,255,0.012);
    position: relative;
  }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--blue); font-weight: 600; opacity: 0.85; }
  .badge { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 700; padding: 3px 9px; border-radius: 20px; background: rgba(255,255,255,0.07); color: var(--ink); }
  .badge.up { color: var(--up); background: rgba(33,230,161,0.12); box-shadow: 0 0 12px -4px var(--glow-up); }
  .badge.down { color: var(--down); background: rgba(255,77,109,0.14); box-shadow: 0 0 12px -4px var(--glow-down); }
  .badge.blue { color: var(--blue); background: rgba(34,211,238,0.12); box-shadow: 0 0 12px -4px var(--glow-cyan); }
  .badge.amber { color: var(--amber); background: rgba(255,176,32,0.14); box-shadow: 0 0 12px -4px rgba(255,176,32,0.4); }

  .cashout {
    text-align: center; margin-bottom: 12px; padding: 14px; border-radius: 10px;
    border: 1px solid rgba(255,176,32,0.45); background: rgba(255,176,32,0.08); box-shadow: 0 0 24px -10px rgba(255,176,32,0.5);
  }
  .cashout-title { font-size: 22px; font-weight: 800; letter-spacing: 0.02em; color: var(--amber); text-shadow: 0 0 16px rgba(255,176,32,0.4); }
  .cashout-sub { font-family: var(--mono); font-size: 11px; color: var(--amber); opacity: 0.85; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.03em; }
  .holding {
    text-align: center; margin-bottom: 12px; padding: 9px; border-radius: 8px; font-family: var(--mono); font-size: 11px;
    letter-spacing: 0.03em; color: var(--blue); border: 1px solid var(--border); background: rgba(34,211,238,0.06);
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
  .order-forced { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--amber); border: 1px solid rgba(255,176,32,0.4); border-radius: 4px; padding: 1px 4px; }
  .order-right { font-weight: 600; white-space: nowrap; }
  .order-empty { color: var(--dim2); font-family: var(--mono); font-size: 11px; text-align: center; padding: 10px 0; }

  .enter-row { display: flex; gap: 10px; margin-bottom: 12px; }
  .enterBtn {
    flex: 1; padding: 12px; border-radius: 8px; font-family: var(--sans); font-size: 12px; letter-spacing: 0.04em;
    text-transform: uppercase; font-weight: 700; cursor: pointer; border: 1px solid; background: transparent; transition: all 0.15s ease;
  }
  .enterBtn.up { color: var(--up); border-color: rgba(33,230,161,0.45); }
  .enterBtn.up:hover { background: rgba(33,230,161,0.08); box-shadow: 0 0 16px -6px var(--glow-up); }
  .enterBtn.down { color: var(--down); border-color: rgba(255,77,109,0.45); }
  .enterBtn.down:hover { background: rgba(255,77,109,0.08); box-shadow: 0 0 16px -6px var(--glow-down); }
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
  .call.up { color: var(--up); text-shadow: 0 0 24px var(--glow-up); }
  .call.down { color: var(--down); text-shadow: 0 0 24px var(--glow-down); }
  .call.none { color: var(--dim); font-size: 20px; letter-spacing: 0.1em; text-shadow: none; }
  .sub { text-align: center; color: var(--dim); font-size: 11px; letter-spacing: 0.03em; margin-bottom: 14px; text-transform: uppercase; }

  .chart-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-bottom: 6px; }
  .tf-btn {
    font-family: var(--mono); font-size: 10px; letter-spacing: 0.05em; padding: 4px 10px; border-radius: 5px;
    border: 1px solid var(--border); background: transparent; color: var(--dim); cursor: pointer;
  }
  .tf-btn.active { color: var(--blue); border-color: var(--border); background: rgba(34,211,238,0.08); box-shadow: 0 0 12px -6px var(--glow-cyan); }
  .chart-wrap {
    position: relative; border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel); margin-bottom: 10px; overflow: hidden;
    box-shadow: inset 0 0 40px -30px var(--glow-cyan);
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
  .stat .value.up { color: var(--up); text-shadow: 0 0 10px var(--glow-up); }
  .stat .value.down { color: var(--down); text-shadow: 0 0 10px var(--glow-down); }
  .stat .value.amber { color: var(--amber); text-shadow: 0 0 10px rgba(255,176,32,0.35); }
  .stat .value.violet { color: var(--violet); text-shadow: 0 0 10px rgba(167,139,250,0.35); }

  .view-tabs { display: flex; gap: 4px; margin-bottom: 14px; padding: 3px; background: var(--panel); border: 1px solid var(--border-soft); border-radius: 9px; }
  .view-tab {
    flex: 1; font-family: var(--sans); font-size: 11px; letter-spacing: 0.02em; font-weight: 600; padding: 7px 6px;
    border-radius: 6px; border: none; background: transparent; color: var(--dim); cursor: pointer;
  }
  .view-tab.active { color: var(--ink); background: var(--card); box-shadow: 0 0 0 1px var(--border), 0 0 14px -6px var(--glow-cyan); }
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

  .pattern-list { display: flex; flex-direction: column; gap: 6px; }
  .pattern-row { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border-soft); background: var(--panel); }
  .pattern-row.active { border-color: var(--border); box-shadow: 0 0 14px -8px var(--glow-cyan); }
  .pattern-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pattern-label { font-family: var(--sans); font-size: 12px; font-weight: 600; color: var(--ink); }
  .pattern-status { font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dim2); white-space: nowrap; }
  .pattern-status.up { color: var(--up); text-shadow: 0 0 8px var(--glow-up); }
  .pattern-status.down { color: var(--down); text-shadow: 0 0 8px var(--glow-down); }
  .pattern-note { font-family: var(--mono); font-size: 10px; color: var(--dim); margin-top: 4px; line-height: 1.5; }
  .pattern-radar { font-family: var(--mono); font-size: 10px; color: var(--violet); margin-top: 4px; line-height: 1.5; }

  .rails { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 12px; padding: 10px; border-radius: 8px; }
  .rails.armed { background: rgba(255,77,109,0.1); border: 1px solid rgba(255,77,109,0.45); box-shadow: 0 0 24px -8px var(--glow-down); animation: armedPulse 2.4s ease-in-out infinite; }
  @keyframes armedPulse { 0%,100% { box-shadow: 0 0 24px -8px var(--glow-down); } 50% { box-shadow: 0 0 34px -6px var(--glow-down); } }
  .rails.disarmed { background: var(--panel); border: 1px solid var(--border-soft); }
  .rails.killed { background: rgba(255,176,32,0.08); border: 1px solid rgba(255,176,32,0.4); }
  .rails-label { font-size: 13px; font-weight: 800; letter-spacing: 0.02em; }
  .rails.armed .rails-label { color: var(--down); text-shadow: 0 0 14px var(--glow-down); }
  .rails.disarmed .rails-label { color: var(--dim); }
  .rails.killed .rails-label { color: var(--amber); text-shadow: 0 0 14px rgba(255,176,32,0.4); }
  .budget-bar { height: 6px; border-radius: 4px; background: var(--panel); overflow: hidden; margin: 4px 0 14px; }
  .budget-bar .fill { height: 100%; background: var(--blue); box-shadow: 0 0 10px var(--glow-cyan); transition: width 0.4s ease; }
  .live-note { text-align: center; font-family: var(--mono); font-size: 10px; color: var(--dim); margin-top: 10px; letter-spacing: 0.01em; line-height: 1.6; }

  .bar-row { margin-bottom: 8px; }
  .bar-row .labels { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; letter-spacing: 0.03em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  .bar { height: 6px; border-radius: 4px; background: var(--panel); overflow: hidden; position: relative; }
  .bar .fill { position: absolute; inset: 0; border-radius: 4px; transition: width 0.4s ease; }
  .bar .fill.model { background: var(--blue); box-shadow: 0 0 8px var(--glow-cyan); }
  .bar .fill.market { background: var(--dim2); }
  .bar .fill.flow { background: linear-gradient(90deg, var(--down), var(--up)); }

  .whale { margin-top: 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel); font-family: var(--mono); font-size: 12px; color: var(--dim); transition: all 0.3s ease; min-height: 16px; }
  .whale.active { border-color: rgba(255,176,32,0.35); background: rgba(255,176,32,0.06); color: var(--amber); box-shadow: 0 0 16px -8px rgba(255,176,32,0.5); }

  .reason { text-align: center; font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 10px; letter-spacing: 0.01em; }
  .clock-row { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-soft); }
  .clock-row .label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
  .clock { font-family: var(--mono); font-size: 17px; font-weight: 700; color: var(--blue); font-variant-numeric: tabular-nums; text-shadow: 0 0 12px var(--glow-cyan); }
  .stale { text-align: center; margin-top: 10px; font-family: var(--mono); font-size: 11px; color: var(--down); visibility: hidden; letter-spacing: 0.03em; }

  .gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 16px; }
  .gate input {
    background: var(--panel); border: 1px solid var(--border); color: var(--ink);
    padding: 12px 16px; border-radius: 8px; font-size: 16px; width: min(260px, 80vw); text-align: center; font-family: var(--sans);
  }
  .gate input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue), 0 0 20px -8px var(--glow-cyan); }
  .gate button {
    background: var(--panel); color: var(--blue); border: 1px solid var(--border); padding: 12px 22px;
    border-radius: 8px; cursor: pointer; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; font-family: var(--sans); font-weight: 600;
  }
  .gate button:hover { background: rgba(34,211,238,0.08); box-shadow: 0 0 20px -8px var(--glow-cyan); }
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
      <button class="view-tab" data-view="viewFlow">Flow</button>
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

    <div class="signal-layout">
      <div class="hero-col">
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
      </div>

      <div class="side-col">
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
    </div>
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
          <span class="section-title">Pattern sonar — real swing geometry, not a guess</span>
          <span class="badge" id="patternBadge">SCANNING</span>
        </div>
        <div class="pattern-list" id="patternList"></div>
        <div class="live-note">Checked against the actual candles on every read. Most of the time none of these are real, and this says so rather than finding one anyway.</div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-title">Our own AI — round history</span>
          <span class="badge amber" id="aiBadge">COLLECTING</span>
        </div>
        <div class="grid" style="margin-bottom:0">
          <div class="stat"><div class="label">Recorded</div><div class="value" id="aiRecorded">—</div></div>
          <div class="stat"><div class="label">Settled</div><div class="value" id="aiSettled">—</div></div>
        </div>
        <div class="live-note" id="aiNote">Every round's full read (patterns, levels, gaps, indicators) is being saved with its real outcome, starting now. This is the history a real "rounds like this one" search will need — there is no way to back-date it, so it has to accumulate before it can say anything. Nothing here is guessed in the meantime.</div>
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

    <div id="viewFlow" class="view hidden">
      <div class="section">
        <div class="section-head">
          <span class="section-title">Order flow — live tape, trailing 60s</span>
          <span class="badge" id="flowBadge">READING</span>
        </div>
        <div class="grid">
          <div class="stat"><div class="label">YES flow</div><div class="value up" id="flowYes">—</div></div>
          <div class="stat"><div class="label">NO flow</div><div class="value down" id="flowNo">—</div></div>
          <div class="stat"><div class="label">Net flow</div><div class="value" id="flowNet">—</div></div>
          <div class="stat"><div class="label">Dominance</div><div class="value" id="flowDom">—</div></div>
        </div>
        <div class="bar-row" style="margin-top:2px">
          <div class="labels"><span>NO</span><span>YES</span></div>
          <div class="bar"><div class="fill flow" id="flowDomBar" style="width:50%"></div></div>
        </div>
        <div class="live-note">Which side paid to cross the spread on THIS contract — not a spot BTC buy/sell tape. YES flow is pressure toward the window finishing up, NO flow toward it finishing down.</div>
      </div>
      <div class="section">
        <div class="section-head">
          <span class="section-title">Tape</span>
          <span class="badge blue" id="flowTradesBadge">0 prints</span>
        </div>
        <div class="order-list" id="flowRecent"></div>
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
  var srLines = [], fvgLines = [], patternLines = [];
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
      layout: { background: { color: 'transparent' }, textColor: '#7c8aa0', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(34,211,238,0.05)' }, horzLines: { color: 'rgba(34,211,238,0.05)' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { borderColor: 'rgba(34,211,238,0.15)', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'rgba(34,211,238,0.15)' },
      handleScroll: true, handleScale: true,
    };

    chart = LightweightCharts.createChart(document.getElementById('chartMain'), Object.assign({
      width: document.getElementById('chartMain').clientWidth, height: 260,
    }, common));
    candleSeries = chart.addCandlestickSeries({
      upColor: '#21e6a1', downColor: '#ff4d6d', borderVisible: false,
      wickUpColor: '#21e6a1', wickDownColor: '#ff4d6d',
    });

    // Real Kalshi contract volume, sparse by nature — see buildVolume server
    // side. Squeezed into the bottom 15% of the same pane, the way a proper
    // terminal does it, rather than a whole separate chart for what is often
    // a handful of bars.
    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: 'rgba(34,211,238,0.4)',
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
    }, common, { rightPriceScale: { borderColor: 'rgba(34,211,238,0.15)' } }));
    rsiSeries = rsiChart.addLineSeries({ color: '#22d3ee', lineWidth: 2 });
    rsiSeries.createPriceLine({ price: 70, color: 'rgba(255,77,109,0.5)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '70' });
    rsiSeries.createPriceLine({ price: 30, color: 'rgba(33,230,161,0.5)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '30' });
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

  /** Whether a price sits inside one of the server's already-computed key zones — see keyZones.js. */
  function findZone(zones, price) {
    if (!Number.isFinite(price) || !zones) return null;
    for (var i = 0; i < zones.length; i += 1) {
      if (Math.abs(zones[i].price - price) / price <= 0.0015) return zones[i];
    }
    return null;
  }

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
        price: data.strike, color: '#7c8aa0', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'strike',
      });
    }

    if (spotLine) { candleSeries.removePriceLine(spotLine); spotLine = null; }
    if (Number.isFinite(data.spot)) {
      spotLine = candleSeries.createPriceLine({
        price: data.spot, color: '#22d3ee', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
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
        price: data.expectedRange.high, color: 'rgba(167,139,250,0.55)', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true, title: '~68% hi',
      });
      rangeLoLine = candleSeries.createPriceLine({
        price: data.expectedRange.low, color: 'rgba(167,139,250,0.55)', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true, title: '~68% lo',
      });
    }

    // Auto support/resistance, drawn straight from findSupportResistance --
    // the title carries the same two real numbers the list view shows
    // (touches, quality) instead of a plain unlabeled line.
    srLines.forEach(function (line) { candleSeries.removePriceLine(line); });
    srLines = (data.levels || []).map(function (level) {
      var up = level.type === 'support';
      var zone = findZone(data.keyZones, level.price);
      return candleSeries.createPriceLine({
        price: level.price,
        color: up ? 'rgba(33,230,161,0.65)' : 'rgba(255,77,109,0.65)',
        lineWidth: zone ? 2 : 1,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: (zone ? '★ ' : '') + level.type.toUpperCase() + ' · ' + level.touches + (level.touches === 1 ? ' touch' : ' touches') + ' · ' + level.quality + '/100' + (zone ? ' · KEY ZONE' : ''),
      });
    });

    // Open fair value gaps -- each one drawn as its top and bottom edge, the
    // same two-line technique already used for the ~68% range above. A
    // filled gap is, by definition, no longer in data.fairValueGaps, so it
    // just stops being drawn rather than needing an "invalidated" state. A
    // gap edge sitting on a key zone (see keyZones.js) gets the same star
    // treatment the S/R line above does -- the two are the same real fact,
    // seen from the level's side and from the gap's side.
    fvgLines.forEach(function (line) { candleSeries.removePriceLine(line); });
    fvgLines = [];
    (data.fairValueGaps || []).forEach(function (gap) {
      var color = gap.bias === 'bullish' ? 'rgba(33,230,161,0.4)' : 'rgba(255,77,109,0.4)';
      var label = gap.bias.toUpperCase() + ' FVG';
      var highZone = findZone(data.keyZones, gap.high);
      fvgLines.push(candleSeries.createPriceLine({
        price: gap.high, color: color, lineWidth: highZone ? 2 : 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: (highZone ? '★ ' : '') + label + (highZone ? ' · KEY ZONE' : ''),
      }));
      var lowZone = findZone(data.keyZones, gap.low);
      fvgLines.push(candleSeries.createPriceLine({
        price: gap.low, color: color, lineWidth: lowZone ? 2 : 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: Boolean(lowZone), title: lowZone ? '★ ' + label + ' · KEY ZONE' : '',
      }));
    });

    // The strongest pattern Pattern Sonar actually found, drawn on the chart
    // itself: neckline (the real trigger level) plus, when the detector
    // reports one, the price that proves the read wrong.
    patternLines.forEach(function (line) { candleSeries.removePriceLine(line); });
    patternLines = [];
    var activePattern = data.patterns && Object.keys(data.patterns)
      .map(function (key) { return data.patterns[key]; })
      .find(function (p) { return p && Number.isFinite(p.neckline); });
    if (activePattern) {
      var pColor = activePattern.bias === 'bullish' ? '#21e6a1' : '#ff4d6d';
      patternLines.push(candleSeries.createPriceLine({
        price: activePattern.neckline, color: pColor, lineWidth: 2,
        lineStyle: activePattern.confirmed ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: activePattern.label + ' · ' + (activePattern.confirmed ? 'CONFIRMED' : 'TRIGGER') + ' · ' + activePattern.quality + '/100',
      }));
      if (Number.isFinite(activePattern.invalidate)) {
        var above = activePattern.invalidate > activePattern.neckline;
        patternLines.push(candleSeries.createPriceLine({
          price: activePattern.invalidate, color: 'rgba(255,209,102,0.7)', lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true,
          title: 'INVALIDATE ' + (above ? 'ABOVE' : 'BELOW'),
        }));
      }
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

  var PATTERN_LABELS = {
    doubleTop: 'Double Top',
    doubleBottom: 'Double Bottom',
    headAndShoulders: 'Head & Shoulders',
    inverseHeadAndShoulders: 'Inverse Head & Shoulders',
    cupAndHandle: 'Cup & Handle',
    reverseCupAndHandle: 'Reverse Cup & Handle',
    bearFlag: 'Bear Flag',
  };

  /** The reversal radar line for one pattern type: its own real settled win rate, or an honest "not yet". */
  function radarLine(trackRecord, key) {
    var row = (trackRecord || []).find(function (r) { return r.patternKey === key; });
    if (!row || !row.enough) {
      var settled = row ? row.settled : 0;
      return 'Reversal radar: not enough settled yet (' + settled + '/15)';
    }
    var pct = Math.round(row.winRate * 100);
    return 'Reversal radar: right ' + pct + '% of the time so far (' + row.settled + ' settled)';
  }

  function paintRoundHistory(rh) {
    var badge = document.getElementById('aiBadge');
    var note = document.getElementById('aiNote');
    document.getElementById('aiRecorded').textContent = rh ? rh.recorded : '—';
    document.getElementById('aiSettled').textContent = rh ? rh.settled : '—';
    if (!rh) { badge.textContent = 'NO DATA'; badge.className = 'badge amber'; return; }
    if (rh.enough) {
      badge.textContent = 'READY'; badge.className = 'badge blue';
      note.textContent = rh.settled + ' real settled rounds on file. Enough to start building a similarity search on top of — that matching feature is the next step, not yet live.';
    } else {
      badge.textContent = 'COLLECTING'; badge.className = 'badge amber';
      note.textContent = 'The full read for every round is being saved with its real outcome, starting now (' + rh.settled + '/' + rh.minimumSettled + ' settled). There is no way to back-date this history, so it has to accumulate before any matching feature can say something real instead of a guess.';
    }
  }

  function paintPatterns(patterns, trackRecord) {
    var list = document.getElementById('patternList');
    var badge = document.getElementById('patternBadge');
    if (!patterns) {
      list.innerHTML = '';
      badge.textContent = 'NO DATA'; badge.className = 'badge';
      return;
    }

    var keys = Object.keys(PATTERN_LABELS);
    var found = keys.filter(function (key) { return patterns[key]; });
    badge.textContent = found.length ? found.length + (found.length === 1 ? ' FOUND' : ' FOUND') : 'SCANNING';
    badge.className = 'badge' + (found.length ? ' blue' : '');

    list.innerHTML = keys.map(function (key) {
      var p = patterns[key];
      var label = PATTERN_LABELS[key];
      if (!p) {
        return '<div class="pattern-row">' +
          '<div class="pattern-top"><span class="pattern-label">' + label + '</span><span class="pattern-status">scanning</span></div>' +
        '</div>';
      }
      var cls = p.bias === 'bullish' ? 'up' : 'down';
      var status = (p.confirmed ? 'confirmed · ' : '') + p.quality + '/100';
      var radar = p.confirmed ? '<div class="pattern-radar">' + radarLine(trackRecord, key) + '</div>' : '';
      return '<div class="pattern-row active">' +
        '<div class="pattern-top"><span class="pattern-label">' + label + '</span><span class="pattern-status ' + cls + '">' + status + '</span></div>' +
        '<div class="pattern-note">' + p.note + '</div>' +
        radar +
      '</div>';
    }).join('');
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

  function paintOrderFlow(flow) {
    var money = function (n) {
      return Number.isFinite(n) ? '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    };
    var badge = document.getElementById('flowBadge');
    var tradesBadge = document.getElementById('flowTradesBadge');
    var list = document.getElementById('flowRecent');

    if (!flow) {
      document.getElementById('flowYes').textContent = '—';
      document.getElementById('flowNo').textContent = '—';
      document.getElementById('flowNet').textContent = '—';
      document.getElementById('flowDom').textContent = '—';
      document.getElementById('flowDomBar').style.width = '50%';
      badge.textContent = 'NO TAPE'; badge.className = 'badge';
      tradesBadge.textContent = '0 prints';
      list.innerHTML = '<div class="order-empty">No trade tape available right now.</div>';
      return;
    }

    document.getElementById('flowYes').textContent = money(flow.yesDollars);
    document.getElementById('flowNo').textContent = money(flow.noDollars);
    var netEl = document.getElementById('flowNet');
    netEl.textContent = (flow.netDollars >= 0 ? '+' : '-') + money(flow.netDollars);
    netEl.className = 'value ' + (flow.netDollars > 0 ? 'up' : flow.netDollars < 0 ? 'down' : '');

    var domPct = Number.isFinite(flow.yesDominance) ? Math.round(flow.yesDominance * 100) : null;
    document.getElementById('flowDom').textContent = domPct === null ? '—' : domPct + ' / ' + (100 - domPct);
    document.getElementById('flowDomBar').style.width = (domPct === null ? 50 : domPct) + '%';

    if (flow.trades === 0) {
      badge.textContent = 'QUIET'; badge.className = 'badge';
    } else if (domPct !== null && domPct >= 60) {
      badge.textContent = 'YES LEANING'; badge.className = 'badge up';
    } else if (domPct !== null && domPct <= 40) {
      badge.textContent = 'NO LEANING'; badge.className = 'badge down';
    } else {
      badge.textContent = 'MIXED'; badge.className = 'badge blue';
    }
    tradesBadge.textContent = flow.trades + (flow.trades === 1 ? ' print' : ' prints');

    var rows = flow.recent || [];
    if (!rows.length) {
      list.innerHTML = '<div class="order-empty">No prints on the tape yet.</div>';
      return;
    }
    list.innerHTML = rows.map(function (t) {
      var time = t.at ? new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
      var side = t.side === 'yes' ? 'YES' : 'NO';
      var cls = t.side === 'yes' ? 'up' : 'down';
      var dollars = Number.isFinite(t.priceCents) ? money((t.count * t.priceCents) / 100) : '—';
      return '<div class="order-row">' +
        '<div class="order-left">' +
          '<span>' + time + '</span>' +
          '<span class="order-side ' + cls + '">' + side + '</span>' +
          '<span>' + t.count + 'x @ ' + Math.round(t.priceCents) + '%</span>' +
        '</div>' +
        '<div class="order-right">' + dollars + '</div>' +
      '</div>';
    }).join('');
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
    paintPatterns(data.patterns, data.patternTrackRecord);
    paintRoundHistory(data.roundHistory);
    paintLiveTrading(data.liveTrading);
    paintOrderFlow(data.orderFlow);
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
