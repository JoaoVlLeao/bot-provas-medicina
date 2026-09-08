import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { safeError } from './worker.js';

export function splitMessage(text, limit = 3900) {
  const parts = []; let part = '';
  for (const character of String(text)) {
    if (part.length + character.length > limit) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  if (!parts.length) throw new Error('Resposta vazia.');
  return parts;
}

export class Telegram {
  constructor({ token, ledger, fetchImpl = fetch, wait = sleep, now = Date.now }) {
    Object.assign(this, { token, ledger, fetchImpl, wait, now });
    this.bot = null; this.error = null; this.lastPoll = null;
    this.controller = new AbortController(); this.sendChain = Promise.resolve();
    this.lastSend = 0; this.task = null;
  }
  get configured() { return Boolean(this.token); }
  get target() { return this.ledger.get('telegram_chat_id') || ''; }
  get ready() { return Boolean(this.bot && this.target && !this.error && !this.controller.signal.aborted); }
  async request(method, payload = {}, timeout = 35000) {
    if (!this.configured) throw new Error('Falta conectar o bot do Telegram.');
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout)])
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) {
      const code = Number(body?.error_code || response.status);
      const messages = { 401: 'Token do Telegram inválido.', 403: 'O bot não tem acesso à conversa. Abra o Telegram e desbloqueie o bot.', 409: 'Outra conexão está lendo este bot. Use um bot exclusivo.', 429: 'Limite temporário de mensagens do Telegram.' };
      const error = new Error(messages[code] || `Telegram HTTP ${code}. Não foi possível concluir a solicitação.`);
      error.status = code; error.retryAfter = Number(body?.parameters?.retry_after || 0);
      throw error;
    }
    return body.result;
  }
  async validate() {
    if (!/^\d{5,16}:[A-Za-z0-9_-]{25,100}$/.test(this.token || '')) throw new Error('Token do Telegram inválido.');
    const bot = await this.request('getMe');
    if (!bot?.is_bot || !/^\w{5,32}$/.test(bot.username || '')) throw new Error('A credencial não identifica um bot válido.');
    const webhook = await this.request('getWebhookInfo');
    if (webhook.url) throw new Error('Este bot já está ligado a outro serviço. Crie um bot exclusivo no BotFather.');
    this.bot = bot; this.error = null;
    return bot;
  }
  newPairing() {
    if (this.target) throw new Error('A conversa do Telegram já está vinculada.');
    this.ledger.set('telegram_pair', randomBytes(24).toString('base64url'));
    this.ledger.set('telegram_pair_expires', this.now() + 30 * 60000);
  }
  pairingLink() {
    if (!this.bot || this.target) return null;
    const nonce = this.ledger.get('telegram_pair');
    if (!nonce || Number(this.ledger.get('telegram_pair_expires')) < this.now()) return null;
    return `https://t.me/${this.bot.username}?start=${nonce}`;
  }
  publicStatus() {
    return { configured: this.configured, ready: this.ready, username: this.bot?.username || null,
      name: this.bot?.first_name || null, target: this.target,
      recipient: this.ledger.get('telegram_recipient') || null,
      pairLink: this.pairingLink(), lastPoll: this.lastPoll, error: this.error };
  }
  // Only a private /start carrying the authenticated panel's secret can bind a recipient.
  handleUpdate(update) {
    const m = update.message;
    if (!m || m.chat?.type !== 'private' || m.from?.is_bot || m.from?.id !== m.chat?.id) return null;
    const chat = String(m.chat.id), command = String(m.text || '');
    if (!this.target) {
      const provided = command.match(/^\/start(?:@\w+)? ([\w-]{32})$/)?.[1];
      const expected = this.ledger.get('telegram_pair');
      if (!provided || !expected || Number(this.ledger.get('telegram_pair_expires')) < this.now()) return null;
      if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
      this.ledger.db.exec('BEGIN IMMEDIATE');
      try {
        this.ledger.set('telegram_chat_id', chat);
        this.ledger.set('telegram_recipient', [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').slice(0,150));
        this.ledger.set('telegram_pair', ''); this.ledger.set('telegram_pair_expires', 0);
        this.ledger.db.exec('COMMIT');
      } catch (e) { this.ledger.db.exec('ROLLBACK'); throw e; }
      return 'Telegram conectado ao Bot Medicina. As respostas dos novos prints serão enviadas nesta conversa. Salve suas capturas na pasta Prints medicina. O monitor pode ser pausado ou retomado no painel.';
    }
    if (chat !== this.target) return null;
    if (/^\/(start|help|status)(?:@\w+)?(?: |$)/.test(command)) {
      return `Bot Medicina conectado. Monitor ${this.ledger.get('paused') === 'true' ? 'pausado no painel' : 'ativo'}. Salve um print novo na pasta Prints medicina para receber a análise aqui.`;
    }
    return null;
  }
  start() {
    if (this.task || !this.configured) return;
    this.task = this.pollLoop();
  }
  async pollLoop() {
    while (!this.controller.signal.aborted) {
      try {
        if (!this.bot) await this.validate();
        const updates = await this.request('getUpdates', { offset: Number(this.ledger.get('telegram_offset') || 0), timeout: 25, allowed_updates: ['message'] });
        for (const update of updates) {
          const reply = this.handleUpdate(update);
          this.ledger.set('telegram_offset', update.update_id + 1);
          if (reply) {
            // Binding is durable before its confirmation is sent. Never replay an ambiguous confirmation.
            try { await this.send(this.target, reply); } catch (e) { this.error = safeError(e); }
          }
        }
        this.lastPoll = new Date(this.now()).toISOString();
        if (!updates.length) this.error = null;
      } catch (e) {
        if (this.controller.signal.aborted) break;
        this.error = safeError(e);
        try { await this.wait(Math.min(60000, Math.max(5000, (e.retryAfter || 0) * 1000)), undefined, { signal: this.controller.signal }); } catch { break; }
      }
    }
  }
  send(target, text) {
    if (!this.ready || String(target) !== this.target) return Promise.reject(new Error('Conversa do Telegram não autorizada.'));
    const job = this.sendChain.then(async () => {
      const ids = [], parts = splitMessage(text);
      for (const part of parts) {
        let result;
        for (let attempt = 0; ; attempt++) {
          const delay = Math.max(0, 1100 - (this.now() - this.lastSend));
          if (delay) await this.wait(delay, undefined, { signal: this.controller.signal });
          try {
            result = await this.request('sendMessage', { chat_id: this.target, text: part, link_preview_options: { is_disabled: true } });
            this.lastSend = this.now(); break;
          } catch (e) {
            this.lastSend = this.now();
            // Only an explicit rate-limit rejection is safe to retry automatically.
            if (e.status !== 429 || attempt >= 2 || e.retryAfter > 60) throw e;
            await this.wait(Math.max(1000, e.retryAfter * 1000), undefined, { signal: this.controller.signal });
          }
        }
        if (!result?.message_id || String(result.chat?.id) !== this.target) throw new Error('O Telegram não confirmou o destino da mensagem.');
        ids.push(String(result.message_id));
      }
      return { id: ids.join(',') };
    });
    this.sendChain = job.catch(() => {});
    return job;
  }
  async stop() { this.controller.abort(); await this.task; }
}
