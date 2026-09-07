// 纯 JS Ed25519（RFC 8032），仅依赖 Web Crypto 的 SHA-512，无需 npm。
// 用于 edge-functions/wxbot.js（EO 边缘函数无法 import @noble/ed25519）。
// 已在 Node 中用 RFC 8032 §7.1 已知向量验证 sign / verify / 公钥派生 全部通过。

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n; // 基点阶
const D = ((-121665n % P) + P) % P * _pow(121666n, P - 2n) % P; // d = -121665/121666 mod P

function _pow(b, e) {
  b %= P;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const _inv = (a) => _pow(((a % P) + P) % P, P - 2n);

// 基点 B：y = 4/5，x 取偶数根（标准 Ed25519 基点）
const BY = (4n * _inv(5n)) % P;
function _xFromY(y) {
  // 由 -x^2 + y^2 = 1 + d x^2 y^2  →  x^2 = (y^2 - 1) / (1 + d y^2)
  let v = (((y * y - 1n) % P) + P) % P * _inv((((1n + D * y * y) % P) + P) % P) % P;
  let x = _pow(v, (P + 3n) / 8n);
  if (x < 0n) x += P;
  if ((x * x - v) % P !== 0n) x = (x * _pow(2n, (P - 1n) / 4n)) % P;
  if ((x * x - v) % P !== 0n) return null;
  if ((x & 1n) === 1n) x = (P - x) % P;
  return x;
}
const BX = _xFromY(BY);

// 扩展坐标点 [X, Y, Z, T]，x=X/Z, y=Y/Z, T=X*Y/Z
const B = [BX, BY, 1n, (BX * BY) % P];
const I = [0n, 1n, 1n, 0n];

// RFC 8032 §5.1.4 完全加法（a = -1）
function _edAdd(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [X1, Y1, Z1, T1] = p;
  const [X2, Y2, Z2, T2] = q;
  const A = (X1 * X2) % P;
  const Bv = (Y1 * Y2) % P;
  const C = (D * T1 * T2) % P;
  const Dd = (Z1 * Z2) % P;
  const E = ((((X1 + Y1) % P) * ((X2 + Y2) % P)) % P - A - Bv) % P;
  const F = (Dd - C) % P; // a = -1 → F = Dd - C
  const G = (Dd + C) % P;
  const Hh = (Bv + A) % P; // a = -1 → H = B - a*A = B + A
  const X3 = (E * F) % P;
  const Y3 = (G * Hh) % P;
  const T3 = (E * Hh) % P;
  const Z3 = (F * G) % P;
  return [((X3 % P) + P) % P, ((Y3 % P) + P) % P, ((Z3 % P) + P) % P, ((T3 % P) + P) % P];
}

function _scalarMult(k, point) {
  k = ((k % L) + L) % L;
  let r = null;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) r = _edAdd(r, addend);
    addend = _edAdd(addend, addend);
    k >>= 1n;
  }
  return r || I;
}

// 字节工具（little-endian）
function _bytesToLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}
function _leToBytes(n, len) {
  const out = new Uint8Array(len);
  let v = ((n % P) + P) % P;
  for (let i = 0; i < len; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

let _cryptoSubtle;
function _getSubtle() {
  if (_cryptoSubtle) return _cryptoSubtle;
  if (typeof crypto !== "undefined" && crypto.subtle) _cryptoSubtle = crypto.subtle;
  else if (typeof require !== "undefined") {
    const nodeCrypto = require("crypto");
    _cryptoSubtle = { digest: (algo, data) => nodeCrypto.webcrypto.subtle.digest(algo, data) };
  }
  return _cryptoSubtle;
}
async function _sha512Async(bytes) {
  const buf = await _getSubtle().digest("SHA-512", bytes);
  return new Uint8Array(buf);
}

function _clamp(sk32) {
  sk32[0] &= 248;
  sk32[31] &= 127;
  sk32[31] |= 64;
  return sk32;
}

function _encodePoint(p) {
  const x = ((p[0] * _inv(p[2])) % P + P) % P;
  const y = ((p[1] * _inv(p[2])) % P + P) % P;
  const out = _leToBytes(y, 32);
  if (((x & 1n) & 1n) === 1n) out[31] |= 0x80;
  return out;
}

function _decodePoint(bytes) {
  const y = _bytesToLE(bytes) & ((1n << 255n) - 1n);
  const xSign = (bytes[31] >> 7) & 1;
  let x = _xFromY(y);
  if (x === null) return null;
  if (Number(x & 1n) !== xSign) x = (P - x) % P;
  return [x, y, 1n, (x * y) % P];
}

async function publicKeyFromSeed(seed) {
  const h = await _sha512Async(seed);
  const s = _clamp(new Uint8Array(h.slice(0, 32)));
  const a = _bytesToLE(s);
  return _encodePoint(_scalarMult(a, B));
}

function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// signature = R(32) || S(32)，little-endian
async function sign(message, seed) {
  const h = await _sha512Async(seed);
  const aBytes = _clamp(new Uint8Array(h.slice(0, 32)));
  const a = _bytesToLE(aBytes);
  const prefix = h.slice(32);
  const A = _encodePoint(_scalarMult(a, B));
  let r = _bytesToLE(await _sha512Async(concatBytes(prefix, message)));
  r %= L;
  const R = _encodePoint(_scalarMult(r, B));
  const k = _bytesToLE(await _sha512Async(concatBytes(R, A, message))) % L;
  const S = (r + k * a) % L;
  return concatBytes(R, _leToBytes(S, 32));
}

// 验证 [8S]B == [8R] + [8k]A（cofactor=8），防小阶点攻击
async function verify(signature, message, publicKey) {
  if (signature.length !== 64) return false;
  const R = signature.slice(0, 32);
  const S = _bytesToLE(signature.slice(32));
  if (S >= L) return false;
  const A = _decodePoint(publicKey);
  if (!A) return false;
  const k = _bytesToLE(await _sha512Async(concatBytes(R, publicKey, message))) % L;
  const lhs = _scalarMult(8n * S, B);
  const rhs = _edAdd(_scalarMult(8n, _decodePoint(R)), _scalarMult(8n * k, A));
  if (!lhs || !rhs) return false;
  const lx = ((lhs[0] * _inv(lhs[2])) % P + P) % P;
  const ly = ((lhs[1] * _inv(lhs[2])) % P + P) % P;
  const rx = ((rhs[0] * _inv(rhs[2])) % P + P) % P;
  const ry = ((rhs[1] * _inv(rhs[2])) % P + P) % P;
  return lx === rx && ly === ry;
}

function seedFromAppSecret(appSecret) {
  const s = new TextEncoder().encode(appSecret || "");
  if (s.length === 0) throw new Error("APP_SECRET 未配置");
  let seed = s;
  while (seed.length < 32) {
    const doubled = new Uint8Array(seed.length * 2);
    doubled.set(seed, 0);
    doubled.set(seed, seed.length);
    seed = doubled;
  }
  return seed.subarray(0, 32);
}

const ED25519 = { publicKeyFromSeed, sign, verify, seedFromAppSecret, B, _scalarMult, _encodePoint, _decodePoint, _xFromY };

if (typeof module !== "undefined" && module.exports) module.exports = ED25519;
if (typeof exports !== "undefined") Object.assign(exports, ED25519);
