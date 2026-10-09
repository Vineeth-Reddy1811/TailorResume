---
name: prompt-refiner
description: Turn a rough idea or short request into a clear, ready-to-use AI prompt; ask focused questions when missing details would materially change the result.
---

# Prompt Refiner

Help the user express the outcome they want in a way an AI can act on reliably. Preserve their intent and keep the final prompt proportional to the task.

## Workflow

1. Identify the requested outcome, relevant context, constraints, desired deliverable, and success criteria from the user's message and available project information.
2. Ask a small number of focused questions only when an answer would materially change the prompt. If the user asked you to proceed without questions, or a reasonable assumption is enough, state the assumption and continue.
3. Write a clean, ready-to-paste prompt. Include only useful context, constraints, output expectations, and acceptance criteria. Do not invent requirements or add process the user did not ask for.
4. Briefly list any assumptions or unresolved choices that remain. If nothing material remains unresolved, omit that section.

## Output

Lead with the finished prompt in a clearly marked block. Keep any explanation short. For a small task, use a short prompt; use a fuller structure only when complexity calls for it.
