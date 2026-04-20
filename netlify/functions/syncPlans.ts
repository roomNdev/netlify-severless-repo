import { Handler, HandlerContext, HandlerEvent, HandlerResponse } from "@netlify/functions";
import Stripe from 'stripe';
import supabase from "../supabase";

interface StripePrice {
  id: string;
  product: string;
  amount: number;
  currency: string;
  recurring?: {
    interval: string;
    interval_count: number;
  };
  status: string;
  metadata?: Record<string, any>;
}

interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  errors: Array<{ priceId: string; error: string }>;
}

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext,
): Promise<HandlerResponse> => {
  try {
    // Optional: Add authentication check here
    const authHeader = event.headers['authorization'];
    if (!authHeader) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    if (authHeader !== `Bearer ${"supersecret"}`) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid authorization token' }),
      };
    }

    const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY!;
    const stripe = new Stripe(STRIPE_KEY);

    const syncResult: SyncResult = {
      created: 0,
      updated: 0,
      deleted: 0,
      errors: [],
    };

    // Fetch all prices from Stripe
    const stripePrices = await fetchAllStripePrices(stripe);
    console.log(`Found ${stripePrices.length} prices in Stripe`);

    // Fetch all plans from Supabase
    const { data: supabasePlans, error: fetchError } = await supabase
      .from('plans')
      .select('id, stripe_price_id');

    if (fetchError) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to fetch plans from Supabase', details: fetchError }),
      };
    }

    const supabasePriceIds = new Set(supabasePlans?.map(p => p.stripe_price_id) || []);
    const stripePriceIds = new Set(stripePrices.map(p => p.id));

    // Create or update plans from Stripe
    for (const stripePrice of stripePrices) {
      try {
        const existingPlan = supabasePlans?.find(p => p.stripe_price_id === stripePrice.id);

        if (existingPlan) {
          // Update existing plan
          const { error: updateError } = await supabase
            .from('plans')
            .update({
              status: stripePrice.status,
              amount: stripePrice.unit_amount,
              currency: stripePrice.currency,
              interval: stripePrice.recurring?.interval || 'month',
              interval_count: stripePrice.recurring?.interval_count || 1,
              metadata: stripePrice.metadata || {},
            })
            .eq('stripe_price_id', stripePrice.id);

          if (updateError) {
            syncResult.errors.push({
              priceId: stripePrice.id,
              error: updateError.message,
            });
          } else {
            syncResult.updated++;
          }
        } else {
          // Create new plan
          console.log({prc: stripePrice});
        //   const product = await stripe.products.retrieve(stripePrice.product.id as string);

          const { error: insertError } = await supabase
            .from('plans')
            .insert({
              stripe_price_id: stripePrice.id,
              stripe_product_id: stripePrice.product as string,
              name: stripePrice.product.name,
              interval: stripePrice.recurring?.interval || 'month',
              interval_count: stripePrice.recurring?.interval_count || 1,
              amount: stripePrice.unit_amount,
              currency: stripePrice.currency,
              status: stripePrice.status,
              metadata: stripePrice.metadata || {},
            });

          if (insertError) {
            syncResult.errors.push({
              priceId: stripePrice.id,
              error: insertError.message,
            });
          } else {
            syncResult.created++;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        syncResult.errors.push({
          priceId: stripePrice.id,
          error: errorMessage,
        });
      }
    }

    // Delete plans from Supabase that no longer exist in Stripe
    for (const supabasePlan of supabasePlans || []) {
      if (!stripePriceIds.has(supabasePlan.stripe_price_id)) {
        const { error: deleteError } = await supabase
          .from('plans')
          .delete()
          .eq('stripe_price_id', supabasePlan.stripe_price_id);

        if (deleteError) {
          syncResult.errors.push({
            priceId: supabasePlan.stripe_price_id,
            error: `Failed to delete: ${deleteError.message}`,
          });
        } else {
          syncResult.deleted++;
        }
      }
    }

    console.log('Sync completed', syncResult);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Plans synchronized successfully',
        result: syncResult,
      }),
    };
  } catch (error) {
    console.error('Error in sync handler:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};

/**
 * Fetch all prices from Stripe using pagination
 */
async function fetchAllStripePrices(stripe: Stripe): Promise<StripePrice[]> {
  const allPrices: StripePrice[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const prices = await stripe.prices.list({
      limit: 100,
      starting_after: startingAfter,
      expand: ['data.product'],
    });

    allPrices.push(...(prices.data as unknown as StripePrice[]));

    hasMore = prices.has_more;
    if (prices.data.length > 0) {
      startingAfter = prices.data[prices.data.length - 1].id;
    }
  }

  return allPrices;
}
