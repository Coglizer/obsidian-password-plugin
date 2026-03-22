/**
 * State manager — the central authority for folder lock/unlock lifecycle.
 *
 * Responsibilities:
 *   - Maintains in-memory FolderState (locked/unlocked + CryptoKey) for each protected folder
 *   - Orchestrates encrypt/decrypt operations during lock/unlock transitions
 *   - Implements brute-force rate limiting with exponential backoff
 *   - Manages crash-recovery journal (pendingOperations) for interrupted encrypt/decrypt
 *   - Drives the auto-lock inactivity timer
 *
 * Important: this class mutates `settings` directly (it holds a reference, not a copy).
 * `persistSettings()` must be called to flush changes to disk via Obsidian's saveData.
 */
import { Notice, Vault } from 'obsidian';
import {
  FolderState,
  PluginSettings,
  ProtectedFolderConfig,
  PendingOperation,
  UnlockResult,
} from './types';
import {
  deriveKeyAndHash,
  constantTimeEqual,
  base64ToBytes,
  encryptFolder,
  decryptFolder,
  MIN_ITERATIONS,
} from './crypto';

/** In-memory only — tracks failed unlock attempts per folder for rate limiting */
interface RateLimitInfo {
  count: number;
  /** Timestamp (ms) until which further attempts are rejected */
  lockedUntil: number;
}

export class StateManager {
  /** Runtime state per folder — never persisted; all folders start locked on load */
  private states: Map<string, FolderState> = new Map();
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** Brute-force tracking — in-memory only, resets on plugin reload (intentional:
   *  persisting would let an attacker lock out a legitimate user permanently) */
  private failedAttempts: Map<string, RateLimitInfo> = new Map();

  constructor(
    private vault: Vault,
    /** Direct reference to the live settings object — mutations here are reflected in plugin.settings */
    private settings: PluginSettings,
    /** Callback that calls plugin.saveData(settings) to flush to disk */
    private persistSettings: () => Promise<void>
  ) {}

  /** Called once during plugin onload — sets up initial locked state and checks for crash recovery */
  async initialize(): Promise<void> {
    // All folders start locked — keys only exist in memory after successful unlock
    for (const config of this.settings.protectedFolders) {
      this.states.set(config.path, {
        path: config.path,
        isUnlocked: false,
        derivedKey: null,
      });
    }

    // Crash recovery: if pendingOperations is non-empty, the app was killed mid encrypt/decrypt.
    // We can't automatically fix this (we don't have the password), so warn the user
    // that some files may be encrypted while others are plaintext within the folder.
    if (
      this.settings.pendingOperations &&
      this.settings.pendingOperations.length > 0
    ) {
      for (const op of this.settings.pendingOperations) {
        new Notice(
          `Folder "${op.folderPath}" may have files in mixed state from interrupted ${op.operation}. Please unlock to recover.`
        );
      }
      this.settings.pendingOperations = [];
      await this.persistSettings();
    }
  }

  private async savePendingOps(ops: PendingOperation[]): Promise<void> {
    this.settings.pendingOperations = ops;
    await this.persistSettings();
  }

  private async clearPendingOps(): Promise<void> {
    this.settings.pendingOperations = [];
    await this.persistSettings();
  }

  // --- Rate limiting ---
  // Exponential backoff: 3 fails → 1s, 5 → 5s, 10 → 30s, 20 → 5min.
  // Slows brute-force attacks while keeping legitimate "typo" attempts responsive.

  private checkRateLimit(path: string): string | null {
    const info = this.failedAttempts.get(path);
    if (!info) return null;
    if (info.lockedUntil > Date.now()) {
      const seconds = Math.ceil((info.lockedUntil - Date.now()) / 1000);
      return `Too many failed attempts. Try again in ${seconds}s.`;
    }
    return null;
  }

  private recordFailedAttempt(path: string): void {
    const info = this.failedAttempts.get(path) ?? { count: 0, lockedUntil: 0 };
    info.count++;
    if (info.count >= 20) {
      info.lockedUntil = Date.now() + 300000; // 5 minutes
    } else if (info.count >= 10) {
      info.lockedUntil = Date.now() + 30000; // 30s
    } else if (info.count >= 5) {
      info.lockedUntil = Date.now() + 5000; // 5s
    } else if (info.count >= 3) {
      info.lockedUntil = Date.now() + 1000; // 1s
    }
    this.failedAttempts.set(path, info);
  }

  private clearFailedAttempts(path: string): void {
    this.failedAttempts.delete(path);
  }

  // --- State queries ---

  getState(path: string): FolderState | undefined {
    return this.states.get(path);
  }

  isUnlocked(path: string): boolean {
    return this.states.get(path)?.isUnlocked ?? false;
  }

  isProtected(path: string): boolean {
    return this.states.has(path);
  }

  getConfig(path: string): ProtectedFolderConfig | undefined {
    return this.settings.protectedFolders.find((f) => f.path === path);
  }

  getAllProtectedPaths(): string[] {
    return Array.from(this.states.keys());
  }

  getAllUnlockedPaths(): string[] {
    return Array.from(this.states.entries())
      .filter(([, s]) => s.isUnlocked)
      .map(([p]) => p);
  }

  // --- Unlock / Lock ---

  /**
   * Unlock flow:
   *   1. Check rate limit → reject if too many recent failures
   *   2. Derive key from password using folder's salt + iterations
   *   3. Compare derived hash to stored hash (constant-time)
   *   4. If encrypt mode: write pending op journal → decrypt all .enc files → clear journal
   *   5. Store CryptoKey in memory, mark folder unlocked
   */
  async unlock(path: string, password: string): Promise<UnlockResult> {
    const rateLimitMsg = this.checkRateLimit(path);
    if (rateLimitMsg) {
      return { success: false, error: rateLimitMsg };
    }

    const config = this.getConfig(path);
    if (!config) return { success: false, error: 'Folder not found.' };

    // Per-folder iterations ensure that changing the global setting doesn't break
    // existing folders — they always use the iteration count from when they were created
    const iterations = config.iterations ?? this.settings.pbkdf2Iterations;
    const salt = base64ToBytes(config.salt);
    const { key, hash: keyHash } = await deriveKeyAndHash(password, salt, iterations);

    if (!constantTimeEqual(keyHash, config.passwordHash)) {
      this.recordFailedAttempt(path);
      return { success: false, error: 'Wrong password.' };
    }

    this.clearFailedAttempts(path);

    if (config.mode === 'encrypt') {
      // Journal the pending operation BEFORE starting — if we crash mid-decrypt,
      // the next startup will find this and warn the user
      const op: PendingOperation = {
        folderPath: path,
        operation: 'decrypt',
        files: [],
        completedFiles: [],
      };
      await this.savePendingOps([op]);

      try {
        const total = this.vault.getFiles().filter(
          (f) => f.path.startsWith(path + '/') && f.path.endsWith('.enc')
        ).length;

        if (total > 10) {
          new Notice(`Decrypting ${total} files...`);
        }

        await decryptFolder(this.vault, path, key, (current, t) => {
          if (t > 10 && current % 10 === 0) {
            new Notice(`Decrypting: ${current}/${t}`);
          }
        });
      } catch (e) {
        new Notice(`Error decrypting folder: ${e}`);
        await this.clearPendingOps();
        return { success: false, error: `Decryption failed: ${e}` };
      }

      await this.clearPendingOps();
    }

    // Key is held in memory for re-encryption on lock; cleared when locked
    this.states.set(path, { path, isUnlocked: true, derivedKey: key });
    this.resetAutoLockTimer();
    return { success: true };
  }

  /**
   * Lock flow:
   *   1. If encrypt mode: journal pending op → encrypt all plaintext files → clear journal
   *   2. Clear CryptoKey from memory (derivedKey: null), mark folder locked
   *
   * Note: for 'hide' mode, no disk I/O is needed — just clear state and let
   * FolderHider handle the DOM visibility.
   */
  async lock(path: string): Promise<void> {
    const config = this.getConfig(path);
    const state = this.states.get(path);
    if (!config || !state || !state.isUnlocked) return;

    if (config.mode === 'encrypt' && state.derivedKey) {
      const op: PendingOperation = {
        folderPath: path,
        operation: 'encrypt',
        files: [],
        completedFiles: [],
      };
      await this.savePendingOps([op]);

      try {
        const total = this.vault.getFiles().filter(
          (f) => f.path.startsWith(path + '/') && !f.path.endsWith('.enc')
        ).length;

        if (total > 10) {
          new Notice(`Encrypting ${total} files...`);
        }

        await encryptFolder(this.vault, path, state.derivedKey, (current, t) => {
          if (t > 10 && current % 10 === 0) {
            new Notice(`Encrypting: ${current}/${t}`);
          }
        });
      } catch (e) {
        new Notice(`Error encrypting folder: ${e}`);
      }

      await this.clearPendingOps();
    }

    // Wipe the CryptoKey reference — JS GC will eventually collect it,
    // and the non-extractable flag prevents reading it before that happens
    this.states.set(path, { path, isUnlocked: false, derivedKey: null });
  }

  async lockAll(): Promise<void> {
    const unlocked = this.getAllUnlockedPaths();
    for (const path of unlocked) {
      await this.lock(path);
    }
  }

  async addProtectedFolder(config: ProtectedFolderConfig): Promise<void> {
    this.settings.protectedFolders.push(config);
    this.states.set(config.path, {
      path: config.path,
      isUnlocked: false,
      derivedKey: null,
    });
  }

  /**
   * Remove password protection from a folder.
   * For 'encrypt' mode, the folder must be unlocked first so files are in plaintext —
   * otherwise removing the config would orphan .enc files with no way to decrypt them.
   * For 'hide' mode, removal is always safe since files were never encrypted.
   */
  async removeProtection(path: string): Promise<void> {
    const state = this.states.get(path);
    if (!state?.isUnlocked) {
      const config = this.getConfig(path);
      if (config?.mode === 'encrypt') {
        new Notice('Unlock the folder first before removing protection.');
        return;
      }
    }

    this.settings.protectedFolders = this.settings.protectedFolders.filter(
      (f) => f.path !== path
    );
    this.states.delete(path);
  }

  /**
   * Change a folder's password.
   *   1. Verify old password (with rate limiting)
   *   2. Derive new key from new password + fresh salt + current global iterations
   *   3. If folder is unlocked in encrypt mode: re-encrypt files with the new key
   *      then decrypt them back so the folder remains usable (files stay plaintext while unlocked)
   *   4. Update config with new salt, hash, and iteration count
   *
   * Uses dynamic import for generateSalt/saltToBase64 to avoid circular dependency issues.
   */
  async changePassword(
    path: string,
    oldPassword: string,
    newPassword: string
  ): Promise<UnlockResult> {
    const rateLimitMsg = this.checkRateLimit(path);
    if (rateLimitMsg) {
      return { success: false, error: rateLimitMsg };
    }

    const config = this.getConfig(path);
    if (!config) return { success: false, error: 'Folder not found.' };

    const iterations = config.iterations ?? this.settings.pbkdf2Iterations;
    const oldSalt = base64ToBytes(config.salt);
    const { hash: oldHash } = await deriveKeyAndHash(oldPassword, oldSalt, iterations);

    if (!constantTimeEqual(oldHash, config.passwordHash)) {
      this.recordFailedAttempt(path);
      return { success: false, error: 'Current password is incorrect.' };
    }

    this.clearFailedAttempts(path);

    // Fresh salt + potentially higher iterations for the new password
    const { generateSalt, saltToBase64 } = await import('./crypto');
    const newSalt = generateSalt();
    const newIterations = Math.max(this.settings.pbkdf2Iterations, MIN_ITERATIONS);
    const { key: newKey, hash: newHash } = await deriveKeyAndHash(
      newPassword,
      newSalt,
      newIterations
    );

    // If the folder is currently unlocked and uses encryption, we need to re-encrypt
    // with the new key so the next lock uses the correct key material.
    // Encrypt-then-decrypt: encrypt writes .enc files with the new key,
    // then decrypt restores them to plaintext (folder stays usable while unlocked).
    const state = this.states.get(path);
    if (config.mode === 'encrypt' && state?.isUnlocked && state.derivedKey) {
      await encryptFolder(this.vault, path, newKey);
      await decryptFolder(this.vault, path, newKey);
    }

    // Update persisted config — caller must call persistSettings() to flush to disk
    config.salt = saltToBase64(newSalt);
    config.passwordHash = newHash;
    config.iterations = newIterations;

    // Update in-memory key so next lock() uses the new key for encryption
    if (state) {
      state.derivedKey = newKey;
    }

    return { success: true };
  }

  /** Called when a folder is renamed in the vault — updates both runtime state and persisted config */
  updateFolderPath(oldPath: string, newPath: string): void {
    const state = this.states.get(oldPath);
    if (state) {
      state.path = newPath;
      this.states.delete(oldPath);
      this.states.set(newPath, state);
    }

    const config = this.getConfig(oldPath);
    if (config) {
      config.path = newPath;
    }
  }

  /** Called when a protected folder is deleted from the vault — removes all traces of it */
  removeFolderConfig(path: string): void {
    this.settings.protectedFolders = this.settings.protectedFolders.filter(
      (f) => f.path !== path
    );
    this.states.delete(path);
  }

  /** Restart the inactivity timer — called on every click/keydown/touch event */
  resetAutoLockTimer(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    if (this.settings.autoLockMinutes > 0) {
      this.autoLockTimer = setTimeout(
        () => this.lockAll(),
        this.settings.autoLockMinutes * 60 * 1000
      );
    }
  }

  clearAutoLockTimer(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
  }
}
