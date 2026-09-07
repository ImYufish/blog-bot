import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

function qqSeedBytes(appSecret) {
  const bytes = new TextEncoder().encode(appSecret || '');
  if (bytes.length === 0) throw new Error('empty');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = bytes[i % bytes.length];
  return out;
}

const appSecret = 'naOC0ocQE3O1jk0uG6KGBFFvogd3gAel';
const seed = qqSeedBytes(appSecret);

const eventTs = '1723273956';
const plain = '41c3m0xNHPIQu';
const msg = new TextEncoder().encode(eventTs + plain);
const sig = await ed.signAsync(msg, seed);
const sigHex = ed.etc.bytesToHex(sig);
console.log('sig hex:', sigHex);

const pub = await ed.getPublicKeyAsync(seed);
console.log('op13 verify:', await ed.verifyAsync(sig, msg, pub));

const rawBody = '{"op":0,"d":{},"t":"TEST"}';
const ts = '1723273956';
const evMsg = new TextEncoder().encode(ts + rawBody);
const evSig = await ed.signAsync(evMsg, seed);
console.log('event verify:', await ed.verifyAsync(evSig, evMsg, pub));
