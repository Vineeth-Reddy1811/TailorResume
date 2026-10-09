---
name: model-effort-selector
description: Choose an efficient model and reasoning effort for a task based on its complexity, importance, and cost of error.
---

# Model and Effort Selector

Choose a suitable model and reasoning effort before substantive work. Optimize for enough capability to finish well without spending tokens or latency where they do not improve the result.

## Decision

Use models available in the current Codex session or model picker; do not assume a model is available because it appears in an old configuration or example. Consider:

- **Complexity:** number of components, uncertainty, cross-file or cross-system reasoning, and need for research or debugging.
- **Importance:** impact of failure, reversibility, and how costly a mistake would be.
- **Task size:** a narrow edit or lookup usually needs less effort than architecture, difficult debugging, or broad code changes.
- **Efficiency:** prefer the least costly, fastest available model and lowest reasoning effort likely to meet the quality bar. Increase capability or effort when complexity or consequences justify it.

As a starting point, use a fast, lower-effort configuration for routine, low-risk work; a capable general model at medium effort for ordinary implementation; and a stronger available model with high effort for difficult, ambiguous, or high-impact work. Use the available reasoning levels rather than assuming their names are identical across every model.

If the user names a model or effort level, honor that choice. If it is unavailable, say so briefly and offer the closest available option. The user can change the recommendation at any time.

## Apply the choice honestly

At the beginning of substantive work, state the selected or recommended model and effort in one short line, with a short reason when useful. Keep trivial requests lightweight and do not produce a cost-analysis report.

Project instructions and skills cannot change the model of an already-running parent conversation. If Codex exposes a way to set the choice before execution, use it. Otherwise, distinguish the recommendation from the active model: proceed with the active model for routine work, and for work where the mismatch materially threatens quality, tell the user the recommended setup and ask whether to switch or proceed with the current model. Never claim that the active model changed when it did not.

When delegating, choose a subagent model and effort appropriate to that subtask. Avoid unnecessary subagents, repeated review passes, and broad exploration that will not affect the result.
