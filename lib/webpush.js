// Boobo – Web Push ohne npm-Paket: VAPID (RFC 8292) und Payload-Verschlüsselung aes128gcm (RFC 8291 / RFC 8188)
// mit node:crypto. Der Push-Dienst (Google, Apple, Mozilla) sieht nur verschlüsselte Bytes.

import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// Schlüsselpaar für VAPID: öffentlicher Schlüssel roh (65 Bytes, base64url) für den Browser,
// privater Schlüssel als PKCS8-PEM für die Datenbank.
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: b64u(rawPublicKey(publicKey)),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function rawPublicKey(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
}

// Authorization-Header für den Push-Dienst: signiertes JWT (ES256) plus öffentlicher Schlüssel.
export function vapidAuthorization({ endpoint, subject, publicKey, privateKey, expiresInSec = 12 * 3600, nowSec = Math.floor(Date.now() / 1000) }) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: nowSec + expiresInSec, sub: subject }));
  const input = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${publicKey}`;
}

// Prüft eine mit vapidAuthorization erzeugte Signatur (für Tests).
export function verifyVapidToken(token, publicKey) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(fromB64u(publicKey).subarray(1, 33)), y: b64u(fromB64u(publicKey).subarray(33, 65)) },
    format: 'jwk',
  });
  return crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(parts[2]));
}

// Verschlüsselt `plaintext` für eine Push-Anmeldung { p256dh, auth } (aes128gcm, ein Record).
// salt/localPrivateKey nur für reproduzierbare Tests.
export function encryptPayload({ p256dh, auth }, plaintext, { salt, localPrivateKey } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 public key');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');

  const ecdh = crypto.createECDH('prime256v1');
  if (localPrivateKey) ecdh.setPrivateKey(localPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const theSalt = salt || crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, theSalt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, theSalt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 = letzter Record
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const header = Buffer.concat([theSalt, recordSize, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body]);
}

// Gegenstück zu encryptPayload aus Sicht des Browsers (für Tests): privater Schlüssel des Empfängers + auth.
export function decryptPayload(body, { privateKey, auth }) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, fromB64u(auth), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('bad padding delimiter');
  return padded.subarray(0, end);
}

// Schickt eine Nachricht an eine Anmeldung. Ergebnis { ok, status, gone }; gone = Anmeldung existiert nicht mehr.
export async function sendPush(subscription, payload, { subject, publicKey, privateKey, ttl = 3600, urgency = 'high', fetchImpl = fetch } = {}) {
  const body = encryptPayload(subscription.keys, typeof payload === 'string' ? payload : JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'Content-Length': String(body.length),
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthorization({ endpoint: subscription.endpoint, subject, publicKey, privateKey }),
  };
  const res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body });
  const status = res.status;
  return { ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410 };
}
