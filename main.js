import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

/**
 * Amazon Product Scraper (MVP)
 * SEARCH -> SCRAPE -> STRUCTURE -> FILTER -> OUTPUT
 *
 * v3: switched from CheerioCrawler (plain HTTP requests) to PlaywrightCrawler
 * (real Chromium browser) because Amazon.in was returning HTTP 503 to the
 * plain HTTP requests CheerioCrawler was making. A real browser context with
 * a real proxy IP is what Amazon expects before it will serve search results.
 *
 * Deliberately does NOT: touch Flipkart/Snapdeal, build a dashboard,
 * run AI scoring, automate login, bypass CAPTCHAs, or call private APIs.
 */

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    searchQuery,
    maxProducts = 50,
    minimumSales = 5000,
    minimumRating = 3.5,
    minimumReviews = 100,
    maximumReviews = 150,
    amazonDomain = 'amazon.in',
    useApifyProxy = true,
    proxyGroups, // optional array, e.g. ["RESIDENTIAL"] — leave empty to let Apify pick automatically
} = input;

if (!searchQuery || !searchQuery.trim()) {
    throw new Error('Input "searchQuery" is required (product name, keyword, or ingredient).');
}

log.info('Starting Amazon Product Scraper', {
    searchQuery, maxProducts, minimumSales, minimumRating, minimumReviews, maximumReviews, amazonDomain,
});

const seenAsins = new Set();
let collected = 0;
let searchRank = 0; // global running rank across pages, matches marketplace order

/** Build the search URL for a given page number. */
function buildSearchUrl(query, page) {
    const base = `https://www.${amazonDomain}/s`;
    const params = new URLSearchParams({ k: query });
    if (page > 1) params.set('page', String(page));
    return `${base}?${params.toString()}`;
}

/** Parse "10K+ bought in past month" / "5K+ bought in past month" / "200+ bought in past month" into a number. */
function parseSalesIndicator(rawText) {
    if (!rawText) return { sales_indicator: null, sales_numeric: null };
    const text = rawText.replace(/\s+/g, ' ').trim();
    const match = text.match(/([\d.,]+)\s*(K|M)?\+?\s*bought in past month/i);
    if (!match) return { sales_indicator: null, sales_numeric: null };

    const [, numPart, unit] = match;
    const cleanNum = parseFloat(numPart.replace(/,/g, ''));
    if (Number.isNaN(cleanNum)) return { sales_indicator: text, sales_numeric: null };

    let multiplier = 1;
    if (unit && unit.toUpperCase() === 'K') multiplier = 1000;
    if (unit && unit.toUpperCase() === 'M') multiplier = 1000000;

    return { sales_indicator: text, sales_numeric: Math.round(cleanNum * multiplier) };
}

/** Parse a price string like "₹1,299" or "$12.99" into a number, or null. */
function parsePrice(rawText) {
    if (!rawText) return null;
    const cleaned = rawText.replace(/[^\d.]/g, '');
    if (!cleaned) return null;
    const value = parseFloat(cleaned);
    return Number.isNaN(value) ? null : value;
}

/** Parse "4.3 out of 5 stars" into 4.3, or null. */
function parseRating(rawText) {
    if (!rawText) return null;
    const match = rawText.match(/([\d.]+)\s*out of\s*5/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    return Number.isNaN(value) ? null : value;
}

/** Parse a review-count string like "1,234" or "(1,234)" into a number, or null. */
function parseReviewCount(rawText) {
    if (!rawText) return null;
    const cleaned = rawText.replace(/[^\d]/g, '');
    if (!cleaned) return null;
    const value = parseInt(cleaned, 10);
    return Number.isNaN(value) ? null : value;
}

/** Decide passes_filter per spec: unavailable fields never count as a pass. */
function computePassesFilter(record) {
    const salesOk = record.sales_numeric !== null && record.sales_numeric > minimumSales;
    const ratingOk = record.rating !== null && record.rating >= minimumRating;
    const reviewOk = record.review_count !== null
        && record.review_count >= minimumReviews
        && record.review_count <= maximumReviews;
    return Boolean(salesOk && ratingOk && reviewOk);
}

function absoluteUrl(href) {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    return `https://www.${amazonDomain}${href}`;
}

// Amazon aggressively blocks/CAPTCHAs plain datacenter traffic. Route through Apify Proxy
// (residential if the account has it) rather than pretending this isn't a risk.
const proxyConfiguration = useApifyProxy
    ? await Actor.createProxyConfiguration({
        groups: Array.isArray(proxyGroups) && proxyGroups.length > 0 ? proxyGroups : undefined,
    })
    : undefined;

if (useApifyProxy && !proxyConfiguration) {
    log.warning('useApifyProxy was true but no proxy configuration could be created '
        + '(likely no Apify Proxy access on this account/plan). Continuing without a proxy — '
        + 'expect a higher chance of CAPTCHA blocks.');
}

let captchaHits = 0;
let blockedResponseHits = 0; // count of 503 / 429 / 403 responses hit (and retried)

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    headless: true,
    maxRequestsPerCrawl: 200, // safety ceiling on pages fetched, independent of maxProducts
    maxConcurrency: 1, // stay polite / avoid triggering anti-bot defenses
    requestHandlerTimeoutSecs: 90, // browser rendering + waits need more time than a plain HTTP fetch
    navigationTimeoutSecs: 60,

    // Retry handling for Amazon 503s / rate-limiting: each retry gets a fresh session
    // (and therefore, with proxyConfiguration set, typically a fresh outbound IP).
    maxRequestRetries: 5,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 20,
        sessionOptions: { maxUsageCount: 5 },
    },

    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            // Real-browser-shaped headers/locale, matching an India-based Chrome session.
            await page.setExtraHTTPHeaders({ 'accept-language': 'en-IN,en;q=0.9' });
        },
    ],

    async requestHandler({ page, request, response, session, parseWithCheerio, crawler: c }) {
        if (collected >= maxProducts) return;

        // --- Retry handling for Amazon 503 / 429 / 403 -------------------------------------
        // This is exactly what failed in the previous CheerioCrawler run. Detect it explicitly,
        // retire the session (so the retry gets a different proxy IP / cookie jar), and throw so
        // Crawlee's built-in retry mechanism (maxRequestRetries above) picks it back up.
        const status = response?.status();
        if (status && [503, 429, 403].includes(status)) {
            blockedResponseHits += 1;
            session?.retire();
            throw new Error(`Amazon returned HTTP ${status} for ${request.url} — retrying with a new session/IP `
                + `(attempt uses Apify Proxy: ${proxyConfiguration ? 'yes' : 'no'}).`);
        }

        // --- Wait for either real results or a CAPTCHA page before reading anything ---------
        try {
            await page.waitForSelector(
                'div[data-component-type="s-search-result"], form[action*="validateCaptcha"], #captchacharacters',
                { timeout: 30000 },
            );
        } catch {
            log.warning(`Timed out waiting for search results or a CAPTCHA marker on ${request.url}. `
                + 'The page may have loaded something unexpected. No fields are invented in this case.');
            throw new Error('Timed out waiting for page content — retrying.');
        }

        // Reuses the exact same Cheerio-based selector logic that already worked in local
        // selector tests — Crawlee's parseWithCheerio() hands us a Cheerio object built from
        // the fully-rendered DOM, so nothing below this line needed to change.
        const $ = await parseWithCheerio();

        const pageTitle = $('title').text() || '';
        const isCaptchaPage = /Robot Check|Enter the characters you see below|api-services-support/i.test(pageTitle)
            || $('form[action*="validateCaptcha"]').length > 0
            || $('#captchacharacters').length > 0;

        if (isCaptchaPage) {
            captchaHits += 1;
            session?.retire();
            log.warning(`Amazon served a CAPTCHA / bot-check page for ${request.url}. `
                + 'No product data is invented in this case — this page is skipped. '
                + 'If this keeps happening, enable/upgrade Apify Proxy (residential) in the input.');
            return;
        }

        const results = $('div[data-component-type="s-search-result"]');
        log.info(`Parsing ${request.url} — found ${results.length} result blocks`);

        if (results.length === 0) {
            log.warning('No result blocks found. Amazon may have served an unrecognized bot-check page, '
                + 'or the layout has changed since this actor was written. No fields are invented in this case.');
            return;
        }

        for (const el of results.toArray()) {
            if (collected >= maxProducts) break;

            const $el = $(el);
            const asin = $el.attr('data-asin') || null;

            // Sponsored/placeholder blocks sometimes have no ASIN — skip, don't invent data.
            if (!asin) continue;
            if (seenAsins.has(asin)) continue;

            searchRank += 1;

            const titleEl = $el.find('h2 span').first();
            const linkHref = $el.find('h2 a').first().attr('href') || $el.find('a.a-link-normal.s-line-clamp-2').first().attr('href');
            const imageUrl = $el.find('img.s-image').first().attr('src') || null;

            const priceText = $el.find('span.a-price:not(.a-text-price) span.a-offscreen').first().text() || null;
            const mrpText = $el.find('span.a-price.a-text-price span.a-offscreen').first().text() || null;

            const ratingRaw = $el.find('span.a-icon-alt').first().text() || null;
            const reviewCountRaw = $el.find('span[aria-label] a.s-underline-text, span.a-size-base.s-underline-text').first().text()
                || $el.find('a.a-link-normal span.a-size-base.s-underline-text').first().text()
                || null;

            // Amazon's "bought in past month" badge — text varies by layout, so scan a couple of likely spots.
            const salesRaw = $el.find('span:contains("bought in past month")').first().text() || null;

            // Brand: Amazon sometimes shows it as a small line above the title (h2's preceding sibling
            // span, class varies: "a-size-base-plus" / "s-line-clamp-1"). Best-effort only — left null
            // if not confidently found, never guessed from the product title.
            const brandRaw = $el.find('h2').prevAll('.a-row').find('span.a-size-base-plus').first().text()
                || $el.find('.a-row.a-size-base.a-color-secondary span.a-size-base-plus').first().text()
                || null;

            const availabilityText = $el.find('span.a-color-price:contains("stock"), span.a-size-base.a-color-secondary:contains("stock"), span.a-color-success, span.a-color-state').first().text() || null;

            const priceParsed = parsePrice(priceText);
            const mrpParsed = parsePrice(mrpText);
            const { sales_indicator, sales_numeric } = parseSalesIndicator(salesRaw);

            let discountPercentage = null;
            if (priceParsed !== null && mrpParsed !== null && mrpParsed > 0) {
                discountPercentage = Math.round(((mrpParsed - priceParsed) / mrpParsed) * 100);
            }

            const record = {
                product_name: titleEl.text().trim() || null,
                product_url: absoluteUrl(linkHref),
                image_url: imageUrl,
                brand: brandRaw ? brandRaw.trim() : null, // best-effort; null when not confidently found (never guessed from the title)
                price: priceParsed,
                mrp: mrpParsed,
                discount_percentage: discountPercentage,
                rating: parseRating(ratingRaw),
                review_count: parseReviewCount(reviewCountRaw),
                sales_indicator,
                sales_numeric,
                availability: availabilityText ? availabilityText.trim() : null,
                seller: null, // Amazon does not expose seller name on search-result cards, only on the product page
                category: null, // not exposed on search-result cards
                search_rank: searchRank,
                asin,
                passes_filter: false, // computed below
                scraped_at: new Date().toISOString(),
            };

            record.passes_filter = computePassesFilter(record);

            seenAsins.add(asin);
            collected += 1;
            await Actor.pushData(record);
        }

        if (collected >= maxProducts) {
            log.info(`Reached maxProducts (${maxProducts}). Stopping.`);
            return;
        }

        // Follow to the next search-results page if one exists.
        const nextHref = $('a.s-pagination-next').attr('href');
        if (nextHref && !$('a.s-pagination-next').hasClass('s-pagination-disabled')) {
            await c.addRequests([{ url: absoluteUrl(nextHref) }]);
        } else {
            log.info('No further search-result pages.');
        }
    },
    failedRequestHandler({ request }, err) {
        log.error(`Request ${request.url} failed: ${err.message}`);
    },
});

await crawler.run([{ url: buildSearchUrl(searchQuery, 1) }]);

log.info(`Done. Collected ${collected} unique product(s). `
    + `CAPTCHA/bot-check pages hit: ${captchaHits}. HTTP 503/429/403 responses hit (and retried): ${blockedResponseHits}.`);

if (collected === 0) {
    log.warning('Zero products collected. Check the log above for "HTTP 503/429/403", "CAPTCHA", or '
        + '"No result blocks found" warnings. If 503s persisted through all retries, try again with '
        + 'proxyGroups set to ["RESIDENTIAL"] in the input if your Apify plan includes it — Amazon '
        + 'is far more likely to serve real results to residential IPs than datacenter ones.');
}

await Actor.exit();
