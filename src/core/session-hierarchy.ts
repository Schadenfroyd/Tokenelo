import type { Source, UsageEvent } from './types.js';

type Identity = Pick<UsageEvent, 'host' | 'source' | 'sessionId' | 'parentSessionId' | 'isSubagent'>;
interface Family {
  parents: Map<string, string>;
  children: Map<string, string[]>;
  roots: Map<string, string>;
}

/** Recorded ancestry belongs to a host and collector. Nested branches are included once.
 * Last valid parent assignment wins, matching the existing session grouping rule. Cyclic
 * edges are left unfolded; incoming acyclic branches still belong to their recorded parent. */
export class SessionHierarchy {
  private readonly families = new Map<string, Family>();

  constructor(events: readonly Identity[]) {
    for (const event of events) {
      if (!event.isSubagent || !event.parentSessionId || event.parentSessionId === event.sessionId) continue;
      const key = JSON.stringify([event.host, event.source]);
      let family = this.families.get(key);
      if (!family) {
        family = { parents: new Map(), children: new Map(), roots: new Map() };
        this.families.set(key, family);
      }
      family.parents.set(event.sessionId, event.parentSessionId);
    }
    for (const family of this.families.values()) {
      const complete = new Set<string>();
      for (const first of family.parents.keys()) {
        const path: string[] = [];
        const positions = new Map<string, number>();
        let next = first;
        while (family.parents.has(next) && !complete.has(next)) {
          const cycleAt = positions.get(next);
          if (cycleAt !== undefined) {
            for (const member of path.slice(cycleAt)) family.parents.delete(member);
            break;
          }
          positions.set(next, path.length); path.push(next);
          next = family.parents.get(next)!;
        }
        for (const member of path) complete.add(member);
      }
      for (const [child, parent] of family.parents) {
        const siblings = family.children.get(parent) ?? [];
        siblings.push(child); family.children.set(parent, siblings);
      }
    }
  }

  private family(host: string, source: Source): Family | undefined {
    return this.families.get(JSON.stringify([host, source]));
  }

  root(host: string, source: Source, sessionId: string): string {
    const family = this.family(host, source);
    if (!family) return sessionId;
    const path: string[] = [];
    let current = sessionId;
    while (family.parents.has(current) && !family.roots.has(current)) {
      path.push(current); current = family.parents.get(current)!;
    }
    const root = family.roots.get(current) ?? current;
    for (const member of path) family.roots.set(member, root);
    return root;
  }

  children(host: string, source: Source, sessionId: string): readonly string[] {
    return this.family(host, source)?.children.get(sessionId) ?? [];
  }

  descendants(host: string, source: Source, sessionId: string): Set<string> {
    const family = this.family(host, source);
    const found = new Set<string>();
    const pending = [...(family?.children.get(sessionId) ?? [])];
    while (pending.length) {
      const child = pending.pop()!;
      if (child === sessionId || found.has(child)) continue;
      found.add(child);
      for (const descendant of family?.children.get(child) ?? []) pending.push(descendant);
    }
    return found;
  }
}
