/**
 * Internal, password-protected view of submitted label orders.
 *
 * Staff sign in with a Supabase Auth account created by an admin in the
 * Supabase dashboard (there is no public sign-up). Once signed in, the
 * `authenticated` role's SELECT policy on `label_orders` (see
 * supabase/migrations/0004_staff_read_access.sql) allows reading orders —
 * still with no INSERT/UPDATE/DELETE, and still no service-role key anywhere
 * in this client code.
 */
(function () {
  'use strict';

  var CONFIG = window.TOOLHOUND_CONFIG || {};
  var root = document.getElementById('admin');

  if (!window.supabase || !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
    root.innerHTML = '<div class="card"><div class="form-error" role="alert">'
      + 'The order system is not available right now. Please try again shortly.</div></div>';
    return;
  }
  var client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    var kids = children == null ? [] : (Array.isArray(children) ? children : [children]);
    kids.forEach(function (c) {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function renderLogin(message) {
    root.innerHTML = '';
    var card = el('div', { class: 'card admin-login' });
    card.appendChild(el('h2', { class: 'step-title' }, 'Staff Sign In'));
    if (message) card.appendChild(el('div', { class: 'form-error', role: 'alert' }, message));

    var emailInput = el('input', { type: 'email', placeholder: 'you@toolhound.com', autocomplete: 'username' });
    var passInput = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });

    var emailField = el('div', { class: 'field' }, [el('label', {}, 'Email'), emailInput]);
    var passField = el('div', { class: 'field' }, [el('label', {}, 'Password'), passInput]);
    card.appendChild(emailField);
    card.appendChild(passField);

    var btn = el('button', { class: 'primary', type: 'button' }, 'Sign In');
    btn.addEventListener('click', function () { doLogin(emailInput.value, passInput.value, btn); });
    passInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin(emailInput.value, passInput.value, btn);
    });
    card.appendChild(el('div', { class: 'actions', style: 'justify-content:flex-end;' }, [btn]));
    root.appendChild(card);
  }

  function doLogin(email, password, btn) {
    if (!email || !password) { renderLogin('Enter your email and password.'); return; }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    client.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
      if (res.error) { renderLogin(res.error.message || 'Sign in failed.'); return; }
      loadOrders();
    });
  }

  function renderOrders(rows) {
    root.innerHTML = '';
    var card = el('div', { class: 'card admin-orders' });
    var header = el('div', { class: 'admin-header' }, [
      el('h2', { class: 'step-title', style: 'margin:0;' }, 'Submitted Orders (' + rows.length + ')'),
      el('button', {
        class: 'ghost',
        type: 'button',
        onclick: function () { client.auth.signOut().then(renderLogin.bind(null, null)); }
      }, 'Sign Out')
    ]);
    card.appendChild(header);

    if (!rows.length) {
      card.appendChild(el('p', { class: 'hint' }, 'No orders yet.'));
    } else {
      var wrap = el('div', { class: 'table-scroll' });
      var table = el('table', { class: 'orders-table' });
      var headRow = el('tr', {}, [
        'Submitted', 'Reference', 'Company', 'Contact', 'Email', 'Logo/Text',
        'Color', 'Qty', 'Start #', 'Authorized By'
      ].map(function (h) { return el('th', {}, h); }));
      table.appendChild(el('thead', {}, headRow));

      var tbody = el('tbody');
      rows.forEach(function (o) {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, formatDate(o.submitted_at)),
          el('td', {}, o.order_ref),
          el('td', {}, o.company_name),
          el('td', {}, o.contact_name),
          el('td', {}, o.contact_email),
          el('td', {}, o.logo_choice),
          el('td', {}, o.full_color),
          el('td', {}, String(o.quantity)),
          el('td', {}, String(o.start_seq)),
          el('td', {}, o.authorized_name)
        ]));
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      card.appendChild(wrap);
    }
    root.appendChild(card);
  }

  function formatDate(v) {
    try {
      return new Date(v).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return v; }
  }

  function loadOrders() {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'card' }, el('p', { class: 'hint' }, 'Loading orders…')));
    client
      .from('label_orders')
      .select('order_ref, submitted_at, company_name, contact_name, contact_email, ' +
        'logo_choice, full_color, quantity, start_seq, authorized_name')
      .order('submitted_at', { ascending: false })
      .then(function (res) {
        if (res.error) { renderLogin('Could not load orders: ' + res.error.message); return; }
        renderOrders(res.data || []);
      });
  }

  client.auth.getSession().then(function (res) {
    if (res.data && res.data.session) loadOrders();
    else renderLogin(null);
  });
})();
