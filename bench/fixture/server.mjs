// Local practice job-application site used to benchmark the agent. Deliberately includes the things
// that slow agents down on real ATS sites: a blocking cookie dialog, a long job description, a nav
// full of links, an Apply button that opens a new tab, a sign-in-or-guest interstitial, a custom
// type-ahead combobox, hidden styled checkboxes/radios, a hidden file input, multi-step validation,
// and a "controlled" form that only records values delivered through real input events (like React).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { frame, frame2 } from "./zoo-frames.mjs";

const ZOO = new URL("./zoo.html", import.meta.url);

const PORT = Number(process.env.BENCH_PORT ?? 4545);
let submissions = [];

const NAV = Array.from({ length: 28 }, (_, i) => `<a href="/careers/team-${i}">Team ${i + 1}</a>`).join(" ");
const FOOTER = Array.from({ length: 16 }, (_, i) => `<a href="/legal/${i}">Legal link ${i + 1}</a>`).join(" ");
const JD = Array.from(
  { length: 18 },
  (_, i) =>
    `<p>Responsibility ${i + 1}: design, build and operate distributed backend services that handle millions of requests per day, write design documents, review code, improve reliability and observability, and collaborate with product and platform teams across regions.</p>`,
).join("");

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#111}header,footer{background:#f3f3f3;padding:12px;font-size:12px}
header a,footer a{margin-right:8px}main{max-width:760px;margin:24px auto;padding:0 16px}
.btn{display:inline-block;background:#0a58ca;color:#fff;padding:10px 18px;border:0;border-radius:6px;cursor:pointer;text-decoration:none;font-size:15px}
.btn.secondary{background:#666}.field{margin:14px 0}.field label{display:block;font-weight:600;margin-bottom:4px}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=url],input[type=password],select,textarea{width:100%;padding:8px;font-size:14px;box-sizing:border-box}
.err{color:#b00020;font-size:13px}.sr{position:absolute;opacity:0;width:1px;height:1px;overflow:hidden}
.chip{display:inline-block;border:1px solid #999;border-radius:14px;padding:4px 10px;margin:3px;cursor:pointer}
.chip.on{background:#0a58ca;color:#fff;border-color:#0a58ca}
#cookie{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;z-index:50}
#cookie>div{background:#fff;padding:20px;max-width:640px;margin:20px;border-radius:8px}
.lb{border:1px solid #ccc;max-height:180px;overflow:auto;margin:0;padding:0;list-style:none;background:#fff}
.lb li{padding:6px 8px;cursor:pointer}.lb li:hover{background:#eef}
</style></head><body>${body}</body></html>`;

const jobPage = shell(
  "Software Development Engineer I - Backend | Northwind Careers",
  `<header><nav aria-label="Main">${NAV}</nav></header>
<main>
<h1>Software Development Engineer I - Backend</h1>
<p>Bengaluru, India · Full-time · Job ID NW-4471</p>
<p><a class="btn" href="/apply/sde1/start" target="_blank" rel="opener">Apply now</a></p>
<h2>About the role</h2>${JD}
<h2>Basic qualifications</h2><p>1+ years of professional software development experience. Proficiency in at least one modern programming language such as Java, Kotlin, Python or Go.</p>
</main>
<footer role="contentinfo">${FOOTER}</footer>
<div id="cookie" role="dialog" aria-modal="true" aria-label="Cookie preferences"><div>
<h2>We value your privacy</h2><p>We use cookies to improve your experience. Choose whether to allow optional cookies.</p>
<button class="btn" onclick="document.getElementById('cookie').remove()">Accept all cookies</button>
<button class="btn secondary" onclick="document.getElementById('cookie').remove()">Reject optional</button>
</div></div>`,
);

const startPage = shell(
  "Apply - Sign in | Northwind Careers",
  `<main><h1>Apply for Software Development Engineer I - Backend</h1>
<h2>Sign in to your candidate account</h2>
<div class="field"><label for="si-email">Email</label><input id="si-email" type="email"></div>
<div class="field"><label for="si-pw">Password</label><input id="si-pw" type="password"></div>
<p><button class="btn secondary" onclick="document.getElementById('si-msg').textContent='Invalid email or password.'">Sign in</button>
<span id="si-msg" class="err" role="alert"></span></p>
<h2>New here?</h2><p><a class="btn" href="/apply/sde1/form">Continue as guest</a></p></main>`,
);

const CITIES = ["Bengaluru", "Bangalore Rural", "Hyderabad", "Pune", "Mumbai", "Chennai", "Delhi", "Gurugram", "Noida", "Kolkata", "Ahmedabad", "Kochi"];
const CODES = ["+1 United States", "+7 Russia", "+20 Egypt", "+27 South Africa", "+33 France", "+34 Spain", "+44 United Kingdom", "+49 Germany", "+61 Australia", "+65 Singapore", "+81 Japan", "+86 China", "+91 India", "+92 Pakistan", "+94 Sri Lanka", "+971 United Arab Emirates", "+977 Nepal", "+880 Bangladesh"];

// buggy=true is the QA-demo variant (/qa/...): the same form with eight planted bugs, each one hit
// only by some personas (see bench/qa/bugs.json). buggy=false is the clean benchmark form.
const formPage = (buggy) => shell(
  "Application form | Northwind Careers",
  `<main id="app"></main>
<script>
const BUGGY=${buggy ? "true" : "false"};
const CITIES=${JSON.stringify(CITIES)}, CODES=${JSON.stringify(buggy ? CODES.filter((c) => !c.startsWith("+34")) : CODES)};
const S={step:1, v:{skills:[]}, errors:{}, file:null};
const req={1:["firstName","lastName","email","phoneCode","phone","city"],2:["resume","employer","title","experience","university","gradYear"],3:["basedInIndia","whyJoin","consent"]};
const labels={firstName:"First name",lastName:"Last name",email:"Email address",phoneCode:"Country code",phone:"Phone number",city:"City",resume:"Resume",employer:"Current employer",title:"Current job title",experience:"Years of experience",university:"University",gradYear:"Graduation year",basedInIndia:"Are you currently based in India?",whyJoin:"Why do you want to work at Northwind?",consent:"Consent"};
function h(s){return s}
function err(k){return S.errors[k]?'<div class="err" id="e-'+k+'">'+S.errors[k]+'</div>':''}
function inv(k){return S.errors[k]?' aria-invalid="true" aria-describedby="e-'+k+'"':''}
function text(k,type,extra){return '<div class="field"><label for="'+k+'">'+labels[k]+' *</label><input id="'+k+'" type="'+type+'" data-k="'+k+'" value="'+(S.v[k]||'').replace(/"/g,'&quot;')+'" required'+inv(k)+(extra||'')+'>'+err(k)+'</div>'}
function sel(k,opts){return '<div class="field"><label for="'+k+'">'+labels[k]+' *</label><select id="'+k+'" data-k="'+k+'" required'+inv(k)+'><option value="">Select…</option>'+opts.map(o=>'<option'+(S.v[k]===o?' selected':'')+'>'+o+'</option>').join('')+'</select>'+err(k)+'</div>'}
function render(){
  const a=document.getElementById('app'); let b='<h1>Apply: Software Development Engineer I - Backend</h1><p>Step '+S.step+' of 3</p>';
  const errs=Object.values(S.errors); if(errs.length) b+='<div role="alert" class="err">Please fix '+errs.length+' field(s) below.</div>';
  if(S.step===1){ b+='<h2>Personal details</h2>'+text('firstName','text')+text('lastName','text')+text('email','email')+sel('phoneCode',CODES)+text('phone','tel')+
    '<div class="field"><label id="city-l">City *</label><input id="city" role="combobox" aria-labelledby="city-l" aria-autocomplete="list" aria-expanded="false" aria-controls="city-lb" autocomplete="off" value="'+(S.v.city||'')+'"'+inv('city')+'><ul id="city-lb" role="listbox" class="lb" hidden></ul>'+err('city')+'</div>'+
    '<div class="field"><label for="linkedin">LinkedIn profile URL</label><input id="linkedin" type="url" data-k="linkedin" value="'+(S.v.linkedin||'')+'"></div>'+
    '<button class="btn" id="next">Next</button>'; }
  if(S.step===2){ b+='<h2>Experience</h2><div class="field"><span style="font-weight:600">Resume *</span><br><label for="resume" class="btn secondary">Upload resume (PDF)</label> <span id="rname">'+(S.file||'No file chosen')+'</span><input id="resume" type="file" class="sr" accept=".pdf"'+inv('resume')+'>'+err('resume')+'</div>'+
    text('employer','text')+text('title','text')+sel('experience',["Less than 1 year","1-2 years","3-5 years","6+ years"])+text('university','text')+text('gradYear','number')+
    '<fieldset class="field"><legend style="font-weight:600">Skills (select all that apply)</legend>'+["Python","Kotlin","Java","TypeScript","Go","PHP","Ruby"].map(s=>'<label class="chip'+(S.v.skills.includes(s)?' on':'')+'"><input type="checkbox" class="sr" value="'+s+'"'+(S.v.skills.includes(s)?' checked':'')+'> '+s+'</label>').join('')+'</fieldset>'+
    '<button class="btn secondary" id="back">Back</button> <button class="btn" id="next">Next</button>'; }
  if(S.step===3){ b+='<h2>A few questions</h2><fieldset class="field"><legend style="font-weight:600">Are you currently based in India? *</legend>'+
    ["Yes","No"].map(o=>'<label class="chip'+(S.v.basedInIndia===o?' on':'')+'"><input type="radio" name="basedInIndia" class="sr" value="'+o+'"'+(S.v.basedInIndia===o?' checked':'')+'> '+o+'</label>').join('')+err('basedInIndia')+'</fieldset>'+
    '<div class="field"><label for="whyJoin">Why do you want to work at Northwind? (at least 50 characters) *</label><textarea id="whyJoin" data-k="whyJoin" rows="4" required'+inv('whyJoin')+'>'+(S.v.whyJoin||'')+'</textarea>'+err('whyJoin')+'</div>'+
    '<div class="field"><label for="gender">Gender (optional)</label><select id="gender" data-k="gender"><option value="">Select…</option>'+["Female","Male","Non-binary","Prefer not to say"].map(o=>'<option'+(S.v.gender===o?' selected':'')+'>'+o+'</option>').join('')+'</select></div>'+
    '<p><a href="'+(BUGGY?'/privacy-policy':'/privacy')+'" target="_blank">Read our privacy policy</a></p>'+
    '<div class="field"><label class="chip'+(S.v.consent?' on':'')+'"><input type="checkbox" id="consent" class="sr"'+(S.v.consent?' checked':'')+inv('consent')+'> I confirm the information in this application is accurate *</label>'+err('consent')+'</div>'+
    '<button class="btn secondary" id="back">Back</button> <button class="btn" id="submit">Submit application</button>'; }
  if(S.step===4){ const last=BUGGY?String(S.v.lastName||'').slice(0,20):S.v.lastName;
    b='<h1>Application received</h1><p role="status">Thank you, '+(BUGGY?S.v.lastName:S.v.firstName)+'. Your reference number is <strong>'+S.ref+'</strong>.</p>'+
      '<p>Applicant: '+S.v.firstName+' '+last+' · '+S.v.email+'</p>'; }
  a.innerHTML=b; wire();
}
function wire(){
  document.querySelectorAll('[data-k]').forEach(el=>{ el.addEventListener('input',()=>{S.v[el.dataset.k]=el.value}); el.addEventListener('change',()=>{S.v[el.dataset.k]=el.value}); });
  const c=document.getElementById('city'), lb=document.getElementById('city-lb');
  if(c){ c.addEventListener('input',()=>{ S.v.city=''; const q=c.value.toLowerCase(); const m=CITIES.filter(x=>x.toLowerCase().includes(q)); lb.innerHTML=m.map(x=>'<li role="option">'+x+'</li>').join(''); lb.hidden=!q||!m.length; c.setAttribute('aria-expanded',String(!lb.hidden));
      lb.querySelectorAll('li').forEach(li=>li.addEventListener('click',()=>{ c.value=li.textContent; S.v.city=li.textContent; lb.hidden=true; c.setAttribute('aria-expanded','false'); })); }); }
  const f=document.getElementById('resume'); if(f) f.addEventListener('change',()=>{ S.file=f.files[0]?f.files[0].name:null; document.getElementById('rname').textContent=S.file||'No file chosen'; });
  document.querySelectorAll('fieldset input[type=checkbox]').forEach(el=>el.addEventListener('change',()=>{ const s=el.value; S.v.skills=el.checked?[...new Set([...S.v.skills,s])]:S.v.skills.filter(x=>x!==s); el.closest('label').classList.toggle('on',el.checked); }));
  document.querySelectorAll('input[name=basedInIndia]').forEach(el=>el.addEventListener('change',()=>{ S.v.basedInIndia=el.value; document.querySelectorAll('input[name=basedInIndia]').forEach(r=>r.closest('label').classList.toggle('on',r.checked)); }));
  const cs=document.getElementById('consent'); if(cs) cs.addEventListener('change',()=>{ S.v.consent=cs.checked; cs.closest('label').classList.toggle('on',cs.checked); });
  const n=document.getElementById('next'); if(n) n.onclick=()=>{ if(BUGGY&&S.step===2&&S.v.experience==='6+ years') return; if(validate()){ S.step++; S.errors={}; } render(); };
  const bk=document.getElementById('back'); if(bk) bk.onclick=()=>{ S.step--; S.errors={}; if(BUGGY&&S.step===1) S.v.city=''; render(); };
  const sb=document.getElementById('submit'); if(sb) sb.onclick=async()=>{ if(!validate()){ render(); return; }
    const r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...S.v,lastName:BUGGY?String(S.v.lastName||'').slice(0,20):S.v.lastName,resume:S.file,variant:BUGGY?'qa':'clean'})}); const j=await r.json(); S.ref=j.ref; S.step=4; render(); };
}
function validate(){ S.errors={}; for(const k of req[S.step]){ const v=k==='resume'?S.file:S.v[k]; if(!v||(k==='whyJoin'&&String(v).trim().length<50)||(k==='email'&&!/^[^@]+@[^@]+\\.[^@]+$/.test(v))) S.errors[k]=labels[k]+(k==='whyJoin'?' must be at least 50 characters':' is required'); }
  if(BUGGY){ if(S.step===1&&S.v.email&&S.v.email.includes('+')) S.errors.email='Please enter a valid email address'; if(S.errors.phone) S.errors.phone='Email address is required'; }
  return !Object.keys(S.errors).length; }
render();
</script>`,
);

function send(res, code, body, type = "text/html") {
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "POST" && url.pathname === "/api/submit") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const data = JSON.parse(body || "{}");
      const ref = "NW-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      submissions.push({ ref, at: new Date().toISOString(), data });
      send(res, 200, JSON.stringify({ ok: true, ref }), "application/json");
    });
    return;
  }
  if (url.pathname === "/api/last") return send(res, 200, JSON.stringify(submissions.at(-1) ?? null), "application/json");
  if (url.pathname === "/api/reset") {
    submissions = [];
    return send(res, 200, "{}", "application/json");
  }
  if (url.pathname === "/jobs/sde1") return send(res, 200, jobPage);
  if (url.pathname === "/apply/sde1/start") return send(res, 200, startPage);
  if (url.pathname === "/apply/sde1/form") return send(res, 200, formPage(false));
  // QA demo: the same journey with planted bugs.
  if (url.pathname === "/qa/jobs/sde1") return send(res, 200, jobPage.replace("/apply/sde1/start", "/qa/apply/sde1/start"));
  if (url.pathname === "/qa/apply/sde1/start") return send(res, 200, startPage.replace("/apply/sde1/form", "/qa/apply/sde1/form"));
  if (url.pathname === "/qa/apply/sde1/form") return send(res, 200, formPage(true));
  if (url.pathname === "/privacy") return send(res, 200, shell("Privacy policy | Northwind", "<main><h1>Privacy policy</h1><p>We only use your data to process your application.</p></main>"));
  if (url.pathname === "/api/submissions") return send(res, 200, JSON.stringify(submissions), "application/json");
  // Read per request so edits to the zoo show up without restarting the server.
  if (url.pathname === "/zoo") return send(res, 200, readFileSync(ZOO, "utf8"));
  if (url.pathname === "/zoo/frame") return send(res, 200, frame);
  if (url.pathname === "/zoo/frame2") return send(res, 200, frame2);
  send(res, 404, shell("Not found", "<main><h1>Not found</h1></main>"));
}).listen(PORT, () => console.log(`bench fixture on http://localhost:${PORT}/jobs/sde1`));
