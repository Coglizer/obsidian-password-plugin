export interface ProtectedFolderConfig {
  path: string;
  salt: string;
  passwordHash: string;
  mode: 'encrypt' | 'hide';
  visibility: 'visible' | 'hidden';
  iterations: number;
  createdAt: number;
}

export interface PluginSettings {
  protectedFolders: ProtectedFolderConfig[];
  pbkdf2Iterations: number;
  lockOnClose: boolean;
  autoLockMinutes: number;
  pendingOperations: PendingOperation[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  protectedFolders: [],
  pbkdf2Iterations: 600000,
  lockOnClose: true,
  autoLockMinutes: 0,
  pendingOperations: [],
};

export interface FolderState {
  path: string;
  isUnlocked: boolean;
  derivedKey: CryptoKey | null;
}

export interface EncryptedFileHeader {
  version: number;
  iv: string;
  originalExtension: string;
}

export interface PendingOperation {
  folderPath: string;
  operation: 'encrypt' | 'decrypt';
  files: string[];
  completedFiles: string[];
}

export interface UnlockResult {
  success: boolean;
  error?: string;
}
