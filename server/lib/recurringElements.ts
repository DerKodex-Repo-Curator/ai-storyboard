import { db, schema } from "../db/client";
import { eq, asc } from "drizzle-orm";
import { newId } from "./nanoid";

/**
 * A project's recurring-element "bible": characters, costumes, props, and
 * locations that appear across frames. A sub-agent registers a canonical
 * appearance the first time it builds an element; every later sub-agent gets it
 * injected and reuses it verbatim, so recurring characters stay on-model instead
 * of being re-invented frame to frame.
 */

export type ElementKind = "character" | "costume" | "prop" | "location" | "other";
const KINDS = new Set<ElementKind>(["character", "costume", "prop", "location", "other"]);

const MAX_NAME_CHARS = 80;
const MAX_DESC_CHARS = 800;

export interface RecurringElement {
  name: string;
  kind: string;
  description: string;
}

/** Create or refine an element's canonical description. Matches an existing
 *  element case-insensitively by name so refinements update rather than
 *  duplicate. Returns whether it created a new element. */
export async function upsertElement(
  projectId: string,
  name: string,
  description: string,
  kind?: string,
): Promise<{ ok: boolean; created: boolean; name: string }> {
  const cleanName = name.trim().slice(0, MAX_NAME_CHARS);
  const cleanDesc = description.trim().slice(0, MAX_DESC_CHARS);
  if (!cleanName || !cleanDesc) return { ok: false, created: false, name: cleanName };
  const cleanKind = kind && KINDS.has(kind as ElementKind) ? kind : "character";

  const existing = await db.select().from(schema.recurringElements)
    .where(eq(schema.recurringElements.projectId, projectId));
  type ElementRow = typeof existing[number];
  const match = existing.find((e: ElementRow) => e.name.trim().toLowerCase() === cleanName.toLowerCase());
  const now = new Date().toISOString();

  if (match) {
    await db.update(schema.recurringElements)
      .set({ description: cleanDesc, kind: cleanKind, updatedAt: now })
      .where(eq(schema.recurringElements.id, match.id));
    return { ok: true, created: false, name: cleanName };
  }
  await db.insert(schema.recurringElements).values({
    id: newId(), projectId, name: cleanName, kind: cleanKind, description: cleanDesc, createdAt: now, updatedAt: now,
  });
  return { ok: true, created: true, name: cleanName };
}

/** All recurring elements for a project, oldest first (introduction order). */
export async function loadElements(projectId: string): Promise<RecurringElement[]> {
  const rows = await db.select({
    name: schema.recurringElements.name,
    kind: schema.recurringElements.kind,
    description: schema.recurringElements.description,
  })
    .from(schema.recurringElements)
    .where(eq(schema.recurringElements.projectId, projectId))
    .orderBy(asc(schema.recurringElements.createdAt));
  return rows;
}

/** Render the bible as a prompt block, or "" when there are none. */
export function formatElementsBlock(elements: RecurringElement[]): string {
  if (elements.length === 0) return "";
  const lines = elements.map((e) => `- ${e.name} (${e.kind}): ${e.description}`).join("\n");
  return `RECURRING ELEMENTS — this project's canonical characters, costumes, props, and locations. Whenever one appears in a frame, describe it EXACTLY as specified below (same features, clothing, colors) so it stays consistent across frames. Do NOT invent new details or contradict these:\n${lines}`;
}

// --- Tools (shared by the orchestrator and sub-agents) -----------------------

/** Tool names that manage the recurring-element bible. */
export const ELEMENT_TOOL_NAMES = ["describe_recurring_element", "list_recurring_elements"] as const;

/** Create/refine a bible entry. Neutral wording — the WHEN-to-use guidance lives
 *  in the orchestrator and sub-agent system prompts. */
export const DESCRIBE_ELEMENT_TOOL = {
  type: "function" as const,
  function: {
    name: "describe_recurring_element",
    description:
      "Create or refine the canonical appearance of a recurring character, costume, prop, or location so it renders IDENTICALLY across every frame. Give a concrete, reusable `description` (age/build/face/hair, exact clothing and colors as UPPERCASE hex, distinguishing features) — enough to reproduce it without seeing any particular frame. Matched by name (case-insensitive): calling it again with an existing name UPDATES that entry, so only ADD missing detail, never contradict the established look.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Canonical name/identifier, e.g. \"Detective Mara\" or \"the red delivery van\"." },
        description: { type: "string", description: "Detailed, reusable appearance another agent can reproduce exactly." },
        kind: { type: "string", enum: ["character", "costume", "prop", "location", "other"], description: "What kind of element this is (defaults to character)." },
      },
      required: ["name", "description"],
    },
  },
};

/** List the current bible. */
export const LIST_ELEMENTS_TOOL = {
  type: "function" as const,
  function: {
    name: "list_recurring_elements",
    description:
      "List this project's recurring elements (characters, costumes, props, locations) with their canonical descriptions. The bible is normally already provided in your context — use this to re-check it or when it may have changed since your turn began.",
    parameters: { type: "object", properties: {} },
  },
};

/** Both bible tool definitions. */
export function getRecurringElementToolDefinitions() {
  return [DESCRIBE_ELEMENT_TOOL, LIST_ELEMENTS_TOOL];
}

/** Execute a bible tool. Shared by the orchestrator (via the chat deps override)
 *  and sub-agents (via the scoped executor). */
export async function executeElementTool(
  name: string,
  args: Record<string, unknown>,
  projectId: string,
): Promise<{ success: boolean; result: unknown }> {
  if (name === "describe_recurring_element") {
    const elName = typeof args.name === "string" ? args.name : "";
    const desc = typeof args.description === "string" ? args.description : "";
    const kind = typeof args.kind === "string" ? args.kind : undefined;
    if (!elName || !desc) {
      return { success: false, result: "describe_recurring_element requires a name and a description." };
    }
    const res = await upsertElement(projectId, elName, desc, kind);
    if (!res.ok) return { success: false, result: "Element name and description must be non-empty." };
    return { success: true, result: { name: res.name, action: res.created ? "registered" : "updated" } };
  }
  if (name === "list_recurring_elements") {
    const elements = await loadElements(projectId);
    return { success: true, result: { count: elements.length, elements } };
  }
  return { success: false, result: `Unknown recurring-element tool: ${name}` };
}
