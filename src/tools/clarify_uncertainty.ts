// @ts-nocheck
/**
 * clarify_uncertainty tool
 *
 * Used in high-confidence mode. The agent calls this tool to declare
 * what it is uncertain about before taking any action.
 *
 * The route layer intercepts this tool call, pauses the AgentLoop,
 * presents the questions to the user, and resumes with the answers.
 *
 * Schema matches UncertaintyItem[] from agent/types.ts.
 */
export async function clarifyUncertaintyHandler(args) {
    // Validation
    if (!Array.isArray(args['items']) || args['items'].length === 0) {
        return {
            type: 'error',
            error: 'clarify_uncertainty requires a non-empty items array',
        };
    }
    // The actual pause/resume is handled by the AgentLoop + route layer.
    // This handler just returns a placeholder — the loop detects this tool
    // call and triggers a pause before the handler result is returned.
    // (In practice, the route's beforeToolCall hook or loop-level detection
    // intercepts this and the handler result is replaced with user answers.)
    return {
        type: 'text',
        text: JSON.stringify({
            status: 'pending_user_input',
            items: args['items'],
        }),
    };
}
export const clarifyUncertaintySchema = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            description: 'List of uncertainty items the agent needs clarified before proceeding',
            items: {
                type: 'object',
                required: ['id', 'question', 'impact'],
                properties: {
                    id: {
                        type: 'string',
                        description: 'Unique identifier for this uncertainty item',
                    },
                    question: {
                        type: 'string',
                        description: 'The question to ask the user',
                    },
                    impact: {
                        type: 'string',
                        enum: ['blocking', 'optional'],
                        description: '"blocking" means execution cannot proceed without an answer; "optional" means the agent can make a reasonable assumption',
                    },
                },
            },
            minItems: 1,
        },
    },
    required: ['items'],
};
export const clarifyUncertaintyDescriptor = {
    name: 'clarify_uncertainty',
    description: `Use this tool BEFORE taking any action in high-confidence mode.
List all things you are uncertain about that could affect the outcome.
Mark items as "blocking" if you truly cannot proceed without an answer,
or "optional" if you can make a reasonable assumption.
The user will answer your questions, then you can proceed.`,
    schema: clarifyUncertaintySchema,
    handler: clarifyUncertaintyHandler,
};
