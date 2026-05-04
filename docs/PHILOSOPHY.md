# Design Philosophy

> "The best systems don't just run — they learn, adapt, and evolve."

## Why GeminiClaw Exists

Most AI agent runtimes are static. You configure them, deploy them, and they stay exactly as you left them. GeminiClaw is different: it is designed to improve itself over time, guided by real usage, constrained by human oversight.

## Core Principles

### 1. Evolution Over Configuration

Configuration is a snapshot. Evolution is a process. GeminiClaw doesn't ask you to tune parameters — it watches how it performs and proposes improvements to its own code.

### 2. Twin-System Safety

Change is dangerous. GeminiClaw uses a Twin-System (slot-A / slot-B) architecture: one slot runs, the other evolves. Swap only after validation. Always have a rollback point. This is inspired by blue-green deployment, but applied to the agent runtime itself.

### 3. Human in the Loop

Automation accelerates. Judgment protects. High-risk changes require human approval. The evolution engine can suggest and prepare — but it cannot deploy without a human saying yes (at least in early stages).

### 4. Provider Agnosticism

No vendor lock-in. Anthropic today, something else tomorrow. GeminiClaw treats all LLM providers as interchangeable adapters behind a common interface, with automatic fallback.

### 5. Secrets Stay Local

API keys, tokens, and credentials are never in the repository. Ever. They live in `config.yaml` on the user's machine, and that file is gitignored by design.

### 6. Simple Over Clever

When in doubt, choose the simpler implementation. Complexity is technical debt. The evolution engine will make things more sophisticated over time — but only when there's evidence it's needed.

## On the Name

Gemini means twins. The dual-slot architecture is the heart of the system. Two identical runtimes, one always stable, one always evolving. That tension — stability and change in parallel — is what makes the system safe enough to let evolve autonomously.

## On Licensing

GeminiClaw is BSL 1.1 until 2030-05-05, then Apache 2.0. This gives us a commercial window to build a sustainable business while committing to open-source in the long run. OEM licensing is available for enterprises who want to embed GeminiClaw in their products.
