/* CUDE-ONBOARDING: first-run full-screen setup (4 steps) followed by a floating "Introducing Cude IDE" window. */
(function(){
 if(typeof document==='undefined'||globalThis.cudeOnboardingLoaded)return;globalThis.cudeOnboardingLoaded=true;
 const DONE='cude.onboarding.v1';
 const tr=()=>String(document.documentElement.lang||navigator.language||'en').toLowerCase().startsWith('tr');
 const T=(en,trText)=>tr()?trText:en;
 const run=(id,...args)=>{try{return globalThis.cudeCommandService?.executeCommand(id,...args);}catch(e){console.warn('[Cude] onboarding command',id,e);}};
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const MARK='M495,373 L488,366 L480,362 L465,361 L459,363 L294,463 L289,470 L290,524 L294,527 L301,527 L485,417 L495,407 L500,395 L500,385Z M219,195 L209,200 L201,212 L201,226 L205,234 L212,241 L275,285 L273,289 L208,330 L203,336 L200,343 L200,356 L203,363 L211,371 L226,375 L238,371 L342,307 L348,301 L352,293 L353,282 L350,273 L343,265 L236,196Z M288,29 L270,29 L255,35 L75,146 L64,156 L55,176 L55,389 L61,405 L74,419 L253,527 L262,526 L266,520 L266,472 L264,467 L259,462 L119,379 L114,372 L113,200 L117,192 L266,100 L278,95 L287,97 L460,204 L475,205 L486,201 L493,195 L500,180 L498,163 L491,152 L485,147 L303,35Z';
 const logo=size=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 557 557');svg.setAttribute('width',size);svg.setAttribute('height',size);const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',MARK);p.setAttribute('fill','currentColor');p.setAttribute('fill-rule','evenodd');svg.appendChild(p);return svg;};
 const css=`
 .cude-ob{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;font-family:var(--vscode-font-family,"Segoe UI",system-ui,sans-serif);color:#f3efe8;background:radial-gradient(60% 70% at 25% 20%,rgba(214,155,112,.28),transparent 70%),radial-gradient(50% 60% at 80% 85%,rgba(176,90,50,.25),transparent 70%),#0b0908;animation:cudeObIn .35s ease-out}
 .cude-ob *{box-sizing:border-box}
 .cude-ob-panel{width:min(880px,calc(100vw - 48px));min-height:min(560px,calc(100vh - 80px));display:flex;flex-direction:column;padding:34px 40px 28px;border-radius:24px;background:rgba(22,18,15,.72);border:1px solid rgba(255,255,255,.08);box-shadow:0 40px 120px -40px rgba(0,0,0,.8);background-color:#16120f}
 .cude-ob-top{display:flex;align-items:center;gap:10px;color:#d69b70;font-weight:700;letter-spacing:.02em}
 .cude-ob-skip{margin-left:auto;background:none;border:0;color:#a9a297;cursor:pointer;font:inherit;font-size:13px}.cude-ob-skip:hover{color:#f3efe8}
 .cude-ob-body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:18px 0;animation:cudeObStep .35s cubic-bezier(.2,.8,.2,1)}
 .cude-ob-hero{text-align:center}.cude-ob-hero svg{color:#fff;filter:drop-shadow(0 12px 40px rgba(214,155,112,.6));animation:cudeObFloat 5s ease-in-out infinite}
 .cude-ob h1{margin:18px 0 8px;font-size:clamp(30px,4.6vw,48px);line-height:1.05;letter-spacing:-.03em;background:linear-gradient(180deg,#fff,#f0d6c2 70%,#d69b70);-webkit-background-clip:text;background-clip:text;color:transparent}
 .cude-ob h2{margin:0 0 6px;font-size:26px;letter-spacing:-.02em}
 .cude-ob p{margin:0;color:#c4bdb2;font-size:15px;line-height:1.6}
 .cude-ob-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:22px}
 .cude-ob-choice{text-align:left;padding:18px;border-radius:16px;cursor:pointer;color:inherit;font:inherit;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .2s,background .2s}
 .cude-ob-choice:hover{transform:translateY(-2px);border-color:rgba(214,155,112,.55)}
 .cude-ob-choice[aria-pressed=true]{border-color:#d69b70;background:rgba(214,155,112,.12);box-shadow:0 0 0 1px #d69b70 inset}
 .cude-ob-choice strong{display:block;font-size:15px;margin-bottom:4px}.cude-ob-choice span{color:#b3aca1;font-size:13px;line-height:1.5}
 .cude-ob-foot{display:flex;align-items:center;gap:10px}
 .cude-ob-dots{display:flex;gap:6px}.cude-ob-dots i{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.18);transition:all .25s}.cude-ob-dots i.on{width:22px;border-radius:6px;background:#d69b70}
 .cude-ob-btn{font:600 14px var(--vscode-font-family,"Segoe UI",sans-serif);padding:11px 20px;border-radius:12px;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:transparent;color:#f3efe8;transition:transform .18s cubic-bezier(.2,.8,.2,1),background .18s,box-shadow .2s}
 .cude-ob-btn:hover{transform:translateY(-1px);background:rgba(255,255,255,.06)}.cude-ob-btn:active{transform:translateY(1px) scale(.98)}
 .cude-ob-btn.primary{background:#d69b70;border-color:transparent;color:#1a120c}.cude-ob-btn.primary:hover{background:#e8b48c;box-shadow:0 12px 28px -12px #d69b70}
 .cude-ob-spacer{flex:1}
 .cude-ob-intro{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;background:rgba(5,4,3,.55);background-color:rgba(5,4,3,.75);animation:cudeObIn .25s ease-out;font-family:var(--vscode-font-family,"Segoe UI",system-ui,sans-serif)}
 .cude-ob-card{position:relative;width:min(620px,calc(100vw - 40px));border-radius:22px;overflow:hidden;background:#0d0907;color:#fff;box-shadow:0 40px 120px -30px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.08);animation:cudeObPop .45s cubic-bezier(.2,.8,.2,1)}
 .cude-ob-poster{position:relative;height:300px;display:grid;place-items:center;text-align:center;isolation:isolate;overflow:hidden}
 .cude-ob-poster::before{content:"";position:absolute;inset:-30%;z-index:-1;background:radial-gradient(38% 48% at 28% 38%,rgba(255,170,110,.9),transparent 70%),radial-gradient(34% 44% at 74% 62%,rgba(214,96,60,.8),transparent 72%),radial-gradient(28% 36% at 58% 18%,rgba(255,214,170,.65),transparent 70%),radial-gradient(30% 40% at 18% 80%,rgba(150,70,120,.5),transparent 70%),#140c08;opacity:.9}
 .cude-ob-poster small{display:inline-block;padding:5px 12px;border-radius:999px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.2)}
 .cude-ob-poster svg{display:block;margin:16px auto 10px;color:#fff;filter:drop-shadow(0 10px 30px rgba(0,0,0,.35))}
 .cude-ob-poster b{display:block;font-size:44px;letter-spacing:-.035em;line-height:1}
 .cude-ob-cardbody{padding:20px 24px 22px;background:#15110e}
 .cude-ob-cardbody p{margin:0 0 16px;color:#cfc7bb;font-size:14.5px;line-height:1.6}
 .cude-ob-close{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;border:0;cursor:pointer;background:rgba(0,0,0,.35);color:#fff;font-size:18px;line-height:32px;transition:background .2s,transform .2s}.cude-ob-close:hover{background:rgba(0,0,0,.55);transform:rotate(90deg)}
 .cude-ob :focus-visible,.cude-ob-intro :focus-visible{outline:2px solid #d69b70;outline-offset:2px}
 @keyframes cudeObIn{from{opacity:0}to{opacity:1}}@keyframes cudeObStep{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
 @keyframes cudeObPop{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}@keyframes cudeObFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
 @keyframes cudeObDrift{0%{transform:translate3d(-2%,-1%,0) rotate(0)}100%{transform:translate3d(2%,1%,0) rotate(8deg) scale(1.05)}}
 @media (prefers-reduced-motion:reduce){.cude-ob *,.cude-ob-intro *,.cude-ob,.cude-ob-intro{animation:none!important;transition:none!important}}`;
 const ensureStyle=()=>{if(document.getElementById('cude-ob-style'))return;const s=el('style');s.id='cude-ob-style';s.textContent=css;document.head.appendChild(s);};
 const currentTheme=()=>document.querySelector('.monaco-workbench')?.matches('.vs,.hc-light')?'light':'dark';
 function wizard(){
  ensureStyle();document.querySelector('.cude-ob')?.remove();
  const choice={model:'provider',theme:currentTheme(),lang:tr()?'tr':'en'};
  let themePicked=false;
  const root=el('div','cude-ob');root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');
  const panel=el('div','cude-ob-panel');root.appendChild(panel);
  const top=el('div','cude-ob-top');top.append(logo(22),el('span','', 'Cude IDE'));const skip=el('button','cude-ob-skip',T('Skip','Atla'));top.appendChild(skip);
  const body=el('div','cude-ob-body');const foot=el('div','cude-ob-foot');const dots=el('div','cude-ob-dots');for(let i=0;i<4;i++)dots.appendChild(el('i'));
  const back=el('button','cude-ob-btn',T('Back','Geri'));const next=el('button','cude-ob-btn primary',T('Next','İleri'));
  foot.append(dots,el('div','cude-ob-spacer'),back,next);panel.append(top,body,foot);
  let step=0;
  const pick=(group,items)=>{const wrap=el('div','cude-ob-choices');for(const [value,title,desc] of items){const b=el('button','cude-ob-choice');b.setAttribute('aria-pressed',String(choice[group]===value));b.append(el('strong','',title),el('span','',desc));b.onclick=()=>{choice[group]=value;wrap.querySelectorAll('.cude-ob-choice').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));if(group==='theme'){themePicked=true;run('cude-ai.onboardingTheme',value);}if(group==='lang')run('cude-ai.onboardingLanguage',value);};wrap.appendChild(b);}return wrap;};
  const render=()=>{
   if(step===2&&!themePicked)choice.theme=currentTheme();
   body.replaceChildren();body.style.animation='none';void body.offsetWidth;body.style.animation='';
   dots.querySelectorAll('i').forEach((d,i)=>d.classList.toggle('on',i===step));back.style.visibility=step?'visible':'hidden';next.textContent=step===3?T('Start','Başla'):T('Next','İleri');
   if(step===0){const h=el('div','cude-ob-hero');h.append(logo(96),el('h1','',T('Welcome to Cude IDE','Cude IDE\'ye hoş geldin')),el('p','',T('Any model. Every tool. Finished work. Let’s set it up in four quick steps.','Her model. Her araç. Bitmiş iş. Dört kısa adımda hazırlayalım.')));body.appendChild(h);}
   if(step===1){body.append(el('h2','',T('How should Cude think?','Cude nasıl düşünsün?')),el('p','',T('You can change this any time from the model picker.','Bunu model seçiciden istediğin zaman değiştirebilirsin.')),pick('model',[['provider',T('Your provider','Kendi sağlayıcın'),T('OpenAI, Anthropic, Gemini, OpenRouter and 300+ more, with your own key.','OpenAI, Anthropic, Gemini, OpenRouter ve 300+ sağlayıcı, kendi anahtarınla.')],['local',T('On this PC','Bu bilgisayarda'),T('Built-in GGUF models, Ollama or LM Studio. Nothing leaves your PC.','Yerleşik GGUF, Ollama veya LM Studio. Hiçbir şey dışarı çıkmaz.')],['agents',T('Agent apps','Ajan uygulamaları'),T('Claude Code, Codex, OpenCode or Claude Desktop through the Cude bridge.','Claude Code, Codex, OpenCode veya Claude Desktop, Cude köprüsüyle.')]]));}
   if(step===2){body.append(el('h2','',T('Look and language','Görünüm ve dil')),el('p','',T('Applied right away. The whole IDE follows the same language.','Hemen uygulanır. IDE\'nin tamamı aynı dili kullanır.')),pick('theme',[['dark',T('Cude Dark','Cude Koyu'),T('Warm dark with copper accents.','Bakır vurgulu sıcak koyu tema.')],['light',T('Light','Açık'),T('Bright and calm for daylight.','Gün ışığı için ferah ve sakin.')]]),pick('lang',[['tr','Türkçe',T('Menus, chat and settings in Turkish.','Menüler, sohbet ve ayarlar Türkçe.')],['en','English',T('Menus, chat and settings in English.','Menüler, sohbet ve ayarlar İngilizce.')]]));}
   if(step===3){const h=el('div','cude-ob-hero');h.append(logo(72),el('h1','',T('You’re ready','Hazırsın')),el('p','',T('Open a project and give Cude a task. Cuets can split big work across parallel workers.','Bir proje aç ve Cude\'a görev ver. Cuets büyük işleri paralel çalışanlara bölebilir.')));const row=el('div','cude-ob-choices');const open=el('button','cude-ob-choice');open.append(el('strong','',T('Open a folder','Klasör aç')),el('span','',T('Start from an existing project.','Var olan bir projeyle başla.')));open.onclick=()=>{finish();run('workbench.action.files.openFolder');};row.appendChild(open);h.appendChild(row);body.appendChild(h);}
  };
  const finish=()=>{try{localStorage.setItem(DONE,'1');}catch{}root.remove();document.removeEventListener('keydown',keys,true);
   if(choice.model==='agents')run('cude-ai.onboardingAgents');else if(choice.model==='provider')run('cude-ai.configureProvider');else run('cude-ai.onboardingLocal');
   setTimeout(intro,450);};
  const keys=e=>{if(e.key==='Escape'){e.stopPropagation();finish();}if(e.key==='ArrowRight'&&step<3){step++;render();}if(e.key==='ArrowLeft'&&step>0){step--;render();}};
  next.onclick=()=>{if(step<3){step++;render();}else finish();};back.onclick=()=>{if(step>0){step--;render();}};skip.onclick=finish;
  document.addEventListener('keydown',keys,true);document.body.appendChild(root);render();next.focus();
 }
 function intro(){
  ensureStyle();document.querySelector('.cude-ob-intro')?.remove();
  const root=el('div','cude-ob-intro');root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');
  const card=el('div','cude-ob-card');const poster=el('div','cude-ob-poster');const inner=el('div');inner.append(el('small','',T('Introducing','Tanıştırıyoruz')),logo(78),el('b','','Cude IDE'));poster.appendChild(inner);
  const close=el('button','cude-ob-close','×');close.setAttribute('aria-label',T('Close','Kapat'));
  const cb=el('div','cude-ob-cardbody');cb.appendChild(el('p','',T('An AI-native IDE that works with any model: your own providers, models on your PC, or agent apps like Claude Code, Codex and Claude Desktop. Plan, build and review with Cude AI and Cuets.','Her modelle çalışan, yapay zekâ odaklı bir IDE: kendi sağlayıcıların, bilgisayarındaki modeller ya da Claude Code, Codex ve Claude Desktop gibi ajan uygulamaları. Cude AI ve Cuets ile planla, kur ve gözden geçir.')));
  const go=el('button','cude-ob-btn primary',T('Get started','Başlayalım'));cb.appendChild(go);card.append(poster,close,cb);root.appendChild(card);
  const done=()=>{root.remove();document.removeEventListener('keydown',esc,true);run('cude-ai.chat');};
  const esc=e=>{if(e.key==='Escape'){e.stopPropagation();done();}};
  close.onclick=done;go.onclick=done;root.addEventListener('mousedown',e=>{if(e.target===root)done();});document.addEventListener('keydown',esc,true);
  document.body.appendChild(root);go.focus();
 }
 globalThis.cudeShowOnboarding=v=>{if(v==='intro')intro();else wizard();};
 const start=()=>{let done=false;try{done=localStorage.getItem(DONE)==='1';}catch{}if(done)return;
  const wait=setInterval(()=>{if(document.querySelector('.monaco-workbench .part.activitybar')&&globalThis.cudeCommandService){clearInterval(wait);setTimeout(wizard,600);}},400);setTimeout(()=>clearInterval(wait),60000);};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
