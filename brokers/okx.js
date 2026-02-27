/**
 * brokers/okx.js — OKX 现货交易 Broker（真实执行）
 *
 * 所需环境变量：
 *   OKX_API_KEY       — API Key
 *   OKX_SECRET_KEY    — Secret Key
 *   OKX_PASSPHRASE    — API 密码短语
 *   OKX_DEMO=true     — 可选，使用 OKX 模拟盘（demo.okx.com）
 *
 * 申请方式：https://www.okx.com → API → 创建 V5 API Key
 *
 * 文档：https://www.okx.com/docs-v5/en/
 *
 * 签名算法：
 *   sign = Base64(HMAC-SHA256(timestamp + method + path + body, secret))
 */

const https = require('https');
const crypto = require('crypto');

const KEY       = process.env.OKX_API_KEY;
const SECRET    = process.env.OKX_SECRET_KEY;
const PASSPHRASE= process.env.OKX_PASSPHRASE;
const DEMO      = process.env.OKX_DEMO === 'true';
const HOST      = DEMO ? 'www.okx.com' : 'www.okx.com';
const DEMO_HDR  = DEMO ? { 'x-simulated-trading': '1' } : {};

function sign(ts, method, path, body = '') {
  const msg = ts + method.toUpperCase() + path + body;
  return crypto.createHmac('sha256', SECRET).update(msg).digest('base64');
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const ts = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': KEY,
      'OK-ACCESS-SIGN': sign(ts, method, path, bodyStr),
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': PASSPHRASE,
      ...DEMO_HDR,
    };
    const opts = {
      hostname: HOST, path, method,
      headers, timeout: 8000,
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.code !== '0') reject(new Error(`OKX err ${j.code}: ${j.msg}`));
          else resolve(j.data);
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
  if (!KEY || !SECRET || !PASSPHRASE) {
    throw new Error('OKX Broker: 请设置 OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE 环境变量');
  }
}

// OKX instId 格式: BTC-USDT（现货）/ BTC-USDT-SWAP（合约）
// agent.js 传入的 symbol 已是 OKX 格式，直接使用

const OKXBroker = {
  name: DEMO ? 'OKX 模拟盘' : 'OKX 现货',
  TYPE: 'live',

  async fetchTicker(symbol) {
    // Public endpoint, 不需要签名
    const data = await new Promise((resolve, reject) => {
      const url = `https://${HOST}/api/v5/market/ticker?instId=${symbol}`;
      https.get(url, { headers: { 'User-Agent': 'SurvivalAgent/2' } }, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => { try { resolve(JSON.parse(b).data[0]); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    return {
      symbol,
      price: parseFloat(data.last),
      bid: parseFloat(data.bidPx),
      ask: parseFloat(data.askPx),
      volume: parseFloat(data.vol24h),
      source: DEMO ? 'okx-demo' : 'okx-live',
    };
  },

  async placeOrder({ symbol, side, qty, price }) {
    checkKeys();
    // OKX 市价单：ordType=market；限价单：ordType=limit
    const body = {
      instId: symbol,
      tdMode: 'cash',          // 现货: cash | 保证金: cross/isolated
      side: side.toLowerCase(), // buy / sell
      ordType: 'limit',
      px: price.toFixed(4),
      sz: qty.toFixed(6),
    };
    console.log(`[OKX] placing ${DEMO?'DEMO ':''} ${side} ${qty} ${symbol} @ ${price}`);
    const data = await request('POST', '/api/v5/trade/order', body);
    return { orderId: data[0].ordId, status: data[0].sCode === '0' ? 'ok' : 'err', raw: data[0] };
  },

  async cancelOrder(orderId, symbol) {
    checkKeys();
    const data = await request('POST', '/api/v5/trade/cancel-order', { instId: symbol, ordId: orderId });
    return { ok: data[0].sCode === '0' };
  },

  async getBalance() {
    checkKeys();
    const data = await request('GET', '/api/v5/account/balance');
    // 返回 USDT 可用余额
    const detail = data[0]?.details?.find(d => d.ccy === 'USDT');
    return detail ? parseFloat(detail.availEq) : 0;
  },
};

module.exports = OKXBroker;
