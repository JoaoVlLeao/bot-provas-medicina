# Bot Medicina — Drive e WhatsApp

Serviço contínuo para Railway. Monitora imagens PNG/JPEG/WebP de uma pasta privada do Google Drive, analisa com Gemini e envia a resposta ao WhatsApp configurado.

## Implantação

- Node.js 24 e Chromium são instalados pelo Dockerfile.
- Anexe um volume Railway em `/data`. O aplicativo usa `RAILWAY_VOLUME_MOUNT_PATH` para banco SQLite, sessão de WhatsApp e sessões do painel.
- Mantenha uma única réplica e Serverless desativado.
- Configure o healthcheck em `/health` e o domínio na porta definida por `PORT`.
- Variáveis: `GEMINI_API_KEY`, `GEMINI_MODEL`, `DRIVE_FOLDER_ID`, `TARGET_WHATSAPP_NUMBER` (DDI+DDD+número), `GOOGLE_SERVICE_ACCOUNT_JSON` (ou importe o JSON pelo painel autenticado; ele será salvo somente no volume privado). Alternativamente, autenticação Drive via `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
- Ative a API do Google Drive no projeto Google e compartilhe **apenas a pasta de capturas**, como leitor, com a conta de serviço. Não conceda funções de administrador do projeto.
- Não coloque chaves, números particulares ou configurações de conta no GitHub.

## Pareamento

Abra o domínio do serviço. O painel exige autenticação. A cada início, os logs privados do Railway recebem `PANEL_ACCESS_CODE`, um código de uso único válido por 30 minutos. Insira-o na página de acesso. A sessão do painel dura 30 dias e usa cookie HttpOnly. Depois, escaneie o QR Code com o WhatsApp que vai executar o bot.

O QR fica disponível independentemente da autorização do Drive. O painel distingue essas duas conexões e mostra o número de destino.

## Fila e recuperação

A primeira consulta completa e autorizada cria uma referência das imagens existentes, que não são respondidas. Consultas posteriores ocorrem a cada 15 segundos. A fila e a deduplicação por ID/conteúdo persistem no SQLite. Não há alteração ou exclusão de imagens no Drive. O processo só analisa a fila com WhatsApp conectado.

Falhas de IA/leitura recebem até cinco tentativas com intervalo crescente. Falhas durante envio são marcadas para conferência manual, pois uma conexão interrompida não comprova que a mensagem deixou de ser entregue. Após reinício, envios interrompidos não são repetidos automaticamente. O código não responde a mensagens de outros contatos ou grupos.

## Verificação

`npm ci --ignore-scripts` e `npm test` validam a fila e a persistência. O modo `BOT_TEST_MODE=true` desativa o WhatsApp apenas fora do Railway.

A dependência transitiva `extract-zip` permanece sinalizada pelo npm audit. A imagem utiliza Chromium do repositório Debian, desativa download do Puppeteer e instala pacotes com `--ignore-scripts`; o bot não oferece upload de ZIP ou extração de arquivos recebidos.
