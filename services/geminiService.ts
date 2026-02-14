
import { GoogleGenAI, Type } from "@google/genai";

export class GeminiAssistant {
  private ai: GoogleGenAI | null = null;

  constructor() {
    // Access Vite environment variable directly
    const apiKey = (import.meta as ImportMeta & { env?: { VITE_GEMINI_API_KEY?: string } }).env?.VITE_GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  async analyzeContent(content: string): Promise<{ suggestion: string; explanation: string }> {
    if (!this.ai) {
      return { suggestion: "Assistant unavailable.", explanation: "API key not configured." };
    }
    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: `Analyze the following document content and provide a constructive improvement or a summary.
        Content: "${content}"`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              suggestion: { type: Type.STRING },
              explanation: { type: Type.STRING },
            },
            required: ['suggestion', 'explanation'],
          },
        },
      });

      const text = response.text || '{}';
      return JSON.parse(text.trim());
    } catch (error) {
      console.error("Gemini Error:", error);
      return { suggestion: "Analysis failed.", explanation: "Connection error." };
    }
  }
}

export const geminiAssistant = new GeminiAssistant();
