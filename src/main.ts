/**
 * Plugin entry point — wires together all subsystems:
 *   - StateManager:  lock/unlock lifecycle, key management, encryption
 *   - FolderHider:   DOM manipulation to hide/show folders in the file explorer
 *   - UI components: modals, settings tab, context menus, commands, ribbon icon
 *
 * Key design decisions:
 *   - All folders start locked on plugin load (safe default)
 *   - CryptoKeys only exist in memory while a folder is unlocked
 *   - onunload() is synchronous (Obsidian doesn't await it), so encryption
 *     on close is best-effort for 'encrypt' mode folders
 */
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
    // Gate: the entire plugin depends on Web Crypto for PBKDF2 + AES-GCM.
    // This check catches extremely old Electron/WebView versions.
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

    // onLayoutReady ensures the file explorer DOM exists before we try to attach
    // our MutationObserver and apply initial folder visibility
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

    // Intercept file opens to prevent viewing files inside locked folders.
    // This catches cases like clicking a link or using quick-open to navigate
    // directly to a file within a locked folder (bypassing the explorer hiding).
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file) return;
        this.interceptFileOpen(file);
      })
    );

    // Keep folder protection in sync when the user renames a protected folder.
    // Without this, renaming would orphan the config (pointing at the old path).
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

    // Clean up config when a protected folder is deleted from the vault
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFolder && this.stateManager.isProtected(file.path)) {
          this.stateManager.removeFolderConfig(file.path);
          this.folderHider.unlockFolder(file.path);
          this.saveSettings();
        }
      })
    );

    // Reset the auto-lock inactivity timer on any user interaction.
    // This ensures the timer only fires after true inactivity, not while
    // the user is actively working in Obsidian.
    this.registerDomEvent(document, 'click', () => {
      this.stateManager.resetAutoLockTimer();
    });
    this.registerDomEvent(document, 'keydown', () => {
      this.stateManager.resetAutoLockTimer();
    });

    // Mobile-specific lifecycle handling
    if (Platform.isMobile) {
      // Touch events don't always produce 'click' on mobile, so also listen for touch
      this.registerDomEvent(document, 'touchstart', () => {
        this.stateManager.resetAutoLockTimer();
      });

      // Mobile apps get suspended (not closed) when backgrounded. visibilitychange
      // is the only reliable signal we get before the OS freezes the process.
      // We lock on BOTH transitions:
      //   hidden  → best-effort lock before OS suspends (may not finish)
      //   visible → catch-up lock on resume, in case the background lock was interrupted
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (this.settings.lockOnClose) {
          if (document.visibilityState === 'hidden') {
            this.lockAllFolders();
          } else if (document.visibilityState === 'visible') {
            this.lockAllFolders();
          }
        }
      });
    }
  }

  /**
   * Called when the plugin is disabled or Obsidian closes.
   * IMPORTANT: Obsidian does NOT await this method — it must be synchronous.
   * For 'encrypt' mode, lock() is async (performs file I/O), so these calls
   * are fire-and-forget. The encryption may not complete before the process exits.
   * This is a known limitation; the mobile visibilitychange handler provides
   * a second chance to lock on mobile.
   */
  onunload(): void {
    this.stateManager.clearAutoLockTimer();
    this.folderHider.stop();

    if (this.settings.lockOnClose) {
      const unlocked = this.stateManager.getAllUnlockedPaths();
      for (const path of unlocked) {
        // Fire-and-forget — promises are not awaited (onunload is sync)
        this.stateManager.lock(path);
      }
    }
  }

  /** Wire up the FolderHider to the file explorer and apply initial locked state */
  private initExplorer(): void {
    // When the user clicks a lock icon, open the unlock modal for that folder
    this.folderHider.setUnlockCallback((path) => {
      this.promptUnlock(path);
    });

    // Attach MutationObserver to the file explorer's container element.
    // getLeavesOfType('file-explorer') returns the explorer sidebar pane.
    const explorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (explorerLeaf?.view?.containerEl) {
      this.folderHider.start(explorerLeaf.view.containerEl);
    }

    // Apply initial visibility for all protected folders (all start locked)
    for (const path of this.stateManager.getAllProtectedPaths()) {
      if (!this.stateManager.isUnlocked(path)) {
        const config = this.stateManager.getConfig(path);
        this.folderHider.lockFolder(path, config?.visibility ?? 'visible');
      }
    }
  }

  /**
   * Guard against direct file access within locked folders.
   * Files can be opened via links, quick-open, or API calls — not just the explorer.
   * If the file belongs to a locked folder, immediately close the tab and prompt unlock.
   */
  private interceptFileOpen(file: TFile): void {
    for (const path of this.stateManager.getAllProtectedPaths()) {
      if (file.path.startsWith(path + '/') && !this.stateManager.isUnlocked(path)) {
        // Detach the active leaf to close the file that was just opened
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

  /**
   * Set up password protection for a new folder.
   * Opens the SetPasswordModal, then on submit: derives key, creates config,
   * optionally encrypts existing files, and hides the folder.
   *
   * Nesting guard: prevents protecting a folder inside an already-protected folder
   * (or vice versa) to avoid ambiguous lock/unlock semantics.
   */
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

  /** Load settings from data.json, merging with defaults for any missing fields.
   *  The protectedFolders guard handles corrupted or first-time data gracefully. */
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
