import {
  type BaseMessage,
  isHumanMessage,
  isToolMessage,
  ToolMessage,
} from "@langchain/core/messages";

// The full accumulated coach thread grows unbounded (every turn re-sends the
// whole history, including raw ToolMessage JSON). We window it only for the
// model call — graph state is never mutated.
export const MAX_WINDOW_MESSAGES = 40;
export const MAX_TOOL_MESSAGE_CHARS = 4000;
export const TOOL_TRUNCATION_SUFFIX = "…[truncated]";

function truncateForModel(message: BaseMessage): BaseMessage {
  if (!isToolMessage(message)) return message;
  const { content } = message;
  if (typeof content !== "string" || content.length <= MAX_TOOL_MESSAGE_CHARS) return message;

  return new ToolMessage({
    content: content.slice(0, MAX_TOOL_MESSAGE_CHARS) + TOOL_TRUNCATION_SUFFIX,
    tool_call_id: message.tool_call_id,
    name: message.name,
    id: message.id,
    additional_kwargs: message.additional_kwargs,
    status: message.status,
    artifact: message.artifact,
  });
}

// Returns a capped copy of `messages` to send to the model. The window starts
// at a HumanMessage boundary so an AIMessage carrying tool_calls is never sent
// without its ToolMessages and no ToolMessage is sent without its initiating
// AIMessage. The latest human turn (last HumanMessage onward) is always fully
// included even if it alone exceeds the cap. Oversized ToolMessage payloads are
// truncated in the copy. `messages` itself is never mutated.
export function windowMessages(messages: BaseMessage[]): BaseMessage[] {
  const start = messages.length <= MAX_WINDOW_MESSAGES ? 0 : windowStart(messages);
  return messages.slice(start).map(truncateForModel);
}

function windowStart(messages: BaseMessage[]): number {
  const target = messages.length - MAX_WINDOW_MESSAGES;

  let latestHuman = -1;
  let firstHumanAtOrAfterTarget = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!isHumanMessage(messages[i])) continue;
    latestHuman = i;
    if (firstHumanAtOrAfterTarget === -1 && i >= target) firstHumanAtOrAfterTarget = i;
  }

  if (firstHumanAtOrAfterTarget !== -1) return firstHumanAtOrAfterTarget;
  if (latestHuman !== -1) return latestHuman;
  return Math.max(0, target);
}
