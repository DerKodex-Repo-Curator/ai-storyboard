import { Hono } from "hono";
import { getToolDefinitions, getContextWindowSize, summarizeConversation, getSubAgentsEnabled, getDelegateToolDefinition } from "../lib/llm";
import { executeToolCall as realExecuteToolCall } from "../lib/toolExecutor";
import { runSubAgent } from "../lib/subAgent";
import {
  loadElements,
  getRecurringElementToolDefinitions,
  executeElementTool,
  ELEMENT_TOOL_NAMES,
} from "../lib/recurringElements";
import { db, schema } from "../db/client";
import { eq, and, asc, notInArray } from "drizzle-orm";
import { newId } from "../lib/nanoid";
import { getSystemPrompt } from "../lib/systemPrompt";
import { getStyleguideSystemPrompt } from "../lib/styleguideSystemPrompt";
import { getStyleguideToolDefinitions, executeStyleguideToolCall } from "../lib/tools/styleguideOps";
import { loadAttachedStyleguides } from "../lib/styleguideContext";
import { mcpClientManager } from "../lib/mcp/clientManager";
import { getUploadsDir } from "../lib/config";
import {
  processAttachments,
  stripImageContentWithVisionFallback,
} from "../lib/chatHelpers";
import { getComfyDisabledWorkflowIds } from "../lib/comfyuiClient";
import { getDisabledToolBuckets, filterToolsByBuckets } from "../lib/toolBuckets";
import { parseLayout } from "../lib/layout";
import {
  conversationKeyFromRequest,
  makeConversationKey,
  type ConversationRef,
} from "../lib/conversationKey";
import { registry, RunConflictError } from "../lib/agentRuns";
import { runAgentLoop, type AgentLoopContext, type AgentLoopDeps } from "../lib/agentLoop";
import { persistUserMessage } from "../lib/chatPersistence";

const app = new Hono();

/** Thrown by a context builder when its target conversation doesn't exist. */
class ConversationNotFound extends Error {}

/** The scope-specific pieces the agent loop needs, assembled per request. */
interface LoopSetup {
  conversation: AgentLoopContext["conversation"];
  allTools: unknown[];
  toolsJson: string;
  systemPrompt: string;
  visionCapable: boolean;
  activePlanContext: AgentLoopContext["activePlanContext"];
  /** projectId for tool execution + run grouping (null for styleguide chat). */
  projectId: string | null;
  /** Loop dependency overrides — styleguide chat swaps in its own tool executor. */
  deps?: Partial<AgentLoopDeps>;
}

/** Resolve attachments and drop empty assistant messages (shared by every scope). */
async function processClientMessages(clientMessages: any[]) {
  return (
    await Promise.all(clientMessages.map(processAttachments))
  ).filter((m: { role: string; content: unknown }) => {
    if (m.role !== "assistant") return true;
    if (Array.isArray(m.content)) return m.content.length > 0;
    return typeof m.content === "string" && m.content.trim().length > 0;
  });
}

/** Build the loop context for project- and image-scoped chats (the storyboard agent). */
async function buildProjectContext(
  projectId: string | null,
  selectedImageId: string | null,
  clientMessages: unknown[],
  isMainThread: boolean,
): Promise<LoopSetup> {
  const [project] = projectId
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    : [null];

  // Storyboard images, ordered.
  const imageRows = projectId
    ? await db.select().from(schema.images).where(eq(schema.images.projectId, projectId)).orderBy(asc(schema.images.order))
    : [];
  const images = imageRows.map((img) => {
    let highLevel = "";
    let regionCount = 0;
    try {
      const layout = parseLayout(img.layout);
      highLevel = layout.high_level_description;
      regionCount = layout.compositional_deconstruction.length;
    } catch { /* ignore */ }
    return { id: img.id, order: img.order, name: img.name ?? "", status: img.status, highLevelDescription: highLevel, regionCount };
  });

  // Selected image (full layout for focused editing).
  let selectedImageDetails: Record<string, unknown> | undefined;
  if (selectedImageId) {
    const [img] = await db.select().from(schema.images).where(eq(schema.images.id, selectedImageId));
    if (img) {
      selectedImageDetails = {
        id: img.id, order: img.order, name: img.name, status: img.status,
        layout: parseLayout(img.layout), plainPrompt: img.plainPrompt, negativePrompt: img.negativePrompt,
      };
    }
  }

  // Available generation workflows.
  const disabledWorkflowIds = await getComfyDisabledWorkflowIds();
  const workflowRows = await db.select().from(schema.workflows);
  const availableWorkflows = workflowRows
    .filter((workflow) => !disabledWorkflowIds.has(workflow.id))
    .map((w) => ({ id: w.id, name: w.name, description: w.description || "", type: w.workflowType, isDefault: w.isDefault === 1 }));

  // Active plan.
  let activePlanContext:
    | { id: string; title: string; status: string; steps: Array<{ id: string; label: string; status: string; notes?: string }> }
    | null = null;
  if (projectId) {
    const [planRow] = await db.select().from(schema.plans)
      .where(and(eq(schema.plans.projectId, projectId), notInArray(schema.plans.status, ["completed", "cancelled"])))
      .limit(1);
    if (planRow) {
      let steps: Array<{ id: string; label: string; status: string; notes?: string }> = [];
      try { steps = JSON.parse(planRow.steps); } catch { /* corrupt plan steps — treat as empty */ }
      activePlanContext = { id: planRow.id, title: planRow.title, status: planRow.status, steps };
    }
  }

  // Recent assets.
  let recentAssets: Array<{ id: string; type: string; prompt: string | null; description: string | null; createdAt: string }> | undefined;
  if (projectId) {
    const assetRows = await db.select().from(schema.assets)
      .where(eq(schema.assets.projectId, projectId))
      .orderBy(schema.assets.createdAt)
      .limit(10);
    if (assetRows.length > 0) {
      recentAssets = assetRows.reverse().map((a) => ({ id: a.id, type: a.type, prompt: a.prompt, description: a.description || null, createdAt: a.createdAt }));
    }
  }

  const attachedStyleguides = project?.id ? await loadAttachedStyleguides(project.id) : [];

  // Sub-agent delegation is offered only to the project main thread (the
  // orchestrator); an image side-chat is itself the per-frame scope. Read it
  // before the system prompt so the prompt can teach the agent to delegate.
  const subAgentsEnabled = projectId && isMainThread ? await getSubAgentsEnabled() : false;
  // Surface the recurring-element bible to the orchestrator so it keeps briefs
  // consistent with the canonical descriptions sub-agents register.
  const recurringElements = subAgentsEnabled && projectId ? await loadElements(projectId) : [];

  const [promptRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, "systemPromptAppend"));
  const customInstructions = promptRow?.value || undefined;

  const systemPrompt = getSystemPrompt({
    projectName: project?.name,
    aspectRatio: project?.aspectRatio,
    megapixels: project?.megapixels ?? undefined,
    width: project?.width,
    height: project?.height,
    promptFormat: project?.promptFormat,
    activePlan: activePlanContext,
    images,
    selectedImageId: selectedImageId ?? undefined,
    selectedImageDetails,
    availableWorkflows: availableWorkflows.length > 0 ? availableWorkflows : undefined,
    recentAssets,
    attachedStyleguides: attachedStyleguides.length > 0 ? attachedStyleguides : undefined,
    subAgentsEnabled,
    recurringElements: recurringElements.length > 0 ? recurringElements : undefined,
    customInstructions,
  });

  // Whether the configured LLM can accept image content. Many OpenAI-compatible
  // endpoints (e.g. DeepSeek) are text-only and reject image_url parts with a
  // 400, so we only offer/inject vision features when this is on.
  const [visRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, "visionCapable"));
  const visionCapable = visRow?.value === "true";

  const baseTools = getToolDefinitions();
  const disabledBuckets = projectId ? await getDisabledToolBuckets(projectId) : new Set<string>();
  let tools = filterToolsByBuckets(baseTools, disabledBuckets);
  // render_layout_image and view_image only make sense for vision models — hide
  // them otherwise so the agent uses the ASCII render_layout / text inspection.
  if (!visionCapable) {
    const visionOnly = new Set(["render_layout_image", "view_image"]);
    tools = tools.filter((t) => !visionOnly.has(t.function?.name ?? ""));
  }
  const externalTools = mcpClientManager.getAllToolDefinitions();

  // When delegation is enabled, the orchestrator gets delegate_image plus the
  // shared bible tools, and a tool executor that intercepts all three (delegate
  // runs a scoped sub-agent; the bible tools manage recurring elements directly
  // so the orchestrator can establish/correct canon without delegating a frame).
  const delegateTools = subAgentsEnabled
    ? [getDelegateToolDefinition(), ...getRecurringElementToolDefinitions()]
    : [];
  const deps: Partial<AgentLoopDeps> | undefined = subAgentsEnabled && projectId
    ? {
        executeToolCall: async (name, args, pid, undoCtx) => {
          if (name === "delegate_image") {
            const imageId = String(args.image_id ?? "");
            const brief = String(args.brief ?? "");
            if (!imageId || !brief) {
              return { success: false, result: "delegate_image requires image_id and brief." };
            }
            const res = await runSubAgent({ imageId, projectId, brief });
            return { success: res.success, result: { summary: res.summary, status: res.status, image_status: res.imageStatus } };
          }
          if ((ELEMENT_TOOL_NAMES as readonly string[]).includes(name)) {
            return executeElementTool(name, args, projectId);
          }
          return realExecuteToolCall(name, args, (pid as string) ?? projectId, undoCtx);
        },
      }
    : undefined;

  const allTools = [...tools, ...delegateTools, ...externalTools];

  const conversation: AgentLoopContext["conversation"] = [
    { role: "system", content: systemPrompt },
    ...(await processClientMessages(clientMessages)),
  ];

  // Text-only model: drop any attached image content up front so we never send
  // image_url parts the endpoint would reject.
  if (!visionCapable) {
    await stripImageContentWithVisionFallback(conversation, getUploadsDir());
  }

  return {
    conversation,
    allTools,
    toolsJson: JSON.stringify(allTools),
    systemPrompt,
    visionCapable,
    activePlanContext,
    projectId: projectId ?? null,
    deps,
  };
}

/** Build the loop context for styleguide chat: styleguide prompt, styleguide
 *  tools, and a tool executor bound to this styleguide. */
async function buildStyleguideContext(styleguideId: string, clientMessages: unknown[]): Promise<LoopSetup> {
  const [sg] = await db.select().from(schema.styleguides).where(eq(schema.styleguides.id, styleguideId));
  if (!sg) throw new ConversationNotFound("Styleguide not found");

  const systemPrompt = await getStyleguideSystemPrompt(styleguideId);
  const allTools = getStyleguideToolDefinitions();

  const conversation: AgentLoopContext["conversation"] = [
    { role: "system", content: systemPrompt },
    ...(await processClientMessages(clientMessages)),
  ];

  return {
    conversation,
    allTools,
    toolsJson: JSON.stringify(allTools),
    systemPrompt,
    // Styleguide editing has no storyboard, plan, or vision-only tools; the loop's
    // vision fallback still strips images if the endpoint rejects them.
    visionCapable: false,
    activePlanContext: null,
    projectId: null,
    deps: {
      executeToolCall: (name, args) => executeStyleguideToolCall(name, args, styleguideId),
      isExternalTool: () => false,
      callExternalTool: async () => ({ success: false, result: { error: "no external tools in styleguide chat" } }),
    },
  };
}

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const { messages: clientMessages, projectId, selectedImageId, chatScope, styleguideId, userMessageId } = body;

  // Which conversation does this turn belong to? Styleguide wins, then an
  // image-scoped side chat, else the project main thread.
  const convRef: ConversationRef | null = conversationKeyFromRequest({ styleguideId, projectId, selectedImageId, chatScope });
  if (!convRef) {
    return c.json({ error: "no conversation: provide a projectId or styleguideId" }, 400);
  }

  let setup: LoopSetup;
  try {
    setup = convRef.scope === "styleguide"
      ? await buildStyleguideContext(convRef.id, clientMessages ?? [])
      : await buildProjectContext(projectId ?? null, selectedImageId ?? null, clientMessages ?? [], convRef.scope === "project");
  } catch (err) {
    if (err instanceof ConversationNotFound) return c.json({ error: err.message }, 404);
    throw err;
  }

  const contextWindow = await getContextWindowSize();
  const threshold = Math.floor(contextWindow * 0.8);

  // Reject up front if this conversation is already busy, so we don't persist a
  // user message for a turn we're not going to run.
  const existing = registry.getActiveForKey(makeConversationKey(convRef.scope, convRef.id));
  if (existing) {
    return c.json({ error: "a run is already active for this conversation", runId: existing.id }, 409);
  }

  // The new user turn is the last client message. Persist it server-side FIRST
  // (before the run's assistant placeholder) so message order is user→assistant,
  // and so a background run survives the client switching away.
  const lastClient = clientMessages?.[clientMessages.length - 1];
  const userMsg = lastClient && lastClient.role === "user"
    ? {
        id: userMessageId || newId(),
        content: typeof lastClient.content === "string" ? lastClient.content : JSON.stringify(lastClient.content),
        createdAt: new Date().toISOString(),
      }
    : null;
  if (userMsg) {
    await persistUserMessage(convRef, { id: userMsg.id, role: "user", content: userMsg.content, createdAt: userMsg.createdAt });
  }

  let run;
  try {
    run = await registry.create(convRef, { projectId: setup.projectId });
  } catch (err) {
    if (err instanceof RunConflictError) {
      return c.json({ error: "a run is already active for this conversation", runId: err.existingRunId }, 409);
    }
    throw err;
  }

  const ctx: AgentLoopContext = {
    conversation: setup.conversation,
    allTools: setup.allTools,
    toolsJson: setup.toolsJson,
    contextWindow,
    threshold,
    visionCapable: setup.visionCapable,
    activePlanContext: setup.activePlanContext,
    projectId: setup.projectId,
    systemPrompt: setup.systemPrompt,
    latestUserMessage: userMsg ? { id: userMsg.id, content: userMsg.content, createdAt: userMsg.createdAt } : null,
    clientMessageCount: clientMessages?.length ?? 0,
    uploadsDir: getUploadsDir(),
  };

  // Fire the loop detached from this request. It runs against the run's own
  // abort signal (cancel), not the HTTP connection, and owns persistence.
  void runAgentLoop(run, ctx, setup.deps).catch((e) => console.error("[chat] detached run failed:", e));

  return c.json({ runId: run.id, assistantMsgId: run.assistantMsgId });
});

app.post("/chat/summarize", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.projectId) return c.json({ error: "projectId required" }, 400);
  const { projectId } = body;
  const rows = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.projectId, projectId));
  const messages = rows.map((r) => ({ role: r.role, content: r.content }));
  const summary = await summarizeConversation(messages);
  const messageId = newId();
  await db.delete(schema.chatMessages).where(eq(schema.chatMessages.projectId, projectId));
  await db.insert(schema.chatMessages).values({
    id: messageId, projectId, role: "system", content: summary, thinking: null, toolCalls: null, segments: null, createdAt: new Date().toISOString(),
  });
  return c.json({ summary, messageId });
});

export default app;
