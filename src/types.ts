/**
 * Persisted configuration for a single protected folder.
 * Stored in plugin data.json under `protectedFolders[]`.
 */
export interface ProtectedFolderConfig {
  path: string;
  /** Base64-encoded 16-byte PBKDF2 salt — unique per folder so identical passwords produce different keys */
  salt: string;
  /** SHA-256 hash of the derived key material (NOT the password itself) — used only for verification */
  passwordHash: string;
  /** 'encrypt' = AES-256-GCM on disk; 'hide' = files stay plaintext, only hidden in UI */
  mode: 'encrypt' | 'hide';
  /** 'visible' = folder shows with lock icon when locked; 'hidden' = folder disappears from explorer */
  visibility: 'visible' | 'hidden';
  /** Per-folder iteration count — stored at protection time so changing the global setting doesn't
   *  invalidate existing folders' key derivation */
  iterations: number;
  createdAt: number;
}

/**
 * Top-level plugin settings — serialized to data.json via Obsidian's loadData/saveData.
 * Every field here is persisted across sessions.
 */
export interface PluginSettings {
  protectedFolders: ProtectedFolderConfig[];
  /** Global default for new folders — existing folders use their own stored value */
  pbkdf2Iterations: number;
  /** When true, all folders are locked during onunload (app close / plugin disable) */
  lockOnClose: boolean;
  /** 0 = disabled; otherwise locks all folders after N minutes of no clicks/keystrokes */
  autoLockMinutes: number;
  /** Crash-recovery journal: written before encrypt/decrypt batches, cleared after.
   *  If non-empty on next startup, the user is warned about possibly mixed-state files. */
  pendingOperations: PendingOperation[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  protectedFolders: [],
  pbkdf2Iterations: 600000,
  lockOnClose: true,
  autoLockMinutes: 0,
  pendingOperations: [],
};

/**
 * In-memory-only runtime state for a protected folder.
 * Never persisted — all folders start locked on plugin load.
 */
export interface FolderState {
  path: string;
  isUnlocked: boolean;
  /** The AES-256-GCM CryptoKey held in memory while unlocked.
   *  Marked non-extractable at creation so raw key bytes can't be read via JS. */
  derivedKey: CryptoKey | null;
}

/**
 * JSON header embedded in every .enc file.
 * In v2 binary format, this header is authenticated (AAD) but not encrypted,
 * so metadata is tamper-proof while ciphertext remains confidential.
 */
export interface EncryptedFileHeader {
  /** Format version: 1 = legacy text/base64, 2 = binary with AAD */
  version: number;
  /** Base64-encoded 12-byte AES-GCM initialization vector — unique per file */
  iv: string;
  /** Preserved so the file can be restored to its original name after decryption */
  originalExtension: string;
}

/**
 * Transaction journal entry for crash recovery.
 * Written to data.json BEFORE a batch encrypt/decrypt starts, cleared AFTER it finishes.
 * If the app crashes mid-operation, the next startup detects the non-empty journal
 * and warns the user that files may be in a mixed (some encrypted, some plaintext) state.
 */
export interface PendingOperation {
  folderPath: string;
  operation: 'encrypt' | 'decrypt';
  files: string[];
  completedFiles: string[];
}

/** Returned by unlock/changePassword so callers can distinguish success from
 *  rate-limiting, wrong password, or decryption errors without try/catch. */
export interface UnlockResult {
  success: boolean;
  error?: string;
}
