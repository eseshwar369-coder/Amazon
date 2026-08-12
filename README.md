# Amazon Product Scraper (MVP)

SEARCH → SCRAPE → STRUCTURE → FILTER → OUTPUT.

Takes a keyword, searches Amazon, extracts one structured record per product,
and flags which products pass configurable sales/rating/review thresholds.
No AI scoring, no other marketplaces, no login automation, no CAPTCHA bypass.

## 1. How to run it

**On the Apify platform**
1. Push this folder as a new Actor (`apify push` from the Apify CLI, or create
   the Actor in the console and paste in these files).
2. Open the Actor's **Input** tab and fill in the form (Search Query is the
   only required field).
3. Click **Start**. Progress and any warnings appear in the run log.
4. Results land in the Actor's **Dataset** tab — export as JSON, CSV, or Excel.

**Locally**
```bash
npm install
apify run   # or: node src/main.js, after setting INPUT via Actor.getInput mock
```

## 2. Input schema

| Field | Type | Default | Notes |
|---|---|---|---|
| `searchQuery` | string | — (required) | Product name, keyword, or ingredient |
| `maxProducts` | integer | 50 | Stops once this many unique products are collected |
| `minimumSales` | integer | 5000 | Applies only when Amazon publicly shows a sales indicator |
| `minimumRating` | number | 3.5 | |
| `minimumReviews` | integer | 100 | |
| `maximumReviews` | integer | 150 | |
| `amazonDomain` | select | amazon.in | amazon.in / amazon.com / amazon.co.uk |

## 3. Output schema (one record per product)

```json
{
  "product_name": "Example Whey Protein",
  "product_url": "https://www.amazon.in/dp/B0EXAMPLE",
  "image_url": "https://m.media-amazon.com/images/...",
  "brand": null,
  "price": 1299,
  "mrp": 1999,
  "discount_percentage": 35,
  "rating": 4.3,
  "review_count": 127,
  "sales_indicator": "10K+ bought in past month",
  "sales_numeric": 10000,
  "availability": null,
  "seller": null,
  "category": null,
  "search_rank": 1,
  "asin": "B0EXAMPLE",
  "passes_filter": true,
  "scraped_at": "2026-08-12T10:15:00.000Z"
}
```

## 4. Sample run

```text
search_query = "whey protein"
max_products = 50
minimum_sales = 5000
minimum_rating = 3.5
minimum_reviews = 100
maximum_reviews = 150
```

Expected behavior: the actor opens the Amazon search results for "whey
protein", walks result pages in order, extracts up to 50 unique products
(deduplicated by ASIN), computes `passes_filter` for each, and writes every
record — passing or not — to the Dataset. Nothing is dropped; filtering only
sets a flag.

## 5. Fields reliably extracted from Amazon's search-results page

- `product_name`, `product_url`, `image_url`
- `price`, `mrp` (when a strikethrough price is shown), `discount_percentage` (derived)
- `rating`, `review_count`
- `sales_indicator` / `sales_numeric` (only when Amazon displays a "bought in
  past month" badge — this is common for popular items, absent for most)
- `search_rank`, `asin`, `scraped_at`, `passes_filter`

## 6. Fields Amazon does not expose on the search-results page

These are set to `null` by design rather than guessed:

- `brand` — sometimes inferable from the title text, but not reliably
  structured on the results card, so left null rather than parsed heuristically
- `availability` (In Stock / Out of Stock) — shown on the product detail
  page, rarely on search cards
- `seller` — only shown on the product detail page's buy box
- `category` — not present on search cards; would require visiting each
  product page or using Amazon's left-hand category filters

Pulling `brand`, `availability`, `seller`, and `category` reliably would mean
visiting each product's own page (one extra request per product) — worth
scoping as a v1.1 if needed, kept out of this MVP intentionally.

## 7. v3 change: CheerioCrawler → PlaywrightCrawler

The first real Apify run failed with `503 - Service Unavailable` from
`https://www.amazon.in/s?...`. Amazon.in serves 503s to plain HTTP requests
(what `CheerioCrawler` makes) far more aggressively than to a real browser
session with a real TLS/JS fingerprint. So:

- **Crawler engine**: `CheerioCrawler` → `PlaywrightCrawler`. Every search
  page is now opened in a real, proxied, headless Chromium browser instead of
  a bare HTTP GET.
- **Selector/extraction logic**: unchanged. Crawlee's `parseWithCheerio()`
  hands back a Cheerio object built from the fully-rendered DOM, so all the
  existing `$el.find(...)` selectors that were already unit-tested keep
  working — nothing was rewritten from scratch.
- **Wait-before-read**: the page now waits (up to 30s) for either a real
  result block or a known CAPTCHA marker to appear before reading anything,
  instead of reading whatever HTML happened to arrive first.
- **503/429/403 retry handling**: if Amazon responds with one of these
  status codes, the Actor retires the current session (so the retry gets a
  different proxy IP / fresh cookies) and retries up to 5 times, instead of
  giving up after one 503 like the previous version did.
- **Proxy**: unchanged input (`useApifyProxy`, `proxyGroups`) but now applies
  to browser traffic, not just HTTP requests — this matters more for a real
  browser, since Amazon fingerprints the IP + TLS + browser signals together.
- **Dockerfile**: base image switched from `apify/actor-node:20` to
  `apify/actor-node-playwright-chrome:20`, which ships Chromium preinstalled
  and matched to the `playwright` npm version in `package.json`. This is the
  standard Apify base image for browser-based Actors, so no extra setup is
  needed on the platform side.
- **Input fields, dataset schema, and output fields**: all unchanged, exactly
  as before (`searchQuery`, `maxProducts`, `minimumSales`, `minimumRating`,
  `minimumReviews`, `maximumReviews`, `amazonDomain`, plus the proxy fields).

## 8. Known limitations / honesty notes

- **This code has still not been run against live Amazon from my side**, and
  now for two separate reasons: (1) this sandbox has no network path to
  amazon.in, same as before, and (2) I also just confirmed it has no network
  path to Playwright's Chromium download server either (`cdn.playwright.dev`
  is blocked), so I can't even launch a real browser here to test navigation
  behavior. What WAS re-verified after this change:
  - The same 14/14 parsing/filter unit tests still pass (that logic is
    untouched).
  - `npm install` (including the `playwright` package) succeeds and the file
    passes a Node syntax check.
  - `PlaywrightCrawler` and `parseWithCheerio` were confirmed to exist and
    import correctly from the installed `crawlee` version.
  - What remains unverified until you run it on Apify: whether Playwright +
    Apify Proxy actually gets past Amazon's 503/CAPTCHA defenses. This is a
    much stronger approach than plain HTTP requests, but Amazon can still
    block browser traffic too, especially from datacenter proxy IPs — if it
    does, the log will now clearly say `HTTP 503/429/403 responses hit` or
    `CAPTCHA/bot-check pages hit` rather than just silently returning 0.
- **On "sales > 5,000" — read this carefully.** Amazon does **not** expose a
  real sales figure anywhere on its site. The only sales-related signal it
  sometimes shows is a rounded, self-reported badge like *"50+ bought in past
  month"* or *"10K+ bought in past month"* — and only for some products, not
  all. The scraper's `parseSalesIndicator()` function:
  - reads that exact badge text verbatim into `sales_indicator`
  - converts it to a number into `sales_numeric` **only when the badge is
    present and matches the expected pattern** (e.g. "10K+" → `10000`,
    "50+" → `50`)
  - sets both fields to `null` when the badge isn't shown at all — which will
    be the majority of products; this badge is fairly rare
  - `passes_filter`'s sales condition (`sales_numeric > minimumSales`) can
    **only ever be true for products where Amazon chose to display that
    badge**. A genuinely well-selling product without the badge showing will
    always fail the sales filter and be recorded with `passes_filter: false`
    — not because it doesn't sell well, but because Amazon didn't expose a
    number to check. This is a real constraint of what Amazon publishes, not
    a bug, and it's why `minimumSales` should be treated as "filter to
    products Amazon is willing to badge as high-selling," not a true
    sales-volume filter.
- Amazon actively rate-limits and CAPTCHAs scraping traffic. This version
  routes browser traffic through **Apify Proxy** (`useApifyProxy` input, on
  by default), retries 503/429/403 with a fresh session, and explicitly
  detects and logs CAPTCHA/bot-check pages instead of silently returning
  nothing. If your Apify plan includes Residential Proxy, set
  `proxyGroups: ["RESIDENTIAL"]` in the input — Amazon blocks plain
  datacenter IPs, including datacenter proxy IPs, far more often than
  residential ones, for both HTTP and browser traffic.
- `brand` is extracted best-effort from the small text line Amazon sometimes
  shows above the title — still `null` (never guessed from the title) when
  that line isn't present.
