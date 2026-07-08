import { db, schema } from "../db/client";
import { eq, desc } from "drizzle-orm";
import { newId } from "./nanoid";

/**
 * Cross-frame learning for delegated sub-agents. Each sub-agent records the
 * generalizable lessons it discovered while refining its frame; later
 * sub-agents get those lessons injected into their prompt so the storyboard
 * improves frame over frame instead of every sub-agent rediscovering the same
 * pitfalls.
 */

const MAX_NOTE_CHARS = 400;

/** Append generalizable lessons for a project. Empty/blank notes are dropped. */
export async function recordLearnings(
  projectId: string,
  imageId: string | null,
  notes: string[],
): Promise<number> {
  const clean = notes
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map((n) => n.trim().slice(0, MAX_NOTE_CHARS));
  if (clean.length === 0) return 0;
  const now = new Date().toISOString();
  await db.insert(schema.subAgentLearnings).values(
    clean.map((note) => ({ id: newId(), projectId, imageId, note, createdAt: now })),
  );
  return clean.length;
}

/** Most-recent-first lessons for a project (chronological on return), capped. */
export async function loadRecentLearnings(projectId: string, limit = 40): Promise<string[]> {
  const rows = await db.select({ note: schema.subAgentLearnings.note })
    .from(schema.subAgentLearnings)
    .where(eq(schema.subAgentLearnings.projectId, projectId))
    .orderBy(desc(schema.subAgentLearnings.createdAt))
    .limit(limit);
  return rows.map((r: typeof rows[number]) => r.note).reverse();
}
