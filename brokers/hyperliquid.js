/**
 * brokers/hyperliquid.js — Hyperliquid 永续合约 Broker（真实执行）
 *
 * 所需环境变量：
 *   HL_PRIVATE_KEY — 以太坊私钥（0x...）用于签名订单
 *   HL_WALLET      — 对应的以太坊钱包地址
 *   HL_TESTNET=true — 可选，使用测试网
 *
 * 特点：
 *   - 去中心化链上交易所，无 API Key，用私钥签名
 *   - 只支持 USDC（跨链桥转入）
 *   - 品种格式: BTC / ETH / SOL（不带 -USDT）
 *   - 全球可访问（本机已确认 200）
 *
 * 文档：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 *
 * ⚠️ 签名需要 eth_sign (EIP-712)，纯 Node.js 需要手写椭圆曲线
 *    实际接入建议安装 ethers.js: npm install ethers
 *    此文件展示接口结构，签名部分标注 TODO
 */

const https = require('https');
const crypto = require('crypto');

const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const WALLET      = process.env.HL_WALLET;
const TESTNET     = process.env.HL_TESTNET === 'true';
const BASE_URL    = TESTNET ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url = new URL(BASE_URL + path);
    const opts = {
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(bodyStr);
    req.end();
  });
}

function checkKeys() {
  if (!PRIVATE_KEY || !WALLET) {
    throw new Error('Hyperliquid Broker: 请设置 HL_PRIVATE_KEY / HL_WALLET 环境变量');
  }
}

// HL 品种格式: BTC / ETH / SOL（agent 传入 BTC-USDT → 取前段）
function toHL(symbol) {
  return symbol.split('-')[0];
}

/**
 * 生成 Hyperliquid 订单签名
 * 完整实现需要 EIP-712 签名，此处为占位
 * 真实部署时替换为: const { ethers } = require('ethers'); 版本
 */
function signOrder(orderPayload) {
  // TODO: 替换为真实 EIP-712 签名
  // const wallet = new ethers.Wallet(PRIVATE_KEY);
  // return wallet.signTypedData(domain, types, orderPayload);
  throw new Error('Hyperliquid 签名未实现：请安装 ethers.js 并替换 signOrder()');
}

const HyperliquidBroker = {
  name: TESTNET ? 'Hyperliquid 测试网' : 'Hyperliquid 永续',
  TYPE: 'live',

  async fetchTicker(symbol) {
    const coin = toHL(symbol);
    const data = await post('/info', { type: 'allMids' });
    const price = parseFloat(data[coin]);
    if (!price) throw new Error(`HL: ${coin} not found`);
    // orderbook for bid/ask
    const book = await post('/info', { type: 'l2Book', coin });
    const bid = book.levels?.[0]?.[0]?.px ? parseFloat(book.levels[0][0].px) : price;
    const ask = book.levels?.[1]?.[0]?.px ? parseFloat(book.levels[1][0].px) : price;
    return { symbol, price, bid, ask, volume: 0, source: 'hyperliquid' };
  },

  async placeOrder({ symbol, side, qty, price, leverage = 1 }) {
    checkKeys();
    const coin = toHL(symbol);
    const isBuy = side.toUpperCase() === 'BUY';

    const orderPayload = {
      coin,
      isBuy,
      limitPx: price.toFixed(4),
      sz: qty.toFixed(6),
      reduceOnly: false,
      orderType: { limit: { tif: 'Gtc' } },
    };

    // 真实签名流程（需 ethers.js）:
    // const sig = await signOrder(orderPayload);
    // const body = { action: { type: 'order', orders: [orderPayload], grouping: 'na' }, nonce: Date.now(), signature: sig };
    // const result = await post('/exchange', body);

    throw new Error('Hyperliquid 下单需要 ethers.js，请运行: npm install ethers 后取消注释签名代码');
  },

  async cancelOrder(orderId, symbol) {
    checkKeys();
    // 同理需要签名
    throw new Error('Hyperliquid 撤单需要签名，请先接入 ethers.js');
  },

  async getBalance() {
    checkKeys();
    const data = await post('/info', { type: 'clearinghouseState', user: WALLET });
    return parseFloat(data?.marginSummary?.accountValue || 0);
  },
};

module.exports = HyperliquidBroker;
