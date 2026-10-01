// In-page step of the calendar driver, as a plain string for the same reason as extract-src.ts.
// Given the target {y, m (0-11), d}, it finds the open calendar popup, reads which month it shows,
// and marks the element to click next with data-ib-click: the target day if that month is showing,
// else the next/previous-month control. The caller clicks it for real and calls this again.
// Returns { status: "day" | "nav" | "nopicker" | "noday" | "nonav", shown }.
export const DATEPICKER_SRC = String.raw`
(function (t) {
  var MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  function vis(el) {
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function txt(el) { return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(); }
  function name(el) { return ((el.getAttribute("aria-label") || el.getAttribute("title") || "") + " " + txt(el)).toLowerCase(); }
  document.querySelectorAll("[data-ib-click]").forEach(function (e) { e.removeAttribute("data-ib-click"); });

  // The calendar: a visible popup-ish container holding at least 28 day-number cells.
  var cands = document.querySelectorAll("[role=dialog],[role=grid],[role=application],[class*=calendar i],[class*=datepicker i],[class*=date-picker i],[class*=picker i],table");
  var cal = null, best = 1e12;
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    if (!vis(c)) continue;
    var cells = c.querySelectorAll("button,td,[role=gridcell],[role=button],div,span");
    var n = 0;
    for (var j = 0; j < cells.length && n < 28; j++) { var s = txt(cells[j]); if (/^\d{1,2}$/.test(s) && cells[j].children.length === 0) n++; }
    if (n < 28) continue;
    var r = c.getBoundingClientRect(), area = r.width * r.height;
    if (area < best) { best = area; cal = c; }
  }
  if (!cal) return { status: "nopicker", shown: "" };
  // Use the container that also holds the header and the arrows.
  var box = cal;
  for (var up = 0; up < 3 && box.parentElement; up++) {
    if (new RegExp("(" + MONTHS.join("|") + ")").test(txt(box).toLowerCase()) && box.querySelector("button,[role=button]")) break;
    box = box.parentElement;
  }
  var head = txt(box).toLowerCase().match(new RegExp("(" + MONTHS.join("|") + "|" + MONTHS.map(function (m) { return m.slice(0, 3); }).join("|") + ")[a-z]*\\.?,? (\\d{4})"));
  if (!head) return { status: "nopicker", shown: "" };
  var shownM = MONTHS.findIndex(function (m) { return m.indexOf(head[1].slice(0, 3)) === 0; });
  var shownY = Number(head[2]);
  var shown = MONTHS[shownM] + " " + shownY;
  var diff = (t.y - shownY) * 12 + (t.m - shownM);

  if (diff === 0) {
    var full = MONTHS[t.m], day = String(t.d);
    var labelled = null, plain = [];
    var all = box.querySelectorAll("button,td,[role=gridcell],[role=button],[role=option],a,div,span");
    for (var k = 0; k < all.length; k++) {
      var e = all[k];
      if (!vis(e)) continue;
      var dis = e.getAttribute("aria-disabled") === "true" || e.disabled || /(disabled|outside|other-month|othermonth|adjacent|muted|prev-month|next-month)/i.test(e.className && e.className.baseVal === undefined ? e.className : "");
      if (dis) continue;
      var al = (e.getAttribute("aria-label") || "").toLowerCase();
      if (al && al.indexOf(full) >= 0 && new RegExp("\\b" + day + "\\b").test(al) && al.indexOf(String(t.y)) >= 0) { labelled = e; break; }
      if (txt(e) === day && e.children.length === 0) plain.push(e);
    }
    var hit = labelled || plain[0];
    if (!hit) return { status: "noday", shown: shown };
    var clickable = hit.closest("button,[role=gridcell],[role=button],[role=option],a,td") || hit;
    clickable.setAttribute("data-ib-click", "1");
    return { status: "day", shown: shown };
  }
  // Navigate one month towards the target.
  var fwd = diff > 0;
  var nav = null;
  var btns = box.querySelectorAll("button,[role=button],a,span,div");
  for (var b = 0; b < btns.length; b++) {
    var el = btns[b];
    if (!vis(el) || el.children.length > 2) continue;
    var nm = name(el);
    var isNext = /next|forward|›|»|→|>|chevron-right|arrow-right/.test(nm) || /next/i.test(el.className && el.className.baseVal === undefined ? el.className : "");
    var isPrev = /prev|previous|back|‹|«|←|<|chevron-left|arrow-left/.test(nm) || /prev/i.test(el.className && el.className.baseVal === undefined ? el.className : "");
    if ((fwd && isNext && !isPrev) || (!fwd && isPrev && !isNext)) { nav = el; break; }
  }
  if (!nav) return { status: "nonav", shown: shown };
  (nav.closest("button,[role=button],a") || nav).setAttribute("data-ib-click", "1");
  return { status: "nav", shown: shown };
})`;
