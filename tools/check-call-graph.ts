/**
 * Call-graph guardrail (ADR-0002, ADR-0005), run by `pnpm lint`. Synchronous calls
 * between services must form a DAG, and event-bus-service must call nobody: every flow
 * that goes "backwards" is an event through the bus, and the bus is a sink.
 *
 * Nodes are the gateway and the services of services.json. Edges are read from each
 * app's src/ (specs excluded): every `target: '<workload>'` in a file that calls
 * GrpcClientsModule.register, plus an edge to event-bus-service from an app that calls
 * EventsModule.forRoot. A target that is not a string literal, or names an unknown
 * workload, fails, so the graph cannot be hidden from this check.
 *
 * Every run first checks itself on two synthetic graphs (one cyclic, one acyclic).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, readRegistry } from './lib.ts';

const BUS = 'event-bus-service';

type Graph = ReadonlyMap<string, ReadonlySet<string>>;

/** A cycle as a path (first node repeated at the end), or undefined. */
export function findCycle(graph: Graph): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === 'done') return undefined;
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

/** What is wrong with a graph: cycles and calls made by the bus. */
export function graphProblems(graph: Graph): string[] {
  const problems: string[] = [];
  const outOfBus = [...(graph.get(BUS) ?? [])];
  if (outOfBus.length > 0) {
    problems.push(`${BUS} calls ${outOfBus.join(', ')}; the bus must call nobody (ADR-0005)`);
  }
  const cycle = findCycle(graph);
  if (cycle) {
    problems.push(
      `call cycle ${cycle.join(' -> ')}; make one direction an event (ADR-0002, ADR-0005)`,
    );
  }
  return problems;
}

function selfTest(): string[] {
  const graph = (edges: Record<string, string[]>): Graph =>
    new Map(Object.entries(edges).map(([from, to]) => [from, new Set(to)]));
  const failures: string[] = [];
  const cyclic = graph({ a: ['b'], b: ['c'], c: ['a'], [BUS]: [] });
  if (!findCycle(cyclic)) failures.push('self-test: missed the cycle a -> b -> c -> a');
  const acyclic = graph({ a: ['b', 'c'], b: ['c'], c: [BUS], [BUS]: [] });
  if (graphProblems(acyclic).length > 0) failures.push('self-test: refused an acyclic graph');
  if (graphProblems(graph({ [BUS]: ['a'], a: [] })).length !== 1) {
    failures.push('self-test: missed a call made by the bus');
  }
  return failures;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
    .map((e) => join(e.parentPath, e.name));
}

/** Source without comments, so commented-out code neither adds nor hides an edge. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const registry = readRegistry();
const workloads = new Set([registry.gateway.name, ...registry.services.map((s) => s.name)]);
const apps = [
  { name: registry.gateway.name, dir: registry.gateway.dir },
  ...registry.services.map((s) => ({ name: s.name, dir: s.dir })),
];

const problems = selfTest();
const graph = new Map<string, Set<string>>(apps.map((app) => [app.name, new Set<string>()]));
for (const app of apps) {
  const edges = graph.get(app.name) as Set<string>;
  for (const path of sourceFiles(join(ROOT, app.dir, 'src'))) {
    const text = code(readFileSync(path, 'utf8'));
    const shown = relative(ROOT, path);
    if (/\bEventsModule\s*\.\s*forRoot\s*\(/.test(text)) edges.add(BUS);
    if (!/\bGrpcClientsModule\s*\.\s*register\s*\(/.test(text)) continue;
    for (const match of text.matchAll(/\btarget\s*:\s*([^,}\n]+)/g)) {
      const value = (match[1] ?? '').trim();
      const literal = /^'([a-z][a-z0-9-]*)'$/.exec(value)?.[1];
      if (!literal) {
        problems.push(`${shown}: client target ${value} is not a string literal`);
      } else if (!workloads.has(literal)) {
        problems.push(`${shown}: client target '${literal}' is not a registered workload`);
      } else {
        edges.add(literal);
      }
    }
  }
}
problems.push(...graphProblems(graph));

if (problems.length > 0) {
  console.error(`check-call-graph: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const shown = [...graph]
  .filter(([, to]) => to.size > 0)
  .map(([from, to]) => `${from} -> ${[...to].sort().join(', ')}`)
  .join('; ');
console.log(`check-call-graph: acyclic, ${BUS} calls nobody (${shown})`);
