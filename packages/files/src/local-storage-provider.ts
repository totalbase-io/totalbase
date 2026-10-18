import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TotalBaseError } from "@totalbase/errors";
import type { FilesStorageProvider, StoredObject } from "./storage-provider.js";

export class FilesLocalStorageProvider implements FilesStorageProvider {
  readonly name = "local";

  constructor(private readonly basePath: string) {}

  static generateKey(): string {
    const id = randomUUID();
    return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
  }

  private resolve(key: string): string {
    const base = path.resolve(this.basePath);
    const resolved = path.resolve(base, key);
    if (!resolved.startsWith(base + path.sep)) {
      throw new TotalBaseError("FILE_STORAGE_ERROR", "Refusing to access a storage key outside the configured base path.");
    }
    return resolved;
  }

  async store(key: string, content: Buffer): Promise<void> {
    const filePath = this.resolve(key);
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    } catch (error) {
      throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to store file content: ${(error as Error).message}`);
    }
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to read file content: ${(error as Error).message}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.resolve(key), { force: true });
    } catch (error) {
      throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to delete file content: ${(error as Error).message}`);
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const dir = this.resolve(prefix);
    let entries;
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to list stored content: ${(error as Error).message}`);
    }
    const base = path.resolve(this.basePath);
    const objects: StoredObject[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(entry.parentPath, entry.name);
      const info = await stat(filePath).catch(() => undefined);
      if (!info) continue; // removed meanwhile
      objects.push({ key: path.relative(base, filePath).split(path.sep).join("/"), modifiedAt: info.mtime });
    }
    return objects;
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      await rm(this.resolve(prefix), { recursive: true, force: true });
    } catch (error) {
      throw new TotalBaseError("FILE_STORAGE_ERROR", `Failed to delete stored content: ${(error as Error).message}`);
    }
  }
}
