/**
 * ToolHound hardware staff console.
 *
 * Four jobs, one page:
 *
 *   Pricing   — the cheapest-vendor suggestion beside the price customers see,
 *               with the markup that connects them, and a Publish action.
 *   Costs     — import a distributor price file, or type a cost in by hand.
 *   Catalog   — add and edit the products themselves.
 *   Orders    — what customers have submitted.
 *   Settings  — FX rate, default markup, staleness window, rounding.
 *
 * Access is gated twice over: Supabase Auth for identity, and the
 * `hardware_staff` allowlist (via hw_is_staff()) inside every RLS policy for
 * authorization. Signing up is not enough; somebody has to add the row.
 *
 * Publishing is deliberately a manual step. Distributor cost moves daily and
 * an unattended feed that rewrites the storefront would happily sell at a loss
 * on a bad FX day or a mis-parsed CSV column. Import writes cost; a human
 * looks at the deltas and publishes.
 */
(function () {
  'use strict';

  var U = window.THUI;
  var el = U.el;
  var CONFIG = window.TOOLHOUND_CONFIG || {};

  var AVAILABILITY = [
    { value: 'in_stock', label: 'In stock' },
    { value: 'low_stock', label: 'Limited stock' },
    { value: 'backorder', label: 'Backorder' },
    { value: 'discontinued', label: 'Discontinued' },
    { value: 'unknown', label: 'Unknown' }
  ];

  var TABS = [
    { key: 'pricing', label: 'Pricing' },
    { key: 'costs', label: 'Distributor Costs' },
    { key: 'catalog', label: 'Catalog' },
    { key: 'orders', label: 'Orders' },
    { key: 'settings', label: 'Settings' }
  ];

  /** Header names seen in BlueStar and ScanSource exports, lowercased. */
  var COLUMN_GUESSES = {
    sku: ['toolhound sku', 'th sku', 'our sku', 'internal sku', 'sku', 'part', 'part number', 'mfg part number', 'manufacturer part number', 'mpn', 'model'],
    vendor_sku: ['vendor sku', 'distributor sku', 'item number', 'item #', 'item no', 'scansource sku', 'bluestar sku', 'stock number', 'product id'],
    cost: ['cost', 'unit cost', 'your price', 'reseller price', 'dealer price', 'net price', 'price', 'unit price', 'contract price'],
    currency: ['currency', 'curr', 'cur'],
    availability: ['availability', 'stock status', 'status', 'in stock'],
    stock_qty: ['qty available', 'quantity available', 'available', 'qty', 'on hand', 'stock'],
    landed_add: ['freight', 'freight per unit', 'landed add', 'duty', 'freight and duty']
  };

  var state = {
    booting: true,
    session: null,
    staff: false,
    authError: '',
    login: { email: '', password: '', busy: false },

    tab: 'pricing',
    busy: false,
    message: null,        // { kind: 'good' | 'bad', text: string }

    settings: null,
    vendors: [],
    pricing: [],
    offers: [],
    products: [],
    orders: [],
    orderItems: {},       // order id -> items[]
    expandedOrder: null,

    pricingFilter: '',
    pricingSelection: {},  // product id -> true
    /** Unsaved edits on the pricing grid, product id -> partial patch. */
    pricingEdits: {},

    importer: {
      vendorCode: '',
      rawText: '',
      headers: [],
      rows: [],
      mapping: {},
      currency: 'USD',
      defaultAvailability: 'in_stock',
      parsed: null,        // { matched: [], unmatched: [] }
      busy: false
    },

    productDraft: null     // editing/creating a product
  };

  // ---------------------------------------------------------------------------
  // Client
  // ---------------------------------------------------------------------------

  /** Tests inject a stub through `window.__TOOLHOUND_DB__`. */
  function getDb() {
    if (window.__TOOLHOUND_DB__) return window.__TOOLHOUND_DB__;
    if (!window.supabase || !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) return null;
    if (!getDb._client) {
      getDb._client = window.supabase.createClient(
        CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
    }
    return getDb._client;
  }

  function say(kind, text) {
    state.message = { kind: kind, text: text };
    render();
  }

  function fail(context, error) {
    console.error(context, error);
    var detail = (error && (error.message || error.details || error.hint)) || 'unknown error';
    say('bad', context + ': ' + detail);
  }

  /** Await a Supabase query, rejecting on the `error` field rather than ignoring it. */
  function run(builder) {
    return Promise.resolve(builder).then(function (res) {
      if (res && res.error) throw res.error;
      return (res && res.data) || null;
    });
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  function boot() {
    var db = getDb();
    if (!db || !db.auth) {
      state.booting = false;
      state.authError = 'Authentication is unavailable. Check config.js.';
      render();
      return;
    }

    Promise.resolve(db.auth.getSession()).then(function (res) {
      state.session = (res && res.data && res.data.session) || null;
      state.booting = false;
      if (state.session) return checkStaffAndLoad();
      render();
    }).catch(function (e) {
      state.booting = false;
      fail('Could not read your session', e);
    });

    if (typeof db.auth.onAuthStateChange === 'function') {
      db.auth.onAuthStateChange(function (_event, session) {
        var had = !!state.session;
        state.session = session || null;
        if (state.session && !had) checkStaffAndLoad();
        else if (!state.session) { state.staff = false; render(); }
      });
    }
  }

  function signIn() {
    var db = getDb();
    if (!db) return;
    state.login.busy = true;
    state.authError = '';
    render();

    Promise.resolve(db.auth.signInWithPassword({
      email: state.login.email.trim(),
      password: state.login.password
    })).then(function (res) {
      state.login.busy = false;
      if (res && res.error) {
        state.authError = res.error.message || 'Sign in failed.';
        render();
        return;
      }
      state.session = res.data.session;
      state.login.password = '';
      return checkStaffAndLoad();
    }).catch(function (e) {
      state.login.busy = false;
      state.authError = (e && e.message) || 'Sign in failed.';
      render();
    });
  }

  function signOut() {
    var db = getDb();
    if (!db) return;
    Promise.resolve(db.auth.signOut()).then(function () {
      state.session = null;
      state.staff = false;
      render();
    });
  }

  /**
   * Confirm the signed-in user is actually on the allowlist. A valid session
   * with no `hardware_staff` row can read nothing, and an empty screen with no
   * explanation is the worst version of that.
   */
  function checkStaffAndLoad() {
    var db = getDb();
    return run(db.rpc('hw_is_staff')).then(function (isStaff) {
      state.staff = !!isStaff;
      if (!state.staff) { render(); return; }
      return loadAll();
    }).catch(function (e) {
      state.staff = false;
      fail('Could not confirm your access', e);
    });
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  function loadAll() {
    var db = getDb();
    state.busy = true;
    render();

    return Promise.all([
      run(db.from('hardware_settings').select('*').eq('id', true)),
      run(db.from('hardware_vendors').select('*').order('name', { ascending: true })),
      run(db.from('hardware_pricing_admin').select('*')
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })),
      run(db.from('hardware_vendor_offers').select('*')
        .order('quoted_at', { ascending: false })),
      run(db.from('hardware_products').select('*')
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }))
    ]).then(function (out) {
      state.settings = (out[0] && out[0][0]) || null;
      state.vendors = out[1] || [];
      state.pricing = out[2] || [];
      state.offers = out[3] || [];
      state.products = out[4] || [];
      state.pricingEdits = {};
      if (!state.importer.vendorCode && state.vendors.length) {
        state.importer.vendorCode = state.vendors[0].code;
      }
      state.busy = false;
      render();
    }).catch(function (e) {
      state.busy = false;
      fail('Could not load the console', e);
    });
  }

  function loadOrders() {
    var db = getDb();
    state.busy = true;
    render();
    return run(db.from('hardware_orders_admin').select('*')
      .order('submitted_at', { ascending: false }).limit(200)
    ).then(function (rows) {
      state.orders = rows || [];
      state.busy = false;
      render();
    }).catch(function (e) {
      state.busy = false;
      fail('Could not load orders', e);
    });
  }

  function loadOrderItems(orderId) {
    var db = getDb();
    if (state.orderItems[orderId]) { render(); return Promise.resolve(); }
    return run(db.from('hardware_order_items').select('*').eq('order_id', orderId)
    ).then(function (rows) {
      state.orderItems[orderId] = rows || [];
      render();
    }).catch(function (e) { fail('Could not load order lines', e); });
  }

  // ---------------------------------------------------------------------------
  // Pricing tab
  // ---------------------------------------------------------------------------

  function displayCurrency() {
    return (state.settings && state.settings.display_currency) || 'CAD';
  }

  function pricingRows() {
    var q = state.pricingFilter.trim().toLowerCase();
    if (!q) return state.pricing;
    return state.pricing.filter(function (r) {
      return (r.sku + ' ' + r.name + ' ' + (r.category || '')).toLowerCase().indexOf(q) >= 0;
    });
  }

  function editedValue(row, key) {
    var patch = state.pricingEdits[row.id];
    return patch && Object.prototype.hasOwnProperty.call(patch, key)
      ? patch[key] : row[key];
  }

  function setEdit(rowId, key, value) {
    if (!state.pricingEdits[rowId]) state.pricingEdits[rowId] = {};
    state.pricingEdits[rowId][key] = value;
  }

  function savePricingEdits() {
    var db = getDb();
    var ids = Object.keys(state.pricingEdits);
    if (!ids.length) { say('good', 'Nothing to save.'); return; }

    state.busy = true;
    render();

    Promise.all(ids.map(function (id) {
      var patch = state.pricingEdits[id];
      var update = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'markup_pct')) {
        update.markup_pct = patch.markup_pct;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'pricing_mode')) {
        update.pricing_mode = patch.pricing_mode;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'price_override_cents')) {
        update.price_override_cents = patch.price_override_cents;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'min_margin_cents')) {
        update.min_margin_cents = patch.min_margin_cents;
      }
      update.updated_at = new Date().toISOString();
      return run(db.from('hardware_products').update(update).eq('id', id));
    })).then(function () {
      return loadAll();
    }).then(function () {
      say('good', ids.length + ' product' + (ids.length === 1 ? '' : 's')
        + ' updated. Publish to push the new prices to the storefront.');
    }).catch(function (e) {
      state.busy = false;
      fail('Could not save pricing changes', e);
    });
  }

  function publish(productIds) {
    var db = getDb();
    state.busy = true;
    render();

    run(db.rpc('hw_publish_prices', { p_product_ids: productIds || null }))
      .then(function (rows) {
        var results = rows || [];
        var published = results.filter(function (r) { return r.published; }).length;
        var skipped = results.length - published;
        return loadAll().then(function () {
          state.pricingSelection = {};
          say(skipped ? 'bad' : 'good',
            published + ' price' + (published === 1 ? '' : 's') + ' published'
            + (skipped
              ? '. ' + skipped + ' product' + (skipped === 1 ? '' : 's')
                + ' had no fresh distributor cost and were taken off the '
                + 'storefront — import today’s cost file and publish again.'
              : ' to the storefront.'));
        });
      })
      .catch(function (e) {
        state.busy = false;
        fail('Publish failed', e);
      });
  }

  function renderPricing(app) {
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Pricing'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'Suggested price is the cheapest in-stock distributor landed cost plus '
      + 'markup, rounded up. Nothing a cost import writes reaches customers '
      + 'until you publish.'));

    var selectedIds = Object.keys(state.pricingSelection).filter(function (id) {
      return state.pricingSelection[id];
    });
    var editCount = Object.keys(state.pricingEdits).length;

    var search = el('input', {
      type: 'text',
      value: state.pricingFilter,
      placeholder: 'Filter by SKU, name or category',
      style: 'min-width:260px;',
      oninput: function (e) { state.pricingFilter = e.target.value; render(); }
    });

    panel.appendChild(el('div', { class: 'toolbar' }, [
      search,
      el('span', { class: 'spacer' }),
      editCount
        ? el('button', {
            class: 'ghost small', type: 'button', disabled: state.busy,
            onclick: savePricingEdits
          }, 'Save ' + editCount + ' change' + (editCount === 1 ? '' : 's'))
        : null,
      el('button', {
        class: 'primary small', type: 'button',
        disabled: state.busy || !selectedIds.length,
        onclick: function () { publish(selectedIds); }
      }, 'Publish selected (' + selectedIds.length + ')'),
      el('button', {
        class: 'ghost small', type: 'button', disabled: state.busy,
        onclick: function () {
          if (window.confirm('Publish suggested prices for every product? '
            + 'Products with no fresh distributor cost will be taken off the '
            + 'storefront.')) publish(null);
        }
      }, 'Publish all')
    ]));

    var rows = pricingRows();
    if (!rows.length) {
      panel.appendChild(el('p', { class: 'muted' },
        state.pricing.length ? 'Nothing matches that filter.'
          : 'No products yet. Add them on the Catalog tab.'));
      app.appendChild(panel);
      return;
    }

    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, ''),
      el('th', {}, 'SKU'),
      el('th', {}, 'Product'),
      el('th', {}, 'Cheapest vendor'),
      el('th', { class: 'num' }, 'Landed cost'),
      el('th', {}, 'Cost age'),
      el('th', { class: 'num' }, 'Markup % / price'),
      el('th', { class: 'num' }, 'Suggested'),
      el('th', { class: 'num' }, 'Live price'),
      el('th', {}, 'Storefront')
    ])));

    var body = el('tbody', {});
    rows.forEach(function (r) { body.appendChild(pricingRow(r)); });
    table.appendChild(body);
    panel.appendChild(el('div', { class: 'tbl-scroll' }, table));
    app.appendChild(panel);
  }

  function pricingRow(r) {
    var currency = r.published_currency || displayCurrency();
    var suggested = r.suggested_price_cents;
    var live = r.published_price_cents;
    var mode = editedValue(r, 'pricing_mode');

    var check = el('input', {
      type: 'checkbox',
      checked: !!state.pricingSelection[r.id],
      'aria-label': 'Select ' + r.sku,
      onchange: function (e) {
        state.pricingSelection[r.id] = e.target.checked;
        render();
      }
    });

    var markupInput = el('input', {
      class: 'cell',
      type: 'text',
      inputmode: 'decimal',
      disabled: mode === 'manual',
      value: editedValue(r, 'markup_pct') === null
        || editedValue(r, 'markup_pct') === undefined
        ? '' : String(editedValue(r, 'markup_pct')),
      placeholder: state.settings ? String(state.settings.default_markup_pct) : '',
      'aria-label': 'Markup percent for ' + r.sku,
      onchange: function (e) {
        var raw = e.target.value.trim();
        if (raw === '') { setEdit(r.id, 'markup_pct', null); render(); return; }
        var n = Number(raw);
        if (!isFinite(n) || n < 0 || n > 500) {
          e.target.classList.add('err');
          return;
        }
        e.target.classList.remove('err');
        setEdit(r.id, 'markup_pct', n);
        render();
      }
    });

    var modeSelect = el('select', {
      'aria-label': 'Pricing mode for ' + r.sku,
      onchange: function (e) {
        setEdit(r.id, 'pricing_mode', e.target.value);
        // A manual price needs a number to fall back on; seed it from
        // whatever is live so saving cannot violate the constraint.
        if (e.target.value === 'manual'
            && !editedValue(r, 'price_override_cents')) {
          setEdit(r.id, 'price_override_cents', live || suggested || null);
        }
        render();
      }
    }, [
      el('option', { value: 'auto', selected: mode === 'auto' }, 'Auto'),
      el('option', { value: 'manual', selected: mode === 'manual' }, 'Manual')
    ]);

    var overrideInput = el('input', {
      class: 'cell',
      type: 'text',
      inputmode: 'decimal',
      value: editedValue(r, 'price_override_cents')
        ? (editedValue(r, 'price_override_cents') / 100).toFixed(2) : '',
      placeholder: '0.00',
      'aria-label': 'Manual price for ' + r.sku,
      onchange: function (e) {
        var cents = U.parseMoneyToCents(e.target.value);
        if (e.target.value.trim() !== '' && (cents === null || cents <= 0)) {
          e.target.classList.add('err');
          return;
        }
        e.target.classList.remove('err');
        setEdit(r.id, 'price_override_cents', cents);
        render();
      }
    });

    var delta = (suggested != null && live != null) ? suggested - live : null;

    var staleHours = state.settings ? state.settings.stale_after_hours : 48;
    var costAgeCell = el('td', {}, r.best_quoted_at
      ? el('span', {
          class: 'badge' + (isStale(r.best_quoted_at, staleHours) ? ' bad' : '')
        }, U.formatAge(r.best_quoted_at))
      : el('span', { class: 'badge bad' }, 'no cost'));

    return el('tr', {}, [
      el('td', {}, check),
      el('td', {}, r.sku),
      el('td', { class: 'wrap' }, [
        el('div', {}, r.name),
        el('div', { class: 'prod-sku' }, r.category || '')
      ]),
      el('td', {}, r.best_vendor_code
        ? el('span', {}, [
            vendorName(r.best_vendor_code),
            r.best_vendor_sku ? el('div', { class: 'prod-sku' }, r.best_vendor_sku) : null
          ])
        : el('span', { class: 'muted' }, '—')),
      el('td', { class: 'num' }, r.best_landed_cost_cents != null
        ? U.formatMoney(r.best_landed_cost_cents, displayCurrency()) : '—'),
      costAgeCell,
      el('td', { class: 'num' }, mode === 'manual' ? overrideInput : markupInput),
      // The change sits under the suggestion rather than in a column of its
      // own: it is only ever read against the number above it, and the grid
      // has to stay narrow enough to see the Publish state without scrolling.
      el('td', { class: 'num' }, suggested != null
        ? el('span', {}, [
            el('div', {}, U.formatMoney(suggested, displayCurrency())),
            delta === null
              ? null
              : el('div', {
                  class: delta === 0 ? 'muted' : (delta > 0 ? 'delta-up' : 'delta-down'),
                  style: 'font-size:12px;'
                }, delta === 0 ? 'no change'
                  : (delta > 0 ? '+' : '') + U.formatMoney(delta, displayCurrency()))
          ])
        : el('span', { class: 'badge bad' }, 'none')),
      el('td', { class: 'num' }, live != null ? U.formatMoney(live, currency) : '—'),
      el('td', {}, [
        modeSelect,
        el('div', {}, r.is_published
          ? el('span', { class: 'badge ok' }, 'live')
          : el('span', { class: 'badge' }, 'hidden'))
      ])
    ]);
  }

  function isStale(quotedAt, staleHours) {
    var age = Date.now() - new Date(quotedAt).getTime();
    return !(age < staleHours * 3600 * 1000);
  }

  function vendorName(code) {
    for (var i = 0; i < state.vendors.length; i++) {
      if (state.vendors[i].code === code) return state.vendors[i].name;
    }
    return code;
  }

  // ---------------------------------------------------------------------------
  // Costs tab — importer and manual entry
  // ---------------------------------------------------------------------------

  function guessMapping(headers) {
    var mapping = {};
    var lower = headers.map(function (h) { return String(h || '').trim().toLowerCase(); });
    Object.keys(COLUMN_GUESSES).forEach(function (field) {
      var candidates = COLUMN_GUESSES[field];
      for (var i = 0; i < candidates.length; i++) {
        var idx = lower.indexOf(candidates[i]);
        if (idx >= 0) { mapping[field] = String(idx); return; }
      }
      // Fall back to a contains match so "Reseller Price (USD)" still lands.
      for (var j = 0; j < lower.length; j++) {
        for (var k = 0; k < candidates.length; k++) {
          if (lower[j].indexOf(candidates[k]) >= 0) { mapping[field] = String(j); return; }
        }
      }
    });
    return mapping;
  }

  function parseImportText(text) {
    var imp = state.importer;
    var rows = U.parseCsv(text);
    if (!rows.length) {
      imp.headers = [];
      imp.rows = [];
      imp.mapping = {};
      imp.parsed = null;
      return;
    }
    imp.headers = rows[0];
    imp.rows = rows.slice(1);
    imp.mapping = guessMapping(imp.headers);
    imp.parsed = null;
  }

  /**
   * Turn the mapped CSV into offer rows, matching each line to a product by
   * our SKU. Unmatched lines are reported rather than dropped: a price file
   * whose SKU column was mapped to the wrong column matches nothing, and that
   * should be loud.
   */
  function buildOfferRows() {
    var imp = state.importer;
    var m = imp.mapping;
    if (m.sku === undefined || m.cost === undefined) {
      say('bad', 'Map at least the ToolHound SKU and the cost column before importing.');
      return null;
    }

    var bySku = {};
    state.products.forEach(function (p) {
      bySku[String(p.sku).trim().toLowerCase()] = p;
    });

    var matched = [];
    var unmatched = [];
    var seen = {};

    imp.rows.forEach(function (row, i) {
      function cell(field) {
        var idx = m[field];
        return idx === undefined || idx === '' ? '' : String(row[Number(idx)] || '').trim();
      }

      var skuText = cell('sku');
      if (!skuText) return;

      var product = bySku[skuText.toLowerCase()];
      var cost = U.parseMoneyToCents(cell('cost'));

      if (!product) {
        unmatched.push({ line: i + 2, sku: skuText, reason: 'no product with this SKU' });
        return;
      }
      if (cost === null || cost <= 0) {
        unmatched.push({ line: i + 2, sku: skuText, reason: 'cost "' + cell('cost') + '" is not a number' });
        return;
      }
      // One offer per product per vendor: the unique constraint would reject a
      // batch containing the same product twice, so keep the first and say so.
      if (seen[product.id]) {
        unmatched.push({ line: i + 2, sku: skuText, reason: 'duplicate SKU in file — first row kept' });
        return;
      }
      seen[product.id] = true;

      var currencyCell = cell('currency').toUpperCase();
      var qty = U.toInt(cell('stock_qty'));
      var landed = U.parseMoneyToCents(cell('landed_add'));

      matched.push({
        product_id: product.id,
        vendor_code: imp.vendorCode,
        vendor_sku: cell('vendor_sku') || skuText,
        cost_cents: cost,
        currency: currencyCell === 'CAD' || currencyCell === 'USD' ? currencyCell : imp.currency,
        landed_add_cents: landed && landed > 0 ? landed : 0,
        availability: normalizeAvailability(cell('availability'), qty, imp.defaultAvailability),
        stock_qty: isNaN(qty) ? null : qty,
        quoted_at: new Date().toISOString(),
        source: 'csv',
        updated_at: new Date().toISOString()
      });
    });

    return { matched: matched, unmatched: unmatched };
  }

  /** Distributor stock wording varies; fall back to the quantity, then the default. */
  function normalizeAvailability(text, qty, fallback) {
    var fromText = availabilityFromText(text);
    var fromQty = availabilityFromQty(qty);
    if (fromText && fromQty) {
      // A feed that says "In Stock" alongside a quantity of 2 is both things
      // at once. Take the more cautious reading: promising same-day shipping
      // on two units when someone orders ten is the expensive mistake.
      return moreConservative(fromText, fromQty);
    }
    return fromText || fromQty || fallback || 'unknown';
  }

  function availabilityFromText(text) {
    var t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/discontinu|obsolete|eol|end of life/.test(t)) return 'discontinued';
    if (/backorder|back order|b\/o|out of stock|no stock|0 available/.test(t)) return 'backorder';
    if (/low|limited/.test(t)) return 'low_stock';
    if (/in stock|available|yes|true|^y$/.test(t)) return 'in_stock';
    return null;
  }

  function availabilityFromQty(qty) {
    if (qty === null || qty === undefined || isNaN(qty)) return null;
    if (qty <= 0) return 'backorder';
    if (qty < 5) return 'low_stock';
    return 'in_stock';
  }

  /** Ordered worst to best, so the lower index wins. */
  var AVAILABILITY_RANK = ['discontinued', 'backorder', 'low_stock', 'in_stock', 'unknown'];

  function moreConservative(a, b) {
    return AVAILABILITY_RANK.indexOf(a) <= AVAILABILITY_RANK.indexOf(b) ? a : b;
  }

  function runImport() {
    var built = buildOfferRows();
    if (!built) return;
    if (!built.matched.length) {
      state.importer.parsed = built;
      say('bad', 'Nothing matched. ' + built.unmatched.length + ' line'
        + (built.unmatched.length === 1 ? '' : 's') + ' could not be used — check '
        + 'the column mapping and that these SKUs exist in the catalog.');
      return;
    }

    var db = getDb();
    state.importer.parsed = built;
    state.importer.busy = true;
    render();

    run(db.from('hardware_vendor_offers')
      .upsert(built.matched, { onConflict: 'product_id,vendor_code' })
    ).then(function () {
      state.importer.busy = false;
      return loadAll();
    }).then(function () {
      say('good', built.matched.length + ' cost' + (built.matched.length === 1 ? '' : 's')
        + ' imported for ' + vendorName(state.importer.vendorCode)
        + (built.unmatched.length
          ? '. ' + built.unmatched.length + ' line'
            + (built.unmatched.length === 1 ? '' : 's') + ' skipped — see below.'
          : '.')
        + ' Review the Pricing tab, then publish.');
    }).catch(function (e) {
      state.importer.busy = false;
      fail('Import failed', e);
    });
  }

  function renderCosts(app) {
    var imp = state.importer;

    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Import a Distributor Price File'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'Upload or paste the daily cost file for one distributor. Costs land in '
      + 'the database immediately; customer-facing prices do not move until you '
      + 'publish on the Pricing tab.'));

    panel.appendChild(el('div', { class: 'notice' }, [
      el('strong', {}, 'Get the file from the distributor, not the storefront. '),
      'BlueStar and ScanSource both provide reseller price and availability '
      + 'feeds (scheduled file drop, EDI 832/846, or a partner API). Ask your '
      + 'rep to turn one on for the ToolHound account, then point '
      + 'scripts/import-vendor-prices.mjs at it to run this same import nightly. '
      + 'Scraping the logged-in web portal breaks on every redesign and is '
      + 'against the terms of both sites.'
    ]));

    var vendorSelect = el('select', {
      'aria-label': 'Distributor',
      onchange: function (e) { imp.vendorCode = e.target.value; render(); }
    }, state.vendors.map(function (v) {
      return el('option', { value: v.code, selected: imp.vendorCode === v.code }, v.name);
    }));

    var currencySelect = el('select', {
      'aria-label': 'File currency',
      onchange: function (e) { imp.currency = e.target.value; render(); }
    }, ['USD', 'CAD'].map(function (c) {
      return el('option', { value: c, selected: imp.currency === c }, c);
    }));

    var fileInput = el('input', {
      type: 'file',
      accept: '.csv,text/csv,text/plain',
      'aria-label': 'Price file',
      onchange: function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          imp.rawText = String(reader.result || '');
          parseImportText(imp.rawText);
          render();
        };
        reader.onerror = function () { say('bad', 'Could not read that file.'); };
        reader.readAsText(file);
      }
    });

    panel.appendChild(el('div', { class: 'toolbar' }, [
      el('label', { class: 'muted' }, 'Distributor'), vendorSelect,
      el('label', { class: 'muted' }, 'File currency'), currencySelect,
      el('span', { class: 'spacer' }),
      fileInput
    ]));

    // Parsing is an explicit button rather than an input handler: re-rendering
    // the page on every keystroke would tear the textarea out from under the
    // cursor.
    var paste = el('textarea', {
      rows: '5',
      placeholder: '…or paste CSV here, header row first',
      oninput: function (e) { imp.rawText = e.target.value; },
      style: 'width:100%;'
    });
    paste.value = imp.rawText;
    panel.appendChild(paste);
    panel.appendChild(el('div', { class: 'toolbar', style: 'margin-top:10px;' }, [
      el('button', {
        class: 'ghost small', type: 'button',
        onclick: function () {
          if (!String(imp.rawText || '').trim()) {
            say('bad', 'Paste the CSV text first, or choose a file.');
            return;
          }
          parseImportText(imp.rawText);
          render();
        }
      }, 'Read pasted CSV'),
      imp.headers.length
        ? el('button', {
            class: 'linkbtn', type: 'button',
            onclick: function () {
              imp.rawText = ''; imp.headers = []; imp.rows = [];
              imp.mapping = {}; imp.parsed = null;
              render();
            }
          }, 'Clear')
        : null
    ]));

    if (imp.headers.length) {
      panel.appendChild(renderMapping());
    }

    app.appendChild(panel);

    if (imp.parsed && imp.parsed.unmatched.length) {
      app.appendChild(renderSkipped(imp.parsed.unmatched));
    }

    app.appendChild(renderOffersTable());
  }

  function renderMapping() {
    var imp = state.importer;
    var box = el('div', { id: 'mapPanel', style: 'margin-top:18px;' });
    box.appendChild(el('h3', { style: 'font-size:14px;margin:0 0 4px;' },
      'Column mapping'));
    box.appendChild(el('p', { class: 'muted', style: 'margin:0 0 12px;' },
      imp.rows.length + ' data row' + (imp.rows.length === 1 ? '' : 's')
      + ' detected. Check the guesses below — a mis-mapped cost column is the '
      + 'one mistake that reaches customers.'));

    var fields = [
      { key: 'sku', label: 'ToolHound SKU *' },
      { key: 'cost', label: 'Unit cost *' },
      { key: 'vendor_sku', label: 'Distributor SKU' },
      { key: 'currency', label: 'Currency' },
      { key: 'availability', label: 'Stock status' },
      { key: 'stock_qty', label: 'Qty available' },
      { key: 'landed_add', label: 'Freight / duty per unit' }
    ];

    var grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;' });
    fields.forEach(function (f) {
      var select = el('select', {
        'aria-label': f.label,
        onchange: function (e) {
          if (e.target.value === '') delete imp.mapping[f.key];
          else imp.mapping[f.key] = e.target.value;
          imp.parsed = null;
          render();
        }
      }, [el('option', { value: '', selected: imp.mapping[f.key] === undefined },
        '— not in file —')].concat(imp.headers.map(function (h, i) {
        return el('option', {
          value: String(i),
          selected: imp.mapping[f.key] === String(i)
        }, (h || '(column ' + (i + 1) + ')'));
      })));

      var wrap = el('div', { class: 'field', style: 'margin:0;' });
      var id = 'map_' + f.key;
      select.id = id;
      wrap.appendChild(el('label', { for: id }, f.label));
      wrap.appendChild(select);
      grid.appendChild(wrap);
    });
    box.appendChild(grid);

    var defaultAvail = el('select', {
      'aria-label': 'Assume this stock status when the file has none',
      onchange: function (e) { imp.defaultAvailability = e.target.value; render(); }
    }, AVAILABILITY.map(function (a) {
      return el('option', {
        value: a.value, selected: imp.defaultAvailability === a.value
      }, a.label);
    }));

    box.appendChild(el('div', { class: 'toolbar', style: 'margin-top:14px;' }, [
      el('label', { class: 'muted' }, 'If the file has no stock status, assume'),
      defaultAvail,
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'ghost small', type: 'button',
        onclick: function () {
          var built = buildOfferRows();
          if (!built) return;
          state.importer.parsed = built;
          say(built.matched.length ? 'good' : 'bad',
            built.matched.length + ' line' + (built.matched.length === 1 ? '' : 's')
            + ' would import, ' + built.unmatched.length + ' skipped. Nothing '
            + 'has been written yet.');
        }
      }, 'Preview'),
      el('button', {
        class: 'primary small', type: 'button',
        disabled: imp.busy || !imp.vendorCode,
        onclick: runImport
      }, imp.busy ? 'Importing…' : 'Import costs')
    ]));

    if (imp.parsed && imp.parsed.matched.length) {
      box.appendChild(renderImportPreview(imp.parsed.matched.slice(0, 10)));
    }

    return box;
  }

  function renderImportPreview(rows) {
    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Product'),
      el('th', {}, 'Distributor SKU'),
      el('th', { class: 'num' }, 'Cost'),
      el('th', { class: 'num' }, 'Freight'),
      el('th', {}, 'Stock'),
      el('th', { class: 'num' }, 'Qty')
    ])));
    var body = el('tbody', {});
    rows.forEach(function (o) {
      var product = state.products.filter(function (p) { return p.id === o.product_id; })[0];
      body.appendChild(el('tr', {}, [
        el('td', { class: 'wrap' }, product ? product.sku + ' · ' + product.name : o.product_id),
        el('td', {}, o.vendor_sku),
        el('td', { class: 'num' }, U.formatMoney(o.cost_cents, o.currency) + ' ' + o.currency),
        el('td', { class: 'num' }, o.landed_add_cents
          ? U.formatMoney(o.landed_add_cents, o.currency) : '—'),
        el('td', {}, o.availability),
        el('td', { class: 'num' }, o.stock_qty == null ? '—' : String(o.stock_qty))
      ]));
    });
    table.appendChild(body);
    return el('div', { style: 'margin-top:14px;' }, [
      el('h3', { style: 'font-size:14px;margin:0 0 8px;' },
        'Preview (first ' + rows.length + ')'),
      el('div', { class: 'tbl-scroll' }, table)
    ]);
  }

  function renderSkipped(unmatched) {
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Skipped Lines'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'These rows were not imported. Usually the product does not exist in the '
      + 'catalog yet, or the cost column is mapped to the wrong column.'));
    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { class: 'num' }, 'Line'),
      el('th', {}, 'SKU in file'),
      el('th', {}, 'Reason')
    ])));
    var body = el('tbody', {});
    unmatched.slice(0, 100).forEach(function (u) {
      body.appendChild(el('tr', {}, [
        el('td', { class: 'num' }, String(u.line)),
        el('td', {}, u.sku),
        el('td', { class: 'wrap' }, u.reason)
      ]));
    });
    table.appendChild(body);
    panel.appendChild(el('div', { class: 'tbl-scroll' }, table));
    if (unmatched.length > 100) {
      panel.appendChild(el('p', { class: 'muted' },
        'and ' + (unmatched.length - 100) + ' more.'));
    }
    return panel;
  }

  function renderOffersTable() {
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Current Distributor Costs'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'One row per product per distributor. Edit a cost here for a one-off '
      + 'quote; the next import overwrites it.'));

    if (!state.offers.length) {
      panel.appendChild(el('p', { class: 'muted' },
        'No distributor costs recorded yet. Import a price file above, or add '
        + 'products first on the Catalog tab.'));
      return panel;
    }

    var staleHours = state.settings ? state.settings.stale_after_hours : 48;
    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Product'),
      el('th', {}, 'Distributor'),
      el('th', {}, 'Their SKU'),
      el('th', { class: 'num' }, 'Cost'),
      el('th', {}, 'Curr'),
      el('th', { class: 'num' }, 'Freight'),
      el('th', {}, 'Stock'),
      el('th', {}, 'Quoted'),
      el('th', {}, 'Source')
    ])));

    var body = el('tbody', {});
    state.offers.forEach(function (o) {
      var product = state.products.filter(function (p) { return p.id === o.product_id; })[0];
      body.appendChild(el('tr', {}, [
        el('td', { class: 'wrap' }, product
          ? el('span', {}, [
              el('div', {}, product.name),
              el('div', { class: 'prod-sku' }, product.sku)
            ])
          : o.product_id),
        el('td', {}, vendorName(o.vendor_code)),
        el('td', {}, o.vendor_sku),
        el('td', { class: 'num' }, costCell(o)),
        el('td', {}, o.currency),
        el('td', { class: 'num' }, o.landed_add_cents
          ? U.formatMoney(o.landed_add_cents, o.currency) : '—'),
        el('td', {}, availabilityCell(o)),
        el('td', {}, el('span', {
          class: 'badge' + (isStale(o.quoted_at, staleHours) ? ' bad' : '')
        }, U.formatAge(o.quoted_at))),
        el('td', {}, o.source)
      ]));
    });
    table.appendChild(body);
    panel.appendChild(el('div', { class: 'tbl-scroll' }, table));
    return panel;
  }

  function costCell(offer) {
    return el('input', {
      class: 'cell',
      type: 'text',
      inputmode: 'decimal',
      value: (offer.cost_cents / 100).toFixed(2),
      'aria-label': 'Cost for ' + offer.vendor_sku + ' at ' + offer.vendor_code,
      onchange: function (e) {
        var cents = U.parseMoneyToCents(e.target.value);
        if (cents === null || cents <= 0) { e.target.classList.add('err'); return; }
        e.target.classList.remove('err');
        updateOffer(offer.id, { cost_cents: cents });
      }
    });
  }

  function availabilityCell(offer) {
    return el('select', {
      'aria-label': 'Stock status for ' + offer.vendor_sku,
      onchange: function (e) { updateOffer(offer.id, { availability: e.target.value }); }
    }, AVAILABILITY.map(function (a) {
      return el('option', {
        value: a.value, selected: offer.availability === a.value
      }, a.label);
    }));
  }

  function updateOffer(offerId, patch) {
    var db = getDb();
    // A hand-edited cost is a fresh quote as far as the staleness window is
    // concerned — otherwise typing today's number leaves it looking stale.
    patch.quoted_at = new Date().toISOString();
    patch.updated_at = patch.quoted_at;
    patch.source = 'manual';
    run(db.from('hardware_vendor_offers').update(patch).eq('id', offerId))
      .then(loadAll)
      .then(function () { say('good', 'Cost updated. Publish to apply it.'); })
      .catch(function (e) { fail('Could not update that cost', e); });
  }

  // ---------------------------------------------------------------------------
  // Catalog tab
  // ---------------------------------------------------------------------------

  function blankProduct() {
    return {
      id: null, sku: '', name: '', category: '', short_description: '',
      long_description: '', image_url: '', lead_time_days: '', sort_order: 100,
      markup_pct: '', min_margin_cents: 0, pricing_mode: 'auto',
      price_override_cents: null
    };
  }

  function renderCatalogTab(app) {
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Catalog'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'The products customers can order. A product needs a distributor cost and '
      + 'a publish before it appears on the storefront.'));

    panel.appendChild(el('div', { class: 'toolbar' }, [
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'primary small', type: 'button',
        onclick: function () { state.productDraft = blankProduct(); render(); }
      }, 'Add product')
    ]));

    if (state.productDraft) panel.appendChild(renderProductForm());

    if (!state.products.length) {
      panel.appendChild(el('p', { class: 'muted' }, 'No products yet.'));
      app.appendChild(panel);
      return;
    }

    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'SKU'),
      el('th', {}, 'Name'),
      el('th', {}, 'Category'),
      el('th', { class: 'num' }, 'Sort'),
      el('th', { class: 'num' }, 'Lead days'),
      el('th', {}, 'Storefront'),
      el('th', {}, '')
    ])));
    var body = el('tbody', {});
    state.products.forEach(function (p) {
      body.appendChild(el('tr', {}, [
        el('td', {}, p.sku),
        el('td', { class: 'wrap' }, p.name),
        el('td', {}, p.category),
        el('td', { class: 'num' }, String(p.sort_order)),
        el('td', { class: 'num' }, p.lead_time_days == null ? '—' : String(p.lead_time_days)),
        el('td', {}, p.is_published
          ? el('span', { class: 'badge ok' }, 'live')
          : el('span', { class: 'badge' }, 'hidden')),
        el('td', {}, [
          el('button', {
            class: 'linkbtn', type: 'button',
            onclick: function () {
              state.productDraft = {
                id: p.id, sku: p.sku, name: p.name, category: p.category,
                short_description: p.short_description || '',
                long_description: p.long_description || '',
                image_url: p.image_url || '',
                lead_time_days: p.lead_time_days == null ? '' : String(p.lead_time_days),
                sort_order: p.sort_order,
                markup_pct: p.markup_pct == null ? '' : String(p.markup_pct),
                min_margin_cents: p.min_margin_cents,
                pricing_mode: p.pricing_mode,
                price_override_cents: p.price_override_cents
              };
              render();
            }
          }, 'Edit'),
          p.is_published
            ? el('button', {
                class: 'linkbtn', type: 'button', style: 'margin-left:10px;',
                onclick: function () { setPublished(p.id, false); }
              }, 'Hide')
            : null
        ])
      ]));
    });
    table.appendChild(body);
    panel.appendChild(el('div', { class: 'tbl-scroll' }, table));
    app.appendChild(panel);
  }

  function setPublished(productId, published) {
    var db = getDb();
    run(db.from('hardware_products')
      .update({ is_published: published, updated_at: new Date().toISOString() })
      .eq('id', productId))
      .then(loadAll)
      .then(function () {
        say('good', published ? 'Product is live.' : 'Product hidden from the storefront.');
      })
      .catch(function (e) { fail('Could not change visibility', e); });
  }

  function renderProductForm() {
    var d = state.productDraft;
    var box = el('div', { style: 'border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:18px;' });
    box.appendChild(el('h3', { style: 'font-size:14px;margin:0 0 12px;' },
      d.id ? 'Edit ' + d.sku : 'New product'));

    var fields = {};
    function add(key, label, opts) {
      var o = opts || {};
      var input = o.textarea
        ? el('textarea', {
            rows: '3',
            oninput: function (e) { d[key] = e.target.value; }
          })
        : el('input', {
            type: o.type || 'text',
            value: d[key] === null || d[key] === undefined ? '' : String(d[key]),
            placeholder: o.placeholder || '',
            oninput: function (e) { d[key] = e.target.value; }
          });
      if (o.textarea) input.value = d[key] || '';
      fields[key] = input;
      var wrap = el('div', { class: 'field' });
      var id = 'pf_' + key;
      input.id = id;
      wrap.appendChild(el('label', { for: id }, label));
      wrap.appendChild(input);
      wrap.appendChild(el('div', { class: 'err-msg', role: 'alert' }, 'Required'));
      input._errMsg = wrap.lastChild;
      if (o.hint) wrap.appendChild(el('div', { class: 'hint' }, o.hint));
      box.appendChild(wrap);
      return input;
    }

    add('sku', 'ToolHound SKU *', {
      hint: 'The key distributor price files are matched on. Keep it stable.'
    });
    add('name', 'Product Name *');
    add('category', 'Category *', { placeholder: 'e.g. Mobile Computers' });
    add('short_description', 'Short Description', { textarea: true,
      hint: 'One or two lines, shown on the catalog card.' });
    add('long_description', 'Long Description', { textarea: true });
    add('image_url', 'Image URL', {
      hint: 'Must be an https URL. The storefront CSP only allows same-origin '
        + 'and data: images, so host the file in public/ or inline it.'
    });

    var row = el('div', { class: 'row2' });
    [['sort_order', 'Sort Order'], ['lead_time_days', 'Lead Time (days)']].forEach(function (pair) {
      var input = el('input', {
        type: 'text',
        inputmode: 'numeric',
        value: d[pair[0]] === null || d[pair[0]] === undefined ? '' : String(d[pair[0]]),
        oninput: function (e) { d[pair[0]] = e.target.value; }
      });
      fields[pair[0]] = input;
      var wrap = el('div', { class: 'field' });
      input.id = 'pf_' + pair[0];
      wrap.appendChild(el('label', { for: input.id }, pair[1]));
      wrap.appendChild(input);
      row.appendChild(wrap);
    });
    box.appendChild(row);

    add('markup_pct', 'Markup % (blank = use default)', {
      placeholder: state.settings ? String(state.settings.default_markup_pct) : '25'
    });

    box.appendChild(el('div', { class: 'actions' }, [
      el('button', {
        class: 'ghost', type: 'button',
        onclick: function () { state.productDraft = null; render(); }
      }, 'Cancel'),
      el('button', {
        class: 'primary', type: 'button',
        onclick: function () { saveProduct(fields); }
      }, d.id ? 'Save changes' : 'Create product')
    ]));

    return box;
  }

  function saveProduct(fields) {
    var d = state.productDraft;
    var ok = true;
    ['sku', 'name', 'category'].forEach(function (key) {
      var bad = !String(d[key] || '').trim();
      if (fields[key]) {
        fields[key].classList.toggle('err', bad);
        if (fields[key]._errMsg) fields[key]._errMsg.style.display = bad ? 'block' : 'none';
      }
      if (bad) ok = false;
    });
    if (!ok) return;

    var markup = String(d.markup_pct || '').trim();
    var lead = String(d.lead_time_days || '').trim();
    var sort = U.toInt(d.sort_order);

    var row = {
      sku: d.sku.trim(),
      name: d.name.trim(),
      category: d.category.trim(),
      short_description: String(d.short_description || '').trim() || null,
      long_description: String(d.long_description || '').trim() || null,
      image_url: String(d.image_url || '').trim() || null,
      lead_time_days: lead === '' ? null : U.toInt(lead),
      sort_order: isNaN(sort) ? 100 : sort,
      markup_pct: markup === '' ? null : Number(markup),
      updated_at: new Date().toISOString()
    };

    if (row.markup_pct !== null && (!isFinite(row.markup_pct) || row.markup_pct < 0)) {
      say('bad', 'Markup must be a number of percent, or blank to use the default.');
      return;
    }

    var db = getDb();
    var query = d.id
      ? db.from('hardware_products').update(row).eq('id', d.id)
      : db.from('hardware_products').insert(row);

    run(query).then(function () {
      state.productDraft = null;
      return loadAll();
    }).then(function () {
      say('good', d.id ? 'Product saved.'
        : 'Product created. Add a distributor cost, then publish.');
    }).catch(function (e) {
      fail('Could not save the product', e);
    });
  }

  // ---------------------------------------------------------------------------
  // Orders tab
  // ---------------------------------------------------------------------------

  function renderOrders(app) {
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Hardware Orders'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'Newest first. Estimated cost is the distributor cost captured when each '
      + 'line was priced, so margin here is indicative, not the invoice.'));

    panel.appendChild(el('div', { class: 'toolbar' }, [
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'ghost small', type: 'button', disabled: state.busy, onclick: loadOrders
      }, state.busy ? 'Loading…' : 'Refresh')
    ]));

    if (!state.orders.length) {
      panel.appendChild(el('p', { class: 'muted' },
        state.busy ? 'Loading…' : 'No orders yet. Hit Refresh if you expect some.'));
      app.appendChild(panel);
      return;
    }

    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Reference'),
      el('th', {}, 'Submitted'),
      el('th', { class: 'wrap' }, 'Customer'),
      el('th', { class: 'num' }, 'Lines'),
      el('th', { class: 'num' }, 'Units'),
      el('th', { class: 'num' }, 'Subtotal'),
      el('th', { class: 'num' }, 'Est. cost'),
      el('th', { class: 'num' }, 'Est. margin'),
      el('th', {}, 'Status'),
      el('th', {}, '')
    ])));

    var body = el('tbody', {});
    state.orders.forEach(function (o) {
      var margin = (o.subtotal_cents || 0) - (o.est_cost_cents || 0);
      body.appendChild(el('tr', {}, [
        el('td', {}, o.order_ref),
        el('td', {}, U.formatDateTime(o.submitted_at)),
        el('td', { class: 'wrap' }, [
          el('div', {}, o.company_name),
          el('div', { class: 'prod-sku' }, o.contact_name + ' · ' + o.contact_email)
        ]),
        el('td', { class: 'num' }, String(o.line_count)),
        el('td', { class: 'num' }, String(o.unit_count)),
        el('td', { class: 'num' }, U.formatMoney(o.subtotal_cents, displayCurrency())),
        el('td', { class: 'num' }, U.formatMoney(o.est_cost_cents, displayCurrency())),
        el('td', { class: 'num' }, el('span', { class: margin >= 0 ? 'delta-up' : 'delta-down' },
          U.formatMoney(margin, displayCurrency()))),
        el('td', {}, orderStatusSelect(o)),
        el('td', {}, el('button', {
          class: 'linkbtn', type: 'button',
          onclick: function () {
            state.expandedOrder = state.expandedOrder === o.id ? null : o.id;
            if (state.expandedOrder) loadOrderItems(o.id); else render();
          }
        }, state.expandedOrder === o.id ? 'Hide lines' : 'Show lines'))
      ]));

      if (state.expandedOrder === o.id) {
        body.appendChild(el('tr', {}, el('td', { colspan: '10' }, orderDetail(o))));
      }
    });
    table.appendChild(body);
    panel.appendChild(el('div', { class: 'tbl-scroll' }, table));
    app.appendChild(panel);
  }

  function orderStatusSelect(order) {
    var options = ['new', 'quoted', 'ordered', 'shipped', 'cancelled'];
    return el('select', {
      'aria-label': 'Status for ' + order.order_ref,
      onchange: function (e) {
        var db = getDb();
        run(db.from('hardware_orders').update({ status: e.target.value })
          .eq('id', order.id))
          .then(loadOrders)
          .then(function () { say('good', order.order_ref + ' marked ' + e.target.value + '.'); })
          .catch(function (err) { fail('Could not update status', err); });
      }
    }, options.map(function (s) {
      return el('option', { value: s, selected: order.status === s }, s);
    }));
  }

  function orderDetail(order) {
    var items = state.orderItems[order.id];
    var box = el('div', { style: 'padding:6px 0 12px;' });

    box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px;' },
      'Ship to: ' + [order.address, order.city, order.state_province,
        order.postal_code, order.country].filter(Boolean).join(', ')
      + (order.po_number ? ' · PO ' + order.po_number : '')
      + (order.contact_phone ? ' · ' + order.contact_phone : '')));

    if (order.notes) {
      box.appendChild(el('div', { class: 'notice' }, [
        el('strong', {}, 'Customer notes: '), order.notes
      ]));
    }

    if (!items) {
      box.appendChild(el('p', { class: 'muted' }, 'Loading lines…'));
      return box;
    }

    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'SKU'),
      el('th', {}, 'Product'),
      el('th', { class: 'num' }, 'Qty'),
      el('th', { class: 'num' }, 'Unit'),
      el('th', { class: 'num' }, 'Line total')
    ])));
    var body = el('tbody', {});
    items.forEach(function (i) {
      body.appendChild(el('tr', {}, [
        el('td', {}, i.sku),
        el('td', { class: 'wrap' }, i.name),
        el('td', { class: 'num' }, String(i.quantity)),
        el('td', { class: 'num' }, U.formatMoney(i.unit_price_cents, i.currency)),
        el('td', { class: 'num' }, U.formatMoney(i.quantity * i.unit_price_cents, i.currency))
      ]));
    });
    table.appendChild(body);
    box.appendChild(el('div', { class: 'tbl-scroll' }, table));
    return box;
  }

  // ---------------------------------------------------------------------------
  // Settings tab
  // ---------------------------------------------------------------------------

  function renderSettings(app) {
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Pricing Settings'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'These apply to every product without its own override. Changing them '
      + 'changes the suggestions, not the live prices — publish to apply.'));

    var s = state.settings;
    if (!s) {
      panel.appendChild(el('p', { class: 'muted' }, 'Settings not loaded.'));
      app.appendChild(panel);
      return;
    }

    var draft = {
      display_currency: s.display_currency,
      fx_usd_to_cad: String(s.fx_usd_to_cad),
      default_markup_pct: String(s.default_markup_pct),
      stale_after_hours: String(s.stale_after_hours),
      round_price_to_cents: String(s.round_price_to_cents)
    };

    function numField(key, label, hint) {
      var input = el('input', {
        type: 'text',
        inputmode: 'decimal',
        value: draft[key],
        oninput: function (e) { draft[key] = e.target.value; }
      });
      var wrap = el('div', { class: 'field' });
      input.id = 'set_' + key;
      wrap.appendChild(el('label', { for: input.id }, label));
      wrap.appendChild(input);
      if (hint) wrap.appendChild(el('div', { class: 'hint' }, hint));
      panel.appendChild(wrap);
    }

    var currencySelect = el('select', {
      onchange: function (e) { draft.display_currency = e.target.value; }
    }, ['CAD', 'USD'].map(function (c) {
      return el('option', { value: c, selected: draft.display_currency === c }, c);
    }));
    var currWrap = el('div', { class: 'field' });
    currencySelect.id = 'set_currency';
    currWrap.appendChild(el('label', { for: 'set_currency' }, 'Selling Currency'));
    currWrap.appendChild(currencySelect);
    currWrap.appendChild(el('div', { class: 'hint' },
      'Distributor costs are converted into this before being compared.'));
    panel.appendChild(currWrap);

    numField('fx_usd_to_cad', 'USD → CAD Rate',
      'Conversions round up, so a rate slightly above spot is the safe error.');
    numField('default_markup_pct', 'Default Markup %',
      'Applied to landed cost for any product without its own markup.');
    numField('stale_after_hours', 'Treat Cost as Stale After (hours)',
      'A distributor cost older than this is not used to price anything. '
      + 'Products with nothing fresh come off the storefront on publish.');
    numField('round_price_to_cents', 'Round Prices Up To (cents)',
      '100 rounds up to the whole dollar. 1 leaves the exact figure.');

    panel.appendChild(el('div', { class: 'actions' }, [
      el('span'),
      el('button', {
        class: 'primary', type: 'button',
        onclick: function () { saveSettings(draft); }
      }, 'Save settings')
    ]));

    app.appendChild(panel);
    app.appendChild(renderStaffPanel());
  }

  function saveSettings(draft) {
    var fx = Number(draft.fx_usd_to_cad);
    var markup = Number(draft.default_markup_pct);
    var stale = U.toInt(draft.stale_after_hours);
    var round = U.toInt(draft.round_price_to_cents);

    if (!isFinite(fx) || fx <= 0) { say('bad', 'FX rate must be a positive number.'); return; }
    if (!isFinite(markup) || markup < 0 || markup > 500) {
      say('bad', 'Default markup must be between 0 and 500 percent.'); return;
    }
    if (isNaN(stale) || stale < 1) { say('bad', 'Staleness window must be at least 1 hour.'); return; }
    if (isNaN(round) || round < 1) { say('bad', 'Rounding must be at least 1 cent.'); return; }

    var db = getDb();
    run(db.from('hardware_settings').update({
      display_currency: draft.display_currency,
      fx_usd_to_cad: fx,
      default_markup_pct: markup,
      stale_after_hours: stale,
      round_price_to_cents: round,
      updated_at: new Date().toISOString()
    }).eq('id', true))
      .then(loadAll)
      .then(function () { say('good', 'Settings saved. Publish to apply them.'); })
      .catch(function (e) { fail('Could not save settings', e); });
  }

  function renderStaffPanel() {
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Access'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'Console access is an explicit allowlist. Create the Supabase Auth user, '
      + 'then insert their user id into public.hardware_staff from the '
      + 'dashboard — it cannot be granted from this screen, on purpose.'));
    return panel;
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  function renderLogin(app) {
    var panel = el('div', { class: 'panel login' });
    panel.appendChild(el('h2', {}, 'Staff Sign In'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'Distributor cost is only visible to signed-in staff.'));

    if (state.authError) panel.appendChild(errorBanner(state.authError));

    var emailInput = el('input', {
      type: 'email',
      value: state.login.email,
      placeholder: 'you@toolhound.com',
      oninput: function (e) { state.login.email = e.target.value; }
    });
    var passInput = el('input', {
      type: 'password',
      value: state.login.password,
      placeholder: 'Password',
      oninput: function (e) { state.login.password = e.target.value; },
      onkeydown: function (e) { if (e.key === 'Enter') signIn(); }
    });

    var eWrap = el('div', { class: 'field' });
    emailInput.id = 'loginEmail';
    eWrap.appendChild(el('label', { for: 'loginEmail' }, 'Email'));
    eWrap.appendChild(emailInput);
    panel.appendChild(eWrap);

    var pWrap = el('div', { class: 'field' });
    passInput.id = 'loginPassword';
    pWrap.appendChild(el('label', { for: 'loginPassword' }, 'Password'));
    pWrap.appendChild(passInput);
    panel.appendChild(pWrap);

    panel.appendChild(el('button', {
      class: 'primary',
      type: 'button',
      style: 'width:100%;',
      disabled: state.login.busy,
      onclick: signIn
    }, state.login.busy ? 'Signing in…' : 'Sign in'));

    app.appendChild(panel);
  }

  function errorBanner(message) {
    return el('div', { class: 'form-error', role: 'alert' }, message);
  }

  function renderNotStaff(app) {
    var panel = el('div', { class: 'panel login' });
    panel.appendChild(el('h2', {}, 'No Access'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'You are signed in, but this account is not on the hardware staff '
      + 'allowlist, so it cannot see distributor cost or change prices. Ask an '
      + 'administrator to add your user id to public.hardware_staff.'));
    panel.appendChild(el('button', {
      class: 'ghost', type: 'button', onclick: signOut
    }, 'Sign out'));
    app.appendChild(panel);
  }

  function renderTabs(app) {
    var tabs = el('div', { class: 'tabs' });
    TABS.forEach(function (t) {
      tabs.appendChild(el('button', {
        type: 'button',
        class: state.tab === t.key ? 'active' : '',
        onclick: function () {
          state.tab = t.key;
          state.message = null;
          if (t.key === 'orders' && !state.orders.length) loadOrders();
          else render();
        }
      }, t.label));
    });
    tabs.appendChild(el('span', { class: 'spacer', style: 'flex:1;' }));
    tabs.appendChild(el('button', { type: 'button', onclick: signOut }, 'Sign out'));
    app.appendChild(tabs);
  }

  function render() {
    var app = document.getElementById('app');
    if (!app) return;
    U.clear(app);

    var who = document.getElementById('whoami');
    if (who) {
      who.textContent = state.session && state.session.user
        ? state.session.user.email : 'Staff Console';
    }

    if (state.booting) {
      app.appendChild(el('div', { class: 'panel' },
        el('p', { class: 'muted' }, 'Loading…')));
      return;
    }
    if (!state.session) { renderLogin(app); return; }
    if (!state.staff) { renderNotStaff(app); return; }

    renderTabs(app);

    if (state.message) {
      app.appendChild(el('div', {
        class: 'notice ' + (state.message.kind === 'bad' ? 'bad' : 'good')
      }, state.message.text));
    }

    if (state.tab === 'pricing') renderPricing(app);
    else if (state.tab === 'costs') renderCosts(app);
    else if (state.tab === 'catalog') renderCatalogTab(app);
    else if (state.tab === 'orders') renderOrders(app);
    else renderSettings(app);
  }

  // Exposed for tests.
  window.__TOOLHOUND_ADMIN__ = {
    state: state,
    render: render,
    guessMapping: guessMapping,
    normalizeAvailability: normalizeAvailability,
    buildOfferRows: buildOfferRows,
    parseImportText: parseImportText,
    reload: loadAll
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
