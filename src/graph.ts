import type { DiscoveryMethod, GraphEdge, GraphNode } from './types.js';

// Temporary in-RAM discovery graph. Destroyed with the session.
export class DiscoveryGraph {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];
  private edgeKeys = new Set<string>();

  addNode(id: string, label: string, kind: GraphNode['kind'], url: string): void {
    if (!this.nodes.has(id)) this.nodes.set(id, { id, label, kind, url });
  }

  link(from: string, to: string, via: DiscoveryMethod, label?: string): void {
    const k = `${from}→${to}→${via}`;
    if (this.edgeKeys.has(k)) return;
    this.edgeKeys.add(k);
    this.edges.push({ from, to, via, label });
    if (this.edges.length > 8000) {
      this.edges.splice(0, 1000);
      // Rebuild edgeKeys from retained edges so dropped keys don't leak
      // forever (long-session growth) and re-adding a dropped triple works.
      this.edgeKeys = new Set(this.edges.map((e) => `${e.from}→${e.to}→${e.via}`));
    }
  }

  routeNode(route: string): string { return `route:${route}`; }

  clear(): void { this.nodes.clear(); this.edges = []; this.edgeKeys.clear(); }

  /** Adjacency summary for UI (bounded). */
  summarize(max = 300): string[] {
    const out: string[] = [];
    for (const e of this.edges.slice(-max)) {
      const f = this.nodes.get(e.from)?.label ?? e.from;
      const t = this.nodes.get(e.to)?.label ?? e.to;
      out.push(`${f} —[${e.via}]→ ${t}`);
    }
    return out;
  }
}
