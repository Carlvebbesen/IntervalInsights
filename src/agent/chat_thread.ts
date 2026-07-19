import { getCheckpointer } from "./analysis_graph";

// Drops the LangGraph checkpointer thread backing a chat conversation. Its own
// module so tests can stub it without mocking the whole analysis graph.
export async function deleteCoachThread(conversationId: string): Promise<void> {
  const checkpointer = await getCheckpointer();
  await checkpointer.deleteThread(conversationId);
}
