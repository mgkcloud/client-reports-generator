#!/usr/bin/env python3
"""
NeedleFree checkout/log probe.

Uses stored secret names only:
- needlefree-woo-consumer-key
- needlefree-woo-consumer-secret

What this can do with current Woo REST keys:
- inspect Woo system status/log directory metadata
- inspect active payment/tracking plugins
- inspect product purchasability/stock
- count kit orders by status for a date window
- show failed/cancelled/pending/refunded kit order notes

What it cannot do with current keys:
- read raw wp-content/uploads/wc-logs/*.log files. Woo REST on this site has no logs route.
  To read those programmatically, add Cloudways SSH/SFTP credentials or install a locked-down WP-CLI/log export endpoint.
"""
import argparse, collections, json, os, subprocess, urllib.parse, urllib.request, urllib.error

SITE = 'https://injectneedlefree.com'
PRODUCT_IDS = {1141: 'IM Kit', 1142: 'SubQ Kit'}
STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed']
PAID = {'processing', 'completed'}


def secret(name):
    return subprocess.check_output(['bash', '/home/mgk/clawd/scripts/secrets.sh', 'get', name], text=True).strip()


def request_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 NeedleFreeCheckoutProbe', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def authed(path, params=None):
    params = dict(params or {})
    params['consumer_key'] = CK
    params['consumer_secret'] = CS
    sep = '&' if '?' in path else '?'
    return request_json(SITE + path + sep + urllib.parse.urlencode(params))


def kit_info(order):
    items = []
    for li in order.get('line_items') or []:
        pid = int(li.get('product_id') or 0)
        if pid in PRODUCT_IDS:
            items.append({'product_id': pid, 'label': PRODUCT_IDS[pid], 'qty': int(li.get('quantity') or 0), 'total': float(li.get('total') or 0)})
    return items


def fetch_orders(since, until, status):
    out = []
    page = 1
    while True:
        rows = authed('/wp-json/wc/v3/orders', {
            'after': since + 'T00:00:00',
            'before': until + 'T23:59:59',
            'status': status,
            'per_page': 100,
            'page': page,
            'orderby': 'date',
            'order': 'asc',
        })
        if not rows:
            break
        out.extend(rows)
        if len(rows) < 100:
            break
        page += 1
    return out


def order_notes(order_id):
    try:
        return authed(f'/wp-json/wc/v3/orders/{order_id}/notes', {'per_page': 50})
    except Exception as e:
        return [{'error': str(e)}]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until', required=True)
    args = ap.parse_args()

    status = authed('/wp-json/wc/v3/system_status')
    env = status.get('environment', {})
    plugins = []
    for p in status.get('active_plugins') or []:
        s = json.dumps(p).lower()
        if any(x in s for x in ['stripe', 'paypal', 'pixel', 'facebook', 'stape', 'cart abandonment', 'woocommerce']):
            plugins.append({k: p.get(k) for k in ['plugin', 'name', 'version', 'version_latest']})

    products = {}
    for pid, label in PRODUCT_IDS.items():
        p = authed(f'/wp-json/wc/v3/products/{pid}')
        products[pid] = {k: p.get(k) for k in ['name', 'status', 'catalog_visibility', 'price', 'stock_status', 'stock_quantity', 'backorders', 'purchasable', 'date_modified']}

    all_orders = []
    for st in STATUSES:
        all_orders.extend(fetch_orders(args.since, args.until, st))
    by_id = {o['id']: o for o in all_orders}

    kit = []
    for o in by_id.values():
        items = kit_info(o)
        if items:
            kit.append((o, items))

    status_counts = collections.Counter(o['status'] for o, _ in kit)
    bad_examples = []
    for o, items in kit:
        if o['status'] not in PAID:
            bad_examples.append({
                'id': o['id'],
                'date_created': o.get('date_created'),
                'status': o.get('status'),
                'total': o.get('total'),
                'payment_method': o.get('payment_method_title') or o.get('payment_method'),
                'items': items,
                'notes': order_notes(o['id'])[:10],
            })

    result = {
        'window': {'since': args.since, 'until': args.until},
        'log_access': {
            'rest_logs_route_available': False,
            'log_directory': env.get('log_directory'),
            'log_directory_writable': env.get('log_directory_writable'),
            'note': 'Current Woo REST exposes log directory metadata but no /system_status/logs route. Raw logs require Cloudways SSH/SFTP or a locked-down custom endpoint.'
        },
        'versions': {'woocommerce': env.get('version'), 'wordpress': env.get('wp_version'), 'php': env.get('php_version')},
        'interesting_plugins': plugins,
        'products': products,
        'kit_orders': {
            'total_any_status': len(kit),
            'paid': sum(1 for o, _ in kit if o['status'] in PAID),
            'non_paid': sum(1 for o, _ in kit if o['status'] not in PAID),
            'status_counts': dict(status_counts),
        },
        'non_paid_examples': bad_examples,
    }
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    CK = secret('needlefree-woo-consumer-key')
    CS = secret('needlefree-woo-consumer-secret')
    main()
