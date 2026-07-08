import { getToolDefinitions } from "../llm";
import { executeToolCall } from "./index";
import { recordLearnings } from "../subAgentLearnings";
import {
  getRecurringElementToolDefinitions,
  executeElementTool,
  ELEMENT_TOOL_NAMES,
} from "../recurringElements";
import type { ToolResult } from "../types";

/**
 * Tool scoping for a delegated sub-agent. A sub-agent owns exactly ONE frame,
 * so it gets the single-frame subset of the full tool set and every image-scoped
 * call is force-bound to its frame id. Multi-frame/structural tools
 * (create/delete/reorder image), planning, asset writes, web, and delegate
 * itself (no recursion) are withheld.
 */

/** Tools a sub-agent may call. Everything here operates on one frame or is a
 *  read-only asset lookup. */
export const SUB_AGENT_TOOL_NAMES: readonly string[] = [
  // inspect the one frame
  "describe_image", "render_layout", "render_layout_image", "view_image",
  // edit the one frame's layout
  "update_image_layout", "patch_image_layout",
  "set_high_level_description", "set_style_description", "set_color_palette",
  "add_region", "update_region", "delete_region", "transform_layout",
  "set_plain_prompt",
  // render + verify the one frame
  "generate_image", "regenerate_image",
  // read-only asset references
  "list_assets", "search_assets", "search_assets_semantic", "get_asset_info",
  // report generalizable lessons forward to future sub-agents
  "record_learnings",
  // read/refine the recurring-element bible (shared with the orchestrator)
  ...ELEMENT_TOOL_NAMES,
] as const;

const SUB_AGENT_TOOL_SET = new Set<string>(SUB_AGENT_TOOL_NAMES);

/** Sub-agent-only tool (not in the main tool set): report generalizable lessons
 *  so later sub-agents building other frames don't repeat the same fixes. */
const RECORD_LEARNINGS_DEF = {
  type: "function" as const,
  function: {
    name: "record_learnings",
    description:
      "Record GENERALIZABLE lessons you learned while refining this frame so future sub-agents building OTHER frames in this project benefit. Call this (before your final summary) whenever a fix would help elsewhere — e.g. an Ideogram/composition/layout/style/palette/text pitfall specific to this project or its subjects. Keep each note short, reusable, and imperative (\"Put the character's full body in one region — split regions garble the pose\"). Do NOT record frame-specific content or one-off details.",
    parameters: {
      type: "object",
      properties: {
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "One or more short, reusable lessons for future frames.",
        },
      },
      required: ["learnings"],
    },
  },
};

/** Vision-only tools, hidden when the model can't see images (matches chat.ts). */
const VISION_ONLY = new Set(["render_layout_image", "view_image"]);

/** Sub-agent tools that take an `image_id` — force-bound to the sub-agent's
 *  frame so it can never edit or render a different one. */
const IMAGE_BOUND_TOOLS = new Set([
  "describe_image", "render_layout", "render_layout_image", "view_image",
  "update_image_layout", "patch_image_layout",
  "set_high_level_description", "set_style_description", "set_color_palette",
  "add_region", "update_region", "delete_region", "transform_layout",
  "set_plain_prompt", "generate_image", "regenerate_image",
]);

/** The single-frame tool definitions offered to a sub-agent. */
export function getSubAgentToolDefinitions(visionCapable: boolean) {
  const scoped = getToolDefinitions().filter((t) => {
    const name = t.function?.name ?? "";
    if (!SUB_AGENT_TOOL_SET.has(name)) return false;
    if (!visionCapable && VISION_ONLY.has(name)) return false;
    return true;
  });
  // record_learnings is sub-agent-only; the bible tools are shared. Neither is
  // in getToolDefinitions(), so append them here.
  return [...scoped, RECORD_LEARNINGS_DEF, ...getRecurringElementToolDefinitions()];
}

/**
 * Execute a sub-agent tool call: reject anything outside the allowlist, force
 * `image_id` to the sub-agent's frame for image-scoped tools, then hand off to
 * the normal tool executor. No external/MCP tools in sub-agents.
 */
export async function executeSubAgentToolCall(
  name: string,
  args: Record<string, unknown>,
  projectId: string,
  imageId: string,
  undoContext?: { groupId: string; seq: number },
): Promise<ToolResult> {
  if (!SUB_AGENT_TOOL_SET.has(name)) {
    return { success: false, result: `Tool "${name}" is not available to a sub-agent (scoped to frame ${imageId}).` };
  }
  // Sub-agent-only tool: needs the frame id, so it's handled here rather than in
  // the shared registry.
  if (name === "record_learnings") {
    const raw = Array.isArray(args.learnings) ? (args.learnings as unknown[]) : [];
    const notes = raw.filter((n): n is string => typeof n === "string");
    const recorded = await recordLearnings(projectId, imageId, notes);
    return { success: true, result: { recorded } };
  }
  if ((ELEMENT_TOOL_NAMES as readonly string[]).includes(name)) {
    return executeElementTool(name, args, projectId);
  }
  const boundArgs = IMAGE_BOUND_TOOLS.has(name) ? { ...args, image_id: imageId } : args;
  return executeToolCall(name, boundArgs, projectId, undoContext);
}
