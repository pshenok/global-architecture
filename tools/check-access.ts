/**
 * Access guardrails (ADR-0004), run by `pnpm lint`. The code is read with the TypeScript 7
 * checker (`typescript/unstable/sync`), so names resolve through imports, renames,
 * namespaces and type aliases the way the compiler sees them; nothing is matched by
 * spelling. Production code is every `.ts` file under apps/*\/src, packages/*\/src,
 * templates/service/src, packages/contracts/scripts and tools/, minus specs, the published
 * test helpers and generated contracts; each must belong to a tsconfig project.
 *
 * 1. Endpoints. Outside the files that define them, the access decorators (@Public,
 *    @AllowUnregistered, @Access.*) are used only as a decorator written on a method or
 *    class, with inline literal arguments; their metadata (AUTH_ROUTE, ACCESS_POLICY,
 *    PUBLIC_EXTENSION, accessPolicyOf, SetMetadata, Reflect's metadata writers and the key
 *    strings) is not used at all. Every decorator that opens something without a user
 *    (public, unregistered, identity, service) is listed with the same reason in
 *    security/public-endpoints.json (CODEOWNERS). The tests compare the same list with
 *    the policies the apps enforce (startTestService, createTestGateway).
 * 2. Actors. Outside the service kit and kernel/actor.ts, nothing produces a value whose
 *    type carries the kernel's verified brand: no type assertion or type predicate to such
 *    a type, to `never` or to a bare type parameter, no `x!` that yields `never`, no object
 *    literal or library call (Object.assign, structuredClone, ...) of such a type, no
 *    overload or ambient declaration returning one. Biome refuses explicit `any` and oxlint
 *    implicit `any`, the remaining way around a type.
 * 3. Identity metadata (x-ga-caller, x-ga-principal) appears only in the service kit.
 * 4. Production code never reaches the test helpers (kernel testing.ts, the kit's
 *    testing/) by any route, and never loads a module from a computed specifier.
 * 5. Gateway routes are controller routes: outside bootstrap.ts and http/openapi.ts no
 *    gateway code touches the HTTP adapter, the Fastify instance or Nest middleware.
 *    createTestGateway also fails on any route no controller serves.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type ArrayLiteralExpression,
  type AsExpression,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Identifier,
  type ImportSpecifier,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
  type TypeAssertion,
  type TypePredicateNode,
} from 'typescript/unstable/ast';
import {
  API,
  type Checker,
  type Project,
  SymbolFlags,
  type Symbol as TsSymbol,
  type Type,
  TypeFlags,
} from 'typescript/unstable/sync';
import { ROOT } from './lib.ts';

interface Entry {
  readonly where: string;
  readonly access: 'public' | 'unregistered' | 'identity' | 'service';
  readonly reason: string;
}

const LIST = join(ROOT, 'security/public-endpoints.json');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);
/** Generated code (buf), skipped by its exact path: a hand-written `gen` folder is checked. */
const GENERATED = 'packages/contracts/src/gen';

/** Production code: source folders and tools, without tests. */
const isProduction = (file: string) =>
  /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|templates\/service\/src|packages\/contracts\/scripts|tools)\//.test(
    file,
  ) &&
  !file.endsWith('.spec.ts') &&
  !file.startsWith('packages/service-kit/src/testing/') &&
  file !== 'packages/kernel/src/testing.ts';
/** The service kit owns identity metadata, actor construction and the @Access decorators. */
const isKit = (file: string) => file.startsWith('packages/service-kit/src/');
/** Gateway files that define or read the route decorators' metadata. */
const GATEWAY_ACCESS_CODE = new Set([
  'apps/gateway/src/auth/decorators.ts',
  'apps/gateway/src/auth/auth.guard.ts',
  'apps/gateway/src/auth/auth-routes.ts',
  'apps/gateway/src/http/openapi.ts',
]);
/** Gateway files that may touch the raw HTTP server (hooks, the docs pages). */
const GATEWAY_RAW_HTTP = new Set([
  'apps/gateway/src/bootstrap.ts',
  'apps/gateway/src/http/openapi.ts',
]);

/** Exports that declare or carry access, by the file that defines them (src or dist). */
const ACCESS_EXPORTS: readonly { readonly file: RegExp; readonly names: ReadonlySet<string> }[] = [
  {
    file: /apps\/gateway\/src\/auth\/decorators\.ts$/,
    names: new Set(['Public', 'AllowUnregistered', 'AUTH_ROUTE', 'PUBLIC_EXTENSION']),
  },
  {
    file: /packages\/service-kit\/(?:src|dist)\/auth\/access\.(?:d\.)?ts$/,
    names: new Set(['Access', 'ACCESS_POLICY', 'accessPolicyOf']),
  },
  { file: /node_modules\/@nestjs\/common\//, names: new Set(['SetMetadata']) },
  {
    file: /node_modules\/reflect-metadata\//,
    names: new Set(['defineMetadata', 'deleteMetadata', 'metadata', 'decorate']),
  },
];
const DECORATORS = new Set(['Public', 'AllowUnregistered', 'Access']);
const ACCESS_KINDS = new Set(['public', 'identity', 'service', 'user', 'admin']);
const ACCESS_KEYS = new Set(['ga:auth-route', 'ga:access-policy', 'x-ga-public']);
const IDENTITY_KEYS = new Set(['x-ga-caller', 'x-ga-principal']);
/** The published test helpers, by declaring file. */
const TEST_HELPER_FILE =
  /packages\/(?:kernel\/(?:src|dist)\/testing\.(?:d\.)?ts|service-kit\/(?:src|dist)\/testing\/)/;
const TEST_HELPER_SPECIFIER =
  /^(?:@ga\/(?:kernel|service-kit)\/testing(?:\/.*)?|\.{1,2}\/(?:.*\/)?testing(?:\.ts|\/.*)?)$/;
/** Nest APIs that reach the HTTP server or add middleware outside controllers. */
const RAW_HTTP_NEST = new Set([
  'HttpAdapterHost',
  'httpAdapter',
  'getHttpAdapter',
  'getInstance',
  'getHttpServer',
  'use',
  'MiddlewareConsumer',
  'NestModule',
  'forRoutes',
]);
const NEST_FILE = /node_modules\/@nestjs\/(?:common|core|platform-fastify)\//;
/** What adds routes, hooks or plugins to a Fastify instance or a Nest HTTP adapter. */
const RAW_HTTP_VERBS = new Set([
  'route',
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'all',
  'head',
  'options',
  'register',
  'addHook',
  'setNotFoundHandler',
  'setErrorHandler',
  'decorate',
  'decorateRequest',
  'decorateReply',
  'addContentTypeParser',
]);
const RAW_HTTP_FILE =
  /node_modules\/(?:fastify|@fastify)\/|node_modules\/@nestjs\/(?:core\/adapters|common\/interfaces\/http|platform-fastify\/adapters)\//;
/**
 * Platform code that loads a module by a computed path on purpose: protobufjs descriptors
 * next to @grpc/proto-loader, and @fastify/otel only where the app depends on it.
 */
const COMPUTED_LOADS = new Set([
  'packages/contracts/src/runtime/reflection.ts',
  'packages/contracts/src/runtime/wkt.ts',
  'packages/service-kit/src/telemetry/instrumentation.ts',
]);
/** The kernel's actor brand: a unique symbol declared in packages/kernel/src/actor.ts. */
const BRAND = /^__@verified@\d+$/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name) || relative(ROOT, path) === GENERATED) continue;
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

const found: Entry[] = [];
const problems: string[] = [];

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

/** Names in an inline literal array of strings; undefined when it is anything else. */
function literalNames(node: Node | undefined): string[] | undefined {
  if (node?.kind !== SyntaxKind.ArrayLiteralExpression) return undefined;
  const names = (node as ArrayLiteralExpression).elements.map(textOf);
  return names.every((name): name is string => name !== undefined) ? names : undefined;
}

/** The value of the only property of an inline object literal, checked by name. */
function onlyProperty(node: Node | undefined, name: string): Node | undefined | 'unreadable' {
  if (node === undefined) return undefined;
  if (node.kind !== SyntaxKind.ObjectLiteralExpression) return 'unreadable';
  const properties = (node as ObjectLiteralExpression).properties;
  if (properties.length === 0) return undefined;
  const property = properties[0] as PropertyAssignment | undefined;
  if (
    properties.length !== 1 ||
    property?.kind !== SyntaxKind.PropertyAssignment ||
    property.name.kind !== SyntaxKind.Identifier ||
    (property.name as Identifier).text !== name
  ) {
    return 'unreadable';
  }
  return property.initializer;
}

/** What an access decorator call opens; `unreadable` when its arguments are not literals. */
function opening(
  kind: string,
  call: CallExpression,
): Pick<Entry, 'access' | 'reason'> | 'unreadable' | undefined {
  const args = call.arguments;
  switch (kind) {
    case 'Public':
    case 'public': {
      const reason = textOf(args[0]);
      const ignoreToken = onlyProperty(kind === 'Public' ? args[1] : undefined, 'ignoreToken');
      const flagIsLiteral =
        ignoreToken === undefined ||
        (ignoreToken !== 'unreadable' &&
          (ignoreToken.kind === SyntaxKind.TrueKeyword ||
            ignoreToken.kind === SyntaxKind.FalseKeyword));
      return reason !== undefined && flagIsLiteral && args.length <= (kind === 'Public' ? 2 : 1)
        ? { access: 'public', reason }
        : 'unreadable';
    }
    case 'AllowUnregistered':
      return args.length === 0 ? { access: 'unregistered', reason: 'registration' } : 'unreadable';
    case 'identity': {
      const via = onlyProperty(args[0], 'via');
      const names = via === undefined ? [] : via === 'unreadable' ? undefined : literalNames(via);
      if (!names || args.length > 1) return 'unreadable';
      return {
        access: 'identity',
        reason:
          names.length > 0
            ? `login without a user, via ${names.join(', ')}`
            : 'login without a user',
      };
    }
    case 'service': {
      const names = literalNames(args[0]);
      return names && args.length === 1
        ? { access: 'service', reason: `workloads: ${names.join(', ')}` }
        : 'unreadable';
    }
    default:
      return undefined; // user and admin need a user: they open nothing
  }
}

/** `Class.method`, or `Class` for a decorator on a class; undefined for anything else. */
function memberOf(decorator: Decorator): string | undefined {
  const target = decorator.parent;
  if (target.kind === SyntaxKind.ClassDeclaration) return (target as ClassDeclaration).name?.text;
  if (target.kind !== SyntaxKind.MethodDeclaration) return undefined;
  const method = target as MethodDeclaration;
  const owner = method.parent as ClassDeclaration;
  if (owner.kind !== SyntaxKind.ClassDeclaration || !owner.name) return undefined;
  if (method.name.kind !== SyntaxKind.Identifier) return undefined;
  return `${owner.name.text}.${(method.name as Identifier).text}`;
}

/** `@Public(...)` / `@AllowUnregistered()` / `@Access.<kind>(...)` headed by this identifier. */
function directDecorator(
  identifier: Identifier,
  name: string,
): { decorator: Decorator; call: CallExpression; kind: string } | undefined {
  let head: Node = identifier;
  let kind = name;
  if (name === 'Access') {
    const access = identifier.parent as PropertyAccessExpression;
    if (
      access.kind !== SyntaxKind.PropertyAccessExpression ||
      access.expression !== identifier ||
      access.name.kind !== SyntaxKind.Identifier
    ) {
      return undefined;
    }
    kind = (access.name as Identifier).text;
    if (!ACCESS_KINDS.has(kind)) return undefined;
    head = access;
  }
  const call = head.parent as CallExpression;
  if (call.kind !== SyntaxKind.CallExpression || call.expression !== head) return undefined;
  const decorator = call.parent as Decorator;
  if (decorator.kind !== SyntaxKind.Decorator) return undefined;
  return { decorator, call, kind };
}

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

/** Whether a value of this type carries the verified brand (any member of a union counts). */
function branded(checker: Checker, type: Type | undefined, seen = new Set<number>()): boolean {
  if (!type || seen.has(type.id)) return false;
  seen.add(type.id);
  if (
    (type.isUnionType() || type.isIntersectionType()) &&
    (type.getTypes() ?? []).some((member) => branded(checker, member, seen))
  ) {
    return true;
  }
  return checker.getPropertiesOfType(type).some((property) => BRAND.test(property.name));
}

const isNever = (type: Type | undefined) => !!type && (type.flags & TypeFlags.Never) !== 0;

function checkFile(
  project: Project,
  file: string,
  source: SourceFile,
  aliases: Map<number, TsSymbol>,
): void {
  const checker = project.checker;
  const nodes = nodesOf(source);
  const at = (node: Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const kit = isKit(file);
  const definesAccess = kit || GATEWAY_ACCESS_CODE.has(file);
  const tools = file.startsWith('tools/');

  // Literal strings: metadata keys and module names, in any quote style.
  for (const node of nodes) {
    const text = textOf(node);
    if (text === undefined) continue;
    if (!definesAccess && ACCESS_KEYS.has(text)) {
      problems.push(`${at(node)}: uses an access metadata key; declare access with the decorators`);
    }
    if (!kit && !tools && IDENTITY_KEYS.has(text)) {
      problems.push(
        `${at(node)}: builds identity metadata by hand; the service kit sets it on every call`,
      );
    }
    if (!tools && TEST_HELPER_SPECIFIER.test(text)) {
      problems.push(`${at(node)}: names a test helper module in production code`);
    }
  }

  // Dynamic loads: the specifier must be a literal the checks above can read.
  if (!tools && !COMPUTED_LOADS.has(file)) {
    for (const node of nodes) {
      if (node.kind !== SyntaxKind.CallExpression) continue;
      const call = node as CallExpression;
      const loads =
        call.expression.kind === SyntaxKind.ImportKeyword ||
        (call.expression.kind === SyntaxKind.Identifier &&
          (call.expression as Identifier).text === 'require');
      if (loads && textOf(call.arguments[0]) === undefined) {
        problems.push(`${at(node)}: loads a module from a computed specifier`);
      }
    }
  }

  // Identifiers: what each resolves to decides whether it may appear here.
  const identifiers = nodes.filter(
    (node): node is Identifier => node.kind === SyntaxKind.Identifier,
  );
  const symbols = identifiers.length > 0 ? checker.getSymbolAtLocation(identifiers) : [];
  identifiers.forEach((identifier, index) => {
    const symbol = symbols[index];
    if (!symbol) return;
    const target = declared(checker, aliases, symbol);
    const parent = identifier.parent;
    if (!tools && declaredIn(target, TEST_HELPER_FILE)) {
      problems.push(`${at(identifier)}: reaches a test helper (${target.name})`);
    }
    if (
      file.startsWith('apps/gateway/src/') &&
      !GATEWAY_RAW_HTTP.has(file) &&
      ((RAW_HTTP_NEST.has(target.name) && declaredIn(target, NEST_FILE)) ||
        (RAW_HTTP_VERBS.has(target.name) && declaredIn(target, RAW_HTTP_FILE)))
    ) {
      problems.push(
        `${at(identifier)}: touches the raw HTTP server (${target.name}); gateway routes are controller routes, so the auth guard sees them`,
      );
    }
    if (definesAccess) return;
    const access = ACCESS_EXPORTS.some(
      ({ file: pattern, names }) => names.has(target.name) && declaredIn(target, pattern),
    );
    if (!access) return;
    if (parent.kind === SyntaxKind.ImportSpecifier) {
      const specifier = parent as ImportSpecifier;
      if (specifier.propertyName && specifier.name === identifier) {
        problems.push(`${at(identifier)}: renames ${target.name} on import; use its own name`);
      }
      return;
    }
    const direct = DECORATORS.has(target.name)
      ? directDecorator(identifier, target.name)
      : undefined;
    if (direct) record(file, direct, at(identifier));
    else {
      problems.push(
        `${at(identifier)}: uses ${target.name} other than as a decorator on a method or class; access is declared only that way`,
      );
    }
  });

  if (!kit && !tools && file !== 'packages/kernel/src/actor.ts') checkActors(checker, nodes, at);
}

function record(
  file: string,
  direct: { decorator: Decorator; call: CallExpression; kind: string },
  at: string,
): void {
  const member = memberOf(direct.decorator);
  if (!member) {
    problems.push(`${at}: access decorators go on a named class or a plainly named method`);
    return;
  }
  const opened = opening(direct.kind, direct.call);
  if (opened === 'unreadable') {
    problems.push(`${at}: write this access decorator's arguments as inline literals`);
  } else if (opened) {
    found.push({ where: `${file}#${member}`, ...opened });
  }
}

function checkActors(checker: Checker, nodes: readonly Node[], at: (node: Node) => string): void {
  const forged = (node: Node, how: string) =>
    problems.push(
      `${at(node)}: ${how}; verified actors come only from currentUser() / currentActor()`,
    );
  for (const node of nodes) {
    if (node.kind === SyntaxKind.AsExpression || node.kind === SyntaxKind.TypeAssertionExpression) {
      const typeNode = (node as AsExpression | TypeAssertion).type;
      if (typeNode.kind === SyntaxKind.TypeReference && typeNode.getText() === 'const') continue;
      const type = checker.getTypeFromTypeNode(typeNode);
      if (branded(checker, type)) forged(node, 'asserts a verified actor type');
      else if (isNever(type)) forged(node, 'asserts `never`, which converts to any type');
      else if (type?.isTypeParameter()) forged(node, 'asserts a type parameter (a generic cast)');
    } else if (node.kind === SyntaxKind.TypePredicate) {
      const typeNode = (node as TypePredicateNode).type;
      const type = typeNode && checker.getTypeFromTypeNode(typeNode);
      if (branded(checker, type) || type?.isTypeParameter()) {
        forged(node, 'a type predicate claims a verified actor (or any type) unchecked');
      }
    }
  }
  // `x!` on a value that is always null or undefined yields `never`.
  const nonNull = nodes.filter((node) => node.kind === SyntaxKind.NonNullExpression);
  if (nonNull.length > 0) {
    checker.getTypeAtLocation(nonNull).forEach((type, index) => {
      if (isNever(type)) forged(nonNull[index] as Node, '`!` turns null or undefined into `never`');
    });
  }
  // An object literal can carry the brand only by spreading an actor.
  const spreads = nodes.filter(
    (node) =>
      node.kind === SyntaxKind.ObjectLiteralExpression &&
      (node as ObjectLiteralExpression).properties.some(
        (property) => property.kind === SyntaxKind.SpreadAssignment,
      ),
  );
  if (spreads.length > 0) {
    checker.getTypeAtLocation(spreads).forEach((type, index) => {
      if (branded(checker, type)) forged(spreads[index] as Node, 'builds an actor from another');
    });
  }
  // Library calls (Object.assign, structuredClone, ...) that return a branded value.
  const calls = nodes.filter(
    (node): node is CallExpression =>
      node.kind === SyntaxKind.CallExpression &&
      (node as CallExpression).expression.kind !== SyntaxKind.ImportKeyword,
  );
  if (calls.length > 0) {
    const callees = checker.getSymbolAtLocation(
      calls.map((call) =>
        call.expression.kind === SyntaxKind.PropertyAccessExpression
          ? (call.expression as PropertyAccessExpression).name
          : call.expression,
      ),
    );
    const external = calls.filter((_, index) =>
      callees[index]?.declarations.some(
        ({ path }) => path.includes('/node_modules/') && !path.includes('/node_modules/@ga/'),
      ),
    );
    if (external.length > 0) {
      checker.getTypeAtLocation(external).forEach((type, index) => {
        if (branded(checker, type)) {
          forged(external[index] as Node, 'copies an actor with a library call');
        }
      });
    }
  }
  // Overloads and ambient declarations state a type without producing the value.
  for (const node of nodes) {
    const bodyless =
      (node.kind === SyntaxKind.FunctionDeclaration ||
        node.kind === SyntaxKind.MethodDeclaration) &&
      !(node as MethodDeclaration).body;
    const ambient =
      node.kind === SyntaxKind.VariableDeclaration &&
      /^\s*(?:export\s+)?declare\b/.test(node.parent.parent.getText());
    if (!bodyless && !ambient) continue;
    let type: Type | undefined;
    if (bodyless) {
      const signature = checker.getSignatureFromDeclaration(node);
      type = signature && checker.getReturnTypeOfSignature(signature);
    } else {
      type = checker.getTypeAtLocation(node);
    }
    if (branded(checker, type)) forged(node, 'declares an actor without producing one');
  }
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

const api = new API({ cwd: ROOT });
try {
  const snapshot = api.updateSnapshot({ openProjects: projects() });
  const aliases = new Map<Project, Map<number, TsSymbol>>();
  for (const top of ['apps', 'packages', 'templates', 'tools']) {
    for (const path of sourceFiles(join(ROOT, top))) {
      const file = relative(ROOT, path);
      if (!isProduction(file) || file === 'tools/check-access.ts') continue;
      const project = snapshot.getDefaultProjectForFile(path);
      const source = project?.program.getSourceFile(path);
      if (!project || !source) {
        problems.push(`${file}: not part of any tsconfig project, so check-access cannot read it`);
        continue;
      }
      const cache = aliases.get(project) ?? new Map<number, TsSymbol>();
      aliases.set(project, cache);
      checkFile(project, file, source, cache);
    }
  }
} finally {
  api.close();
}

const listed = (JSON.parse(readFileSync(LIST, 'utf8')) as { endpoints: Entry[] }).endpoints;
const key = (entry: Entry) => `${entry.where} [${entry.access}] ${entry.reason}`;
const counts = (entries: readonly Entry[]) => {
  const map = new Map<string, number>();
  for (const entry of entries) map.set(entry.where, (map.get(entry.where) ?? 0) + 1);
  return map;
};
for (const [where, count] of counts(found)) {
  if (count > 1) problems.push(`${where}: ${count} access decorators open the same member`);
}
for (const [where, count] of counts(listed)) {
  if (count > 1) problems.push(`security/public-endpoints.json lists ${where} ${count} times`);
}
const listedKeys = new Set(listed.map(key));
const foundKeys = new Set(found.map(key));
for (const entry of found) {
  if (!listedKeys.has(key(entry))) {
    problems.push(
      `${entry.where}: ${entry.access} access ("${entry.reason}") is not in security/public-endpoints.json`,
    );
  }
}
for (const entry of listed) {
  if (!foundKeys.has(key(entry))) {
    problems.push(
      `security/public-endpoints.json lists ${key(entry)}, which the code no longer declares`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `check-access: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `check-access: ${found.length} endpoint(s) open without a user, all listed; no forged actors, identity metadata or test helpers`,
);
