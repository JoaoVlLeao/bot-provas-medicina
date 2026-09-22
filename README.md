# Bot Medicina — Drive e Telegram

Serviço contínuo no Railway. Monitora imagens PNG/JPEG/WebP de uma pasta privada do Google Drive, analisa com Gemini e envia a resposta à conversa privada configurada pela API oficial do Telegram.

As respostas começam com `Resposta letra: A`, com apenas a letra em negrito no Telegram, seguidas de uma ou duas frases curtas (até 40 palavras e 400 caracteres). A saída estruturada do Gemini garante a posição da letra; imagens sem alternativa identificável recebem uma resposta curta sem inventar uma letra. O Gemini 2.5 Pro mantém raciocínio com orçamento de 2.048 tokens e limite total de saída de 3.072 tokens para reduzir demora e elaboração.

## Estudo por mensagem

Somente os telefones definidos na variável privada `TELEGRAM_ALLOWED_PHONES` (separados por vírgula, com país e DDD) podem receber respostas. Sem essa variável, somente o destino configurado pode ser autorizado; sem lista e sem destino, ninguém recebe respostas médicas. Envie `/start` e confirme seu próprio contato. Contatos de terceiros e contatos encaminhados são rejeitados. A autorização persiste pelo ID do Telegram e pelo telefone verificado. O destinatário já verificado dos prints mantém acesso somente se estiver na lista.

Pessoas não verificadas recebem apenas a solicitação de contato ao enviar `/start`; dúvidas e demais comandos são ignorados. Conversas registradas durante o antigo acesso público não concedem autorização. A fila também verifica a autorização antes de analisar e enviar respostas.

As mensagens recebidas são salvas no SQLite antes de avançar o offset do Telegram. A fila de estudo funciona também com o monitor do Drive pausado ou sem destinatário de prints, processa um tema por vez e responde à mensagem original na conversa de quem enviou. O acesso exige contato próprio verificado e telefone presente na lista privada. Grupos e mensagens de outros bots são ignorados. As conversas reconhecidas persistem no banco; nenhum usuário recebe respostas de outro ou os prints privados do Drive. A atividade aparece em Estudo por mensagem no painel. Até três tentativas de IA são feitas com espera crescente; envios de resultado incerto ficam para conferência e não são repetidos automaticamente.

## Implantação

- Node.js 24 é instalado pelo Dockerfile. Não há Chromium, WhatsApp Web ou automação de uma conta pessoal.
- Anexe um volume Railway em `/data`. O aplicativo usa `RAILWAY_VOLUME_MOUNT_PATH` para o SQLite, credenciais privadas e sessões do painel.
- Mantenha uma única réplica e Serverless desativado. Configure o healthcheck em `/health`.
- Variáveis: `GEMINI_API_KEY`, `GEMINI_MODEL`, `DRIVE_FOLDER_ID`. O token do Telegram e a credencial do Drive podem ser importados pelo painel autenticado e são salvos somente no volume privado. Alternativas: `TELEGRAM_BOT_TOKEN` e `GOOGLE_SERVICE_ACCOUNT_JSON` nas variáveis privadas do Railway.
- Ative a API do Google Drive no projeto Google e compartilhe apenas a pasta de capturas, como leitor, com a conta de serviço. Não conceda funções administrativas ao projeto.
- Não coloque tokens, chaves, números particulares ou configurações de conta no GitHub.

## Conexão do Telegram

1. Abra o domínio do serviço. O painel exige autenticação. A cada início, os logs privados do Railway recebem `PANEL_ACCESS_CODE`, código de uso único válido por 30 minutos. A sessão do painel dura 30 dias e usa cookie HttpOnly.
2. Na sua conta do Telegram, crie um bot exclusivo com `/newbot` no BotFather oficial. Não precisa de um novo número de telefone.
3. Cole o token no campo privado do painel. O serviço valida `getMe` e recusa um bot que já usa webhook em outro serviço.
4. Abra o link de conexão gerado no painel e toque em Iniciar no Telegram. O link contém um segredo de uso único que expira em 30 minutos; `/start` sem esse segredo não vincula ninguém. Quando `TARGET_TELEGRAM_NUMBER` estiver configurado, confirme seu próprio contato no botão do bot: o número e o ID do remetente precisam coincidir. Para a migração, a variável antiga `TARGET_WHATSAPP_NUMBER` funciona como valor de destino quando a nova não estiver definida.
5. Confira o destinatário no painel e retome o monitor, se estiver pausado. Envie uma captura nova à pasta e confirme a resposta na conversa.

A conta vinculada por esse link recebe exclusivamente os prints do Drive. O estudo por texto exige autorização por telefone nas respectivas conversas privadas. Os demais usuários não podem trocar o destinatário dos prints nem acessar seu histórico ou o painel administrativo. O Telegram Web pode ficar fechado.

O bot usa long polling oficial, com offset persistente. O token não é retornado pelo painel nem registrado em logs. Respostas longas são divididas, preservando caracteres Unicode e respeitando o intervalo por conversa. Somente rejeições explícitas por limite de envio são repetidas automaticamente.

## Fila e recuperação

A primeira consulta completa e autorizada cria uma referência das imagens existentes, que não são respondidas. Consultas posteriores ocorrem a cada 15 segundos. A fila e a deduplicação por ID/conteúdo persistem no SQLite. Não há alteração ou exclusão de imagens no Drive. O processo só analisa a fila com o Telegram vinculado e monitor ativo.

Falhas de IA/leitura recebem até cinco tentativas com intervalo crescente. Falhas de resultado incerto durante envio são marcadas para conferência, inclusive quando apenas parte de uma resposta longa pode ter chegado. Após reinício, envios interrompidos não são repetidos automaticamente.

A migração preserva o mesmo banco e os registros de envios anteriores. Itens antigos marcados como `uncertain` não são automaticamente reenviados ao Telegram. Arquivos de sessão do WhatsApp que já existiam no volume ficam inativos; não são mais carregados.

## Verificação

`npm ci --ignore-scripts` e `npm test` validam autenticação do painel, vinculação privada, limites do Telegram, respostas longas, persistência, deduplicação e recuperação da fila. `BOT_TEST_MODE=true` desativa acesso de rede periódico somente fora do Railway.
