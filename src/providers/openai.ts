// src/providers/openai.ts
// Backward-compatible re-export: OpenAIProvider is now UniversalProvider.
// Kept so existing test imports continue to work without change.
export { UniversalProvider as OpenAIProvider } from "./universal.js"
