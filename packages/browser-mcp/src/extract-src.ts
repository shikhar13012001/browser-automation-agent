// In-page extraction script, kept as a plain-JS string on purpose: tsx/esbuild can inject helpers
// (e.g. __name) into compiled functions, which then fail with "not defined" when puppeteer
// serialises them into the page. A string is evaluated verbatim.
//
// It builds the compact "semantic tree": only elements a user can act on, each with a resolved
// human label, current value, flags and the section it sits under, plus blocking dialogs and
// visible error messages. Ids are stable for an element's lifetime (kept in a per-window
// registry), and `gen` changes on every new document so stale ids from a previous page are
// rejected instead of silently hitting a different element.
export const EXTRACT_SRC = String.raw`
(function (opts) {
  var W = window;
  if (!W.__ib || W.__ib.doc !== document) {
    W.__ib = { doc: document, byId: new Map(), byEl: new WeakMap(), next: 1, gen: Math.random().toString(36).slice(2, 10) };
  }
  var reg = W.__ib;
  var INTERACTIVE_ROLES = { button:1, link:1, checkbox:1, radio:1, combobox:1, option:1, menuitem:1, menuitemcheckbox:1,
    menuitemradio:1, tab:1, "switch":1, textbox:1, searchbox:1, listbox:1, slider:1, spinbutton:1, treeitem:1 };
  var CHROME_SEL = "nav,footer,header,[role=navigation],[role=contentinfo],[role=banner]";
  var DIALOG_SEL = "[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true]";
  var POPUP_SEL = DIALOG_SEL + ",[role=menu],[role=listbox],[data-radix-popper-content-wrapper]";
  var POINTER_TAGS = { div:1, span:1, li:1, img:1, p:1, td:1, label:1, i:1, figure:1 };
  var cursorCache = new WeakMap();
  function cursorOf(el) {
    if (!el || el.nodeType !== 1) return "";
    var c = cursorCache.get(el);
    if (c === undefined) { c = getComputedStyle(el).cursor; cursorCache.set(el, c); }
    return c;
  }
  // Code editors (Monaco, CodeMirror 5, Ace) type through a hidden, 1px-tall textarea.
  function editorOf(el) {
    return el.closest(".monaco-editor,.CodeMirror,.cm-editor,.ace_editor");
  }
  // The editor's real text via its API; the rendered lines include soft wraps, so they're a fallback.
  function editorCode(ed) {
    try {
      if (W.monaco && W.monaco.editor && W.monaco.editor.getEditors) {
        var eds = W.monaco.editor.getEditors();
        for (var mi = 0; mi < eds.length; mi++) if (eds[mi].getContainerDomNode().contains(ed) || ed.contains(eds[mi].getContainerDomNode())) return eds[mi].getModel().getValue();
      }
      if (ed.CodeMirror) return ed.CodeMirror.getValue();
      var cm6 = ed.querySelector(".cm-content");
      if (cm6 && cm6.cmView && cm6.cmView.view) return cm6.cmView.view.state.doc.toString();
      if (W.ace && ed.classList.contains("ace_editor")) return W.ace.edit(ed).getValue();
    } catch (e) {}
    var lines = ed.querySelector(".view-lines,.CodeMirror-code,.ace_text-layer");
    return lines ? (lines.innerText || "").replace(/\u00a0/g, " ") : "";
  }

  function clean(s, max) {
    s = (s || "").replace(/\s+/g, " ").trim();
    if (max && s.length > max) s = s.slice(0, max - 1) + "…";
    return s;
  }
  function textOf(el) { return clean(el.innerText || el.textContent || ""); }
  // Label text without the text of controls nested inside it -- otherwise a <label> wrapping a
  // <select> reads "Time 09:00 09:15 09:30 …" and a phone field reads "Phone Afghanistan Albania …".
  var CONTROL_SEL = "select,option,input,textarea,button,[role=listbox],[role=option],[role=combobox],[role=menu]";
  function labelText(label) {
    var out = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out.push(c.nodeValue);
        else if (c.nodeType === 1 && !c.matches(CONTROL_SEL)) walk(c);
      }
    })(label);
    return clean(out.join(" "), 120);
  }
  // A dialog only blocks the page when it is modal or covers a large part of the viewport; small
  // role=dialog widgets (chat bubbles, toasts) must not hide the page behind them.
  function isBlocking(d) {
    if (d.getAttribute("aria-modal") === "true") return true;
    try { if (d.matches("dialog:modal")) return true; } catch (e) {}
    var r = d.getBoundingClientRect();
    return r.width * r.height >= 0.25 * innerWidth * innerHeight;
  }
  function byIds(root, ids) {
    return clean(ids.split(/\s+/).map(function (id) {
      var n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      return n ? textOf(n) : "";
    }).join(" "));
  }
  function rootOf(el) { var r = el.getRootNode(); return r && r.getElementById ? r : document; }
  function visible(el) {
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function roleOf(el) { return (el.getAttribute("role") || "").toLowerCase(); }

  function kindOf(el) {
    var tag = el.tagName.toLowerCase(), role = roleOf(el);
    if (tag === "input") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden") return null;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "file") return "file";
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (role === "combobox" || el.getAttribute("list") || el.getAttribute("aria-autocomplete")) return "combobox";
      return "textbox";
    }
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    if (tag === "button") return role === "combobox" ? "combobox" : role === "tab" ? "tab" : role === "switch" ? "switch" : "button";
    if (tag === "a" && el.hasAttribute("href")) return role === "button" ? "button" : role === "tab" ? "tab" : "link";
    if (tag === "summary") return "button";
    if (role && INTERACTIVE_ROLES[role]) return role === "searchbox" ? "textbox" : role;
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    if (el.hasAttribute("onclick") || /\bclick:/.test(el.getAttribute("jsaction") || "")) return "button";
    return null;
  }

  function labelOf(el, kind) {
    var root = rootOf(el), a = el.getAttribute("aria-labelledby");
    if (a) { var t = byIds(root, a); if (t) return t; }
    var al = el.getAttribute("aria-label"); if (al && al.trim()) return clean(al, 120);
    var isField = kind === "textbox" || kind === "textarea" || kind === "select" || kind === "combobox" ||
      kind === "checkbox" || kind === "radio" || kind === "file" || kind === "switch" || kind === "slider" || kind === "spinbutton";
    // A div/span with role=radio|checkbox|option carries its own label as text (radio cards,
    // custom checkboxes); looking at preceding text would label it with its neighbour's words.
    var native = /^(input|select|textarea)$/.test(el.tagName.toLowerCase());
    if (isField && !native && (kind === "radio" || kind === "checkbox" || kind === "option")) {
      var own = textOf(el); if (own) return clean(own, 120);
    }
    if (isField) {
      if (el.id) {
        try { var l = root.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) { var lt = labelText(l); if (lt) return lt; } } catch (e) {}
      }
      var wrap = el.closest("label"); if (wrap) { var wt = labelText(wrap); if (wt) return wt; }
      if (el.getAttribute("placeholder")) return clean(el.getAttribute("placeholder"), 120);
      if (el.title) return clean(el.title, 120);
      // Nearest preceding text in the same row/container (common in un-labelled forms).
      var p = el.parentElement;
      for (var i = 0; p && i < 3; i++, p = p.parentElement) {
        var prev = el.previousElementSibling || null, cur = el;
        while (!prev && cur.parentElement && cur.parentElement !== p) { cur = cur.parentElement; prev = cur.previousElementSibling; }
        if (prev) { var pt = textOf(prev); if (pt && pt.length < 120) return pt; }
      }
      if (el.getAttribute("name")) return el.getAttribute("name");
      return "";
    }
    var txt = textOf(el);
    if (txt) return clean(txt, 100);
    if (el.title) return clean(el.title, 100);
    var img = el.querySelector && el.querySelector("img[alt]"); if (img && img.alt) return clean(img.alt, 100);
    if (el.value && typeof el.value === "string") return clean(el.value, 100);
    return "";
  }

  function groupOf(el) {
    var fs = el.closest("fieldset");
    if (fs) { var lg = fs.querySelector("legend"); if (lg && textOf(lg)) return clean(textOf(lg), 120); }
    var g = el.closest("[role=radiogroup],[role=group]");
    if (g) {
      var lb = g.getAttribute("aria-labelledby"); if (lb) { var t = byIds(rootOf(g), lb); if (t) return clean(t, 120); }
      if (g.getAttribute("aria-label")) return clean(g.getAttribute("aria-label"), 120);
    }
    return el.getAttribute("name") || "";
  }

  function hintOf(el) {
    var ids = (el.getAttribute("aria-errormessage") || "") + " " + (el.getAttribute("aria-describedby") || "");
    ids = ids.trim();
    return ids ? clean(byIds(rootOf(el), ids), 140) : "";
  }

  var items = [], headings = [], errors = [], messages = [], dialogs = [], blockers = [], popups = [], popupNames = [], included = new Set(), chromeCount = 0;
  var section = "";
  var stack = [document.documentElement];
  var MAX_ITEMS = opts.all ? 1500 : 400;

  while (stack.length) {
    var el = stack.pop();
    if (!el || el.nodeType !== 1) continue;
    var tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "svg") continue;

    // Children first-in-last-out so traversal stays in document order.
    var kids = el.shadowRoot ? Array.prototype.slice.call(el.shadowRoot.children).concat(Array.prototype.slice.call(el.children)) : el.children;
    for (var k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);

    if (/^h[1-4]$/.test(tag) || roleOf(el) === "heading" || tag === "legend") {
      if (visible(el)) { var ht = clean(textOf(el), 100); if (ht) { section = ht; if (headings.length < 40) headings.push(ht); } }
      continue;
    }
    var r = roleOf(el);
    if (r === "alert" || el.getAttribute("aria-live") === "assertive") {
      if (visible(el)) { var et = clean(textOf(el), 160); if (et && errors.indexOf(et) < 0 && errors.length < 10) errors.push(et); }
    } else if (r === "status" || el.getAttribute("aria-live") === "polite" || el.matches("[class*=toast i],[class*=snackbar i]")) {
      // Toasts/snackbars ("Saved", "Invitation sent") are often the only sign an action worked.
      if (visible(el)) { var st = clean(textOf(el), 160); if (st && messages.indexOf(st) < 0 && messages.length < 6) messages.push(st); }
    }
    if (el.matches(POPUP_SEL) && visible(el)) {
      var dl = clean(el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") ? byIds(rootOf(el), el.getAttribute("aria-labelledby")) : "") || textOf(el), 80);
      if (el.matches(DIALOG_SEL) && isBlocking(el)) {
        if (dialogs.indexOf(dl) < 0) dialogs.push(dl);
        blockers.push(el);
      } else if (!blockers.some(function (b) { return b.contains(el); })) {
        popups.push(el);
        if (popupNames.indexOf(dl) < 0) popupNames.push(dl);
      }
    }

    var kind = kindOf(el);
    var ed = null;
    if (kind === "textarea" || kind === "textbox") { ed = editorOf(el); if (ed) kind = "code"; }
    // React/Vue click handlers leave no trace in the DOM; a pointer cursor is the only signal.
    // Take the outermost element with it -- its children inherit the cursor.
    if (!kind && POINTER_TAGS[tag] && cursorOf(el) === "pointer" && cursorOf(el.parentElement) !== "pointer") {
      var pr = el.getBoundingClientRect();
      var pt = textOf(el);
      if (pr.width > 1 && pr.height > 1 && pr.width * pr.height < 0.3 * innerWidth * innerHeight && (pt.length > 0 && pt.length < 150 || el.querySelector("img,svg"))) kind = "button";
    }
    // CSS :hover menus ("Account ▾" over a display:none list of links) have no role and no pointer
    // cursor, so nothing marks the trigger. Hovering is what opens them; a click moves the mouse there.
    var hoverMenu = false;
    if (!kind && el.children.length && el.children.length <= 6 && POINTER_TAGS[tag]) {
      for (var hc = 0; hc < el.children.length; hc++) {
        var sub = el.children[hc];
        if (!visible(sub) && sub.querySelectorAll("a[href],[role=menuitem],button").length >= 2) { hoverMenu = true; break; }
      }
      if (hoverMenu && visible(el) && textOf(el)) kind = "button"; else hoverMenu = false;
    }
    if (!kind) continue;
    if (el.closest("[aria-hidden=true]")) continue;
    // Skip non-field elements nested inside an already-listed button/link (icon spans, inner divs).
    var anc = el.parentElement, nested = false;
    for (var d = 0; anc && d < 6; d++, anc = anc.parentElement) { if (included.has(anc)) { nested = true; break; } }
    if (nested && (kind === "button" || kind === "link")) continue;

    var isVis = kind === "code" ? visible(ed) : visible(el);
    var hiddenOk = kind === "file" || kind === "checkbox" || kind === "radio";
    if (!isVis && !hiddenOk) continue;
    if (!isVis && hiddenOk && kind !== "file") {
      // Custom-styled checkbox/radio: only keep it if a visible label points at it.
      var lab = el.closest("label") || (el.id ? rootOf(el).querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
      if (!lab || !visible(lab)) continue;
    }
    var inChrome = !!el.closest(CHROME_SEL);
    if (inChrome && !opts.all && (kind === "link" || kind === "button")) { chromeCount++; continue; }
    if (items.length >= MAX_ITEMS) break;

    var id = reg.byEl.get(el);
    if (!id) { id = reg.next++; reg.byEl.set(el, id); }
    reg.byId.set(id, el);
    included.add(el);

    var item = { id: id, kind: kind, label: labelOf(el, kind), section: section };
    if (!isVis) item.hidden = true;
    for (var bi = 0; bi < blockers.length; bi++) if (blockers[bi].contains(el)) { item.inDialog = true; break; }
    for (var pi = 0; pi < popups.length; pi++) if (popups[pi].contains(el)) { item.inPopup = true; break; }
    if (kind === "code") {
      item.label = labelOf(el, "textbox") || "Code editor";
      var code = editorCode(ed);
      item.value = code.length > 400 ? code.slice(0, 399) + "…" : code;
      item.lines = code ? code.split("\n").length : 0;
    }
    if (inChrome) item.chrome = true;
    if (el.required || el.getAttribute("aria-required") === "true") item.required = true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (el.getAttribute("aria-invalid") === "true") { item.invalid = true; var h = hintOf(el); if (h) item.hint = h; }
    if (el.getAttribute("aria-expanded") === "true") item.expanded = true;
    if (hoverMenu) item.hoverMenu = true;
    // Date pickers and some autocompletes are read-only inputs that only change through their popup.
    if (el.readOnly === true || el.getAttribute("aria-readonly") === "true") item.readonly = true;
    // Toggle/segmented buttons (doctor pickers, In-clinic/Video, tabs) show their choice this way.
    if (el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true" ||
        el.getAttribute("aria-current") === "true" || /^(on|active|checked)$/.test(el.getAttribute("data-state") || "")) item.selected = true;

    if (kind === "button" && el.hasAttribute("aria-pressed")) {
      var bg = el.closest("[role=group],[role=radiogroup],[role=toolbar]");
      if (bg) { var bgl = groupOf(el); if (bgl && bgl !== item.label) item.group = bgl; }
    }
    if (kind === "checkbox" || kind === "radio" || kind === "switch") {
      item.checked = el.checked === true || el.getAttribute("aria-checked") === "true";
      var grp = groupOf(el); if (grp && grp !== item.label) item.group = grp;
    } else if (kind === "select") {
      var o = el.options, list = [];
      for (var j = 0; j < o.length && j < 25; j++) list.push(clean(o[j].text, 60));
      item.options = list;
      if (o.length > 25) item.optionsMore = o.length - 25;
      item.value = el.selectedIndex >= 0 ? clean(o[el.selectedIndex].text, 80) : "";
    } else if (kind === "file") {
      item.value = el.files && el.files.length ? Array.prototype.map.call(el.files, function (f) { return f.name; }).join(", ") : "";
    } else if (kind === "textbox" || kind === "textarea" || kind === "combobox" || kind === "spinbutton" || kind === "slider") {
      // A button/div combobox (Radix, MUI, Headless UI) shows its current choice as its own text;
      // <button> has a .value property too, but it's always "" there.
      var fieldTag = /^(input|textarea)$/.test(tag);
      var v = !fieldTag && kind === "combobox" ? textOf(el).replace(/\s*[▾▼⌄⏷]\s*$/, "") :
        el.isContentEditable && !("value" in el) ? textOf(el) : (el.value != null ? String(el.value) : textOf(el));
      // React-Select, Select2, Downshift etc. show the chosen value in a sibling element and leave
      // the <input> empty; without this the model saw "" after a successful pick and kept retrying.
      if (fieldTag && kind === "combobox" && !v) {
        for (var ca = el.parentElement, cd = 0; ca && cd < 3; ca = ca.parentElement, cd++) {
          var shown = textOf(ca);
          if (!shown) continue;
          // Stop at a container that holds other fields too -- its text is not this field's value.
          if (shown.length > 80 || ca.querySelectorAll("input,select,textarea").length > 1) break;
          if (/^(select|choose|search|type|pick|start typing)\b[^]{0,30}$/i.test(shown) || shown === labelOf(el, kind)) break;
          v = shown;
          break;
        }
      }
      if ((el.getAttribute("type") || "").toLowerCase() === "password" && v) v = "••••••";
      item.value = clean(v, 200);
      var it = (el.getAttribute("type") || "").toLowerCase();
      if (it && it !== "text") item.inputType = it;
    } else if (kind === "link") {
      item.href = el.getAttribute("href") || "";
    }
    items.push(item);
  }

  var out = { items: items, headings: headings, errors: errors, messages: messages, dialogs: dialogs, popups: popupNames, chromeHidden: chromeCount, gen: reg.gen,
    title: document.title, url: location.href };
  if (items.length < 4) {
    var mainEl = document.querySelector("main,[role=main],article") || document.body;
    out.summary = clean(mainEl ? mainEl.innerText : "", 600);
  }
  if (opts.text) {
    var main = document.querySelector("main,[role=main],article") || document.body;
    out.text = clean(main ? main.innerText : "", opts.textLimit || 6000);
  }
  return out;
})`;
