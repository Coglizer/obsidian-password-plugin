/**
 * Password modals — three variants for different operations:
 *   SetPasswordModal:    Initial folder protection setup (password + mode + visibility)
 *   UnlockModal:         Single password prompt to unlock a locked folder
 *   ChangePasswordModal: Current + new password fields to change an existing password
 *
 * All modals clear sensitive fields (passwords) in onClose() to minimize
 * time that password strings linger in memory.
 */
import { App, Modal, Setting } from 'obsidian';

type ProtectionMode = 'encrypt' | 'hide';
type VisibilityMode = 'visible' | 'hidden';

export interface SetPasswordResult {
  password: string;
  mode: ProtectionMode;
  visibility: VisibilityMode;
}

export class SetPasswordModal extends Modal {
  private password = '';
  private confirm = '';
  private mode: ProtectionMode = 'encrypt';
  private visibility: VisibilityMode = 'visible';
  private onSubmit: (result: SetPasswordResult) => void;
  private folderPath: string;

  constructor(
    app: App,
    folderPath: string,
    onSubmit: (result: SetPasswordResult) => void
  ) {
    super(app);
    this.folderPath = folderPath;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('password-plugin-modal');
    contentEl.createEl('h2', { text: `Protect "${this.folderPath}"` });

    new Setting(contentEl)
      .setName('Password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.placeholder = 'Enter password';
        text.onChange((value) => (this.password = value));
      });

    new Setting(contentEl)
      .setName('Confirm password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.placeholder = 'Confirm password';
        text.onChange((value) => (this.confirm = value));
      });

    new Setting(contentEl)
      .setName('Protection mode')
      .setDesc('Encrypt: files encrypted on disk. Hide: files hidden in UI only.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('encrypt', 'Full Encryption (AES-256-GCM)')
          .addOption('hide', 'UI-Only Hiding')
          .setValue(this.mode)
          .onChange((value) => (this.mode = value as ProtectionMode));
      });

    new Setting(contentEl)
      .setName('When locked')
      .setDesc('Show folder with a lock icon, or hide it completely from the explorer.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('visible', 'Show with lock icon')
          .addOption('hidden', 'Hide completely')
          .setValue(this.visibility)
          .onChange((value) => (this.visibility = value as VisibilityMode));
      });

    const errorEl = contentEl.createDiv({ cls: 'error-message' });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText('Protect').setCta().onClick(() => {
        if (!this.password) {
          errorEl.setText('Password is required.');
          return;
        }
        if (this.password.length < 8) {
          errorEl.setText('Password must be at least 8 characters.');
          return;
        }
        if (this.password !== this.confirm) {
          errorEl.setText('Passwords do not match.');
          return;
        }
        this.onSubmit({
          password: this.password,
          mode: this.mode,
          visibility: this.visibility,
        });
        this.close();
      });
    });
  }

  onClose(): void {
    this.password = '';
    this.confirm = '';
    this.contentEl.empty();
  }
}

export class UnlockModal extends Modal {
  private password = '';
  private onSubmit: (password: string) => void;
  private folderPath: string;

  constructor(
    app: App,
    folderPath: string,
    onSubmit: (password: string) => void
  ) {
    super(app);
    this.folderPath = folderPath;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('password-plugin-modal');
    contentEl.createEl('h2', { text: `Unlock "${this.folderPath}"` });

    const errorEl = contentEl.createDiv({ cls: 'error-message' });

    new Setting(contentEl)
      .setName('Password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.placeholder = 'Enter password';
        text.onChange((value) => (this.password = value));
        // Allow Enter key to submit — common UX expectation for password fields
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            this.submit(errorEl);
          }
        });
        // Auto-focus after a short delay — Obsidian's modal animation needs
        // a frame to finish before focus will stick
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText('Unlock').setCta().onClick(() => {
        this.submit(errorEl);
      });
    });
  }

  private submit(errorEl: HTMLElement): void {
    if (!this.password) {
      errorEl.setText('Password is required.');
      return;
    }
    // Modal stays open after submit — the caller decides whether to close (success)
    // or call showError() (wrong password). This avoids a flash-close-reopen cycle.
    this.onSubmit(this.password);
  }

  showError(msg: string): void {
    const errorEl = this.contentEl.querySelector('.error-message');
    if (errorEl) errorEl.setText(msg);
  }

  onClose(): void {
    this.password = '';
    this.contentEl.empty();
  }
}

export class ChangePasswordModal extends Modal {
  private currentPassword = '';
  private newPassword = '';
  private confirmPassword = '';
  private onSubmit: (currentPassword: string, newPassword: string) => void;
  private folderPath: string;

  constructor(
    app: App,
    folderPath: string,
    onSubmit: (currentPassword: string, newPassword: string) => void
  ) {
    super(app);
    this.folderPath = folderPath;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('password-plugin-modal');
    contentEl.createEl('h2', { text: `Change Password for "${this.folderPath}"` });

    new Setting(contentEl)
      .setName('Current password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.onChange((value) => (this.currentPassword = value));
      });

    new Setting(contentEl)
      .setName('New password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.onChange((value) => (this.newPassword = value));
      });

    new Setting(contentEl)
      .setName('Confirm new password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.onChange((value) => (this.confirmPassword = value));
      });

    const errorEl = contentEl.createDiv({ cls: 'error-message' });

    new Setting(contentEl).addButton((btn) => {
      btn.setButtonText('Change Password').setCta().onClick(() => {
        if (!this.currentPassword || !this.newPassword) {
          errorEl.setText('All fields are required.');
          return;
        }
        if (this.newPassword.length < 8) {
          errorEl.setText('New password must be at least 8 characters.');
          return;
        }
        if (this.newPassword !== this.confirmPassword) {
          errorEl.setText('New passwords do not match.');
          return;
        }
        this.onSubmit(this.currentPassword, this.newPassword);
        this.close();
      });
    });
  }

  onClose(): void {
    this.currentPassword = '';
    this.newPassword = '';
    this.confirmPassword = '';
    this.contentEl.empty();
  }
}
