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

type SoldItem = {
  title: string;
  price: number;
  currency?: string;
  soldDate?: string;
  condition?: string;
  imageUrl?: string;
  itemUrl?: string;
  shipping?: string;
};

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

    const scrapURL = `https://www.ebay.com/sch/i.html?_nkw=${formatItemName}&_sop=12&LH_Active=1&_ipg=240&_salic=1&LH_PrefLoc=1`;
    const client = new ScrapingBeeClient(process.env.BEE_KEY || '');
    const response = await client.get({ url: scrapURL, params: { timeout: 140000 } });

    const rawHTML = await response.data;
    let items = extractSellItemsFromHTML(rawHTML, q);
    let stats = calculateSalesMetrics(items);
    let source = 'scrapingbee';

    // Fallback: if scrapingbee returned too few items, try SerpAPI as backup
    if (!items || items.length < 3) {
      const serpItems = (await fetchSerp(q)) || [];
      items = serpItems as any[];
      stats = calculateSalesMetrics(items);
      source = 'serpapi';

      cache.data = {
        query: q,
        stats,
        items,
        source,
        cached: true,
      };
      cache.timestamp = Date.now();
      cache.query = q;
    } else {
      stats = calculateSalesMetrics(items);

      cache.data = {
        query: q,
        stats,
        items,
        source,
        cached: true,
      };
      cache.timestamp = Date.now();
      cache.query = q;
    }

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
      },
      body: JSON.stringify({
        query: q,
        items,
        stats,
        source,
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
    const price = $(element).find('.s-card__price').text();

    const parsedPrice = parsePrice(price);
    if (parsedPrice?.symbol !== '$') {
      console.log(`Skipping item with non-USD currency: ${title} - ${price}`);
      return;
    }
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
      console.log('title is ', title, 'price is ', price);
      const resultData = {
        title,
        currency: parsedPrice?.symbol,
        price: parsedPrice?.value,
      };
      items.push(resultData);
    }
  });
  return items;
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

// get shipping cost if available
function getShippingCost(
  shipping: string | { raw: string; extracted: number },
) {
  let shippingCost = 0;

  if (typeof shipping === 'string') {
    if (
      !shipping.toLowerCase().includes('free') &&
      !shipping.toLocaleLowerCase().includes('bids') &&
      shipping.includes('delivery')
    ) {
      let formattedShipping = shipping.replace(' delivery', '');
      formattedShipping = formattedShipping.replace('+', '');
      const parsedShipping = parsePrice(formattedShipping);
      if (parsedShipping) {
        shippingCost = parsedShipping.value;
      }
    } else if (
      !shipping.toLowerCase().includes('free') &&
      shipping.toLocaleLowerCase().includes('bids')
    ) {
      return 'Unknown';
    }
  } else {
    shippingCost = shipping.extracted;
  }

  return String(shippingCost.toString());
}

async function fetchSerp(q: string) {
  const SERP_KEY = process.env.SERP_KEY;
  if (!SERP_KEY) {
    console.error('SerpAPI key not configured');
    return null;
  }

  const u = new URL('https://serpapi.com/search.json');
  u.searchParams.set('engine', 'ebay');
  u.searchParams.set('no_cache', 'true');
  u.searchParams.set('_nkw', q);
  u.searchParams.set('ebay_domain', 'ebay.com');
  u.searchParams.set('LH_PrefLoc', '1');
  u.searchParams.set('_salic', '1');
  u.searchParams.set('_ipg', '200');
  u.searchParams.set('api_key', SERP_KEY);
  const r = await fetch(u.toString());
  if (!r.ok) {
    const error = `SerpAPI ERROR ${r.status}`;
    console.error(error);
    throw new Error(error);
  }
  const j: any = await r.json();
  const items: SoldItem[] = (j?.organic_results || [])
    .map((it: any): SoldItem => {
      const p = parsePrice(it.price.raw || it.price.raw || '');
      return {
        title: it.title || '',
        price: p?.value || 0,
        currency: p?.currency || 'USD',
        imageUrl: it.thumbnail || '',
        itemUrl: it.link || '',
        soldDate: it.sold_at || new Date().toISOString(),
        shipping: it.shipping ? getShippingCost(it.shipping) : 'Unknown',
        condition: it.condition || 'Unknown',
      };
    })
    .filter((x: SoldItem) => x.title && x.itemUrl && x.price > 0);
  return items;
}
