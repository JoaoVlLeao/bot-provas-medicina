// index.js - Bot Médico (Acesso Público)
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import wwebjs from 'whatsapp-web.js';
import qrcode from "qrcode"; 

const { Client, LocalAuth } = wwebjs;

// ======================= PREVENÇÃO DE CRASH =======================
process.on('uncaughtException', (err) => {
    console.error('🔥 CRÍTICO: Erro não tratado (uncaughtException):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 CRÍTICO: Rejeição de promessa não tratada:', reason);
});

// ======================= CONFIGURAÇÃO DE DIRETÓRIOS =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, ".data"); 

if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

// ======================= GEMINI SETUP =======================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.5-pro"; 

const PROMPT_MEDICINA = `
Você é um preceptor médico de altíssimo nível, especialista em Urgência, Emergência, Cirurgia e Terapia Intensiva.
O usuário é um estudante ou médico buscando informações rápidas.

OBJETIVO: Fornecer respostas precisas, diretas e otimizadas estritamente para leitura no WHATSAPP.

🚨 REGRAS RÍGIDAS DE FORMATAÇÃO (LIMITAÇÕES DO WHATSAPP) 🚨
1. PROIBIDO TABELAS E HTML: O WhatsApp NÃO suporta tabelas Markdown (| coluna |), cabeçalhos com hashtag (###), nem tags HTML como <br>. NUNCA os utilize.
2. NEGRITO: Para destacar palavras, use apenas UM asterisco de cada lado. Exemplo: *Cardiomiopatia*. NUNCA use dois asteriscos (**).
3. ITÁLICO: Use underline. Exemplo: _texto_.
4. ESTRUTURAÇÃO SEM TABELAS: Se precisar comparar doenças (ex: tipos de cardiomiopatias), crie um bloco de texto para cada uma usando listas e emojis, NUNCA desenhe uma tabela.
5. TÍTULOS: Como não há tags de cabeçalho, faça títulos usando letras maiúsculas, emojis e negrito. Exemplo: 🫀 *CLASSIFICAÇÃO DAS CARDIOMIOPATIAS PRIMÁRIAS*
6. QUEBRAS DE LINHA: Use a quebra de linha normal (pular linha), nunca escreva <br>.

DIRETRIZES DE CONTEÚDO MÉDICO:
1. VÁ DIRETO AO PONTO: Zero enrolação. Sem "Olá", sem introduções.
2. SCANNEABILIDADE: O usuário está num plantão ou fazendo prova. Use tópicos curtos (com o símbolo • ou -). 
3. CONDUTAS E ALGORITMOS: Use fluxogramas em texto claro. Exemplo: *Passo 1* ➔ *Passo 2* ➔ *Passo 3*.
4. QUESTÕES DE PROVA: Dê o GABARITO imediatamente na primeira linha. Em seguida, justifique rapidamente porque a certa é a certa, e o erro das outras.
5. MNEMÔNICOS: Sempre que existir um mnemônico clássico, destaque-o no final com o emoji 🧠.
`;

const chatHistory = new Map(); 

async function gerarRespostaGemini(userId, textoUsuario) {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    
    if (!chatHistory.has(userId)) {
        chatHistory.set(userId, [
            { role: "user", parts: [{ text: `Instruções do Sistema: ${PROMPT_MEDICINA}` }] },
            { role: "model", parts: [{ text: "Compreendido. Aguardando a primeira dúvida médica ou questão." }] }
        ]);
    }

    const historico = chatHistory.get(userId);
    const chat = model.startChat({ history: historico });

    try {
        const result = await chat.sendMessage(textoUsuario);
        const respostaText = result.response.text();
        
        historico.push({ role: "user", parts: [{ text: textoUsuario }] });
        historico.push({ role: "model", parts: [{ text: respostaText }] });
        
        if (historico.length > 30) {
            historico.splice(2, 2); 
        }

        return respostaText;
    } catch (error) {
        console.error(`⚠️ Erro Gemini: ${error.message}`);
        return "⚠️ Erro ao processar com a IA. Tente novamente em alguns instantes.";
    }
}

// ======================= CLIENTE WHATSAPP =======================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let latestQrCode = null; 

client.on('qr', (qr) => {
    console.log('QR RECEIVED - Escaneie via Web');
    qrcode.toDataURL(qr, (err, url) => {
        if (!err) latestQrCode = url; 
    });
});

client.on('ready', () => {
    console.log('✅ Bot Médico Online e aberto ao público!');
    latestQrCode = "CONNECTED"; 
});

client.on('disconnected', (reason) => {
    console.log('❌ Cliente desconectado! Tentando reconectar...', reason);
    latestQrCode = null;
    client.initialize();
});

client.on('message_create', async (msg) => {
    // Ignora mensagens enviadas por você mesmo ou status
    if (msg.fromMe || msg.isStatus) return;

    // A trava de segurança foi removida. Qualquer número que enviar mensagem será atendido.
    console.log(`💬 Dúvida recebida de ${msg.from}! Processando...`);

    try {
        const chat = await msg.getChat();
        await chat.sendStateTyping(); 
        
        const resposta = await gerarRespostaGemini(msg.from, msg.body);
        
        await msg.reply(resposta);
        await chat.clearState();
    } catch (e) {
        console.error("Erro ao responder:", e);
    }
});

client.initialize();

// ======================= SERVER (QR CODE WEB) =======================
const app = express();
app.use(cors());

app.get('/', (req, res) => {
    const metaRefresh = '<meta http-equiv="refresh" content="3">';
    const style = '<style>body{font-family:sans-serif;text-align:center;padding-top:50px;background-color:#f0f4f8;}</style>';

    if (latestQrCode === "CONNECTED") {
        res.send(`
            <html><head>${style}</head>
            <body>
                <h1 style="color: #2c3e50;">⚕️ Bot Médico Online!</h1>
                <p>O sistema está conectado ao seu WhatsApp.</p>
            </body></html>
        `);
    } else if (latestQrCode) {
        res.send(`
            <html><head>${metaRefresh}${style}</head>
            <body>
                <h1 style="color: #2c3e50;">Conecte o Bot Médico</h1>
                <p>Escaneie o QR Code abaixo:</p>
                <img src="${latestQrCode}" width="300" style="border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);"/>
            </body></html>
        `);
    } else {
        res.send(`
            <html><head>${metaRefresh}${style}</head>
            <body>
                <h1>Aguardando QR Code...</h1>
            </body></html>
        `);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`👂 Servidor rodando na porta ${PORT}`));