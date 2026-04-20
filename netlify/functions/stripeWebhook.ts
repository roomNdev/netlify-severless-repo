import { Handler, HandlerContext, HandlerEvent, HandlerResponse } from "@netlify/functions";
// import * as Data from '../../public/config.json'
import Stripe from 'stripe'
import supabase from "../supabase";

// Type definitions for Stripe objects
interface StripeCustomer {
  id: string;
  email: string;
  name?: string;
  metadata?: Record<string, any>;
}

interface StripeSubscription {
  id: string;
  customer: string;
  items: {
    data: Array<{
      id: string;
      price: {
        id: string;
        product: string;
      };
      quantity: number;
    }>;
  };
  status: string;
  period_start: number;
  period_end: number;
  trial_start?: number;
  trial_end?: number;
  canceled_at?: number;
  cancel_at?: number;
  cancel_at_period_end: boolean;
  metadata?: Record<string, any>;
}

interface StripeInvoice {
  id: string;
  customer: string;
  subscription?: string;
  status: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  period_start?: number;
  period_end?: number;
  due_date?: number;
  hosted_invoice_url?: string;
  invoice_pdf?: string;
  lines: {
    data: StripeLineItem[];
  };
  metadata?: Record<string, any>;
}

interface StripeLineItem {
  id: string;
  invoice?: string;
  description?: string;
  amount: number;
  currency: string;
  quantity: number;
  period?: {
    start: number;
    end: number;
  };
}

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

interface StripePaymentMethod {
  id: string;
  customer?: string;
  type: string;
  card?: {
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
  };
  billing_details?: {
    email?: string;
  };
}

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext,
): Promise<HandlerResponse> => {
  try {
    const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY! 

    const stripe = new Stripe(STRIPE_KEY)

    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Empty request body' }),
      };
    }

    let req = JSON.parse(event.body);
    console.log({data: req.data.object});

    const sessionId = req.data.object.id;
    console.log(`Session ID: ${sessionId}`);

    let userId = req.data.object.metadata?.userId;

    console.log({userId, event: req.data.object.object});

    if (!!userId && req.data.object.object === 'checkout.session') {
      const customerObject = {...req.data.object.customer_details, id: req.data.object.customer};
      await handleCustomerCreated(customerObject as StripeCustomer, userId);
    }
    // if (req.data.type === 'checkout.session.completed') {
    //   const session = await stripe.checkout.sessions.retrieve(sessionId, {
    //     expand: ['subscription', 'customer'],
    //   });
      
    //   userId = session.metadata?.userId;
    // }

    console.log(`User ID from session metadata: ${userId}`);

    // Replace this endpoint secret with your endpoint's unique secret
    // If you are testing with the CLI, find the secret by running 'stripe listen'
    // If you are using an endpoint defined with the API or dashboard, look in your webhook settings
    // at https://dashboard.stripe.com/webhooks
    const endpointSecret = 'whsec_371535d14348a9d70499e9665c179b1497ffc01b1932f9c7a9ed0ca83dbbbda4';
    // Only verify the event if you have an endpoint secret defined.
    // Otherwise use the basic event deserialized with JSON.parse
    if (endpointSecret) {
      // Get the signature sent by Stripe
      const signature = event.headers['stripe-signature'];
      try {
        req = stripe.webhooks.constructEvent(
          event.body,
          signature!,
          endpointSecret
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.log(`⚠️  Webhook signature verification failed.`, errorMessage);
        return {
            statusCode: 400
        }
      }
    }

    // Handle the event
    switch (req.type) {
      // Customer events
      case 'customer.created':
        await handleCustomerCreated(req.data.object as StripeCustomer, userId);
        break;
      case 'customer.updated':
        await handleCustomerUpdated(req.data.object as StripeCustomer);
        break;

      // Subscription events
      case 'customer.subscription.created':
        await handleSubscriptionCreated(req.data.object as StripeSubscription, userId);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(req.data.object as StripeSubscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(req.data.object as StripeSubscription);
        break;
      case 'customer.subscription.trial_will_end':
        await handleSubscriptionTrialEnding(req.data.object as StripeSubscription);
        break;

      // Invoice events
      case 'invoice.created':
        await handleInvoiceCreated(req.data.object as StripeInvoice);
        break;
      case 'invoice.finalized':
        await handleInvoiceFinalized(req.data.object as StripeInvoice);
        break;
      case 'invoice.paid':
        await handleInvoicePaymentSucceeded(req.data.object as StripeInvoice);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(req.data.object as StripeInvoice);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(req.data.object as StripeInvoice);
        break;
      case 'invoice.updated':
        await handleInvoiceUpdated(req.data.object as StripeInvoice);
        break;

      // Payment method events
      case 'payment_method.attached':
        await handlePaymentMethodAttached(req.data.object as StripePaymentMethod);
        break;
      case 'payment_method.detached':
        await handlePaymentMethodDetached(req.data.object as StripePaymentMethod);
        break;

      // // Payment intent events
      // case 'payment_intent.created':
      //   console.log(`Payment intent created: ${req.data.object.id}`);
      //   break;
      // case 'payment_intent.succeeded':
      //   console.log(`Payment intent succeeded: ${req.data.object.id}`);
      //   break;

      // // Charge events
      // case 'charge.succeeded':
      //   console.log(`Charge succeeded: ${req.data.object.id}`);
      //   break;

      // // Checkout session events
      // case 'checkout.session.completed':
      //   console.log(`Checkout session completed: ${req.data.object.id}`);
      //   break;

      // Price/Plan events
      case 'price.created':
        await handlePriceCreated(req.data.object as StripePrice);
        break;
      case 'price.updated':
        await handlePriceUpdated(req.data.object as StripePrice);
        break;

      // Other events
      // case 'entitlements.active_entitlement_summary.updated':
      //   console.log(`Active entitlement summary updated.`);
      //   break;
      default:
        // Log unhandled events for monitoring
        console.log(`Unhandled event type ${req.type}.`);
    }
    // Return a 200 response to acknowledge receipt of the event
    return {
        statusCode: 200
    }

  } catch (error) {
    console.log('Error in handler:', error);

    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
      },
      body: JSON.stringify({ error: 'Internal Server Error', message: error }),
    };
  }
};

/**
 * Handle subscription created event
 */
async function handleSubscriptionCreated(subscription: StripeSubscription, userId?: string) {
  try {
    const stripeCustomerId = subscription.customer as string;
    const stripeSubscriptionId = subscription.id;
    const stripePriceId = subscription.items.data[0]?.price.id;

    if (!stripePriceId) {
      console.error('No price ID found in subscription');
      return;
    }

    // Get the plan (price) from Supabase
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('id')
      .eq('stripe_price_id', stripePriceId)
      .single();

    if (!plan) {
      console.error('Plan not found for price ID:', stripePriceId);
      return;
    }

    // Create subscription in Supabase (customer doesn't need to exist)
    const { data: createdSubscription, error: subscriptionError } = await supabase
      .from('subscriptions')
      .insert({
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
        plan_id: plan.id,
        status: subscription.status,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date().toISOString(),
        // trial_start: subscription.trial_start ? new Date(subscription.trial_start * 1000).toISOString() : null,
        // trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
        quantity: subscription.items.data[0]?.quantity || 1,
        metadata: subscription.metadata || {},
      })
      .select('id')
      .single();

    if (subscriptionError) {
      console.error('Error creating subscription:', subscriptionError);
      return;
    }

    // Create subscription items
    if (createdSubscription && subscription.items.data) {
      const subscriptionItems = subscription.items.data.map((item) => ({
        stripe_subscription_item_id: item.id,
        subscription_id: createdSubscription.id,
        stripe_price_id: item.price.id,
        quantity: item.quantity,
      }));

      const { error: itemsError } = await supabase
        .from('subscription_items')
        .insert(subscriptionItems);

      if (itemsError) {
        console.error('Error creating subscription items:', itemsError);
      }
    }

    // Attempt to create or get customer if userId is provided
    if (userId || subscription) {
      const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY!;
      const stripe = new Stripe(STRIPE_KEY);
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
      const email = (stripeCustomer as StripeCustomer).email;

      let { data: customer } = await supabase
        .from('customers')
        .select('id')
        .eq('stripe_customer_id', stripeCustomerId)
        .single();

      if (!customer) {
        await supabase
          .from('customers')
          .insert({
            stripe_customer_id: stripeCustomerId,
            email,
            user_id: userId,
            name: (stripeCustomer as StripeCustomer).name || null,
            metadata: (stripeCustomer as StripeCustomer).metadata || {},
          })
          .select('id')
          .single();
      }
    }

    console.log(`Subscription created: ${stripeSubscriptionId}`);
  } catch (error) {
    console.error('Error in handleSubscriptionCreated:', error);
  }
}

/**
 * Handle subscription updated event
 */
async function handleSubscriptionUpdated(subscription: StripeSubscription) {
  try {
    const stripeSubscriptionId = subscription.id;

    // Get the subscription from Supabase
    const { data: existingSubscription, error: fetchError } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('stripe_subscription_id', stripeSubscriptionId)
      .single();

    if (!existingSubscription) {
      console.error('Subscription not found:', stripeSubscriptionId);
      return;
    }

    // Update subscription in Supabase
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        status: subscription.status,
        // current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        // current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        // trial_start: subscription.trial_start ? new Date(subscription.trial_start * 1000).toISOString() : null,
        // trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
        cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
        cancel_at_period_end: subscription.cancel_at_period_end,
        metadata: subscription.metadata || {},
      })
      .eq('stripe_subscription_id', stripeSubscriptionId);

    if (updateError) {
      console.error('Error updating subscription:', updateError);
      return;
    }

    // Update subscription items
    if (subscription.items.data) {
      // Delete old items and create new ones
      const { error: deleteError } = await supabase
        .from('subscription_items')
        .delete()
        .eq('subscription_id', existingSubscription.id);

      if (!deleteError) {
        const subscriptionItems = subscription.items.data.map((item) => ({
          stripe_subscription_item_id: item.id,
          subscription_id: existingSubscription.id,
          stripe_price_id: item.price.id,
          quantity: item.quantity,
        }));

        const { error: itemsError } = await supabase
          .from('subscription_items')
          .insert(subscriptionItems);

        if (itemsError) {
          console.error('Error updating subscription items:', itemsError);
        }
      }
    }

    console.log(`Subscription updated: ${stripeSubscriptionId} - Status: ${subscription.status}`);
  } catch (error) {
    console.error('Error in handleSubscriptionUpdated:', error);
  }
}

/**
 * Handle subscription deleted event
 */
async function handleSubscriptionDeleted(subscription: StripeSubscription) {
  try {
    const stripeSubscriptionId = subscription.id;

    // Update subscription status to canceled in Supabase
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        status: 'canceled',
        canceled_at: new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSubscriptionId);

    if (updateError) {
      console.error('Error updating subscription:', updateError);
      return;
    }

    console.log(`Subscription deleted: ${stripeSubscriptionId}`);
  } catch (error) {
    console.error('Error in handleSubscriptionDeleted:', error);
  }
}

/**
 * Handle subscription trial ending event
 */
async function handleSubscriptionTrialEnding(subscription: StripeSubscription) {
  try {
    const stripeSubscriptionId = subscription.id;

    // Get the subscription from Supabase
    const { data: existingSubscription } = await supabase
      .from('subscriptions')
      .select('id, stripe_customer_id')
      .eq('stripe_subscription_id', stripeSubscriptionId)
      .single();

    if (!existingSubscription) {
      console.error('Subscription not found:', stripeSubscriptionId);
      return;
    }

    // You could send a notification email here or update a notification table
    console.log(`Subscription trial ending: ${stripeSubscriptionId}`);
    
    // Example: You could insert into a notifications/events table if needed
    // await supabase
    //   .from('notifications')
    //   .insert({
    //     stripe_customer_id: existingSubscription.stripe_customer_id,
    //     type: 'trial_ending',
    //     subscription_id: existingSubscription.id,
    //     sent_at: new Date().toISOString(),
    //   });

  } catch (error) {
    console.error('Error in handleSubscriptionTrialEnding:', error);
  }
}

/**
 * Handle invoice created event
 */
async function handleInvoiceCreated(invoice: StripeInvoice) {
  try {
    const stripeInvoiceId = invoice.id;
    const stripeCustomerId = invoice.customer as string;

    // Get subscription if invoice is related to a subscription
    let subscriptionId: string | null = null;
    if (invoice.subscription) {
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('stripe_subscription_id', invoice.subscription as string)
        .single();
      subscriptionId = subscription?.id || null;
    }

    // Create invoice in Supabase
    const { error: invoiceError } = await supabase
      .from('invoices')
      .insert({
        stripe_invoice_id: stripeInvoiceId,
        stripe_customer_id: stripeCustomerId,
        subscription_id: subscriptionId,
        status: invoice.status,
        amount_due: invoice.amount_due,
        amount_paid: invoice.amount_paid,
        amount_remaining: invoice.amount_remaining,
        currency: invoice.currency,
        period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
        period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
        due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
        hosted_invoice_url: invoice.hosted_invoice_url,
        invoice_pdf: invoice.invoice_pdf,
      });

    if (invoiceError) {
      console.error('Error creating invoice:', invoiceError);
      return;
    }

    // Create invoice line items
    if (invoice.lines && invoice.lines.data) {
      const lineItems = invoice.lines.data.map((item: StripeLineItem) => ({
        stripe_line_item_id: item.id,
        description: item.description,
        amount: item.amount,
        currency: item.currency,
        quantity: item.quantity,
        period_start: item.period?.start ? new Date(item.period.start * 1000).toISOString() : null,
        period_end: item.period?.end ? new Date(item.period.end * 1000).toISOString() : null,
      }));

      // First, get the invoice ID from Supabase
      const { data: createdInvoice } = await supabase
        .from('invoices')
        .select('id')
        .eq('stripe_invoice_id', stripeInvoiceId)
        .single();

      if (createdInvoice) {
        const itemsWithInvoiceId = lineItems.map(item => ({
          ...item,
          invoice_id: createdInvoice.id
        }));

        const { error: lineItemError } = await supabase
          .from('invoice_line_items')
          .insert(itemsWithInvoiceId);

        if (lineItemError) {
          console.error('Error creating invoice line items:', lineItemError);
        }
      }
    }

    console.log(`Invoice created: ${stripeInvoiceId}`);
  } catch (error) {
    console.error('Error in handleInvoiceCreated:', error);
  }
}

/**
 * Handle invoice updated event
 */
async function handleInvoiceUpdated(invoice: StripeInvoice) {
  try {
    const stripeInvoiceId = invoice.id;

    // Update invoice in Supabase
    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        status: invoice.status,
        amount_due: invoice.amount_due,
        amount_paid: invoice.amount_paid,
        amount_remaining: invoice.amount_remaining,
        hosted_invoice_url: invoice.hosted_invoice_url,
        invoice_pdf: invoice.invoice_pdf,
      })
      .eq('stripe_invoice_id', stripeInvoiceId);

    if (updateError) {
      console.error('Error updating invoice:', updateError);
      return;
    }

    console.log(`Invoice updated: ${stripeInvoiceId} - Status: ${invoice.status}`);
  } catch (error) {
    console.error('Error in handleInvoiceUpdated:', error);
  }
}

/**
 * Handle invoice finalized event
 */
async function handleInvoiceFinalized(invoice: StripeInvoice) {
  try {
    const stripeInvoiceId = invoice.id;

    // Update invoice status to open
    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'open',
        hosted_invoice_url: invoice.hosted_invoice_url,
        invoice_pdf: invoice.invoice_pdf,
      })
      .eq('stripe_invoice_id', stripeInvoiceId);

    if (updateError) {
      console.error('Error finalizing invoice:', updateError);
      return;
    }

    console.log(`Invoice finalized: ${stripeInvoiceId}`);
  } catch (error) {
    console.error('Error in handleInvoiceFinalized:', error);
  }
}

/**
 * Handle invoice payment succeeded event
 */
async function handleInvoicePaymentSucceeded(invoice: StripeInvoice) {
  try {
    const stripeInvoiceId = invoice.id;

    // Update invoice status to paid
    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'paid',
        amount_paid: invoice.amount_paid,
        amount_remaining: invoice.amount_remaining,
      })
      .eq('stripe_invoice_id', stripeInvoiceId);

    if (updateError) {
      console.error('Error updating invoice payment:', updateError);
      return;
    }

    console.log(`Invoice payment succeeded: ${stripeInvoiceId}`);
  } catch (error) {
    console.error('Error in handleInvoicePaymentSucceeded:', error);
  }
}

/**
 * Handle invoice payment failed event
 */
async function handleInvoicePaymentFailed(invoice: StripeInvoice) {
  try {
    const stripeInvoiceId = invoice.id;

    // Update invoice status to uncollectible
    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'uncollectible',
        amount_remaining: invoice.amount_remaining,
      })
      .eq('stripe_invoice_id', stripeInvoiceId);

    if (updateError) {
      console.error('Error updating invoice payment failure:', updateError);
      return;
    }

    console.log(`Invoice payment failed: ${stripeInvoiceId}`);
  } catch (error) {
    console.error('Error in handleInvoicePaymentFailed:', error);
  }
}


/**
 * Handle customer created event
 */
async function handleCustomerCreated(customer: StripeCustomer, userId?: string) {
  try {
    const stripeCustomerId = customer.id;

    // Create customer in Supabase
    const { error: insertError } = await supabase
      .from('customers')
      .insert({
        stripe_customer_id: stripeCustomerId,
        userId,
        email: customer.email,
        name: customer.name || null,
        metadata: customer.metadata || {},
      });

    if (insertError) {
      console.error('Error creating customer:', insertError);
      return;
    }

    console.log(`Customer created: ${stripeCustomerId}`);
  } catch (error) {
    console.error('Error in handleCustomerCreated:', error);
  }
}

/**
 * Handle customer updated event
 */
async function handleCustomerUpdated(customer: StripeCustomer) {
  try {
    const stripeCustomerId = customer.id;

    // Update customer in Supabase
    const { error: updateError } = await supabase
      .from('customers')
      .update({
        email: customer.email,
        name: customer.name || null,
        metadata: customer.metadata || {},
      })
      .eq('stripe_customer_id', stripeCustomerId);

    if (updateError) {
      console.error('Error updating customer:', updateError);
      return;
    }

    console.log(`Customer updated: ${stripeCustomerId}`);
  } catch (error) {
    console.error('Error in handleCustomerUpdated:', error);
  }
}

/**
 * Handle payment method attached event
 */
async function handlePaymentMethodAttached(paymentMethod: StripePaymentMethod) {
  try {
    const stripePaymentMethodId = paymentMethod.id;
    const stripeCustomerId = paymentMethod.customer as string;

    if (!stripeCustomerId) {
      console.error('No customer ID for payment method');
      return;
    }

    // Create payment method in Supabase
    const cardBrand = paymentMethod.card?.brand || null;
    const cardLast4 = paymentMethod.card?.last4 || null;
    const cardExpMonth = paymentMethod.card?.exp_month || null;
    const cardExpYear = paymentMethod.card?.exp_year || null;

    const { error: insertError } = await supabase
      .from('payment_methods')
      .insert({
        stripe_payment_method_id: stripePaymentMethodId,
        stripe_customer_id: stripeCustomerId,
        type: paymentMethod.type,
        card_brand: cardBrand,
        card_last4: cardLast4,
        card_exp_month: cardExpMonth,
        card_exp_year: cardExpYear,
        is_default: false,
      });

    if (insertError) {
      console.error('Error creating payment method:', insertError);
      return;
    }

    console.log(`Payment method attached: ${stripePaymentMethodId}`);
  } catch (error) {
    console.error('Error in handlePaymentMethodAttached:', error);
  }
}

/**
 * Handle payment method detached event
 */
async function handlePaymentMethodDetached(paymentMethod: StripePaymentMethod) {
  try {
    const stripePaymentMethodId = paymentMethod.id;

    // Delete payment method from Supabase
    const { error: deleteError } = await supabase
      .from('payment_methods')
      .delete()
      .eq('stripe_payment_method_id', stripePaymentMethodId);

    if (deleteError) {
      console.error('Error deleting payment method:', deleteError);
      return;
    }

    console.log(`Payment method detached: ${stripePaymentMethodId}`);
  } catch (error) {
    console.error('Error in handlePaymentMethodDetached:', error);
  }
}

/**
 * Handle price created event
 */
async function handlePriceCreated(price: StripePrice) {
  try {
    const stripePriceId = price.id;
    const stripeProductId = price.product as string;

    // Check if price already exists
    const { data: existingPrice } = await supabase
      .from('plans')
      .select('id')
      .eq('stripe_price_id', stripePriceId)
      .single();

    if (existingPrice) {
      console.log(`Price already exists: ${stripePriceId}`);
      return;
    }

    // Get product name from Stripe API
    const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY!;
    const stripe = new Stripe(STRIPE_KEY);
    const product = await stripe.products.retrieve(stripeProductId);

    // Create plan in Supabase
    const { error: insertError } = await supabase
      .from('plans')
      .insert({
        stripe_price_id: stripePriceId,
        stripe_product_id: stripeProductId,
        name: product.name,
        interval: price.recurring?.interval || 'month',
        interval_count: price.recurring?.interval_count || 1,
        amount: price.amount,
        currency: price.currency,
        status: price.status,
        metadata: price.metadata || {},
      });

    if (insertError) {
      console.error('Error creating plan:', insertError);
      return;
    }

    console.log(`Price created: ${stripePriceId}`);
  } catch (error) {
    console.error('Error in handlePriceCreated:', error);
  }
}

/**
 * Handle price updated event
 */
async function handlePriceUpdated(price: StripePrice) {
  try {
    const stripePriceId = price.id;

    // Get price from Supabase
    const { data: existingPrice, error: fetchError } = await supabase
      .from('plans')
      .select('id')
      .eq('stripe_price_id', stripePriceId)
      .single();

    if (!existingPrice) {
      console.error('Price not found:', stripePriceId);
      return;
    }

    // Update plan in Supabase
    const { error: updateError } = await supabase
      .from('plans')
      .update({
        status: price.status,
        metadata: price.metadata || {},
      })
      .eq('stripe_price_id', stripePriceId);

    if (updateError) {
      console.error('Error updating plan:', updateError);
      return;
    }

    console.log(`Price updated: ${stripePriceId} - Status: ${price.status}`);
  } catch (error) {
    console.error('Error in handlePriceUpdated:', error);
  }
}
