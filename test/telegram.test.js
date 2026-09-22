import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../lib/ledger.js';
import { Telegram, splitMessage } from '../lib/telegram.js';
import { safeError } from '../lib/worker.js';
import { StudyWorker } from '../lib/study.js';

function fixture(t) {
  const ledger = new Ledger(':memory:'); t.after(() => ledger.close());
  let clock = 1000000;
  const calls = [], waits = [];
  const token = '123456789:' + 'X'.repeat(35);
  const allowedPhones=['5511999999999','5511888888888','5511777777777'];
  const telegram = new Telegram({token, ledger, allowedPhones, now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
    fetchImpl: async (url, options) => {
      const method = url.split('/').at(-1), body = JSON.parse(options.body); calls.push({method, body});
      const result = method === 'getMe' ? { id: 123456789, is_bot: true, username: 'MedicineTestBot', first_name: 'Medicina' }
        : method === 'getWebhookInfo' ? { url: '' } : { message_id: calls.length, chat: {id: Number(body.chat_id)} };
      return {ok: true, status: 200, json: async () => ({ok: true, result})};
    }});
  for(const [i,id] of [100,200,300].entries()) ledger.db.prepare('INSERT INTO telegram_authorized_chats VALUES (?,?)').run(String(id),allowedPhones[i]);
  const update = (id, text, type = 'private') => ({update_id: 10, message: {chat: {id, type}, from: {id, first_name: 'Pessoa'}, text}});
  return {ledger, telegram, calls, waits, update, advance: ms => clock += ms};
}

test('only a private start with the current secret binds one recipient', async t => {
  const f = fixture(t); await f.telegram.validate(); f.telegram.newPairing();
  const nonce = f.ledger.get('telegram_pair');
  for (const update of [f.update(100, '/start'), f.update(100, '/start ' + 'Z'.repeat(32)), f.update(100, '/start ' + nonce, 'group')]) {
    const reply=f.telegram.handleUpdate(update);
    if(update.message.chat.type==='private') assert.equal(reply.study,true);else assert.equal(reply,null);
    assert.equal(f.telegram.target, '');
  }
  assert.match(f.telegram.handleUpdate(f.update(100, '/start ' + nonce)), /conectado/);
  assert.equal(f.telegram.target, '100'); assert.equal(f.telegram.pairingLink(), null);
  assert.equal(f.telegram.handleUpdate(f.update(200, '/start ' + nonce)).study, true);
  assert.equal(f.telegram.target, '100');
  await assert.rejects(f.telegram.send('200', 'Resposta privada'), /não autorizada/);
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('expired and rotated pairing links cannot bind a chat', async t => {
  const f = fixture(t); await f.telegram.validate(); f.telegram.newPairing();
  const old = f.ledger.get('telegram_pair'); f.advance(31 * 60000);
  assert.equal(f.telegram.pairingLink(), null); assert.equal(f.telegram.handleUpdate(f.update(100, '/start ' + old)).study, true);assert.equal(f.telegram.target,'');
  f.telegram.newPairing(); assert.equal(f.telegram.handleUpdate(f.update(100, '/start ' + old)).study, true);assert.equal(f.telegram.target,'');
});

test('an expected phone requires the sender own contact and rejects the administrative account', async t => {
  const f=fixture(t);f.telegram.expectedPhone='5511999999999';await f.telegram.validate();f.telegram.newPairing();
  const nonce=f.ledger.get('telegram_pair');
  assert.equal(f.telegram.handleUpdate(f.update(100,'/start '+nonce)).contact,true);assert.equal(f.telegram.target,'');
  const u=f.update(100,'');u.message.contact={user_id:100,phone_number:'+5511888888888'};
  assert.match(f.telegram.handleUpdate(u).text,/não é o destino/);assert.equal(f.telegram.target,'');
  u.message.contact={user_id:200,phone_number:'+5511999999999'};
  assert.equal(f.telegram.handleUpdate(u),null);assert.equal(f.telegram.target,'');
  f.telegram.handleUpdate(f.update(200,'/start '+nonce));
  const correct=f.update(200,'');correct.message.contact={user_id:200,phone_number:'+5511999999999'};
  assert.match(f.telegram.handleUpdate(correct),/conectado/);assert.equal(f.telegram.target,'200');
});

test('long Unicode responses are delivered in order without truncation or broken characters', async t => {
  const f = fixture(t); await f.telegram.validate(); f.ledger.set('telegram_chat_id', '100');
  const answer = 'Análise 🩺 com acentuação.\n'.repeat(500);
  const result = await f.telegram.send('100', answer);
  const sent = f.calls.filter(c => c.method === 'sendMessage');
  assert.equal(sent.map(c => c.body.text).join(''), answer);
  assert.ok(sent.every(c => c.body.text.length <= 4096 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c.body.text)));
  assert.equal(result.id.split(',').length, sent.length);
  assert.ok(f.waits.every(ms => ms >= 1100));
  assert.equal(splitMessage(' x ').join(''), ' x ');
});

test('only the answer letter is bold and explanation markup remains literal', async t => {
  const f = fixture(t); await f.telegram.validate(); f.ledger.set('telegram_chat_id', '100');
  const text = 'Resposta letra: A\n\nJustificativa curta com <, >, & e _texto_ 🩺.';
  await f.telegram.send('100', text);
  await f.telegram.send('100', 'Resposta:\n\nNão é possível ler as alternativas.');
  const sent = f.calls.filter(c => c.method === 'sendMessage');
  assert.equal(sent[0].body.text, text);
  assert.deepEqual(sent[0].body.entities, [{type:'bold', offset:'Resposta letra: '.length, length:1}]);
  assert.equal(text.slice(sent[0].body.entities[0].offset, sent[0].body.entities[0].offset+1), 'A');
  assert.equal(sent[0].body.parse_mode, undefined);
  assert.equal(sent[1].body.entities, undefined);
});

test('study replies reference the incoming message without altering screenshot formatting',async t=>{
  const f=fixture(t);await f.telegram.validate();f.ledger.set('telegram_chat_id','100');
  await f.telegram.send('100','Conceito.\n• Pista.',{replyTo:123});
  assert.deepEqual(f.calls.find(c=>c.method==='sendMessage').body.reply_parameters,{message_id:123,allow_sending_without_reply:true});
});

test('plain text from verified authorized senders reaches the study handler',async t=>{
  const f=fixture(t);await f.telegram.validate();f.ledger.set('telegram_chat_id','100');const received=[];f.telegram.onText=message=>received.push(message);
  for(const update of [f.update(100,'SIRS','group'),f.update(100,'/status'),f.update(100,'/unknown'),f.update(100,'  ')]) f.telegram.handleUpdate(update);
  assert.equal(received.length,0);
  const update=f.update(100,'  SIRS  ');update.message.message_id=25;
  assert.equal(f.telegram.handleUpdate(update),null);
  assert.deepEqual(received,[{updateId:10,chatId:'100',messageId:25,text:'SIRS'}]);
  const other=f.update(200,'Asma');other.message.message_id=26;
  f.telegram.handleUpdate(other);
  assert.deepEqual(received[1],{updateId:10,chatId:'200',messageId:26,text:'Asma'});
  assert.equal(f.telegram.target,'100');
});

test('authorized study messages stay in their originating chat and cannot receive Drive deliveries',async t=>{
  const f=fixture(t);await f.telegram.validate();f.ledger.set('telegram_chat_id','100');
  const study=new StudyWorker({ledger:f.ledger,canReply:chat=>f.telegram.canStudy(chat),isReady:()=>f.telegram.connected,answer:async topic=>'Tema: '+topic,send:(...args)=>f.telegram.sendStudy(...args)});
  f.telegram.onText=message=>study.enqueue(message);
  for(const [id,topic] of [[200,'SIRS'],[300,'DPOC']]) {
    const update=f.update(id,topic);update.update_id=id;update.message.message_id=id+1;
    f.telegram.handleUpdate(update);f.telegram.handleUpdate(update);
  }
  await study.tick();
  const sent=f.calls.filter(c=>c.method==='sendMessage').map(c=>c.body);
  assert.deepEqual(sent.map(m=>[m.chat_id,m.text,m.reply_parameters.message_id]),[['200','Tema: SIRS',201],['300','Tema: DPOC',301]]);
  assert.equal(study.status().counts.sent,2);assert.equal(f.telegram.target,'100');
  await assert.rejects(f.telegram.send('200','Print privado'),/não autorizada/);
  await assert.rejects(f.telegram.sendStudy('999','Não solicitada'),/não autorizada/);
  await assert.rejects(f.telegram.sendStudy('-100','Grupo'),/não autorizada/);
  const restored=new Telegram({ledger:f.ledger,token:f.telegram.token,allowedPhones:[...f.telegram.allowedPhones]});assert.equal(restored.canStudy('200'),true);
});

test('authorized study works before Drive pairing and rejects spoofed senders and groups',async t=>{
  const f=fixture(t);await f.telegram.validate();
  const spoof=f.update(400,'SIRS');spoof.message.from.id=401;
  const bot=f.update(500,'SIRS');bot.message.from.is_bot=true;
  for(const update of [spoof,bot,f.update(-600,'SIRS','supergroup')]) assert.equal(f.telegram.handleUpdate(update),null);
  assert.equal(f.telegram.canStudy('400'),false);assert.equal(f.telegram.canStudy('500'),false);
  const reply=f.telegram.handleUpdate(f.update(200,'/start'));
  assert.equal(reply.chat,'200');assert.equal(reply.study,true);assert.equal(reply.text.includes('Prints medicina'),false);
  await f.telegram.sendStudy(reply.chat,reply.text);
  assert.equal(f.telegram.connected,true);assert.equal(f.telegram.ready,false);assert.equal(f.telegram.target,'');
  assert.equal(f.calls.find(c=>c.method==='sendMessage').body.chat_id,'200');
});

test('polling sends authorized greetings to the sender and one blocked user does not disable others',async t=>{
  const f=fixture(t);await f.telegram.validate();f.ledger.set('telegram_chat_id','100');
  let polls=0;const normal=f.telegram.fetchImpl;
  f.telegram.fetchImpl=async(url,options)=>{
    if(url.endsWith('getUpdates')) {
      if(++polls===1)return {ok:true,json:async()=>({ok:true,result:[f.update(200,'/start'),{...f.update(300,'/start'),update_id:11}]})};
      f.telegram.controller.abort();throw new Error('stopped');
    }
    if(url.endsWith('sendMessage') && JSON.parse(options.body).chat_id==='200') return {ok:false,status:403,json:async()=>({ok:false,error_code:403})};
    return normal(url,options);
  };
  f.telegram.start();await f.telegram.task;
  assert.deepEqual(f.calls.filter(c=>c.method==='sendMessage').map(c=>c.body.chat_id),['300']);
  assert.equal(f.telegram.error,null);assert.equal(f.telegram.target,'100');
});

test('incoming study text is committed before acknowledging its Telegram offset',async t=>{
  const f=fixture(t);await f.telegram.validate();f.ledger.set('telegram_chat_id','100');
  const update=f.update(100,'SIRS');update.message.message_id=25;let persisted=false,polls=0;
  f.telegram.onText=()=>{assert.equal(f.ledger.get('telegram_offset'),undefined);persisted=true;};
  f.telegram.fetchImpl=async()=>{
    if(++polls===1)return {ok:true,json:async()=>({ok:true,result:[update]})};
    assert.equal(persisted,true);assert.equal(f.ledger.get('telegram_offset'),'11');
    f.telegram.controller.abort();throw new Error('stopped');
  };
  f.telegram.start();await f.telegram.task;
});

test('explicit rate limits wait and retry; ambiguous partial delivery is not replayed', async t => {
  const f = fixture(t); await f.telegram.validate(); f.ledger.set('telegram_chat_id', '100');
  const normal = f.telegram.fetchImpl; let calls = 0;
  f.telegram.fetchImpl = async (...args) => {
    calls++;
    if(calls === 1) return {ok: false, status: 429, json: async () => ({ok: false, error_code: 429, parameters: {retry_after: 2}})};
    return normal(...args);
  };
  await f.telegram.send('100', 'Resposta'); assert.equal(calls, 2); assert.ok(f.waits.includes(2000));
  calls = 0;
  f.telegram.fetchImpl = async (...args) => { calls++; if(calls === 2) throw new Error('network lost'); return normal(...args); };
  await assert.rejects(f.telegram.send('100', 'A'.repeat(8000)), /network lost/);
  assert.equal(calls, 2);
});

test('a bot already using a webhook is not taken over', async t => {
  const f = fixture(t), normal = f.telegram.fetchImpl;
  f.telegram.fetchImpl = async (url, options) => url.endsWith('getWebhookInfo') ? {ok: true, json: async () => ({ok: true, result: {url: 'https://existing.example/webhook'}})} : normal(url, options);
  await assert.rejects(f.telegram.validate(), /outro serviço/);
  assert.equal(f.telegram.bot, null);
  assert.ok(f.calls.every(c => !['deleteWebhook','setWebhook'].includes(c.method)));
});

test('polling persists binding and offset before the confirmation; a new instance retains the recipient', async t => {
  const f = fixture(t); await f.telegram.validate(); f.telegram.newPairing();
  const update = f.update(100, '/start ' + f.ledger.get('telegram_pair')), normal = f.telegram.fetchImpl;
  let polls = 0;
  f.telegram.fetchImpl = async (url, options) => {
    if(url.endsWith('getUpdates')) {
      if(++polls === 1) return {ok: true, json: async () => ({ok: true, result: [update]})};
      f.telegram.controller.abort(); throw new Error('stopped');
    }
    if(url.endsWith('sendMessage')) assert.equal(f.ledger.get('telegram_offset'), '11');
    return normal(url, options);
  };
  f.telegram.start(); await f.telegram.task;
  const restored = new Telegram({ledger: f.ledger, token: f.telegram.token});
  assert.equal(restored.target, '100'); assert.equal(f.ledger.get('telegram_offset'), '11');
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.equal(JSON.stringify(f.telegram.publicStatus()).includes(f.telegram.token), false);
  assert.equal(safeError(new Error(f.telegram.token)).includes(f.telegram.token), false);
});

 test('restriction ignores historical public chats, forged contacts, other numbers and queued messages',async t=>{
  const f=fixture(t);await f.telegram.validate();
  f.ledger.db.prepare('INSERT INTO telegram_private_chats VALUES (?,?)').run('900',1);
  const received=[];f.telegram.onText=m=>received.push(m);
  assert.equal(f.telegram.canStudy('900'),false);
  assert.equal(f.telegram.handleUpdate(f.update(900,'SIRS')),null);
  assert.equal(f.telegram.handleUpdate(f.update(900,'/help')),null);
  assert.equal(f.telegram.handleUpdate(f.update(900,'/start')).contact,true);
  for(const contact of [{user_id:100,phone_number:'5511999999999'},{user_id:900,phone_number:'5511666666666'}]) {
    const u=f.update(900,'');u.message.contact=contact;assert.equal(f.telegram.handleUpdate(u),null);
  }
  assert.equal(received.length,0);assert.equal(f.telegram.canStudy('900'),false);
  await assert.rejects(f.telegram.sendStudy('900','denied'),/não autorizada/);
  const study=new StudyWorker({ledger:f.ledger,canReply:c=>f.telegram.canStudy(c),isReady:()=>f.telegram.connected,answer:async()=>{throw Error('must not analyze');},send:async()=>{throw Error('must not send');}});
  f.ledger.db.prepare("INSERT INTO study_messages(update_id,chat_id,source_message_id,topic,status,updated) VALUES (999,'900',1,'old','queued',1)").run();
  await study.tick();assert.equal(study.status().counts.failed,1);
});

test('own contact authorizes only listed phones, persists, and is revoked when list changes',async t=>{
  const f=fixture(t);await f.telegram.validate();
  const u=f.update(900,'');u.message.contact={user_id:900,phone_number:'+55 (11) 99999-9999'};
  u.message.forward_origin={type:'user'};assert.equal(f.telegram.handleUpdate(u),null);
  delete u.message.forward_origin;f.telegram.handleUpdate(u);assert.equal(f.telegram.canStudy('900'),true);
  assert.equal(f.telegram.canStudy('100'),false);
  const restored=new Telegram({ledger:f.ledger,allowedPhones:['5511999999999']});assert.equal(restored.canStudy('900'),true);
  const revoked=new Telegram({ledger:f.ledger,allowedPhones:[]});assert.equal(revoked.canStudy('900'),false);
  f.ledger.set('telegram_chat_id','800');f.ledger.set('telegram_verified_phone','5511999999999');
  assert.equal(restored.canStudy('800'),true);assert.equal(revoked.canStudy('800'),false);
});
