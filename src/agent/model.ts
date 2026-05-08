import { ChatOpenAI } from "@langchain/openai";

export const gptMiniModel = new ChatOpenAI({
	model: "gpt-4o-mini",
	temperature: 0,
	maxRetries: 2,
});
