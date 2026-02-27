/**
 * brokers/mexc.js — MEXC 现货交易 Broker（真实执行）
 *
 * 所需环境变量：
 *   MEXC_API_KEY   — API Key
 *   MEXC_SECRET    — Secret Key
 *
 * 申请方式：https://www.mexc.com → 账户 → API 管理
 * 文档：https://mexcdevelop.github.io/apidocs/spot_v3_en/
 *
 * 签名算法：
 *   HMAC-SHA256(queryString + body, secret)，timestamp 放 query 参数
 */

const https = require('https');
const crypto = require('crypto');

const KEY    = process.env.MEXC_API_KEY;
const SECRET = process.env.MEXC_SECRET;
const HOST   = 'api.mexc.com';

function sign(params) {
  const qs = new URLSearchParams(params).toString();
  return crypto.createHmac('sha256', SECRET).update(qs).digest('hex');
}

function request(method, path, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const ts = Date.now().toString();
    const allParams = { ...params, timestamp: ts };
    allParams.signature = sign(allParams);
    const query = new URLSearchParams(allParams).toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const fullPath = path + (method === 'GET' ? '?' + query : '?' + query);
    const opts = {
      hostname: HOST, path: fullPath, method,
      headers: {
        'Content-Type': 'application/json',
        'X-MEXC-APIKEY': KEY,
      },
      timeout: 8000,
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.code && j.code !== 200 && j.code !== 0) reject(new Error(`MEXC ${j.code}: ${j.msg}`));
          else resolve(j);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function checkKeys() {
  if (!KEY || !SECRET) throw new Error('MEXC Broker: 请设置 MEXC_API_KEY / MEXC_SECRET 环境变量');
}

// MEXC 品种格式: BTCUSDT（大写，无分隔符）
function toMEXC(symbol) {
  return symbol.replace('-', '').toUpperCase();
}

const MEXCBroker = {
  name: 'MEXC 现货',
  TYPE: 'live',

  async fetchTicker(symbol) {
    const s = toMEXC(symbol);
    const data = await new Promise((resolve, reject) => {
      https.get(`https://${HOST}/api/v3/ticker/24hr?symbol=${s}`, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    return {
      symbol,
      price: parseFloat(data.lastPrice),
      bid: parseFloat(data.bidPrice),
      ask: parseFloat(data.askPrice),
      volume: parseFloat(data.volume),
      source: 'mexc',
    };
  },

  async placeOrder({ symbol, side, qty, price }) {
    checkKeys();
    const params = {
      symbol: toMEXC(symbol),
      side: side.toUpperCase(),    // BUY / SELL
      type: 'LIMIT',
      quantity: qty.toFixed(6),
      price: price.toFixed(4),
      timeInForce: 'GTC',
    };
    console.log(`[MEXC] ${side} ${qty} ${symbol} @ ${price}`);
    const data = await request('POST', '/api/v3/order', params);
    return { orderId: data.orderId, status: data.status };
  },

  async cancelOrder(orderId, symbol) {
    checkKeys();
    await request('DELETE', '/api/v3/order', { symbol: toMEXC(symbol), orderId });
    return { ok: true };
  },

  async getBalance() {
    checkKeys();
    const data = await request('GET', '/api/v3/account');
    const usdt = data.balances?.find(b => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.free) : 0;
  },
};

module.exports = MEXCBroker;
