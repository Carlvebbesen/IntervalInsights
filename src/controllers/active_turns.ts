const activeTurns = new Set<string>();

export function markTurnActive(conversationId: string): void {
  activeTurns.add(conversationId);
}

export function clearTurnActive(conversationId: string): void {
  activeTurns.delete(conversationId);
}

export function isTurnActive(conversationId: string): boolean {
  return activeTurns.has(conversationId);
}
