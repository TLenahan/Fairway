import { DataStore } from '@golf/types';
import { z } from 'zod';

/**
 * @golf/mcp — the Model Context Protocol tool surface over the practice
 * history (BUILD_SPEC Phase 5).
 *
 * TWO RULES HOLD EVERYWHERE IN THIS LIB.
 *
 * 1. READ-ONLY. Every tool here answers a question; none of them changes the
 *    store. That is not a convention to remember — the tools receive a
 *    `DataStore` but the hub opens the database read-only for this process
 *    (apps/hub/src/mcp), so a write would fail at the driver rather than
 *    quietly succeed. It matters because an MCP client calls these tools
 *    speculatively: a model exploring "what happened to my 7 iron" must not
 *    be able to prescribe a training block as a side effect. The prescription
 *    loop stays where it belongs, in the hub (see program-runner.ts).
 *
 * 2. THE ENGINE IS THE ONLY SOURCE OF NUMBERS. Tools project and filter what
 *    `@golf/insights` computed; they never re-derive a statistic. A tool that
 *    computed its own dispersion would be a second engine with its own
 *    thresholds, and the two would disagree the first time a config value
 *    moved.
 *
 * Wire shapes are snake_case — these are LLM-facing payloads, the same
 * convention `@golf/insights`'s wire and `@golf/coach`'s export already use.
 */

export interface ToolContext {
  data: DataStore;
}

/**
 * A tool as the transport sees it: a name, prose the model reads to decide
 * whether to call it, an input schema, and a handler that returns a plain
 * JSON-serializable value. Serializing that value and framing it as MCP
 * content is the transport's job, not the tool's — which is what keeps this
 * whole lib testable without a protocol implementation in sight.
 */
export interface FairwayTool {
  name: string;
  title: string;
  description: string;
  /** zod raw shape; the transport converts it to the wire JSON Schema */
  inputSchema: z.ZodRawShape;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Bind a tool's argument schema once so the handler receives parsed, typed
 * args and the transport still gets the raw shape to publish.
 *
 * The schema is STRICT. An unknown argument means the model invented a filter
 * this tool does not have — silently ignoring it would answer a different
 * question than the one asked, with full confidence and no way for the caller
 * to tell. Failing is the only honest response.
 */
export function defineTool<Shape extends z.ZodRawShape>(spec: {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  run(
    ctx: ToolContext,
    args: z.infer<z.ZodObject<Shape>>,
  ): Promise<unknown>;
}): FairwayTool {
  const schema = z.object(spec.inputSchema).strict();
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: (ctx, args) => spec.run(ctx, schema.parse(args)),
  };
}
