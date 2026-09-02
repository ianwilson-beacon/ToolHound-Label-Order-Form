/**
 * Shared Supabase stub for the hardware portal tests.
 *
 * Held as a string of browser source rather than a module, because it is
 * injected with page.addInitScript and therefore has to run in the page's own
 * world, before hardware.js or admin.js look for window.__TOOLHOUND_DB__.
 *
 * The stub imitates the shape of a PostgREST query builder rather than the
 * whole API: chainable filter methods returning `this`, and a thenable that
 * resolves to `{ data, error }` the way supabase-js does.
 */
const STUB_SOURCE = `
(function () {
  var fixtures = window.__FIXTURES__ || {};
  window.__CALLS__ = [];

  function log(entry) { window.__CALLS__.push(entry); }

  function resolveTable(table) {
    var override = fixtures.tables && fixtures.tables[table];
    if (typeof override === 'function') return override();
    if (override) return override;
    return { data: [], error: null };
  }

  function builder(table) {
    var self = {
      _table: table,
      _op: 'select',
      _payload: null,
      _options: null,
      _filters: []
    };

    ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike',
     'order', 'limit', 'range', 'select', 'single', 'maybeSingle'].forEach(function (name) {
      self[name] = function () {
        self._filters.push([name].concat(Array.prototype.slice.call(arguments)));
        return self;
      };
    });

    ['insert', 'upsert', 'update', 'delete'].forEach(function (name) {
      self[name] = function (payload, options) {
        self._op = name;
        self._payload = payload;
        self._options = options || null;
        return self;
      };
    });

    self.then = function (onFulfilled, onRejected) {
      var result;
      if (self._op === 'select') {
        result = resolveTable(table);
      } else {
        log({ table: table, op: self._op, payload: self._payload,
              options: self._options, filters: self._filters });
        var writes = fixtures.writes && fixtures.writes[table + '.' + self._op];
        result = typeof writes === 'function' ? writes(self._payload)
          : (writes || { data: null, error: null });
      }
      return Promise.resolve(result).then(onFulfilled, onRejected);
    };
    self.catch = function (onRejected) { return self.then(null, onRejected); };

    return self;
  }

  window.__TOOLHOUND_DB__ = {
    from: function (table) { return builder(table); },
    rpc: function (name, params) {
      log({ rpc: name, params: params });
      var impl = fixtures.rpc && fixtures.rpc[name];
      var value = typeof impl === 'function' ? impl(params) : impl;
      return Promise.resolve(
        value === undefined ? { data: null, error: null } : value);
    },
    auth: {
      getSession: function () {
        return Promise.resolve({
          data: { session: fixtures.session || null }, error: null
        });
      },
      signInWithPassword: function (creds) {
        log({ auth: 'signIn', email: creds.email });
        if (fixtures.signInError) {
          return Promise.resolve({ data: null, error: { message: fixtures.signInError } });
        }
        fixtures.session = fixtures.sessionAfterSignIn
          || { user: { id: 'u1', email: creds.email } };
        return Promise.resolve({ data: { session: fixtures.session }, error: null });
      },
      signOut: function () {
        fixtures.session = null;
        return Promise.resolve({ error: null });
      },
      onAuthStateChange: function () {
        return { data: { subscription: { unsubscribe: function () {} } } };
      }
    }
  };
})();
`;

/** Block the CDN and font requests so the suite needs no network at all. */
async function isolate(page) {
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
}

/** Install fixtures plus the stub, in that order, before any page script runs. */
async function installStub(page, fixtures) {
  await isolate(page);
  await page.addInitScript((f) => { window.__FIXTURES__ = f; }, fixtures || {});
  await page.addInitScript(STUB_SOURCE);
}

/** Everything the stub recorded: writes, rpc calls, sign-ins. */
function calls(page) {
  return page.evaluate(() => window.__CALLS__);
}

module.exports = { installStub, calls, isolate };
