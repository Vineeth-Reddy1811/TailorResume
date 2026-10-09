# Project Codex Workflow

You are the orchestrator for work in this project. Use the user's request as the source of truth, and carry authorized work through implementation and a bug-focused review.

## Before implementation

- For a new feature, project, or materially ambiguous request, identify the goal, expected behavior, constraints, and how the user will judge completion. Ask only questions whose answers would materially change the solution; otherwise state a brief assumption and proceed.
- Use `$model-effort-selector` before substantive work. It chooses a suitable available model and reasoning effort based on complexity, importance, and the cost of mistakes. Keep the assessment short. Respect an explicit user model or effort override.
- For a small, clear edit, use a lightweight plan. For larger or cross-cutting work, give the user a concise build plan before implementation.

## During implementation

- Follow the project's existing conventions and keep changes within the requested scope.
- Use subagents only when a focused parallel task or independent review will materially improve the result. Avoid delegation for simple edits.
- Do not run tests or add tests unless the user asks for testing or verification. Do not claim checks were run when they were not.

## Before finishing code work

- Inspect the changes made for this request, including the diff and relevant surrounding code. Look for correctness errors, edge cases, regressions, and mismatches with the requirements.
- For meaningful code changes, use the read-only `bug-reviewer` subagent when it is available. If it is unavailable, perform the review yourself. Do not spend a reviewer call on a trivial edit.
- Resolve clear bugs within scope. If a finding needs a product decision or broader change, explain it and ask the user rather than silently expanding scope.
- In the final response, summarize what changed and the review outcome. Mention tests or other checks only if they were actually requested and run.

## Prompt drafting

When the user asks to improve, structure, or prepare a prompt, use `$prompt-refiner`. Do not turn an ordinary implementation request into a prompt-writing exercise unless the user asks for that.
