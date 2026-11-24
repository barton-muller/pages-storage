import type { Client } from './ghstore.js';
export interface Store {
  fetch(): Promise<{ revision: string | null; files: Record<string, string> }>;
  read(id: string): Promise<string>;
  commit(expected: string | null, changes: Record<string, string | null>, message?: string): Promise<string>;
}
export interface MemoryStore extends Store {
  beforeCommit: (() => unknown) | null;
  commitElsewhere(changes: Record<string, string | null>): Promise<string>;
  readonly files: Record<string, string>;
}
export function memoryStore(): MemoryStore;
export function githubStore(client: Client, repo: string, options?: { branch?: string; message?: string }): Store;
export function forgejoStore(options: { url: string; repo: string; branch?: string; token?: string; folder?: string; fetch?: typeof fetch }): Store;
export function storeClient(store: Store, label?: string): Pick<Client, 'handleReturn' | 'signedIn' | 'login' | 'signOut' | 'repos' | 'list' | 'read' | 'write' | 'remove' | 'history'>;
