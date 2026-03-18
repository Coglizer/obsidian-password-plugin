const HIDDEN_CLASS = 'password-plugin-hidden';
const LOCKED_CLASS = 'password-plugin-locked';
const LOCK_ICON_CLASS = 'password-plugin-lock-icon';

const LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;

interface LockedFolderInfo {
  path: string;
  mode: 'visible' | 'hidden';
}

export class FolderHider {
  private observer: MutationObserver | null = null;
  private containerEl: HTMLElement | null = null;
  private lockedFolders: Map<string, LockedFolderInfo> = new Map();
  private onLockIconClick: ((path: string) => void) | null = null;
  private applyScheduled = false;

  setUnlockCallback(cb: (path: string) => void): void {
    this.onLockIconClick = cb;
  }

  start(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
    this.applyAll();

    this.observer = new MutationObserver(() => {
      // Debounce to avoid re-entrant DOM modification loops
      if (!this.applyScheduled) {
        this.applyScheduled = true;
        requestAnimationFrame(() => {
          this.applyScheduled = false;
          this.applyAll();
        });
      }
    });

    this.observer.observe(containerEl, {
      childList: true,
      subtree: true,
    });
  }

  stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.containerEl = null;
    // Clean up all our modifications
    document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((el) => {
      el.classList.remove(HIDDEN_CLASS);
    });
    document.querySelectorAll(`.${LOCKED_CLASS}`).forEach((el) => {
      el.classList.remove(LOCKED_CLASS);
    });
    document.querySelectorAll(`.${LOCK_ICON_CLASS}`).forEach((el) => {
      el.remove();
    });
  }

  lockFolder(path: string, visibility: 'visible' | 'hidden'): void {
    this.lockedFolders.set(path, { path, mode: visibility });
    this.pauseObserver(() => this.applyForPath(path));
  }

  unlockFolder(path: string): void {
    this.lockedFolders.delete(path);
    this.pauseObserver(() => this.clearPath(path));
  }

  /** Temporarily disconnect observer while modifying DOM to prevent infinite loops */
  private pauseObserver(fn: () => void): void {
    if (this.observer && this.containerEl) {
      this.observer.disconnect();
      fn();
      this.observer.observe(this.containerEl, {
        childList: true,
        subtree: true,
      });
    } else {
      fn();
    }
  }

  private applyAll(): void {
    this.pauseObserver(() => {
      // Clear everything first
      document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((el) => {
        el.classList.remove(HIDDEN_CLASS);
      });
      document.querySelectorAll(`.${LOCKED_CLASS}`).forEach((el) => {
        el.classList.remove(LOCKED_CLASS);
      });
      document.querySelectorAll(`.${LOCK_ICON_CLASS}`).forEach((el) => {
        el.remove();
      });

      // Re-apply all locked folders
      for (const [path] of this.lockedFolders) {
        this.applyForPath(path);
      }
    });
  }

  private applyForPath(path: string): void {
    const info = this.lockedFolders.get(path);
    if (!info) return;

    const folderSelector = `[data-path="${CSS.escape(path)}"]`;
    const childSelector = `[data-path^="${CSS.escape(path + '/')}"]`;

    if (info.mode === 'hidden') {
      // Hide the folder and all children completely
      for (const selector of [folderSelector, childSelector]) {
        document.querySelectorAll(selector).forEach((el) => {
          const treeItem = el.closest('.tree-item') ?? el;
          treeItem.classList.add(HIDDEN_CLASS);
        });
      }
    } else {
      // Visible mode: show folder with lock icon, hide children
      document.querySelectorAll(childSelector).forEach((el) => {
        const treeItem = el.closest('.tree-item') ?? el;
        treeItem.classList.add(HIDDEN_CLASS);
      });

      // Add lock styling and icon to the folder itself
      document.querySelectorAll(folderSelector).forEach((el) => {
        const treeItem = el.closest('.tree-item') ?? el;
        treeItem.classList.add(LOCKED_CLASS);

        const selfEl = treeItem.querySelector('.tree-item-self') ?? el;
        if (!selfEl.querySelector(`.${LOCK_ICON_CLASS}`)) {
          const iconEl = document.createElement('span');
          iconEl.className = LOCK_ICON_CLASS;
          iconEl.innerHTML = LOCK_SVG;
          iconEl.title = 'Click to unlock';
          iconEl.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.onLockIconClick?.(path);
          });
          selfEl.appendChild(iconEl);
        }
      });
    }
  }

  private clearPath(path: string): void {
    const folderSelector = `[data-path="${CSS.escape(path)}"]`;
    const childSelector = `[data-path^="${CSS.escape(path + '/')}"]`;

    for (const selector of [folderSelector, childSelector]) {
      document.querySelectorAll(selector).forEach((el) => {
        const treeItem = el.closest('.tree-item') ?? el;
        treeItem.classList.remove(HIDDEN_CLASS);
        treeItem.classList.remove(LOCKED_CLASS);
        treeItem.querySelectorAll(`.${LOCK_ICON_CLASS}`).forEach((icon) => icon.remove());
      });
    }
  }
}
