import { describe, expect, it } from "vitest";
import { realtimeUnavailable } from "./realtime.js";

const ready = { walLevel: "logical", replication: true, createOnDatabase: true, maxReplicationSlots: 10, usedReplicationSlots: 0, ready: true };

// The 503 said "needs logical replication" whatever was missing - a role without REPLICATION read like a wal_level problem.
describe("realtimeUnavailable", () => {
  it("names each requirement missing, and what to do about it", () => {
    expect(realtimeUnavailable(ready)).toBeNull();
    const noReplication = realtimeUnavailable({ ...ready, replication: false, ready: false })!;
    expect(noReplication.code).toBe("REALTIME_UNAVAILABLE");
    expect(noReplication.message).toMatch(/role lacks the REPLICATION attribute \(ALTER ROLE/);
    expect(noReplication.message).not.toMatch(/wal_level/);
    const neither = realtimeUnavailable({ ...ready, walLevel: "replica", replication: false, ready: false })!;
    expect(neither.message).toMatch(/wal_level is replica, it must be logical.*; TotalBase's PostgreSQL role lacks the REPLICATION/);
  });
});
