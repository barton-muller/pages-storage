import type { Client } from './ghstore.js';

export type Concurrency = 'branch' | 'files';
export interface Store {
  /** Which host adapter this is: 'github', 'gitlab', 'forgejo', 'memory' */
  host: string;
  label?: string;
  capabilities: { createOnEmpty: boolean; concurrency: Concurrency };
  repoInfo(): Promise<{ defaultBranch: string; canWrite: boolean | undefined }>;
  fetch(): Promise<{ revision: string | null; files: Record<string, string> }>;
  read(id: string): Promise<string>;
  commit(expected: string | null, changes: Record<string, string | null>, message?: string): Promise<string>;
  /** Creates the store's branch from the default branch when it is missing. True if it created it. */
  ensureBranch(): Promise<boolean>;
}
export interface MemoryStore extends Store {
  beforeCommit: (() => unknown) | null;
  commitElsewhere(changes: Record<string, string | null>): Promise<string>;
  readonly files: Record<string, string>;
}
export function memoryStore(): MemoryStore;
export interface StoreOptions { token?: string | (() => string | Promise<string>); branch?: string; folder?: string; anonymous?: boolean; fetch?: typeof fetch }
export function storeFromUrl(url: string, options?: StoreOptions): Promise<Store>;
export function githubStore(client: Client, repo: string, options?: { branch?: string; folder?: string }): Promise<Store>;
export function createStore(host: string, options: { repo: string; origin?: string; token?: StoreOptions['token']; branch: string; folder?: string; fetch?: typeof fetch }): Store;
export function githubTokenStore(options: { repo: string; branch?: string; token: StoreOptions['token']; folder?: string; fetch?: typeof fetch }): Store;
export function forgejoStore(options: { url: string; repo: string; branch?: string; token: StoreOptions['token']; folder?: string; fetch?: typeof fetch }): Store;
export function gitlabStore(options: { url?: string; repo: string; branch?: string; token: StoreOptions['token']; folder?: string; fetch?: typeof fetch }): Store;
export function parseRepoUrl(url: string): { host: string; origin: string; segments: string[]; token?: string } | null;
export function detectHost(parsed: { host: string; origin: string }, fetch?: typeof fetch): Promise<unknown>;
export const hosts: Record<string, unknown>;
export function storeClient(store: Store, label?: string): Pick<Client, 'handleReturn' | 'signedIn' | 'login' | 'signOut' | 'repos' | 'list' | 'read' | 'write' | 'remove' | 'history'>;
export * from './hosts/errors.js';
