import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type PasswordProtectedFoldersPlugin from '../main';
import { ChangePasswordModal, UnlockModal } from './PasswordModal';

export class SettingsTab extends PluginSettingTab {
  plugin: PasswordProtectedFoldersPlugin;

  constructor(app: App, plugin: PasswordProtectedFoldersPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Password Protected Folders' });

    new Setting(containerEl)
      .setName('PBKDF2 iterations')
      .setDesc('Higher values are more secure but slower. Minimum enforced: 100,000.')
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.pbkdf2Iterations))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              if (num < 100000) {
                text.inputEl.style.borderColor = 'var(--text-error)';
              } else {
                text.inputEl.style.borderColor = '';
              }
              this.plugin.settings.pbkdf2Iterations = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Auto-lock timeout')
      .setDesc('Automatically lock all folders after inactivity.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('0', 'Disabled')
          .addOption('5', '5 minutes')
          .addOption('15', '15 minutes')
          .addOption('30', '30 minutes')
          .addOption('60', '1 hour')
          .setValue(String(this.plugin.settings.autoLockMinutes))
          .onChange(async (value) => {
            this.plugin.settings.autoLockMinutes = parseInt(value);
            await this.plugin.saveSettings();
            this.plugin.stateManager.resetAutoLockTimer();
          });
      });

    new Setting(containerEl)
      .setName('Lock on close')
      .setDesc('Lock all folders when Obsidian closes.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.lockOnClose)
          .onChange(async (value) => {
            this.plugin.settings.lockOnClose = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl('h3', { text: 'Protected Folders' });

    if (this.plugin.settings.protectedFolders.length === 0) {
      containerEl.createEl('p', {
        text: 'No protected folders. Right-click a folder to protect it.',
        cls: 'setting-item-description',
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: 'password-plugin-folder-list' });

    for (const config of this.plugin.settings.protectedFolders) {
      const isUnlocked = this.plugin.stateManager.isUnlocked(config.path);

      const itemEl = listEl.createDiv({ cls: 'folder-item' });
      const infoEl = itemEl.createDiv();
      infoEl.createSpan({ text: config.path, cls: 'folder-path' });
      infoEl.createSpan({
        text: ` (${config.mode}, ${config.visibility}${isUnlocked ? ' - unlocked' : ''})`,
        cls: 'folder-mode',
      });

      const actionsEl = itemEl.createDiv({ cls: 'folder-actions' });

      if (isUnlocked) {
        const lockBtn = actionsEl.createEl('button', { text: 'Lock' });
        lockBtn.addEventListener('click', async () => {
          await this.plugin.lockFolder(config.path);
          this.display();
        });
      } else {
        const unlockBtn = actionsEl.createEl('button', { text: 'Unlock' });
        unlockBtn.addEventListener('click', () => {
          new UnlockModal(this.app, config.path, async (password) => {
            const result = await this.plugin.unlockFolder(config.path, password);
            if (result.success) {
              new Notice(`Folder "${config.path}" unlocked.`);
              this.display();
            } else {
              new Notice(result.error ?? 'Wrong password.');
            }
          }).open();
        });
      }

      const changePwBtn = actionsEl.createEl('button', { text: 'Change Password' });
      changePwBtn.addEventListener('click', () => {
        new ChangePasswordModal(
          this.app,
          config.path,
          async (currentPw, newPw) => {
            const result = await this.plugin.stateManager.changePassword(
              config.path,
              currentPw,
              newPw
            );
            if (result.success) {
              await this.plugin.saveSettings();
              new Notice('Password changed successfully.');
            } else {
              new Notice(result.error ?? 'Current password is incorrect.');
            }
          }
        ).open();
      });

      const removeBtn = actionsEl.createEl('button', { text: 'Remove' });
      removeBtn.addEventListener('click', async () => {
        await this.plugin.stateManager.removeProtection(config.path);
        this.plugin.folderHider.unlockFolder(config.path);
        await this.plugin.saveSettings();
        new Notice(`Protection removed from "${config.path}".`);
        this.display();
      });
    }
  }
}
