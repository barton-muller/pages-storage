export { Conflict } from './conflict.js';

export interface AuthState {
  login: string;
  access: string;
  expiresAt: number;
  refresh: string | null;
  refreshExpiresAt: number | null;
}
export interface AuthStorage {
  get(): Promise<AuthState | null> | AuthState | null;
  set(value: AuthState): Promise<unknown> | unknown;
  del(): Promise<unknown> | unknown;
}
export interface ClientOptions {
  clientId: string;
  relay: string;
  appSlug: string;
  name?: string;
  folder?: string;
  storage?: AuthStorage;
  cleanUrl?: () => string;
  fetchImpl?: typeof fetch;
}
export interface RepoChoice { full: string; branch: string }
export interface FileInfo { name: string; path: string; type: 'file' | 'dir'; sha: string; size: number }
export interface Commit { sha: string; message: string; author: string; date: string }
export interface Change { path: string; status: 'added' | 'modified' | 'removed' }
export interface Client {
  auth(): Promise<AuthState | null>;
  signedIn(): Promise<boolean>;
  login(): Promise<string | null>;
  signOut(): Promise<void>;
  signIn(): Promise<void>;
  handleReturn(): Promise<AuthState | null>;
  token(): Promise<string | null>;
  installUrl(): string;
  repos(): Promise<RepoChoice[]>;
  createRepo(name: string, options?: { description?: string; isPrivate?: boolean }): Promise<RepoChoice>;
  createRepoFromTemplate(template: string, name: string, options?: { description?: string; isPrivate?: boolean }): Promise<RepoChoice>;
  writeMany(repo: string, files: Record<string, string | null>, options?: { branch?: string; message?: string; base?: string }): Promise<{ commit: string }>;
  history(repo: string, path: string, options?: { branch?: string; limit?: number }): Promise<Commit[]>;
  head(repo: string, branch?: string, etag?: string | null): Promise<{ sha: string; etag: string | null } | { notModified: true; etag: string }>;
  changes(repo: string, since: string, branch?: string): Promise<{ head: string; files: Change[]; truncated: boolean }>;
  read(repo: string, path: string, branch?: string, etag?: string | null): Promise<{ text: string; sha: string; etag: string | null } | { notModified: true; etag: string } | null>;
  list(repo: string, dir?: string, branch?: string): Promise<FileInfo[]>;
  write(repo: string, path: string, text: string, sha?: string, branch?: string, message?: string): Promise<string>;
  remove(repo: string, path: string, sha: string, branch?: string, message?: string): Promise<boolean>;
}
export function createClient(options: ClientOptions): Client;
