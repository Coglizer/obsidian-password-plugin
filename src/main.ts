import {
  Plugin,
  Notice,
  TFolder,
  TFile,
  Platform,
} from 'obsidian';
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  ProtectedFolderConfig,
  UnlockResult,
} from './types';
import { StateManager } from './state';
import { FolderHider } from './explorer/FolderHider';
import {
  generateSalt,
  saltToBase64,
  deriveKeyAndHash,
  encryptFolder,
  MIN_ITERATIONS,
} from './crypto';
import { SetPasswordModal, UnlockModal } from './ui/PasswordModal';
import { SettingsTab } from './ui/SettingsTab';
import { registerContextMenu } from './ui/ContextMenu';

export default class PasswordProtectedFoldersPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  stateManager!: StateManager;
  folderHider: FolderHider = new FolderHider();

  async onload(): Promise<void> {
    // Verify crypto API is available (required for all functionality)
    if (!crypto?.subtle) {
      new Notice(
        'Password Protected Folders: Web Crypto API is not available. Plugin cannot function.',
        10000
      );
      return;
    }

    await this.loadSettings();

    this.stateManager = new StateManager(
      this.app.vault,
      this.settings,
      () => this.saveSettings()
    );

    await this.stateManager.initialize();

    this.app.workspace.onLayoutReady(() => {
      this.initExplorer();
    });

    registerContextMenu(this);
    this.addSettingTab(new SettingsTab(this.app, this));

    this.addCommand({
      id: 'lock-all-folders',
      name: 'Lock all protected folders',
      callback: async () => {
        await this.lockAllFolders();
      },
    });

    this.addCommand({
      id: 'unlock-folder',
      name: 'Unlock a protected folder',
      callback: () => {
        const locked = this.stateManager
          .getAllProtectedPaths()
          .filter((p) => !this.stateManager.isUnlocked(p));
        if (locked.length === 0) {
          new Notice('No locked folders.');
          return;
        }
        if (locked.length === 1) {
          this.promptUnlock(locked[0]);
        } else {
          new Notice(
            `${locked.length} locked folders. Use the settings tab or right-click to unlock specific folders.`
          );
        }
      },
    });

    this.addRibbonIcon('lock', 'Lock all folders', async () => {
      await this.lockAllFolders();
      new Notice('All folders locked.');
    });

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file) return;
        this.interceptFileOpen(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFolder) {
          if (this.stateManager.isProtected(oldPath)) {
            const config = this.stateManager.getConfig(oldPath);
            this.stateManager.updateFolderPath(oldPath, file.path);
            this.folderHider.unlockFolder(oldPath);
            if (!this.stateManager.isUnlocked(file.path)) {
              this.folderHider.lockFolder(file.path, config?.visibility ?? 'visible');
            }
            this.saveSettings();
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFolder && this.stateManager.isProtected(file.path)) {
          this.stateManager.removeFolderConfig(file.path);
          this.folderHider.unlockFolder(file.path);
          this.saveSettings();
        }
      })
    );

    this.registerDomEvent(document, 'click', () => {
      this.stateManager.resetAutoLockTimer();
    });
    this.registerDomEvent(document, 'keydown', () => {
      this.stateManager.resetAutoLockTimer();
    });

    // Mobile: reset auto-lock on touch and lock when app goes to background
    if (Platform.isMobile) {
      this.registerDomEvent(document, 'touchstart', () => {
        this.stateManager.resetAutoLockTimer();
      });

      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden' && this.settings.lockOnClose) {
          this.lockAllFolders();
        }
      });
    }
  }

  onunload(): void {
    this.stateManager.clearAutoLockTimer();
    this.folderHider.stop();

    if (this.settings.lockOnClose) {
      const unlocked = this.stateManager.getAllUnlockedPaths();
      for (const path of unlocked) {
        this.stateManager.lock(path);
      }
    }
  }

  private initExplorer(): void {
    this.folderHider.setUnlockCallback((path) => {
      this.promptUnlock(path);
    });

    const explorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (explorerLeaf?.view?.containerEl) {
      this.folderHider.start(explorerLeaf.view.containerEl);
    }

    for (const path of this.stateManager.getAllProtectedPaths()) {
      if (!this.stateManager.isUnlocked(path)) {
        const config = this.stateManager.getConfig(path);
        this.folderHider.lockFolder(path, config?.visibility ?? 'visible');
      }
    }
  }

  private interceptFileOpen(file: TFile): void {
    for (const path of this.stateManager.getAllProtectedPaths()) {
      if (file.path.startsWith(path + '/') && !this.stateManager.isUnlocked(path)) {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf) {
          activeLeaf.detach();
        }
        new Notice(`"${path}" is locked. Unlock it first.`);
        this.promptUnlock(path);
        return;
      }
    }
  }

  async protectFolder(folderPath: string): Promise<void> {
    const allProtected = this.stateManager.getAllProtectedPaths();
    for (const pp of allProtected) {
      if (folderPath.startsWith(pp + '/')) {
        new Notice(`Cannot protect: "${folderPath}" is inside protected folder "${pp}".`);
        return;
      }
      if (pp.startsWith(folderPath + '/')) {
        new Notice(`Cannot protect: "${folderPath}" contains protected folder "${pp}".`);
        return;
      }
    }

    new SetPasswordModal(this.app, folderPath, async (result) => {
      const salt = generateSalt();
      const iterations = Math.max(this.settings.pbkdf2Iterations, MIN_ITERATIONS);
      const { key, hash: keyHash } = await deriveKeyAndHash(
        result.password,
        salt,
        iterations
      );

      const config: ProtectedFolderConfig = {
        path: folderPath,
        salt: saltToBase64(salt),
        passwordHash: keyHash,
        mode: result.mode,
        visibility: result.visibility,
        iterations,
        createdAt: Date.now(),
      };

      await this.stateManager.addProtectedFolder(config);

      if (result.mode === 'encrypt') {
        const files = this.app.vault
          .getFiles()
          .filter((f) => f.path.startsWith(folderPath + '/'));
        if (files.length > 0) {
          new Notice(`Encrypting ${files.length} files...`);
          await encryptFolder(this.app.vault, folderPath, key, (current, total) => {
            if (total > 10 && current % 10 === 0) {
              new Notice(`Encrypting: ${current}/${total}`);
            }
          });
        }
      }

      this.folderHider.lockFolder(folderPath, result.visibility);
      await this.saveSettings();
      new Notice(`Folder "${folderPath}" is now protected (${result.mode} mode).`);
    }).open();
  }

  promptUnlock(folderPath: string): void {
    const modal = new UnlockModal(this.app, folderPath, async (password) => {
      const result = await this.unlockFolder(folderPath, password);
      if (result.success) {
        modal.close();
        new Notice(`Folder "${folderPath}" unlocked.`);
      } else {
        modal.showError(result.error ?? 'Wrong password.');
      }
    });
    modal.open();
  }

  async unlockFolder(folderPath: string, password: string): Promise<UnlockResult> {
    const result = await this.stateManager.unlock(folderPath, password);
    if (result.success) {
      this.folderHider.unlockFolder(folderPath);
    }
    return result;
  }

  async lockFolder(folderPath: string): Promise<void> {
    await this.stateManager.lock(folderPath);
    const config = this.stateManager.getConfig(folderPath);
    this.folderHider.lockFolder(folderPath, config?.visibility ?? 'visible');
    new Notice(`Folder "${folderPath}" locked.`);
  }

  async lockAllFolders(): Promise<void> {
    const unlocked = this.stateManager.getAllUnlockedPaths();
    for (const path of unlocked) {
      await this.stateManager.lock(path);
      const config = this.stateManager.getConfig(path);
      this.folderHider.lockFolder(path, config?.visibility ?? 'visible');
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!Array.isArray(this.settings.protectedFolders)) {
      this.settings.protectedFolders = [];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
