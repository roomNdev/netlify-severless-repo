// netlify/functions/myFunction.ts
import {
  Handler,
  HandlerEvent,
  HandlerContext,
  HandlerResponse,
} from '@netlify/functions';
import { ScrapingBeeClient } from 'scrapingbee'; // Importing SPB's SDK
import 'dotenv/config'; // Import and configure dotenv
import * as cheerio from 'cheerio';

// in-memory cache for 60 minutes
const cache: { data: any; timestamp: number; query: string } = {
  data: null,
  timestamp: 0,
  query: '',
};
const CACHE_DURATION = 60 * 60 * 1000; // 60 minutes in milliseconds

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext,
): Promise<HandlerResponse> => {
  try {
    const durationFromLastFetch = cache.timestamp
      ? Date.now() - cache.timestamp
      : null;

    const { q } = event.queryStringParameters || {};
    const formatItemName = q?.replace(/ /g, '+') ?? '';
    if (!q || q.trim() === '') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing query parameter q' }),
      };
    }

    if (
      cache.data &&
      durationFromLastFetch !== null &&
      durationFromLastFetch < CACHE_DURATION &&
      cache.query === q
    ) {
      console.log('Returning cached data');
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
        body: JSON.stringify(cache.data),
      };
    }

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

    const scrapURL = `https://www.ebay.com/sch/i.html?_nkw=${formatItemName}&_sop=12&LH_Active=1&_ipg=240`;
    const client = new ScrapingBeeClient(process.env.BEE_KEY || '');
    const response = await client.get({ url: scrapURL });

    const rawHTML = await response.data;
    const text = extractSellItemsFromHTML(rawHTML, q);

    cache.data = {
      query: q,

      items: text,
      source: 'scrapingbee',
      cached: true,
    };
    cache.timestamp = Date.now();
    cache.query = q;
    const headers = {
      'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    };
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
      },
      body: JSON.stringify({
        query: q,
        items: text,
        source: 'scrapingbee',
        cached: false,
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
function extractSellItemsFromHTML(html: string, query: string) {
  const $ = cheerio.load(html);
  const items: any[] = [];
  console.log(`Extracting items from HTML...`);
  $('.su-card-container').each((index, element) => {
    const tileDiv = $(element).find('.s-card__title');
    const title = tileDiv.find('.primary').text();

    const subtile = $(element).find('.s-card__subtitle');
    const condition = subtile.find('span').first().text();

    let shipping = null;
    let shippingCost = null;
    // sometimes shipping info is in the second child of .su-card-container__attributes__primary
    // and sometimes it's not there at all
    const shippingInfo = $(element)
      .find('.su-card-container__attributes__primary')
      .children();
    if (shippingInfo.length > 1) {
      const shippingText = $(shippingInfo[2]).text();
    }
    if (title !== 'Shop on eBay' && condition) {
      const beautyCondition = condition.replace(' · ', '');
      // compare item name to search string so we will have a weight system to determine the resell value
      console.log('tile is ', title);
      const resultData = {
        title,
      };
      items.push(resultData);
    }
  });
  return items;
}
