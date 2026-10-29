/**
 * Header and window-title text for the session-detail window while a load is pending or after it
 * failed (R45). It takes only the requested key's source, so nothing from a previously shown
 * session (project, host, models, metrics) can carry over into a state that does not belong to it.
 * The failure reason itself stays in the panel. detail.ts renders exactly these strings. No DOM.
 */
import type { Source } from './api-types.js';

export interface DetailContext {
  title: string;
  subtitle: string;
  documentTitle: string;
}

export function sourceLabel(source: Source): string {
  switch (source) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'ollama-proxy':
      return 'Local proxy';
    case 'ollama-log':
      return 'Local server log';
    case 'bench':
      return 'Bench';
    case 'qwen-code':
      return 'Qwen Code';
  }
  // The boot key comes from the URL, so an unrecognized source is possible at runtime.
  return 'Unknown source';
}

export function pendingContext(source: Source): DetailContext {
  return { title: 'Loading session…', subtitle: sourceLabel(source), documentTitle: 'Tokenelo — Loading session' };
}

export function failureContext(source: Source): DetailContext {
  return { title: 'Session unavailable', subtitle: sourceLabel(source), documentTitle: 'Tokenelo — Session unavailable' };
}
