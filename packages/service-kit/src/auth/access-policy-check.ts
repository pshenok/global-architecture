import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { ACCESS_POLICY, type AccessPolicy, accessPolicyOf } from './access.ts';

/** A method callable without a signed-in user, as security/public-endpoints.json lists it. */
export interface OpenEndpoint {
  /** `Class.method`. */
  readonly member: string;
  readonly access: 'public' | 'identity' | 'service';
  readonly reason: string;
}

/** How security/public-endpoints.json (and tools/check-access.ts) describe an open policy. */
function opening(policy: AccessPolicy): Omit<OpenEndpoint, 'member'> | undefined {
  switch (policy.kind) {
    case 'public':
      return { access: 'public', reason: policy.reason };
    case 'identity':
      return {
        access: 'identity',
        reason:
          policy.via.length > 0
            ? `login without a user, via ${policy.via.join(', ')}`
            : 'login without a user',
      };
    case 'service':
      return { access: 'service', reason: `workloads: ${policy.callers.join(', ')}` };
    case 'user':
    case 'admin':
      return undefined;
  }
}

/**
 * Boot-time check and record: every gRPC handler declares an @Access policy, and none is
 * put on a class. Runs in every service and every startTestService, so a forgotten policy
 * fails the first test instead of reaching production. The policies read here are the
 * ones GrpcAuthGuard enforces (`policyOf`), and `open` lists the methods open without a
 * user, which startTestService compares with security/public-endpoints.json: what the
 * tests check is what runs, and metadata changed after boot changes nothing.
 */
@Injectable()
export class AccessPolicyCheck implements OnModuleInit {
  private readonly logger = new Logger('AccessPolicy');
  private found: readonly OpenEndpoint[] = [];
  private readonly policies = new Map<object, AccessPolicy>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  /** Methods callable without a signed-in user, read from their metadata at boot. */
  get open(): readonly OpenEndpoint[] {
    return this.found;
  }

  /** The policy a handler had at boot; undefined for anything that was not a handler then. */
  policyOf(handler: object): AccessPolicy | undefined {
    return this.policies.get(handler);
  }

  onModuleInit(): void {
    const undeclared: string[] = [];
    const open: OpenEndpoint[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance: unknown = wrapper.instance;
      const { metatype } = wrapper;
      if (!instance || !metatype) continue;
      if (Reflect.hasMetadata(ACCESS_POLICY, metatype)) {
        throw new Error(`@Access must be on methods, not on ${metatype.name}`);
      }
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || !Reflect.hasMetadata(PATTERN_METADATA, handler))
          continue;
        const policy = accessPolicyOf(handler);
        const member = `${metatype.name}.${name}`;
        const opened = policy && opening(policy);
        if (!policy) undeclared.push(member);
        else this.policies.set(handler, policy);
        if (opened) open.push({ member, ...opened });
      }
    }
    if (undeclared.length > 0) {
      throw new Error(
        `gRPC methods without an @Access policy: ${undeclared.join(', ')}. Declare one on each method (ADR-0004).`,
      );
    }
    this.found = Object.freeze(open);
    if (open.length > 0) {
      this.logger.log(
        `open without a user: ${open.map((o) => `${o.member} [${o.access}] ${o.reason}`).join(', ')}`,
      );
    }
  }
}
