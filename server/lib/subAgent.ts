import { db, schema } from "../db/client";
import { eq, asc } from "drizzle-orm";
import { getSystemPrompt } from "./systemPrompt";
import { loadAttachedStyleguides } from "./styleguideContext";
import { parseLayout } from "./layout";
import { getComfyDisabledWorkflowIds } from "./comfyuiClient";
import { registry, RunConflictError } from "./agentRuns";
import { runAgentLoop, type AgentLoopContext, type AgentLoopDeps } from "./agentLoop";
import {
  streamChat,
  getSubAgentLLMConfig,
  getContextWindowSize,
  type LLMConfig,
} from "./llm";
import { getSubAgentToolDefinitions, executeSubAgentToolCall } from "./tools/subAgentScope";
import { loadRecentLearnings } from "./subAgentLearnings";
import { loadElements, formatElementsBlock } from "./recurringElements";
import { persistUserMessage } from "./chatPersistence";
import { getUploadsDir } from "./config";
import { newId } from "./nanoid";

export interface SubAgentResult {
  success: boolean;
  /** The sub-agent's final report to the orchestrator (its closing summary). */
  summary: string;
  /** Terminal run status: "complete" | "error" | "cancelled". */
  status: string;
  /** The frame's status after the sub-agent finished (draft/generated/failed). */
  imageStatus?: string;
}

/**
 * Run a delegated sub-agent scoped to ONE frame. The orchestrator calls this via
 * the `delegate_image` tool and blocks on it; the sub-agent runs its own
 * `runAgentLoop` (image-scoped run, streamed live into that frame's side-chat)
 * and returns a concise summary the orchestrator can react to.
 *
 * Repeated calls on the same frame continue its side-chat, so the orchestrator
 * can keep guiding it.
 */
export async function runSubAgent(opts: {
  imageId: string;
  projectId: string;
  brief: string;
}): Promise<SubAgentResult> {
  const { imageId, projectId, brief } = opts;

  const [img] = await db.select().from(schema.images).where(eq(schema.images.id, imageId));
  if (!img || img.projectId !== projectId) {
    return { success: false, summary: `No frame ${imageId} in this project.`, status: "error" };
  }
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));

  // Full layout for the one frame the sub-agent owns.
  const layout = parseLayout(img.layout);
  const selectedImageDetails: Record<string, unknown> = {
    id: img.id, order: img.order, name: img.name, status: img.status,
    layout, plainPrompt: img.plainPrompt, negativePrompt: img.negativePrompt,
  };

  // Available generation workflows (same filtering as the main chat context).
  const disabledWorkflowIds = await getComfyDisabledWorkflowIds();
  const workflowRows = await db.select().from(schema.workflows);
  type WorkflowRow = typeof workflowRows[number];
  const availableWorkflows = workflowRows
    .filter((w: WorkflowRow) => !disabledWorkflowIds.has(w.id))
    .map((w: WorkflowRow) => ({ id: w.id, name: w.name, description: w.description || "", type: w.workflowType, isDefault: w.isDefault === 1 }));

  const attachedStyleguides = await loadAttachedStyleguides(projectId);

  const baseSystemPrompt = getSystemPrompt({
    projectName: project?.name,
    aspectRatio: project?.aspectRatio,
    megapixels: project?.megapixels ?? undefined,
    width: project?.width,
    height: project?.height,
    promptFormat: project?.promptFormat,
    activePlan: null,
    images: [{
      id: img.id, order: img.order, name: img.name ?? "", status: img.status,
      highLevelDescription: layout.high_level_description,
      regionCount: layout.compositional_deconstruction.length,
    }],
    selectedImageId: img.id,
    selectedImageDetails,
    availableWorkflows: availableWorkflows.length > 0 ? availableWorkflows : undefined,
    attachedStyleguides: attachedStyleguides.length > 0 ? attachedStyleguides : undefined,
  });

  // Lessons earlier sub-agents recorded for this project, so this frame builds
  // on their fixes instead of rediscovering them.
  const priorLearnings = await loadRecentLearnings(projectId);
  const learningsBlock = priorLearnings.length > 0
    ? `\n\nLESSONS FROM EARLIER FRAMES IN THIS PROJECT — apply these proactively so you don't repeat past fixes:\n${priorLearnings.map((l) => `- ${l}`).join("\n")}`
    : "";

  // The project's recurring-element bible so characters/props stay on-model.
  const elements = await loadElements(projectId);
  const elementsBlock = elements.length > 0 ? `\n\n${formatElementsBlock(elements)}` : "";

  // Restate the canvas shape in the directive (the sub-agent's highest-attention
  // zone) so it composes for the right orientation — the PROJECT/CANVAS blocks
  // above are easy to under-weight in a long prompt.
  const canvasShape = project?.width && project?.height
    ? (project.width === project.height ? "SQUARE" : project.width > project.height ? "LANDSCAPE" : "PORTRAIT")
    : "";
  const canvasLine = project?.width && project?.height
    ? `\n- CANVAS: this frame is ${project.width}×${project.height}px — aspect ${project.aspectRatio}, ${canvasShape}. Compose the layout to FILL this shape (${project.width > project.height ? "spread elements horizontally; use full-width establishing regions" : project.width < project.height ? "stack elements top-to-bottom; favor full-height subjects" : "balance the square"}). The 0–1000 grid is normalized per axis, so equal x/y spans are NOT square on screen — size boxes for this canvas and verify with render_layout_image.`
    : "";

  // Optional user-supplied instructions for sub-agents (Settings → Sub-agents),
  // appended verbatim to the end so they carry the highest recency weight.
  const [promptRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, "subAgentSystemPromptAppend"));
  const customInstructions = promptRow?.value?.trim();
  const customBlock = customInstructions
    ? `\n\nADDITIONAL INSTRUCTIONS (from user configuration — follow these, they take precedence on any conflict with the above):\n${customInstructions}`
    : "";

  const systemPrompt = `${baseSystemPrompt}

SUB-AGENT MODE — You are a focused sub-agent responsible ONLY for frame ${img.id}. An orchestrating agent has delegated this single frame to you with the brief below.${canvasLine}
- Compose a COMPLETE, DETAILED layout for this frame (high-level description, style, palette, and well-placed regions), then render it (generate_image), view the result, and self-correct until it matches the brief.
- Your tools act on this frame only; you cannot create, delete, reorder, or edit other frames. Follow any attached styleguides.
- CONSISTENCY: if a RECURRING ELEMENT listed below appears in your frame, describe it EXACTLY as specified (call list_recurring_elements if you need to re-check the bible). If your frame introduces a character, costume, prop, or location that will (or could) recur and has no canonical description yet, write a detailed, reusable appearance for it (age/build/face/hair, exact clothing and colors as UPPERCASE hex, distinguishing features) and call describe_recurring_element to register it so later frames match. Never leave a recurring character described only vaguely.
- LEARN FORWARD: whenever a fix you make would help someone building ANOTHER frame in this project (a composition/layout/style/palette/text or Ideogram pitfall), call record_learnings with short, reusable notes so future sub-agents get it right the first time. Record only generalizable lessons, not frame-specific content.
- When done, finish with a concise SUMMARY for the orchestrator: what you composed (key regions, style, palette), the final generation status, WHAT YOU HAD TO REFINE and why (so the orchestrator can steer later frames), and anything needed for continuity with neighboring frames.${elementsBlock}${learningsBlock}${customBlock}`;

  // Whether the sub-agent's model can accept image content (vision).
  const [visRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, "visionCapable"));
  const visionCapable = visRow?.value === "true";

  const allTools = getSubAgentToolDefinitions(visionCapable);

  // Prior side-chat for this frame (before persisting the new brief) so repeated
  // delegations continue rather than restart.
  const priorRows = await db.select().from(schema.imageChatMessages)
    .where(eq(schema.imageChatMessages.imageId, imageId))
    .orderBy(asc(schema.imageChatMessages.createdAt));
  type ChatRow = typeof priorRows[number];
  const priorHistory = priorRows
    .filter((r: ChatRow) => (r.role === "user" || r.role === "assistant") && typeof r.content === "string" && r.content.trim().length > 0)
    .map((r: ChatRow) => ({ role: r.role, content: r.content }));

  const ref = { scope: "image" as const, id: imageId };

  // Persist the brief as the new user turn BEFORE the run's assistant placeholder
  // (user→assistant order), matching the /chat route.
  const briefMsg = { id: newId(), content: brief, createdAt: new Date().toISOString() };
  await persistUserMessage(ref, { id: briefMsg.id, role: "user", content: briefMsg.content, createdAt: briefMsg.createdAt });

  let run;
  try {
    run = await registry.create(ref, { projectId });
  } catch (err) {
    if (err instanceof RunConflictError) {
      return { success: false, summary: `Frame ${imageId} is busy (someone is chatting on it). Try delegating again shortly.`, status: "error" };
    }
    throw err;
  }

  const subAgentConfig: LLMConfig = await getSubAgentLLMConfig();
  const contextWindow = await getContextWindowSize();

  const conversation: AgentLoopContext["conversation"] = [
    { role: "system", content: systemPrompt },
    ...priorHistory,
    { role: "user", content: brief },
  ];

  const ctx: AgentLoopContext = {
    conversation,
    allTools,
    toolsJson: JSON.stringify(allTools),
    contextWindow,
    threshold: Math.floor(contextWindow * 0.8),
    visionCapable,
    activePlanContext: null,
    projectId,
    systemPrompt,
    latestUserMessage: { id: briefMsg.id, content: briefMsg.content, createdAt: briefMsg.createdAt },
    clientMessageCount: priorHistory.length + 1,
    uploadsDir: getUploadsDir(),
  };

  const deps: Partial<AgentLoopDeps> = {
    streamChat: (conv, tools) => streamChat(conv as any, tools as any, subAgentConfig),
    executeToolCall: (name, args, _projectId, undoCtx) => executeSubAgentToolCall(name, args, projectId, imageId, undoCtx),
    isExternalTool: () => false,
    callExternalTool: async () => ({ success: false, result: { error: "no external tools in a sub-agent" } }),
  };

  await runAgentLoop(run, ctx, deps);

  const [after] = await db.select({ status: schema.images.status }).from(schema.images).where(eq(schema.images.id, imageId));
  const summary = run.content.trim() || `Sub-agent finished work on frame ${imageId} (status: ${after?.status ?? "unknown"}).`;

  return {
    success: run.status === "complete",
    summary,
    status: run.status,
    imageStatus: after?.status,
  };
}
