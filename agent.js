/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   SURVIVAL AGENT v2 - Real Strategy Engine          ║
 * ║   Data: OKX (crypto) + Sina Finance (A股)           ║
 * ║   Mode: DRY_RUN=true (paper) | false (real)         ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * DEBUG LEVELS (set via env DEBUG_LEVEL=0-4):
 *   0 = SILENT   - trades only
 *   1 = INFO     - key decisions
 *   2 = VERBOSE  - signal details
 *   3 = DATA     - raw market data
 *   4 = TRACE    - every calculation step
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── STRATEGIES ───────────────────────────────────────────────────────────────
const GithubBounty   = require('./strategies/github-bounty.js');
// const SecondhandDeals = require('./strategies/secondhand-deals.js'); // WIP

// ─── BROKER LOADING ───────────────────────────────────────────────────────────
// 通过 BROKER 环境变量选择交易接口:
//   BROKER=paper        — 纸面交易，OKX 公开行情（默认）
//   BROKER=okx          — OKX 现货实盘（需 OKX_API_KEY + OKX_SECRET_KEY + OKX_PASSPHRASE）
//   BROKER=okx-demo     — OKX 模拟盘（需 API Key + OKX_DEMO=true）
//   BROKER=gateio       — Gate.io 现货（需 GATEIO_API_KEY + GATEIO_SECRET）
//   BROKER=htx          — HTX 火币现货（需 HTX_API_KEY + HTX_SECRET + HTX_ACCOUNT_ID）
//   BROKER=hyperliquid  — Hyperliquid 永续（需 HL_PRIVATE_KEY + HL_WALLET + ethers.js）
const BROKER_NAME = process.env.BROKER || 'paper';
let broker;
try {
  const brokerFile = BROKER_NAME === 'okx-demo'
    ? './brokers/okx.js'
    : `./brokers/${BROKER_NAME}.js`;
  if (BROKER_NAME === 'okx-demo') process.env.OKX_DEMO = 'true';
  broker = require(brokerFile);
  console.log(`✅ Broker loaded: ${broker.name} [${broker.TYPE}]`);
} catch(e) {
  console.warn(`⚠️  Broker "${BROKER_NAME}" not found or failed to load: ${e.message}`);
  console.warn('   Falling back to paper broker');
  broker = require('./brokers/paper.js');
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: 7788,
  DRY_RUN: process.env.DRY_RUN !== 'false',   // default: paper trade
  DEBUG_LEVEL: parseInt(process.env.DEBUG_LEVEL ?? '2'),
  INITIAL_BALANCE: parseFloat(process.env.BALANCE ?? '10000'),
  SCAN_INTERVAL_MS: 8000,    // fetch + evaluate every 8s
  LOG_DIR: path.join(__dirname, 'logs'),

  // Strategy params
  MOMENTUM_PERIODS: 3,       // compare price to N readings ago
  MOMENTUM_THRESHOLD: 0.004, // 0.4% move = signal
  POSITION_SIZE_PCT: 0.05,   // risk 5% per trade
  STOP_LOSS_PCT: 0.02,       // 2% stop loss
  TAKE_PROFIT_PCT: 0.04,     // 4% take profit
  MAX_OPEN_POSITIONS: 3,
};

// ─── DEBUG LOGGER ─────────────────────────────────────────────────────────────
const LOG_COLORS = {
  TRACE: '\x1b[90m',   // gray
  DATA:  '\x1b[36m',   // cyan
  VERBOSE: '\x1b[34m', // blue
  INFO:  '\x1b[33m',   // yellow
  TRADE: '\x1b[32m',   // green
  ERROR: '\x1b[31m',   // red
  DEATH: '\x1b[35m',   // magenta
  RESET: '\x1b[0m',
};

function debug(level, tag, msg, data = null) {
  const levels = { TRACE: 4, DATA: 3, VERBOSE: 2, INFO: 1, TRADE: 0, ERROR: 0, DEATH: 0 };
  if (levels[level] > CONFIG.DEBUG_LEVEL) return;

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const color = LOG_COLORS[level] || '';
  const reset = LOG_COLORS.RESET;
  const prefix = `${color}[${ts}] [${level.padEnd(7)}] [${tag}]${reset}`;

  console.log(`${prefix} ${msg}`);
  if (data && CONFIG.DEBUG_LEVEL >= 3) {
    console.log(`${LOG_COLORS.DATA}           ↳ ${JSON.stringify(data, null, 2).replace(/\n/g, '\n             ')}${reset}`);
  }

  // Write to debug log file
  const logLine = `[${ts}] [${level}] [${tag}] ${msg}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
  fs.appendFileSync(path.join(CONFIG.LOG_DIR, 'debug.log'), logLine);
}

// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  balance: CONFIG.INITIAL_BALANCE,
  initialBalance: CONFIG.INITIAL_BALANCE,
  positions: {},       // { symbol: { qty, entryPrice, entryTime, side } }
  trades: [],
  tradeCount: 0,
  winCount: 0,
  alive: true,
  startTime: Date.now(),
  sseClients: [],
  priceHistory: {},    // { symbol: [{ price, ts }] }
  lastScan: null,
  scanCount: 0,
  lastSignals: {},     // { symbol: signal details }
  // GitHub Bounty Strategy
  bounties: [],        // 当前可接的悬赏列表
  bountyTrades: [],    // 已结算的悬赏
  bountyInProgress: [],// 正在"提交中"的
  // Secondhand Deals: disabled (WIP)
  deals: [],
  dealTrades: [],
  dealHolding: [],
};

// ─── MARKET DATA ──────────────────────────────────────────────────────────────
const WATCHLIST = [
  // Crypto via OKX (24/7, real-time)
  { symbol: 'BTC-USDT',  name: 'Bitcoin',    type: 'crypto', source: 'okx' },
  { symbol: 'ETH-USDT',  name: 'Ethereum',   type: 'crypto', source: 'okx' },
  { symbol: 'SOL-USDT',  name: 'Solana',     type: 'crypto', source: 'okx' },

  // A股 via Sina Finance (交易时段 09:30-15:00)
  { symbol: 'sh000001',  name: '上证指数',    type: 'astock', source: 'sina' },
  { symbol: 'sh600519',  name: '贵州茅台',    type: 'astock', source: 'sina' },
  { symbol: 'sz300750',  name: '宁德时代',    type: 'astock', source: 'sina' },
];

function fetchOKX(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}`;
    debug('TRACE', 'FETCH', `GET ${url}`);

    https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.data && j.data[0]) {
            const d = j.data[0];
            resolve({
              symbol,
              price: parseFloat(d.last),
              bid: parseFloat(d.bidPx),
              ask: parseFloat(d.askPx),
              volume24h: parseFloat(d.vol24h),
              change24h: parseFloat(d.sodUtc8) > 0
                ? ((parseFloat(d.last) - parseFloat(d.sodUtc8)) / parseFloat(d.sodUtc8) * 100)
                : 0,
              ts: Date.now(),
              source: 'okx',
            });
          } else {
            reject(new Error('No data: ' + body.slice(0, 100)));
          }
        } catch(e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function fetchSina(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://hq.sinajs.cn/list=${symbol}`;
    debug('TRACE', 'FETCH', `GET ${url}`);

    const options = {
      hostname: 'hq.sinajs.cn',
      path: `/list=${symbol}`,
      headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000,
    };

    https.get(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const match = body.match(/"([^"]+)"/);
          if (!match) return reject(new Error('parse fail'));

          const parts = match[1].split(',');
          // Parts: [name, open, prevClose, current, high, low, ...]
          if (parts.length < 6 || !parts[3]) return reject(new Error('empty quote'));

          const price = parseFloat(parts[3]);
          const prevClose = parseFloat(parts[2]);
          if (!price) return reject(new Error('zero price - market closed?'));

          resolve({
            symbol,
            price,
            open: parseFloat(parts[1]),
            prevClose,
            high: parseFloat(parts[4]),
            low: parseFloat(parts[5]),
            volume: parseFloat(parts[8]),
            change24h: ((price - prevClose) / prevClose * 100),
            marketTime: `${parts[30]} ${parts[31]}`,
            ts: Date.now(),
            source: 'sina',
          });
        } catch(e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

async function fetchAll() {
  // ── BREAKPOINT 1: DATA FETCH ──────────────────────────────────────────────
  debug('VERBOSE', 'FETCH', `Starting market data fetch for ${WATCHLIST.length} symbols`);

  const results = await Promise.allSettled(
    WATCHLIST.map(w => w.source === 'okx' ? fetchOKX(w.symbol) : fetchSina(w.symbol))
  );

  const quotes = {};
  results.forEach((r, i) => {
    const w = WATCHLIST[i];
    if (r.status === 'fulfilled') {
      quotes[w.symbol] = { ...r.value, name: w.name, type: w.type };
      debug('DATA', 'QUOTE', `${w.name} (${w.symbol}): ¥${r.value.price} | 24h: ${r.value.change24h?.toFixed(2)}%`, r.value);
    } else {
      debug('ERROR', 'FETCH', `${w.symbol} failed: ${r.reason?.message}`);
    }
  });

  return quotes;
}

// ─── STRATEGY ENGINE ──────────────────────────────────────────────────────────
function updatePriceHistory(quotes) {
  for (const [sym, q] of Object.entries(quotes)) {
    if (!state.priceHistory[sym]) state.priceHistory[sym] = [];
    state.priceHistory[sym].push({ price: q.price, ts: q.ts });
    // Keep last 20 readings
    if (state.priceHistory[sym].length > 20) state.priceHistory[sym].shift();
  }
}

function calcMomentum(sym) {
  const hist = state.priceHistory[sym];
  if (!hist || hist.length < CONFIG.MOMENTUM_PERIODS + 1) {
    debug('TRACE', 'SIGNAL', `${sym}: insufficient history (${hist?.length ?? 0} readings, need ${CONFIG.MOMENTUM_PERIODS + 1})`);
    return null;
  }

  const current = hist[hist.length - 1].price;
  const nPeriodsAgo = hist[hist.length - 1 - CONFIG.MOMENTUM_PERIODS].price;
  const momentum = (current - nPeriodsAgo) / nPeriodsAgo;

  // ── BREAKPOINT 2: MOMENTUM CALCULATION ───────────────────────────────────
  debug('TRACE', 'SIGNAL', `${sym} momentum: current=${current} vs ${CONFIG.MOMENTUM_PERIODS} periods ago=${nPeriodsAgo} → ${(momentum*100).toFixed(3)}%`);

  return { momentum, current, nPeriodsAgo };
}

function calcMovingAverage(sym, periods) {
  const hist = state.priceHistory[sym];
  if (!hist || hist.length < periods) return null;
  const slice = hist.slice(-periods);
  return slice.reduce((s, p) => s + p.price, 0) / periods;
}

function generateSignal(sym, quote) {
  // ── BREAKPOINT 3: SIGNAL GENERATION ──────────────────────────────────────
  debug('VERBOSE', 'SIGNAL', `Evaluating ${sym} (${quote.name})`);

  const mom = calcMomentum(sym);
  if (!mom) return { signal: 'WAIT', reason: 'building history' };

  const ma5 = calcMovingAverage(sym, 5);
  const ma10 = calcMovingAverage(sym, Math.min(10, state.priceHistory[sym].length));

  debug('VERBOSE', 'SIGNAL', `${sym} | momentum=${(mom.momentum*100).toFixed(3)}% | MA5=${ma5?.toFixed(2)} | MA10=${ma10?.toFixed(2)} | threshold=±${(CONFIG.MOMENTUM_THRESHOLD*100).toFixed(1)}%`);

  // Rule 1: Strong momentum + price above MA
  if (mom.momentum > CONFIG.MOMENTUM_THRESHOLD && ma5 && ma5 > (ma10 || ma5)) {
    return {
      signal: 'BUY',
      strength: Math.min(mom.momentum / CONFIG.MOMENTUM_THRESHOLD, 3).toFixed(2),
      reason: `momentum +${(mom.momentum*100).toFixed(2)}% > threshold, price above MA5`,
      momentum: mom.momentum,
      ma5, ma10,
    };
  }

  // Rule 2: Strong negative momentum
  if (mom.momentum < -CONFIG.MOMENTUM_THRESHOLD && ma5 && ma5 < (ma10 || ma5)) {
    return {
      signal: 'SELL',
      strength: Math.min(Math.abs(mom.momentum) / CONFIG.MOMENTUM_THRESHOLD, 3).toFixed(2),
      reason: `momentum ${(mom.momentum*100).toFixed(2)}% < -threshold, price below MA5`,
      momentum: mom.momentum,
      ma5, ma10,
    };
  }

  return {
    signal: 'HOLD',
    reason: `momentum ${(mom.momentum*100).toFixed(3)}% within threshold`,
    momentum: mom.momentum,
    ma5, ma10,
  };
}

// ─── EXECUTION ENGINE ─────────────────────────────────────────────────────────
function calcPositionSize(price) {
  const riskAmount = state.balance * CONFIG.POSITION_SIZE_PCT;
  const stopLossDistance = price * CONFIG.STOP_LOSS_PCT;
  const qty = riskAmount / stopLossDistance;
  // ── BREAKPOINT 4: POSITION SIZING ────────────────────────────────────────
  debug('VERBOSE', 'EXEC', `Position size: risk ¥${riskAmount.toFixed(2)} / SL distance ¥${stopLossDistance.toFixed(4)} = qty ${qty.toFixed(6)}`);
  return qty;
}

async function openPosition(sym, signal, quote) {
  if (Object.keys(state.positions).length >= CONFIG.MAX_OPEN_POSITIONS) {
    debug('INFO', 'EXEC', `${sym}: MAX_OPEN_POSITIONS reached (${CONFIG.MAX_OPEN_POSITIONS}), skip`);
    return null;
  }
  if (state.positions[sym]) {
    debug('INFO', 'EXEC', `${sym}: already have position, skip`);
    return null;
  }

  const price = signal.signal === 'BUY' ? quote.ask || quote.price : quote.bid || quote.price;
  const qty = calcPositionSize(price);
  const cost = price * qty;

  if (cost > state.balance * 0.5) {
    debug('INFO', 'EXEC', `${sym}: cost ¥${cost.toFixed(2)} > 50% balance, reduce qty`);
    return null;
  }

  // ── BREAKPOINT 5: ORDER PLACEMENT ────────────────────────────────────────
  const order = {
    id: `ord_${Date.now()}`,
    sym,
    name: quote.name,
    side: signal.signal,
    qty,
    price,
    cost,
    stopLoss: signal.signal === 'BUY' ? price * (1 - CONFIG.STOP_LOSS_PCT) : price * (1 + CONFIG.STOP_LOSS_PCT),
    takeProfit: signal.signal === 'BUY' ? price * (1 + CONFIG.TAKE_PROFIT_PCT) : price * (1 - CONFIG.TAKE_PROFIT_PCT),
    openTime: Date.now(),
    signal: signal.reason,
    strength: signal.strength,
  };

  if (CONFIG.DRY_RUN) {
    debug('TRADE', 'PAPER', `[DRY RUN] OPEN ${signal.signal} ${sym} | qty=${qty.toFixed(6)} @ ¥${price.toFixed(2)} | cost=¥${cost.toFixed(2)} | SL=¥${order.stopLoss.toFixed(2)} | TP=¥${order.takeProfit.toFixed(2)}`);
  } else {
    debug('TRADE', broker.TYPE === 'live' ? 'REAL' : 'PAPER', `[${broker.name}] OPEN ${signal.signal} ${sym} | qty=${qty.toFixed(6)} @ ¥${price.toFixed(2)}`);
    try {
      // ── REAL EXECUTION via pluggable broker ──────────────────────────────
      const result = await broker.placeOrder({ symbol: sym, side: signal.signal, qty, price });
      order.brokerOrderId = result.orderId;
      order.brokerStatus  = result.status;
      debug('TRADE', 'REAL', `Order placed: id=${result.orderId} status=${result.status}`);
    } catch(e) {
      debug('ERROR', 'EXEC', `Broker placeOrder failed: ${e.message} — position NOT opened`);
      return null;  // abort if real order fails
    }
  }

  state.positions[sym] = order;
  state.balance -= cost;
  return order;
}

async function checkExits(quotes) {
  // ── BREAKPOINT 6: EXIT CHECK ──────────────────────────────────────────────
  debug('TRACE', 'EXEC', `Checking exits for ${Object.keys(state.positions).length} open positions`);

  for (const [sym, pos] of Object.entries(state.positions)) {
    const quote = quotes[sym];
    if (!quote) { debug('ERROR', 'EXEC', `${sym}: no quote for exit check`); continue; }

    const currentPrice = quote.price;
    const holdingMinutes = ((Date.now() - pos.openTime) / 60000).toFixed(1);
    let exitReason = null;

    if (pos.side === 'BUY') {
      if (currentPrice <= pos.stopLoss) exitReason = `STOP_LOSS hit (${currentPrice.toFixed(4)} ≤ ${pos.stopLoss.toFixed(4)})`;
      else if (currentPrice >= pos.takeProfit) exitReason = `TAKE_PROFIT hit (${currentPrice.toFixed(4)} ≥ ${pos.takeProfit.toFixed(4)})`;
    } else {
      if (currentPrice >= pos.stopLoss) exitReason = `STOP_LOSS hit (${currentPrice.toFixed(4)} ≥ ${pos.stopLoss.toFixed(4)})`;
      else if (currentPrice <= pos.takeProfit) exitReason = `TAKE_PROFIT hit (${currentPrice.toFixed(4)} ≤ ${pos.takeProfit.toFixed(4)})`;
    }

    // Time-based exit: close after 30 min if no trigger
    if (!exitReason && holdingMinutes >= 30) {
      exitReason = `TIME_EXIT (held ${holdingMinutes}min)`;
    }

    debug('TRACE', 'EXEC', `${sym}: price=${currentPrice.toFixed(4)} | SL=${pos.stopLoss.toFixed(4)} | TP=${pos.takeProfit.toFixed(4)} | held=${holdingMinutes}min | ${exitReason || 'holding'}`);

    if (exitReason) await closePosition(sym, currentPrice, exitReason, quote);
  }
}

async function closePosition(sym, exitPrice, reason, quote) {
  const pos = state.positions[sym];
  if (!pos) return;

  const proceeds = exitPrice * pos.qty;
  const pnl = pos.side === 'BUY' ? proceeds - pos.cost : pos.cost - proceeds;
  const pnlPct = (pnl / pos.cost * 100).toFixed(2);

  if (CONFIG.DRY_RUN) {
    debug('TRADE', CONFIG.DRY_RUN ? 'PAPER' : 'REAL',
      `CLOSE ${pos.side} ${sym} | entry=¥${pos.price.toFixed(4)} exit=¥${exitPrice.toFixed(4)} | PnL=${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)} (${pnlPct}%) | reason: ${reason}`
    );
  } else {
    debug('TRADE', 'REAL', `[${broker.name}] CLOSE ${pos.side} ${sym} @ ¥${exitPrice.toFixed(4)} | reason: ${reason}`);
    try {
      // ── REAL CLOSE: place reverse order ───────────────────────────────────
      const closeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const result = await broker.placeOrder({ symbol: sym, side: closeSide, qty: pos.qty, price: exitPrice });
      debug('TRADE', 'REAL', `Close order placed: id=${result.orderId} status=${result.status}`);
    } catch(e) {
      debug('ERROR', 'EXEC', `Broker close order failed: ${e.message} — forcing paper close`);
      // 真实平仓失败时仍更新内部状态，但记录错误
    }
  }

  state.balance += proceeds;
  if (pnl > 0) state.winCount++;

  const trade = {
    id: pos.id,
    sym,
    name: pos.name,
    side: pos.side,
    entryPrice: pos.price,
    exitPrice,
    qty: pos.qty,
    cost: pos.cost,
    proceeds,
    pnl,
    pnlPct,
    reason,
    signal: pos.signal,
    strength: pos.strength,
    holdingMinutes: ((Date.now() - pos.openTime) / 60000).toFixed(1),
    openTime: new Date(pos.openTime).toISOString(),
    closeTime: new Date().toISOString(),
    balance: state.balance,
    dryRun: CONFIG.DRY_RUN,
  };

  state.trades.unshift(trade);
  if (state.trades.length > 500) state.trades.pop();
  state.tradeCount++;

  // Write log
  const logFile = `${pos.id}.json`;
  fs.writeFileSync(path.join(CONFIG.LOG_DIR, logFile), JSON.stringify(trade, null, 2));
  fs.appendFileSync(path.join(CONFIG.LOG_DIR, `${new Date().toISOString().slice(0,10)}.log`),
    `[${trade.closeTime}] ${pos.side} ${sym} | PnL: ${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)} (${pnlPct}%) | ${reason}\n`
  );

  delete state.positions[sym];

  broadcast({ type: 'trade', trade, balance: state.balance });

  if (state.balance <= 0) {
    state.alive = false;
    debug('DEATH', 'AGENT', '💀 Balance hit zero. Agent terminated.');
    broadcast({ type: 'death' });
  }
}

// ─── MAIN SCAN LOOP ──────────────────────────────────────────────────────────
async function scan() {
  if (!state.alive) return;
  state.scanCount++;

  // ── BREAKPOINT 0: SCAN START ──────────────────────────────────────────────
  debug('INFO', 'SCAN', `=== Scan #${state.scanCount} | balance=¥${state.balance.toFixed(2)} | positions=${Object.keys(state.positions).length}/${CONFIG.MAX_OPEN_POSITIONS} | mode=${CONFIG.DRY_RUN ? 'PAPER' : 'LIVE'} ===`);

  let quotes;
  try {
    quotes = await fetchAll();
    state.lastScan = Date.now();
  } catch(e) {
    debug('ERROR', 'SCAN', `fetchAll failed: ${e.message}`);
    return;
  }

  updatePriceHistory(quotes);
  await checkExits(quotes);

  // Evaluate signals for each symbol
  for (const [sym, quote] of Object.entries(quotes)) {
    const signal = generateSignal(sym, quote);
    state.lastSignals[sym] = { ...signal, price: quote.price, ts: Date.now(), name: quote.name };

    debug('INFO', 'SIGNAL', `${quote.name}: ${signal.signal.padEnd(5)} | ${signal.reason}`);

    if (signal.signal === 'BUY' || signal.signal === 'SELL') {
      await openPosition(sym, signal, quote);
    }
  }

  // ── 策略2: GitHub Bounty ─────────────────────────────────────────────────
  // 每 5 次扫描刷新一次悬赏列表（GitHub API rate limit 友好）
  if (state.scanCount % 5 === 1) {
    GithubBounty.scan().then(bounties => {
      state.bounties = bounties;
      debug('INFO', 'BOUNTY', `Found ${bounties.length} opportunities, top: ${bounties[0]?.title?.slice(0,40) || 'none'}`);
      broadcast({ type: 'bounties', bounties: state.bounties });

      // 自动接单：选预期价值最高的还没接的
      for (const opp of bounties.slice(0, 2)) {
        const claim = GithubBounty.claimBounty(opp, (result) => {
          const pnl = result.pnl;
          state.balance += pnl > 0 ? pnl : 0;
          state.tradeCount++;
          if (pnl > 0) state.winCount++;
          const trade = {
            strategy: 'github-bounty',
            id: result.id,
            title: result.title,
            repo: result.repo,
            url: result.url,
            reward: result.reward,
            pnl,
            won: result.won,
            ts: new Date().toISOString(),
            balance: state.balance,
          };
          state.bountyTrades.unshift(trade);
          if (state.bountyTrades.length > 50) state.bountyTrades.pop();
          state.trades.unshift({ ...trade, name: `[Bounty] ${result.title.slice(0,30)}`, pnlPct: (pnl / result.reward * 100).toFixed(0) });
          debug('TRADE', result.won ? 'PAPER' : 'ERROR', `Bounty ${result.won ? 'WON' : 'LOST'}: ${result.title.slice(0,40)} | PnL: ${pnl > 0 ? '+' : ''}¥${pnl.toFixed(2)}`);
          broadcast({ type: 'bountyTrade', trade, balance: state.balance });
          if (state.balance <= 0) { state.alive = false; broadcast({ type: 'death' }); }
        });
        if (claim) {
          debug('INFO', 'BOUNTY', `Claimed: ${opp.title.slice(0,40)} | reward=$${opp.reward} successRate=${(opp.successRate*100).toFixed(0)}%`);
        }
      }
    }).catch(e => debug('ERROR', 'BOUNTY', `scan failed: ${e.message}`));
  }
  state.bountyInProgress = GithubBounty.getPending();

  // 策略3 (SecondhandDeals) — WIP，暂未启用

  broadcast({ type: 'scan', signals: state.lastSignals, positions: state.positions, balance: state.balance,
    bounties: state.bounties });
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'init', state: getSummary() })}\n\n`);
    state.sseClients.push(res);
    req.on('close', () => { state.sseClients = state.sseClients.filter(c => c !== res); });
    return;
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getSummary()));
  }

  if (url.pathname.startsWith('/api/log/')) {
    const f = path.join(CONFIG.LOG_DIR, url.pathname.replace('/api/log/', ''));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); return res.end('not found');
  }

  if (url.pathname === '/api/debug') {
    const f = path.join(CONFIG.LOG_DIR, 'debug.log');
    const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(-100).join('\n') : 'no log yet';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(lines);
  }

  if (url.pathname === '/api/signals') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state.lastSignals));
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }

  res.writeHead(404); res.end();
});

function getSummary() {
  return {
    balance: state.balance,
    initialBalance: state.initialBalance,
    pnl: state.balance - state.initialBalance,
    pnlPct: ((state.balance - state.initialBalance) / state.initialBalance * 100).toFixed(2),
    tradeCount: state.tradeCount,
    winRate: state.tradeCount > 0 ? (state.winCount / state.tradeCount * 100).toFixed(1) : '0.0',
    alive: state.alive,
    runtime: Math.floor((Date.now() - state.startTime) / 1000),
    positions: state.positions,
    trades: state.trades.slice(0, 50),
    signals: state.lastSignals,
    scanCount: state.scanCount,
    config: { DRY_RUN: CONFIG.DRY_RUN, DEBUG_LEVEL: CONFIG.DEBUG_LEVEL, BROKER: broker.name, BROKER_TYPE: broker.TYPE },
    // Strategy 2: GitHub Bounty
    bounties: state.bounties.slice(0, 8),
    bountyInProgress: state.bountyInProgress,
    bountyTrades: state.bountyTrades.slice(0, 20),
    // Strategy 3: Secondhand Deals
    deals: state.deals.slice(0, 8),
    dealHolding: state.dealHolding,
    dealTrades: state.dealTrades.slice(0, 20),
  };
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  state.sseClients.forEach(r => { try { r.write(msg); } catch(e) {} });
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, async () => {
  debug('INFO', 'START', `╔══════════════════════════════════════╗`);
  debug('INFO', 'START', `║  Survival Agent v2 ONLINE            ║`);
  debug('INFO', 'START', `║  Dashboard: http://localhost:${CONFIG.PORT}   ║`);
  debug('INFO', 'START', `╚══════════════════════════════════════╝`);
  debug('INFO', 'START', `Mode:        ${CONFIG.DRY_RUN ? '📄 PAPER TRADE (DRY_RUN=true)' : '🔴 LIVE TRADE (DRY_RUN=false)'}`);
  debug('INFO', 'START', `Broker:      ${broker.name} [${broker.TYPE}]  (BROKER=${BROKER_NAME})`);
  debug('INFO', 'START', `Debug level: ${CONFIG.DEBUG_LEVEL} (0=silent → 4=trace)`);
  debug('INFO', 'START', `Balance:     ¥${CONFIG.INITIAL_BALANCE}`);
  debug('INFO', 'START', `Scan every:  ${CONFIG.SCAN_INTERVAL_MS}ms`);
  debug('INFO', 'START', `Watchlist:   ${WATCHLIST.map(w => w.name).join(', ')}`);

  // Initial scan
  await scan();
  setInterval(scan, CONFIG.SCAN_INTERVAL_MS);
  setInterval(() => broadcast({ type: 'ping', balance: state.balance, ts: Date.now() }), 5000);
});
