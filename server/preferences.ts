import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Preferences, PreferencesResponse } from "../shared/types.js";
const id = z.string().regex(/^[a-z][a-z0-9-]{0,49}$/);
export const preferencesSchema = z
  .object({
    version: z.literal(1),
    order: z
      .array(z.string().regex(/^(folder:)?[a-z][a-z0-9-]{0,49}$/))
      .max(150),
    folders: z
      .array(
        z
          .object({
            id,
            name: z.string().trim().min(1).max(40),
            appIds: z.array(id).max(100),
          })
          .strict(),
      )
      .max(30),
    dock: z.array(id).max(8),
    wallpaper: z.enum(["landscape", "midnight", "dusk"]),
  })
  .strict();
export const defaultPreferences = (): Preferences => ({
  version: 1,
  order: [],
  folders: [],
  dock: [],
  wallpaper: "landscape",
});
export function ownerKey(issuer: string, subject: string): string {
  return createHash("sha256").update(`${issuer}\0${subject}`).digest("hex");
}
export function sanitizePreferences(
  input: Preferences,
  appIds: string[],
): Preferences {
  const permitted = new Set(appIds);
  const nested = new Set<string>();
  const folderIds = new Set<string>();
  const folders = input.folders
    .filter((folder) => {
      if (folderIds.has(folder.id)) return false;
      folderIds.add(folder.id);
      return true;
    })
    .map((folder) => ({
      ...folder,
      appIds: folder.appIds.filter((id) => {
        if (!permitted.has(id) || nested.has(id)) return false;
        nested.add(id);
        return true;
      }),
    }))
    .filter((folder) => folder.appIds.length > 0);
  const items = new Set([
    ...appIds.filter((id) => !nested.has(id)),
    ...folders.map((f) => `folder:${f.id}`),
  ]);
  const order = [...new Set(input.order.filter((id) => items.has(id)))];
  for (const id of items) if (!order.includes(id)) order.push(id);
  return {
    version: 1,
    order,
    folders,
    dock: [...new Set(input.dock.filter((id) => permitted.has(id)))].slice(
      0,
      8,
    ),
    wallpaper: input.wallpaper,
  };
}
export class PreferencesConflict extends Error {}
export class PreferencesStore {
  private database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(
      "PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS preferences (owner TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }
  get(owner: string, appIds: string[]): PreferencesResponse {
    const row = this.database
      .prepare("SELECT value, revision FROM preferences WHERE owner = ?")
      .get(owner) as { value: string; revision: number } | undefined;
    const value = row
      ? preferencesSchema.parse(JSON.parse(row.value))
      : { ...defaultPreferences(), dock: appIds.slice(0, 4) };
    return {
      revision: row?.revision ?? 0,
      preferences: sanitizePreferences(value, appIds),
    };
  }
  put(
    owner: string,
    value: Preferences,
    revision: number,
    appIds: string[],
  ): PreferencesResponse {
    const clean = sanitizePreferences(preferencesSchema.parse(value), appIds);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT revision FROM preferences WHERE owner = ?")
        .get(owner) as { revision: number } | undefined;
      if ((row?.revision ?? 0) !== revision)
        throw new PreferencesConflict("Layout changed in another browser");
      const next = revision + 1;
      this.database
        .prepare(
          "INSERT INTO preferences(owner,value,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at",
        )
        .run(owner, JSON.stringify(clean), next, Date.now());
      this.database.exec("COMMIT");
      return { revision: next, preferences: clean };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.database.close();
  }
}
