// netlify/functions/myFunction.ts
import {
  Handler,
  HandlerEvent,
  HandlerContext,
  HandlerResponse,
} from '@netlify/functions';
import { ScrapingBeeClient } from 'scrapingbee'; // Importing SPB's SDK
import 'dotenv/config'; // Import and configure dotenv
import parseCurrency from 'parsecurrency';

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

// --- eBay OAuth: fetch a client-credentials token ---
async function getEbayAccessToken(): Promise<string> {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('eBay API credentials not configured');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const URL = process.env.NODE_ENV === 'production' ? 'https://api.ebay.com/identity/v1/oauth2/token' : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'

  const response = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get eBay access token: ${err}`);
  }

  const data = await response.json();
  return data.access_token;
}

// --- Fetch items from eBay Browse API ---
async function fetchEbayItems(query: string): Promise<SoldItem[]> {
  const accessToken = await getEbayAccessToken();
  const formatItemName = encodeURIComponent(query);

  // Browse API: search active listings, filtered to USD + US location
  const url = `${process.env.NODE_ENV === 'production' ? `https://api.ebay.com` : `https://api.sandbox.ebay.com`}` + `/buy/browse/v1/item_summary/search?q=${formatItemName}&limit=200`;

  console.log({url, formatItemName});

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      // 'X-EBAY-C-ENDUSERCTX:affiliateCampaignId':<ePNCampaignId>,affiliateReferenceId=<referenceId>
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    console.log(response);
    const err = await response.text();
    throw new Error(`eBay Browse API error: ${err}`);
  }

  const data = await response.json();
  const itemSummaries = data.itemSummaries ?? [];

  return itemSummaries
    .map((item: any) => {
      const priceValue = parseFloat(item.price?.value ?? '0');
      const currency = item.price?.currency ?? 'USD';

      if (currency !== 'USD' || priceValue <= 0) return null;

      const shippingOptions = item.shippingOptions?.[0];
      let shipping = '0';
      if (shippingOptions) {
        if (shippingOptions.shippingCostType === 'FREE') {
          shipping = '0';
        } else {
          shipping = shippingOptions.shippingCost?.value ?? 'Unknown';
        }
      }

      return {
        title: item.title ?? '',
        price: priceValue,
        currency: '$',
        condition: item.condition ?? 'Unknown',
        imageUrl: item.image?.imageUrl ?? '',
        itemUrl: item.itemWebUrl ?? '',
        shipping,
      } satisfies SoldItem;
    })
    .filter(Boolean) as SoldItem[];
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

export const handler: Handler = async (
  event: HandlerEvent,
  _context: HandlerContext,
): Promise<HandlerResponse> => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: 'Preflight OK' };
  }

  try {
    const { q } = event.queryStringParameters || {};
    if (!q || q.trim() === '') {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Missing query parameter q' }),
      };
    }

    // Return cache if still valid for the same query
    const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
    if (cache.data && age < CACHE_DURATION && cache.query === q) {
      console.log('Returning cached data');
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ...cache.data, cached: true }),
      };
    }

    console.log(`Fetching eBay listings for: "${q}"`);
    let items = await fetchEbayItems(q);
    let response = {}
    let stats = {}

    // Fallback: if scrapingbee returned too few items, try SerpAPI as backup
    if (!items || items.length < 3) {
      const serpItems = (await fetchSerp(q)) || [];
      items = serpItems as any[];
      stats = calculateSalesMetrics(items);
      // source = 'serpapi';
      
      response = {
        query: q,
        stats,
        items,
        source: 'serpapi',
        cached: false,
      };
      cache.timestamp = Date.now();
      cache.query = q;
    } else {
      stats = calculateSalesMetrics(items);
      // let source = 'ebay-browse-api';

      response = { query: q, stats, items, source: 'ebay-browse-api', cached: false }
      cache.timestamp = Date.now();
      cache.query = q;
    }

    // Update cache
    // cache.data = responseBody;
    // cache.timestamp = Date.now();
    // cache.query = q;

    console.log(`SUCCESS — returned ${items.length} items`);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error('Error in handler:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal Server Error', message: String(error) }),
    };
  }
};


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


// // netlify/functions/myFunction.ts
// import {
//   Handler,
//   HandlerEvent,
//   HandlerContext,
//   HandlerResponse,
// } from '@netlify/functions';
// import { ScrapingBeeClient } from 'scrapingbee'; // Importing SPB's SDK
// import 'dotenv/config'; // Import and configure dotenv
// import * as cheerio from 'cheerio';
// // import parseCurrency from 'parsecurrency';

// // in-memory cache for 60 minutes
// const cache: { data: any; timestamp: number; query: string } = {
//   data: null,
//   timestamp: 0,
//   query: '',
// };
// const CACHE_DURATION = 60 * 60 * 1000; // 60 minutes in milliseconds

// type SoldItem = {
//   title: string;
//   price: number;
//   currency?: string;
//   soldDate?: string;
//   condition?: string;
//   imageUrl?: string;
//   itemUrl?: string;
//   shipping?: string;
// };

// // --- eBay OAuth: fetch a client-credentials token ---
// async function getEbayAccessToken(): Promise<string> {
//   const clientId = process.env.EBAY_CLIENT_ID;
//   const clientSecret = process.env.EBAY_CLIENT_SECRET;

//   if (!clientId || !clientSecret) {
//     throw new Error('eBay API credentials not configured');
//   }

//   const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

//   const URL = process.env.NODE_ENV === 'production' ? 'https://api.ebay.com/identity/v1/oauth2/token' : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'

//   console.log({credentials, p: process.env.NODE_ENV});

//   const response = await fetch(URL, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/x-www-form-urlencoded',
//       Authorization: `Basic ${credentials}`,
//     },
//     body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
//   });

//   if (!response.ok) {
//     const err = await response.text();
//     throw new Error(`Failed to get eBay access token: ${err}`);
//   }

//   const data = await response.json();
//   return data.access_token;
// }

// async function fetchEbaySoldItems(query: string): Promise<SoldItem[]> {
//   const token = await getEbayAccessToken()
//   const appId = process.env.EBAY_CLIENT_ID; // Same as Client ID

//   const url = `${process.env.NODE_ENV === 'production' ? `https://svcs.ebay.com/services/search/FindingService/v1` : `https://svcs.sandbox.ebay.com/services/search/FindingService/v1`}` +
//     `?OPERATION-NAME=findCompletedItems` +
//     `&SERVICE-VERSION=1.0.0` +
//     `&SECURITY-APPNAME=${appId}` +
//     `&RESPONSE-DATA-FORMAT=JSON` +
//     `&keywords=${encodeURIComponent(query)}` +
//     `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
//     `&itemFilter(1).name=ListingType&itemFilter(1).value=AuctionWithBIN` +
//     `&itemFilter(2).name=Currency&itemFilter(2).value=USD` +
//     `&paginationInput.entriesPerPage=200`;

//   const response = await fetch(url, {
//     headers: {
//       "CONTENT-TYPE": "SOAP12" ,
//       "X-EBAY-SOA-OPERATION-NAME": "findCompletedItems",
//       "X-EBAY-SOA-SECURITY-APPNAME": process.env.EBAY_CLIENT_ID || 'QuickflipAI',
//       // 'X-EBAY-SOA-OPERATION-NAME': 'findItemsByKeywords',
//       Authorization: `Bearer ${token}`,
//     }
//   });
//   if (!response.ok) {
//     const text = await response.text()
//     throw new Error(`Finding API error: ${response.statusText} ${text}`)
//   };

//   const data = await response.json();
//   const entries = data.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item ?? [];

//   return entries.map((item: any) => {
//     const priceValue = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] ?? '0');
//     const shipping = item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.['__value__'] ?? '0';

//     return {
//       title: item.title?.[0] ?? '',
//       price: priceValue,
//       currency: '$',
//       soldDate: item.listingInfo?.[0]?.endTime?.[0] ?? '',
//       condition: item.condition?.[0]?.conditionDisplayName?.[0] ?? 'Unknown',
//       imageUrl: item.galleryURL?.[0] ?? '',
//       itemUrl: item.viewItemURL?.[0] ?? '',
//       shipping,
//     } satisfies SoldItem;
//   }).filter((item: SoldItem) => item.price > 0);
// }

// function calculateSalesMetrics(items: SoldItem[]) {
//   const prices = items.map((item) => item.price);
//   return {
//     count: items.length,
//     p25: quantile(prices, 0.25),
//     median: quantile(prices, 0.5),
//     p75: quantile(prices, 0.75),
//   };
// }

// function quantile(arr: number[], q: number) {
//   const sorted = [...arr].sort((a, b) => a - b);
//   const pos = (sorted.length - 1) * q;
//   const base = Math.floor(pos);
//   const rest = pos - base;
//   return sorted[base + 1] !== undefined
//     ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
//     : sorted[base];
// }

// const CORS_HEADERS = {
//   'Access-Control-Allow-Origin': '*',
//   'Access-Control-Allow-Headers': '*',
//   'Access-Control-Allow-Methods': '*',
// };

// export const handler: Handler = async (
//   event: HandlerEvent,
//   _context: HandlerContext,
// ): Promise<HandlerResponse> => {
//   // Handle CORS preflight
//   if (event.httpMethod === 'OPTIONS') {
//     return { statusCode: 200, headers: CORS_HEADERS, body: 'Preflight OK' };
//   }

//   try {
//     const { q } = event.queryStringParameters || {};
//     if (!q || q.trim() === '') {
//       return {
//         statusCode: 400,
//         headers: CORS_HEADERS,
//         body: JSON.stringify({ error: 'Missing query parameter q' }),
//       };
//     }

//     // Return cache if still valid for the same query
//     const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
//     if (cache.data && age < CACHE_DURATION && cache.query === q) {
//       console.log('Returning cached data');
//       return {
//         statusCode: 200,
//         headers: CORS_HEADERS,
//         body: JSON.stringify({ ...cache.data, cached: true }),
//       };
//     }

//     console.log(`Fetching eBay listings for: "${q}"`);
//     const items = await fetchEbaySoldItems(q);
//     const stats = calculateSalesMetrics(items);

//     const responseBody = { query: q, stats, items, source: 'ebay-browse-api', cached: false };

//     // Update cache
//     cache.data = responseBody;
//     cache.timestamp = Date.now();
//     cache.query = q;

//     console.log(`SUCCESS — returned ${items.length} items`);
//     return {
//       statusCode: 200,
//       headers: CORS_HEADERS,
//       body: JSON.stringify(responseBody),
//     };
//   } catch (error) {
//     console.error('Error in handler:', error);
//     return {
//       statusCode: 500,
//       headers: CORS_HEADERS,
//       body: JSON.stringify({ error: 'Internal Server Error', message: String(error) }),
//     };
//   }
// };
// async function fetchSerp(q: string) {
//   const SERP_KEY = process.env.SERP_KEY;
//   if (!SERP_KEY) {
//     console.error('SerpAPI key not configured');
//     return null;
//   }

//   const u = new URL('https://serpapi.com/search.json');
//   u.searchParams.set('engine', 'ebay');
//   u.searchParams.set('no_cache', 'true');
//   u.searchParams.set('_nkw', q);
//   u.searchParams.set('ebay_domain', 'ebay.com');
//   u.searchParams.set('LH_PrefLoc', '1');
//   u.searchParams.set('_salic', '1');
//   u.searchParams.set('_ipg', '200');
//   u.searchParams.set('api_key', SERP_KEY);
//   const r = await fetch(u.toString());
//   if (!r.ok) {
//     const error = `SerpAPI ERROR ${r.status}`;
//     console.error(error);
//     throw new Error(error);
//   }
//   const j: any = await r.json();
//   const items: SoldItem[] = (j?.organic_results || [])
//     .map((it: any): SoldItem => {
//       const p = parsePrice(it.price.raw || it.price.raw || '');
//       return {
//         title: it.title || '',
//         price: p?.value || 0,
//         currency: p?.currency || 'USD',
//         imageUrl: it.thumbnail || '',
//         itemUrl: it.link || '',
//         soldDate: it.sold_at || new Date().toISOString(),
//         shipping: it.shipping ? getShippingCost(it.shipping) : 'Unknown',
//         condition: it.condition || 'Unknown',
//       };
//     })
//     .filter((x: SoldItem) => x.title && x.itemUrl && x.price > 0);
//   return items;
// }

