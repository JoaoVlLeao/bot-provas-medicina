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

OBJETIVO: Fornecer respostas precisas, diretas e visualmente otimizadas para consulta ultra-rápida durante resolução de questões de prova ou dúvidas de plantão.

DIRETRIZES DE FORMATAÇÃO E RESPOSTA:
1. VÁ DIRETO AO PONTO: Zero enrolação. Não diga "Olá", "Entendi", ou "Aqui está a resposta". Comece imediatamente com a informação médica.
2. SCANNEABILIDADE: Use tópicos (bullet points) e **negrito** nas palavras-chave, drogas e doses. O usuário precisa bater o olho e achar a informação em 2 segundos.
3. CONDUTAS: Para passo a passo (ex: ACLS, ATLS), use fluxogramas em texto claro (Ex: Passo 1 -> Passo 2).
4. QUESTÕES DE PROVA: Se o usuário mandar uma questão, dê o GABARITO imediatamente na primeira linha. Em seguida, justifique rapidamente porque a certa é a certa, e porque as erradas são absurdas ou pegadinhas.
5. MNEMÔNICOS: Sempre que existir um mnemônico clássico para o tema, inclua-o no final.
6. TABELAS: Use tabelas em Markdown para diagnósticos diferenciais ou critérios diagnósticos complexos (ex: Critérios de Light, Ranson).
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