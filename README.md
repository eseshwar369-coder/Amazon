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

## 7. Known limitations / honesty notes

- **This code has not been run against live Amazon** from this environment —
  the sandbox used to build it has no network access to amazon.com. Amazon's
  search-page HTML/CSS selectors also change periodically and vary by
  marketplace (amazon.in vs amazon.com) and by A/B test, so selectors in
  `src/main.js` may need small adjustments after a first real run — the code
  is written to fail gracefully (logs a warning, extracts nothing invented)
  rather than fabricate data if a selector stops matching.
- Amazon actively rate-limits and blocks scraping traffic. This actor makes
  no attempt to defeat that (no proxy rotation, no CAPTCHA solving, no
  headless-browser fingerprint spoofing) per the stated constraints — for
  sustained, large-scale use you'd likely need Apify's proxy configuration
  and slower crawl rates, which is a deployment concern, not a code change.
- `sales_indicator` parsing only fires when Amazon's own "bought in past
  month" text is present on the card; no sales figure is ever invented or
  estimated.
