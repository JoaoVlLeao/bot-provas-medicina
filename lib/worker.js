import { createHash } from 'node:crypto';
export class Worker {
  constructor({ledger,drive,analyze,send,isReady,target}) {Object.assign(this,{ledger,drive,analyze,send,isReady,target});this.busy=false;this.lastScan=null;this.error=null;}
  async tick() {
    if(this.busy || !this.drive.configured) return;
    this.busy=true;
    try {
      const files=await this.drive.list();
      this.ledger.discover(files);this.lastScan=new Date().toISOString();this.error=null;
      while(this.isReady() && this.ledger.get('paused')!=='true') {
        const file=this.ledger.next();if(!file) break;
        await this.process(file);
      }
    } catch(e) {this.error=safeError(e);}
    finally {this.busy=false;}
  }
  async process(file) {
    let sending=false;
    try {
      this.ledger.update(file.id,{status:'analyzing',attempts:file.attempts+1,error:null});
      const bytes=await this.drive.download(file);
      const hash=createHash('sha256').update(bytes).digest('hex');
      if(this.ledger.knownHash(hash,file.id)) {this.ledger.update(file.id,{status:'duplicate',hash});return;}
      this.ledger.update(file.id,{hash});
      const answer=file.answer || await this.analyze(bytes,file.mime);
      this.ledger.update(file.id,{answer});
      if(!this.isReady() || this.ledger.get('paused')==='true') {this.ledger.update(file.id,{status:'queued',retry_at:Date.now()+30000});return;}
      // Persist before the network side effect; ambiguous failures require manual review.
      const target=typeof this.target==='function'?this.target():this.target;
      this.ledger.update(file.id,{status:'sending',target});sending=true;
      const result=await this.send(target,answer);
      this.ledger.update(file.id,{status:'sent',message_id:result.id?._serialized || result.id || null,answer:null,error:null});
    } catch(e) {
      const attempts=file.attempts+1;
      this.ledger.update(file.id,{status:sending?'uncertain':attempts>=5?'failed':'queued',error:sending?'Não foi possível confirmar o envio. Confira a conversa antes de reenviar.':safeError(e),retry_at:Date.now()+Math.min(15*60000,30000*2**attempts)});
    }
  }
}
export function safeError(e) {return String(e?.message||'Erro desconhecido').replace(/AIza[\w-]+/g,'[chave omitida]').replace(/\d{5,16}:[A-Za-z0-9_-]{25,}/g,'[token omitido]').replace(/Bearer\s+\S+/gi,'Bearer [omitido]').replace(/https?:\/\/\S+/g,'[endereço omitido]').slice(0,250);}
