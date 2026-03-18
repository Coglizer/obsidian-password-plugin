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

interface RateLimitInfo {
  count: number;
  lockedUntil: number;
}

export class StateManager {
  private states: Map<string, FolderState> = new Map();
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private failedAttempts: Map<string, RateLimitInfo> = new Map();

  constructor(
    private vault: Vault,
    private settings: PluginSettings,
    private persistSettings: () => Promise<void>
  ) {}

  async initialize(): Promise<void> {
    for (const config of this.settings.protectedFolders) {
      this.states.set(config.path, {
        path: config.path,
        isUnlocked: false,
        derivedKey: null,
      });
    }

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

  async unlock(path: string, password: string): Promise<UnlockResult> {
    // Check rate limit
    const rateLimitMsg = this.checkRateLimit(path);
    if (rateLimitMsg) {
      return { success: false, error: rateLimitMsg };
    }

    const config = this.getConfig(path);
    if (!config) return { success: false, error: 'Folder not found.' };

    // Use per-folder iterations (fall back to global for legacy configs)
    const iterations = config.iterations ?? this.settings.pbkdf2Iterations;
    const salt = base64ToBytes(config.salt);
    const { key, hash: keyHash } = await deriveKeyAndHash(password, salt, iterations);

    if (!constantTimeEqual(keyHash, config.passwordHash)) {
      this.recordFailedAttempt(path);
      return { success: false, error: 'Wrong password.' };
    }

    this.clearFailedAttempts(path);

    if (config.mode === 'encrypt') {
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

    this.states.set(path, { path, isUnlocked: true, derivedKey: key });
    this.resetAutoLockTimer();
    return { success: true };
  }

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

  async changePassword(
    path: string,
    oldPassword: string,
    newPassword: string
  ): Promise<UnlockResult> {
    // Check rate limit
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

    // Generate new credentials with current global iterations setting
    const { generateSalt, saltToBase64 } = await import('./crypto');
    const newSalt = generateSalt();
    const newIterations = Math.max(this.settings.pbkdf2Iterations, MIN_ITERATIONS);
    const { key: newKey, hash: newHash } = await deriveKeyAndHash(
      newPassword,
      newSalt,
      newIterations
    );

    const state = this.states.get(path);
    if (config.mode === 'encrypt' && state?.isUnlocked && state.derivedKey) {
      await encryptFolder(this.vault, path, newKey);
      await decryptFolder(this.vault, path, newKey);
    }

    config.salt = saltToBase64(newSalt);
    config.passwordHash = newHash;
    config.iterations = newIterations;

    if (state) {
      state.derivedKey = newKey;
    }

    return { success: true };
  }

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

  removeFolderConfig(path: string): void {
    this.settings.protectedFolders = this.settings.protectedFolders.filter(
      (f) => f.path !== path
    );
    this.states.delete(path);
  }

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
