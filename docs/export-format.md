# CSV v2 field dictionary — release draft

The current private implementation appends fields to the original CSV column order. Consumers should select by header name. JSON continues to export normalized events and has not been anonymized or changed by the CSV addition.

| Group | Fields | Interpretation |
| --- | --- | --- |
| Original identity/scope | `id`, `host`, `source`, `ts`, `sessionId`, `model`, `provider` | Operational identifiers; `ts` is epoch milliseconds UTC |
| Original price/measurement | `apiEquivUsd`, `priceStatus`, `priceVersion` | Stored comparison/measurement and qualification; unavailable numbers are blank |
| Recorded components | `inputFresh`, `cacheWrite5m`, `cacheWrite1h`, `cacheWriteUnassigned`, `cacheWriteAssumed1h`, `cacheRead`, `output`, `reasoning` | Normalized components; optional legacy fields stay blank. Assumed-duration and reasoning subsets must not be counted twice |
| Count qualifications | `countQuality` | Missing legacy metadata becomes `unrecorded` |
| Source context | `tsSource`, `engine`, `thinking`, `speed`, `effort`, `serviceTier`, `inferenceGeo` | Recorded source/model context, not inferred completeness |
| Evidence structure | `flags`, `components` | JSON arrays inside properly quoted CSV cells; component details preserve mixed-model events |
| Rate provenance | `rateKey`, `rateResolvedSha256`, `selectionState`, `runtimeState` | Optional stored/read-time rate context; blank when not available from the export path |
| Export contract | `costBasis`, `exportSchemaVersion` | `api-equivalent-not-billed` and `2` |

Strings starting with spreadsheet formula indicators (including leading whitespace) or tab/CR/LF are prefixed with an apostrophe in CSV presentation. Commas, quotes, CR and LF are escaped as CSV text. JSON and stored event identities remain unchanged. Consumers that need byte-identical identifiers should use JSON rather than removing the protection and opening an untrusted spreadsheet.

There is no guarantee that a raw export is safe to publish. Host/session/event identifiers remain in CSV; JSON can contain paths and additional metadata. A share-safe report is a planned separate workflow.
