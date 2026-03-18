import { Platform } from 'obsidian';

const HIDDEN_CLASS = 'password-plugin-hidden';
const LOCKED_CLASS = 'password-plugin-locked';
const LOCK_ICON_CLASS = 'password-plugin-lock-icon';

const LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;

interface LockedFolderInfo {
  path: string;
  mode: 'visible' | 'hidden';
}

/**
 * Find the nearest folder container element in the file explorer DOM.
 * Desktop uses `.tree-item`, mobile uses `.nav-folder` (or falls back to the element itself).
 */
function findFolderContainer(el: Element): Element {
  return el.closest('.tree-item') ?? el.closest('.nav-folder') ?? el;
}

/**
 * Find the self/title row within a folder container.
 * Desktop uses `.tree-item-self`, mobile uses `.nav-folder-title`.
 */
function findSelfElement(container: Element): Element {
  return container.querySelector('.tree-item-self')
    ?? container.querySelector('.nav-folder-title')
    ?? container;
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
      document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((el) => {
        el.classList.remove(HIDDEN_CLASS);
      });
      document.querySelectorAll(`.${LOCKED_CLASS}`).forEach((el) => {
        el.classList.remove(LOCKED_CLASS);
      });
      document.querySelectorAll(`.${LOCK_ICON_CLASS}`).forEach((el) => {
        el.remove();
      });

      for (const [path] of this.lockedFolders) {
        this.applyForPath(path);
      }
    });
  }

  private applyForPath(path: string): void {
    const info = this.lockedFolders.get(path);
    if (!info) return;

    const escapedPath = this.escapeSelector(path);
    const folderSelector = `[data-path="${escapedPath}"]`;
    const childSelector = `[data-path^="${this.escapeSelector(path + '/')}"]`;

    if (info.mode === 'hidden') {
      for (const selector of [folderSelector, childSelector]) {
        document.querySelectorAll(selector).forEach((el) => {
          findFolderContainer(el).classList.add(HIDDEN_CLASS);
        });
      }
    } else {
      // Hide children so you can't browse into the folder
      document.querySelectorAll(childSelector).forEach((el) => {
        findFolderContainer(el).classList.add(HIDDEN_CLASS);
      });

      // Show folder with lock icon
      document.querySelectorAll(folderSelector).forEach((el) => {
        const container = findFolderContainer(el);
        container.classList.add(LOCKED_CLASS);

        const selfEl = findSelfElement(container);
        if (!selfEl.querySelector(`.${LOCK_ICON_CLASS}`)) {
          const iconEl = document.createElement('span');
          iconEl.className = LOCK_ICON_CLASS;
          iconEl.innerHTML = LOCK_SVG;
          iconEl.setAttribute('aria-label', 'Unlock folder');

          // Use both click and touchend for cross-platform support
          const handler = (e: Event) => {
            e.stopPropagation();
            e.preventDefault();
            this.onLockIconClick?.(path);
          };
          iconEl.addEventListener('click', handler);
          if (Platform.isMobile) {
            iconEl.addEventListener('touchend', handler);
          }

          selfEl.appendChild(iconEl);
        }
      });
    }
  }

  private clearPath(path: string): void {
    const escapedPath = this.escapeSelector(path);
    const folderSelector = `[data-path="${escapedPath}"]`;
    const childSelector = `[data-path^="${this.escapeSelector(path + '/')}"]`;

    for (const selector of [folderSelector, childSelector]) {
      document.querySelectorAll(selector).forEach((el) => {
        const container = findFolderContainer(el);
        container.classList.remove(HIDDEN_CLASS);
        container.classList.remove(LOCKED_CLASS);
        container.querySelectorAll(`.${LOCK_ICON_CLASS}`).forEach((icon) => icon.remove());
      });
    }
  }

  /**
   * Escape a string for use in a CSS selector.
   * Falls back to manual escaping if CSS.escape is unavailable (some mobile WebViews).
   */
  private escapeSelector(value: string): string {
    if (typeof CSS !== 'undefined' && CSS.escape) {
      return CSS.escape(value);
    }
    // Manual fallback: escape special CSS selector characters
    return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }
}
