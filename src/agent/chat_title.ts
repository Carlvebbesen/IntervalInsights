import { z } from "zod";
import { invokeStructured } from "./model";

const TitleSchema = z.object({
  title: z.string().describe("A concise conversation title, at most 60 characters."),
});

const MAX_TITLE_LEN = 60;

// Cheap-model title for a chat, from its first question + answer. Returns null
// on failure so callers keep the derived-truncation title.
export async function generateConversationTitle(
  question: string,
  answer: string,
): Promise<string | null> {
  const prompt = [
    "Write a short, specific title for this training-coach conversation.",
    "Rules: at most 60 characters, plain text, no surrounding quotes, no trailing punctuation.",
    "",
    `Athlete's question: ${question}`,
    `Coach's answer: ${answer}`,
  ].join("\n");

  const result = await invokeStructured(TitleSchema, prompt, "generate conversation title");
  if (!result) return null;
  const title = result.title
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  if (!title) return null;
  return title.length > MAX_TITLE_LEN ? title.slice(0, MAX_TITLE_LEN).trim() : title;
}
