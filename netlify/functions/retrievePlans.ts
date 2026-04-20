import { Handler, HandlerContext, HandlerEvent, HandlerResponse } from "@netlify/functions";
import Stripe from 'stripe';

interface StripePlanResponse {
  id: string;
  productId: string;
  productName: string;
  amount: number;
  currency: string;
  interval?: string;
  intervalCount?: number;
  metadata?: Record<string, any>;
}

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext,
): Promise<HandlerResponse> => {
  try {
    const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY!;
    const stripe = new Stripe(STRIPE_KEY);

    // Fetch all prices from Stripe with pagination
    const allPlans: StripePlanResponse[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const prices = await stripe.prices.list({
        limit: 100,
        starting_after: startingAfter,
        expand: ['data.product'],
      });

      for (const price of prices.data) {
        const product = price.product as Stripe.Product;

        allPlans.push({
          id: price.id,
          productId: product.id,
          productName: product.name,
          amount: price.unit_amount || 0,
          currency: price.currency,
          interval: price.recurring?.interval,
          intervalCount: price.recurring?.interval_count,
          metadata: price.metadata || {},
        });
      }

      hasMore = prices.has_more;
      if (prices.data.length > 0) {
        startingAfter = prices.data[prices.data.length - 1].id;
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
      body: JSON.stringify({
        success: true,
        count: allPlans.length,
        plans: allPlans,
      }),
    };
  } catch (error) {
    console.error('Error retrieving plans:', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success: false,
        error: 'Failed to retrieve plans',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};
