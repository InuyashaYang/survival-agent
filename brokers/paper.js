/**
 * brokers/paper.js — 内置纸面交易 Broker（无需任何 API Key）
 * 
 * 默认 Broker，用 OKX public API 获取真实行情，
 * 但所有下单操作只在内存中模拟。
 * 
 * 接口规范（所有 broker 必须实现）：
 *   fetchTicker(symbol) → { symbol, price, bid, ask, volume }
 *   placeOrder({ symbol, side, qty, price }) → { orderId, status }
 *   cancelOrder(orderId) → { ok }
 *   getBalance() → number (USDT/CNY 可用余额)
 *   name → string
 *   TYPE → 'paper' | 'live'
 */

const https = require('https');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = typeof url === 'string' ? new URL(url) : url;
    const req = https.get({ ...opts, headers: { 'User-Agent': 'SurvivalAgent/2', ...headers } }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(b); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

// 内存订单簿
const orders = new Map();
let orderSeq = 1;

const PaperBroker = {
  name: 'Paper (OKX数据)',
  TYPE: 'paper',

  async fetchTicker(symbol) {
    // 使用 OKX public API 获取真实价格
    const d = await get(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}`);
    if (!d?.data?.[0]) throw new Error('no data');
    const t = d.data[0];
    return {
      symbol,
      price: parseFloat(t.last),
      bid: parseFloat(t.bidPx),
      ask: parseFloat(t.askPx),
      volume: parseFloat(t.vol24h),
      source: 'okx-public',
    };
  },

  async placeOrder({ symbol, side, qty, price }) {
    const id = `PAPER-${Date.now()}-${orderSeq++}`;
    const order = { orderId: id, symbol, side, qty, price, status: 'filled', ts: Date.now() };
    orders.set(id, order);
    console.log(`[PAPER] ${side} ${qty} ${symbol} @ ${price} → ${id}`);
    return { orderId: id, status: 'filled', avgPrice: price };
  },

  async cancelOrder(orderId) {
    orders.delete(orderId);
    return { ok: true };
  },

  async getBalance() {
    return null; // paper broker 不管理真实余额，由 agent 内部状态维护
  },
};

module.exports = PaperBroker;
