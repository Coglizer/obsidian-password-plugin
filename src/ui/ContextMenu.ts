/**
 * Context menu integration — adds folder protection actions to the right-click menu.
 *
 * Only shows for TFolder (not files), and suppresses the menu entirely for folders
 * nested inside an already-protected folder to avoid confusing nesting scenarios.
 *
 * Three states → three menu items:
 *   Unprotected → "Protect this folder"
 *   Protected + locked → "Unlock folder"
 *   Protected + unlocked → "Lock folder"
 */
import { Menu, TFolder, MenuItem } from 'obsidian';
import type PasswordProtectedFoldersPlugin from '../main';

export function registerContextMenu(plugin: PasswordProtectedFoldersPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
      if (!(file instanceof TFolder)) return;
      const path = file.path;

      // Suppress menu for folders nested inside a protected parent —
      // these are managed as part of the parent's protection scope
      const allProtected = plugin.stateManager.getAllProtectedPaths();
      const isNestedInProtected = allProtected.some(
        (pp) => path.startsWith(pp + '/') && pp !== path
      );
      if (isNestedInProtected) return;

      const isProtected = plugin.stateManager.isProtected(path);
      const isUnlocked = plugin.stateManager.isUnlocked(path);

      if (!isProtected) {
        menu.addItem((item: MenuItem) => {
          item
            .setTitle('Protect this folder')
            .setIcon('lock')
            .onClick(() => plugin.protectFolder(path));
        });
      } else if (isUnlocked) {
        menu.addItem((item: MenuItem) => {
          item
            .setTitle('Lock folder')
            .setIcon('lock')
            .onClick(() => plugin.lockFolder(path));
        });
      } else {
        menu.addItem((item: MenuItem) => {
          item
            .setTitle('Unlock folder')
            .setIcon('unlock')
            .onClick(() => plugin.promptUnlock(path));
        });
      }
    })
  );
}
