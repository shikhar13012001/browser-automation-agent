// The two iframe documents embedded by zoo.html. frame posts to its same-origin parent directly;
// frame2 is loaded cross-origin, so it can only report back with postMessage.
export const frame = `<!doctype html><html><head><meta charset="utf-8"><title>Coupon</title></head>
<body style="font-family:system-ui;margin:8px"><label for="cc" style="font-weight:600">Coupon code</label> <input id="cc">
<button id="apply">Apply coupon</button> <span id="out"></span>
<script>document.getElementById("apply").onclick=()=>{const v=document.getElementById("cc").value;parent.ZOO.coupon=v;document.getElementById("out").textContent=v?"Coupon applied":"Enter a code";};</script>
</body></html>`;

export const frame2 = `<!doctype html><html><head><meta charset="utf-8"><title>Payment details</title></head>
<body style="font-family:system-ui;margin:8px"><label for="holder" style="font-weight:600">Name on card</label> <input id="holder">
<button id="save">Save card holder</button>
<script>document.getElementById("save").onclick=()=>{parent.postMessage({zoo:{cardHolder:document.getElementById("holder").value}},"*");};</script>
</body></html>`;
