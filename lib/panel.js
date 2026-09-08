const shell=(title,body,js='')=>`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/style.css"></head><body><main>${body}</main>${js}</body></html>`;
export const login=shell('Acesso · Bot Medicina',`<div class="brand">MEDICINA · ASSISTENTE DE ESTUDOS</div><h1>Acessar o painel</h1><p>Use o código de acesso fornecido na configuração do bot.</p><form method="post" action="/login"><label for="code">Código de acesso</label><input id="code" name="code" type="password" required autocomplete="one-time-code"><button>Entrar</button></form>`);
export const panel=shell('Conectar Telegram · Bot Medicina',`
<div class="brand">MEDICINA · ASSISTENTE DE ESTUDOS</div>
<h1>Seu print. Sua resposta.</h1>
<p class="lead">Capturas do Google Drive, analisadas pela IA e respondidas no Telegram.</p>
<section class="grid"><article class="card">
<span class="step">01 · TELEGRAM</span><h2>Conecte seu Telegram</h2>
<p id="telegram-state" class="badge">Verificando…</p>
<div id="telegram-setup" hidden>
<p>Crie um bot exclusivo em <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>, usando o comando /newbot. Cole abaixo o token recebido.</p>
<label for="telegram-token">Token do bot</label><input id="telegram-token" type="password" autocomplete="off" spellcheck="false">
<button id="connect-telegram">Conectar bot</button><p id="telegram-setup-result"></p>
</div>
<div id="telegram-pair" hidden><p>Abra o link abaixo com a conta que receberá as respostas e toque em <strong>Iniciar</strong>.</p>
<a id="pair-link" class="button-link" target="_blank" rel="noopener">Abrir meu bot no Telegram ↗</a>
<button id="renew-pair" hidden>Gerar novo link de conexão</button>
<p class="note">Esse link é privado e vale por 30 minutos. Depois da conexão, o bot enviará as respostas apenas para a sua conversa.</p></div>
<p id="telegram-error" class="error"></p><p id="telegram-connected"></p>
<p id="telegram-info" class="note">O servidor usa a API oficial do Telegram. Depois da configuração, o Telegram Web pode ficar fechado.</p>
</article><article class="card"><span class="step">02 · GOOGLE DRIVE</span><h2>Capturas automáticas</h2>
<p id="drive" class="badge">Verificando…</p><p>Salve os prints do Chromebook na pasta <a id="folder" target="_blank" rel="noopener">Prints medicina ↗</a>.</p>
<p id="driveerror" class="error"></p><p id="account" class="note"></p>
<div id="drive-setup" hidden><label for="credential-file">Arquivo de acesso à pasta</label><input id="credential-file" type="file" accept=".json,application/json"><button id="connect-drive">Conectar Google Drive</button><p id="setup-result"></p></div>
<p id="lastscan"></p><div class="note">A verificação ocorre a cada 15 segundos. As imagens anteriores à primeira conexão são ignoradas.</div>
<button id="pause" hidden>Pausar monitor</button></article></section>
<section class="card activity"><div class="activityhead"><h2>Atividade</h2><span id="model"></span></div><p id="summary">Aguardando conexão.</p><div id="activity"></div></section>
<footer>Use as respostas como apoio ao estudo e confira as fontes. Uma captura incompleta pode limitar a análise.</footer>`, '<script src="/panel.js" defer></script>');
export const script=`
const el=id=>document.getElementById(id);let paused=false;
const names={baseline:'Anterior à ativação',queued:'Na fila',analyzing:'Analisando',sending:'Enviando',sent:'Enviada',duplicate:'Repetida',uncertain:'Conferir envio',failed:'Falhou'};
async function post(url,body={}){
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(r.status===401){location.href='/login';throw new Error('Entre novamente no painel.');}
 const data=await r.json();if(!r.ok)throw new Error(data.error||'Não foi possível concluir.');return data;
}
async function refresh(){try{
 const r=await fetch('/api/status');if(r.status===401){location.href='/login';return;}const s=await r.json(),t=s.telegram;
 el('telegram-state').textContent=!t.configured?'Aguardando token':t.error?'Verificar conexão':t.ready?'Conectado':!t.username?'Conectando ao Telegram':'Aguardando você iniciar a conversa';
 el('telegram-setup').hidden=t.configured;
 el('telegram-pair').hidden=!t.username||Boolean(t.target);
 el('pair-link').hidden=!t.pairLink;if(t.pairLink)el('pair-link').href=t.pairLink;else el('pair-link').removeAttribute('href');
 el('renew-pair').hidden=Boolean(t.pairLink);
 el('telegram-error').textContent=t.error||'';
 el('telegram-connected').textContent=t.target?'Respostas para '+(t.recipient||'sua conversa')+' · bot @'+t.username:t.username?'Bot @'+t.username:'';
 el('folder').href='https://drive.google.com/drive/folders/'+s.driveFolder;
 el('drive').textContent=!s.driveConfigured?'Aguardando autorização do Drive':s.driveError?'Acesso pendente':!s.initialized?'Conectando à pasta':s.paused?'Monitor pausado':t.ready?'Monitor ativo':'Pronto · aguardando Telegram';
 el('driveerror').textContent=s.driveError||(!s.storageReady?'Armazenamento persistente ainda não configurado.':'');
 el('account').textContent=!s.driveConfigured?'Falta configurar o acesso do bot à pasta.':s.driveAccount?'Conta do bot: '+s.driveAccount:'';
 el('lastscan').textContent=s.lastScan?'Última verificação: '+new Date(s.lastScan).toLocaleTimeString('pt-BR'):'';
 el('drive-setup').hidden=s.driveConfigured;paused=s.paused;el('pause').hidden=!s.initialized;el('pause').textContent=paused?'Retomar monitor':'Pausar monitor';
 el('model').textContent=s.model;el('summary').textContent=(s.counts.sent||0)+' respostas enviadas · '+(s.counts.queued||0)+' na fila · '+(s.counts.uncertain||0)+' envios a conferir';
 el('activity').replaceChildren();for(const f of s.recent.filter(x=>x.status!=='baseline')){
  const row=document.createElement('div');row.className='row';const name=document.createElement('span');name.textContent=f.name;const state=document.createElement('span');state.textContent=names[f.status]||f.status;row.append(name,state);
  if(f.error){const error=document.createElement('small');error.textContent=f.error;row.append(error);}el('activity').append(row);
 }if(!el('activity').children.length)el('activity').textContent='Os próximos prints aparecerão aqui.';
}catch{el('telegram-error').textContent='Reconectando ao painel…';}}
el('pause').onclick=async()=>{try{await post('/api/pause',{paused:!paused});await refresh();}catch(e){el('driveerror').textContent=e.message;}};
el('connect-telegram').onclick=async()=>{
 el('connect-telegram').disabled=true;el('telegram-setup-result').textContent='Verificando o bot…';
 try{await post('/api/telegram-token',{token:el('telegram-token').value.trim()});el('telegram-token').value='';el('telegram-setup-result').textContent='Bot configurado.';await refresh();}
 catch(e){el('telegram-setup-result').textContent=e.message;}finally{el('connect-telegram').disabled=false;}
};
el('renew-pair').onclick=async()=>{try{await post('/api/telegram-pair');await refresh();}catch(e){el('telegram-error').textContent=e.message;}};
el('connect-drive').onclick=async()=>{
 const file=el('credential-file').files[0];if(!file){el('setup-result').textContent='Selecione o arquivo de acesso.';return;}el('connect-drive').disabled=true;el('setup-result').textContent='Verificando acesso à pasta…';
 try{const credentials=JSON.parse(await file.text());const data=await post('/api/drive-credentials',{credentials});el('setup-result').textContent='Drive conectado. '+data.files+' imagens reconhecidas.';el('credential-file').value='';await refresh();}
 catch(e){el('setup-result').textContent=e.message;}finally{el('connect-drive').disabled=false;}
};
refresh();setInterval(refresh,5000);
`;
export const style=`:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#182e31;background:#f3f7f5;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1080px;margin:0 auto;padding:48px 28px}.brand{font-size:12px;font-weight:750;letter-spacing:.15em;color:#457569}h1{font-size:clamp(30px,5vw,44px);letter-spacing:-.045em;margin:16px 0 8px}h2{font-size:22px;letter-spacing:-.025em;margin:12px 0}.lead{color:#657770;max-width:650px;margin:0 0 30px;line-height:1.6}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:white;border:1px solid #dce8e2;border-radius:20px;padding:28px;box-shadow:0 8px 30px #183f2f04}.step{font-size:11px;letter-spacing:.1em;font-weight:700;color:#709283}.badge{display:inline-block;padding:7px 12px;background:#edf5f0;color:#2d6a50;border-radius:30px;font-size:13px;font-weight:600}.note{padding:15px;background:#f6f9f7;border-radius:10px;font-size:13px;line-height:1.6;margin-top:20px;overflow-wrap:anywhere}p,li{line-height:1.6}ol{padding-left:20px;font-size:14px}#qrwrap{text-align:center}#qrwrap ol{text-align:left}#qr{max-width:100%;height:auto}.error{color:#a23d32;font-size:14px;overflow-wrap:anywhere}.error:empty,#connected:empty,#account:empty{display:none}a{color:#267451;text-decoration-thickness:1px;text-underline-offset:3px}button{background:#245e48;color:#fff;border:0;padding:12px 18px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;margin-top:12px}.button-link{display:inline-block;background:#245e48;color:#fff;border-radius:10px;padding:12px 18px;text-decoration:none;font-weight:600}button:disabled{opacity:.6;cursor:wait}button:hover{background:#174b36}.activity{margin-top:20px}.activityhead{display:flex;justify-content:space-between;align-items:center;gap:12px}.activityhead span{font-size:12px;color:#7c8f85}.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;padding:13px 0;border-top:1px solid #edf1ee;font-size:13px}.row span:first-child{overflow-wrap:anywhere;max-width:75%}.row small{width:100%;color:#9b523d}footer{font-size:12px;color:#7d8f86;margin-top:26px;line-height:1.6}form{max-width:460px;background:white;padding:25px;border:1px solid #dce8e2;border-radius:15px}label{display:block;font-size:14px;margin-bottom:10px}input{display:block;width:100%;font:inherit;padding:12px;border:1px solid #b8cbc1;border-radius:8px}#activity:empty{color:#77867e}[hidden]{display:none!important}@media(max-width:760px){main{padding:30px 18px}.grid{grid-template-columns:1fr}.card{padding:22px}.activityhead{align-items:flex-start;flex-direction:column}}`;
