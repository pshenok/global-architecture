import type { HouseTerms } from '../../domain/booking.ts';

/** What the booking service needs to know about houses. */
export abstract class HouseCatalog {
  /** Current booking terms of a house, or null when it does not exist. Throws DependencyUnavailableError when house-service cannot be reached. */
  abstract findTerms(houseId: string): Promise<HouseTerms | null>;
}
