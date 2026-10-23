import { BookingParty, type BookingServiceClient } from '@ga/contracts/ga/booking/v1/booking';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { firstValueFrom } from 'rxjs';
import type { z } from 'zod';
import { BOOKING_SERVICE } from '../clients.ts';
import { ProblemDetails } from '../http/problem-details.ts';
import { IdParam, nextToken, PageQuery } from '../http/schemas.ts';
import {
  BookingPage,
  BookingQuery,
  BookingView,
  CreateBookingBody,
  toBookingView,
} from './bookings.schemas.ts';

const ListBookingsQuery = PageQuery.extend(BookingQuery.shape);

@ApiTags('bookings')
@ApiResponse({
  status: 400,
  description: 'Invalid input or failed precondition',
  standardSchema: ProblemDetails,
})
@ApiResponse({
  status: 503,
  description: 'A service is unavailable',
  standardSchema: ProblemDetails,
})
@Controller('v1/bookings')
export class BookingsController {
  constructor(@Inject(BOOKING_SERVICE) private readonly bookings: BookingServiceClient) {}

  @Post()
  @ApiOperation({ summary: 'Book a house for a date range' })
  @ApiResponse({ status: 201, standardSchema: BookingView })
  @ApiResponse({
    status: 409,
    description: 'Dates overlap a confirmed booking (BOOKING_DATES_UNAVAILABLE)',
    standardSchema: ProblemDetails,
  })
  async create(
    @Body({ schema: CreateBookingBody }) body: z.output<typeof CreateBookingBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = toBookingView((await firstValueFrom(this.bookings.createBooking(body))).booking);
    void reply.header('location', `/v1/bookings/${view.id}`);
    return view;
  }

  @Get()
  @ApiOperation({ summary: 'List bookings, newest first, optionally by guest or house' })
  @ApiResponse({ status: 200, standardSchema: BookingPage })
  async list(@Query({ schema: ListBookingsQuery }) query: z.output<typeof ListBookingsQuery>) {
    const page = await firstValueFrom(
      this.bookings.listBookings({ ...query, party: BookingParty.BOOKING_PARTY_UNSPECIFIED }),
    );
    return {
      items: page.bookings.map(toBookingView),
      nextPageToken: nextToken(page.nextPageToken),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a booking' })
  @ApiResponse({ status: 200, standardSchema: BookingView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async get(@Param('id', { schema: IdParam }) id: string) {
    return toBookingView((await firstValueFrom(this.bookings.getBooking({ id }))).booking);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a booking and free its dates' })
  @ApiResponse({ status: 200, standardSchema: BookingView })
  @ApiResponse({ status: 404, standardSchema: ProblemDetails })
  async cancel(@Param('id', { schema: IdParam }) id: string) {
    return toBookingView((await firstValueFrom(this.bookings.cancelBooking({ id }))).booking);
  }
}
