// @ts-nocheck
// src/providers/universal.ts
// UniversalProvider — routes to the correct protocol adapter based on config.api.
import { anthMessagesChat, anthMessagesStream } from "./adapters/anth.js";
import { openaiCompletionsChat, openaiCompletionsStream } from "./adapters/openai.js";
export class UniversalProvider {
    config;
    name;
    models;
    constructor(config) {
        this.config = config;
        this.name = config.name;
        this.models = config.models;
    }
    async chat(messages, options) {
        switch (this.config.api) {
            case "anth-messages":
                return anthMessagesChat(this.config, messages, options);
            case "openai-completions":
                return openaiCompletionsChat(this.config, messages, options);
            default: {
                const _ = this.config.api;
                throw new Error(`Unsupported API protocol: ${_}`);
            }
        }
    }
    async *stream(messages, options) {
        switch (this.config.api) {
            case "anth-messages":
                yield* anthMessagesStream(this.config, messages, options);
                return;
            case "openai-completions":
                yield* openaiCompletionsStream(this.config, messages, options);
                return;
            default: {
                const _ = this.config.api;
                throw new Error(`Unsupported API protocol: ${_}`);
            }
        }
    }
}
