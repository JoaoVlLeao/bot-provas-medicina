import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes,createHash,timingSafeEqual } from 'node:crypto';
import wwebjs from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { Ledger } from './lib/ledger.js';
import { Drive } from './lib/drive.js';
import { Worker,safeError } from './lib/worker.js';
import { createAnalyzer } from './lib/gemini.js';
import { panel,login,script,style } from './lib/panel.js';

process.umask(0o077);
const dataDir=path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || '.data');
fs.mkdirSync(dataDir,{recursive:true});
const ledger=new Ledger(path.join(dataDir,'bot.sqlite'));
const folderId=process.env.DRIVE_FOLDER_ID || '';
if(folderId && !/^[\w-]+$/.test(folderId)) throw new Error('DRIVE_FOLDER_ID inválido.');
const target=(process.env.TARGET_WHATSAPP_NUMBER || '').replace(/\D/g,'');
if(target && !/^\d{10,15}$/.test(target)) throw new Error('Número de destino inválido.');
const model=process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const credentialPath=path.join(dataDir,'google-service-account.json');
const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : fs.existsSync(credentialPath)?JSON.parse(fs.readFileSync(credentialPath,'utf8')):undefined;
let drive=new Drive({folderId,credentials,refreshToken:process.env.GOOGLE_REFRESH_TOKEN,clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET});
const port=Number(process.env.PORT || 3050);
const testMode=process.env.BOT_TEST_MODE==='true' && !process.env.RAILWAY_SERVICE_ID;
const storageReady=!process.env.RAILWAY_SERVICE_ID || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR);
const status={whatsapp:'iniciando',qr:null,error:null,connectedNumber:null};
let client,initializing=false,stopping=false,reconnectTimer;

async function initializeWhatsApp() {
  if(initializing || stopping || testMode || !storageReady || status.whatsapp==='conectado') return;
  initializing=true;status.error=null;status.whatsapp='iniciando';status.qr=null;
  try {
    if(client) {await client.destroy().catch(()=>{});client.removeAllListeners();}
    const sessionDir=path.join(dataDir,'whatsapp','session');
    // Chromium leaves only these process locks after a container is replaced.
    for(const name of ['SingletonLock','SingletonSocket','SingletonCookie']) fs.rmSync(path.join(sessionDir,name),{force:true});
    client=new wwebjs.Client({authStrategy:new wwebjs.LocalAuth({dataPath:path.join(dataDir,'whatsapp')}),puppeteer:{headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || undefined,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']},qrMaxRetries:0});
    client.on('qr',async qr=>{status.whatsapp='aguardando QR Code';status.connectedNumber=null;status.qr=await QRCode.toDataURL(qr,{width:320,margin:2});});
    client.on('authenticated',()=>{status.whatsapp='autenticando';status.qr=null;});
    client.on('ready',()=>{status.whatsapp='conectado';status.connectedNumber=client.info?.wid?.user || null;status.qr=null;status.error=null;console.log('WhatsApp conectado.');void worker.tick();});
    client.on('auth_failure',()=>{status.whatsapp='falha de autenticação';status.qr=null;status.error='A conexão precisa ser refeita.';});
    client.on('disconnected',()=>{status.whatsapp='desconectado';status.qr=null;clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>void initializeWhatsApp(),15000);});
    await client.initialize();
  } catch(e) {status.whatsapp='erro ao iniciar';status.error=safeError(e);console.error('Não foi possível iniciar o WhatsApp:',safeError(e));}
  finally {initializing=false;}
}
const worker=new Worker({ledger,drive,target,analyze:createAnalyzer({apiKey:process.env.GEMINI_API_KEY,model}),isReady:()=>status.whatsapp==='conectado' && Boolean(target) && !stopping,send:async(number,answer)=>{
  const id=await client.getNumberId(number);if(!id) throw new Error('O número de destino não está disponível no WhatsApp.');
  return client.sendMessage(id._serialized,answer,{sendSeen:false});
}});

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
app.get('/api/status',(_req,res)=>res.json({whatsapp:status.whatsapp,hasQr:Boolean(status.qr),whatsappError:status.error,connectedNumber:status.connectedNumber,target,model,storageReady,driveConfigured:drive.configured,driveAccount:drive.email,driveFolder:folderId,driveError:worker.error,lastScan:worker.lastScan,initialized:ledger.get('initialized')||null,paused:ledger.get('paused')==='true',counts:ledger.counts(),recent:ledger.recent(),geminiConfigured:Boolean(process.env.GEMINI_API_KEY)}));
app.get('/api/qr',(_req,res)=>{if(!status.qr)return res.sendStatus(404);res.type('png').send(Buffer.from(status.qr.split(',')[1],'base64'));});
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
app.post('/api/reconnect',(_req,res)=>{if(!initializing && status.whatsapp!=='conectado')void initializeWhatsApp();res.json({ok:true});});
app.use((err,_req,res,_next)=>{console.error(safeError(err));res.status(500).json({error:'Falha ao atender a solicitação.'});});
const server=app.listen(port,'0.0.0.0',()=>{console.log(`Painel ativo na porta ${server.address().port}.`);console.log(`PANEL_ACCESS_CODE=${code}`);console.log('Código de acesso de uso único; expira em 30 minutos.');});
const timer=setInterval(()=>void worker.tick(),Math.max(10000,Number(process.env.DRIVE_POLL_MS)||15000));
if(!testMode){void worker.tick();void initializeWhatsApp();}
else {status.whatsapp='modo de teste';}
async function shutdown(){if(stopping)return;stopping=true;clearInterval(timer);clearTimeout(reconnectTimer);server.close();await client?.destroy().catch(()=>{});ledger.close();process.exit(0);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
