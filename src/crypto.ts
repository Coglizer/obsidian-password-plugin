/**
 * Encryption module — all cryptographic operations live here.
 *
 * Uses the Web Crypto API (crypto.subtle) which is available in both
 * Obsidian's Electron runtime (desktop) and mobile WebView environments.
 *
 * Cipher: AES-256-GCM with random 12-byte IVs
 * KDF:    PBKDF2-SHA256 with per-folder salts
 * Format: Binary v2 (header as AAD + raw ciphertext), with backward-compat for v1 text/base64
 */
import { Vault, TFile } from 'obsidian';
import { EncryptedFileHeader } from './types';

const CURRENT_VERSION = 2;
const LEGACY_VERSION = 1;
const ENC_EXTENSION = '.enc';
/** Absolute floor for PBKDF2 iterations — enforced even if the user sets a lower value in settings */
export const MIN_ITERATIONS = 100000;

// --- Salt / encoding helpers ---
// Manual base64 encoding/decoding avoids Buffer (not available in all WebView environments)
// and works with raw byte arrays rather than strings.

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function saltToBase64(salt: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < salt.length; i++) {
    binary += String.fromCharCode(salt[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --- Constant-time comparison ---
// Prevents timing side-channel attacks where an attacker could measure response time
// to determine how many leading characters of a hash match. XOR accumulates differences
// across ALL characters before returning, so timing is independent of where mismatches occur.
// Note: the early return on length mismatch is acceptable because our hashes are always
// the same length (base64-encoded SHA-256 = 44 chars).

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// --- Key derivation ---
// Two-step process:
//   1. PBKDF2(password, salt) → 256 raw bits (slow, intentionally expensive)
//   2. SHA-256(raw bits) → verification hash (stored in config for password checking)
//
// The raw bits are imported as a non-extractable CryptoKey so JavaScript code cannot
// read the key material after creation — it can only be used for encrypt/decrypt ops.
// Raw bits are explicitly zeroed after import to minimize time in readable memory.

export async function deriveKeyAndHash(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<{ key: CryptoKey; hash: string }> {
  // Enforce minimum iterations regardless of what was passed in
  const safeIterations = Math.max(iterations, MIN_ITERATIONS);
  const enc = new TextEncoder();

  // Step 1: Import password as PBKDF2 key material (not yet derived)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Step 2: Run the expensive PBKDF2 derivation to get raw key bytes
  const rawBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: safeIterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  // Step 3: Hash the raw key bytes to create a verification token.
  // We store this hash (not the key) so we can check "is this the right password?"
  // without exposing the actual encryption key in persisted storage.
  const hashBuffer = await crypto.subtle.digest('SHA-256', rawBits);
  const hashArray = new Uint8Array(hashBuffer);
  let hashBinary = '';
  for (let i = 0; i < hashArray.length; i++) {
    hashBinary += String.fromCharCode(hashArray[i]);
  }
  const hash = btoa(hashBinary);

  // Step 4: Import raw bits as a non-extractable AES-GCM CryptoKey.
  // 'extractable: false' means crypto.subtle.exportKey() will reject — the key
  // can only be used for encrypt/decrypt, never read back as bytes.
  const key = await crypto.subtle.importKey(
    'raw',
    rawBits,
    { name: 'AES-GCM' },
    false, // non-extractable
    ['encrypt', 'decrypt']
  );

  // Step 5: Overwrite raw key material in memory to reduce exposure window
  new Uint8Array(rawBits).fill(0);

  return { key, hash };
}

// --- AES-256-GCM with AAD ---
// GCM mode provides both confidentiality (encryption) and integrity (authentication tag).
// AAD (Additional Authenticated Data) lets us authenticate the file header without encrypting it —
// if anyone tampers with the header (e.g., changes originalExtension), decryption will fail
// because the GCM tag won't verify.

export async function encryptBuffer(
  data: ArrayBuffer,
  key: CryptoKey,
  aad?: Uint8Array
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  // 12-byte IV is the recommended size for AES-GCM (NIST SP 800-38D)
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (aad) {
    params.additionalData = aad;
  }
  const ciphertext = await crypto.subtle.encrypt(params, key, data);
  return { ciphertext, iv };
}

export async function decryptBuffer(
  ciphertext: ArrayBuffer,
  key: CryptoKey,
  iv: Uint8Array,
  aad?: Uint8Array
): Promise<ArrayBuffer> {
  const params: AesGcmParams = { name: 'AES-GCM', iv };
  if (aad) {
    params.additionalData = aad;
  }
  // Will throw if: wrong key, tampered ciphertext, or tampered AAD
  return crypto.subtle.decrypt(params, key, ciphertext);
}

// --- Binary file format (v2) ---
// Layout: [4-byte header length (big-endian uint32)] [header JSON bytes] [raw ciphertext]
//
// Why binary instead of the original v1 text/base64?
//   - v1 base64-encoded ciphertext, inflating file size by ~33%
//   - v2 stores raw ciphertext bytes, keeping files close to original size
//   - The 4-byte length prefix allows parsing without scanning for delimiters
//   - Header JSON is passed as AAD to AES-GCM, making it tamper-proof without encrypting it

function packEncryptedFile(headerBytes: Uint8Array, ciphertext: ArrayBuffer): ArrayBuffer {
  const headerLen = headerBytes.length;
  const result = new ArrayBuffer(4 + headerLen + ciphertext.byteLength);
  const view = new DataView(result);
  view.setUint32(0, headerLen, false); // big-endian
  new Uint8Array(result, 4, headerLen).set(headerBytes);
  new Uint8Array(result, 4 + headerLen).set(new Uint8Array(ciphertext));
  return result;
}

function unpackEncryptedFile(data: ArrayBuffer): { headerBytes: Uint8Array; ciphertext: ArrayBuffer } {
  const view = new DataView(data);
  const headerLen = view.getUint32(0, false);
  const headerBytes = new Uint8Array(data.slice(4, 4 + headerLen));
  const ciphertext = data.slice(4 + headerLen);
  return { headerBytes, ciphertext };
}

// --- Legacy text format (v1) helpers ---
// v1 format: "JSON_HEADER\nBASE64_CIPHERTEXT" — kept for backward compatibility so
// users who encrypted files before the v2 upgrade can still decrypt them.

function legacyBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- File encryption/decryption ---

/**
 * Encrypt a single file in-place:
 *   1. Read original file as binary
 *   2. Generate random IV, build JSON header with metadata
 *   3. Encrypt file contents with header as AAD
 *   4. Write packed .enc file, then delete the original
 *
 * The "write new then delete old" order ensures that if the process is interrupted,
 * the original file still exists (no data loss). The worst case is a leftover .enc
 * alongside the original, which the next lock/unlock cycle will reconcile.
 */
export async function encryptFile(
  vault: Vault,
  file: TFile,
  key: CryptoKey
): Promise<void> {
  const data = await vault.readBinary(file);

  const header: EncryptedFileHeader = {
    version: CURRENT_VERSION,
    iv: '', // placeholder — filled below once IV is generated
    originalExtension: file.extension,
  };

  const iv = crypto.getRandomValues(new Uint8Array(12));
  let ivBinary = '';
  for (let i = 0; i < iv.length; i++) {
    ivBinary += String.fromCharCode(iv[i]);
  }
  header.iv = btoa(ivBinary);

  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);

  // Encrypt with header as AAD
  const params: AesGcmParams = { name: 'AES-GCM', iv, additionalData: headerBytes };
  const ciphertext = await crypto.subtle.encrypt(params, key, data);

  const packed = packEncryptedFile(headerBytes, ciphertext);
  const encPath = file.path + ENC_EXTENSION;

  await vault.createBinary(encPath, packed);
  await vault.delete(file);
}

/**
 * Decrypt a single .enc file back to its original form.
 * Auto-detects v1 vs v2 format by inspecting the first byte:
 *   - 0x7B ('{') → v1 legacy text/base64 format (header starts with JSON '{')
 *   - anything else → v2 binary format (first 4 bytes are a uint32 header length)
 *
 * Same write-then-delete ordering as encryptFile for crash safety.
 */
export async function decryptFile(
  vault: Vault,
  file: TFile,
  key: CryptoKey
): Promise<void> {
  const rawData = await vault.readBinary(file);
  // Peek at first byte to determine format version
  const firstByte = new Uint8Array(rawData, 0, 1)[0];

  let plaintext: ArrayBuffer;

  if (firstByte === 0x7B) {
    plaintext = await decryptLegacyFile(rawData, key);
  } else {
    plaintext = await decryptBinaryFile(rawData, key);
  }

  const originalPath = file.path.slice(0, -ENC_EXTENSION.length);
  await vault.createBinary(originalPath, plaintext);
  await vault.delete(file);
}

async function decryptBinaryFile(rawData: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const { headerBytes, ciphertext } = unpackEncryptedFile(rawData);
  const headerJson = new TextDecoder().decode(headerBytes);
  const header: EncryptedFileHeader = JSON.parse(headerJson);

  if (header.version !== CURRENT_VERSION) {
    throw new Error(`Unsupported encryption version: ${header.version}`);
  }

  const iv = base64ToBytes(header.iv);

  // Decrypt with header as AAD (verifies header integrity)
  return decryptBuffer(ciphertext, key, iv, headerBytes);
}

async function decryptLegacyFile(rawData: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  // Legacy v1: text format "JSON_HEADER\nBASE64_CIPHERTEXT"
  const text = new TextDecoder().decode(rawData);
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) {
    throw new Error('Invalid legacy encrypted file format');
  }

  const headerStr = text.substring(0, newlineIndex);
  const ciphertextB64 = text.substring(newlineIndex + 1);

  const header: EncryptedFileHeader = JSON.parse(headerStr);
  if (header.version !== LEGACY_VERSION) {
    throw new Error(`Unsupported legacy encryption version: ${header.version}`);
  }

  const iv = base64ToBytes(header.iv);
  const ciphertext = legacyBase64ToArrayBuffer(ciphertextB64);

  // Legacy format had no AAD
  return decryptBuffer(ciphertext, key, iv);
}

export function isEncryptedFile(file: TFile): boolean {
  return file.path.endsWith(ENC_EXTENSION);
}

/**
 * Encrypt all plaintext files within a folder. Skips files that already have .enc extension.
 * Files are processed sequentially (not in parallel) to avoid overwhelming the vault
 * with concurrent I/O and to give the progress callback meaningful current/total values.
 */
export async function encryptFolder(
  vault: Vault,
  folderPath: string,
  key: CryptoKey,
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {
  const files = vault.getFiles().filter(
    (f) => f.path.startsWith(folderPath + '/') && !isEncryptedFile(f)
  );
  const encrypted: string[] = [];

  for (let i = 0; i < files.length; i++) {
    await encryptFile(vault, files[i], key);
    encrypted.push(files[i].path);
    onProgress?.(i + 1, files.length);
  }
  return encrypted;
}

/** Decrypt all .enc files within a folder back to their original form. */
export async function decryptFolder(
  vault: Vault,
  folderPath: string,
  key: CryptoKey,
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {
  const files = vault.getFiles().filter(
    (f) => f.path.startsWith(folderPath + '/') && isEncryptedFile(f)
  );
  const decrypted: string[] = [];

  for (let i = 0; i < files.length; i++) {
    await decryptFile(vault, files[i], key);
    decrypted.push(files[i].path);
    onProgress?.(i + 1, files.length);
  }
  return decrypted;
}
