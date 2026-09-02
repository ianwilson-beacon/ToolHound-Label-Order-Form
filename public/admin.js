/**
 * Internal, password-protected view of submitted label orders.
 *
 * Staff sign in one of three ways:
 *   - Google, restricted to @beaconsoftware.com
 *   - Microsoft, restricted to @toolhound.com
 *   - Email + password, for an account created by an admin in the Supabase
 *     dashboard (there is no public sign-up for this path)
 *
 * The domain restriction on the OAuth paths is enforced in the database — a
 * trigger on auth.users (see supabase/migrations/0005_oauth_domain_restriction.sql)
 * rejects account creation for any Google/Microsoft sign-in outside the
 * approved domain, so a client-side bypass can't grant access. This file also
 * checks the domain again after sign-in as a second line of defense and to
 * give a clear message quickly, but the database check is the real boundary.
 *
 * Once signed in, the `authenticated` role's SELECT policy on `label_orders`
 * (see supabase/migrations/0004_staff_read_access.sql) allows reading orders
 * — still with no INSERT/UPDATE/DELETE, and still no service-role key
 * anywhere in this client code.
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

  var OAUTH_DOMAINS = { google: 'beaconsoftware.com', azure: 'toolhound.com' };

  function emailDomain(email) {
    return String(email || '').split('@')[1] || '';
  }

  /** Belt-and-suspenders check: the real boundary is the database trigger. */
  function domainAllowedForSession(session) {
    var provider = session && session.user && session.user.app_metadata
      && session.user.app_metadata.provider;
    var required = OAUTH_DOMAINS[provider];
    if (!required) return true; // email/password accounts aren't domain-restricted here
    return emailDomain(session.user.email).toLowerCase() === required;
  }

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

    var oauthRow = el('div', { class: 'oauth-row' });
    oauthRow.appendChild(el('button', {
      type: 'button',
      class: 'oauth-btn',
      onclick: function () { doOAuthLogin('google'); }
    }, 'Continue with Google (@beaconsoftware.com)'));
    oauthRow.appendChild(el('button', {
      type: 'button',
      class: 'oauth-btn',
      onclick: function () { doOAuthLogin('azure'); }
    }, 'Continue with Microsoft (@toolhound.com)'));
    card.appendChild(oauthRow);

    card.appendChild(el('div', { class: 'oauth-divider' }, 'or sign in with a password'));

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
      // On success, the onAuthStateChange listener below takes it from here.
      if (res.error) { renderLogin(res.error.message || 'Sign in failed.'); }
    });
  }

  function doOAuthLogin(provider) {
    var opts = { redirectTo: window.location.origin + '/admin.html' };
    // Hints the provider's own account picker toward the right domain. This
    // is a convenience, not the security boundary — the database trigger is.
    if (provider === 'google') opts.queryParams = { hd: OAUTH_DOMAINS.google };
    else if (provider === 'azure') opts.queryParams = { domain_hint: OAUTH_DOMAINS.azure };
    client.auth.signInWithOAuth({ provider: provider, options: opts });
  }

  /** After any sign-in, confirm the domain before showing order data. */
  function checkDomainAndLoad(session) {
    if (!session) { renderLogin(null); return; }
    if (!domainAllowedForSession(session)) {
      var required = OAUTH_DOMAINS[session.user.app_metadata.provider];
      client.auth.signOut().then(function () {
        renderLogin('That account is not on an approved domain (' + required + '). Signed out.');
      });
      return;
    }
    loadOrders();
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

  /**
   * A rejected OAuth sign-in (wrong domain, caught by the database trigger)
   * comes back as `#error=...&error_description=...` on the redirect URL
   * rather than a promise rejection, since the failure happens after the
   * provider hands off to Supabase. Surface it, then drop it from the URL.
   */
  function oauthErrorFromUrl() {
    var hash = window.location.hash || '';
    if (hash.indexOf('error=') === -1) return null;
    var params = new URLSearchParams(hash.replace(/^#/, ''));
    var desc = params.get('error_description') || params.get('error');
    history.replaceState(null, '', window.location.pathname);
    return desc ? decodeURIComponent(desc.replace(/\+/g, ' ')) : 'Sign in failed.';
  }

  var urlError = oauthErrorFromUrl();
  if (urlError) {
    renderLogin(urlError);
  } else {
    client.auth.getSession().then(function (res) {
      checkDomainAndLoad(res.data && res.data.session);
    });
  }

  client.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_IN') checkDomainAndLoad(session);
  });
})();
