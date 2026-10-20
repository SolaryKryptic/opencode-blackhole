import type { Message, ToolCall } from "../pi-types";
import { clip, textOf } from "./content";
import { summarizeToolArgs } from "./tool-args";
import { extractPath } from "./tool-args";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
}

const toolCallParts = (content: Message["content"]): ToolCall[] => {
  if (!content || typeof content === "string") return [];
  return (content as { type: string }[]).filter((c): c is ToolCall => c.type === "toolCall");
};

const toolCalls = (content: Message["content"]): string => {
  return toolCallParts(content)
    .map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`)
    .join(", ");
};

const extractFilesFromContent = (content: Message["content"]): string[] => {
  return toolCallParts(content)
    .map((c) => extractPath(c.arguments))
    .filter((p): p is string => p !== null);
};

export const renderMessage = (msg: Message, index: number, full = false): RenderedEntry => {
  if (msg.role === "user") {
    return { index, role: "user", summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300) };
  }
  if (msg.role === "toolResult") {
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
    return {
      index, role: "tool_result",
      summary: `[${msg.toolName}] ${text}`,
    };
  }
  // bashExecution has command+output instead of content
  if ((msg as any).role === "bashExecution") {
    const cmd = (msg as any).command ?? "";
    const out = (msg as any).output ?? "";
    const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, 300);
    return { index, role: "bash", summary: text };
  }
  const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
  const tools = toolCalls(msg.content);
  const files = extractFilesFromContent(msg.content);
  const summary = tools ? `${tools}\n${text}` : text;
  return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};


