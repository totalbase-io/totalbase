import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IndexService } from "./index-service.js";
import { TableSchemaService } from "./table-schema-service.js";

const T1 = "schema_pkg_index_test_t1";

describe("IndexService (integration)", () => {
  let database: Database;
  let indexService: IndexService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    indexService = new IndexService(database);
    const tableService = new TableSchemaService(database);
    await database.query(`DROP TABLE IF EXISTS public.${T1} CASCADE`);
    await tableService.createTable({
      schema: "public",
      name: T1,
      columns: [
        { name: "id", dataType: "uuid", nullable: false, default: "gen_random_uuid()", primaryKey: true },
        { name: "email", dataType: "text" },
        { name: "status", dataType: "text" },
      ],
    });
  });

  afterAll(async () => {
    await database.query(`DROP TABLE IF EXISTS public.${T1} CASCADE`);
    await database.close();
  });

  it("creates a plain btree index and lists it", async () => {
    await indexService.create({ schema: "public", table: T1, columns: ["email"], name: `${T1}_email_idx` });
    const indexes = await indexService.list("public", T1);
    const found = indexes.find((i) => i.name === `${T1}_email_idx`);
    expect(found).toBeDefined();
    expect(found!.isUnique).toBe(false);
    expect(found!.definition).toContain("btree");
  });

  it("creates a unique, partial index with a WHERE clause", async () => {
    await indexService.create({
      schema: "public",
      table: T1,
      columns: ["email"],
      name: `${T1}_active_email_key`,
      unique: true,
      where: "status = 'ACTIVE'",
    });
    const indexes = await indexService.list("public", T1);
    const found = indexes.find((i) => i.name === `${T1}_active_email_key`);
    expect(found).toBeDefined();
    expect(found!.isUnique).toBe(true);
    expect(found!.definition).toContain("WHERE");
  });

  it("creates an index with a DESC column", async () => {
    await indexService.create({
      schema: "public",
      table: T1,
      columns: [{ name: "email", direction: "desc" }],
      name: `${T1}_email_desc_idx`,
    });
    const indexes = await indexService.list("public", T1);
    const found = indexes.find((i) => i.name === `${T1}_email_desc_idx`);
    expect(found).toBeDefined();
    expect(found!.definition).toContain("DESC");
  });

  it("rejects an unsupported index method", async () => {
    await expect(
      indexService.create({ schema: "public", table: T1, columns: ["status"], method: "not-a-method" as never }),
    ).rejects.toMatchObject({ code: "INVALID_SCHEMA_OPERATION" });
  });

  it("drops an index", async () => {
    await indexService.drop("public", `${T1}_email_idx`);
    const indexes = await indexService.list("public", T1);
    expect(indexes.find((i) => i.name === `${T1}_email_idx`)).toBeUndefined();
  });
});
