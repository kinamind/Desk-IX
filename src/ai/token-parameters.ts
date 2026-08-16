export function usesMaxCompletionTokens(model: string): boolean {
  const modelName = model.split("/").at(-1) ?? model;
  return /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$)|codex(?:[.-]|$))/i.test(modelName);
}

export function adaptChatCompletionTokenParameter(
  model: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  if (!usesMaxCompletionTokens(model) || request.max_tokens == null || request.max_completion_tokens != null) {
    return request;
  }

  const { max_tokens: maxCompletionTokens, ...rest } = request;
  return {
    ...rest,
    max_completion_tokens: maxCompletionTokens,
  };
}
