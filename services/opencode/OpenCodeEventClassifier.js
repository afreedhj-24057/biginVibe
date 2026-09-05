const CHAT_CLASSIFICATION = {
  USER_VISIBLE_ASSISTANT_RESPONSE: "user_visible_assistant_response",
  INTERNAL_AGENT_SUBAGENT_MESSAGE: "internal_agent_subagent_message",
  SYSTEM_DEVELOPER_PROMPT: "system_developer_prompt",
  AGENT_INITIALIZATION: "agent_initialization",
  TOOL_CALL_RESULT: "tool_call_result",
  REASONING_THINKING: "reasoning_thinking",
  STATUS_PROGRESS: "status_progress",
  INTERNAL_EXECUTION_METADATA: "internal_execution_metadata",
  INTERMEDIATE_STREAMING_LOOP: "intermediate_streaming_loop",
};

function classifyMessagePart(part, activeAssistantMessageId) {
  if (!part || !part.type) return CHAT_CLASSIFICATION.INTERNAL_EXECUTION_METADATA;

  if (activeAssistantMessageId && part.messageID !== activeAssistantMessageId) {
    if (part.type === "subtask" || part.type === "agent") {
      return CHAT_CLASSIFICATION.INTERNAL_AGENT_SUBAGENT_MESSAGE;
    }
    if (part.type === "text") {
      return CHAT_CLASSIFICATION.INTERMEDIATE_STREAMING_LOOP;
    }
    return CHAT_CLASSIFICATION.INTERNAL_EXECUTION_METADATA;
  }

  switch (part.type) {
    case "text":
      if (part.synthetic || part.ignored) {
        return CHAT_CLASSIFICATION.INTERNAL_EXECUTION_METADATA;
      }
      return CHAT_CLASSIFICATION.USER_VISIBLE_ASSISTANT_RESPONSE;
    case "reasoning":
      return CHAT_CLASSIFICATION.REASONING_THINKING;
    case "tool":
      return CHAT_CLASSIFICATION.TOOL_CALL_RESULT;
    case "step-start":
    case "step-finish":
    case "retry":
      return CHAT_CLASSIFICATION.STATUS_PROGRESS;
    case "subtask":
      return CHAT_CLASSIFICATION.INTERNAL_AGENT_SUBAGENT_MESSAGE;
    case "agent":
      return CHAT_CLASSIFICATION.AGENT_INITIALIZATION;
    case "snapshot":
    case "patch":
    case "file":
    case "compaction":
    default:
      return CHAT_CLASSIFICATION.INTERNAL_EXECUTION_METADATA;
  }
}

function extractVisibleAssistantText(parts, activeAssistantMessageId) {
  if (!Array.isArray(parts)) return "";

  return parts
    .filter((part) => {
      return (
        classifyMessagePart(part, activeAssistantMessageId) ===
        CHAT_CLASSIFICATION.USER_VISIBLE_ASSISTANT_RESPONSE
      );
    })
    .map((part) => part.text || "")
    .join("");
}

module.exports = {
  CHAT_CLASSIFICATION,
  classifyMessagePart,
  extractVisibleAssistantText,
};
