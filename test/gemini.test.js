import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer,createStudyTutor } from '../lib/gemini.js';

function analyzer(answer, {finishReason='STOP', thoughts=false, inspect=()=>{}}={}) {
  return createAnalyzer({apiKey:'test-key', fetchImpl:async (url, options)=>{
    inspect(url, JSON.parse(options.body));
    return {ok:true, json:async()=>({candidates:[{finishReason, content:{parts:[
      ...(thoughts ? [{thought:true, text:'Raciocínio privado.'}] : []),
      {text:typeof answer === 'string' ? answer : JSON.stringify(answer)}
    ]}}]})};
  }});
}

test('image analysis returns the letter first and a short explanation without exposing thoughts', async()=>{
  const result = await analyzer({letra:'B', explicacao:'O achado decisivo corresponde à alternativa indicada.'}, {thoughts:true, inspect:(url,body)=>{
    assert.match(url, /gemini-2\.5-pro:generateContent$/);
    assert.equal(body.contents[0].parts[1].inlineData.data, Buffer.from('image').toString('base64'));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.generationConfig.maxOutputTokens > body.generationConfig.thinkingConfig.thinkingBudget);
  }})(Buffer.from('image'), 'image/png');
  assert.equal(result, 'Resposta letra: B\n\nO achado decisivo corresponde à alternativa indicada.');
});

test('an inconclusive screenshot does not receive a fabricated answer letter', async()=>{
  const result = await analyzer({letra:null, explicacao:'As alternativas estão cortadas. Envie a questão completa.'})(Buffer.from('image'), 'image/png');
  assert.equal(result, 'Resposta:\n\nAs alternativas estão cortadas. Envie a questão completa.');
});

test('invalid, incomplete or oversized model output is not sent as an answer', async()=>{
  for(const value of ['not JSON', {letra:'AB', explicacao:'Motivo.'}, {explicacao:'Sem letra.'}, {letra:'A', explicacao:''}, {letra:'A', explicacao:'x'.repeat(401)}]) {
    await assert.rejects(analyzer(value)(Buffer.from('image'), 'image/png'), /resposta/);
  }
  await assert.rejects(analyzer({letra:'A', explicacao:'Motivo.'}, {finishReason:'MAX_TOKENS'})(Buffer.from('image'), 'image/png'), /completa/);
});

test('a word or phrase uses the text study mode with the same Gemini model, separate from image answers',async()=>{
  const seen=[];
  const tutor=createStudyTutor({apiKey:'test',fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);seen.push(body);
    assert.match(url,/gemini-2\.5-pro:generateContent$/);
    assert.equal(body.generationConfig.responseSchema,undefined);
    assert.equal(body.contents[0].parts.length,1);
    return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'Conceito.\n* **Pista decisiva.**\n• Diferencial.'}]}}]})};
  }});
  for(const topic of ['SIRS','Diferença entre asma e DPOC']) assert.equal(await tutor(topic),'Conceito.\n• Pista decisiva.\n• Diferencial.');
  assert.deepEqual(seen.map(body=>body.contents[0].parts[0].text),['SIRS','Diferença entre asma e DPOC']);
  await assert.rejects(tutor(''),/Envie/);await assert.rejects(tutor('x'.repeat(4097)),/4096/);
});
