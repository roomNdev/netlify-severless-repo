// netlify/functions/myFunction.ts
import {
  Handler,
  HandlerEvent,
  HandlerContext,
  HandlerResponse,
} from '@netlify/functions';
import 'dotenv/config';
import * as cheerio from 'cheerio';
import { ScrapingBeeClient } from 'scrapingbee';
import parseCurrency from 'parsecurrency';

const cache: { data: any; timestamp: number; query: string } = {
  data: null,
  timestamp: 0,
  query: '',
};
const CACHE_DURATION = 60 * 60 * 1000;

type SoldItem = {
  title: string;
  price: number;
  currency: string;
  condition: string;
  imageUrl: string;
  itemUrl: string;
  shipping: string;
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


    
    // const TZ = 'America%2FNew_York'
    // const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    // const endDate = new Date().toISOString().split('T')[0];

    const scrapURL = `https://www.ebay.com/sch/i.html?_nkw=${formatItemName}&_sacat=0&_from=R40&_sop=12&LH_PrefLoc=1&LH_Complete=1&_ipg=60&LH_Sold=1&_fcid=1`
    // `https://www.ebay.com/sh/research?marketplace=EBAY-US&keywords=${formatItemName}&dayRange=30&endDate=${endDate}&startDate=${startDate}&offset=0&limit=50&tabName=SOLD&tz=${TZ}`;

    const client = new ScrapingBeeClient(process.env.BEE_KEY || '');
    if (!process.env.BEE_KEY) {
      throw new Error('ScrapingBee API key not configured');
    }
    const response = await client.get({ url: scrapURL, params: {timeout: 140000, country_code: 'us', premium_proxy: true } });

    const rawHTML = await response.data;
    let items = extractSellItemsFromHTML(rawHTML, q);
    let stats = calculateSalesMetrics(items);
    let source = 'scrapingbee';

    // Fallback: if scrapingbee returned too few items, try SerpAPI as backup
    if (!items || items.length === 0) {
      console.log({items});
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
    const msg = Buffer.from(error.response.data)
    console.log(error.response.data);
    console.log('error body', msg.toString() )
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
    const soldDate = $(element).find('.s-card__caption').text();
    const subtile = $(element).find('.s-card__subtitle');
    const condition = subtile.find('span').first().text();
    let imageDiv = $(element).find('.su-image');
    if (!imageDiv || imageDiv.length === 0) {
      imageDiv = $(element).find('.s-card__image');
    }
    if (!imageDiv || imageDiv.length === 0) {
      imageDiv = $(element).find('.image-treatment');
    }
    const imageUrl = imageDiv.find('img').attr('src');
    console.log('+++++++++++++++++++++++++++++++++++++++');
    console.log('Image URL:', imageUrl);
    console.log('---------------------------------------');
    const itemUrl = imageDiv.find('a').attr('href');
    const parsedPrice = parsePrice(price);
    if (parsedPrice?.currency !== 'USD' && parsedPrice?.symbol !== '$') {
      console.log(`Skipping item with non-USD currency: ${title} - ${price}`);
      return;
    }
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
      const resultData = {
        title,
        price: parsedPrice?.value,
        unparsedPrice: price,
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
  if (priceStr.trim() === '') {
    return null;
  }
  const isRange = priceStr.includes('to')
  if (isRange) {
    const prices = priceStr.split(' to ')
    const parsedPrices = prices.map(p => parseCurrency(p))
    const avg = (parsedPrices[0].value + parsedPrices[1].value)/2    

    return {value: avg, currency: parsedPrices[0].currency, symbol: parsedPrices[0].symbol};
  }
  else {
    const parsed = parseCurrency(priceStr);
  
    if (parsed) {
      return {...parsed, currency: parsed?.symbol === '$' && !!parsed.currency ? 'USD' : parsed.currency };
    } 
    return parsed
  }
}

function calculateSalesMetrics(items: SoldItem[]) {
  const prices = items.map((item) => item.price);
  return {
    count: items.length,
    p25: quantile(prices, 0.25),
    median: quantile(prices, 0.5),
    p75: quantile(prices, 0.75),
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
  try {
    // Example dateStr: "Sold Sep 23, 2025"
    const parts = dateStr.replace('Sold ', '').split(' ');

    const month = new Date(Date.parse(parts[1] + ' 1, 2020')).getMonth();
    const day = parseInt(parts[2], 10);
    const year = parseInt(parts[3], 10);
    const date = new Date(Date.UTC(year, month, day));
    return date.toISOString();
  } catch (err) {
    console.error('Error converting date string:', err);
    return 'Unknown';
  }
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


// function extractSellItemsFromHTMLTerraPeak(html: string, query: string) {
//   const $ = cheerio.load(html);
//   const items: any[] = [];
//   console.log(`Extracting items from HTML...`);
//   $('.research-table-row').each((index, element) => {
//     const tileDiv = $(element).find('.research-table-row__link-row-anchor');
//     const link = tileDiv.attr()?.href
//     const title = tileDiv.find('span').text();
//     const price = $(element).find('.research-table-row__item-with-subtitle div:not(.format)').text();

//     const parsedPrice = parsePrice(price);
//     if (parsedPrice?.symbol !== '$') {
//       console.log(`Skipping item with non-USD currency: ${title} - ${price}`);
//       return;
//     }
//     // const subtile = $(element).find('.s-card__subtitle');
//     // const condition = subtile.find('span').first().text();

//     // let shipping = null;
//     // let shippingCost = null;
//     // sometimes shipping info is in the second child of .su-card-container__attributes__primary
//     // and sometimes it's not there at all
//     // const shippingInfo = $(element)
//     //   .find('.su-card-container__attributes__primary')
//     //   .children();
//     // if (shippingInfo.length > 1) {
//       // const shippingText = $(shippingInfo[2]).text();
//     // }
//     if (title) {
//       // const beautyCondition = condition.replace(' · ', '');
//       // compare item name to search string so we will have a weight system to determine the resell value
//       console.log('title is ', title, 'price is ', price);
//       const resultData = {
//         title,
//         link,
//         currency: parsedPrice?.symbol,
//         price: parsedPrice?.value,
//       };
//       items.push(resultData);
//     }
//   });
//   return items;
// }

async function fetchSerp(q: string) {
  const SERP_KEY = process.env.SERP_KEY;
  if (!SERP_KEY) {
    console.error('SerpAPI key not configured');
    return null;
  }

  const u = new URL('https://serpapi.com/search.json');
  u.searchParams.set('engine', 'ebay');
  u.searchParams.set('ebay_domain', 'ebay.com');
  u.searchParams.set('show_only', 'Sold,Complete');
  u.searchParams.set('_ipg', '60');
  u.searchParams.set('_nkw', q);
  u.searchParams.set('LH_PrefLoc', '1');
  u.searchParams.set('_salic', '1');
  u.searchParams.set('no_cache', 'true');
  // u.searchParams.set('LH_Sold', '1');
  // u.searchParams.set('LH_Complete', '1');
  // u.searchParams.set('LH_PrefLoc', 'Domestic');
  u.searchParams.set('api_key', SERP_KEY);
  const r = await fetch(u.toString());
  if (!r.ok) {
    const error = `SerpAPI ERROR ${r.status}`;
    console.error(error);
    throw new Error(error);
  }
  const j: any = await r.json();
  // console.log(j);
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
        shipping: getShippingCost(it.shipping),
        condition: it.condition || 'Unknown',
      };
    })
    .filter((x: SoldItem) => x.title && x.itemUrl && x.price > 0);
  return items;
}
