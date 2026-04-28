import { Handler, HandlerContext, HandlerEvent, HandlerResponse } from "@netlify/functions";
// import * as Data from '../../public/config.json'
import Stripe from 'stripe'
import supabase from "../supabase";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_KEY);

// Type definitions for Stripe objects
interface StripeCustomer {
  id: string;
  email: string;
  name?: string;
  metadata?: Record<string, any>;
}

interface StripeCheckoutSession {
  id: string;
  customer: string | StripeCustomer;
  customer_details: {
    email: string;  
    name?: string;
  };
  metadata?: Record<string, any>;
  object: string;
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

    // Replace this endpoint secret with your endpoint's unique secret
    // If you are testing with the CLI, find the secret by running 'stripe listen'
    // If you are using an endpoint defined with the API or dashboard, look in your webhook settings
    // at https://dashboard.stripe.com/webhooks
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    // Only verify the event if you have an endpoint secret defined.
    // Otherwise use the basic event deserialized with JSON.parse
    let req = null
    const signature = event.headers['stripe-signature'];

    console.log('Webhook signature verification:', typeof event.body, signature, endpointSecret,);

    if (endpointSecret) {
      // Get the signature sent by Stripe
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
    
    req = JSON.parse(event.body);
    // console.log({data: req.data.object});

    const sessionId = req.data.object.id;
    console.log(`Session ID: ${sessionId}`);

    let userId = req.data.object.metadata?.userId;
    console.log(`User ID from session metadata: ${userId}`);

    // console.log({userId, event: req.data.object.object});

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
      case 'checkout.session.completed':
        // console.log(`Checkout session completed: ${req.data.object.id}`);
        await handleCheckoutCompleted(req.data.object);
        break;

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

async function handleCheckoutCompleted(checkout: StripeCheckoutSession) {
  try {
    // Validate required fields
    if (!checkout?.id) {
      console.error('Invalid checkout: missing checkout ID');
      return;
    }

    const checkoutSessionId = checkout.id;

    // Handle customer ID - could be string or StripeCustomer object
    const customerId = typeof checkout.customer === 'string' 
      ? checkout.customer 
      : checkout.customer?.id;

    if (!customerId) {
      console.error('Invalid checkout: missing customer ID');
      return;
    }

    // Prepare metadata safely
    const baseMetadata = checkout.metadata || {};
    const updatedMetadata = {
      ...baseMetadata,
      session_id: checkoutSessionId,
    };

    // Update customer record
    const { data, error } = await supabase.from('customers')
      .update({
        session_id: checkoutSessionId,
        metadata: updatedMetadata,
      })
      .eq('stripe_customer_id', customerId)
      .select('id');

    if (error) {
      console.error('Database error updating customer with checkout session:', error);
      return;
    }

    // Verify the update affected at least one row
    if (!data || data.length === 0) {
      console.warn(`No customer record found with ID: ${customerId}`);
      return;
    }

    console.log(`Checkout completed successfully: ${checkoutSessionId} for customer: ${customerId}`);

  } catch (err) {
    console.error('Unexpected error in handleCheckoutCompleted:', err);
  }
}


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


    console.log({subscription});

    const month = 30 * 86400;
    const current_period_start = new Date(subscription.start_date * 1000).toISOString();
    const current_period_end = new Date((subscription.start_date + (month * subscription.plan.interval_count)) * 1000).toISOString();

    console.log({t: current_period_end, t2: current_period_start});

    // Create subscription in Supabase (customer doesn't need to exist)
    const { data: createdSubscription, error: subscriptionError } = await supabase
      .from('subscriptions')
      .insert({
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
        plan_id: plan.id,
        status: subscription.status,
        current_period_start,
        current_period_end,
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

    let customer = null;
    // Attempt to create or get customer if userId is provided
    if (userId || subscription) {
      const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY!;
      const stripe = new Stripe(STRIPE_KEY);
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
      const email = (stripeCustomer as StripeCustomer).email;

      const { data } = await supabase
        .from('customers')
        .select('id, email')
        .eq('stripe_customer_id', stripeCustomerId)
        .single();
      customer = data

      if (!customer) {
        const { data } = await supabase
          .from('customers')
          .insert({
            stripe_customer_id: stripeCustomerId,
            email,
            user_id: userId,
            name: (stripeCustomer as StripeCustomer).name || null,
            metadata: (stripeCustomer as StripeCustomer).metadata || {},
          })
          .select('id, email')
          .single();
          customer = data

          console.log(`customer created: ${userId} - ${stripeCustomerId}`);
      }

      const product = await stripe.products.retrieve(subscription.items.data[0].price.product as string);

      const renewalDate = new Date(current_period_end)
        .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      sendSubscriptionEmail(customer.email, product.name, renewalDate, subscription.plan.amount / 100, 'month', 'https://app.quickflip.ai');
    }

    // trigger email after checkout completed

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

    console.log({subscription});

    const month = 30 * 86400;
    const current_period_start = new Date(subscription.start_date * 1000)
    const current_period_end = new Date((subscription.start_date + (month * subscription.plan.interval_count)) * 1000)

    console.log({t: current_period_end.toISOString(), t2: current_period_start.toISOString()});

    // Update subscription in Supabase
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        status: subscription.status,
        current_period_start,
        current_period_end,
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

    if (!userId) {
      console.warn('No user ID provided for customer creation, skipping database insert');
      return;
    }
    // Create customer in Supabase
    const { error: insertError } = await supabase
      .from('customers')
      .insert({
        stripe_customer_id: stripeCustomerId,
        user_id: userId,
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

async function sendSubscriptionEmail(email: string, planName: string, renewalDate: string, price: number, billingCycle: string, appURL: string) {
  try {

    const result = await resend.emails.send({
      from: 'Quickflip <team@updates.quickflip.ai>',
      to: email,
      subject: 'Welcome to Quickflip!',
      html: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to QuickFlip.ai - Your Subscription is Active</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background-color: #f9fafb;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
        }
        .header {
            background: linear-gradient(135deg, #ef4444 0%, #eab308 100%);
            padding: 40px 20px;
            text-align: center;
        }
        .header-logo {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
        }
        .logo-icon {
            width: 40px;
            height: 40px;
            background-color: rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            font-weight: bold;
            color: white;
        }
        .header-title {
            color: white;
            font-size: 28px;
            font-weight: bold;
            margin: 0;
            font-family: 'Montserrat', sans-serif;
        }
        .content {
            padding: 40px 30px;
            color: #1f2937;
        }
        .greeting {
            font-size: 24px;
            font-weight: bold;
            margin: 0 0 16px 0;
            color: #111827;
        }
        .description {
            font-size: 16px;
            line-height: 1.6;
            margin: 0 0 24px 0;
            color: #4b5563;
        }
        .confirmation-section {
            background-color: #f3f4f6;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 24px;
            margin: 24px 0;
            text-align: center;
        }
        .confirmation-label {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #6b7280;
            margin-bottom: 12px;
        }
        .confirmation-code {
            font-size: 32px;
            font-weight: bold;
            letter-spacing: 4px;
            color: #ef4444;
            font-family: 'Monaco', 'Courier New', monospace;
            margin: 8px 0;
        }
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #ef4444 0%, #eab308 100%);
            color: white !important;
            padding: 14px 48px;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
            font-size: 16px;
            margin: 24px 0;
            transition: transform 0.2s, box-shadow 0.2s;
            border: none;
            cursor: pointer;
        }
        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(239, 68, 68, 0.3);
        }
        .link-section {
            background-color: #f9fafb;
            padding: 20px;
            border-radius: 8px;
            margin: 24px 0;
        }
        .link-text {
            font-size: 13px;
            color: #6b7280;
            margin: 0 0 8px 0;
        }
        .link {
            word-break: break-all;
            color: #ef4444;
            text-decoration: none;
            font-size: 12px;
            font-family: 'Monaco', 'Courier New', monospace;
        }
        .footer {
            background-color: #f3f4f6;
            padding: 32px 30px;
            text-align: center;
            border-top: 1px solid #e5e7eb;
        }
        .footer-text {
            font-size: 13px;
            color: #6b7280;
            margin: 8px 0;
            line-height: 1.6;
        }
        .divider {
            border: 0;
            border-top: 1px solid #e5e7eb;
            margin: 24px 0;
        }
        .features-list {
            margin: 24px 0;
            padding: 0;
            list-style: none;
        }
        .features-list li {
            padding: 8px 0;
            font-size: 14px;
            color: #4b5563;
        }
        .warning {
            background-color: #fef3c7;
            border-left: 4px solid #eab308;
            padding: 12px 16px;
            margin: 20px 0;
            border-radius: 4px;
            font-size: 13px;
            color: #78350f;
        }
        @media (max-width: 600px) {
            .content {
                padding: 24px 16px;
            }
            .header {
                padding: 32px 16px;
            }
            .footer {
                padding: 24px 16px;
            }
            .header-title {
                font-size: 24px;
            }
            .greeting {
                font-size: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="header-logo">
                <div class="logo-icon" style="justify-content: center; align-items: center;">⚡</div>
                <h1 class="header-title">QuickFlip.ai</h1>
            </div>
        </div>

        <!-- Main Content -->
        <div class="content">
            <p class="greeting">Welcome to QuickFlip.ai! 🚀</p>
            <p class="description">
                Your subscription is now active! You've unlocked unlimited access to real market data and pricing insights. Start flipping with confidence today.
            </p>

            <!-- Subscription Details -->
            <div class="confirmation-section">
                <div class="confirmation-label">Subscription Details</div>
                <p style="font-size: 16px; font-weight: 600; margin: 12px 0; color: #111827;">${planName}</p>
                <p style="font-size: 13px; color: #6b7280; margin: 4px 0;">Renews on: ${renewalDate}</p>
                <p style="font-size: 13px; color: #6b7280; margin: 8px 0;">Price: ${price}/${billingCycle}</p>
            </div>

            <!-- CTA Button -->
            <div style="text-align: center;">
                <a href="${appURL}" class="cta-button">Go to App</a>
            </div>

            <hr class="divider">

            <p class="description" style="font-size: 14px;">
                <strong>You now have access to:</strong>
            </p>

            <ul class="features-list">
                <li>✨ Unlimited photo uploads and link pastes</li>
                <li>✨ Real sold prices from actual market data</li>
                <li>✨ Accurate pricing for your flips</li>
                <li>✨ Early adopter locked-in pricing</li>
            </ul>

            <div class="warning">
                💡 <strong>Getting Started Tip:</strong> Download the QuickFlip.ai app to start scanning items instantly. Take a photo or paste a link to get real market prices in seconds!
            </div>

            <hr class="divider">

            <p class="description" style="font-size: 13px; color: #6b7280;">
                Questions or need help? <a href="https://app.quickflip.ai/support" style="color: #ef4444; text-decoration: none;">Contact our support team</a>. We're here to help you succeed!
            </p>
        </div>

        <!-- Footer -->
        <div class="footer">
            <p class="footer-text">
                <strong>QuickFlip.ai</strong><br>
                Know what flips. Instantly.
            </p>
            <p class="footer-text">
                © 2026 QuickFlip.ai. All rights reserved.
            </p>
        </div>
    </div>
</body>
</html>`
    })

    if (result.error) {
      console.error('Error sending email:', result.error);
    }
  } catch (err) {
    console.error('Unexpected error:', err);
  }
}
