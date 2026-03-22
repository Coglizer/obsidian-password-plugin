# Password Protected Folders for Obsidian

An Obsidian plugin that lets you password-protect individual folders in your vault. Choose between **full AES-256-GCM encryption at rest** (files are unreadable outside Obsidian) or **UI-only locking** (files hidden in the Obsidian interface but remain plaintext on disk). Each folder gets its own independent password.

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
   - Enter and confirm your password (minimum 8 characters)
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

### Encrypted file format (v2)

Each encrypted file has the extension `.enc` appended to its original name. The binary layout is:

```
[4-byte header length (big-endian uint32)] [JSON header bytes] [raw AES-256-GCM ciphertext]
```

- **Header:** JSON containing `version`, `iv` (base64 12-byte IV), and `originalExtension`
- **AAD:** The header bytes are passed as Additional Authenticated Data to AES-GCM, making them tamper-proof without encrypting them
- **Ciphertext:** Raw encrypted bytes (not base64), keeping file size close to the original

Legacy v1 files (text/base64 format) are automatically detected and supported for backward compatibility.

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

## Security Limitations & Known Constraints

> **Read this section carefully before relying on this plugin for sensitive data.**
> These are architectural limitations of Obsidian's plugin system and the browser/Electron runtime. They cannot be fixed by this plugin alone.

### Plaintext exposure while unlocked

When you unlock an encrypted folder, **all files are decrypted to plaintext on disk** for the entire duration the folder is unlocked. During this window:

- **Cloud sync services** (iCloud, Dropbox, Google Drive, OneDrive) will detect the file changes and **upload plaintext copies** to the cloud. Most cloud providers retain version history — even if you lock the folder again, plaintext versions may persist in cloud trash or version history indefinitely.
- **OS search indexing** (Spotlight on macOS, Windows Search) may index the decrypted file contents.
- **Backup tools** (Time Machine, etc.) may snapshot the plaintext versions.
- Any other application running on the device can read the plaintext files.

**This is the most significant limitation.** Obsidian's plugin API provides no way to serve decrypted content from memory without writing it to disk. A virtual filesystem layer would be needed, which Obsidian does not support.

**Recommendation:** If you sync your vault to the cloud, understand that the cloud provider has access to your plaintext every time you unlock. Minimize the time folders stay unlocked. For truly sensitive data, consider whether cloud sync and encryption mode are compatible for your threat model.

### Other Obsidian plugins can bypass all protections

Obsidian has no plugin sandboxing or permission model. **Any installed plugin** can:

- Call `vault.read()` or `vault.adapter.read()` on files inside protected folders
- Enumerate all files with `vault.getFiles()`, including hidden ones
- Access decrypted file contents while a folder is unlocked

This plugin hides folders in the UI and intercepts file-open events, but these are best-effort guards — not an access control boundary. There is no mechanism in Obsidian's architecture to restrict one plugin's vault access from another.

**Recommendation:** Only install plugins you trust. Treat this plugin as protection against casual browsing, not against malicious plugins.

### Encryption cannot complete on app close

Obsidian does not `await` the plugin's `onunload()` method — it is synchronous. When you close Obsidian (or the plugin is disabled) with encrypted folders unlocked:

- The plugin attempts to re-encrypt files, but the process exits before encryption finishes
- Files may remain as plaintext on disk
- On mobile, the OS can suspend the app at any time during background encryption

The plugin mitigates this on mobile by also attempting to lock when the app returns to foreground, but this is not guaranteed.

**Recommendation:** Always manually lock encrypted folders before closing Obsidian. Do not rely on "Lock on close" for encrypt mode — it is best-effort only.

### DOM hiding is not a security boundary

Folder hiding in the file explorer uses CSS (`display: none`). Anyone with access to the Obsidian window can open Developer Tools and run:

```js
document.querySelectorAll('.password-plugin-hidden')
  .forEach(e => e.classList.remove('password-plugin-hidden'))
```

This instantly reveals all hidden folders. This is inherent to browser-based UI — DOM-level security is impossible in an Electron/Chromium environment.

### Search, graph view, and backlinks ignore hiding

Obsidian's built-in features do not respect this plugin's folder hiding:

- **Search** (`Ctrl+Shift+F`) returns results from files inside locked folders (in hide mode, files are plaintext; in encrypt mode while locked, files are `.enc` gibberish)
- **Graph view** shows nodes for files in hidden folders
- **Backlinks** panel shows references to/from hidden files
- **Quick switcher** (`Ctrl+O`) lists files from hidden folders

There is no Obsidian API to exclude files from search, graph, or the quick switcher programmatically.

**Recommendation:** Use encrypt mode if you need to prevent content from appearing in search and graph. In encrypt mode while locked, file contents are encrypted and search will not return meaningful results.

### Filenames are not encrypted

Encrypted files are named `original-name.md.enc` — the original filename (minus extension) is visible on disk and in `.enc` listings. An attacker with filesystem access can see what documents exist without knowing the password.

Encrypting filenames would break Obsidian's link resolution (`[[wiki-links]]`, embeds, backlinks, graph view) because Obsidian resolves these by filename. This would require a virtual filesystem layer that Obsidian does not provide.

### Password strings persist in JavaScript memory

JavaScript strings are immutable and cannot be zeroed after use. The password you type persists in the V8 heap until garbage collection. The derived key material (`ArrayBuffer`) is explicitly zeroed, and the `CryptoKey` is non-extractable, but the original password string cannot be scrubbed.

In practice, an attacker with the ability to dump process memory already has full filesystem access and does not need the password. This is a theoretical concern inherent to all JavaScript applications.

### `data.json` enables offline brute-force attacks

The plugin stores the PBKDF2 salt, SHA-256 verification hash, and iteration count in Obsidian's `data.json` file. An attacker who copies this file can run offline password cracking (GPU-accelerated PBKDF2) with no rate limiting. The in-app rate limiter (exponential backoff) only applies to the running plugin.

At 600,000 PBKDF2 iterations this is slow but not infeasible for weak passwords. There is no way to use Argon2id (memory-hard, GPU-resistant) because the Web Crypto API does not support it.

**Recommendation:** Use a strong, unique password (16+ characters, not a dictionary word). The strength of your password is the primary defense against offline attacks.

### No password recovery

If you forget a folder's password, **the encrypted files are permanently lost**. There is no recovery key, master password, backdoor, or reset mechanism. The password hash stored in `data.json` is one-way — it can verify a correct password but cannot recover one.

**Recommendation:** Use a password manager. Consider keeping a backup of important files in a separate secure location.

### Obsidian version coupling

Folder hiding and lock icons rely on Obsidian's internal DOM structure (`.tree-item`, `.tree-item-self`, `.nav-folder`, `.nav-folder-title`, `data-path` attributes). These are implementation details, not a public API. A major Obsidian UI update could break folder hiding and lock icons without warning.

The encryption/decryption functionality (files on disk) is independent of Obsidian's DOM and will continue to work regardless of UI changes.

---

### Security summary table

| Concern | Encrypt mode (locked) | Encrypt mode (unlocked) | Hide mode |
|---------|----------------------|------------------------|-----------|
| Files safe on disk | Yes (.enc) | **No** (plaintext) | **No** (always plaintext) |
| Safe from cloud sync | Mostly (filenames leak) | **No** (sync uploads plaintext) | **No** |
| Safe from other plugins | Yes (files are .enc) | **No** (vault API reads plaintext) | **No** |
| Safe from OS search | Yes (encrypted) | **No** (indexed) | **No** |
| Safe from git history | Partially (binary blobs) | **No** (plaintext in commits) | **No** |
| Hidden from Obsidian search | Yes (gibberish) | **No** (indexed) | **No** |
| Hidden from graph/backlinks | Yes (no parseable links) | **No** | **No** |
| Survives app crash | Mixed-state risk | Mixed-state risk | Safe (no encryption) |
| Password recovery possible | **No** | **No** | **No** |

---

## Other Limitations

- **No nested protection** — You cannot protect a folder that is inside an already-protected folder, or protect a parent of an already-protected folder
- **No multi-user support** — Single password per folder; no shared access or role-based permissions
- **Large folders** — Encrypt/decrypt is sequential (one file at a time). Folders with hundreds of files will take noticeable time to lock/unlock
- **Large files** — Entire file must fit in memory to encrypt/decrypt. Very large files (>500MB) may cause issues on mobile

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
