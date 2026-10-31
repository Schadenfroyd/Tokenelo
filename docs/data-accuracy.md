# Interpreting Tokenelo data

Internal alpha; the source is released and no installer is available. These principles describe the tracker contract; a release must document exactly which adapters and fields it supports.

## Recorded components

Fresh input, cache creation, cache reads, output and reasoning are distinct fields. Some providers report cache creation by duration; others leave it unspecified. Missing or legacy qualification metadata is unrecorded, not proof of a complete count.

Reasoning can be a subset of output. A cache-duration assumption can be a subset of a cache-creation field. Do not add subsets again when calculating a total. Provider adapters must describe their normalization rules.

## Read the context with the number

Check the source, model, selected range, recorded timestamp and capture status. Parent sessions may already include subagent usage. Session views must make that inclusion explicit. A comparison across different windows or partial sources is not a like-for-like total.

Zero means a known value of zero. Blank, unknown, unavailable, incomplete, estimated and unpriced carry different meanings. Failed reads must not silently become zero. This edition does not meet that standard everywhere yet. The six core token counters are stored as integers that default to 0 and cannot be blank, and some collectors store an absent counter as 0: Codex, Qwen Code, the Ollama server-log collector and the Ollama proxy's response parser. Such a row's count quality reads `unrecorded` or carries an estimate flag, and its exported number is the same as a measured zero. The Codex collector keeps per-field presence (reported zero, missing or invalid) in the stored components, but no report reads it yet.

## Cost interpretation

API-equivalent cost compares recorded usage against the configured price table and its version. It does not establish an invoice, subscription allocation, refund entitlement, negotiated price or actual cash savings. Local inference comparison is also not a paid amount. Electricity estimates require explicit assumptions.

Count completeness and pricing status are separate questions.

## Reporting and sharing

The CSV export retains the original leading columns and adds token components, qualifications, source/model-component detail and field evidence. Unknown optional counters remain blank, but the six core counters cannot be blank: an absent core counter exports as `0`. Legacy quality is labeled unrecorded. String fields that could become spreadsheet formulas receive an apostrophe in CSV presentation; JSON and stored records are unchanged.

The [CSV field dictionary](export-format.md) lists every exported column. Raw event/host/session identifiers remain sensitive. JSON may include project paths and additional metadata. Sanitize before sharing.

## Accountability workflow

1. Confirm which tools and windows are captured.
2. Inspect model/session records and count qualifications.
3. Compare a reviewed export with the vendor's reporting for the same scope.
4. Document discounts, rounding, unsupported activity and unresolved discrepancies.
5. Use that evidence to ask the vendor a precise question.

Automated invoice reconciliation is a proposed feature, not a released capability.
