import type { Store } from './store.js';
export function merge3Keys<T extends Record<string, unknown>>(base: T | null | undefined, local: T, remote: T | null | undefined, options?: { preferRemote?: boolean }): T;
export function mergeRecords<T extends { updatedAt?: string | number; deleted?: boolean }>(local: Record<string, T> | undefined, remote: Record<string, T> | undefined): Record<string, T>;
export function mergeText(path: string, base: string | undefined, local: string | undefined, remote: string | undefined): string | null;
export interface SyncBase { files: Record<string, string>; ids: Record<string, string>; revision: string | null }
export interface SyncResult { files: Record<string, string>; base: SyncBase; revision: string | null; pulled: string[]; pushed: string[] }
export function syncFiles(store: Store, options: {
  files: Record<string, string>;
  base?: SyncBase | null;
  merge?: (path: string, base: string | undefined, local: string | undefined, remote: string | undefined) => string | null;
  include?: (path: string) => boolean;
  message?: string;
  attempts?: number;
}): Promise<SyncResult>;
