import {
  Plugin,
  Notice,
  TFolder,
  TFile,
} from 'obsidian';
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  ProtectedFolderConfig,
} from './types';
import { StateManager } from './state';
import { FolderHider } from './explorer/FolderHider';
import {
  generateSalt,
  saltToBase64,
  deriveKey,
  hashKey,
  encryptFolder,
} from './crypto';
import { SetPasswordModal, UnlockModal } from './ui/PasswordModal';
import { SettingsTab } from './ui/SettingsTab';
import { registerContextMenu } from './ui/ContextMenu';

export default class PasswordProtectedFoldersPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  stateManager!: StateManager;
  folderHider: FolderHider = new FolderHider();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.stateManager = new StateManager(
      this.app.vault,
      this.settings,
      () => this.saveSettings()
    );

    await this.stateManager.initialize();

    // Wait for layout to be ready before manipulating DOM
    this.app.workspace.onLayoutReady(() => {
      this.initExplorer();
    });

    // Register context menu
    registerContextMenu(this);

    // Register settings tab
    this.addSettingTab(new SettingsTab(this.app, this));

    // Register lock-all command
    this.addCommand({
      id: 'lock-all-folders',
      name: 'Lock all protected folders',
      callback: async () => {
        await this.lockAllFolders();
      },
    });

    // Register unlock command (opens a chooser)
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
        // For simplicity, prompt for the first locked folder
        // A more elaborate UI could use a suggester
        if (locked.length === 1) {
          this.promptUnlock(locked[0]);
        } else {
          new Notice(
            `${locked.length} locked folders. Use the settings tab or right-click to unlock specific folders.`
          );
        }
      },
    });

    // Ribbon icon
    this.addRibbonIcon('lock', 'Lock all folders', async () => {
      await this.lockAllFolders();
      new Notice('All folders locked.');
    });

    // Intercept file open for locked folders
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file) return;
        this.interceptFileOpen(file);
      })
    );

    // Track folder renames
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

    // Track folder deletes
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFolder && this.stateManager.isProtected(file.path)) {
          this.stateManager.removeFolderConfig(file.path);
          this.folderHider.unlockFolder(file.path);
          this.saveSettings();
        }
      })
    );

    // Auto-lock timer: reset on user activity
    this.registerDomEvent(document, 'click', () => {
      this.stateManager.resetAutoLockTimer();
    });
    this.registerDomEvent(document, 'keydown', () => {
      this.stateManager.resetAutoLockTimer();
    });
  }

  onunload(): void {
    // Stop observer and clean up DOM first (synchronous)
    this.stateManager.clearAutoLockTimer();
    this.folderHider.stop();

    // Encrypt unlocked folders best-effort
    // Obsidian doesn't await onunload, so this may not complete on quit.
    // The lockOnClose + encrypt workflow is inherently limited by this.
    if (this.settings.lockOnClose) {
      const unlocked = this.stateManager.getAllUnlockedPaths();
      for (const path of unlocked) {
        this.stateManager.lock(path);
      }
    }
  }

  private initExplorer(): void {
    // Set up the unlock callback for lock icon clicks
    this.folderHider.setUnlockCallback((path) => {
      this.promptUnlock(path);
    });

    // Find the file explorer container
    const explorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (explorerLeaf?.view?.containerEl) {
      this.folderHider.start(explorerLeaf.view.containerEl);
    }

    // Apply lock state to all protected folders
    for (const path of this.stateManager.getAllProtectedPaths()) {
      if (!this.stateManager.isUnlocked(path)) {
        const config = this.stateManager.getConfig(path);
        this.folderHider.lockFolder(path, config?.visibility ?? 'visible');
      }
    }
  }

  private interceptFileOpen(file: TFile): void {
    // Check if this file belongs to a locked protected folder
    for (const path of this.stateManager.getAllProtectedPaths()) {
      if (file.path.startsWith(path + '/') && !this.stateManager.isUnlocked(path)) {
        // Close the active leaf that just opened this file
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
    // Check nesting
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
      const key = await deriveKey(
        result.password,
        salt,
        this.settings.pbkdf2Iterations
      );
      const keyHash = await hashKey(key);

      const config: ProtectedFolderConfig = {
        path: folderPath,
        salt: saltToBase64(salt),
        passwordHash: keyHash,
        mode: result.mode,
        visibility: result.visibility,
        createdAt: Date.now(),
      };

      await this.stateManager.addProtectedFolder(config);

      // If encrypt mode, encrypt files now
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

      // Lock the folder in the explorer
      this.folderHider.lockFolder(folderPath, result.visibility);
      await this.saveSettings();
      new Notice(`Folder "${folderPath}" is now protected (${result.mode} mode).`);
    }).open();
  }

  promptUnlock(folderPath: string): void {
    const modal = new UnlockModal(this.app, folderPath, async (password) => {
      const success = await this.unlockFolder(folderPath, password);
      if (success) {
        modal.close();
        new Notice(`Folder "${folderPath}" unlocked.`);
      } else {
        modal.showError('Wrong password. Try again.');
      }
    });
    modal.open();
  }

  async unlockFolder(folderPath: string, password: string): Promise<boolean> {
    const success = await this.stateManager.unlock(folderPath, password);
    if (success) {
      this.folderHider.unlockFolder(folderPath);
    }
    return success;
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
    // Ensure protectedFolders is always an array
    if (!Array.isArray(this.settings.protectedFolders)) {
      this.settings.protectedFolders = [];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
