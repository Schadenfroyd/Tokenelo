# Synthetic collector fixture set

This fixture catalog contains fabricated numbers and ordinal labels only. It has no prompts, response bodies, filesystem paths, hostnames, credentials, or real message identifiers. It is a structure guide for cloud tests, not telemetry or release evidence.

The native counter cases mirror the fixed fields consumed by `captureNativeCounters`: `prompt_eval_count`, `prompt_eval_cached_count`, and `eval_count`. They distinguish a reported zero from a missing or invalid field, replay of an identical snapshot, a cache/prompt contradiction, and two genuinely different snapshots. `native-counter-pipeline.test.ts` and `field-adversarial.test.ts` are the existing source-level companions.

The collector cases mirror `usage.iterations[]` in Claude usage, the documented UUID fallback when both message and request identity are absent, and Codex's persisted continuation state (`openTurns`, pending records, and `emittedAhead`). The two-source-instance scenario describes a fabricated repeated event identity; it asks the regression to verify the existing dedup and ownership rule without storing host labels or any real identifier.

No production code changed. The fixture does not decide PM-02/PM-03 semantics or close the native-counter mutation gate. A test author should instantiate fake IDs inside the test process and retain the original suite's case names, skip reasons, and deadlines.
