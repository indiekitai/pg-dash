// Schema Diff — compares two schema snapshots and produces a change list

export interface SchemaSnapshot {
  tables: SnapshotTable[];
  enums: SnapshotEnum[];
}

export interface SnapshotTable {
  name: string;
  schema: string;
  columns: SnapshotColumn[];
  indexes: SnapshotIndex[];
  constraints: SnapshotConstraint[];
}

export interface SnapshotColumn {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
}

export interface SnapshotIndex {
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
}

export interface SnapshotConstraint {
  name: string;
  type: string;
  definition: string;
}

export interface SnapshotEnum {
  name: string;
  schema: string;
  values: string[];
}

export interface SchemaChange {
  change_type: "added" | "removed" | "modified";
  object_type: "table" | "column" | "index" | "constraint" | "enum";
  table_name: string | null;
  detail: string;
}

export function diffSnapshots(oldSnap: SchemaSnapshot, newSnap: SchemaSnapshot): SchemaChange[] {
  const changes: SchemaChange[] = [];

  const oldTableMap = new Map(oldSnap.tables.map((t) => [`${t.schema}.${t.name}`, t]));
  const newTableMap = new Map(newSnap.tables.map((t) => [`${t.schema}.${t.name}`, t]));

  // Tables added/removed
  for (const [key, t] of newTableMap) {
    if (!oldTableMap.has(key)) {
      changes.push({ change_type: "added", object_type: "table", table_name: key, detail: `Table ${key} added` });
    }
  }
  for (const [key] of oldTableMap) {
    if (!newTableMap.has(key)) {
      changes.push({ change_type: "removed", object_type: "table", table_name: key, detail: `Table ${key} removed` });
    }
  }

  // Compare matching tables
  for (const [key, newTable] of newTableMap) {
    const oldTable = oldTableMap.get(key);
    if (!oldTable) continue;

    // Columns
    const oldCols = new Map(oldTable.columns.map((c) => [c.name, c]));
    const newCols = new Map(newTable.columns.map((c) => [c.name, c]));

    for (const [name, col] of newCols) {
      const oldCol = oldCols.get(name);
      if (!oldCol) {
        changes.push({ change_type: "added", object_type: "column", table_name: key, detail: `Column ${name} added (${col.type})` });
      } else {
        if (oldCol.type !== col.type) {
          changes.push({ change_type: "modified", object_type: "column", table_name: key, detail: `Column ${name} type changed: ${oldCol.type} → ${col.type}` });
        }
        if (oldCol.nullable !== col.nullable) {
          changes.push({ change_type: "modified", object_type: "column", table_name: key, detail: `Column ${name} nullable changed: ${oldCol.nullable} → ${col.nullable}` });
        }
        if (oldCol.default_value !== col.default_value) {
          changes.push({ change_type: "modified", object_type: "column", table_name: key, detail: `Column ${name} default changed: ${oldCol.default_value ?? "NULL"} → ${col.default_value ?? "NULL"}` });
        }
      }
    }
    for (const name of oldCols.keys()) {
      if (!newCols.has(name)) {
        changes.push({ change_type: "removed", object_type: "column", table_name: key, detail: `Column ${name} removed` });
      }
    }

    // Indexes
    const oldIdx = new Map(oldTable.indexes.map((i) => [i.name, i]));
    const newIdx = new Map(newTable.indexes.map((i) => [i.name, i]));
    for (const [name, idx] of newIdx) {
      if (!oldIdx.has(name)) {
        changes.push({ change_type: "added", object_type: "index", table_name: key, detail: `Index ${name} added` });
      } else if (oldIdx.get(name)!.definition !== idx.definition) {
        changes.push({ change_type: "modified", object_type: "index", table_name: key, detail: `Index ${name} definition changed` });
      }
    }
    for (const name of oldIdx.keys()) {
      if (!newIdx.has(name)) {
        changes.push({ change_type: "removed", object_type: "index", table_name: key, detail: `Index ${name} removed` });
      }
    }

    // Constraints
    const oldCon = new Map(oldTable.constraints.map((c) => [c.name, c]));
    const newCon = new Map(newTable.constraints.map((c) => [c.name, c]));
    for (const [name, con] of newCon) {
      if (!oldCon.has(name)) {
        changes.push({ change_type: "added", object_type: "constraint", table_name: key, detail: `Constraint ${name} added (${con.type})` });
      } else if (oldCon.get(name)!.definition !== con.definition) {
        changes.push({ change_type: "modified", object_type: "constraint", table_name: key, detail: `Constraint ${name} definition changed` });
      }
    }
    for (const name of oldCon.keys()) {
      if (!newCon.has(name)) {
        changes.push({ change_type: "removed", object_type: "constraint", table_name: key, detail: `Constraint ${name} removed` });
      }
    }
  }

  // Enums
  const oldEnums = new Map((oldSnap.enums || []).map((e) => [`${e.schema}.${e.name}`, e]));
  const newEnums = new Map((newSnap.enums || []).map((e) => [`${e.schema}.${e.name}`, e]));
  for (const [key, en] of newEnums) {
    const oldEn = oldEnums.get(key);
    if (!oldEn) {
      changes.push({ change_type: "added", object_type: "enum", table_name: null, detail: `Enum ${key} added (${en.values.join(", ")})` });
    } else {
      const added = en.values.filter((v) => !oldEn.values.includes(v));
      const removed = oldEn.values.filter((v) => !en.values.includes(v));
      for (const v of added) {
        changes.push({ change_type: "modified", object_type: "enum", table_name: null, detail: `Enum ${key}: value '${v}' added` });
      }
      for (const v of removed) {
        changes.push({ change_type: "modified", object_type: "enum", table_name: null, detail: `Enum ${key}: value '${v}' removed` });
      }
    }
  }
  for (const key of oldEnums.keys()) {
    if (!newEnums.has(key)) {
      changes.push({ change_type: "removed", object_type: "enum", table_name: null, detail: `Enum ${key} removed` });
    }
  }

  return changes;
}
