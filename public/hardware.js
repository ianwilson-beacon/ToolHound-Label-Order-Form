/**
 * ToolHound hardware order portal (customer facing).
 *
 * Reads the published catalog from `public.hardware_catalog` and files an order
 * as one row in `public.hardware_orders` plus a row per line in
 * `public.hardware_order_items`.
 *
 * Two things about this flow are worth knowing before changing it:
 *
 *  - The order id is generated here, not by the database. The anon key holds
 *    an INSERT-only policy with no SELECT, so there is no way to read back the
 *    id of a row we just wrote; generating it client side lets the line items
 *    reference the order in the same round trip.
 *
 *  - The prices this page sends are ignored. A trigger re-reads the published
 *    price for every line item server side. The numbers here are for the
 *    customer's benefit, not the invoice's, which is why a price that moved
 *    between page load and submit is caught at review rather than trusted.
 *
 * No build step: loaded directly by hardware.html after ui.js.
 */
(function () {
  'use strict';

  var U = window.THUI;
  var el = U.el;
  var CONFIG = window.TOOLHOUND_CONFIG || {};
  var HW = CONFIG.hardware || {};

  var MAX_LINE_QTY = 10000;
  var MAX_LINES = 40;

  var AUTH_TEXT = 'I authorize ToolHound to place this hardware order on my '
    + 'behalf. I understand these items are drop-shipped from ToolHound’s '
    + 'distributors, that the prices shown are current distributor-based pricing '
    + 'subject to final confirmation and stock availability, and that returns are '
    + 'governed by the manufacturer’s and distributor’s return policies. '
    + 'Freight, duties and applicable taxes are not included in the totals shown '
    + 'and will appear on the final invoice.';

  var CATALOG_COLUMNS = 'id,sku,name,category,short_description,long_description,'
    + 'image_url,spec,sort_order,price_cents,currency,lead_time_days,'
    + 'availability_label,ships_now';

  var STEPS = ['Select Hardware', 'Delivery & Contact', 'Review & Authorize'];

  var state = {
    step: 0,
    loading: true,
    loadError: '',
    products: [],
    /** product id -> quantity. Kept separate from products so a catalog
     *  refresh cannot silently drop what the customer picked. */
    cart: {},
    submitting: false,
    submitError: '',
    order: { id: null, ref: null, headerInserted: false },
    submittedAt: null,
    data: {
      companyName: '', contactName: '', contactEmail: '', contactPhone: '',
      address: '', city: '', stateProvince: '', postalCode: '', country: 'Canada',
      poNumber: '', notes: '',
      authorizedName: '', approvalDate: new Date().toISOString().slice(0, 10),
      agreed: false
    }
  };

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------

  /**
   * Resolve the database client. Tests inject a stub via
   * `window.__TOOLHOUND_DB__` so the portal can be exercised without network
   * access or credentials.
   */
  function getDb() {
    if (window.__TOOLHOUND_DB__) return window.__TOOLHOUND_DB__;
    if (!window.supabase || !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) return null;
    if (!getDb._client) {
      getDb._client = window.supabase.createClient(
        CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
    }
    return getDb._client;
  }

  function loadCatalog() {
    var db = getDb();
    if (!db) {
      state.loading = false;
      state.loadError = 'The hardware catalog is not available right now.';
      render();
      return;
    }

    Promise.resolve(
      db.from('hardware_catalog')
        .select(CATALOG_COLUMNS)
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
    ).then(function (res) {
      state.loading = false;
      if (res && res.error) {
        console.error('Catalog load failed', res.error);
        state.loadError = 'The hardware catalog could not be loaded.';
      } else {
        state.products = (res && res.data) || [];
      }
      render();
    }).catch(function (e) {
      console.error('Catalog load failed', e);
      state.loading = false;
      state.loadError = 'The hardware catalog could not be loaded.';
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // Cart
  // ---------------------------------------------------------------------------

  function productById(id) {
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) return state.products[i];
    }
    return null;
  }

  /** Cart entries paired with their catalog row, skipping anything delisted. */
  function cartLines() {
    return Object.keys(state.cart).map(function (id) {
      var p = productById(id);
      return p ? { product: p, quantity: state.cart[id] } : null;
    }).filter(Boolean);
  }

  function cartCurrency() {
    var lines = cartLines();
    return (lines.length && lines[0].product.currency) || HW.currency || 'CAD';
  }

  function cartSubtotalCents() {
    return cartLines().reduce(function (sum, line) {
      return sum + (line.product.price_cents || 0) * line.quantity;
    }, 0);
  }

  function cartUnitCount() {
    return cartLines().reduce(function (n, line) { return n + line.quantity; }, 0);
  }

  function setQty(productId, qty) {
    if (!qty || qty <= 0) {
      delete state.cart[productId];
    } else {
      state.cart[productId] = Math.min(qty, MAX_LINE_QTY);
    }
    render();
  }

  function addToCart(productId, qty) {
    var current = state.cart[productId] || 0;
    if (!current && Object.keys(state.cart).length >= MAX_LINES) {
      state.submitError = 'This order already has ' + MAX_LINES + ' different '
        + 'items. Please submit it and start another, or call us to place a '
        + 'larger order.';
      render();
      return;
    }
    setQty(productId, current + (qty || 1));
  }

  // ---------------------------------------------------------------------------
  // Rendering — shared bits
  // ---------------------------------------------------------------------------

  function fieldWrap(labelText, inputEl, hint, errText) {
    var wrap = el('div', { class: 'field' });
    var id = inputEl.id || ('h_' + Math.random().toString(36).slice(2, 9));
    inputEl.id = id;
    wrap.appendChild(el('label', { for: id }, labelText));
    wrap.appendChild(inputEl);
    var errMsg = el('div', { class: 'err-msg', role: 'alert' }, errText || 'Required');
    wrap.appendChild(errMsg);
    if (hint) wrap.appendChild(el('div', { class: 'hint' }, hint));
    inputEl._errMsg = errMsg;
    return wrap;
  }

  function textInput(value, oninput, opts) {
    var o = opts || {};
    var attrs = {
      type: o.type || 'text',
      value: value,
      placeholder: o.placeholder || 'Type your answer here',
      oninput: function (e) { oninput(e.target.value); }
    };
    Object.keys(o.extra || {}).forEach(function (k) { attrs[k] = o.extra[k]; });
    return el('input', attrs);
  }

  function markErr(inputEl, isErr, message) {
    if (!inputEl) return;
    if (inputEl.classList) inputEl.classList.toggle('err', !!isErr);
    if (inputEl._errMsg) {
      if (message) inputEl._errMsg.textContent = message;
      inputEl._errMsg.style.display = isErr ? 'block' : 'none';
    }
    if (inputEl.setAttribute) inputEl.setAttribute('aria-invalid', isErr ? 'true' : 'false');
  }

  function errorBanner(message) {
    return el('div', { class: 'form-error', role: 'alert' }, message);
  }

  /**
   * Green only for genuinely in stock. Limited stock is amber on purpose: the
   * number behind it is often two or three units, which is not the same
   * promise as "in stock" even though both can ship today.
   */
  function availabilityBadge(product) {
    var label = product.availability_label || 'Call to confirm';
    var cls = label === 'In stock' ? 'badge ok'
      : (label === 'Limited stock' || label === 'On backorder') ? 'badge warn'
      : 'badge';
    return el('span', { class: cls }, label);
  }

  function stepper() {
    var s = el('div', { class: 'stepper', 'aria-hidden': 'true' });
    for (var i = 0; i < STEPS.length; i++) {
      s.appendChild(el('div', {
        class: 'tag' + (i < state.step ? ' done' : i === state.step ? ' active' : '')
      }));
    }
    return s;
  }

  function actionBar(onBack, primaryLabel, onPrimary, primaryDisabled) {
    var bar = el('div', { class: 'actions' });
    bar.appendChild(onBack
      ? el('button', { class: 'ghost', type: 'button', onclick: onBack }, 'Back')
      : el('span'));
    bar.appendChild(el('button', {
      class: 'primary',
      type: 'button',
      disabled: !!primaryDisabled,
      onclick: onPrimary
    }, primaryLabel));
    return bar;
  }

  // ---------------------------------------------------------------------------
  // Step 1 — catalog and cart
  // ---------------------------------------------------------------------------

  function renderCatalog(app) {
    var shop = el('div', { class: 'shop' });
    shop.appendChild(renderProducts());
    shop.appendChild(renderCart());
    app.appendChild(shop);
  }

  function renderProducts() {
    var col = el('div', { class: 'panel' });
    col.appendChild(el('h2', {}, 'Hardware Catalog'));

    if (state.loading) {
      col.appendChild(el('p', { class: 'panel-note' }, 'Loading current pricing…'));
      return col;
    }
    if (state.loadError) {
      col.appendChild(errorBanner(state.loadError + ' Please try again, or call us at '
        + (CONFIG.supportPhone || 'the number above') + '.'));
      return col;
    }
    if (!state.products.length) {
      col.appendChild(el('p', { class: 'panel-note' },
        'No hardware is listed right now. Please call us at '
        + (CONFIG.supportPhone || 'the number above') + ' and we will quote you directly.'));
      return col;
    }

    col.appendChild(el('p', { class: 'panel-note' },
      'Pricing is reviewed against our distributors every business day. Add the '
      + 'quantities you need, then continue to delivery details.'));

    if (state.submitError && state.step === 0) col.appendChild(errorBanner(state.submitError));

    // Preserve the order the query returned: category, then sort_order, then name.
    var categories = [];
    var byCategory = {};
    state.products.forEach(function (p) {
      var key = p.category || 'Other';
      if (!byCategory[key]) { byCategory[key] = []; categories.push(key); }
      byCategory[key].push(p);
    });

    categories.forEach(function (cat) {
      var items = byCategory[cat];
      var head = el('div', { class: 'cat-head' }, [
        el('h3', {}, cat),
        el('span', { class: 'cat-count' },
          items.length + (items.length === 1 ? ' item' : ' items'))
      ]);
      col.appendChild(head);

      var grid = el('div', { class: 'prod-grid' });
      items.forEach(function (p) { grid.appendChild(productCard(p)); });
      col.appendChild(grid);
    });

    return col;
  }

  function productCard(p) {
    var card = el('div', { class: 'prod' });

    card.appendChild(p.image_url
      ? el('img', { class: 'prod-img', src: p.image_url, alt: p.name, loading: 'lazy' })
      : el('div', { class: 'prod-img prod-img-empty', 'aria-hidden': 'true' }, 'TH'));

    card.appendChild(el('div', { class: 'prod-sku' }, p.sku));
    card.appendChild(el('h4', {}, p.name));
    if (p.short_description) {
      card.appendChild(el('p', { class: 'prod-desc' }, p.short_description));
    }

    card.appendChild(el('div', { class: 'rowflex' }, [
      availabilityBadge(p),
      p.lead_time_days
        ? el('span', { class: 'muted' }, 'approx. ' + p.lead_time_days + ' day lead time')
        : null
    ]));

    card.appendChild(el('div', { class: 'prod-price' }, [
      U.formatMoney(p.price_cents, p.currency),
      el('small', {}, ' ' + (p.currency || 'CAD') + ' each')
    ]));

    var qtyInput = el('input', {
      type: 'text',
      inputmode: 'numeric',
      value: '1',
      'aria-label': 'Quantity of ' + p.name
    });
    card.appendChild(el('div', { class: 'prod-add' }, [
      qtyInput,
      el('button', {
        class: 'primary small',
        type: 'button',
        onclick: function () {
          var n = U.toInt(qtyInput.value);
          if (isNaN(n) || n <= 0) { qtyInput.classList.add('err'); qtyInput.focus(); return; }
          qtyInput.classList.remove('err');
          addToCart(p.id, n);
        }
      }, state.cart[p.id] ? 'Add more' : 'Add')
    ]));

    if (state.cart[p.id]) {
      card.appendChild(el('div', { class: 'muted' },
        state.cart[p.id] + ' in this order'));
    }

    return card;
  }

  function renderCart() {
    var panel = el('div', { class: 'panel cart-panel' });
    panel.appendChild(el('h2', {}, 'Your Order'));

    var lines = cartLines();
    if (!lines.length) {
      panel.appendChild(el('p', { class: 'cart-empty' },
        'Nothing added yet. Choose hardware from the catalog and it will appear here.'));
      return panel;
    }

    var list = el('ul', { class: 'cart-lines' });
    lines.forEach(function (line) {
      var p = line.product;
      var qtyInput = el('input', {
        type: 'text',
        inputmode: 'numeric',
        value: String(line.quantity),
        'aria-label': 'Quantity of ' + p.name,
        onchange: function (e) {
          var n = U.toInt(e.target.value);
          setQty(p.id, isNaN(n) ? 0 : n);
        }
      });

      list.appendChild(el('li', {}, [
        el('span', { class: 'cart-name' }, p.name),
        el('span', { class: 'num' },
          U.formatMoney((p.price_cents || 0) * line.quantity, p.currency)),
        el('span', { class: 'cart-meta' }, [
          qtyInput,
          el('span', {}, '× ' + U.formatMoney(p.price_cents, p.currency)),
          el('button', {
            class: 'linkbtn',
            type: 'button',
            onclick: function () { setQty(p.id, 0); }
          }, 'Remove')
        ])
      ]));
    });
    panel.appendChild(list);

    panel.appendChild(el('div', { class: 'cart-total' }, [
      el('span', {}, 'Subtotal'),
      el('span', {}, U.formatMoney(cartSubtotalCents(), cartCurrency()))
    ]));
    panel.appendChild(el('p', { class: 'cart-fine' },
      cartUnitCount() + ' unit' + (cartUnitCount() === 1 ? '' : 's') + '. Freight, '
      + 'duties and taxes are not included and will appear on your invoice.'));

    panel.appendChild(el('button', {
      class: 'primary',
      type: 'button',
      style: 'width:100%;',
      onclick: function () { go(1); }
    }, 'Continue'));

    return panel;
  }

  // ---------------------------------------------------------------------------
  // Step 2 — delivery and contact
  // ---------------------------------------------------------------------------

  function renderDetails(app) {
    var d = state.data;
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Delivery & Contact'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'Hardware ships direct from our distributor, so this is the address the '
      + 'boxes arrive at. A depot or receiving bay is fine.'));

    if (state.submitError) panel.appendChild(errorBanner(state.submitError));

    var f = {};
    function add(key, label, opts, hint) {
      var input = textInput(d[key], function (v) { d[key] = v; }, opts);
      f[key] = input;
      panel.appendChild(fieldWrap(label, input, hint,
        opts && opts.errText ? opts.errText : null));
      return input;
    }

    add('companyName', 'Company Name *');
    add('contactName', 'Contact Name *');
    add('contactEmail', 'Contact Email *', {
      type: 'email', placeholder: 'name@company.com',
      errText: 'Enter a valid email address'
    });
    add('contactPhone', 'Contact Phone', { type: 'tel', placeholder: 'Optional' });
    add('address', 'Shipping Address *');

    var row = el('div', { class: 'row2' });
    ['city', 'stateProvince'].forEach(function (key) {
      var input = textInput(d[key], function (v) { d[key] = v; }, {});
      f[key] = input;
      row.appendChild(fieldWrap(key === 'city' ? 'City *' : 'State / Province *', input));
    });
    panel.appendChild(row);

    var row2 = el('div', { class: 'row2' });
    ['postalCode', 'country'].forEach(function (key) {
      var input = textInput(d[key], function (v) { d[key] = v; }, {});
      f[key] = input;
      row2.appendChild(fieldWrap(
        key === 'postalCode' ? 'Postal / ZIP Code *' : 'Country *', input));
    });
    panel.appendChild(row2);

    add('poNumber', 'Your PO Number', { placeholder: 'Optional' },
      'Included on the invoice if your accounts team needs it.');

    var notes = el('textarea', {
      rows: '3',
      placeholder: 'Optional — configuration notes, delivery window, receiving contact',
      oninput: function (e) { d.notes = e.target.value; }
    });
    notes.value = d.notes;
    f.notes = notes;
    panel.appendChild(fieldWrap('Notes', notes));

    var bar = actionBar(function () { go(0); }, 'Continue', function () {
      if (validateDetails(f)) go(2);
      else focusFirstError(panel);
    });
    panel.appendChild(bar);
    app.appendChild(panel);
  }

  function validateDetails(f) {
    var d = state.data;
    var ok = true;
    var required = ['companyName', 'contactName', 'address', 'city',
      'stateProvince', 'postalCode', 'country'];

    required.forEach(function (key) {
      var bad = !String(d[key] || '').trim();
      markErr(f[key], bad);
      if (bad) ok = false;
    });

    var emailBad = !U.isEmail(d.contactEmail);
    markErr(f.contactEmail, emailBad,
      String(d.contactEmail || '').trim() ? 'Enter a valid email address' : 'Required');
    if (emailBad) ok = false;

    return ok;
  }

  function focusFirstError(node) {
    var bad = node.querySelector('.err, [aria-invalid="true"]');
    if (bad && typeof bad.focus === 'function') bad.focus();
  }

  // ---------------------------------------------------------------------------
  // Step 3 — review and authorize
  // ---------------------------------------------------------------------------

  function reviewRow(label, value) {
    return el('div', { class: 'review-row' }, [
      el('span', {}, label),
      el('strong', {}, value == null || value === '' ? '—' : String(value))
    ]);
  }

  function lineItemsTable() {
    var lines = cartLines();
    var currency = cartCurrency();
    var table = el('table', { class: 'grid' });
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', {}, 'Item'),
      el('th', { class: 'num' }, 'Qty'),
      el('th', { class: 'num' }, 'Unit'),
      el('th', { class: 'num' }, 'Line total')
    ])));
    var body = el('tbody', {});
    lines.forEach(function (line) {
      var p = line.product;
      body.appendChild(el('tr', {}, [
        el('td', { class: 'wrap' }, [
          el('div', {}, p.name),
          el('div', { class: 'prod-sku' }, p.sku)
        ]),
        el('td', { class: 'num' }, String(line.quantity)),
        el('td', { class: 'num' }, U.formatMoney(p.price_cents, p.currency)),
        el('td', { class: 'num' },
          U.formatMoney((p.price_cents || 0) * line.quantity, p.currency))
      ]));
    });
    table.appendChild(body);
    table.appendChild(el('tfoot', {}, el('tr', {}, [
      el('td', { colspan: '3' }, 'Subtotal (excl. freight, duties and tax)'),
      el('td', { class: 'num' }, el('strong', {},
        U.formatMoney(cartSubtotalCents(), currency)))
    ])));
    return el('div', { class: 'tbl-scroll' }, table);
  }

  function shippingBlock() {
    var d = state.data;
    var block = el('div', { class: 'review-block' });
    block.appendChild(el('h3', {}, 'Delivery & Contact'));
    block.appendChild(reviewRow('Company', d.companyName));
    block.appendChild(reviewRow('Contact', d.contactName));
    block.appendChild(reviewRow('Email', d.contactEmail));
    if (d.contactPhone) block.appendChild(reviewRow('Phone', d.contactPhone));
    block.appendChild(reviewRow('Ship To', [d.address, d.city, d.stateProvince,
      d.postalCode, d.country].filter(Boolean).join(', ')));
    if (d.poNumber) block.appendChild(reviewRow('PO Number', d.poNumber));
    if (d.notes) block.appendChild(reviewRow('Notes', d.notes));
    return block;
  }

  function renderReview(app) {
    var d = state.data;
    var panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', {}, 'Review & Authorize'));
    panel.appendChild(el('p', { class: 'panel-note' },
      'Check the quantities and the delivery address. Once you authorize, we '
      + 'place the order with our distributor.'));

    if (state.submitError) panel.appendChild(errorBanner(state.submitError));

    var items = el('div', { class: 'review-block' });
    items.appendChild(el('h3', {}, 'Hardware'));
    items.appendChild(lineItemsTable());
    panel.appendChild(items);
    panel.appendChild(shippingBlock());

    var auth = el('div', { class: 'review-block' });
    auth.appendChild(el('h3', {}, 'Authorization'));
    auth.appendChild(el('div', { class: 'authtext' }, AUTH_TEXT));

    var nameInput = textInput(d.authorizedName, function (v) { d.authorizedName = v; }, {
      placeholder: 'Your full name'
    });
    auth.appendChild(fieldWrap('Authorized Name *', nameInput));

    var dateInput = textInput(d.approvalDate, function (v) { d.approvalDate = v; }, {
      type: 'date'
    });
    auth.appendChild(fieldWrap('Approval Date *', dateInput));

    var agreeBox = el('input', {
      type: 'checkbox',
      checked: d.agreed,
      onchange: function (e) { d.agreed = e.target.checked; }
    });
    var agreeId = 'hwAgree';
    agreeBox.id = agreeId;
    var agree = el('div', { class: 'agree' }, [
      agreeBox,
      el('label', { for: agreeId },
        'I have read and agree to the authorization above.')
    ]);
    var agreeErr = el('div', { class: 'err-msg', role: 'alert' },
      'Please confirm you agree before submitting.');
    agree.appendChild(agreeErr);
    agreeBox._errMsg = agreeErr;
    auth.appendChild(agree);
    panel.appendChild(auth);

    var bar = actionBar(function () { go(1); },
      state.submitting ? 'Submitting…' : 'Submit order',
      function (e) {
        var ok = true;
        var nameBad = !String(d.authorizedName || '').trim();
        markErr(nameInput, nameBad);
        if (nameBad) ok = false;
        var dateBad = !/^\d{4}-\d{2}-\d{2}$/.test(String(d.approvalDate || ''));
        markErr(dateInput, dateBad, 'Enter a valid date');
        if (dateBad) ok = false;
        markErr(agreeBox, !d.agreed);
        if (!d.agreed) ok = false;
        if (!cartLines().length) {
          state.submitError = 'Your order is empty. Please add hardware first.';
          render();
          return;
        }
        if (!ok) { focusFirstError(panel); return; }
        submitOrder(e && e.target);
      }, state.submitting);
    panel.appendChild(bar);

    app.appendChild(panel);
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  function orderRow() {
    var d = state.data;
    return {
      id: state.order.id,
      order_ref: state.order.ref,
      company_name: d.companyName.trim(),
      contact_name: d.contactName.trim(),
      contact_email: d.contactEmail.trim(),
      contact_phone: d.contactPhone.trim() || null,
      address: d.address.trim(),
      city: d.city.trim(),
      state_province: d.stateProvince.trim(),
      postal_code: d.postalCode.trim(),
      country: d.country.trim(),
      po_number: d.poNumber.trim() || null,
      notes: d.notes.trim() || null,
      authorized_name: d.authorizedName.trim(),
      approval_date: d.approvalDate
    };
  }

  /**
   * Line item rows. sku, name, unit_price_cents and currency are sent so the
   * customer's own record matches what they saw, but the database trigger
   * overwrites all four from the published catalog — a forged price here has
   * no effect on the invoice.
   */
  function itemRows() {
    return cartLines().map(function (line) {
      var p = line.product;
      return {
        order_id: state.order.id,
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        quantity: line.quantity,
        unit_price_cents: p.price_cents,
        currency: p.currency
      };
    });
  }

  function submitOrder(button) {
    if (state.submitting) return;
    state.submitting = true;
    state.submitError = '';
    if (button) { button.disabled = true; button.textContent = 'Submitting…'; }

    var db = getDb();
    if (!db) {
      failSubmit('The order system is not available right now. Please call us at '
        + (CONFIG.supportPhone || 'the number above') + '.');
      return;
    }

    // Reuse the identifiers across retries. A retry after a failed line-item
    // insert must land on the same order, not open a second one.
    if (!state.order.id) state.order.id = U.uuid();
    if (!state.order.ref) state.order.ref = U.makeRef('THH');

    insertHeader()
      .then(insertItems)
      .then(function () {
        state.submitting = false;
        state.submittedAt = new Date();
        go(3);
      })
      .catch(function (err) {
        console.error('Hardware order submission failed', err);
        failSubmit(messageForError(err));
      });

    function insertHeader() {
      if (state.order.headerInserted) return Promise.resolve();
      return Promise.resolve(db.from('hardware_orders').insert(orderRow()))
        .then(function (res) {
          var error = res && res.error;
          // A duplicate here means our own earlier attempt already wrote the
          // header and only the line items failed. Carry on to those.
          if (error && error.code === '23505') {
            state.order.headerInserted = true;
            return;
          }
          if (error) throw error;
          state.order.headerInserted = true;
        });
    }

    function insertItems() {
      return Promise.resolve(db.from('hardware_order_items').insert(itemRows()))
        .then(function (res) {
          var error = res && res.error;
          // Retrying an order whose items already landed: the (order_id,
          // product_id) unique constraint says the work is done.
          if (error && error.code === '23505') return;
          if (error) throw error;
        });
    }

    function failSubmit(message) {
      state.submitting = false;
      state.submitError = message;
      render();
      var alertEl = document.querySelector('.form-error');
      if (alertEl && alertEl.scrollIntoView) alertEl.scrollIntoView({ block: 'center' });
    }
  }

  function messageForError(error) {
    var code = error && error.code;
    if (code === '23514') {
      // The line-item trigger raises check_violation when a product is no
      // longer published — usually a price refresh landed mid-session.
      return 'One of the items in your order is no longer available at the '
        + 'price shown. Please go back, remove it, and add it again with '
        + 'current pricing, or call us at '
        + (CONFIG.supportPhone || 'the number above') + '.';
    }
    if (code === '42501' || code === 'PGRST301') {
      return 'Your order could not be accepted. Please call us at '
        + (CONFIG.supportPhone || 'the number above') + ' and we will place it for you.';
    }
    return 'Something went wrong submitting your order. Please try again, or call '
      + 'us at ' + (CONFIG.supportPhone || 'the number above') + '.';
  }

  // ---------------------------------------------------------------------------
  // Step 4 — confirmation and the printable record
  // ---------------------------------------------------------------------------

  function renderDone(app) {
    var d = state.data;

    var s = el('div', { class: 'panel success no-print' });
    s.appendChild(el('div', {
      class: 'check',
      html: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" '
        + 'aria-hidden="true"><path d="M4 12l5 5L20 6" stroke="currentColor" '
        + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    }));
    s.appendChild(el('h2', { class: 'step-title', style: 'margin-bottom:6px;' },
      'Order Submitted'));
    s.appendChild(el('p', {
      style: 'color:var(--ink-soft);font-size:14.5px;max-width:460px;margin:0 auto;'
    }, 'Your hardware order has been sent to ToolHound. We confirm stock and '
      + 'freight with our distributor and come back to you with shipping '
      + 'details. Please keep your order reference for any follow-up.'));
    s.appendChild(el('div', { class: 'ref' }, 'Reference: ' + state.order.ref));
    s.appendChild(el('p', {
      style: 'color:var(--ink-soft);font-size:13px;max-width:460px;margin:10px auto 0;'
    }, 'Questions about this order? Call ToolHound at '
      + (CONFIG.supportPhone || '') + '.'));

    s.appendChild(el('div', {
      style: 'margin-top:22px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;'
    }, [
      el('button', {
        class: 'primary', type: 'button', onclick: function () { window.print(); }
      }, 'Print / save a copy'),
      el('button', {
        class: 'ghost', type: 'button', onclick: function () { window.location.reload(); }
      }, 'Place another order')
    ]));
    app.appendChild(s);

    // Print view: a standalone record of what was ordered and authorized.
    var p = el('div', { class: 'print-only' });
    p.appendChild(el('div', { class: 'print-header' }, [
      el('img', { src: 'toolhound-logo.png', alt: 'ToolHound' }),
      el('div', { class: 'meta' }, [
        el('div', { style: 'font-weight:700;color:var(--ink);' },
          'Hardware Order Authorization'),
        el('div', {}, 'Reference: ' + state.order.ref),
        el('div', {}, 'Submitted: ' + U.formatDateTime(state.submittedAt))
      ])
    ]));

    var items = el('div', { class: 'review-block' });
    items.appendChild(el('h3', {}, 'Hardware'));
    items.appendChild(lineItemsTable());
    p.appendChild(items);
    p.appendChild(shippingBlock());

    var auth = el('div', { class: 'review-block' });
    auth.appendChild(el('h3', {}, 'Authorization'));
    auth.appendChild(el('div', { class: 'authtext' }, AUTH_TEXT));
    auth.appendChild(reviewRow('Authorized By', d.authorizedName));
    auth.appendChild(reviewRow('Approval Date', d.approvalDate));
    p.appendChild(auth);

    p.appendChild(el('div', {
      style: 'margin-top:16px;font-size:11px;color:var(--ink-soft);'
    }, 'ToolHound · ' + (CONFIG.supportPhone || '')));
    app.appendChild(p);
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  function go(step) {
    state.step = step;
    state.submitError = '';
    render();
    if (window.scrollTo && window.scrollY > 0) window.scrollTo(0, 0);
  }

  function render() {
    var app = document.getElementById('app');
    if (!app) return;
    U.clear(app);

    if (state.step < 3) {
      var head = el('div', { class: 'no-print' });
      head.appendChild(stepper());
      head.appendChild(el('div', { class: 'step-label' },
        'Step ' + (state.step + 1) + ' of ' + STEPS.length + ' · ' + STEPS[state.step]));
      app.appendChild(head);
    }

    if (state.step === 0) renderCatalog(app);
    else if (state.step === 1) renderDetails(app);
    else if (state.step === 2) renderReview(app);
    else renderDone(app);
  }

  // Exposed for tests.
  window.__TOOLHOUND_HARDWARE__ = {
    state: state,
    render: render,
    reload: loadCatalog,
    cartLines: cartLines,
    cartSubtotalCents: cartSubtotalCents,
    orderRow: orderRow,
    itemRows: itemRows
  };

  function start() {
    render();
    loadCatalog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
