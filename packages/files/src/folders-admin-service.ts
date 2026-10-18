import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { validateName } from "@totalbase/shared";

export interface FolderRecord {
  id: string;
  parent: string | null;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FolderRow {
  id: string;
  parent: string | null;
  name: string;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: FolderRow): FolderRecord {
  return {
    id: row.id,
    parent: row.parent,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FoldersAdminService {
  constructor(private readonly database: Queryable) {}

  async list(): Promise<FolderRecord[]> {
    const { rows } = await this.database.query<FolderRow>(
      `SELECT * FROM totalbase.folders ORDER BY parent NULLS FIRST, name`,
    );
    return rows.map(toRecord);
  }

  async get(id: string): Promise<FolderRecord> {
    const { rows } = await this.database.query<FolderRow>(
      `SELECT * FROM totalbase.folders WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Folder not found.");
    return toRecord(rows[0]);
  }

  async create(input: { parent?: string | null; name: string }): Promise<FolderRecord> {
    const name = validateName(input.name);
    const parent = input.parent ?? null;
    if (parent !== null) await this.get(parent);
    const { rows } = await this.database.query<FolderRow>(
      `INSERT INTO totalbase.folders (parent, name)
       VALUES ($1, $2)
       RETURNING *`,
      [parent, name],
    );
    return toRecord(rows[0]!);
  }

  async rename(id: string, input: { name: string }): Promise<FolderRecord> {
    await this.get(id);
    const name = validateName(input.name);
    const { rows } = await this.database.query<FolderRow>(
      `UPDATE totalbase.folders
       SET name = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, name],
    );
    return toRecord(rows[0]!);
  }

  async remove(id: string): Promise<void> {
    const { rowCount } = await this.database.query(
      `DELETE FROM totalbase.folders WHERE id = $1`,
      [id],
    );
    if (rowCount === 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Folder not found.");
  }
}
