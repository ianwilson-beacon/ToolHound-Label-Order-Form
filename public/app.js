/**
 * ToolHound custom label order form.
 *
 * A four step wizard (customer details -> label spec -> review -> authorization)
 * that writes one row to `public.label_orders` in Supabase. Because a custom
 * label run is nonreturnable once approved, the final step captures an explicit
 * authorization and the confirmation screen doubles as a printable record of
 * exactly what was approved.
 *
 * No build step: this file is loaded directly by index.html.
 */
(function () {
  'use strict';

  var CONFIG = window.TOOLHOUND_CONFIG || {};

  var LOGO_CHOICES = [
    { value: 'custom_logo', label: 'Custom Logo' },
    { value: 'custom_text', label: 'Custom Text' },
    { value: 'toolhound_logo', label: 'ToolHound Logo' }
  ];

  var LOGO_CHOICE_LABELS = LOGO_CHOICES.reduce(function (acc, c) {
    acc[c.value] = c.label;
    return acc;
  }, {});

  /**
   * Artwork types the label press accepts. These must stay in sync with the
   * `label_orders_logo_data_shape` constraint in the database — a file whose
   * MIME type is missing or unrecognised produces a `data:;base64,` URL that
   * the constraint rejects, so it is caught here with a readable message
   * instead of surfacing as an opaque insert failure.
   */
  var ACCEPTED_LOGO_TYPES = {
    'image/png': 'PNG',
    'image/jpeg': 'JPG',
    'image/svg+xml': 'SVG',
    'application/pdf': 'PDF'
  };

  var MAX_TEXT_LINES = 3;
  var MAX_TEXT_LINE_CHARS = 10;
  var MAX_QUANTITY = 1000000;

  var STEP_TITLES = [
    'Customer & Shipping Information',
    'Label Specifications',
    'Review Your Order',
    'Customer Authorization'
  ];

  var state = {
    step: 0,
    submitting: false,
    submitError: '',
    orderRef: null,
    submittedAt: null,
    data: {
      companyName: '', contactName: '', contactEmail: '',
      address: '', city: '', stateProvince: '', postalCode: '', country: 'Canada',
      logoChoice: '', logoFileName: '', logoFileData: '',
      textLines: ['', '', ''],
      fullColor: '',
      quantity: '', startSeq: '', instructions: '',
      authorizedName: '', approvalDate: new Date().toISOString().slice(0, 10)
    }
  };

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  /**
   * Build an element. Attributes whose value is null or undefined are skipped:
   * setAttribute stringifies its argument, so passing null would set the
   * literal string "null" and, for boolean attributes such as `checked`, mark
   * the element as checked when the intent was the opposite.
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

  function fieldWrap(labelText, inputEl, hint, errText) {
    var wrap = el('div', { class: 'field' });
    var id = inputEl.id || ('f_' + Math.random().toString(36).slice(2, 9));
    inputEl.id = id;
    wrap.appendChild(el('label', { for: id }, labelText));
    wrap.appendChild(inputEl);
    var errMsg = el('div', { class: 'err-msg', role: 'alert' }, errText || 'Required');
    wrap.appendChild(errMsg);
    if (hint) wrap.appendChild(el('div', { class: 'hint' }, hint));
    inputEl._errMsg = errMsg;
    return wrap;
  }

  function textInput(value, oninput, type, placeholder, extra) {
    var attrs = {
      type: type || 'text',
      value: value,
      placeholder: placeholder || 'Type your answer here',
      oninput: function (e) { oninput(e.target.value); }
    };
    Object.keys(extra || {}).forEach(function (k) { attrs[k] = extra[k]; });
    return el('input', attrs);
  }

  /** Toggle a field's error state, with an optional specific message. */
  function markErr(inputEl, isErr, message) {
    if (!inputEl) return;
    if (inputEl.classList) inputEl.classList.toggle('err', !!isErr);
    if (inputEl._errMsg) {
      if (message) inputEl._errMsg.textContent = message;
      inputEl._errMsg.style.display = isErr ? 'block' : 'none';
    }
    if (inputEl.setAttribute) inputEl.setAttribute('aria-invalid', isErr ? 'true' : 'false');
  }

  /** Move focus to the first field showing an error, so the user sees it. */
  function focusFirstError(card) {
    var bad = card.querySelector('.err, [aria-invalid="true"]');
    if (bad && typeof bad.focus === 'function') bad.focus();
  }

  // ---------------------------------------------------------------------------
  // Radio groups
  //
  // Native <input type="radio"> inside a <label> gives correct keyboard
  // behaviour (arrow keys move within the group, space selects) and correct
  // screen reader semantics without any custom key handling.
  // ---------------------------------------------------------------------------

  function radioGroup(name, options, selected, onChange) {
    var group = el('div', { class: 'choice-group', role: 'radiogroup' });
    options.forEach(function (opt) {
      var input = el('input', {
        type: 'radio',
        name: name,
        value: opt.value,
        checked: selected === opt.value,
        onchange: function () {
          Array.prototype.forEach.call(
            group.querySelectorAll('.choice'),
            function (c) { c.classList.remove('selected'); }
          );
          label.classList.add('selected');
          onChange(opt.value);
        }
      });
      var label = el('label', {
        class: 'choice' + (selected === opt.value ? ' selected' : '')
      }, [input, el('span', { class: 'clabel' }, opt.label)]);
      group.appendChild(label);
    });
    return group;
  }

  function radioField(legend, name, options, selected, onChange, layoutClass) {
    var wrap = el('fieldset', {
      class: 'field',
      style: 'border:none;padding:0;margin:0 0 16px;'
    });
    wrap.appendChild(el('legend', {
      style: 'font-size:13px;font-weight:600;margin-bottom:6px;padding:0;'
    }, legend));
    var group = radioGroup(name, options, selected, onChange);
    if (layoutClass) group.className = layoutClass;
    wrap.appendChild(group);
    var errMsg = el('div', { class: 'err-msg', role: 'alert' }, 'Please choose one');
    wrap.appendChild(errMsg);
    wrap._errMsg = errMsg;
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  function isBlank(v) { return !v || !String(v).trim(); }

  function isEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim()); }

  /** Parse a field that must be a whole number; returns null when invalid. */
  function toInt(v) {
    var s = String(v == null ? '' : v).trim();
    if (!/^-?\d+$/.test(s)) return null;
    var n = parseInt(s, 10);
    return isNaN(n) ? null : n;
  }

  function endingSequence(d) {
    var start = toInt(d.startSeq);
    var qty = toInt(d.quantity);
    if (start === null || qty === null || qty < 1) return null;
    return start + qty - 1;
  }

  function filledTextLines(d) {
    return d.textLines.map(function (l) { return String(l || '').trim(); })
      .filter(function (l) { return l.length > 0; });
  }

  // ---------------------------------------------------------------------------
  // Step 1 — customer & shipping
  // ---------------------------------------------------------------------------

  function renderStep1(card) {
    var d = state.data;
    var inputs = {};

    function add(key, label, type, placeholder, container) {
      inputs[key] = textInput(d[key], function (v) { d[key] = v; }, type, placeholder);
      var f = fieldWrap(label, inputs[key]);
      (container || card).appendChild(f);
      return f;
    }

    add('companyName', 'Company Name *');
    add('contactName', 'Customer Contact Name *');
    add('contactEmail', 'Customer Contact Email *', 'email', 'name@example.com');
    add('address', 'Shipping Address *');

    var row = el('div', { class: 'row2' });
    add('city', 'City *', null, null, row);
    add('stateProvince', 'State / Province *', null, null, row);
    card.appendChild(row);

    var row2 = el('div', { class: 'row2' });
    add('postalCode', 'Postal / ZIP Code *', null, null, row2);
    add('country', 'Country *', null, null, row2);
    card.appendChild(row2);

    card.appendChild(actionBar(null, 'Continue', function () {
      var ok = true;
      ['companyName', 'contactName', 'contactEmail', 'address', 'city',
        'stateProvince', 'postalCode', 'country'].forEach(function (k) {
        var blank = isBlank(d[k]);
        if (k === 'contactEmail' && !blank && !isEmail(d[k])) {
          markErr(inputs[k], true, 'Enter a valid email address');
          ok = false;
          return;
        }
        markErr(inputs[k], blank, 'Required');
        if (blank) ok = false;
      });
      if (ok) go(1); else focusFirstError(card);
    }));
  }

  // ---------------------------------------------------------------------------
  // Step 2 — label specifications
  // ---------------------------------------------------------------------------

  function renderStep2(card) {
    var d = state.data;

    // The conditional artwork inputs live in their own host element so that
    // switching between logo choices does not rebuild — and therefore does not
    // blur or discard — the rest of the step.
    var conditional = el('div', {});
    var fileErr = el('div', { class: 'err-msg', role: 'alert' }, 'Please upload a logo file');
    var textErr = el('div', { class: 'err-msg', role: 'alert' },
      'Enter at least one line of text');

    var logoField = radioField('Logo / Text on Labels *', 'logoChoice', LOGO_CHOICES,
      d.logoChoice, function (v) {
        d.logoChoice = v;
        logoField._errMsg.style.display = 'none';
        renderConditional();
      });
    card.appendChild(logoField);
    card.appendChild(conditional);

    function renderConditional() {
      conditional.innerHTML = '';
      fileErr.style.display = 'none';
      textErr.style.display = 'none';
      if (d.logoChoice === 'custom_logo') renderLogoUpload();
      else if (d.logoChoice === 'custom_text') renderTextLines();
    }

    function renderLogoUpload() {
      var fw = el('div', { class: 'field' });
      fw.appendChild(el('label', {}, 'Upload customer logo file *'));

      var picker = el('label', {
        class: 'fileinput' + (d.logoFileName ? ' has-file' : ''),
        tabindex: '0',
        onkeydown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
        }
      }, [
        d.logoFileName ? ('Selected: ' + d.logoFileName)
          : ('Click to upload logo (PNG, JPG, SVG, or PDF, up to '
             + (CONFIG.maxLogoFileMb || 4) + 'MB)')
      ]);

      var input = el('input', {
        type: 'file',
        accept: '.png,.jpg,.jpeg,.svg,.pdf,image/png,image/jpeg,image/svg+xml,application/pdf',
        onchange: function (e) { handleLogoFile(e.target.files[0]); }
      });
      picker.appendChild(input);
      fw.appendChild(picker);
      fw.appendChild(fileErr);
      if (d.logoFileName) {
        fw.appendChild(el('div', { class: 'hint' },
          'Vector artwork (SVG or PDF) reproduces most cleanly at label size.'));
      }
      conditional.appendChild(fw);
    }

    function handleLogoFile(f) {
      if (!f) return;
      var maxMb = CONFIG.maxLogoFileMb || 4;
      if (!ACCEPTED_LOGO_TYPES[f.type]) {
        showFileError('That file type is not supported. Please upload a PNG, JPG, SVG, or PDF.');
        return;
      }
      if (f.size > maxMb * 1024 * 1024) {
        showFileError('That file is ' + (f.size / 1048576).toFixed(1)
          + 'MB. Please upload a file under ' + maxMb + 'MB.');
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        d.logoFileData = reader.result;
        d.logoFileName = f.name;
        renderConditional();
      };
      reader.onerror = function () {
        showFileError('That file could not be read. Please try another file.');
      };
      reader.readAsDataURL(f);
    }

    function showFileError(msg) {
      d.logoFileData = '';
      d.logoFileName = '';
      renderConditional();
      fileErr.textContent = msg;
      fileErr.style.display = 'block';
    }

    function renderTextLines() {
      var fw = el('div', { class: 'field' });
      fw.appendChild(el('label', {}, 'Text to print on the labels *'));
      var tl = el('div', { class: 'textlines' });
      for (var i = 0; i < MAX_TEXT_LINES; i++) {
        (function (idx) {
          tl.appendChild(el('input', {
            type: 'text',
            maxlength: String(MAX_TEXT_LINE_CHARS),
            placeholder: 'Line ' + (idx + 1)
              + (idx === 0 ? ' (required)' : ' (optional)'),
            value: d.textLines[idx],
            'aria-label': 'Text line ' + (idx + 1),
            oninput: function (e) {
              d.textLines[idx] = e.target.value;
              textErr.style.display = 'none';
            }
          }));
        })(i);
      }
      fw.appendChild(tl);
      fw.appendChild(textErr);
      fw.appendChild(el('div', { class: 'hint' },
        'Up to ' + MAX_TEXT_LINES + ' lines, maximum '
        + MAX_TEXT_LINE_CHARS + ' characters each.'));
      conditional.appendChild(fw);
    }

    renderConditional();

    var colorField = radioField('Should the logo be printed in full color? *', 'fullColor',
      [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }],
      d.fullColor, function (v) {
        d.fullColor = v;
        colorField._errMsg.style.display = 'none';
      }, 'yn');
    card.appendChild(colorField);

    var row = el('div', { class: 'row2' });
    var qtyInput = textInput(d.quantity, function (v) {
      d.quantity = v; updateSeqPreview();
    }, 'number', 'e.g. 500', { min: '1', step: '1' });
    row.appendChild(fieldWrap('Quantity *', qtyInput));

    var seqInput = textInput(d.startSeq, function (v) {
      d.startSeq = v; updateSeqPreview();
    }, 'number', 'e.g. 0', { min: '0', step: '1' });
    var seqField = fieldWrap('Starting Sequence # *', seqInput);
    row.appendChild(seqField);
    card.appendChild(row);

    // Spelling out the resulting range makes an off-by-one obvious before the
    // order becomes nonreturnable.
    var seqPreview = el('div', { class: 'seq-preview' });
    seqField.appendChild(seqPreview);

    function updateSeqPreview() {
      var end = endingSequence(d);
      if (end === null) { seqPreview.textContent = ''; return; }
      seqPreview.innerHTML = '';
      seqPreview.appendChild(document.createTextNode('This order will print labels '));
      seqPreview.appendChild(el('strong', {}, String(toInt(d.startSeq))));
      seqPreview.appendChild(document.createTextNode(' through '));
      seqPreview.appendChild(el('strong', {}, String(end)));
      seqPreview.appendChild(document.createTextNode('.'));
    }
    updateSeqPreview();

    var instr = el('textarea', { rows: '3', placeholder: 'Optional' });
    instr.value = d.instructions;
    instr.addEventListener('input', function (e) { d.instructions = e.target.value; });
    card.appendChild(fieldWrap('Special Instructions', instr));

    card.appendChild(actionBar(function () { go(0); }, 'Continue', function () {
      var ok = true;

      if (!d.logoChoice) {
        logoField._errMsg.style.display = 'block';
        ok = false;
      } else if (d.logoChoice === 'custom_logo' && !d.logoFileName) {
        fileErr.textContent = 'Please upload a logo file';
        fileErr.style.display = 'block';
        ok = false;
      } else if (d.logoChoice === 'custom_text' && filledTextLines(d).length === 0) {
        textErr.style.display = 'block';
        ok = false;
      }

      if (!d.fullColor) { colorField._errMsg.style.display = 'block'; ok = false; }

      var qty = toInt(d.quantity);
      if (qty === null) { markErr(qtyInput, true, 'Enter a quantity'); ok = false; }
      else if (qty < 1) { markErr(qtyInput, true, 'Quantity must be at least 1'); ok = false; }
      else if (qty > MAX_QUANTITY) {
        markErr(qtyInput, true, 'For orders above ' + MAX_QUANTITY.toLocaleString()
          + ' labels, please contact ToolHound directly');
        ok = false;
      } else markErr(qtyInput, false);

      var seq = toInt(d.startSeq);
      if (seq === null) { markErr(seqInput, true, 'Enter a starting sequence number'); ok = false; }
      else if (seq < 0) {
        markErr(seqInput, true, 'Starting sequence cannot be negative');
        ok = false;
      } else markErr(seqInput, false);

      if (ok) go(2); else focusFirstError(card);
    }));
  }

  // ---------------------------------------------------------------------------
  // Step 3 — review
  // ---------------------------------------------------------------------------

  function reviewRow(k, v) {
    return el('div', { class: 'review-row' }, [
      el('span', { class: 'k' }, k),
      el('span', { class: 'v' }, v == null || v === '' ? '—' : String(v))
    ]);
  }

  function reviewBlocks(d) {
    var blocks = [];

    var b1 = el('div', { class: 'review-block' });
    b1.appendChild(el('h3', {}, 'Customer & Shipping'));
    b1.appendChild(reviewRow('Company', d.companyName));
    b1.appendChild(reviewRow('Contact', d.contactName));
    b1.appendChild(reviewRow('Email', d.contactEmail));
    b1.appendChild(reviewRow('Address', [d.address, d.city,
      d.stateProvince + ' ' + d.postalCode, d.country].join(', ')));
    blocks.push(b1);

    var b2 = el('div', { class: 'review-block' });
    b2.appendChild(el('h3', {}, 'Label Specifications'));
    b2.appendChild(reviewRow('Logo / Text', LOGO_CHOICE_LABELS[d.logoChoice]));
    if (d.logoChoice === 'custom_logo') b2.appendChild(reviewRow('Logo File', d.logoFileName));
    if (d.logoChoice === 'custom_text') {
      b2.appendChild(reviewRow('Custom Text', filledTextLines(d).join(' / ')));
    }
    b2.appendChild(reviewRow('Full Color', d.fullColor));
    b2.appendChild(reviewRow('Quantity', d.quantity));
    b2.appendChild(reviewRow('Starting Sequence #', d.startSeq));
    var end = endingSequence(d);
    if (end !== null) {
      b2.appendChild(reviewRow('Sequence Range', toInt(d.startSeq) + ' – ' + end));
    }
    if (d.instructions) b2.appendChild(reviewRow('Special Instructions', d.instructions));
    blocks.push(b2);

    return blocks;
  }

  function renderStep3(card) {
    reviewBlocks(state.data).forEach(function (b) { card.appendChild(b); });
    card.appendChild(el('div', { class: 'hint', style: 'margin-bottom:18px;' },
      'If everything above looks correct, continue to authorization.'));
    card.appendChild(actionBar(function () { go(1); },
      'Continue to Authorization', function () { go(3); }));
  }

  // ---------------------------------------------------------------------------
  // Step 4 — authorization
  // ---------------------------------------------------------------------------

  var AUTH_TEXT =
    'I confirm that I have reviewed the label specifications provided above and '
    + 'that they are accurate. I authorize ToolHound to submit this custom label '
    + 'order for production based on these specifications. I understand that these '
    + 'labels are custom manufactured and cannot be returned once the approved '
    + 'order has been submitted for production.';

  function renderStep4(card) {
    var d = state.data;

    if (state.submitError) {
      card.appendChild(el('div', { class: 'form-error', role: 'alert' }, state.submitError));
    }

    card.appendChild(el('div', { class: 'authtext' }, AUTH_TEXT));

    var nameInput = textInput(d.authorizedName, function (v) { d.authorizedName = v; });
    card.appendChild(fieldWrap('Authorized Name *', nameInput));

    var dateInput = el('input', {
      type: 'date',
      value: d.approvalDate,
      oninput: function (e) { d.approvalDate = e.target.value; }
    });
    card.appendChild(fieldWrap('Approval Date *', dateInput));

    var cb = el('input', { type: 'checkbox', id: 'agreeCb' });
    var agreeWrap = el('div', { class: 'agree' }, [
      cb,
      el('label', { for: 'agreeCb' },
        'I have read and agree to the authorization statement above.')
    ]);
    card.appendChild(agreeWrap);
    var agreeErr = el('div', {
      class: 'err-msg',
      role: 'alert',
      style: 'margin-top:-10px;margin-bottom:14px;'
    }, 'Please check the box to continue');
    card.appendChild(agreeErr);

    var bar = actionBar(function () { go(2); }, 'Submit Order', function () {
      var ok = true;
      var blankName = isBlank(d.authorizedName);
      markErr(nameInput, blankName, 'Required');
      if (blankName) ok = false;

      markErr(dateInput, !d.approvalDate, 'Required');
      if (!d.approvalDate) ok = false;

      agreeErr.style.display = cb.checked ? 'none' : 'block';
      if (!cb.checked) ok = false;

      if (!ok) { focusFirstError(card); return; }
      submitOrder(bar._primary);
    });
    card.appendChild(bar);
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /**
   * Order references embed a timestamp for readability plus random entropy,
   * because two customers submitting inside the same millisecond would
   * otherwise collide on the table's unique index.
   */
  function makeOrderRef() {
    var stamp = Date.now().toString(36).toUpperCase();
    var rand = '';
    var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no easily confused glyphs
    // Six characters over a 31 character alphabet is ~887 million values per
    // millisecond. Four was measurably collision-prone when references are
    // generated in a tight loop, and the timestamp alone does not separate
    // two submissions landing in the same millisecond.
    var bytes = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i++) rand += alphabet[bytes[i] % alphabet.length];
    return 'THL-' + stamp + '-' + rand;
  }

  function buildRow(d, orderRef) {
    return {
      order_ref: orderRef,
      company_name: d.companyName.trim(),
      contact_name: d.contactName.trim(),
      contact_email: d.contactEmail.trim(),
      address: d.address.trim(),
      city: d.city.trim(),
      state_province: d.stateProvince.trim(),
      postal_code: d.postalCode.trim(),
      country: d.country.trim(),
      logo_choice: d.logoChoice,
      logo_file_name: d.logoFileName || null,
      logo_file_data: d.logoFileData || null,
      text_lines: d.logoChoice === 'custom_text' ? filledTextLines(d) : null,
      full_color: d.fullColor,
      quantity: toInt(d.quantity),
      start_seq: toInt(d.startSeq),
      instructions: d.instructions.trim() ? d.instructions.trim() : null,
      authorized_name: d.authorizedName.trim(),
      approval_date: d.approvalDate
    };
  }

  /**
   * Resolve the database client. Tests inject a stub via `window.__TOOLHOUND_DB__`
   * so the wizard can be exercised without network access.
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

  function submitOrder(button) {
    if (state.submitting) return;
    state.submitting = true;
    state.submitError = '';
    if (button) { button.disabled = true; button.textContent = 'Submitting…'; }

    var db = getDb();
    if (!db) {
      failSubmit('The order system is not available right now. Please contact '
        + 'ToolHound at ' + (CONFIG.supportPhone || 'the number above') + '.');
      return;
    }

    var attempt = 0;

    function tryInsert() {
      attempt++;
      var orderRef = makeOrderRef();
      var row = buildRow(state.data, orderRef);

      Promise.resolve(db.from('label_orders').insert(row)).then(function (res) {
        var error = res && res.error;
        if (!error) {
          state.submitting = false;
          state.orderRef = orderRef;
          state.submittedAt = new Date();
          go(4);
          return;
        }
        // A duplicate order reference is the one error worth retrying: the
        // reference is generated client side, so a fresh one may well succeed.
        if (error.code === '23505' && attempt < 3) { tryInsert(); return; }

        console.error('Supabase insert failed', error);
        if (error.code === '23514') {
          failSubmit('Some of the order details were rejected as invalid. Please '
            + 'go back and check the quantity, sequence number, and label text, '
            + 'then try again.');
        } else {
          failSubmit('Something went wrong submitting your order. Please try again, '
            + 'or contact ToolHound at '
            + (CONFIG.supportPhone || 'the number above') + '.');
        }
      }).catch(function (e) {
        console.error('Network error submitting order', e);
        failSubmit('Your order could not be sent. Please check your connection and '
          + 'try again.');
      });
    }

    function failSubmit(message) {
      state.submitting = false;
      state.submitError = message;
      render();
      var alertEl = document.querySelector('.form-error');
      if (alertEl && alertEl.scrollIntoView) alertEl.scrollIntoView({ block: 'center' });
    }

    tryInsert();
  }

  // ---------------------------------------------------------------------------
  // Step 5 — confirmation, and the printable authorization record
  // ---------------------------------------------------------------------------

  function renderStep5(card) {
    var d = state.data;

    // Screen view.
    var s = el('div', { class: 'success no-print' });
    s.appendChild(el('div', {
      class: 'check',
      html: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" '
        + 'aria-hidden="true"><path d="M4 12l5 5L20 6" stroke="currentColor" '
        + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    }));
    s.appendChild(el('h2', { class: 'step-title', style: 'margin-bottom:6px;' },
      'Order Submitted'));
    s.appendChild(el('p', {
      style: 'color:var(--ink-soft);font-size:14.5px;max-width:440px;margin:0 auto;'
    }, 'Your authorization has been recorded and your label order has been sent to '
      + 'ToolHound for production. Please keep your order reference for any '
      + 'follow-up.'));
    s.appendChild(el('div', { class: 'ref' }, 'Reference: ' + state.orderRef));
    s.appendChild(el('p', {
      style: 'color:var(--ink-soft);font-size:13px;max-width:440px;margin:10px auto 0;'
    }, 'Questions about this order? Call ToolHound at '
      + (CONFIG.supportPhone || '') + '.'));

    var buttons = el('div', { style: 'margin-top:22px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;' });
    buttons.appendChild(el('button', {
      class: 'primary',
      type: 'button',
      onclick: function () { window.print(); }
    }, 'Print / save a copy'));
    buttons.appendChild(el('button', {
      class: 'ghost',
      type: 'button',
      onclick: function () { window.location.reload(); }
    }, 'Submit another order'));
    s.appendChild(buttons);
    card.appendChild(s);

    // Print view: a standalone record of what was authorized. A custom run is
    // nonreturnable, so the customer keeps the specifications and the signed
    // authorization together on one page.
    var p = el('div', { class: 'print-only' });
    var header = el('div', { class: 'print-header' }, [
      el('img', { src: 'toolhound-logo.png', alt: 'ToolHound' }),
      el('div', { class: 'meta' }, [
        el('div', { style: 'font-weight:700;color:var(--ink);' },
          'Label Order Authorization'),
        el('div', {}, 'Reference: ' + state.orderRef),
        el('div', {}, 'Submitted: ' + formatTimestamp(state.submittedAt))
      ])
    ]);
    p.appendChild(header);
    reviewBlocks(d).forEach(function (b) { p.appendChild(b); });

    var auth = el('div', { class: 'review-block' });
    auth.appendChild(el('h3', {}, 'Authorization'));
    auth.appendChild(el('div', { class: 'authtext' }, AUTH_TEXT));
    auth.appendChild(reviewRow('Authorized By', d.authorizedName));
    auth.appendChild(reviewRow('Approval Date', d.approvalDate));
    p.appendChild(auth);

    p.appendChild(el('div', {
      style: 'margin-top:16px;font-size:11px;color:var(--ink-soft);'
    }, 'ToolHound · ' + (CONFIG.supportPhone || '')));
    card.appendChild(p);
  }

  function formatTimestamp(dt) {
    if (!dt) return '';
    try {
      return dt.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return dt.toISOString();
    }
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  function actionBar(onBack, primaryLabel, onPrimary) {
    var bar = el('div', { class: 'actions' });
    bar.appendChild(onBack
      ? el('button', { class: 'ghost', type: 'button', onclick: onBack }, 'Back')
      : el('span'));
    var primary = el('button', {
      class: 'primary',
      type: 'button',
      onclick: onPrimary
    }, primaryLabel);
    bar.appendChild(primary);
    bar._primary = primary;
    return bar;
  }

  function renderStepper(card) {
    var s = el('div', { class: 'stepper', 'aria-hidden': 'true' });
    for (var i = 0; i < 4; i++) {
      s.appendChild(el('div', {
        class: 'tag' + (i < state.step ? ' done' : i === state.step ? ' active' : '')
      }));
    }
    card.appendChild(s);
  }

  function go(step) {
    state.step = step;
    state.submitError = '';
    render();
    // Only scroll when the page is actually scrolled down, and jump rather than
    // animate: a smooth scroll on every step keeps the card moving under the
    // pointer, which makes the next control briefly unclickable.
    if (window.scrollTo && window.scrollY > 0) window.scrollTo(0, 0);
  }

  function render() {
    var card = document.getElementById('card');
    if (!card) return;
    card.innerHTML = '';

    if (state.step < 4) {
      renderStepper(card);
      card.appendChild(el('div', { class: 'step-label' },
        'Step ' + (state.step + 1) + ' of 4'));
      card.appendChild(el('h2', { class: 'step-title' }, STEP_TITLES[state.step]));
    }

    if (state.step === 0) renderStep1(card);
    else if (state.step === 1) renderStep2(card);
    else if (state.step === 2) renderStep3(card);
    else if (state.step === 3) renderStep4(card);
    else renderStep5(card);
  }

  // Exposed for tests.
  window.__TOOLHOUND_FORM__ = {
    state: state,
    render: render,
    makeOrderRef: makeOrderRef,
    buildRow: buildRow,
    endingSequence: endingSequence,
    toInt: toInt,
    isEmail: isEmail
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
