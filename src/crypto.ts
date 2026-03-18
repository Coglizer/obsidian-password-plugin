import { Vault, TFile } from 'obsidian';
import { EncryptedFileHeader } from './types';

const CURRENT_VERSION = 2;
const LEGACY_VERSION = 1;
const ENC_EXTENSION = '.enc';
export const MIN_ITERATIONS = 100000;

// --- Salt / encoding helpers ---

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

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// --- Key derivation ---
// Derives a non-extractable AES-GCM key and a verification hash.
// The raw key material is zeroed after use.

export async function deriveKeyAndHash(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<{ key: CryptoKey; hash: string }> {
  const safeIterations = Math.max(iterations, MIN_ITERATIONS);
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Derive 256 bits of raw key material
  const rawBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: safeIterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  // Hash raw bytes for password verification
  const hashBuffer = await crypto.subtle.digest('SHA-256', rawBits);
  const hashArray = new Uint8Array(hashBuffer);
  let hashBinary = '';
  for (let i = 0; i < hashArray.length; i++) {
    hashBinary += String.fromCharCode(hashArray[i]);
  }
  const hash = btoa(hashBinary);

  // Import as NON-extractable AES-GCM key
  const key = await crypto.subtle.importKey(
    'raw',
    rawBits,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  // Zero the raw key material
  new Uint8Array(rawBits).fill(0);

  return { key, hash };
}

// --- AES-256-GCM with AAD ---

export async function encryptBuffer(
  data: ArrayBuffer,
  key: CryptoKey,
  aad?: Uint8Array
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
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
  return crypto.subtle.decrypt(params, key, ciphertext);
}

// --- Binary file format (v2) ---
// Layout: [4-byte header length (big-endian uint32)] [header JSON bytes] [raw ciphertext]
// The header JSON bytes are passed as AAD to AES-GCM, authenticating them without encrypting.

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

function legacyBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- File encryption/decryption ---

export async function encryptFile(
  vault: Vault,
  file: TFile,
  key: CryptoKey
): Promise<void> {
  const data = await vault.readBinary(file);

  const header: EncryptedFileHeader = {
    version: CURRENT_VERSION,
    iv: '', // placeholder, filled after encryption
    originalExtension: file.extension,
  };

  // We need the IV first, so encrypt, then build final header
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

export async function decryptFile(
  vault: Vault,
  file: TFile,
  key: CryptoKey
): Promise<void> {
  const rawData = await vault.readBinary(file);
  const firstByte = new Uint8Array(rawData, 0, 1)[0];

  let plaintext: ArrayBuffer;

  if (firstByte === 0x7B) {
    // Legacy text format (v1): starts with '{' (JSON header)
    plaintext = await decryptLegacyFile(rawData, key);
  } else {
    // Binary format (v2)
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
