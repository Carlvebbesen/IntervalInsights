import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export const geminiFlashModel = new ChatGoogleGenerativeAI({
	model: "gemini-2.5-flash",
	temperature: 0,
	maxRetries: 2,
});
