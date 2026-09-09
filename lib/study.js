import { safeError } from './worker.js';

// Store incoming text before Telegram's offset advances. Keep this queue independent of Drive.
export class StudyWorker {
  constructor({ledger,answer,send,isReady,target}) {
    Object.assign(this,{ledger,answer,send,isReady,target});this.task=null;this.error=null;
    ledger.db.exec(`CREATE TABLE IF NOT EXISTS study_messages (
      update_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL,
      topic TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, message_id TEXT, updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS study_status ON study_messages(status,retry_at);
    UPDATE study_messages SET status='queued' WHERE status='analyzing';
    UPDATE study_messages SET status='uncertain', error='Envio interrompido: confira a conversa antes de repetir o tema.' WHERE status='sending';`);
  }
  enqueue({updateId,chatId,messageId,text}) {
    const topic=String(text||'').trim();
    if(String(chatId)!==String(this.target()) || !Number.isSafeInteger(updateId) || !Number.isSafeInteger(messageId) || messageId<=0 || !topic || topic.length>4096) return;
    this.ledger.db.prepare("INSERT OR IGNORE INTO study_messages(update_id,chat_id,source_message_id,topic,status,updated) VALUES (?,?,?,?,'queued',?)").run(updateId,String(chatId),messageId,topic,Date.now());
  }
  update(id,fields) {
    const keys=Object.keys(fields).filter(k=>['status','answer','attempts','retry_at','error','message_id'].includes(k));
    this.ledger.db.prepare(`UPDATE study_messages SET ${keys.map(k=>`${k}=?`).join(',')},updated=? WHERE update_id=?`).run(...keys.map(k=>fields[k]),Date.now(),id);
  }
  status() {
    return {error:this.error,counts:Object.fromEntries(this.ledger.db.prepare('SELECT status,COUNT(*) n FROM study_messages GROUP BY status').all().map(r=>[r.status,r.n])),recent:this.ledger.db.prepare('SELECT update_id,substr(topic,1,100) name,status,error,updated FROM study_messages ORDER BY updated DESC LIMIT 10').all()};
  }
  tick() {
    if(this.task) return this.task;
    this.task=this.drain().catch(e=>{this.error=safeError(e);}).finally(()=>{this.task=null;});
    return this.task;
  }
  async drain() {
    while(this.isReady()) {
      const item=this.ledger.db.prepare("SELECT * FROM study_messages WHERE status='queued' AND retry_at<=? AND chat_id=? ORDER BY update_id LIMIT 1").get(Date.now(),String(this.target()));
      if(!item) break;
      await this.process(item);
    }
  }
  async process(item) {
    let sending=false;
    try {
      this.update(item.update_id,{status:'analyzing',attempts:item.attempts+1,error:null});
      const answer=item.answer || await this.answer(item.topic);
      this.update(item.update_id,{answer});
      if(!this.isReady()) {this.update(item.update_id,{status:'queued'});return;}
      this.update(item.update_id,{status:'sending'});sending=true;
      const result=await this.send(item.chat_id,answer,{replyTo:item.source_message_id});
      this.update(item.update_id,{status:'sent',message_id:result.id||null,answer:null,error:null});this.error=null;
    } catch(e) {
      this.error=sending?'Não foi possível confirmar o envio. Confira a conversa antes de repetir o tema.':safeError(e);
      this.update(item.update_id,{status:sending?'uncertain':item.attempts+1>=3?'failed':'queued',error:this.error,retry_at:Date.now()+Math.min(300000,15000*2**item.attempts)});
    }
  }
}
