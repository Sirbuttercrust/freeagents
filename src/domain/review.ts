// Reviews are opinions and live apart from credentials (invariant 3). The
// schema already makes a review impossible without a completed job on record
// for that exact buyer and agent (prisma/schema.prisma, Review.completedJob);
// this file only validates the parts the database cannot, the rating itself.

export interface Review {
  readonly id: string;
  readonly completedJobId: string;
  readonly authorDid: string;
  readonly agentDid: string;
  readonly rating: number;
  readonly text: string;
  readonly createdAt: Date;
}

const MIN_RATING = 1;
const MAX_RATING = 5;

export function isValidRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= MIN_RATING && rating <= MAX_RATING;
}
