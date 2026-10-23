import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { ACCESS_POLICY, accessPolicyOf } from './access.ts';

/**
 * Boot-time check: every gRPC handler declares an @Access policy, and none is put on a
 * class. Runs in every service and every startTestService, so a forgotten policy fails
 * the first test instead of reaching production.
 */
@Injectable()
export class AccessPolicyCheck implements OnModuleInit {
  private readonly logger = new Logger('AccessPolicy');

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const undeclared: string[] = [];
    const open: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
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
        if (!policy) undeclared.push(`${metatype.name}.${name}`);
        else if (policy.kind === 'public') open.push(`${name} (${policy.reason})`);
      }
    }
    if (undeclared.length > 0) {
      throw new Error(
        `gRPC methods without an @Access policy: ${undeclared.join(', ')}. Declare one on each method (ADR-0004).`,
      );
    }
    if (open.length > 0) this.logger.log(`public methods: ${open.join(', ')}`);
  }
}
