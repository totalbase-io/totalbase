import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { loadDatabaseConfigFromEnv } from "./config.js";
import { timezoneNames } from "./timezone-names.js";

/**
 * The zones PostgreSQL knows, and PostgreSQL's name for a browser's spelling
 * (Security.md §4.2): ICU's canonical `America/Buenos_Aires` is IANA's legacy
 * alias, missing from a tzdata without `backward` links (Debian 13's).
 */
describe("timezoneNames (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.ping();
  });

  afterAll(async () => {
    await database.close();
  });

  it("knows PostgreSQL's own names as they are", async () => {
    const names = await timezoneNames(database);
    expect(names.has("UTC")).toBe(true);
    expect(names.canonical("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(names.canonical("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("reads a browser's ICU spelling as the zone PostgreSQL names - whether or not PostgreSQL has the alias", async () => {
    const names = await timezoneNames(database);
    const buenosAires = names.canonical("America/Buenos_Aires");
    expect(buenosAires).toBe(names.has("America/Buenos_Aires") ? "America/Buenos_Aires" : "America/Argentina/Buenos_Aires");
    expect(names.canonical("Asia/Calcutta")).toBe(names.has("Asia/Calcutta") ? "Asia/Calcutta" : "Asia/Kolkata");
    expect(names.canonical("Europe/Kiev")).toBe(names.has("Europe/Kiev") ? "Europe/Kiev" : "Europe/Kyiv");
    // Every answer is a name PostgreSQL accepts as a TimeZone.
    const { rows } = await database.query<{ tz: string }>(`SELECT (now() AT TIME ZONE $1)::text AS tz`, [buenosAires]);
    expect(rows[0]!.tz).toBeTruthy();
  });

  it("answers nothing for a name nobody knows, or for a non-string", async () => {
    const names = await timezoneNames(database);
    expect(names.canonical("Nowhere/Nope")).toBeUndefined();
    expect(names.canonical("")).toBeUndefined();
    expect(names.canonical(3)).toBeUndefined();
    expect(names.canonical(undefined)).toBeUndefined();
  });

  it("is read once per database", async () => {
    expect(await timezoneNames(database)).toBe(await timezoneNames(database));
  });
});
