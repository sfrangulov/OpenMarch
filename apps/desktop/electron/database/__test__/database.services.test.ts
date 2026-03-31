import { beforeEach, describe, expect, it } from "vitest";
import Database from "libsql";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import {
    __databaseServiceTestUtils,
    handleSqlProxyWithDb,
    setDbPath,
} from "../database.services";

describe("Database Services", () => {
    describe("sql proxy", () => {
        let db: Database.Database;

        beforeEach(() => {
            db = new Database(":memory:");
            // Set up a test table
            db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
            db.exec(
                "INSERT INTO test (id, name) VALUES (1, 'test1'), (2, 'test2')",
            );
        });

        it("should handle all - returns {rows: string[][]}", async () => {
            const result = await handleSqlProxyWithDb(
                db,
                "SELECT * FROM test",
                [],
                "all",
            );
            expect(result).toEqual({
                rows: [
                    [1, "test1"],
                    [2, "test2"],
                ],
            });
            expect(Array.isArray(result.rows)).toBe(true);
            expect(Array.isArray(result.rows[0])).toBe(true); // Should be string[][]
        });

        it("should handle get - returns {rows: string[]}", async () => {
            const result = await handleSqlProxyWithDb(
                db,
                "SELECT * FROM test WHERE id = ?",
                [1],
                "get",
            );
            expect(result).toEqual({
                rows: [1, "test1"],
            });
            expect(Array.isArray(result.rows)).toBe(true);
            expect(Array.isArray(result.rows[0])).toBe(false); // Should be string[], not string[][]
        });

        it("should handle run for insert - returns {rows: string[][]}", async () => {
            const result = await handleSqlProxyWithDb(
                db,
                "INSERT INTO test (id, name) VALUES (?, ?)",
                [3, "test3"],
                "run",
            );
            expect(result.rows).toEqual([]);

            // Verify the insert worked
            const selectResult = await handleSqlProxyWithDb(
                db,
                "SELECT * FROM test WHERE id = ?",
                [3],
                "get",
            );
            expect(selectResult).toEqual({
                rows: [3, "test3"],
            });
        });

        it("should handle empty results", async () => {
            const result = await handleSqlProxyWithDb(
                db,
                "SELECT * FROM test WHERE id = ?",
                [999],
                "all",
            );
            expect(result).toEqual({ rows: [] });
        });
    });

    describe("serialized queue", () => {
        beforeEach(() => {
            __databaseServiceTestUtils.resetPersistentConnectionState({
                resetQueue: true,
            });
        });

        it("executes queued jobs in order", async () => {
            const executionOrder: string[] = [];

            const firstJob = __databaseServiceTestUtils.enqueueSql(async () => {
                executionOrder.push("first:start");
                await new Promise((resolve) => setTimeout(resolve, 25));
                executionOrder.push("first:end");
                return "first";
            });
            const secondJob = __databaseServiceTestUtils.enqueueSql(
                async () => {
                    executionOrder.push("second");
                    return "second";
                },
            );

            await expect(firstJob).resolves.toBe("first");
            await expect(secondJob).resolves.toBe("second");
            expect(executionOrder).toEqual([
                "first:start",
                "first:end",
                "second",
            ]);
        });

        it("continues processing after a failed queued job", async () => {
            const failedJob = __databaseServiceTestUtils.enqueueSql(
                async () => {
                    throw new Error("expected queue failure");
                },
            );
            const successfulJob = __databaseServiceTestUtils.enqueueSql(
                async () => "still-runs",
            );

            await expect(failedJob).rejects.toThrow("expected queue failure");
            await expect(successfulJob).resolves.toBe("still-runs");
        });

        it("resets persistent connection when db path changes", async () => {
            const tempDir = fs.mkdtempSync(
                path.join(tmpdir(), "openmarch-db-services-"),
            );
            const firstPath = path.join(tempDir, "first.sqlite");
            const secondPath = path.join(tempDir, "second.sqlite");

            try {
                expect(setDbPath(firstPath, true)).toBe(200);
                const firstConnection =
                    await __databaseServiceTestUtils.withPersistentDb(
                        async (db) => db,
                    );

                expect(
                    __databaseServiceTestUtils.getPersistentConnectionPath(),
                ).toBe(firstPath);

                expect(setDbPath(secondPath, true)).toBe(200);
                const secondConnection =
                    await __databaseServiceTestUtils.withPersistentDb(
                        async (db) => db,
                    );

                expect(secondConnection).not.toBe(firstConnection);
                expect(
                    __databaseServiceTestUtils.getPersistentConnectionPath(),
                ).toBe(secondPath);
            } finally {
                __databaseServiceTestUtils.resetPersistentConnectionState({
                    resetQueue: true,
                });
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
});
