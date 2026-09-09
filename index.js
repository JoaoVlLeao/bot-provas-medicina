import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes,createHash,timingSafeEqual } from 'node:crypto';
import { Telegram } from './lib/telegram.js';
import { Ledger } from './lib/ledger.js';
import { Drive } from './lib/drive.js';
import { Worker,safeError } from './lib/worker.js';
import { createAnalyzer,createStudyTutor } from './lib/gemini.js';
import { StudyWorker } from './lib/study.js';
import { panel,login,script,style } from './lib/panel.js';

process.umask(0o077);
const dataDir=path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || '.data');
fs.mkdirSync(dataDir,{recursive:true});
const ledger=new Ledger(path.join(dataDir,'bot.sqlite'));
const folderId=process.env.DRIVE_FOLDER_ID || '';
if(folderId && !/^[\w-]+$/.test(folderId)) throw new Error('DRIVE_FOLDER_ID inválido.');
const model=process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const credentialPath=path.join(dataDir,'google-service-account.json');
const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : fs.existsSync(credentialPath)?JSON.parse(fs.readFileSync(credentialPath,'utf8')):undefined;
let drive=new Drive({folderId,credentials,refreshToken:process.env.GOOGLE_REFRESH_TOKEN,clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET});
const port=Number(process.env.PORT || 3050);
const testMode=process.env.BOT_TEST_MODE==='true' && !process.env.RAILWAY_SERVICE_ID;
const storageReady=!process.env.RAILWAY_SERVICE_ID || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR);
const telegramPath=path.join(dataDir,'telegram.json');
const expectedPhone=String(process.env.TARGET_TELEGRAM_NUMBER || process.env.TARGET_WHATSAPP_NUMBER || '').replace(/\D/g,'');
if(expectedPhone && !/^\d{10,15}$/.test(expectedPhone)) throw new Error('Número de destino inválido.');
const telegramConfig=fs.existsSync(telegramPath)?JSON.parse(fs.readFileSync(telegramPath,'utf8')):{};
let telegram=new Telegram({token:process.env.TELEGRAM_BOT_TOKEN || telegramConfig.token,ledger,expectedPhone});
let stopping=false,configuringTelegram=false;
const study=new StudyWorker({ledger,answer:createStudyTutor({apiKey:process.env.GEMINI_API_KEY,model}),send:(...args)=>telegram.send(...args),target:()=>telegram.target,isReady:()=>telegram.ready && storageReady && !stopping});
const receiveText=message=>{study.enqueue(message);};
telegram.onText=receiveText;
const worker=new Worker({ledger,drive,target:()=>telegram.target,analyze:createAnalyzer({apiKey:process.env.GEMINI_API_KEY,model}),isReady:()=>telegram.ready && storageReady && !stopping,send:(target,answer)=>telegram.send(target,answer)});

const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use(express.urlencoded({extended:false,limit:'2kb'}));app.use(express.json({limit:'32kb'}));
app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});next();});
app.get('/health',(_req,res)=>res.status(storageReady?200:503).json({ok:storageReady}));
app.get('/style.css',(_req,res)=>res.type('css').send(style));
const code=randomBytes(24).toString('base64url');const codeExpiry=Date.now()+30*60000;let codeUsed=false;
const sha=value=>createHash('sha256').update(value).digest('hex');
let failures=[];
function authenticated(req) {const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('bot_session='))?.slice(12);return Boolean(token && ledger.db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(sha(token),Date.now()));}
function sameOrigin(req) {return req.get('origin')===`${req.protocol}://${req.get('host')}`;}
app.get('/login',(_req,res)=>res.type('html').send(login));
app.post('/login',(req,res)=>{
  if(!sameOrigin(req)) return res.sendStatus(403);
  failures=failures.filter(t=>Date.now()-t<60000);if(failures.length>=10) return res.status(429).send('Aguarde um minuto antes de tentar novamente.');
  const supplied=Buffer.from(sha(String(req.body.code||'')));const expected=Buffer.from(sha(code));
  if(codeUsed || Date.now()>codeExpiry || !timingSafeEqual(supplied,expected)) {failures.push(Date.now());return res.status(401).send('Código inválido ou expirado.');}
  const token=randomBytes(32).toString('base64url');ledger.db.prepare('INSERT INTO sessions VALUES (?,?)').run(sha(token),Date.now()+30*86400000);codeUsed=true;
  res.cookie('bot_session',token,{httpOnly:true,secure:req.secure,sameSite:'strict',maxAge:30*86400000,path:'/'});res.redirect('/');
});
app.use((req,res,next)=>{if(!authenticated(req))return req.path.startsWith('/api/')?res.sendStatus(401):res.redirect('/login');if(req.method==='POST'&&!sameOrigin(req))return res.sendStatus(403);next();});
app.get('/',(_req,res)=>res.type('html').send(panel));
app.get('/panel.js',(_req,res)=>res.type('js').send(script));
app.get('/api/status',(_req,res)=>res.json({channel:'telegram',telegram:telegram.publicStatus(),study:study.status(),model,storageReady,driveConfigured:drive.configured,driveAccount:drive.email,driveFolder:folderId,driveError:worker.error,lastScan:worker.lastScan,initialized:ledger.get('initialized')||null,paused:ledger.get('paused')==='true',counts:ledger.counts(),recent:ledger.recent(),geminiConfigured:Boolean(process.env.GEMINI_API_KEY)}));
app.post('/api/telegram-token',async(req,res)=>{
  if(!storageReady) return res.status(409).json({error:'Configure primeiro o armazenamento persistente.'});
  if(telegram.configured) return res.status(409).json({error:'Um bot já está configurado. Use a conexão existente.'});
  if(configuringTelegram || worker.busy) return res.status(409).json({error:'Aguarde a verificação em andamento e tente novamente.'});
  configuringTelegram=true;
  const candidate=new Telegram({token:String(req.body.token || '').trim(),ledger,expectedPhone,onText:receiveText});
  try {
    await candidate.validate();
    await telegram.stop();
    fs.writeFileSync(telegramPath+'.tmp',JSON.stringify({token:candidate.token}),{mode:0o600});fs.renameSync(telegramPath+'.tmp',telegramPath);
    candidate.newPairing();telegram=candidate;
    if(!testMode) telegram.start();
    res.json({ok:true,telegram:telegram.publicStatus()});
  } catch(e) {await candidate.stop();res.status(400).json({error:safeError(e)});}
  finally {configuringTelegram=false;}
});
app.post('/api/telegram-pair',(_req,res)=>{
  if(!telegram.bot || telegram.target) return res.status(409).json({error:'Verifique a configuração do Telegram.'});
  telegram.newPairing();res.json({ok:true,telegram:telegram.publicStatus()});
});
app.post('/api/drive-credentials',async(req,res)=>{
  const supplied=req.body.credentials;
  if(!storageReady) return res.status(409).json({error:'Configure primeiro o armazenamento persistente.'});
  if(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return res.status(409).json({error:'O acesso está configurado nas variáveis do Railway.'});
  if(!supplied || supplied.type!=='service_account' || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(supplied.client_email||'') || !String(supplied.private_key||'').startsWith('-----BEGIN PRIVATE KEY-----')) return res.status(400).json({error:'Selecione o arquivo JSON da conta de serviço do bot.'});
  if(worker.busy) return res.status(409).json({error:'Aguarde a verificação em andamento e tente novamente.'});
  try {
    const clean={type:'service_account',project_id:supplied.project_id,client_email:supplied.client_email,private_key:supplied.private_key,private_key_id:supplied.private_key_id};
    const candidate=new Drive({folderId,credentials:clean});
    const files=await candidate.list();
    fs.writeFileSync(credentialPath+'.tmp',JSON.stringify(clean),{mode:0o600});fs.renameSync(credentialPath+'.tmp',credentialPath);
    ledger.discover(files);drive=candidate;worker.drive=drive;worker.lastScan=new Date().toISOString();worker.error=null;
    res.json({ok:true,files:files.length});
  } catch(e) {res.status(400).json({error:safeError(e)});}
});
app.post('/api/pause',(req,res)=>{ledger.set('paused',req.body.paused===true?'true':'false');res.json({ok:true});});
app.use((err,_req,res,_next)=>{console.error(safeError(err));res.status(500).json({error:'Falha ao atender a solicitação.'});});
const server=app.listen(port,'0.0.0.0',()=>{console.log(`Painel ativo na porta ${server.address().port}.`);console.log(`PANEL_ACCESS_CODE=${code}`);console.log('Código de acesso de uso único; expira em 30 minutos.');});
const timer=setInterval(()=>void worker.tick(),Math.max(10000,Number(process.env.DRIVE_POLL_MS)||15000));
const studyTimer=testMode?null:setInterval(()=>void study.tick(),1000);
if(!testMode){void worker.tick();if(storageReady) telegram.start();}
async function shutdown(){if(stopping)return;stopping=true;clearInterval(timer);clearInterval(studyTimer);server.close();await telegram.stop();await study.task;ledger.close();process.exit(0);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
