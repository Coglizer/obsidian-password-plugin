/**
 * FolderHider — DOM-based folder visibility control for the file explorer.
 *
 * Obsidian has no public API for hiding folders, so we manipulate the DOM directly:
 *   - Add/remove CSS classes to show/hide folder tree items
 *   - Inject lock icon elements for "visible" locked folders
 *   - Use a MutationObserver to re-apply visibility when Obsidian re-renders the explorer
 *
 * Cross-platform: desktop uses `.tree-item` / `.tree-item-self` classes,
 * mobile uses `.nav-folder` / `.nav-folder-title`. Both are handled by
 * the findFolderContainer() and findSelfElement() helpers.
 */
import { Platform } from 'obsidian';

/** CSS class that completely hides an element (display: none) */
const HIDDEN_CLASS = 'password-plugin-hidden';
/** CSS class for visible-but-locked folders (reduced opacity) */
const LOCKED_CLASS = 'password-plugin-locked';
/** CSS class for the injected lock icon span */
const LOCK_ICON_CLASS = 'password-plugin-lock-icon';

/** Inline SVG for the padlock icon — avoids external asset dependencies */
const LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;

interface LockedFolderInfo {
  path: string;
  /** 'visible' = show with lock icon; 'hidden' = display:none the entire tree item */
  mode: 'visible' | 'hidden';
}

/**
 * Walk up from a data-path element to the outermost folder container.
 * The data-path attribute lives on an inner element; we need the container
 * that wraps both the title row and child items so we can hide/style the whole thing.
 */
function findFolderContainer(el: Element): Element {
  return el.closest('.tree-item') ?? el.closest('.nav-folder') ?? el;
}

/**
 * Within a folder container, find the clickable title row where we append the lock icon.
 * This is the row the user sees in the explorer — not the children container.
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

  /** Attach to the file explorer DOM and begin enforcing folder visibility */
  start(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
    this.applyAll();

    // Watch for Obsidian re-rendering the explorer (e.g., folder expand/collapse, file creation).
    // When the DOM changes, we re-apply our visibility classes on the next animation frame.
    // The applyScheduled flag + requestAnimationFrame debounce prevents running applyAll()
    // dozens of times during a single render batch.
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

  /**
   * Temporarily disconnect the MutationObserver, run a DOM-modifying function,
   * then reconnect. Without this, our own DOM changes (adding classes, icons)
   * would trigger the observer → call applyAll() → modify DOM → trigger observer
   * in an infinite loop that crashes Obsidian.
   */
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

  /**
   * Full re-apply: strip all our classes/icons then re-add for current locked set.
   * Called on observer mutations and during start(). The "clear everything then re-add"
   * approach is simple and correct — avoids stale state from partial updates.
   */
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

  /**
   * Apply visibility rules for a single folder path.
   *
   * Two modes:
   *   'hidden' → hide both the folder and all its children (display: none)
   *   'visible' → hide children (so user can't browse into locked content),
   *               but show the folder itself with a lock icon that triggers unlock
   *
   * Selectors use Obsidian's `data-path` attribute which holds the vault-relative path.
   * The `^=` prefix match catches all children (e.g., "Journal/" matches "Journal/2024/entry.md").
   */
  private applyForPath(path: string): void {
    const info = this.lockedFolders.get(path);
    if (!info) return;

    const escapedPath = this.escapeSelector(path);
    const folderSelector = `[data-path="${escapedPath}"]`;
    const childSelector = `[data-path^="${this.escapeSelector(path + '/')}"]`;

    if (info.mode === 'hidden') {
      // Hide everything — folder and all descendants
      for (const selector of [folderSelector, childSelector]) {
        document.querySelectorAll(selector).forEach((el) => {
          findFolderContainer(el).classList.add(HIDDEN_CLASS);
        });
      }
    } else {
      // Hide children so user can't browse into locked content
      document.querySelectorAll(childSelector).forEach((el) => {
        findFolderContainer(el).classList.add(HIDDEN_CLASS);
      });

      // Show the folder itself with reduced opacity + lock icon
      document.querySelectorAll(folderSelector).forEach((el) => {
        const container = findFolderContainer(el);
        container.classList.add(LOCKED_CLASS);

        const selfEl = findSelfElement(container);
        // Guard: don't add duplicate icons (applyAll clears first, but applyForPath
        // can be called independently via lockFolder)
        if (!selfEl.querySelector(`.${LOCK_ICON_CLASS}`)) {
          const iconEl = document.createElement('span');
          iconEl.className = LOCK_ICON_CLASS;
          iconEl.innerHTML = LOCK_SVG;
          iconEl.setAttribute('aria-label', 'Unlock folder');

          // stopPropagation prevents Obsidian from expanding/collapsing the folder on click;
          // preventDefault suppresses any default browser behavior
          const handler = (e: Event) => {
            e.stopPropagation();
            e.preventDefault();
            this.onLockIconClick?.(path);
          };
          iconEl.addEventListener('click', handler);
          // Mobile WebViews may not reliably fire 'click' on tapped elements,
          // so we also listen for 'touchend' as a fallback
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
   * Escape a string for use inside a CSS attribute selector like [data-path="..."].
   * Folder paths may contain special characters (quotes, parentheses, etc.) that
   * would break the selector without escaping.
   *
   * CSS.escape is the standard API, but some older mobile WebViews lack it,
   * so we include a regex-based manual fallback.
   */
  private escapeSelector(value: string): string {
    if (typeof CSS !== 'undefined' && CSS.escape) {
      return CSS.escape(value);
    }
    // Manual fallback: escape special CSS selector characters
    return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }
}
