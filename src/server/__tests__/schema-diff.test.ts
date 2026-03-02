import { describe, it, expect } from "vitest";
import { diffSnapshots, type SchemaSnapshot } from "../schema-diff.js";

const base: SchemaSnapshot = {
  tables: [
    {
      name: "users", schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, default_value: null },
        { name: "name", type: "text", nullable: false, default_value: null },
        { name: "email", type: "text", nullable: true, default_value: null },
      ],
      indexes: [
        { name: "users_pkey", definition: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)", is_unique: true, is_primary: true },
      ],
      constraints: [
        { name: "users_pkey", type: "PRIMARY KEY", definition: "PRIMARY KEY (id)" },
      ],
    },
  ],
  enums: [
    { name: "status", schema: "public", values: ["active", "inactive"] },
  ],
};

describe("diffSnapshots", () => {
  it("detects no changes for identical snapshots", () => {
    expect(diffSnapshots(base, base)).toEqual([]);
  });

  it("detects added table", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [...base.tables, { name: "posts", schema: "public", columns: [], indexes: [], constraints: [] }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "added", object_type: "table", table_name: "public.posts" });
  });

  it("detects removed table", () => {
    const next: SchemaSnapshot = { ...base, tables: [] };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "removed", object_type: "table", table_name: "public.users" });
  });

  it("detects added column", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [{ ...base.tables[0], columns: [...base.tables[0].columns, { name: "age", type: "integer", nullable: true, default_value: null }] }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "added", object_type: "column", detail: expect.stringContaining("age") });
  });

  it("detects removed column", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [{ ...base.tables[0], columns: base.tables[0].columns.slice(0, 2) }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "removed", object_type: "column", detail: expect.stringContaining("email") });
  });

  it("detects column type change", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [{
        ...base.tables[0],
        columns: base.tables[0].columns.map((c) => c.name === "name" ? { ...c, type: "varchar(255)" } : c),
      }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "modified", object_type: "column", detail: expect.stringContaining("text → varchar(255)") });
  });

  it("detects nullable change", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [{
        ...base.tables[0],
        columns: base.tables[0].columns.map((c) => c.name === "email" ? { ...c, nullable: false } : c),
      }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes.some((c) => c.detail.includes("nullable changed"))).toBe(true);
  });

  it("detects added index", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [{
        ...base.tables[0],
        indexes: [...base.tables[0].indexes, { name: "idx_email", definition: "CREATE INDEX idx_email ON public.users USING btree (email)", is_unique: false, is_primary: false }],
      }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "added", object_type: "index" });
  });

  it("detects removed index", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [{ ...base.tables[0], indexes: [] }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "removed", object_type: "index" });
  });

  it("detects added enum value", () => {
    const next: SchemaSnapshot = {
      ...base,
      enums: [{ name: "status", schema: "public", values: ["active", "inactive", "pending"] }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "modified", object_type: "enum", detail: expect.stringContaining("pending") });
  });

  it("detects removed enum", () => {
    const next: SchemaSnapshot = { ...base, enums: [] };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "removed", object_type: "enum" });
  });

  it("detects added constraint", () => {
    const next: SchemaSnapshot = {
      ...base,
      tables: [{
        ...base.tables[0],
        constraints: [...base.tables[0].constraints, { name: "users_email_unique", type: "UNIQUE", definition: "UNIQUE (email)" }],
      }],
    };
    const changes = diffSnapshots(base, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "added", object_type: "constraint" });
  });
});
