# DeepRun Issue Draft: False Complete On Zero-Mutation Implementation Runs

## Title

DeepRun marks implementation-intent kernel runs complete after zero-mutation read-only execution

## Summary

For implementation-intent tasks, DeepRun can return terminal `complete` after only reading the prompt and inspecting files. No mutation step may occur, no patch/write action may be taken, and no delivered repo diff may be produced, yet the run is still reported as complete.

## Scope

This applies to implementation-intent prompts such as `implement`, `fix`, `complete`, `add`, `update`, `enforce`, `wire`, and `migrate`.

This does not apply to analysis or research prompts, where read-only completion may be valid.

## Observed Evidence

- the prompt was read
- backend files were inspected
- module files were listed
- no `write_file`, `apply_patch`, or equivalent mutation step occurred
- no delivered repo diff was produced
- the run still reached terminal `complete`

## Why This Matters

One of DeepRun's key use cases is bounded implementation work in existing repos under validation constraints. That use case depends on `complete` meaning either actual implementation delivery or an explicit justified no-change outcome.

## Actual Behavior

Implementation-intent runs can terminate read-only and still be marked `complete`.

## Expected Behavior

Implementation-intent runs must not return `complete` unless one of these is true:

- at least one mutation action occurred and produced code changes
- the agent returned an explicit no-change justification proving the acceptance criteria were already satisfied
- the run exited as `blocked`, `incomplete`, or failed with a clear reason

## Likely Cause

- completion criteria are too weak for implementation-intent runs
- implementation and analysis runs are not gated differently enough
- no mutation-aware completion guard exists
- no end-of-run delivery validation checks whether requested deliverables were actually produced

## Proposed Fixes

1. Classify runs by intent, such as analysis vs implementation.
2. Require mutation or explicit no-change proof before allowing `complete` on implementation-intent runs.
3. Add end-of-run delivery validation for modified files, produced diff, attempted deliverables, and acceptance-criteria coverage.
4. Use clearer non-success terminal states such as `blocked`, `incomplete`, or `failed_no_delivery`.

## Acceptance Criteria

- implementation-intent runs cannot silently complete with zero mutations
- analysis-class prompts may still complete read-only
- no-change completion requires explicit proof
- users can reliably distinguish delivered vs blocked vs incomplete runs