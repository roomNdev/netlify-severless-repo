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
import { stringSimilarity } from 'string-similarity-js';

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

    const scrapURL = `https://www.ebay.com/sch/i.html?_nkw=${formatItemName}&_sop=12&LH_Sold=1&LH_Complete=1&_ipg=240`;
    const client = new ScrapingBeeClient(process.env.BEE_KEY || '');
    const response = await client.get({ url: scrapURL });

    const rawHTML = await response.data;
    const text = extractItemsFromHTML(rawHTML, q);
    const stats = calculateSalesMetrics(text);

    cache.data = {
      query: q,
      stats,
      items: text,
      source: 'scrapingbee',
      cached: true,
    };
    cache.timestamp = Date.now();
    cache.query = q;
    const headers = {
      'access-control-allow-origin': '*',
    };
    console.log('Returning new fetched data length:', text.length);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
      },
      body: JSON.stringify({
        query: q,
        stats,
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

function extractItemsFromHTML(html: string, query: string) {
  const $ = cheerio.load(html);
  const items: any[] = [];
  console.log(`Extracting items from HTML...`);
  $('.su-card-container').each((index, element) => {
    const tileDiv = $(element).find('.s-card__title');
    const title = tileDiv.find('.primary').text();
    const price = $(element).find('.s-card__price').text();
    const soldDate = $(element).find('.s-card__caption').text();
    const subtile = $(element).find('.s-card__subtitle');
    const condition = subtile.find('span').first().text();
    const imageDiv = $(element).find('.su-media__image');
    const imageUrl = imageDiv.find('img').attr('src');
    const itemUrl = imageDiv.find('a').attr('href');
    const parsedPrice = parsePrice(price);
    let shipping = null;
    let shippingCost = null;
    // sometimes shipping info is in the second child of .su-card-container__attributes__primary
    // and sometimes it's not there at all
    const shippingInfo = $(element)
      .find('.su-card-container__attributes__primary')
      .children();
    if (shippingInfo.length > 1) {
      const shippingText = $(shippingInfo[2]).text();
      shippingCost = getShippingCost(shippingText);
    }
    if (title !== 'Shop on eBay' && parsedPrice && soldDate && condition) {
      const beautyCondition = condition.replace(' · ', '');
      // compare item name to search string so we will have a weight system to determine the resell value
      console.log('tile is ', title);
      const resultData = {
        title,
        price: parsedPrice?.value,
        currency: parsedPrice?.symbol,
        soldDate: convertToDate(soldDate),
        condition: beautyCondition,
        imageUrl,
        itemUrl,
        shipping: shippingCost,
      };
      items.push(resultData);
    }
  });
  return items;
}

function parsePrice(
  priceStr: string,
): { value: number; currency: string; symbol: string } | null {
  const parseCurrency = require('parsecurrency');
  if (priceStr.trim() === '') {
    return null;
  }
  const parsed = parseCurrency(priceStr);

  return parsed;
}

function calculateSalesMetrics(items: any[]) {
  const totalSales = items.length;
  const p75 = quantile(
    items.map((item) => item.price),
    0.75,
  );
  const p25 = quantile(
    items.map((item) => item.price),
    0.25,
  );
  const median = quantile(
    items.map((item) => item.price),
    0.5,
  );
  return {
    count: totalSales,
    p25,
    median,
    p75,
  };
}

function quantile(arr: number[], q: number) {
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  } else {
    return sorted[base];
  }
}

// convert "Sold Sep 23, 2025" to Date UTC ISO-8601 UTC date string=
function convertToDate(dateStr: string) {
  // Example dateStr: "Sold Sep 23, 2025"
  const parts = dateStr.replace('Sold ', '').split(' ');

  const month = new Date(Date.parse(parts[1] + ' 1, 2020')).getMonth();
  const day = parseInt(parts[2], 10);
  const year = parseInt(parts[3], 10);
  const date = new Date(Date.UTC(year, month, day));
  return date.toISOString();
}

// get shipping cost if available
function getShippingCost(shippingText: string) {
  let shippingCost = 0;

  if (shippingText) {
    if (
      !shippingText.toLowerCase().includes('free') &&
      shippingText.includes('delivery')
    ) {
      let formattedShipping = shippingText.replace(' delivery', '');
      formattedShipping = formattedShipping.replace('+', '');
      const parsedShipping = parsePrice(formattedShipping);
      if (parsedShipping) {
        shippingCost = parsedShipping.value;
      }
    }
  }

  return shippingCost;
}
