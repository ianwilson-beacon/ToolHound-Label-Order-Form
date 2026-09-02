/**
 * Small DOM and formatting helpers shared by the hardware storefront
 * (hardware.js) and the staff pricing screen (admin.js).
 *
 * The label form (app.js) predates this file and keeps its own private copies;
 * it is left alone deliberately rather than refactored underneath a working
 * production form.
 */
(function () {
  'use strict';

  /**
   * Build an element. Attributes whose value is null, undefined or false are
   * skipped — setAttribute stringifies its argument, so passing null would set
   * the literal "null", and for boolean attributes it would mark the element
   * as set when the intent was the opposite.
   */
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
      else e.setAttribute(k, v);
    });
    var kids = children == null ? [] : (Array.isArray(children) ? children : [children]);
    kids.forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function clear(node) {
    if (node) node.innerHTML = '';
    return node;
  }

  /**
   * Money is carried as integer cents everywhere — database, wire, and UI —
   * so nothing rounds a price by accident on the way through a float.
   */
  function formatMoney(cents, currency) {
    if (cents === null || cents === undefined || isNaN(cents)) return '—';
    var value = cents / 100;
    try {
      return value.toLocaleString(undefined, {
        style: 'currency',
        currency: currency || 'CAD',
        currencyDisplay: 'narrowSymbol'
      });
    } catch (e) {
      return '$' + value.toFixed(2) + ' ' + (currency || '');
    }
  }

  /** Parse a typed dollar amount into integer cents. Returns null if unusable. */
  function parseMoneyToCents(text) {
    if (text === null || text === undefined) return null;
    var cleaned = String(text).replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    if (!/^-?\d*(\.\d{0,4})?$/.test(cleaned)) return null;
    var n = Number(cleaned);
    if (!isFinite(n)) return null;
    return Math.round(n * 100);
  }

  function toInt(text) {
    var cleaned = String(text === null || text === undefined ? '' : text).replace(/[\s,]/g, '');
    if (!/^\d+$/.test(cleaned)) return NaN;
    return parseInt(cleaned, 10);
  }

  function isEmail(text) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(text || '').trim());
  }

  function formatDateTime(value) {
    if (!value) return '—';
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '—';
    try {
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  /** "3 hours ago" style age, used to make a stale cost feed obvious at a glance. */
  function formatAge(value) {
    if (!value) return 'never';
    var then = new Date(value).getTime();
    if (isNaN(then)) return 'unknown';
    var mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + (mins === 1 ? ' min ago' : ' mins ago');
    var hours = Math.round(mins / 60);
    if (hours < 48) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    return Math.round(hours / 24) + ' days ago';
  }

  /**
   * RFC 4122 v4 identifier from the platform CSPRNG. The storefront generates
   * the order id client side so it can insert the order and its line items
   * without ever reading a row back — anon holds no SELECT policy.
   */
  function uuid() {
    var c = window.crypto || window.msCrypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var hex = [];
    for (var i = 0; i < 16; i++) hex.push((b[i] + 0x100).toString(16).slice(1));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-'
      + hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-'
      + hex.slice(10, 16).join('');
  }

  /**
   * Reference with a sortable timestamp and random tail. Collisions are
   * possible in principle, so callers retry on a unique violation.
   */
  function makeRef(prefix) {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    var bytes = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var rand = '';
    for (var i = 0; i < bytes.length; i++) rand += alphabet[bytes[i] % alphabet.length];
    return prefix + '-' + stamp + '-' + rand;
  }

  /**
   * Minimal RFC 4180 CSV parser: quoted fields, embedded commas, newlines and
   * doubled quotes. Distributor price files are plain CSV, but SKU
   * descriptions contain commas often enough that a split(',') import silently
   * shifts every column after the description.
   */
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var i = 0;
    var inQuotes = false;
    var src = String(text || '').replace(/^﻿/, '');

    function endField() { row.push(field); field = ''; }
    function endRow() { endField(); rows.push(row); row = []; }

    while (i < src.length) {
      var ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { endField(); i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { endRow(); i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length) endRow();

    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  window.THUI = {
    el: el,
    clear: clear,
    formatMoney: formatMoney,
    parseMoneyToCents: parseMoneyToCents,
    toInt: toInt,
    isEmail: isEmail,
    formatDateTime: formatDateTime,
    formatAge: formatAge,
    uuid: uuid,
    makeRef: makeRef,
    parseCsv: parseCsv
  };
})();
