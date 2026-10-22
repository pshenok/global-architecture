import { Clock, IdGenerator, type Page, type PageRequest, UnitOfWork } from '@ga/kernel';
import { Injectable } from '@nestjs/common';
import { bookingNotFound, guestNotFound, houseNotFound } from '../domain/booking.errors.ts';
import { type BookingFilter, BookingRepository } from '../domain/booking.repository.ts';
import { Booking } from '../domain/booking.ts';
import { nightsOf } from '../domain/stay.ts';
import { HouseCatalog } from './ports/house-catalog.ts';
import { UserDirectory } from './ports/user-directory.ts';

export interface CreateBookingInput {
  readonly houseId: string;
  readonly guestId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly guests: number;
}

/** Use cases of the booking service. */
@Injectable()
export class BookingService {
  constructor(
    private readonly bookings: BookingRepository,
    private readonly users: UserDirectory,
    private readonly houses: HouseCatalog,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /**
   * 1. Validate the stay locally (cheap, no network).
   * 2. Ask user-service and house-service in parallel (outside any DB transaction).
   * 3. Insert. The database exclusion constraint rejects overlapping confirmed
   *    bookings atomically, so concurrent requests for the same dates cannot both win.
   */
  async create(input: CreateBookingInput): Promise<Booking> {
    const now = this.clock.now();
    nightsOf(input.checkIn, input.checkOut, now);
    const [guestExists, terms] = await Promise.all([
      this.users.exists(input.guestId),
      this.houses.findTerms(input.houseId),
    ]);
    if (!guestExists) throw guestNotFound(input.guestId);
    if (!terms) throw houseNotFound(input.houseId);
    const booking = Booking.create({ id: this.ids.newId(), ...input }, terms, now);
    await this.bookings.insert(booking);
    return booking;
  }

  async get(id: string): Promise<Booking> {
    const booking = await this.bookings.findById(id);
    if (!booking) throw bookingNotFound(id);
    return booking;
  }

  list(filter: BookingFilter, page: PageRequest): Promise<Page<Booking>> {
    return this.bookings.list(filter, page);
  }

  /** Locks the row so two concurrent cancels resolve to one success and one FAILED_PRECONDITION. */
  cancel(id: string): Promise<Booking> {
    return this.unitOfWork.run(async () => {
      const booking = await this.bookings.findById(id, { forUpdate: true });
      if (!booking) throw bookingNotFound(id);
      booking.cancel(this.clock.now());
      await this.bookings.update(booking);
      return booking;
    });
  }
}
