/**
 * brokers/htx.js — HTX (火币 Huobi) 现货交易 Broker（真实执行）
 *
 * 所需环境变量：
 *   HTX_API_KEY    — Access Key
 *   HTX_SECRET     — Secret Key
 *   HTX_ACCOUNT_ID — 现货账户 ID（从 /v1/account/accounts 获取）
 *
 * 申请方式：https://www.htx.com → API 管理
 * 文档：https://huobiapi.github.io/docs/spot/v1/en/
 *
 * 签名算法（Query 参数 + HMAC-SHA256 Base64）：
 *   将签名参数按字母排序拼入 query → HMAC-SHA256(hostline + path + query, secret) → Base64
 */

const https = require('https');
const crypto = require('crypto');

const KEY    = process.env.HTX_API_KEY;
const SECRET = process.env.HTX_SECRET;
const ACCT   = process.env.HTX_ACCOUNT_ID;
const HOST   = 'api.huobi.pro';

function sign(method, path, params) {
  const ts = new Date().toISOString().slice(0, 19);
  const base = {
    AccessKeyId: KEY,
    SignatureMethod: 'HmacSHA256',
    SignatureVersion: '2',
    Timestamp: ts,
    ...params,
  };
  const query = Object.keys(base).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(base[k])}`).join('&');
  const msg = [method.toUpperCase(), HOST, path, query].join('\n');
  const sig = crypto.createHmac('sha256', SECRET).update(msg).digest('base64');
  return query + '&Signature=' + encodeURIComponent(sig);
}

function request(method, path, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const signed = sign(method, path, method === 'GET' ? params : {});
    const fullPath = path + '?' + signed;
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: HOST, path: fullPath, method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 8000,
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.status === 'error') reject(new Error(`HTX: ${j['err-msg']}`));
          else resolve(j.data ?? j);
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
  if (!KEY || !SECRET) throw new Error('HTX Broker: 请设置 HTX_API_KEY / HTX_SECRET 环境变量');
  if (!ACCT) throw new Error('HTX Broker: 请设置 HTX_ACCOUNT_ID 环境变量（从 GET /v1/account/accounts 获取）');
}

// HTX 品种格式: btcusdt（小写，无分隔符）
function toHTX(symbol) {
  return symbol.replace('-', '').toLowerCase();
}

const HTXBroker = {
  name: 'HTX 火币现货',
  TYPE: 'live',

  async fetchTicker(symbol) {
    const s = toHTX(symbol);
    const data = await new Promise((resolve, reject) => {
      https.get(`https://${HOST}/market/detail/merged?symbol=${s}`, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    return {
      symbol,
      price: data.tick.close,
      bid: data.tick.bid?.[0] || data.tick.close,
      ask: data.tick.ask?.[0] || data.tick.close,
      volume: data.tick.vol,
      source: 'htx',
    };
  },

  async placeOrder({ symbol, side, qty, price }) {
    checkKeys();
    const body = {
      'account-id': ACCT,
      symbol: toHTX(symbol),
      type: `${side.toLowerCase()}-limit`,  // buy-limit / sell-limit
      amount: qty.toFixed(6),
      price: price.toFixed(4),
      source: 'spot-api',
    };
    console.log(`[HTX] ${side} ${qty} ${symbol} @ ${price}`);
    const orderId = await request('POST', '/v1/order/orders/place', {}, body);
    return { orderId, status: 'submitted' };
  },

  async cancelOrder(orderId) {
    checkKeys();
    await request('POST', `/v1/order/orders/${orderId}/submitcancel`);
    return { ok: true };
  },

  async getBalance() {
    checkKeys();
    const list = await request('GET', `/v1/account/accounts/${ACCT}/balance`);
    const usdt = list?.list?.find(b => b.currency === 'usdt' && b.type === 'trade');
    return usdt ? parseFloat(usdt.balance) : 0;
  },
};

module.exports = HTXBroker;
