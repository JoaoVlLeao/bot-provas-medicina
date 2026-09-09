import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../lib/ledger.js';
import { StudyWorker } from '../lib/study.js';

const message=(id,text='Choque neurogênico')=>({updateId:id,chatId:'100',messageId:id+100,text});
function fixture(t) {
  const ledger=new Ledger(':memory:');t.after(()=>ledger.close());
  const sends=[],topics=[];let ready=true;
  const worker=new StudyWorker({ledger,target:()=> '100',isReady:()=>ready,answer:async topic=>{topics.push(topic);return 'Explicação de '+topic;},send:async(...args)=>{sends.push(args);return {id:'sent-'+sends.length};}});
  return {ledger,worker,sends,topics,setReady:value=>{ready=value;}};
}

test('authorized text is durable and deduplicated; answers work with Drive paused and reply to each topic',async t=>{
  const f=fixture(t);f.ledger.set('paused','true');
  f.worker.enqueue(message(1));f.worker.enqueue(message(1));f.worker.enqueue({...message(2),chatId:'200'});f.worker.enqueue(message(3,'SIRS'));
  await Promise.all([f.worker.tick(),f.worker.tick()]);await f.worker.tick();
  assert.deepEqual(f.topics,['Choque neurogênico','SIRS']);assert.equal(f.sends.length,2);
  assert.deepEqual(f.sends[0],['100','Explicação de Choque neurogênico',{replyTo:101}]);
  assert.equal(f.worker.status().counts.sent,2);
});

test('disconnecting preserves an already generated answer without another Gemini call',async t=>{
  const f=fixture(t);f.worker.enqueue(message(1));f.setReady(false);await f.worker.tick();assert.equal(f.topics.length,0);
  f.setReady(true);const normal=f.worker.answer;f.worker.answer=async topic=>{const answer=await normal(topic);f.setReady(false);return answer;};
  await f.worker.tick();assert.equal(f.sends.length,0);assert.equal(f.worker.status().counts.queued,1);
  f.setReady(true);await f.worker.tick();assert.equal(f.topics.length,1);assert.equal(f.sends.length,1);
});

test('model failure backs off while ambiguous delivery never replays',async t=>{
  const f=fixture(t);f.worker.enqueue(message(1));f.worker.answer=async()=>{throw new Error('Gemini HTTP 429');};
  await f.worker.tick();await f.worker.tick();assert.equal(f.sends.length,0);
  assert.equal(f.ledger.db.prepare('SELECT attempts FROM study_messages').get().attempts,1);
  f.worker.answer=async()=> 'Explicação';f.worker.enqueue(message(2));let sends=0;
  f.worker.send=async()=>{sends++;throw new Error('network lost');};
  await f.worker.tick();await f.worker.tick();assert.equal(sends,1);assert.equal(f.worker.status().counts.uncertain,1);
});

test('restart recovers queued study requests and quarantines interrupted sends without changing print history',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'study-restart-')),file=path.join(dir,'db.sqlite');
  try {
    let ledger=new Ledger(file);let worker=new StudyWorker({ledger,target:()=> '100'});
    ledger.discover([]);ledger.discover([{id:'print',name:'print.png',mimeType:'image/png'}]);ledger.update('print',{status:'sent'});
    worker.enqueue(message(1));worker.enqueue(message(2));worker.update(1,{status:'analyzing'});worker.update(2,{status:'sending'});ledger.close();
    ledger=new Ledger(file);worker=new StudyWorker({ledger,target:()=> '100'});
    assert.deepEqual(worker.status().counts,{queued:1,uncertain:1});assert.equal(ledger.counts().sent,1);ledger.close();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
