import { readFile } from "node:fs/promises";
import type {
  Trajectory,
  ParseResult,
  Step,
  ToolCall,
  Observation,
  ObservationResult,
  Metrics,
  FinalMetrics,
  Agent,
  ToolDefinition,
} from "../types.js";

interface HarFile {
  log: {
    version: string;
    entries: HarEntry[];
  };
}

interface HarEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    postData?: { text: string; mimeType: string };
  };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content: { text?: string; mimeType: string };
  };
  _webSocketMessages?: WebSocketMessage[];
}

interface WebSocketMessage {
  type: "send" | "receive";
  time: number;
  opcode: number;
  data: string;
}

type ApiFormat = "openai-chat" | "openai-responses" | "anthropic-messages";

interface ParsedExchange {
  timestamp: string;
  apiFormat: ApiFormat;
  model: string;
  request: Record<string, unknown>;
  responseEvents: Record<string, unknown>[];
  requestHeaders: Record<string, string>;
}

export async function parseHar(filePath: string): Promise<ParseResult> {
  const raw = await readFile(filePath, "utf-8");
  const har: HarFile = JSON.parse(raw);

  const exchanges = extractExchanges(har);
  if (exchanges.length === 0) {
    throw new Error("No LLM API calls found in HAR file");
  }

  // Determine the primary model (most-used non-utility model)
  const primaryModel = detectPrimaryModel(exchanges);
  const agent = buildAgent(exchanges, primaryModel);
  const steps = buildSteps(exchanges);
  const finalMetrics = computeFinalMetrics(steps);

  return {
    trajectory: {
      schema_version: "ATIF-v1.7",
      session_id: generateSessionId(har),
      agent,
      steps,
      final_metrics: finalMetrics,
      notes: `Converted from HAR file: ${filePath}`,
    },
  };
}

function extractExchanges(har: HarFile): ParsedExchange[] {
  const exchanges: ParsedExchange[] = [];

  for (const entry of har.log.entries) {
    // WebSocket entry: GET /responses with _webSocketMessages
    if (entry._webSocketMessages && entry._webSocketMessages.length > 0) {
      exchanges.push(...extractWebSocketExchanges(entry));
      continue;
    }

    if (entry.request.method !== "POST") continue;

    const url = entry.request.url;
    const apiFormat = detectApiFormat(url);
    if (!apiFormat) continue;

    const requestBody = entry.request.postData?.text;
    if (!requestBody) continue;

    let request: Record<string, unknown>;
    try {
      request = JSON.parse(requestBody);
    } catch {
      continue;
    }

    const responseText = entry.response.content.text;
    if (!responseText) continue;

    const responseEvents = parseSseStream(responseText, apiFormat);
    const model = (request.model as string) || "unknown";

    const headers: Record<string, string> = {};
    for (const h of entry.request.headers) {
      headers[h.name.toLowerCase()] = h.value;
    }

    exchanges.push({
      timestamp: entry.startedDateTime,
      apiFormat,
      model,
      request,
      responseEvents,
      requestHeaders: headers,
    });
  }

  return exchanges;
}

function extractWebSocketExchanges(entry: HarEntry): ParsedExchange[] {
  const exchanges: ParsedExchange[] = [];
  const wsMessages = entry._webSocketMessages!;

  const headers: Record<string, string> = {};
  for (const h of entry.request.headers) {
    headers[h.name.toLowerCase()] = h.value;
  }

  // Group messages into turns: each "response.create" send starts a new turn,
  // receive messages until the next send (or end) are its response events.
  const turns: { send: Record<string, unknown>; sendTime: number; receives: Record<string, unknown>[] }[] = [];
  let currentTurn: { send: Record<string, unknown>; sendTime: number; receives: Record<string, unknown>[] } | null = null;

  for (const msg of wsMessages) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(msg.data);
    } catch {
      continue;
    }

    if (msg.type === "send" && data.type === "response.create") {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = { send: data, sendTime: msg.time, receives: [] };
    } else if (msg.type === "receive" && currentTurn) {
      // Set _event_type from the message's type field so existing
      // extractOpenAIResponsesAgentStep can process these events
      data._event_type = data.type;
      currentTurn.receives.push(data);
    }
  }
  if (currentTurn) {
    turns.push(currentTurn);
  }

  for (const turn of turns) {
    const model = (turn.send.model as string) || "unknown";
    const timestamp = new Date(turn.sendTime * 1000).toISOString();

    exchanges.push({
      timestamp,
      apiFormat: "openai-responses",
      model,
      request: turn.send,
      responseEvents: turn.receives,
      requestHeaders: headers,
    });
  }

  return exchanges;
}

function detectApiFormat(url: string): ApiFormat | null {
  if (url.includes("/v1/messages")) return "anthropic-messages";
  if (url.includes("/responses")) return "openai-responses";
  if (url.includes("/chat/completions")) return "openai-chat";
  return null;
}

function parseSseStream(
  text: string,
  apiFormat: ApiFormat
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const lines = text.split("\n");

  if (apiFormat === "anthropic-messages") {
    // Anthropic uses named events: event: type\ndata: json
    let currentEventType: string | null = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (currentEventType) {
            parsed._event_type = currentEventType;
          }
          events.push(parsed);
        } catch {
          // skip malformed events
        }
        currentEventType = null;
      }
    }
  } else {
    // OpenAI uses: event: type\ndata: json  OR  data: json
    let currentEventType: string | null = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (currentEventType) {
            parsed._event_type = currentEventType;
          }
          events.push(parsed);
        } catch {
          // skip malformed events
        }
        currentEventType = null;
      }
    }
  }

  return events;
}

function detectPrimaryModel(exchanges: ParsedExchange[]): string {
  const modelCounts = new Map<string, number>();
  for (const ex of exchanges) {
    // Skip utility models (title generation, etc.)
    if (ex.model.includes("mini") || ex.model.includes("small")) continue;
    modelCounts.set(ex.model, (modelCounts.get(ex.model) || 0) + 1);
  }
  if (modelCounts.size === 0 && exchanges.length > 0) {
    return exchanges[0].model;
  }
  let best = "";
  let bestCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best || "unknown";
}

function buildAgent(
  exchanges: ParsedExchange[],
  primaryModel: string
): Agent {
  const agent: Agent = {
    name: "copilot-chat",
    version: extractEditorVersion(exchanges),
    model_name: primaryModel,
  };

  // Extract tool definitions from the first main exchange
  const mainExchange = exchanges.find(
    (e) => e.apiFormat !== "openai-chat" || e.model === primaryModel
  );
  if (mainExchange) {
    const tools = extractToolDefinitions(mainExchange);
    if (tools.length > 0) {
      agent.tool_definitions = tools;
    }
  }

  return agent;
}

function extractEditorVersion(exchanges: ParsedExchange[]): string {
  for (const ex of exchanges) {
    const pluginVersion = ex.requestHeaders["editor-plugin-version"];
    if (pluginVersion) return pluginVersion;
  }
  return "unknown";
}

function extractToolDefinitions(
  exchange: ParsedExchange
): ToolDefinition[] {
  const tools = exchange.request.tools as unknown[];
  if (!Array.isArray(tools)) return [];

  return tools.map((tool: unknown) => {
    const t = tool as Record<string, unknown>;

    if (exchange.apiFormat === "anthropic-messages") {
      // Anthropic format: { name, description, input_schema }
      return {
        type: "function",
        function: {
          name: t.name as string,
          description: t.description as string | undefined,
          parameters: t.input_schema as Record<string, unknown> | undefined,
        },
      };
    }

    // OpenAI format: { type: "function", name, description, parameters }
    // or nested: { type: "function", function: { name, ... } }
    if (t.function) {
      const fn = t.function as Record<string, unknown>;
      return {
        type: "function",
        function: {
          name: fn.name as string,
          description: fn.description as string | undefined,
          parameters: fn.parameters as Record<string, unknown> | undefined,
        },
      };
    }

    return {
      type: "function",
      function: {
        name: t.name as string,
        description: t.description as string | undefined,
        parameters: t.parameters as Record<string, unknown> | undefined,
      },
    };
  });
}

function buildSteps(exchanges: ParsedExchange[]): Step[] {
  const steps: Step[] = [];

  // Group exchanges into conversations (main agent calls vs utility calls)
  // Utility calls are lightweight models (mini/small) doing title generation etc.
  const mainExchanges: ParsedExchange[] = [];
  const utilityExchanges: ParsedExchange[] = [];

  for (const ex of exchanges) {
    if (ex.model.includes("mini") || ex.model.includes("small")) {
      // Only mark as utility if it looks like a utility call (short messages, title gen)
      const messages = (ex.request.messages || ex.request.input) as unknown[];
      if (Array.isArray(messages) && messages.length <= 3) {
        utilityExchanges.push(ex);
        continue;
      }
    }
    mainExchanges.push(ex);
  }

  // Process main conversation exchanges
  // Each HTTP request carries full history. We only want NEW content per exchange.
  let systemEmitted = false;
  let prevAgentStep: Step | null = null;
  let prevUserMsgCount = 0;

  for (let i = 0; i < mainExchanges.length; i++) {
    const exchange = mainExchanges[i];

    // Extract system prompt (only from first exchange)
    if (!systemEmitted) {
      const systemStep = extractSystemStep(exchange);
      if (systemStep) {
        steps.push(systemStep);
        systemEmitted = true;
      }
    }

    // Attach tool results from this request to the PREVIOUS agent step
    if (prevAgentStep) {
      const observations = extractToolResultsFromRequest(exchange);
      // Only keep results whose source_call_id matches a tool_call in this step
      // (requests replay the full conversation history, so we must filter out
      // results from earlier rounds)
      const prevToolCallIds = new Set(
        (prevAgentStep.tool_calls || []).map((tc) => tc.tool_call_id)
      );
      const relevant = observations.filter(
        (o) => o.source_call_id && prevToolCallIds.has(o.source_call_id)
      );
      if (relevant.length > 0) {
        prevAgentStep.observation = { results: relevant };
      }
    }

    // Only emit a user step when the count of real (non-tool-result) user
    // messages has increased compared to the previous exchange — that means
    // a genuinely new user message was added, not just replayed context.
    const currentUserMsgCount = countNonToolUserMessages(exchange);
    if (currentUserMsgCount > prevUserMsgCount) {
      const userMessage = extractLastUserMessage(exchange);
      if (userMessage) {
        steps.push({ ...userMessage, step_id: 0 }); // step_id renumbered later
      }
    }
    prevUserMsgCount = currentUserMsgCount;

    // Extract agent response from SSE events
    const agentStep = extractAgentStep(exchange, 0);
    if (agentStep) {
      steps.push(agentStep);
      prevAgentStep = agentStep;
    }
  }

  // Renumber step IDs sequentially
  for (let i = 0; i < steps.length; i++) {
    steps[i].step_id = i + 1;
  }

  return steps;
}

function extractSystemStep(exchange: ParsedExchange): Step | null {
  if (exchange.apiFormat === "anthropic-messages") {
    const system = exchange.request.system as unknown;
    if (Array.isArray(system) && system.length > 0) {
      const text = (system as Record<string, unknown>[])
        .filter((s) => s.type === "text")
        .map((s) => s.text as string)
        .join("\n");
      if (text) {
        return {
          step_id: 0,
          timestamp: exchange.timestamp,
          source: "system",
          message: text,
        };
      }
    }
  } else if (exchange.apiFormat === "openai-responses") {
    const input = exchange.request.input as unknown[];
    if (Array.isArray(input)) {
      for (const item of input) {
        const m = item as Record<string, unknown>;
        if (m.role === "system") {
          const content = m.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = (content as Record<string, unknown>[])
              .filter((c) => c.type === "input_text" || c.type === "text")
              .map((c) => c.text as string)
              .join("\n");
          }
          if (text) {
            return {
              step_id: 0,
              timestamp: exchange.timestamp,
              source: "system",
              message: text,
            };
          }
        }
      }
    }
  } else {
    // openai-chat
    const messages = exchange.request.messages as unknown[];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const m = msg as Record<string, unknown>;
        if (m.role === "system") {
          return {
            step_id: 0,
            timestamp: exchange.timestamp,
            source: "system",
            message: m.content as string,
          };
        }
      }
    }
  }
  return null;
}

function extractToolResultsFromRequest(
  exchange: ParsedExchange
): ObservationResult[] {
  const results: ObservationResult[] = [];

  if (exchange.apiFormat === "anthropic-messages") {
    const messages = exchange.request.messages as unknown[];
    if (!Array.isArray(messages)) return results;
    for (const msg of messages) {
      const m = msg as Record<string, unknown>;
      if (m.role !== "user") continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as Record<string, unknown>[]) {
        if (c.type === "tool_result") {
          const resultContent = c.content;
          let text = "";
          if (typeof resultContent === "string") {
            text = resultContent;
          } else if (Array.isArray(resultContent)) {
            text = (resultContent as Record<string, unknown>[])
              .filter((r) => r.type === "text")
              .map((r) => r.text as string)
              .join("\n");
          }
          results.push({
            source_call_id: c.tool_use_id as string,
            content: text,
          });
        }
      }
    }
  } else if (exchange.apiFormat === "openai-responses") {
    const input = exchange.request.input as unknown[];
    if (!Array.isArray(input)) return results;
    for (const item of input) {
      const m = item as Record<string, unknown>;
      if (m.type === "function_call_output") {
        results.push({
          source_call_id: m.call_id as string,
          content: m.output as string,
        });
      }
    }
  }

  return results;
}

function countNonToolUserMessages(exchange: ParsedExchange): number {
  if (exchange.apiFormat === "anthropic-messages") {
    const messages = exchange.request.messages as unknown[];
    if (!Array.isArray(messages)) return 0;
    return messages.filter((msg) => {
      const m = msg as Record<string, unknown>;
      if (m.role !== "user") return false;
      const content = m.content;
      if (Array.isArray(content)) {
        return !(content as Record<string, unknown>[]).some(
          (c) => c.type === "tool_result"
        );
      }
      return true;
    }).length;
  }

  if (exchange.apiFormat === "openai-responses") {
    const input = exchange.request.input as unknown[];
    if (!Array.isArray(input)) return 0;
    return input.filter((item) => {
      const m = item as Record<string, unknown>;
      return m.role === "user";
    }).length;
  }

  // openai-chat
  const messages = exchange.request.messages as unknown[];
  if (!Array.isArray(messages)) return 0;
  return messages.filter(
    (m) => (m as Record<string, unknown>).role === "user"
  ).length;
}

function extractLastUserMessage(
  exchange: ParsedExchange
): Step | null {
  if (exchange.apiFormat === "anthropic-messages") {
    const messages = exchange.request.messages as unknown[];
    if (!Array.isArray(messages)) return null;

    // Find the last user message that isn't a tool_result
    const userMessages = messages.filter((msg) => {
      const m = msg as Record<string, unknown>;
      if (m.role !== "user") return false;
      const content = m.content;
      if (Array.isArray(content)) {
        return !(content as Record<string, unknown>[]).some(
          (c) => c.type === "tool_result"
        );
      }
      return true;
    });

    if (userMessages.length === 0) return null;
    const lastUser = userMessages[userMessages.length - 1] as Record<
      string,
      unknown
    >;

    const content = lastUser.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as Record<string, unknown>[])
        .filter((c) => c.type === "text")
        .map((c) => c.text as string)
        .join("\n");
    }

    if (text) {
      return {
        step_id: 0,
        timestamp: exchange.timestamp,
        source: "user",
        message: text,
      };
    }
  } else if (exchange.apiFormat === "openai-responses") {
    const input = exchange.request.input as unknown[];
    if (!Array.isArray(input)) return null;

    // Find the last user message
    const userMessages = input.filter((item) => {
      const m = item as Record<string, unknown>;
      return m.role === "user";
    });

    if (userMessages.length === 0) return null;
    const lastUser = userMessages[userMessages.length - 1] as Record<
      string,
      unknown
    >;

    const content = lastUser.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as Record<string, unknown>[])
        .filter((c) => c.type === "input_text" || c.type === "text")
        .map((c) => c.text as string)
        .join("\n");
    }

    if (text) {
      return {
        step_id: 0,
        timestamp: exchange.timestamp,
        source: "user",
        message: text,
      };
    }
  } else {
    // openai-chat
    const messages = exchange.request.messages as unknown[];
    if (!Array.isArray(messages)) return null;
    const userMessages = messages.filter(
      (m) => (m as Record<string, unknown>).role === "user"
    );
    if (userMessages.length === 0) return null;
    const lastUser = userMessages[userMessages.length - 1] as Record<
      string,
      unknown
    >;
    return {
      step_id: 0,
      timestamp: exchange.timestamp,
      source: "user",
      message: lastUser.content as string,
    };
  }

  return null;
}

function extractAgentStep(
  exchange: ParsedExchange,
  stepId: number
): Step | null {
  switch (exchange.apiFormat) {
    case "anthropic-messages":
      return extractAnthropicAgentStep(exchange, stepId);
    case "openai-responses":
      return extractOpenAIResponsesAgentStep(exchange, stepId);
    case "openai-chat":
      return extractOpenAIChatAgentStep(exchange, stepId);
    default:
      return null;
  }
}

// --- Anthropic Messages API ---

function extractAnthropicAgentStep(
  exchange: ParsedExchange,
  stepId: number
): Step | null {
  const events = exchange.responseEvents;
  if (events.length === 0) return null;

  let message = "";
  let reasoningContent = "";
  const toolCalls: ToolCall[] = [];
  let model = exchange.model;
  let metrics: Metrics | undefined;

  // Track content blocks being built
  const contentBlocks: Map<
    number,
    { type: string; text: string; toolId?: string; toolName?: string; toolInput: string }
  > = new Map();

  // Initial usage from message_start
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheCreationTokens = 0;

  for (const event of events) {
    const eventType = event._event_type as string | undefined;

    if (eventType === "message_start") {
      const msg = event.message as Record<string, unknown>;
      if (msg?.model) model = msg.model as string;
      const usage = msg?.usage as Record<string, unknown>;
      if (usage) {
        inputTokens += (usage.input_tokens as number) || 0;
        outputTokens += (usage.output_tokens as number) || 0;
        cachedTokens += (usage.cache_read_input_tokens as number) || 0;
        cacheCreationTokens +=
          (usage.cache_creation_input_tokens as number) || 0;
      }
    }

    if (eventType === "content_block_start") {
      const idx = event.index as number;
      const block = event.content_block as Record<string, unknown>;
      if (block) {
        contentBlocks.set(idx, {
          type: block.type as string,
          text: "",
          toolId: block.id as string | undefined,
          toolName: block.name as string | undefined,
          toolInput: "",
        });
      }
    }

    if (eventType === "content_block_delta") {
      const idx = event.index as number;
      const delta = event.delta as Record<string, unknown>;
      const block = contentBlocks.get(idx);
      if (block && delta) {
        if (delta.type === "text_delta") {
          block.text += delta.text as string;
        } else if (delta.type === "thinking_delta") {
          block.text += delta.thinking as string;
        } else if (delta.type === "input_json_delta") {
          block.toolInput += delta.partial_json as string;
        }
        // signature_delta — skip, not needed for ATIF
      }
    }

    if (eventType === "message_delta") {
      const usage = event.usage as Record<string, unknown>;
      if (usage) {
        outputTokens = (usage.output_tokens as number) || outputTokens;
      }
    }
  }

  // Process accumulated content blocks
  for (const [, block] of contentBlocks) {
    if (block.type === "thinking") {
      reasoningContent += block.text;
    } else if (block.type === "text") {
      message += block.text;
    } else if (block.type === "tool_use") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(block.toolInput || "{}");
      } catch {
        // leave as empty
      }
      toolCalls.push({
        tool_call_id: block.toolId || `call_${toolCalls.length}`,
        function_name: block.toolName || "unknown",
        arguments: args,
      });
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    metrics = {
      prompt_tokens: inputTokens + cachedTokens + cacheCreationTokens,
      completion_tokens: outputTokens,
      cached_tokens: cachedTokens,
    };
    if (cacheCreationTokens > 0) {
      metrics.extra = { cache_creation_input_tokens: cacheCreationTokens };
    }
  }

  if (!message && !reasoningContent && toolCalls.length === 0) return null;

  const step: Step = {
    step_id: stepId,
    timestamp: exchange.timestamp,
    source: "agent",
    model_name: model,
    message: message || "",
  };

  if (reasoningContent) step.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) step.tool_calls = toolCalls;
  if (metrics) step.metrics = metrics;

  return step;
}

// --- OpenAI Responses API ---

function extractOpenAIResponsesAgentStep(
  exchange: ParsedExchange,
  stepId: number
): Step | null {
  const events = exchange.responseEvents;
  if (events.length === 0) return null;

  let message = "";
  let reasoningContent = "";
  const toolCalls: ToolCall[] = [];
  let model = exchange.model;
  let metrics: Metrics | undefined;
  let reasoningEffort: string | undefined;

  // Track output items by index
  const outputItems: Map<
    number,
    {
      type: string;
      text: string;
      callId?: string;
      name?: string;
      arguments: string;
      summaryParts: string[];
    }
  > = new Map();

  // Extract reasoning effort from request
  const reasoning = exchange.request.reasoning as Record<string, unknown>;
  if (reasoning?.effort) {
    reasoningEffort = reasoning.effort as string;
  }

  for (const event of events) {
    const eventType = event._event_type as string | undefined;

    if (eventType === "output_item.added" || eventType === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      const idx = event.output_index as number;
      if (item) {
        outputItems.set(idx, {
          type: item.type as string,
          text: "",
          callId: item.call_id as string | undefined,
          name: item.name as string | undefined,
          arguments: "",
          summaryParts: [],
        });
      }
    }

    if (eventType === "output_text.delta" || eventType === "response.output_text.delta") {
      const idx = event.output_index as number;
      const item = outputItems.get(idx);
      if (item) {
        item.text += event.delta as string;
      }
    }

    if (eventType === "reasoning_summary_text.delta" || eventType === "response.reasoning_summary_text.delta") {
      const idx = event.output_index as number;
      const item = outputItems.get(idx);
      if (item) {
        item.summaryParts.push(event.delta as string);
      }
    }

    if (eventType === "function_call_arguments.delta" || eventType === "response.function_call_arguments.delta") {
      const idx = event.output_index as number;
      const item = outputItems.get(idx);
      if (item) {
        item.arguments += event.delta as string;
      }
    }

    // Extract completed response with usage
    if (eventType === "response.completed") {
      const response = event.response as Record<string, unknown>;
      if (response) {
        if (response.model) model = response.model as string;
        const usage = response.usage as Record<string, unknown>;
        if (usage) {
          const inputDetails = usage.input_tokens_details as Record<
            string,
            unknown
          >;
          const outputDetails = usage.output_tokens_details as Record<
            string,
            unknown
          >;
          metrics = {
            prompt_tokens: (usage.input_tokens as number) || 0,
            completion_tokens: (usage.output_tokens as number) || 0,
            cached_tokens: (inputDetails?.cached_tokens as number) || 0,
          };
          if (outputDetails?.reasoning_tokens) {
            metrics.extra = {
              reasoning_tokens: outputDetails.reasoning_tokens as number,
            };
          }
        }
      }
    }
  }

  // Process output items
  for (const [, item] of outputItems) {
    if (item.type === "reasoning") {
      reasoningContent = item.summaryParts.join("");
    } else if (item.type === "message") {
      message = item.text;
    } else if (item.type === "function_call") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(item.arguments || "{}");
      } catch {
        // leave empty
      }
      toolCalls.push({
        tool_call_id: item.callId || `call_${toolCalls.length}`,
        function_name: item.name || "unknown",
        arguments: args,
      });
    }
  }

  // Extract tool results from request input (function_call_output items)
  // NOTE: handled separately by extractToolResultsFromRequest, attached to prev step

  if (!message && !reasoningContent && toolCalls.length === 0) return null;

  const step: Step = {
    step_id: stepId,
    timestamp: exchange.timestamp,
    source: "agent",
    model_name: model,
    message: message || "",
  };

  if (reasoningEffort) step.reasoning_effort = reasoningEffort;
  if (reasoningContent) step.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) step.tool_calls = toolCalls;
  if (metrics) step.metrics = metrics;

  return step;
}

// --- OpenAI Chat Completions ---

function extractOpenAIChatAgentStep(
  exchange: ParsedExchange,
  stepId: number
): Step | null {
  const events = exchange.responseEvents;
  if (events.length === 0) return null;

  let message = "";
  let model = exchange.model;
  let metrics: Metrics | undefined;
  const toolCalls: ToolCall[] = [];

  // Track streaming tool calls by index
  const streamingToolCalls: Map<
    number,
    { id: string; name: string; arguments: string }
  > = new Map();

  for (const event of events) {
    // Skip prompt filter results
    if (event.prompt_filter_results) continue;

    const choices = event.choices as Record<string, unknown>[];
    if (choices && choices.length > 0) {
      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown>;

      if (delta) {
        if (delta.content && typeof delta.content === "string") {
          message += delta.content;
        }

        // Handle streaming tool calls
        const deltaToolCalls = delta.tool_calls as Record<string, unknown>[];
        if (deltaToolCalls) {
          for (const tc of deltaToolCalls) {
            const idx = tc.index as number;
            if (!streamingToolCalls.has(idx)) {
              streamingToolCalls.set(idx, {
                id: (tc.id as string) || `call_${idx}`,
                name: "",
                arguments: "",
              });
            }
            const tracked = streamingToolCalls.get(idx)!;
            if (tc.id) tracked.id = tc.id as string;
            const fn = tc.function as Record<string, unknown>;
            if (fn) {
              if (fn.name) tracked.name += fn.name as string;
              if (fn.arguments) tracked.arguments += fn.arguments as string;
            }
          }
        }
      }

      if (choice.finish_reason === "stop" || choice.finish_reason === "tool_calls") {
        if (event.model) model = event.model as string;
      }
    }

    // Token usage on the final event
    const usage = event.usage as Record<string, unknown>;
    if (usage) {
      const promptDetails = usage.prompt_tokens_details as Record<
        string,
        unknown
      >;
      metrics = {
        prompt_tokens: (usage.prompt_tokens as number) || 0,
        completion_tokens: (usage.completion_tokens as number) || 0,
        cached_tokens: (promptDetails?.cached_tokens as number) || 0,
      };
      const reasoningTokens = usage.reasoning_tokens as number;
      if (reasoningTokens) {
        metrics.extra = { reasoning_tokens: reasoningTokens };
      }
    }
  }

  // Convert streaming tool calls to ATIF format
  for (const [, tc] of streamingToolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.arguments || "{}");
    } catch {
      // leave empty
    }
    toolCalls.push({
      tool_call_id: tc.id,
      function_name: tc.name,
      arguments: args,
    });
  }

  if (!message && toolCalls.length === 0) return null;

  const step: Step = {
    step_id: stepId,
    timestamp: exchange.timestamp,
    source: "agent",
    model_name: model,
    message: message || "",
  };

  if (toolCalls.length > 0) step.tool_calls = toolCalls;
  if (metrics) step.metrics = metrics;

  return step;
}

// --- Utilities ---

function computeFinalMetrics(steps: Step[]): FinalMetrics {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;
  let totalSteps = 0;

  for (const step of steps) {
    if (step.source === "agent") totalSteps++;
    if (step.metrics) {
      totalPromptTokens += step.metrics.prompt_tokens || 0;
      totalCompletionTokens += step.metrics.completion_tokens || 0;
      totalCachedTokens += step.metrics.cached_tokens || 0;
    }
  }

  return {
    total_prompt_tokens: totalPromptTokens,
    total_completion_tokens: totalCompletionTokens,
    total_cached_tokens: totalCachedTokens,
    total_steps: steps.length,
  };
}

function generateSessionId(har: HarFile): string {
  // Try to extract from headers or generate from HAR metadata
  for (const entry of har.log.entries) {
    for (const h of entry.request.headers) {
      if (h.name.toLowerCase() === "x-request-id") return h.value;
      if (h.name.toLowerCase() === "copilot-edits-session") return h.value;
    }
  }
  // Fallback: use first entry timestamp as seed
  const firstTimestamp = har.log.entries[0]?.startedDateTime || "unknown";
  return `har-${firstTimestamp.replace(/[^a-zA-Z0-9]/g, "-")}`;
}
