export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatRequest = { sessionId: string; message: string; speak?: boolean; provider?: 'openai' | 'elevenlabs' };
export type RobotCommand = { type: "speak" | "face" | "motion"; payload: Record<string, string | number | boolean> };
