/**
 * brokers/gateio.js — Gate.io 现货交易 Broker（真实执行）
 *
 * 所需环境变量：
 *   GATEIO_API_KEY    — API Key
 *   GATEIO_SECRET     — API Secret
 *
 * 申请方式：https://www.gate.io → 账户 → API 管理
 * 文档：https://www.gate.io/docs/developers/apiv4/en/
 *
 * 签名算法：
 *   HMAC-SHA512(method + "\n" + path + "\n" + query + "\n" + sha512(body) + "\n" + ts, secret)
 */

const https = require('https');
const crypto = require('crypto');

const KEY    = process.env.GATEIO_API_KEY;
const SECRET = process.env.GATEIO_SECRET;
const HOST   = 'api.gateio.ws';
const PREFIX = '/api/v4';

function sha512hex(body) {
  return crypto.createHash('sha512').update(body || '').digest('hex');
}

function sign(method, path, query, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const msg = [method.toUpperCase(), PREFIX + path, query || '', sha512hex(body || ''), ts].join('\n');
  const sig = crypto.createHmac('sha512', SECRET).update(msg).digest('hex');
  return { ts, sig };
}

function request(method, path, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const query = method === 'GET' && Object.keys(params).length
      ? new URLSearchParams(params).toString() : '';
    const bodyStr = body ? JSON.stringify(body) : '';
    const { ts, sig } = sign(method, path, query, bodyStr);
    const fullPath = PREFIX + path + (query ? '?' + query : '');
    const opts = {
      hostname: HOST, path: fullPath, method,
      headers: {
        'Content-Type': 'application/json',
        'KEY': KEY,
        'SIGN': sig,
        'Timestamp': ts,
      },
      timeout: 8000,
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (res.statusCode >= 400) reject(new Error(`Gate ${res.statusCode}: ${j.message || b}`));
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
  if (!KEY || !SECRET) throw new Error('Gate.io Broker: 请设置 GATEIO_API_KEY / GATEIO_SECRET 环境变量');
}

// Gate.io 品种格式: BTC_USDT（下划线）
// agent.js 传入 BTC-USDT，需转换
function toGate(symbol) {
  return symbol.replace('-', '_');
}

const GateioBroker = {
  name: 'Gate.io 现货',
  TYPE: 'live',

  async fetchTicker(symbol) {
    const pair = toGate(symbol);
    const data = await new Promise((resolve, reject) => {
      https.get(`https://${HOST}${PREFIX}/spot/tickers?currency_pair=${pair}`, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => { try { resolve(JSON.parse(b)[0]); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    return {
      symbol,
      price: parseFloat(data.last),
      bid: parseFloat(data.highest_bid),
      ask: parseFloat(data.lowest_ask),
      volume: parseFloat(data.base_volume),
      source: 'gateio',
    };
  },

  async placeOrder({ symbol, side, qty, price }) {
    checkKeys();
    const body = {
      currency_pair: toGate(symbol),
      type: 'limit',
      side: side.toLowerCase(),  // buy / sell
      amount: qty.toFixed(6),
      price: price.toFixed(4),
      time_in_force: 'gtc',
    };
    console.log(`[GATE] ${side} ${qty} ${symbol} @ ${price}`);
    const data = await request('POST', '/spot/orders', {}, body);
    return { orderId: data.id, status: data.status, raw: data };
  },

  async cancelOrder(orderId, symbol) {
    checkKeys();
    const data = await request('DELETE', `/spot/orders/${orderId}`, { currency_pair: toGate(symbol) });
    return { ok: data.status === 'cancelled' };
  },

  async getBalance() {
    checkKeys();
    const data = await request('GET', '/spot/accounts', { currency: 'USDT' });
    return data[0] ? parseFloat(data[0].available) : 0;
  },
};

module.exports = GateioBroker;
