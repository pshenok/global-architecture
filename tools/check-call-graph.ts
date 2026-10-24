/**
 * Call-graph guardrail (ADR-0002, ADR-0005), run by `pnpm lint`. Synchronous calls
 * between services must form a DAG, and event-bus-service must call nobody: every flow
 * that goes "backwards" is an event through the bus, and the bus is a sink.
 *
 * Nodes are the gateway and the services of services.json. The code is read with the
 * TypeScript 7 checker (`typescript/unstable/sync`), like tools/check-access.ts, so names
 * resolve through imports, renames and re-exports; nothing is matched by spelling.
 * Production code is what check-access reads: every `.ts` file under apps/*\/src,
 * packages/*\/src, templates/service/src, packages/contracts/scripts and tools/, minus
 * specs, the published test helpers and generated contracts; each must belong to a
 * tsconfig project.
 *
 * 1. Edges. In an app's src/, every reference to the kit's GrpcClientsModule.register is
 *    the callee of a call whose one argument is an inline array of inline object literals,
 *    each with a `target: '<workload>'` property whose value is a string literal naming
 *    the gateway or a service; each target is an edge. Anything else fails: definitions
 *    built elsewhere, a spread, a computed key, a shorthand or accessor target, a target
 *    that is not a literal or names an unknown workload, register used as a value, and
 *    GrpcClientsModule used other than as `GrpcClientsModule.register(...)`. Any use of
 *    the kit's EventsModule (forRoot or not) adds an edge to event-bus-service.
 * 2. Clients are declared only there. Outside apps' src, GrpcClientsModule and EventsModule
 *    are only imported and re-exported, except in the kit's own two modules. Outside the
 *    kit and tools/, nothing builds a gRPC client without the kit (Nest's
 *    ClientProxyFactory, ClientsModule, ClientGrpcProxy or @Client; grpc-js Client, Channel,
 *    loadPackageDefinition or makeClientConstructor) and no code (an import or export
 *    without names included) reaches into an app other than its own, so every client
 *    counts for the app whose src declares it.
 * 3. Every name stays visible. A namespace import, `export *`, `export * as` or `import()`
 *    binds a whole module, and what is read from it (`kit[name]`) has no name to resolve.
 *    In apps' src and templates/service/src none is allowed. Elsewhere outside the kit and
 *    tools/, none may bind a module that is the kit (src or dist), @nestjs/microservices,
 *    @grpc/grpc-js or an app's code, or that exports a client builder, an app's code or
 *    such a module; and nowhere outside them may a default or named import be one (a
 *    CommonJS module's default import is the whole module).
 * 4. The graph has no cycle, and no edge leaves event-bus-service.
 *
 * What this guarantees: every client the kit builds for production code is an edge of the
 * app whose src declares it, to the target written there, and nothing else in production
 * code builds a gRPC client. TypeScript is not sound, though, so a deliberate structural
 * cast (a value whose static type hides what it is, such as the kit's class found in Nest
 * module metadata) can still carry a client past this checker, as can code that defeats it
 * at run time (eval and the like). Both are left to CODEOWNERS review, with run-time
 * backstops: the kit signs only for the target register() validated, the bus signs no
 * caller assertion at all (ADR-0005), and a service method accepts only the callers its
 * @Access allows (a public one any signed caller).
 *
 * Every run first checks itself: rule 4 on synthetic graphs, rules 1 to 3 on the probes in
 * apps/house-service/test/call-graph-probes, read as house-service's src (its package/
 * folder as a package's src). A line marked `// refused` must be refused and no other
 * line; a line marked `// edge: <workload>` must yield exactly that edge and no other line
 * any. Probe edges never enter the graph.
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type ArrayLiteralExpression,
  type CallExpression,
  type ExportDeclaration,
  type ExportSpecifier,
  type Identifier,
  type ImportDeclaration,
  type ImportSpecifier,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type ShorthandPropertyAssignment,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from 'typescript/unstable/ast';
import {
  API,
  type Checker,
  type Project,
  SymbolFlags,
  type Symbol as TsSymbol,
} from 'typescript/unstable/sync';
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

/** The graph rules on two synthetic graphs (one cyclic, one acyclic) and a calling bus. */
function graphSelfTest(): string[] {
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

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);
/** Generated code (buf), skipped by its exact path, as check-access does. */
const GENERATED = 'packages/contracts/src/gen';

/** Production code, as check-access reads it: source folders and tools, without tests. */
const isProduction = (file: string) =>
  /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|templates\/service\/src|packages\/contracts\/scripts|tools)\//.test(
    file,
  ) &&
  !file.endsWith('.spec.ts') &&
  !file.startsWith('packages/service-kit/src/testing/') &&
  file !== 'packages/kernel/src/testing.ts';
const isKit = (file: string) => file.startsWith('packages/service-kit/src/');

/** The kit's client builders, by the file that declares them (src or dist). */
const CLIENTS_MODULE =
  /packages\/service-kit\/(?:src|dist)\/grpc\/grpc-clients\.module\.(?:d\.)?ts$/;
const EVENTS_MODULE = /packages\/service-kit\/(?:src|dist)\/events\/events\.module\.(?:d\.)?ts$/;
/** The kit modules that define the builders (EventsModule registers the bus client). */
const BUILDER_FILES = new Set([
  'packages/service-kit/src/grpc/grpc-clients.module.ts',
  'packages/service-kit/src/events/events.module.ts',
]);
/**
 * What builds a gRPC client without the kit, by declaring package and declared name
 * (grpc-js exports ChannelImplementation as Channel, makeClientConstructor also as
 * makeGenericClientConstructor).
 */
const RAW_CLIENTS: readonly {
  readonly package: string;
  readonly file: RegExp;
  readonly names: ReadonlySet<string>;
}[] = [
  {
    package: '@nestjs/microservices',
    file: /node_modules\/@nestjs\/microservices\//,
    names: new Set(['ClientProxyFactory', 'ClientsModule', 'ClientGrpcProxy', 'Client']),
  },
  {
    package: '@grpc/grpc-js',
    file: /node_modules\/@grpc\/grpc-js\//,
    names: new Set([
      'Client',
      'ChannelImplementation',
      'loadPackageDefinition',
      'makeClientConstructor',
      'makeGenericClientConstructor',
    ]),
  },
];
/** Modules no code outside the kit and tools/ binds whole (rule 3), by declaring file. */
const WHOLE_MODULES: readonly { readonly package: string; readonly file: RegExp }[] = [
  { package: 'the service kit', file: /packages\/service-kit\/(?:src|dist)\// },
  ...RAW_CLIENTS,
];

/**
 * Self-test: probe files of ways reviews found to hide a call, and legal spellings, checked
 * as if they were production code where `as` says (the most specific folder first). Their
 * edges stay out of the graph.
 */
const PROBES = [
  {
    dir: 'apps/house-service/test/call-graph-probes/package',
    as: 'packages/call-graph-probes/src',
  },
  {
    dir: 'apps/house-service/test/call-graph-probes',
    as: 'apps/house-service/src/call-graph-probes',
  },
];

/** The probe folder a repo path belongs to, if any. */
const probeOf = (file: string) =>
  PROBES.find(({ dir }) => file.toLowerCase().startsWith(`${dir.toLowerCase()}/`));

const registry = readRegistry();
const workloads = new Set([registry.gateway.name, ...registry.services.map((s) => s.name)]);
const apps = [
  { name: registry.gateway.name, dir: registry.gateway.dir },
  ...registry.services.map((s) => ({ name: s.name, dir: s.dir })),
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name) || relative(ROOT, path) === GENERATED) continue;
    if (entry.isDirectory()) yield* sourceFiles(path);
    else yield path;
  }
}

/** Every node of a file, depth first. */
function nodesOf(file: SourceFile): Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node): void => {
    nodes.push(node);
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return nodes;
}

const textOf = (node: Node | undefined): string | undefined =>
  node &&
  (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    ? (node as StringLiteral).text
    : undefined;

/** What one project resolved: alias targets, and why a module may not be bound whole. */
interface Cache {
  readonly aliases: Map<number, TsSymbol>;
  readonly modules: Map<number, string | undefined>;
}
const newCache = (): Cache => ({ aliases: new Map(), modules: new Map() });

/** Follows import aliases to the declared symbol (cached per project). */
function declared(checker: Checker, cache: Map<number, TsSymbol>, symbol: TsSymbol): TsSymbol {
  if (!(symbol.flags & SymbolFlags.Alias)) return symbol;
  let target = cache.get(symbol.id);
  if (!target) {
    target = checker.getAliasedSymbol(symbol);
    cache.set(symbol.id, target);
  }
  return target;
}

const declaredIn = (symbol: TsSymbol, pattern: RegExp) =>
  symbol.declarations.some((declaration) => pattern.test(declaration.path));

/**
 * The app folder name of a repo path or checker path (lower-cased, as the checker may). A
 * probe counts where PROBES reads it, so imports between probes do too.
 */
function appOf(path: string): string | undefined {
  const lower = path.toLowerCase();
  const root = ROOT.toLowerCase();
  let file = lower.startsWith(root) ? lower.slice(root.length) : lower;
  const probe = probeOf(file);
  if (probe) file = probe.as + file.slice(probe.dir.length);
  return /^apps\/([^/]+)\//.exec(file)?.[1];
}

/** Whether a symbol is a whole module (a file or `declare module '...'`), as a namespace is. */
const isModule = (symbol: TsSymbol) =>
  (symbol.flags & SymbolFlags.ValueModule) !== 0 && symbol.name.startsWith('"');

type Builder =
  | 'GrpcClientsModule'
  | 'GrpcClientsModule.register'
  | 'EventsModule'
  | 'EventsModule.forRoot';

/** Which of the kit's client builders a declared symbol is, if any. */
function builderOf(symbol: TsSymbol): Builder | undefined {
  const isClass = (symbol.flags & SymbolFlags.Class) !== 0;
  const isMethod = (symbol.flags & SymbolFlags.Method) !== 0;
  if (declaredIn(symbol, CLIENTS_MODULE)) {
    if (isClass && symbol.name === 'GrpcClientsModule') return 'GrpcClientsModule';
    if (isMethod && symbol.name === 'register') return 'GrpcClientsModule.register';
  } else if (declaredIn(symbol, EVENTS_MODULE)) {
    if (isClass && symbol.name === 'EventsModule') return 'EventsModule';
    if (isMethod && symbol.name === 'forRoot') return 'EventsModule.forRoot';
  }
  return undefined;
}

/** Why a declared symbol may not be reachable through a whole module, if it may not. */
function clientOf(symbol: TsSymbol): string | undefined {
  if (builderOf(symbol)) return 'is a client builder of the service kit';
  const raw = RAW_CLIENTS.find(
    ({ file, names }) => names.has(symbol.name) && declaredIn(symbol, file),
  );
  if (raw) return `builds ${raw.package} clients`;
  const owner = symbol.declarations.map(({ path }) => appOf(path)).find(Boolean);
  return owner ? `is code of apps/${owner}` : undefined;
}

/**
 * Why a module may not be bound whole outside the kit and tools/ (rule 3), or undefined:
 * it is the kit, @nestjs/microservices, @grpc/grpc-js or an app's code, or it exports a
 * client builder, an app's code or such a module.
 */
function exposes(checker: Checker, cache: Cache, module: TsSymbol): string | undefined {
  if (cache.modules.has(module.id)) return cache.modules.get(module.id);
  cache.modules.set(module.id, undefined);
  const paths = module.declarations.map(({ path }) => path);
  const known = WHOLE_MODULES.find(({ file }) => paths.some((path) => file.test(path)));
  const owner = paths.map(appOf).find(Boolean);
  let reason = known ? `is ${known.package}` : owner ? `is code of apps/${owner}` : undefined;
  for (const exported of reason ? [] : checker.getExportsOfModule(module)) {
    const target = declared(checker, cache.aliases, exported);
    const inner = isModule(target) ? exposes(checker, cache, target) : clientOf(target);
    if (inner) {
      reason = `exports ${exported.name}, which ${inner}`;
      break;
    }
  }
  cache.modules.set(module.id, reason);
  return reason;
}

/** A module load: an import or export declaration naming a module, or `import()`. */
interface Load {
  readonly specifier: Node | undefined;
  /** How it binds the whole module, when it does (rule 3). */
  readonly whole: string | undefined;
}

function loadOf(node: Node): Load | undefined {
  if (node.kind === SyntaxKind.ImportDeclaration) {
    const { importClause, moduleSpecifier } = node as ImportDeclaration;
    const namespace = importClause?.namedBindings?.kind === SyntaxKind.NamespaceImport;
    return { specifier: moduleSpecifier, whole: namespace ? 'a namespace import' : undefined };
  }
  if (node.kind === SyntaxKind.ExportDeclaration) {
    const { exportClause, moduleSpecifier } = node as ExportDeclaration;
    if (!moduleSpecifier) return undefined;
    if (!exportClause) return { specifier: moduleSpecifier, whole: '`export *`' };
    const namespace = exportClause.kind === SyntaxKind.NamespaceExport;
    return { specifier: moduleSpecifier, whole: namespace ? '`export * as`' : undefined };
  }
  if (
    node.kind === SyntaxKind.CallExpression &&
    (node as CallExpression).expression.kind === SyntaxKind.ImportKeyword
  ) {
    return { specifier: (node as CallExpression).arguments[0], whole: '`import()`' };
  }
  return undefined;
}

const NAME_IT = 'import the names you use instead, so the call graph can follow them';

type Fail = (node: Node, message: string) => void;

/** The target literal of one inline client definition; undefined (after a problem) otherwise. */
function targetOf(definition: ObjectLiteralExpression, fail: Fail): StringLiteral | undefined {
  let target: PropertyAssignment | undefined;
  for (const property of definition.properties) {
    if (property.kind === SyntaxKind.SpreadAssignment) {
      fail(property, 'spreads into a client definition, which can hide its target');
      return undefined;
    }
    const name = (property as PropertyAssignment).name;
    if (name.kind === SyntaxKind.ComputedPropertyName) {
      fail(property, 'a client definition has a computed key, which can hide its target');
      return undefined;
    }
    if ((name as Identifier).text !== 'target') continue;
    if (property.kind !== SyntaxKind.PropertyAssignment || target) {
      fail(
        property,
        "write the client target once, as `target: '<workload>'` (no shorthand or accessor)",
      );
      return undefined;
    }
    target = property as PropertyAssignment;
  }
  if (!target) {
    fail(definition, "a client definition has no `target: '<workload>'` property");
    return undefined;
  }
  const value = textOf(target.initializer);
  if (value === undefined) {
    fail(target, `client target ${target.initializer.getText()} is not a string literal`);
    return undefined;
  }
  if (!workloads.has(value)) {
    fail(target, `client target '${value}' is not a registered workload`);
    return undefined;
  }
  return target.initializer as StringLiteral;
}

interface Edge {
  readonly to: string;
  readonly line: number;
}

/**
 * Checks one production file and returns its problems and edges. `shown` names it in
 * problems; `file` decides which rules apply (the self-test checks its probes as if they
 * lived in an app's src).
 */
function checkFile(
  checker: Checker,
  file: string,
  source: SourceFile,
  cache: Cache,
  shown = file,
): { problems: string[]; edges: Edge[] } {
  const problems: string[] = [];
  const edges: Edge[] = [];
  const lineOf = (node: Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const fail: Fail = (node, message) => problems.push(`${shown}:${lineOf(node)}: ${message}`);
  const app = /^apps\/[^/]+\/src\//.test(file) ? appOf(file) : undefined;
  const kit = isKit(file);
  const tools = file.startsWith('tools/');
  const strict = app !== undefined || file.startsWith('templates/service/src/');
  const nodes = nodesOf(source);

  // Module loads: where each reaches (`export *`, `import()` or an import without names
  // leaves no identifier below to resolve), and whether it binds a whole module (rule 3).
  for (const node of tools ? [] : nodes) {
    const load = loadOf(node);
    if (!load) continue;
    const specifier = load.specifier;
    const name = textOf(specifier);
    const module = name === undefined ? undefined : checker.getSymbolAtLocation(specifier as Node);
    const other = module?.declarations
      .map(({ path }) => appOf(path))
      .find((owner) => owner && owner !== app);
    if (other) {
      fail(
        node,
        `reaches into apps/${other} (${name}); an app declares its own clients, shared code lives in packages`,
      );
    }
    if (kit || !load.whole) continue;
    const what = `${load.whole} of ${specifier?.getText(source) ?? 'nothing'}`;
    if (strict) {
      fail(node, `${what} binds a whole module, which hides the names read from it; ${NAME_IT}`);
      continue;
    }
    const reason = module ? exposes(checker, cache, module) : 'cannot be resolved';
    if (reason) fail(node, `${what}, which ${reason}, hides the names read from it; ${NAME_IT}`);
  }

  const identifiers = nodes.filter(
    (node): node is Identifier => node.kind === SyntaxKind.Identifier,
  );
  const symbols = identifiers.length > 0 ? checker.getSymbolAtLocation(identifiers) : [];
  identifiers.forEach((identifier, index) => {
    const parent = identifier.parent;
    // `{ GrpcClientsModule }` names the property; the value it copies is what matters.
    const symbol =
      parent.kind === SyntaxKind.ShorthandPropertyAssignment &&
      (parent as ShorthandPropertyAssignment).name === identifier
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : symbols[index];
    if (!symbol) return;
    const target = declared(checker, cache.aliases, symbol);
    // `import grpc from '@grpc/grpc-js'` (a CommonJS module's default) or `{ ns }` is the
    // whole module, as a namespace import is.
    if (
      !kit &&
      !tools &&
      isModule(target) &&
      (parent.kind === SyntaxKind.ImportClause ||
        ((parent.kind === SyntaxKind.ImportSpecifier ||
          parent.kind === SyntaxKind.ExportSpecifier) &&
          (parent as ImportSpecifier | ExportSpecifier).name === identifier))
    ) {
      const reason = exposes(checker, cache, target);
      if (reason) {
        fail(identifier, `${identifier.text} binds a whole module, which ${reason}; ${NAME_IT}`);
      }
    }
    if (
      !kit &&
      !tools &&
      RAW_CLIENTS.some(
        ({ file: pattern, names }) => names.has(target.name) && declaredIn(target, pattern),
      )
    ) {
      fail(
        identifier,
        `builds a gRPC client without the kit (${target.name}); use GrpcClientsModule.register, so the call is signed and in this graph`,
      );
    }
    const other = tools
      ? undefined
      : target.declarations.map(({ path }) => appOf(path)).find((owner) => owner && owner !== app);
    if (other) {
      fail(
        identifier,
        `reaches into apps/${other} (${isModule(target) ? 'a whole module' : target.name}); an app declares its own clients, shared code lives in packages`,
      );
    }
    if (BUILDER_FILES.has(file)) return;
    const builder = builderOf(target);
    if (!builder) return;
    if (parent.kind === SyntaxKind.ImportSpecifier || parent.kind === SyntaxKind.ExportSpecifier) {
      return;
    }
    if (!app) {
      fail(
        identifier,
        `uses ${builder} outside an app's src; an app declares its own clients, so the graph can place them`,
      );
      return;
    }
    if (builder === 'EventsModule' || builder === 'EventsModule.forRoot') {
      edges.push({ to: BUS, line: lineOf(identifier) });
      return;
    }
    if (builder === 'GrpcClientsModule') {
      // `GrpcClientsModule` or `kit.GrpcClientsModule`, followed by `.register`.
      const head =
        parent.kind === SyntaxKind.PropertyAccessExpression &&
        (parent as PropertyAccessExpression).name === identifier
          ? parent
          : identifier;
      const access = head.parent as PropertyAccessExpression;
      if (
        access.kind !== SyntaxKind.PropertyAccessExpression ||
        access.expression !== head ||
        access.name.kind !== SyntaxKind.Identifier ||
        (access.name as Identifier).text !== 'register'
      ) {
        fail(identifier, 'uses GrpcClientsModule other than as GrpcClientsModule.register([...])');
      }
      return;
    }
    const access = parent as PropertyAccessExpression;
    const call = access.parent as CallExpression;
    if (
      parent.kind !== SyntaxKind.PropertyAccessExpression ||
      access.name !== identifier ||
      call.kind !== SyntaxKind.CallExpression ||
      call.expression !== access
    ) {
      fail(identifier, 'uses GrpcClientsModule.register other than by calling it');
      return;
    }
    const definitions = call.arguments[0];
    if (call.arguments.length !== 1 || definitions?.kind !== SyntaxKind.ArrayLiteralExpression) {
      fail(
        definitions ?? call,
        'pass GrpcClientsModule.register one inline array of client definitions, so their targets can be read',
      );
      return;
    }
    for (const element of (definitions as ArrayLiteralExpression).elements) {
      if (element.kind !== SyntaxKind.ObjectLiteralExpression) {
        fail(element, 'write each client definition as an inline object literal');
        continue;
      }
      const literal = targetOf(element as ObjectLiteralExpression, fail);
      if (literal) edges.push({ to: literal.text, line: lineOf(literal) });
    }
  });
  return { problems, edges };
}

/** The tsconfig projects production code belongs to. */
function projects(): string[] {
  const configs = [join(ROOT, 'tsconfig.json'), join(ROOT, 'templates/service/tsconfig.json')];
  for (const top of ['apps', 'packages']) {
    for (const entry of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        readdirSync(join(ROOT, top, entry.name)).includes('tsconfig.json')
      ) {
        configs.push(join(ROOT, top, entry.name, 'tsconfig.json'));
      }
    }
  }
  return configs;
}

function probeSelfTest(snapshot: ReturnType<API['updateSnapshot']>): string[] {
  const failures: string[] = [];
  for (const probe of PROBES) {
    const paths = [...sourceFiles(join(ROOT, probe.dir))].filter(
      (path) => probeOf(relative(ROOT, path)) === probe,
    );
    if (paths.length === 0) failures.push(`${probe.dir}: check-call-graph self-test has no probes`);
    for (const path of paths) {
      const shown = relative(ROOT, path);
      const project = snapshot.getDefaultProjectForFile(path);
      const source = project?.program.getSourceFile(path);
      if (!project || !source) {
        failures.push(
          `${shown}: check-call-graph self-test probe is not part of a tsconfig project`,
        );
        continue;
      }
      const file = join(probe.as, relative(join(ROOT, probe.dir), path));
      const { problems, edges } = checkFile(project.checker, file, source, newCache(), shown);
      const refused = new Map<number, string>();
      for (const problem of problems) {
        const line = Number(/^[^:]+:(\d+):/.exec(problem)?.[1]);
        if (line) refused.set(line, problem);
      }
      const found = new Map<number, Set<string>>();
      for (const { line, to } of edges) found.set(line, (found.get(line) ?? new Set()).add(to));
      const lines = source.text.split('\n');
      lines.forEach((text, index) => {
        const line = index + 1;
        // The marker ends the line, or (where the formatter moves it into a block) is the
        // whole next line.
        const marked =
          (/\/\/ refused\b/.test(text) && text.trim() !== '// refused') ||
          lines[index + 1]?.trim() === '// refused';
        if (marked && !refused.has(line)) {
          failures.push(
            `${shown}:${line}: check-call-graph self-test: this probe is no longer refused`,
          );
        } else if (!marked && refused.has(line)) {
          failures.push(
            `check-call-graph self-test: refuses a probe not marked as refused: ${refused.get(line)}`,
          );
        }
        const expected = /\/\/ edge: ([a-z][a-z0-9-]*)\s*$/.exec(text)?.[1];
        const got = [...(found.get(line) ?? [])].sort();
        if (expected ? got.length !== 1 || got[0] !== expected : got.length > 0) {
          failures.push(
            `${shown}:${line}: check-call-graph self-test: expected ${expected ? `the edge to ${expected}` : 'no edge'}, found ${got.join(', ') || 'none'}`,
          );
        }
      });
    }
  }
  return failures;
}

const problems = graphSelfTest();
const graph = new Map<string, Set<string>>(apps.map((app) => [app.name, new Set<string>()]));
const api = new API({ cwd: ROOT });
try {
  const snapshot = api.updateSnapshot({ openProjects: projects() });
  const caches = new Map<Project, Cache>();
  for (const top of ['apps', 'packages', 'templates', 'tools']) {
    for (const path of sourceFiles(join(ROOT, top))) {
      const file = relative(ROOT, path);
      if (!isProduction(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
      if (!file.endsWith('.ts') || (/\.d\.[cm]?ts$/.test(file) && !isKit(file))) {
        problems.push(`${file}: production code is checked TypeScript (.ts files, no .d.ts)`);
        continue;
      }
      const project = snapshot.getDefaultProjectForFile(path);
      const source = project?.program.getSourceFile(path);
      if (!project || !source) {
        problems.push(
          `${file}: not part of any tsconfig project, so check-call-graph cannot read it`,
        );
        continue;
      }
      const cache = caches.get(project) ?? newCache();
      caches.set(project, cache);
      const found = checkFile(project.checker, file, source, cache);
      problems.push(...found.problems);
      if (found.edges.length === 0) continue;
      const dir = /^apps\/[^/]+/.exec(file)?.[0];
      const app = apps.find((candidate) => candidate.dir === dir);
      if (!app) {
        problems.push(
          `${file}: ${dir} is not in services.json, so its calls have no place in the graph`,
        );
        continue;
      }
      for (const edge of found.edges) graph.get(app.name)?.add(edge.to);
    }
  }
  problems.push(...probeSelfTest(snapshot));
} finally {
  api.close();
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
