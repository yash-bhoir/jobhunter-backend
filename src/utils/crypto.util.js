'use strict';

/**
 * crypto.util.js
 *
 * Exports:
 *   generateToken(bytes)  — secure random hex token (for email verify / password reset)
 *   hashToken(token)      — SHA-256 hex hash (store in DB, compare against user-supplied token)
 *
 *   encrypt(plaintext)    — AES-256-GCM field-level encryption for sensitive DB fields
 *   decrypt(ciphertext)   — Reverse of encrypt(); safe to call on legacy plaintext (returns as-is)
 *   isEncrypted(value)    — Heuristic: returns true if value looks like an encrypted blob
 *
 * ENCRYPTION_KEY env var:
 *   Must be a 64-character hex string (32 bytes).
 *   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Encrypted format (single base64 string):
 *   [12 bytes IV] + [16 bytes GCM auth tag] + [N bytes ciphertext]
 *
 * Backwards compat:
 *   decrypt() returns the original value unchanged on any decryption failure,
 *   so legacy plaintext values keep working until they are re-saved through
 *   the normal save path (which will then encrypt them).
 */

const crypto = require('crypto');

// ── Token helpers (existing) ──────────────────────────────────────

const generateToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

// ── AES-256-GCM field encryption ─────────────────────────────────

const ALGO    = 'aes-256-gcm';
const IV_LEN  = 12;                      // GCM recommended IV length
const TAG_LEN = 16;                      // GCM auth tag
const MIN_ENC = IV_LEN + TAG_LEN + 1;   // minimum valid encrypted blob size

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded string. Returns null/undefined/'' unchanged.
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;

  const key    = getKey();
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Layout: iv(12) | tag(16) | ciphertext(N)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a value previously encrypted with encrypt().
 * On any failure (wrong key, auth tag mismatch, too short, not base64)
 * the original value is returned — enabling safe use on legacy plaintext.
 */
function decrypt(ciphertext) {
  if (ciphertext == null || ciphertext === '') return ciphertext;

  let raw;
  try {
    raw = Buffer.from(ciphertext, 'base64');
  } catch {
    return ciphertext; // not base64 → legacy plaintext
  }

  if (raw.length < MIN_ENC) return ciphertext; // too short → legacy plaintext

  try {
    const key      = getKey();
    const iv       = raw.slice(0, IV_LEN);
    const tag      = raw.slice(IV_LEN, IV_LEN + TAG_LEN);
    const enc      = raw.slice(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    // Decryption failed — likely a legacy plaintext value
    return ciphertext;
  }
}

/**
 * Returns true if the value looks like it was produced by encrypt().
 * Useful for migration scripts to skip already-encrypted values.
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    const raw = Buffer.from(value, 'base64');
    return raw.length >= MIN_ENC;
  } catch {
    return false;
  }
}

module.exports = { generateToken, hashToken, encrypt, decrypt, isEncrypted };
