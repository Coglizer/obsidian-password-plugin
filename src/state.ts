import { Notice, Vault } from 'obsidian';
import {
  FolderState,
  PluginSettings,
  ProtectedFolderConfig,
  PendingOperation,
} from './types';
import {
  deriveKey,
  hashKey,
  base64ToSalt,
  encryptFolder,
  decryptFolder,
} from './crypto';

export class StateManager {
  private states: Map<string, FolderState> = new Map();
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Check for pending operations from a crash
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

  async unlock(path: string, password: string): Promise<boolean> {
    const config = this.getConfig(path);
    if (!config) return false;

    const salt = base64ToSalt(config.salt);
    const key = await deriveKey(password, salt, this.settings.pbkdf2Iterations);
    const keyHash = await hashKey(key);

    if (keyHash !== config.passwordHash) {
      return false;
    }

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
        return false;
      }

      await this.clearPendingOps();
    }

    this.states.set(path, { path, isUnlocked: true, derivedKey: key });
    this.resetAutoLockTimer();
    return true;
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
    newPassword: string,
    iterations: number
  ): Promise<boolean> {
    const config = this.getConfig(path);
    if (!config) return false;

    const oldSalt = base64ToSalt(config.salt);
    const oldKey = await deriveKey(oldPassword, oldSalt, iterations);
    const oldHash = await hashKey(oldKey);
    if (oldHash !== config.passwordHash) return false;

    const { generateSalt, saltToBase64 } = await import('./crypto');
    const newSalt = generateSalt();
    const newKey = await deriveKey(newPassword, newSalt, iterations);
    const newHash = await hashKey(newKey);

    const state = this.states.get(path);
    if (config.mode === 'encrypt' && state?.isUnlocked && state.derivedKey) {
      await encryptFolder(this.vault, path, newKey);
      await decryptFolder(this.vault, path, newKey);
    }

    config.salt = saltToBase64(newSalt);
    config.passwordHash = newHash;

    if (state) {
      state.derivedKey = newKey;
    }

    return true;
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
