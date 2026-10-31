# CSV field dictionary (schema version 3) — release draft

`export --format csv` writes one row per recorded event with a fixed header. Select columns by header name: the header may change before a supported release. `export --format json` writes the normalized events; it has not been anonymized.

| Group | Fields | Interpretation |
| --- | --- | --- |
| Identity and scope | `id`, `host`, `source`, `ts`, `sessionId`, `model`, `provider` | Operational identifiers; `ts` is epoch milliseconds UTC |
| Price comparison | `apiEquivUsd`, `priceStatus`, `priceVersion` | Stored Standard API-equivalent comparison and its qualification; unavailable numbers are blank |
| Recorded components | `inputFresh`, `cacheWrite5m`, `cacheWrite1h`, `cacheWriteUnassigned`, `cacheWriteAssumed1h`, `cacheRead`, `output`, `reasoning` | Normalized components; optional legacy fields stay blank. Assumed-duration and reasoning subsets must not be counted twice |
| Count qualifications | `countQuality`, `ucuCountQuality` | Missing legacy metadata becomes `unrecorded`. `ucuCountQuality` qualifies the fresh-input, cache-creation and output subset when that differs from the full counts, and repeats `countQuality` when no separate value was stored |
| Source context | `tsSource`, `engine`, `thinking`, `speed`, `effort`, `serviceTier`, `inferenceGeo` | Recorded source/model context, not inferred completeness |
| Evidence structure | `flags`, `components` | JSON arrays inside properly quoted CSV cells; component details preserve mixed-model events |
| Export contract | `costBasis`, `exportSchemaVersion` | `api-equivalent-not-billed` and `3` |
| Field evidence | `fieldEvidence` | JSON object with read-side field presence and assumptions for the token fields; filled only for events captured by the Ollama proxy and blank for every other source |

Strings starting with spreadsheet formula indicators (including leading whitespace) or tab/CR/LF are prefixed with an apostrophe in CSV presentation. Commas, quotes, CR and LF are escaped as CSV text. JSON and stored event identities remain unchanged. Consumers that need byte-identical identifiers should use JSON rather than removing the protection and opening an untrusted spreadsheet.

There is no guarantee that a raw export is safe to publish. Host/session/event identifiers remain in CSV; JSON can contain paths and additional metadata. `report --share` emits a versioned aggregate with local identifiers and paths omitted; review it before sharing.
