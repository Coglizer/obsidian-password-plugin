# Password Protected Folders for Obsidian

A desktop-only Obsidian plugin that lets you password-protect individual folders in your vault. Choose between **full AES-256-GCM encryption at rest** (files are unreadable outside Obsidian) or **UI-only locking** (files hidden in the Obsidian interface but remain plaintext on disk). Each folder gets its own independent password.

---

## Features

- **Per-folder passwords** — Each protected folder has its own independent password
- **Two security levels:**
  - **Encrypt mode** — Files are encrypted with AES-256-GCM and renamed to `.enc`. They are completely unreadable without the password, even outside Obsidian
  - **Hide mode** — Files are hidden from Obsidian's UI but remain as plaintext on disk. Useful for casual privacy without the overhead of encryption
- **Two visibility options when locked:**
  - **Show with lock icon** — The folder remains visible in the file explorer with a lock icon. Click the icon to unlock
  - **Hide completely** — The folder disappears from the file explorer entirely
- **Right-click context menu** — Protect, lock, or unlock folders directly from the file explorer
- **Auto-lock timer** — Automatically lock all folders after a configurable period of inactivity
- **Lock on close** — Optionally lock all folders when Obsidian shuts down
- **Ribbon button** — One-click lock-all button in the sidebar
- **Command palette integration** — Lock/unlock via keyboard shortcuts
- **Change password** — Change a folder's password without losing data
- **Crash recovery** — Transaction log detects interrupted encrypt/decrypt operations

---

## Installation

### From source (manual)

1. Clone or download this repository
2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
3. Copy these three files to your vault's plugin folder:
   ```
   .obsidian/plugins/password-protected-folders/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```
4. Open Obsidian, go to **Settings > Community Plugins**
5. Disable **Restricted mode** if it's on
6. Find **Password Protected Folders** in the installed plugins list and toggle it on

### Updating

After pulling new changes, rebuild and re-copy the three files:
```bash
npm run build
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/password-protected-folders/
```
Then reload Obsidian (Ctrl/Cmd+R) or restart it.

---

## Usage

### Protecting a folder

1. Right-click any folder in the file explorer
2. Select **"Protect this folder"**
3. In the dialog:
   - Enter and confirm your password (minimum 4 characters)
   - Choose **Protection mode**:
     - *Full Encryption (AES-256-GCM)* — Encrypts all files on disk
     - *UI-Only Hiding* — Hides files in Obsidian only
   - Choose **When locked**:
     - *Show with lock icon* — Folder stays visible with a lock badge
     - *Hide completely* — Folder disappears from the explorer
4. Click **Protect**

If you chose encryption mode, all files in the folder will be encrypted immediately. A progress indicator appears for large folders.

### Unlocking a folder

There are several ways to unlock a protected folder:

- **Click the lock icon** next to the folder name (if visibility is set to "Show with lock icon")
- **Right-click the folder** > "Unlock folder" (if the folder is visible)
- **Settings tab** > find the folder > click **Unlock**
- **Command palette** > "Unlock a protected folder"

Enter the correct password and the folder's contents become accessible.

### Locking a folder

- **Right-click an unlocked folder** > "Lock folder"
- **Click the lock ribbon icon** (locks all folders)
- **Command palette** > "Lock all protected folders"
- **Settings tab** > click **Lock** next to the folder
- **Auto-lock** fires after the configured inactivity period

### Changing a password

1. Go to **Settings > Password Protected Folders**
2. Find the folder in the list
3. Click **Change Password**
4. Enter your current password, then the new password twice
5. Click **Change Password**

### Removing protection

1. Go to **Settings > Password Protected Folders**
2. Find the folder in the list
3. Click **Remove**

> **Note:** If the folder uses encryption mode, you must unlock it first before removing protection. This ensures files are decrypted back to their original state.

---

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **PBKDF2 iterations** | Number of key derivation iterations. Higher = more secure but slower to unlock. The input border turns red if set below 100,000 | 600,000 |
| **Auto-lock timeout** | Lock all folders after inactivity. Options: Disabled, 5m, 15m, 30m, 1hr | Disabled |
| **Lock on close** | Automatically lock all folders when Obsidian closes | On |

---

## Security Details

### Encryption (encrypt mode)

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key derivation:** PBKDF2 with SHA-256, configurable iterations (default 600,000)
- **Salt:** 16-byte random salt per folder, stored in plugin settings
- **IV:** 12-byte random IV per file, stored in the encrypted file header
- **Implementation:** Uses the Web Crypto API (`crypto.subtle`) available in Obsidian's Electron runtime — no external crypto libraries

### Encrypted file format

Each encrypted file has the extension `.enc` appended to its original name and contains:

```
{"version":1,"iv":"<base64>","originalExtension":"<ext>"}\n<base64-encoded-ciphertext>
```

- Line 1: JSON header with version, IV, and original file extension
- Line 2: Base64-encoded AES-256-GCM ciphertext

### Password verification

The password is never stored. Instead:

1. PBKDF2 derives a 256-bit AES key from the password + salt
2. The key bytes are hashed with SHA-256
3. This hash is stored in settings and compared on unlock attempts

### What happens when the plugin is disabled?

- **Encrypt mode:** `.enc` files remain encrypted on disk. They are safe but unreadable until the plugin is re-enabled and the correct password is provided
- **Hide mode:** Files become fully visible again since hiding is UI-only

### Transaction safety

If Obsidian crashes during an encrypt/decrypt operation:
- On next load, the plugin detects the incomplete operation
- A notice informs you which folder may have files in a mixed state
- Unlocking the folder will complete the recovery

---

## Limitations

- **Desktop only** — This plugin uses Electron APIs and DOM manipulation not available on mobile
- **Lock on close with encryption** — Obsidian doesn't await async operations during shutdown, so re-encryption on close is best-effort. For maximum security, manually lock encrypted folders before quitting
- **No nested protection** — You cannot protect a folder that is inside an already-protected folder, or protect a parent of an already-protected folder
- **File explorer DOM** — Folder hiding/lock icons rely on Obsidian's internal DOM structure (`.tree-item`, `data-path` attributes). Major Obsidian UI updates may require plugin updates

---

## Development

### Project structure

```
src/
  main.ts              # Plugin entry point
  types.ts             # All TypeScript interfaces
  crypto.ts            # AES-256-GCM encryption module
  state.ts             # Lock/unlock state manager
  ui/
    PasswordModal.ts   # Password entry/set/change modals
    SettingsTab.ts     # Plugin settings tab
    ContextMenu.ts     # Folder context menu registration
  explorer/
    FolderHider.ts     # DOM manipulation for hiding/locking folders
```

### Building

```bash
npm install
npm run build        # Production build (minified)
npm run dev          # Development build (with source maps)
```

### Key design decisions

- **Web Crypto API over external libraries:** Avoids supply chain risk and bundle bloat. `crypto.subtle` is available natively in Electron
- **MutationObserver with pause/debounce:** The file explorer DOM is observed for changes to re-apply lock icons and hiding. The observer is paused during our own DOM modifications to prevent infinite loops
- **Settings as single source of truth:** All persistent data (folder configs, pending operations) lives in the plugin's `data.json` via Obsidian's `saveData`/`loadData` API
- **In-memory CryptoKey:** Derived keys are held in memory only while a folder is unlocked. They are never written to disk

---

## License

MIT
