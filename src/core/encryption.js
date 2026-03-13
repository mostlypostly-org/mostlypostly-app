// src/core/encryption.js — AES-256-GCM encrypt/decrypt for sensitive integration credentials

import crypto from 'crypto';

const KEY_HEX = process.env.SALON_POS_ENCRYPTION_KEY;
const KEY = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : null;
const ALGO = 'aes-256-gcm';

export function encrypt(plaintext) {
  if (!KEY) throw new Error('SALON_POS_ENCRYPTION_KEY not set');
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext) {
  if (!KEY) throw new Error('SALON_POS_ENCRYPTION_KEY not set');
  if (!ciphertext) return null;
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}
