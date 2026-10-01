// In-page lookup for click_text, as a plain string for the same reason as extract-src.ts.
// Finds the visible element whose text matches, preferring one inside an open popup/menu/dialog
// (you usually click what just appeared), then the smallest match, then climbs to the element that
// actually handles the click. Returns { el, total, text } or null.
export const FIND_TEXT_SRC = String.raw`
(function (wanted) {
  var want = wanted.replace(/\s+/g, " ").trim().toLowerCase();
  if (!want) return null;
  function vis(el) {
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function txt(el) { return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function area(el) { var r = el.getBoundingClientRect(); return r.width * r.height; }
  var POP = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox],dialog[open],[data-radix-popper-content-wrapper]";
  var exact = [], prefix = [];
  var all = document.querySelectorAll("body *");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    // Icon buttons ("›" with aria-label "Next month") are named by their aria-label/title, not text.
    var named = (el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (named === want && vis(el)) { exact.push(el); continue; }
    var t = txt(el);
    if (!t || t.length > want.length + 40) continue;
    if (t === want) { if (vis(el)) exact.push(el); }
    else if (t.indexOf(want) === 0 && t.length <= want.length + 20) { if (vis(el)) prefix.push(el); }
  }
  var cands = exact.length ? exact : prefix;
  if (!cands.length) return null;
  cands.sort(function (a, b) {
    var pa = a.closest(POP) ? 0 : 1, pb = b.closest(POP) ? 0 : 1;
    return pa !== pb ? pa - pb : area(a) - area(b);
  });
  var best = cands[0];
  var target = best.closest("a[href],button,[role=button],[role=option],[role=menuitem],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],label,summary,input,select") || best;
  if (target === best) {
    for (var p = best; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).cursor === "pointer" && (!p.parentElement || getComputedStyle(p.parentElement).cursor !== "pointer")) { target = p; break; }
    }
  }
  // Distinct clickable targets among the matches, so the caller can say how ambiguous it was.
  var seen = [];
  for (var j = 0; j < cands.length; j++) {
    var c = cands[j].closest("a[href],button,[role=button],[role=option],[role=menuitem],[role=tab],label") || cands[j];
    var dup = false;
    for (var k = 0; k < seen.length; k++) if (seen[k] === c || seen[k].contains(c) || c.contains(seen[k])) { dup = true; break; }
    if (!dup) seen.push(c);
  }
  return { el: target, total: seen.length, text: (target.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) };
})`;
