# NeedleFree Woo/Meta/GA4 Dropoff Audit — 2026-05-11

Period compared: selected week `2026-05-05 → 2026-05-11` vs prior weekly windows.

## Short answer

Current evidence does **not** point to WooCommerce checkout/payment failure for this week.

- Current week kit orders in Woo: `14 paid`, `0 failed/cancelled/pending/on-hold`.
- Prior week kit orders in Woo: `15 paid`, `1 refunded`, `0 failed/cancelled/pending/on-hold`.
- Products `1141` and `1142` are published, visible, purchasable, and in stock.
- Payment gateways are enabled; current week completed across Link, card, PayPal, and PayPal Pay Later.

The visible drop is mostly in Meta-attributed purchase rate / traffic quality, while backend Woo paid kit orders are roughly flat week-on-week.

## WooCommerce order status by period

### Current week: 2026-05-05 → 2026-05-11

- All Woo orders: `29`
- Kit orders any status: `14`
- Paid kit orders: `14`
- Paid kit units: `17`
- Paid kit revenue: `$8,391.77`
- Failed/cancelled/pending/on-hold kit orders: `0`
- Statuses: `processing: 14`

### Previous week: 2026-04-28 → 2026-05-04

- All Woo orders: `36`
- Kit orders any status: `16`
- Paid kit orders: `15`
- Paid kit units: `15`
- Paid kit revenue: `$6,580.79`
- Non-paid kit orders: `1 refunded`, `$342.77`
- Failed/cancelled/pending/on-hold kit orders: `0`

### Week before: 2026-04-21 → 2026-04-27

- All Woo orders: `32`
- Paid kit orders: `9`
- Paid kit revenue: `$4,608.38`
- Failed/cancelled/pending/on-hold kit orders: `0`

### 2026-04-14 → 2026-04-20

- All Woo orders: `47`
- Paid kit orders: `17`
- Paid kit revenue: `$8,612.03`
- Failed/cancelled/pending/on-hold kit orders: `0`

## Meta campaign funnel

### Current week

- Spend: `$522.74`
- CTR: `3.64%`
- Clicks: `1,308`
- Add to Cart: `128`
- Checkout: `45`
- Purchase: `13`
- Purchase value: `$6,434.77`
- ATC → Checkout: `35.2%`
- Checkout → Purchase: `28.9%`
- ATC → Purchase: `10.2%`

### Previous week

- Spend: `$555.88`
- CTR: `4.23%`
- Clicks: `1,643`
- Add to Cart: `162`
- Checkout: `20`
- Purchase: `26`
- Purchase value: `$9,329.53`
- ATC → Purchase: `16.0%`

## GA4 sitewide context

### Current week

- Sessions: `5,370`
- Users: `4,754`
- Transactions: `26`
- Revenue: `$13,678.36`
- Engagement rate: `32.6%`

### Previous week

- Sessions: `6,192`
- Users: `5,485`
- Transactions: `32`
- Revenue: `$10,456.57`
- Engagement rate: `29.8%`

## Product/API checks

- Product `1141`: published, visible, purchasable, in stock, price `$489.95`, modified `2026-05-06T00:22:11`.
- Product `1142`: published, visible, purchasable, in stock, price `$439.95`, modified `2026-05-05T17:59:21`.
- Enabled gateways include Stripe card, PayPal, Apple Pay, Google Pay, Afterpay, Affirm, Klarna, Zip, and other Stripe alternative methods.

## Interpretation

1. No Woo API evidence of a failed checkout/payment wave this week: current kit failures/cancellations/pending are zero.
2. Backend paid kit orders are basically flat vs previous week (`14` vs `15`), and revenue is higher (`$8.39k` vs `$6.58k`).
3. Meta-attributed purchases are down vs previous week (`13` vs `26`), but Woo paid orders did not halve. That points more toward attribution/traffic mix than checkout breakage.
4. Sitewide GA4 sessions fell ~13% and transactions fell ~19% vs prior week, but revenue rose. Lower volume, not total checkout collapse.
5. Product pages were modified right at the start of the selected period (`1142` May 5, `1141` May 6). Products are currently purchasable/in stock, but those changes are worth reviewing in WP admin / revision history.
6. Woo REST does not expose abandoned carts unless an abandoned-cart plugin/custom tracking exists. It can show created orders by status, not people who added to cart and never created an order.

## Next checks

- Inspect WP product revision history / plugin changes around `2026-05-05 → 2026-05-06`.
- Inspect checkout/payment logs in WP Admin → WooCommerce → Status → Logs for Stripe/PayPal errors on May 5–11.
- Add server-side checkout-start logging or an abandoned cart endpoint/plugin if we want real ATC/checkout abandonment truth from Woo.
- Compare new ad creative/adset audience quality against previous week because clicks fell ~20% and CTR fell from `4.23%` to `3.64%`, while Woo checkout did not show a failure spike.
