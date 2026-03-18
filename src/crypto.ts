import { Vault, TFile, Notice } from 'obsidian';
import { EncryptedFileHeader } from './types';

const HEADER_VERSION = 1;
const ENC_EXTENSION = '.enc';

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function saltToBase64(salt: Uint8Array): string {
  return btoa(String.fromCharCode(...salt));
}

export function base64ToSalt(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function hashKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', exported);
  const hashArray = new Uint8Array(hashBuffer);
  return btoa(String.fromCharCode(...hashArray));
}

export async function encryptBuffer(
  data: ArrayBuffer,
  key: CryptoKey
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return { ciphertext, iv };
}

export async function decryptBuffer(
  ciphertext: ArrayBuffer,
  key: CryptoKey,
  iv: Uint8Array
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function encryptFile(
  vault: Vault,
  file: TFile,
  key: CryptoKey
): Promise<void> {
  const data = await vault.readBinary(file);
  const { ciphertext, iv } = await encryptBuffer(data, key);

  const header: EncryptedFileHeader = {
    version: HEADER_VERSION,
    iv: btoa(String.fromCharCode(...iv)),
    originalExtension: file.extension,
  };

  const content = JSON.stringify(header) + '\n' + arrayBufferToBase64(ciphertext);
  const encPath = file.path + ENC_EXTENSION;

  await vault.create(encPath, content);
  await vault.delete(file);
}

export async function decryptFile(
  vault: Vault,
  file: TFile,
  key: CryptoKey
): Promise<void> {
  const content = await vault.read(file);
  const newlineIndex = content.indexOf('\n');
  if (newlineIndex === -1) {
    throw new Error(`Invalid encrypted file format: ${file.path}`);
  }

  const headerStr = content.substring(0, newlineIndex);
  const ciphertextB64 = content.substring(newlineIndex + 1);

  const header: EncryptedFileHeader = JSON.parse(headerStr);
  if (header.version !== HEADER_VERSION) {
    throw new Error(`Unsupported encryption version: ${header.version}`);
  }

  const iv = base64ToSalt(header.iv);
  const ciphertext = base64ToArrayBuffer(ciphertextB64);
  const plaintext = await decryptBuffer(ciphertext, key, iv);

  // Restore original path by removing .enc
  const originalPath = file.path.slice(0, -ENC_EXTENSION.length);
  await vault.createBinary(originalPath, plaintext);
  await vault.delete(file);
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
