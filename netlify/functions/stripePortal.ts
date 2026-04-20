import { Handler, HandlerContext, HandlerEvent, HandlerResponse } from "@netlify/functions";
import Stripe from 'stripe';

interface PortalSessionRequest {
  session_id?: string;
  customer_id?: string;
}

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext,
): Promise<HandlerResponse> => {
  try {
    
    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
      console.log('Handling preflight OPTIONS request');
      return {
        statusCode: 200, // Must be 200 for preflight to succeed
        headers: {
          'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
        body: 'Preflight check successful',
      };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing request body' }),
      };
    }

    const { session_id, customer_id } = JSON.parse(event.body) as PortalSessionRequest;

    if (!session_id && !customer_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Either session_id or customer_id is required' }),
      };
    }

    const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY!;
    const stripe = new Stripe(STRIPE_KEY);

    let customerId: string;

    // Get customer ID from checkout session if session_id is provided
    if (session_id) {
      const checkoutSession = await stripe.checkout.sessions.retrieve(session_id);
      if (!checkoutSession.customer) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Checkout session has no associated customer' }),
        };
      }
      customerId = checkoutSession.customer as string;
    } else {
      customerId = customer_id!;
    }

    // Get return URL from environment or request headers
    const returnUrl = process.env.STRIPE_PORTAL_RETURN_URL || 
      `${event.headers['x-forwarded-proto'] || 'http'}://${event.headers.host}`;

    // Create billing portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    // Return the portal URL to the client
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
      },
      body: JSON.stringify({
        success: true,
        portalUrl: portalSession.url,
      }),
    };
  } catch (error) {
    console.error('Error creating portal session:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'Failed to create billing portal session',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};