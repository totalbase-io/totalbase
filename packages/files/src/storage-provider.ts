export interface StoredObject {
  key: string;
  modifiedAt: Date;
}

export interface FilesStorageProvider {
  readonly name: string;
  store(key: string, content: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Every object stored under `prefix` (a key path, e.g. "derivatives"), at any depth. A prefix with nothing under it: []. */
  list(prefix: string): Promise<StoredObject[]>;
  /** Deletes every object under `prefix` - a no-op when there is none. */
  deletePrefix(prefix: string): Promise<void>;
}
