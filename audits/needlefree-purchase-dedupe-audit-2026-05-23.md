# NeedleFree Woo → Pixel Purchase Dedupe Audit — 2026-05-23

Generated: 2026-05-23 12:28 AEST
Ad account: act_160907410994298
Pixel: 925792214985190

## Executive finding

The headline gap `Pixel Purchase=136` vs `12 backend kit orders` is not an apples-to-apples comparison.

- The 12 figure only counts paid IM/SubQ kit orders: products 1141 and 1142.
- Woo had 37 paid orders across all products in the same 7d period.
- Pixel raw stats count all Purchase events across the site, not only kit purchases, and likely count browser + server-side events before/around dedupe diagnostics.
- All 37 paid Woo orders had `_pys_purchase_event_fired=1`, so PixelYourSite is firing Purchase for paid orders.
- Checkout config still has server API + AJAX server event + eventID wiring enabled for pixel 925792214985190.

Conclusion: no evidence that Meta is blind to Purchase. The issue is attribution quality and raw-event inflation, not a simple missing Purchase event.

## Core numbers

### Pixel raw stats

Last 7d:
- PageView: 15,203
- ViewContent: 2,547
- AddToCart: 480
- InitiateCheckout: 511
- Purchase: 136

Last 36h:
- PageView: 3,355
- ViewContent: 548
- AddToCart: 117
- InitiateCheckout: 105
- Purchase: 22

### Meta attributed actions, last 7d

- Spend: $541.76
- Purchase: 22
- offsite_conversion.fb_pixel_purchase: 22
- omni_purchase: 22
- AddToCart: 115
- InitiateCheckout: 172
- CTR: 2.81%
- CPC: $0.46
- CPM: $12.99

Important: `purchase`, `offsite_conversion.fb_pixel_purchase`, and `omni_purchase` match at 22. Do not sum them.

### Woo orders, last 7d

All order statuses:
- Total orders: 48
- Processing/paid: 37
- Cancelled: 11

Paid kit orders only:
- IM/SubQ kit orders: 12
- IM kit: 9
- SubQ kit: 3

Top paid products by quantity:
- Product 1521 nozzles/syringe 0.15: 18
- Product 1521 blue tip nozzles/syringe: 14
- Product 1155 14mm vial adapter: 10
- Product 1141 IM kit: 9
- Product 1524 Luer universal adapter: 7
- Product 1149 Luer adapter: 4
- Product 1142 SubQ kit: 3

## 7-day daily reconciliation

- 2026-05-17: Meta spend $70.02, Meta purchases 7, Woo kit orders 2, backend CPA $35.01
- 2026-05-18: Meta spend $80.80, Meta purchases 4, Woo kit orders 2, backend CPA $40.40
- 2026-05-19: Meta spend $87.77, Meta purchases 3, Woo kit orders 0
- 2026-05-20: Meta spend $86.54, Meta purchases 2, Woo kit orders 2, backend CPA $43.27
- 2026-05-21: Meta spend $81.23, Meta purchases 6, Woo kit orders 2, backend CPA $40.62
- 2026-05-22: Meta spend $61.96, Meta purchases 0, Woo kit orders 2, backend CPA $30.98
- 2026-05-23: partial day, Woo kit orders 1; Meta same-day attribution not settled

## Dedupe/config evidence

Checkout URL tested:
`https://injectneedlefree.com/checkout/?add-to-cart=1141`

Found in live HTML:
- `serverApiEnabled`: true
- `ajaxForServerEvent`: true
- `pys-facebook` REST endpoint: true
- `eventID`: true
- Pixel `925792214985190`: true
- PixelYourSite version marker: true

Relevant snippet showed PixelYourSite creating an AddToCart server/browser event with eventID for product 1141:

```txt
pys_late_event ... eventID ... name:"AddToCart" ... pixelIds:["925792214985190"] ... content_ids:["1141"]
```

This proves the current checkout-side PixelYourSite config is still designed for browser/server event ID dedupe.

## Woo order metadata evidence

Across 12 paid kit orders in the last 7d:

- `pys_enrich_data`: 12/12
- `pys_fb_cookie`: 12/12
- `_pys_purchase_event_fired`: 12/12
- `_wc_order_attribution_*`: 12/12
- `_fbc` equivalent inside `pys_fb_cookie`: 3/12
- `_fbp` equivalent inside `pys_fb_cookie`: 10/12 visible in sampled/truncated fields; all paid orders across all products had `pys_fb_cookie`

Across all 37 paid orders in the last 7d:

- `_pys_purchase_event_fired`: 37/37
- `pys_fb_cookie`: 37/37
- `fbp`: 37/37
- `fbc`: 5/37

Cancelled orders:

- 11 cancelled orders had `pys_fb_cookie`
- 0/11 had `_pys_purchase_event_fired`

This is good: cancelled orders are not being marked as Purchase-fired by PYS.

## Attribution quality

Kit order source types, last 7d:

- Organic: 8
- Type-in/direct: 2
- UTM: 1
- Referral: 1

Device:

- Mobile: 10
- Desktop: 2

Landing/session entry pages were mostly normal Woo/shop/organic paths:

- `/shop/`: dominant
- `/`: 2 orders
- `/comfort-in-comparison/`: 1
- `/trimix-auto-injector-without-needles/`: 1
- `/faq/`: 1
- `/shopping-cart/`: 1

Interpretation: only a minority of recent backend kit orders are carrying strong Meta click evidence (`fbc`). This means Meta click attribution is weak for many buyers even though Purchase is firing.

## Why 136 raw Pixel Purchases can coexist with 12 kit orders

1. The 12-order number excludes non-kit paid orders. Woo had 37 paid orders across all products.
2. Pixel raw stats are site-wide, not product-filtered.
3. Raw pixel stats may include both browser and server Purchase events, whereas Ads Manager reporting uses attributed/deduped action surfaces.
4. Purchases can be attributed across sessions and products; kit-only backend counts should not be compared directly to raw Pixel Purchase totals.

The more meaningful comparison is:

- Meta attributed purchases: 22
- Woo paid kit orders: 12
- Woo paid all-product orders: 37

That is not proof of catastrophic overcounting. It shows Meta is attributing some but not all purchase activity to ads, and raw pixel stats are inflated relative to backend orders as expected when browser/server events are both present.

## Remaining proof gap

Graph API cannot expose Meta Events Manager browser/server dedupe diagnostics. To prove Purchase dedupe at the strongest level, run a controlled test order and capture the thank-you page network:

Required match:

```txt
Browser Pixel Purchase request: ev=Purchase & eid=<EVENT_ID>
PixelYourSite server dispatch: event=Purchase & eventID=<same EVENT_ID>
```

Then confirm in Events Manager:

- Browser Purchase received
- Server Purchase received
- Deduplicated by event_id
- Event Match Quality acceptable

## Recommendations

1. Do not change campaign budgets based on the 136 vs 12 gap. That comparison is invalid.
2. Keep using Woo paid kit orders as cash truth.
3. Report Meta CPA using `action_type == "purchase"` only; never sum purchase/omni/offsite purchase.
4. Improve attribution continuity: low `fbc` presence means many buyers arrive via organic/direct later, so ad click match quality is weak.
5. If exact dedupe proof is needed, run a controlled low-value order/test order and capture thank-you page network + Events Manager Test Events.

Raw audit JSON: `/tmp/needlefree_purchase_dedupe_audit.json`
