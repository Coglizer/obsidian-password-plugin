import { Menu, TFolder, MenuItem } from 'obsidian';
import type PasswordProtectedFoldersPlugin from '../main';

export function registerContextMenu(plugin: PasswordProtectedFoldersPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
      if (!(file instanceof TFolder)) return;
      const path = file.path;

      // Check if any ancestor is already protected
      const allProtected = plugin.stateManager.getAllProtectedPaths();
      const isNestedInProtected = allProtected.some(
        (pp) => path.startsWith(pp + '/') && pp !== path
      );
      if (isNestedInProtected) return; // Don't show menu for nested folders

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
