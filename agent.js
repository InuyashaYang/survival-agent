/**
 * Survival Agent - Virtual Trading Engine
 * Dies if balance hits 0. No external dependencies.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT = 7788;
const INITIAL_BALANCE = 10000;
const TRADE_INTERVAL_MS = 2500;
const LOG_DIR = path.join(__dirname, 'logs');

// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  balance: INITIAL_BALANCE,
  initialBalance: INITIAL_BALANCE,
  trades: [],
  tradeCount: 0,
  alive: true,
  startTime: Date.now(),
  sseClients: []
};

// ─── STRATEGIES ──────────────────────────────────────────────────────────────
const STRATEGIES = [
  {
    name: '拼多多比价套利',
    icon: '🛒',
    execute() {
      const spread = rnd(0.5, 8);
      const amount = rnd(200, 800);
      const profit = rnd(-spread, spread * 2.5) * (amount / 100);
      return { amount, profit, detail: `发现价差 ¥${spread.toFixed(2)}，买入 ¥${amount.toFixed(0)}` };
    }
  },
  {
    name: '优惠券批发分发',
    icon: '🎫',
    execute() {
      const coupons = Math.floor(rnd(10, 80));
      const profit = coupons * rnd(0.3, 2.1);
      return { amount: coupons * 5, profit, detail: `分发 ${coupons} 张券，佣金 ¥${profit.toFixed(2)}` };
    }
  },
  {
    name: '信息差报告售卖',
    icon: '📊',
    execute() {
      const price = rnd(9.9, 99);
      const sold = Math.floor(rnd(0, 5));
      const profit = sold * price * 0.7;
      return { amount: price, profit, detail: `报告售出 ${sold} 份，净收 ¥${profit.toFixed(2)}` };
    }
  },
  {
    name: '闲鱼商品翻转',
    icon: '♻️',
    execute() {
      const cost = rnd(50, 500);
      const margin = rnd(-0.15, 0.35);
      const profit = cost * margin;
      return { amount: cost, profit, detail: `收购 ¥${cost.toFixed(0)} → 溢价 ${(margin*100).toFixed(1)}%` };
    }
  },
  {
    name: 'API 服务调用费',
    icon: '⚡',
    execute() {
      const calls = Math.floor(rnd(50, 500));
      const profit = calls * rnd(0.01, 0.08);
      return { amount: calls, profit, detail: `处理 ${calls} 次请求，收入 ¥${profit.toFixed(2)}` };
    }
  }
];

// ─── UTILS ───────────────────────────────────────────────────────────────────
function rnd(min, max) {
  return Math.random() * (max - min) + min;
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function logId() {
  return `trade_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

// ─── TRADING ENGINE ──────────────────────────────────────────────────────────
function executeTrade() {
  if (!state.alive) return;

  const strategy = STRATEGIES[Math.floor(Math.random() * STRATEGIES.length)];
  const result = strategy.execute();
  const id = logId();
  const timestamp = ts();
  const prevBalance = state.balance;

  // Apply trade cost (API/compute cost per trade)
  const computeCost = rnd(0.5, 3.0);
  const netProfit = result.profit - computeCost;

  state.balance += netProfit;
  state.tradeCount++;

  const trade = {
    id,
    timestamp,
    strategy: strategy.name,
    icon: strategy.icon,
    amount: result.amount,
    grossProfit: result.profit,
    computeCost,
    netProfit,
    balance: state.balance,
    prevBalance,
    detail: result.detail,
    status: netProfit > 0 ? 'profit' : 'loss',
    logFile: `${id}.json`
  };

  state.trades.unshift(trade);
  if (state.trades.length > 200) state.trades.pop();

  // Write individual log file
  const logPath = path.join(LOG_DIR, `${id}.json`);
  fs.writeFileSync(logPath, JSON.stringify(trade, null, 2));

  // Append to daily log
  const dailyLog = path.join(LOG_DIR, `${new Date().toISOString().slice(0,10)}.log`);
  fs.appendFileSync(dailyLog,
    `[${timestamp}] ${strategy.icon} ${strategy.name} | 净利润: ${netProfit >= 0 ? '+' : ''}¥${netProfit.toFixed(2)} | 余额: ¥${state.balance.toFixed(2)}\n`
  );

  // Check survival
  if (state.balance <= 0) {
    state.alive = false;
    state.balance = 0;
    broadcast({ type: 'death', trade });
    broadcast({ type: 'trade', trade });
    console.log('💀 Agent died at', timestamp);
    return;
  }

  broadcast({ type: 'trade', trade });
  console.log(`${strategy.icon} [${timestamp}] ${strategy.name} | ${netProfit >= 0 ? '📈' : '📉'} ¥${netProfit.toFixed(2)} | 余额 ¥${state.balance.toFixed(2)}`);
}

// ─── SSE BROADCAST ───────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  state.sseClients.forEach(res => {
    try { res.write(msg); } catch(e) {}
  });
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  // SSE stream
  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'init', state: getSummary() })}\n\n`);
    state.sseClients.push(res);
    req.on('close', () => {
      state.sseClients = state.sseClients.filter(c => c !== res);
    });
    return;
  }

  // API: get state
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSummary()));
    return;
  }

  // API: get log file
  if (url.pathname.startsWith('/api/log/')) {
    const logFile = url.pathname.replace('/api/log/', '');
    const logPath = path.join(LOG_DIR, logFile);
    if (fs.existsSync(logPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(logPath, 'utf8'));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Serve dashboard
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlPath, 'utf8'));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function getSummary() {
  const runtime = Math.floor((Date.now() - state.startTime) / 1000);
  const profits = state.trades.map(t => t.netProfit);
  const wins = profits.filter(p => p > 0).length;
  return {
    balance: state.balance,
    initialBalance: state.initialBalance,
    pnl: state.balance - state.initialBalance,
    pnlPct: ((state.balance - state.initialBalance) / state.initialBalance * 100).toFixed(2),
    tradeCount: state.tradeCount,
    winRate: state.tradeCount > 0 ? (wins / state.tradeCount * 100).toFixed(1) : '0.0',
    alive: state.alive,
    runtime,
    trades: state.trades.slice(0, 50)
  };
}

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Survival Agent started`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`⚡ Stream:    http://localhost:${PORT}/stream`);
  console.log(`💰 Starting balance: ¥${INITIAL_BALANCE}`);
  console.log(`⏱️  Trade interval: ${TRADE_INTERVAL_MS}ms\n`);
});

// Start trading loop
setInterval(executeTrade, TRADE_INTERVAL_MS);

// Heartbeat ping
setInterval(() => {
  broadcast({ type: 'ping', time: ts(), balance: state.balance, alive: state.alive });
}, 5000);
