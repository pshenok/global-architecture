import type { UserServiceClient } from '@ga/contracts/ga/user/v1/user';
import { DependencyUnavailableError } from '@ga/kernel';
import { Metadata, status } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { GrpcUserDirectory } from './grpc-user-directory.ts';

/** Adapter unit test: the anti-corruption mapping, with the typed client faked. */
function serviceError(code: number) {
  return Object.assign(new Error(status[code]), {
    code,
    details: status[code],
    metadata: new Metadata(),
  });
}

function directory(getUser: ReturnType<typeof vi.fn>): GrpcUserDirectory {
  return new GrpcUserDirectory({ getUser } as unknown as UserServiceClient);
}

describe('GrpcUserDirectory', () => {
  it('reports an existing user', async () => {
    await expect(
      directory(vi.fn().mockReturnValue(of({ user: { id: 'u1' } }))).exists('u1'),
    ).resolves.toBe(true);
  });

  it('maps NOT_FOUND to false', async () => {
    const getUser = vi.fn().mockReturnValue(throwError(() => serviceError(status.NOT_FOUND)));
    await expect(directory(getUser).exists('u1')).resolves.toBe(false);
  });

  it.each([status.UNAVAILABLE, status.DEADLINE_EXCEEDED])(
    'maps transient status %i to USER_SERVICE_UNAVAILABLE',
    async (code) => {
      const getUser = vi.fn().mockReturnValue(throwError(() => serviceError(code)));
      const error = await directory(getUser)
        .exists('u1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DependencyUnavailableError);
      expect((error as DependencyUnavailableError).reason).toBe('USER_SERVICE_UNAVAILABLE');
    },
  );

  it('lets unexpected statuses surface unchanged (they become INTERNAL)', async () => {
    const original = serviceError(status.INVALID_ARGUMENT);
    const getUser = vi.fn().mockReturnValue(throwError(() => original));
    await expect(directory(getUser).exists('u1')).rejects.toBe(original);
  });
});
