
import Stripe from 'stripe'
import { Handler, HandlerContext, HandlerEvent, HandlerResponse } from "@netlify/functions";

const YOUR_DOMAIN = (process.env.NODE_ENV === 'production' ? 'http://localhost:8081' :'http://localhost:8081') + '/subscription';

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext,
): Promise<HandlerResponse> => {
  try {

    const STRIPE_KEY = process.env.STRIPE_PRIVATE_KEY! 
    
    const stripe = new Stripe(STRIPE_KEY)
    
    const prices = await stripe.prices.list({
      expand: ['data.product'],
      recurring: {
        interval: 'month'
      }
    });

    console.log(prices);
    
    const priceId = 'price_1TMwcRKkFs1y9M8NyAFNhqjs'

      const session = await stripe.checkout.sessions.create({
          line_items: [ 
              {
                  price: priceId,
                  quantity: 1,
              },
          ],
          mode: 'subscription',
          success_url: `${YOUR_DOMAIN}?success=true&session_id={CHECKOUT_SESSION_ID}`,
      });

    return {
      statusCode: 303,
      headers: {
        'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
      },
      body: JSON.stringify({
        url: session.url
        // { categorySuggestions,
        // categoryTreeId,
        // categoryTreeVersion }
      }),
    };
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