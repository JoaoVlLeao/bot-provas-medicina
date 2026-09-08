import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../lib/ledger.js';
import { Telegram, splitMessage } from '../lib/telegram.js';
import { safeError } from '../lib/worker.js';

function fixture(t) {
  const ledger = new Ledger(':memory:'); t.after(() => ledger.close());
  let clock = 1000000;
  const calls = [], waits = [];
  const token = '123456789:' + 'X'.repeat(35);
  const telegram = new Telegram({token, ledger, now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
    fetchImpl: async (url, options) => {
      const method = url.split('/').at(-1), body = JSON.parse(options.body); calls.push({method, body});
      const result = method === 'getMe' ? { id: 123456789, is_bot: true, username: 'MedicineTestBot', first_name: 'Medicina' }
        : method === 'getWebhookInfo' ? { url: '' } : { message_id: calls.length, chat: {id: Number(body.chat_id)} };
      return {ok: true, status: 200, json: async () => ({ok: true, result})};
    }});
  const update = (id, text, type = 'private') => ({update_id: 10, message: {chat: {id, type}, from: {id, first_name: 'Pessoa'}, text}});
  return {ledger, telegram, calls, waits, update, advance: ms => clock += ms};
}

test('only a private start with the current secret binds one recipient', async t => {
  const f = fixture(t); await f.telegram.validate(); f.telegram.newPairing();
  const nonce = f.ledger.get('telegram_pair');
  for (const update of [f.update(100, '/start'), f.update(100, '/start ' + 'Z'.repeat(32)), f.update(100, '/start ' + nonce, 'group')]) {
    assert.equal(f.telegram.handleUpdate(update), null); assert.equal(f.telegram.target, '');
  }
  assert.match(f.telegram.handleUpdate(f.update(100, '/start ' + nonce)), /conectado/);
  assert.equal(f.telegram.target, '100'); assert.equal(f.telegram.pairingLink(), null);
  assert.equal(f.telegram.handleUpdate(f.update(200, '/start ' + nonce)), null);
  assert.equal(f.telegram.target, '100');
  await assert.rejects(f.telegram.send('200', 'Resposta privada'), /não autorizada/);
  assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('expired and rotated pairing links cannot bind a chat', async t => {
  const f = fixture(t); await f.telegram.validate(); f.telegram.newPairing();
  const old = f.ledger.get('telegram_pair'); f.advance(31 * 60000);
  assert.equal(f.telegram.pairingLink(), null); assert.equal(f.telegram.handleUpdate(f.update(100, '/start ' + old)), null);
  f.telegram.newPairing(); assert.equal(f.telegram.handleUpdate(f.update(100, '/start ' + old)), null);
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
