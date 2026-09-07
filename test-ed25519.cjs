const ed = require("./src/ed25519.js");

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

(async () => {
  // RFC 8032 §7.1 Test 1
  const seedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const pubHex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const sigHex = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
  const seed = hexToBytes(seedHex);
  const msg = new Uint8Array(0);

  const pub = await ed.publicKeyFromSeed(seed);
  const pubOk = bytesToHex(pub) === pubHex;
  console.log("publicKeyFromSeed 匹配 RFC 向量:", pubOk, "(got " + bytesToHex(pub) + ")");

  const sig = await ed.sign(msg, seed);
  const sigOk = bytesToHex(sig) === sigHex;
  console.log("sign 匹配 RFC 向量:", sigOk, "(got " + bytesToHex(sig) + ")");

  const verifyOwn = await ed.verify(sig, msg, pub);
  console.log("verify(自签签名):", verifyOwn);

  const verifyRfc = await ed.verify(hexToBytes(sigHex), msg, pub);
  console.log("verify(RFC 给定签名):", verifyRfc);

  // 负向：篡改消息应验签失败
  const bad = await ed.verify(sig, new TextEncoder().encode("x"), pub);
  console.log("verify(篡改消息)应 false:", bad);

  const allOk = pubOk && sigOk && verifyOwn && verifyRfc && !bad;
  console.log("\n==> 全部通过:", allOk);
  process.exit(allOk ? 0 : 1);
})();
