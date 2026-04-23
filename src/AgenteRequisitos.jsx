import { useState, useRef, useEffect, useMemo } from "react";

const STORAGE_KEY = "agente_req_v1";
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

let _apiKey = "";
export function setApiKey(k) { _apiKey = k; }

// ════════════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════════════

function chunkText(text, maxChars = 3500) {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if ((current + p).length > maxChars && current) {
      chunks.push(current.trim());
      current = p + "\n\n";
    } else {
      current += p + "\n\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function safeJSON(raw) {
  if (!raw) return null;
  // strip markdown code fences
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(clean); } catch {}
  // try largest {...} block
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(clean.slice(s, e + 1)); } catch {} }
  // try largest [...] block
  const a = clean.indexOf("["), ae = clean.lastIndexOf("]");
  if (a !== -1 && ae > a) { try { return JSON.parse(clean.slice(a, ae + 1)); } catch {} }
  console.error("[safeJSON] falhou em parsear. Primeiros 400 chars:", raw.slice(0, 400));
  return null;
}

// Tenta recuperar JSON truncado (ex: resposta cortada no meio de um array)
// Retorna objeto com arrays parciais se possível, null se impossível
function recoverPartialJSON(raw) {
  if (!raw) return null;
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  // Tenta recuperar o objeto raiz mesmo com JSON truncado
  const start = clean.indexOf("{");
  if (start === -1) return null;
  let partial = clean.slice(start);
  // Tenta fechar arrays e objetos abertos progressivamente
  for (let trim = 0; trim < partial.length; trim++) {
    const attempt = partial.slice(0, partial.length - trim);
    // Conta colchetes e chaves para tentar fechar
    let opens = 0, opens2 = 0;
    for (const ch of attempt) {
      if (ch === "{") opens++;
      else if (ch === "}") opens--;
      else if (ch === "[") opens2++;
      else if (ch === "]") opens2--;
    }
    const close = "]".repeat(Math.max(0, opens2)) + "}".repeat(Math.max(0, opens));
    try {
      const recovered = JSON.parse(attempt + close);
      if (recovered && typeof recovered === "object") {
        console.warn("[recoverPartialJSON] JSON recuperado com truncamento de", trim, "chars");
        return recovered;
      }
    } catch {}
    // Só tenta os primeiros 2000 chars de trim para não ser muito lento
    if (trim > 2000) break;
  }
  return null;
}

const pad3 = n => String(n).padStart(3, "0");

// Deriva prefixo de 4 letras para IDs de RN a partir do título do UC
// Ex: "Executar Conciliação DDA" → "EXEC", "Manter Usuário" → "MANT"
function ucToRNPrefix(title) {
  if (!title) return "RN";
  const stopWords = new Set(["de","do","da","dos","das","e","a","o","os","as","em","no","na","nos","nas","por","para","com","um","uma","ao","à"]);
  const words = title.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()));
  const first = (words[0] || title).replace(/[^a-zA-ZÀ-ú]/g, "");
  // Remove acentos
  const ascii = first.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return ascii.slice(0, 4).toUpperCase() || "RN";
}

// ════════════════════════════════════════════════════════════════════
// CLAUDE API
// ════════════════════════════════════════════════════════════════════

async function claude(prompt, system, maxTokens = 4000, model = "claude-opus-4-7") {
  const key = _apiKey || sessionStorage.getItem("anthropic_key") || "";
  if (!key) throw new Error("API key não configurada. Insira sua chave Anthropic antes de continuar.");
  _apiKey = key;

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  };

  console.group("[DEBUG] claude()");
  console.log("key:", `${key.slice(0, 10)}...`);
  console.log("model:", body.model, "| max_tokens:", maxTokens);
  console.log("system:", system?.slice(0, 100));
  console.log("prompt:", (typeof prompt === "string" ? prompt : JSON.stringify(prompt))?.slice(0, 150));
  console.groupEnd();

  let r;
  try {
    r = await fetch("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    console.error("[DEBUG] network error:", netErr);
    throw new Error(`Erro de rede: ${netErr.message}`);
  }

  console.log(`[DEBUG] HTTP ${r.status} ${r.statusText}`);
  let d;
  try { d = await r.json(); } catch {
    throw new Error(`Resposta inesperada da API (status ${r.status})`);
  }
  console.log("[DEBUG] response:", JSON.stringify(d).slice(0, 300));
  if (d.error) throw new Error(`API [${d.error.type}]: ${d.error.message}`);
  if (d.stop_reason === "max_tokens") console.warn("[DEBUG] ⚠ max_tokens atingido");
  return d?.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
}

// ════════════════════════════════════════════════════════════════════
// FASE 0 — Normalizar estrutura do texto antes da extração
// Usa Haiku (mais barato) para reestruturar sem alterar conteúdo.
// Fallback seguro: retorna texto original se a chamada falhar.
// ════════════════════════════════════════════════════════════════════

const FASE0_SYSTEM = `Você é um pré-processador de documentos de requisitos de software.
Sua única missão é REESTRUTURAR o texto recebido em Markdown limpo, SEM alterar, resumir ou omitir nenhum conteúdo.

REGRAS OBRIGATÓRIAS:
1. PRESERVAR TODO O CONTEÚDO — nenhuma frase, dado ou valor pode ser removido.
2. Converter tabelas desformatadas em tabelas Markdown (| col | col |).
3. Identificar cabeçalhos de Caso de Uso (ex: "UC-07", "Identificador | UC-07") e formatar como: ## UC-XX — Título
4. Normalizar passos de fluxo ("3.1 texto", "Passo 3:") para numeração limpa: 1., 2., 3.
5. Identificar campos de cabeçalho de UC e formatar como: **Campo:** valor
6. Separar seções com heading adequado: ## Fluxo Principal, ## Fluxo Alternativo, ## Fluxo de Exceção, ## Regras de Negócio.
7. Corrigir quebras de linha espúrias dentro de frases contínuas.
8. NUNCA reescrever, interpretar ou acrescentar informações que não estão no original.
9. Retornar APENAS o texto reestruturado, sem explicações adicionais.`;

async function fase0_normalizarTexto(rawText, filename = "") {
  if (!rawText?.trim() || rawText.length < 400) return rawText;

  // Heurística: texto já bem estruturado em Markdown → pula (economiza chamada)
  const mdScore =
    (rawText.match(/^#{1,3} /gm) || []).length +
    (rawText.match(/^\*\*/gm) || []).length +
    (rawText.match(/^\| /gm) || []).length;
  if (mdScore > 10) {
    console.log(`[fase0] "${filename}" já estruturado (md-score: ${mdScore}), pulando.`);
    return rawText;
  }

  try {
    const result = await claude(
      `Arquivo: ${filename || "documento"}\n\nTexto:\n\n${rawText}`,
      FASE0_SYSTEM,
      Math.min(Math.ceil(rawText.length / 2.8), 8192),
      "claude-haiku-4-5-20251001"   // Haiku: ~10× mais barato que Sonnet
    );
    if (!result?.trim()) {
      console.warn(`[fase0] "${filename}" resposta vazia — usando original.`);
      return rawText;
    }
    console.log(`[fase0] "${filename}": ${rawText.length} → ${result.length} chars`);
    return result;
  } catch (e) {
    console.warn(`[fase0] "${filename}" falhou (${e.message}) — usando original.`);
    return rawText; // ← fallback: pipeline continua normalmente
  }
}

// ════════════════════════════════════════════════════════════════════
// FASE 1 — Extrair funcionalidades de cada chunk
// ════════════════════════════════════════════════════════════════════

async function fase1_resumirChunk(chunk, idx, total) {
  const system = `Você é um analista de requisitos. Extraia funcionalidades da ata.
Nome: verbo no infinitivo + objeto (máx 6 palavras). Descrição: 1 frase.
Identifique a entidade de negócio e as operações CRUD presentes.
IMPORTANTE: Retorne SOMENTE o objeto JSON, sem texto adicional, sem markdown, sem \`\`\`.
{"funcionalidades":[{"id":"F001","titulo":"string","descricao":"string","atores":["string"],"entidade":"string","operacoes":["Inserir","Alterar","Excluir","Consultar"]}]}`;
  const raw = await claude(
    `Ata (parte ${idx + 1} de ${total}):\n\n${chunk}\n\nIdentifique todas as funcionalidades e retorne JSON válido.`,
    system, 3000
  );
  const parsed = safeJSON(raw);
  if (!parsed) {
    console.error(`[DEBUG] fase1 chunk ${idx + 1}: safeJSON falhou. Raw (200 chars):`, raw?.slice(0, 200));
    throw new Error(`Chunk ${idx + 1}: a IA não retornou JSON válido. Resposta recebida: "${raw?.slice(0, 120)}..."`);
  }
  const funcs = parsed.funcionalidades || [];
  console.log(`[DEBUG] fase1 chunk ${idx + 1}: ${funcs.length} funcionalidades extraídas`);
  return funcs;
}

// ════════════════════════════════════════════════════════════════════
// FASE 1b — Agrupar funcionalidades em Épicos
// ════════════════════════════════════════════════════════════════════

async function fase1b_gerarEpicos(funcList, correction = "") {
  const system = `Você é um Analista de Requisitos Sênior. Agrupe as funcionalidades em Épicos.
REGRAS:
1. Épico = módulo/domínio de negócio. Nome: OBRIGATORIAMENTE verbo no infinitivo + objeto, máx 60 chars. ID: EP001, EP002... Exemplos corretos: "Gerenciar Pagamentos", "Processar Conciliação DDA", "Controlar Acesso". ERRADO: "Gestão de Pagamentos", "Processamento DDA", "Controle de Acesso".
2. CRUD consolidado: se 2+ operações CRUD (Inserir/Alterar/Excluir/Consultar) da mesma entidade → liste essa entidade em "manterEntidades". O UC será gerado como "Manter [Entidade]".
3. Cada Épico deve ter 3-10 funcionalidades relacionadas.
4. ÉPICO COR (OBRIGATÓRIO SE EXISTIR): Se houver funcionalidades TRANSVERSAIS ao sistema (autenticação, autorização, perfis/permissões, auditoria/log, tratamento global de erros, configurações do sistema, gestão de sessão, notificações globais, gestão de usuários), crie UM épico com id "COR" e titulo "COR - Funcionalidades Transversais". Funcionalidades COR NÃO pertencem a nenhum módulo de negócio específico. Se não houver funcionalidades transversais, NÃO crie o épico COR.
Retorne SOMENTE JSON:
{"epicos":[{"id":"EP001","titulo":"string","objetivo":"string","funcIds":["F001","F002"],"manterEntidades":["Veículo"]},{"id":"COR","titulo":"COR - Funcionalidades Transversais","objetivo":"string","funcIds":["F00x"],"manterEntidades":[]}]}`;
  const corrNote = correction ? `\n\n⚠ CORREÇÃO SOLICITADA PELO ANALISTA: ${correction}` : "";
  const raw = await claude(
    `Funcionalidades:\n${JSON.stringify(funcList, null, 2)}\n\nAgrupe em Épicos.${corrNote}`,
    system, 2500
  );
  return safeJSON(raw)?.epicos || [];
}

// ════════════════════════════════════════════════════════════════════
// FASE 2 — Gerar N UCs para um Épico (com padrão Manter)
// ════════════════════════════════════════════════════════════════════

async function fase2_gerarUCsParaEpico(epico, funcList, ucStartIdx, correction = "") {
  const funcsDoEpico = funcList.filter(f => (epico.funcIds || []).includes(f.id));
  const system = `Você é um Analista de Requisitos UML 2.5.1. Gere TODOS os Casos de Uso do Épico.
REGRAS OBRIGATÓRIAS:
1. PADRÃO MANTER: CRUD da mesma entidade → UM UC "Manter [Entidade]". Fluxo principal = Consultar. Alternativos: FA1=Incluir, FA2=Alterar, FA3=Excluir. NÃO gere UCs separados para cada operação CRUD.
2. Nome do UC: OBRIGATORIAMENTE verbo no infinitivo + objeto. Exemplos corretos: "Consultar Extrato", "Realizar Transferência", "Manter Usuário". ERRADO: "Consulta de Extrato", "Transferência entre Contas", "Gestão de Usuários".
3. Máx 7 passos no fluxo principal, máx 3 alternativos, máx 2 exceções. Último passo SEMPRE = "Caso de uso encerra."
4. IDs serão corrigidos pelo sistema — use FT001, FT002... como placeholder sequencial.
5. RASTREABILIDADE (obrigatório):
   - "refs" em cada passo do fluxo principal: lista os IDs de RN e MSG que SE ORIGINAM naquele passo (ex: ["RN001","MSG002"]). Use [] se nenhum.
   - "origemPasso" em FA e FE: código do passo do fluxo principal que DISPARA o fluxo (ex: "FP-2").
   - "descricao" em FA: frase curta explicando o gatilho — "Este fluxo alternativo se inicia quando o ator [ação] no passo FP-X do fluxo principal."
   - "descricao" em FE: frase curta explicando o gatilho — "Este fluxo de exceção ocorre quando [condição] no passo FP-X do fluxo principal."
CAMPOS ADICIONAIS OBRIGATÓRIOS:
- "gatilho": evento ou ação do ator que inicia o UC (ex: "Usuário aciona opção Processar"). DIFERENTE de pré-condição — é o evento disparador, não um estado. NUNCA deixe vazio.
Retorne SOMENTE JSON (sem markdown):
{"ucs":[{"ftId":"FT001","ucId":"UC001","titulo":"string","atores":["string"],"precondição":"string","gatilho":"evento que dispara o UC","fluxoPrincipal":[{"passo":"1","descricao":"string","refs":["RN001","RN002"]},{"passo":"2","descricao":"string","refs":[]}],"fluxosAlternativos":[{"id":"FA1","titulo":"string","origemPasso":"FP-2","descricao":"Este fluxo alternativo se inicia quando o ator aciona X no passo FP-2 do fluxo principal.","passos":["string"]}],"fluxosExcecao":[{"id":"FE1","origemPasso":"FP-2","descricao":"Este fluxo de exceção ocorre quando Y no passo FP-2 do fluxo principal.","mensagem":"string","retorno":"string"}],"posCondição":"string"}]}`;
  const corrNote = correction ? `\n\n⚠ CORREÇÃO SOLICITADA PELO ANALISTA: ${correction}` : "";
  const raw = await claude(
    `Épico: ${epico.id} — ${epico.titulo}\nObjetivo: ${epico.objetivo || ""}\nEntidades com padrão Manter: ${(epico.manterEntidades || []).join(", ") || "nenhuma"}\n\nFuncionalidades:\n${JSON.stringify(funcsDoEpico, null, 2)}\n\nGere todos os Casos de Uso.${corrNote}`,
    system, 4000
  );
  const ucs = safeJSON(raw)?.ucs || [];
  ucs.forEach((uc, i) => {
    const idx = ucStartIdx + i;
    uc.ftId = `FT${pad3(idx + 1)}`;
    uc.ucId = uc.ftId;
    uc.epicId = epico.id;
    uc.epicTitulo = epico.titulo;
  });
  return ucs;
}

// ════════════════════════════════════════════════════════════════════
// FASE 3 — Gerar N HUs para um UC
// ════════════════════════════════════════════════════════════════════

function buildHUTitulo(hu, reqId, uc) {
  const quero = (hu.quero || "").trim();
  if (quero) return `${reqId} — ${quero}`.slice(0, 100);
  if (uc?.titulo) return `${reqId} — ${uc.titulo}`.slice(0, 100);
  return `${reqId} — Requisito ${uc?.ftId || ""}`.slice(0, 100);
}

function createFallbackHU(uc, idx) {
  const reqId = `REQ${pad3(idx + 1)}`;
  const titulo = `${reqId} — ${uc.titulo}`.slice(0, 100);
  return {
    reqId, ucId: uc.ucId, ftId: uc.ftId, epicId: uc.epicId,
    titulo,
    como:  "Usuário do sistema",
    quero: uc.titulo,
    para:  "realizar a funcionalidade prevista no caso de uso",
    regrasNegocio:      [],
    criteriosAceitacao: [{ id: "Critério 01", descricao: "A funcionalidade deve estar disponível conforme especificado no caso de uso." }],
    _fallback: true,
    workItem: {
      titulo,
      descricao: `HU gerada como fallback para ${uc.ftId} — ${uc.titulo}. Revise e complete os detalhes.`,
      criteriosAceitacao: "<ul><li><b>Critério 01</b> — A funcionalidade deve estar disponível conforme especificado no caso de uso.</li></ul>",
      tags: ["Requisito", reqId, uc.ftId, "revisar"],
    },
  };
}

async function fase3_gerarHUsParaUC(uc, huStartIdx, correction = "", rnPrefix = "RN") {
  const rn1 = `RN-${rnPrefix}-001`;
  const system = `Você é um Analista de Requisitos ágil. Gere TODAS as Histórias de Usuário para este Caso de Uso.
REGRAS OBRIGATÓRIAS:
1. QUANTIDADE DE HUs POR UC — REGRA INVEST:
   - UC "Manter" (CRUD com FP=Incluir, FA=Alterar/Excluir/Consultar): gere 1 HU por operação CRUD presente — tipicamente 4 HUs: "Incluir [Entidade]", "Alterar [Entidade]", "Excluir [Entidade]", "Consultar [Entidade]". Cada operação é independente, estimável e testável (princípio INVEST).
   - UC simples (1 ator, 1 objetivo claro): EXATAMENTE 1 HU.
   - UC com subprocessos distintos envolvendo atores diferentes: máx 3 HUs, cada uma com objetivo de negócio distinto.
   - Fluxos de exceção NUNCA geram HU separada — tornam-se critérios de aceitação da HU correspondente (ex: exceção de saldo insuficiente → critério de aceitação da HU "Incluir Pagamento").
2. "como": OBRIGATÓRIO — persona específica com perfil (ex: "Usuário com perfil Administrador"). NUNCA deixe vazio.
3. "quero": OBRIGATÓRIO — ação clara em verbo no infinitivo. Exemplos: "consultar o saldo da conta", "registrar novo pagamento recorrente". NUNCA deixe vazio.
3b. "workItem.titulo": OBRIGATÓRIO — deve iniciar com verbo no infinitivo. Ex: "Consultar Saldo da Conta", "Registrar Pagamento Recorrente". NUNCA use substantivos como título: ERRADO "Consulta de Saldo", "Registro de Pagamento".
4. Regras de negócio: IDs no padrão "${rn1}", sequencial. "nome": substantivo curto (máx 5 palavras). "descricao": frase completa. "origemPasso": passo FP onde a regra se aplica (ex: "FP-2").
5. Critérios: id "Critério 01", "Critério 02"...
Retorne SOMENTE JSON sem markdown:
{"hus":[{"reqId":"REQ001","titulo":"string","como":"Usuário com perfil X","quero":"realizar ação Y","para":"obter benefício Z","regrasNegocio":[{"id":"${rn1}","nome":"Nome Curto","descricao":"Descrição da regra","origemPasso":"FP-2"}],"criteriosAceitacao":[{"id":"Critério 01","descricao":"string"}],"workItem":{"titulo":"string","descricao":"string","criteriosAceitacao":"string","tags":["string"]}}]}`;
  const corrNote = correction ? `\n\n⚠ CORREÇÃO SOLICITADA PELO ANALISTA: ${correction}` : "";
  // Envia apenas os campos relevantes para geração de HUs.
  // Passos renumerados a partir de 1 independente do valor original (evita confusão com passos 43, 44...).
  // Refs removidos dos passos — não são necessários para derivar HUs.
  const ucCompact = {
    ftId: uc.ftId, titulo: uc.titulo, atores: uc.atores,
    precondição: uc.precondição, posCondição: uc.posCondição,
    fluxoPrincipal: (uc.fluxoPrincipal || []).map((p, i) => ({
      passo: `FP-${i + 1}`, descricao: p.descricao,
    })),
    fluxosAlternativos: (uc.fluxosAlternativos || []).map(a => ({
      id: a.id, titulo: a.titulo, origemPasso: a.origemPasso, descricao: a.descricao,
    })),
    fluxosExcecao: (uc.fluxosExcecao || []).map(e => ({
      id: e.id, origemPasso: e.origemPasso, descricao: e.descricao, mensagem: e.mensagem,
    })),
  };
  const raw = await claude(
    `Caso de Uso:\n${JSON.stringify(ucCompact, null, 2)}\n\nGere as HUs. Primeira começa em REQ${pad3(huStartIdx + 1)}.${corrNote}`,
    system, 8192
  );
  const hus = safeJSON(raw)?.hus || [];
  hus.forEach((hu, i) => {
    const idx = huStartIdx + i;
    hu.reqId    = `REQ${pad3(idx + 1)}`;
    hu.ucId     = uc.ucId;
    hu.ucTitulo = uc.titulo || "";
    hu.ftId     = uc.ftId;
    hu.epicId   = uc.epicId;
    hu.titulo   = buildHUTitulo(hu, hu.reqId, uc);
    if (hu.workItem) hu.workItem.titulo = hu.titulo;
  });
  return hus;
}

// ════════════════════════════════════════════════════════════════════
// FASE 3b — Enriquecer nomes das Regras de Negócio via IA (batch)
// ════════════════════════════════════════════════════════════════════

async function enrichRNNames(hus) {
  // Coleta todas as RNs únicas pelo id
  const rnMap = new Map();
  hus.forEach(hu =>
    (hu.regrasNegocio || []).forEach(rn => {
      if (rn.id && !rnMap.has(rn.id)) rnMap.set(rn.id, rn.descricao || "");
    })
  );
  if (!rnMap.size) return hus;

  const rnsToName = Array.from(rnMap.entries()).map(([id, descricao]) => ({ id, descricao }));

  const system = `Você é um analista de requisitos sênior. Para cada regra de negócio recebida, gere um NOME curto e semântico.
REGRAS DO NOME:
1. Substantivo composto em Title Case, máx 4 palavras, SEM artigos e SEM preposições.
2. Deve capturar o CONCEITO de negócio central da regra — é um rótulo identificador, não uma ação.
3. Exemplos corretos: "Limite Diário Transação", "Prazo Liquidação PIX", "Bloqueio Conta Inadimplente", "Autenticação Duplo Fator".
4. Exemplos ERRADOS: "Limitar Transação", "Bloquear Conta", "O valor não pode", "Regra sobre limite".
Retorne SOMENTE JSON sem markdown: {"rns":[{"id":"RN001","nome":"Nome Semantico"}]}`;

  const raw = await claude(
    `Gere nomes semânticos para as regras abaixo:\n${JSON.stringify(rnsToName, null, 2)}`,
    system, 1500
  );

  const result = safeJSON(raw)?.rns || [];
  const nameMap = new Map(result.map(r => [r.id, r.nome]).filter(([, n]) => n));

  // Injeta os nomes gerados em todas as HUs
  return hus.map(hu => ({
    ...hu,
    regrasNegocio: (hu.regrasNegocio || []).map(rn => ({
      ...rn,
      nome: nameMap.get(rn.id) || rn.nome || inferRNNome(rn.descricao),
    })),
  }));
}

// ════════════════════════════════════════════════════════════════════
// FASE 3c — Extrair RF e RNF por UC a partir das HUs já geradas
// Usa Haiku (barato) por UC; fallback seguro: arrays vazios.
// Retorna ucs[] atualizados com requisitosFuncionais e requisitosNaoFuncionais.
// ════════════════════════════════════════════════════════════════════

async function enrichRFRNF(hus, ucs, epicos = []) {
  const updated = ucs.map(uc => ({ ...uc }));

  // Agrupa UCs por épico para geração consolidada
  const epicGroups = new Map();
  updated.forEach(uc => {
    const key = uc.epicId || "__none__";
    if (!epicGroups.has(key)) epicGroups.set(key, []);
    epicGroups.get(key).push(uc);
  });

  for (const [epicId, epicUCs] of epicGroups) {
    const epico     = epicos.find(e => e.id === epicId);
    const epicTitle = epico?.titulo || epicUCs[0]?.titulo || epicId;
    const allHus    = hus.filter(h => epicUCs.some(u => u.ftId === h.ftId || u.ucId === h.ucId));

    if (!allHus.length) continue;

    const prefix = ucToRNPrefix(epicTitle);
    const system = `Você é um Analista de Requisitos sênior (ISO 29148 / UML 2.5.1).
Analise TODOS os Casos de Uso do Épico e gere Requisitos Funcionais no nível de CAPACIDADE DO SISTEMA.

REGRAS OBRIGATÓRIAS:
1. NÍVEL CAPACIDADE — RF descreve o que o sistema é capaz de fazer, independente de qual UC usa essa capacidade.
   CORRETO: "O sistema deve classificar registros de conciliação por categoria de divergência (duplicado, parcial, sem correspondência) com base em regras parametrizáveis."
   ERRADO:  "O sistema deve listar registros divergentes do lote selecionado." ← paráfrase do UC, proibido.
   TESTE: se remover o RF e o UC ainda descrever o mesmo comportamento nos seus passos, o RF estava errado.

2. PROIBIDO — não gere RF que seja paráfrase do título, objetivo ou fluxo de um único UC. Se o RF só faz sentido para um UC, ele não é um RF — é parte do UC.

3. PRIORIDADE TRANSVERSAL — prefira RFs que atendem 2 ou mais UCs. Um RF com ucRefs: ["FT002","FT005","FT007"] vale mais que três RFs de um UC cada.

4. QUANTIDADE — entre 3 e 8 RF por épico. Menos RFs de melhor qualidade é preferível a mais RFs granulares.

5. "ucRefs" — lista dos ftIds que este RF atende (obrigatório). RF transversal lista todos os UCs beneficiados.

6. descricao — sentença declarativa modal: "O sistema deve [capacidade] [restrição/condição]."

7. origemPasso — passo FP do UC principal onde a capacidade é exercida. Use "" se transversal a múltiplos passos.

8. prioridade — "Alta" | "Média" | "Baixa"

9. verificacao — como confirmar que a capacidade está implementada (teste de integração, critério mensurável).

10. RNF — entre 2 e 4 por épico. Somente restrições de qualidade mensuráveis e críticas. Não repita RNFs genéricos entre épicos.

Retorne SOMENTE JSON sem markdown:
{"rf":[{"id":"RF-${prefix}-001","descricao":"string","ucRefs":["FT001","FT002"],"origemPasso":"FP-2","prioridade":"Alta","verificacao":"string"}],"rnf":[{"id":"RNF-${prefix}-001","categoria":"Performance Efficiency","descricao":"string","metrica":"string","prioridade":"Alta"}]}`;

    try {
      const ucsCompact = epicUCs.map(uc => ({
        ftId: uc.ftId, titulo: uc.titulo,
        fluxoPrincipal: (uc.fluxoPrincipal || []).map((p, i) => ({ passo: `FP-${i + 1}`, descricao: p.descricao })),
      }));
      const husCompact = allHus.map(h => ({
        reqId: h.reqId, ftId: h.ftId,
        criteriosAceitacao: (h.criteriosAceitacao || []).map(c => c.descricao),
        regrasNegocio: (h.regrasNegocio || []).map(r => ({ id: r.id, descricao: r.descricao })),
      }));
      const raw = await claude(
        `Épico: ${epicId} — ${epicTitle}\n\nCasos de Uso:\n${JSON.stringify(ucsCompact, null, 2)}\n\nHUs:\n${JSON.stringify(husCompact, null, 2)}`,
        system, 3000, "claude-haiku-4-5-20251001"
      );
      const parsed = safeJSON(raw) || recoverPartialJSON(raw);
      if (!parsed) { console.warn(`[enrichRFRNF] épico ${epicId}: JSON inválido`); continue; }

      const rfs  = (parsed.rf  || []).filter(r => r.id && r.descricao);
      const rnfs = (parsed.rnf || []).filter(r => r.id && r.descricao);

      // Só limpa quando temos dados válidos para substituir
      epicUCs.forEach(uc => { uc.requisitosFuncionais = []; uc.requisitosNaoFuncionais = []; });

      // Distribui cada RF para o UC primário (primeiro em ucRefs)
      rfs.forEach(rf => {
        const primaryFtId = (rf.ucRefs || [])[0] || epicUCs[0].ftId;
        const owner = epicUCs.find(u => u.ftId === primaryFtId) || epicUCs[0];
        owner.requisitosFuncionais.push(rf);
      });
      // RNFs ficam no primeiro UC do épico (são épico-wide)
      if (rnfs.length) epicUCs[0].requisitosNaoFuncionais = rnfs;

      console.log(`[enrichRFRNF] épico ${epicId}: ${rfs.length} RF, ${rnfs.length} RNF (${epicUCs.length} UCs)`);
    } catch (e) {
      console.warn(`[enrichRFRNF] épico ${epicId} falhou (${e.message})`);
    }
  }
  return updated;
}

// ════════════════════════════════════════════════════════════════════
// MIGRAÇÃO — Extrai estrutura de documento existente via IA
// Preserva conteúdo original sem reescrever ou resumir
// ════════════════════════════════════════════════════════════════════

// Limite de caracteres por chunk (~4 chars/token; 6000 chars ≈ 1500 tokens entrada,
// deixa ~6500 tokens livres para saída JSON detalhada)
const MIGRATION_CHUNK_CHARS = 6000;

function buildMigrationSystem(epId, ucStartIdx, huStartIdx) {
  return `Você é especialista em migração de documentação de requisitos de software.
MISSÃO: Ler o trecho do documento e mapear TODA estrutura encontrada para o schema JSON abaixo.

REGRAS CRÍTICAS — PRESERVAÇÃO DE CONTEÚDO:
1. NUNCA reescreva, resuma ou altere qualquer texto original do documento.
2. Copie IDs, títulos e descrições EXATAMENTE como aparecem no original.
3. Se o documento não tiver um campo, deixe como string vazia "".
4. Preserve idioma e terminologia originais do documento.
5. Extraia TUDO — não omita nenhum UC, RF, RN, RNF ou critério presente.
6. Para documentos de Requisitos Funcionais: cada RF vira uma HU.
7. Para documentos de Casos de Uso: extraia fluxos completos com todos os passos.
8. Para documentos mistos: extraia tudo que encontrar em cada seção.
9. Marque "_migrated": true em todos os itens.
10. Se o trecho não contiver determinado tipo de artefato, retorne o array vazio [].
11. IDs de regras de negócio devem seguir o padrão "RN-{PREFIXO}-NNN" onde PREFIXO (3-4 letras) é derivado do título do UC ou módulo (ex: "RN-EXEC-001" para UC "Executar Conciliação"). IDs sequenciais dentro de cada UC.
12. PROIBIDO incluir em regrasNegocio: atributos de tabelas/entidades (campos de banco de dados como DataInicio, StatusExecucao, TotalBoletos, Quantidade, Valor etc.) — esses são dicionário de dados, NÃO regras de negócio.
13. PADRÃO MANTER (CRUD): se o documento trata de operações CRUD (Incluir/Alterar/Excluir/Consultar) sobre a MESMA entidade → consolide em UM ÚNICO UC com título "Manter [Entidade]". Fluxo principal = Consultar. FA1=Incluir, FA2=Alterar, FA3=Excluir. NÃO crie UCs separados para cada operação CRUD da mesma entidade.
14. NUMERAÇÃO DE PASSOS: os passos do fluxo principal podem estar numerados de forma não sequencial a partir de 1 (ex: 43, 44, 45 ou 3.1, 3.2). SEMPRE renumere a partir de "1" no output — passo 43 → "1", passo 44 → "2" etc. O número original pode ser ignorado; o que importa é a ordem relativa dentro do fluxo.
15. TABELAS DE CABEÇALHO DO UC: documentos frequentemente descrevem atributos do UC em tabela (linhas como "Identificador | UC-07", "Ator Principal | Operador", "Pré-condições | texto", "Pós-condições | texto", "Gatilho | texto"). Mapeie cada célula ao campo correto do schema: Identificador→ucId, Ator Principal→atores[], Pré-condições→precondição, Pós-condições→posCondição, Gatilho→campo "gatilho" (NÃO append a precondição). NÃO trate essas linhas como passos do fluxo.

Retorne SOMENTE JSON sem markdown:
{"epico":{"id":"${epId}","titulo":"nome do módulo/domínio identificado","objetivo":"objetivo extraído","funcIds":[],"manterEntidades":[]},"ucs":[{"ftId":"FT${pad3(ucStartIdx + 1)}","ucId":"UC${pad3(ucStartIdx + 1)}","titulo":"título original","atores":["ator original"],"precondição":"texto original","gatilho":"evento ou ação do ator que inicia o UC","fluxoPrincipal":[{"passo":"1","descricao":"texto original","refs":["RN-PREF-001"]}],"fluxosAlternativos":[{"id":"FA1","titulo":"título original","origemPasso":"FP-2","descricao":"Este fluxo alternativo se inicia quando...","passos":["texto original"]}],"fluxosExcecao":[{"id":"FE1","origemPasso":"FP-2","descricao":"Este fluxo de exceção ocorre quando...","mensagem":"mensagem original","retorno":"retorno original"}],"posCondição":"texto original","epicId":"${epId}","epicTitulo":"","_migrated":true}],"hus":[{"reqId":"REQ${pad3(huStartIdx + 1)}","titulo":"título original","como":"persona/ator ou 'Usuário do sistema'","quero":"ação original","para":"benefício original","ucId":"","ftId":"","epicId":"${epId}","regrasNegocio":[{"id":"RN-PREF-001","nome":"nome da regra","descricao":"texto original","origemPasso":"FP-2"}],"criteriosAceitacao":[{"id":"Critério 01","descricao":"texto original"}],"workItem":{"titulo":"","descricao":"","criteriosAceitacao":"","tags":["Migrado"]},"_migrated":true}]}`;
}

async function migrarDocumentoChunk(filename, content, epIdx, ucStartIdx, huStartIdx) {
  const epId = `EP${pad3(epIdx + 1)}`;
  const system = buildMigrationSystem(epId, ucStartIdx, huStartIdx);
  const raw = await claude(
    `Arquivo: ${filename}\n\nConteúdo:\n${content}`,
    system, 8192
  );
  // Tenta parse normal primeiro; se falhar, tenta recuperar JSON truncado
  const parsed = safeJSON(raw) || recoverPartialJSON(raw);
  if (!parsed) throw new Error(`JSON inválido. Resposta (início): "${raw?.slice(0, 120)}"`);
  return parsed;
}

async function migrarDocumento(filename, content, epIdx, ucStartIdx, huStartIdx, onProgress) {
  const notify = onProgress || (() => {});

  notify("🧹 Normalizando estrutura do documento...");
  content = await fase0_normalizarTexto(content, filename);

  // Documento cabe em uma chamada só
  if (content.length <= MIGRATION_CHUNK_CHARS) {
    const result = await migrarDocumentoChunk(filename, content, epIdx, ucStartIdx, huStartIdx);
    if (!result) throw new Error(`"${filename}": IA não retornou JSON válido.`);
    return result;
  }

  // Documento grande — processa em partes e consolida
  const chunks = chunkText(content, MIGRATION_CHUNK_CHARS);
  notify(`📄 Documento grande: dividido em ${chunks.length} partes para processamento...`);
  let epico = null;
  const allUCs = [];
  const allHUs = [];
  let ucIdx = ucStartIdx;
  let huIdx = huStartIdx;
  const chunkErrors = [];

  for (let i = 0; i < chunks.length; i++) {
    notify(`  ↳ Parte ${i + 1}/${chunks.length} (${Math.round(chunks[i].length / 1000)}k chars)...`);
    let result;
    try {
      result = await migrarDocumentoChunk(
        `${filename} [parte ${i + 1}/${chunks.length}]`,
        chunks[i], epIdx, ucIdx, huIdx
      );
    } catch (e) {
      const msg = `Parte ${i + 1}/${chunks.length} falhou: ${e.message}`;
      chunkErrors.push(msg);
      notify(`  ⚠ ${msg}`);
      console.warn(`[migração] ${msg}`);
      continue;
    }

    // Usa o épico do primeiro chunk com dados válidos
    if (!epico && result.epico?.titulo) epico = result.epico;

    for (const uc of (result.ucs || [])) {
      uc.ftId = `FT${pad3(ucIdx + 1)}`;
      uc.ucId = uc.ftId;
      uc._migrated = true;
      allUCs.push(uc);
      ucIdx++;
    }
    for (const hu of (result.hus || [])) {
      hu.reqId = `REQ${pad3(huIdx + 1)}`;
      hu._migrated = true;
      allHUs.push(hu);
      huIdx++;
    }
  }

  if (!epico && !allUCs.length && !allHUs.length) {
    const details = chunkErrors.length
      ? `\nErros: ${chunkErrors.join(" | ")}`
      : "";
    throw new Error(`"${filename}": nenhum artefato extraído em ${chunks.length} partes.${details}`);
  }

  // Fallback de épico se nenhum chunk retornou
  if (!epico) {
    epico = {
      id: `EP${pad3(epIdx + 1)}`,
      titulo: filename.replace(/\.[^.]+$/, ""),
      objetivo: "",
      funcIds: [],
      manterEntidades: [],
    };
  }

  return { epico, ucs: allUCs, hus: allHUs };
}

// ════════════════════════════════════════════════════════════════════
// FASE 4 — Gerar CTs para um UC
// ════════════════════════════════════════════════════════════════════

async function fase4_gerarCTs(uc, husDoUC, correction = "", rnfsDoUC = []) {
  const firstReqId = husDoUC[0]?.reqId || "";
  const rnfsComMetrica = rnfsDoUC.filter(r => r.metrica && r.metrica !== "A definir");
  const rnfInstr = rnfsComMetrica.length
    ? `\n6. Para cada RNF com metrica definida, gere 1 CT adicional de tipo 'Nao Funcional' com 'dado'=cenário de carga/contexto, 'quando'=ação que estresse o requisito, 'entao'=métrica esperada. Vincule ao reqId da HU mais relacionada.\nRNFs com métrica: ${JSON.stringify(rnfsComMetrica.map(r => ({ id: r.id, categoria: r.categoria, metrica: r.metrica })))}`
    : "";
  const system = `Você é um QA especialista em BDD. Gere Casos de Teste para este UC/Feature.
REGRAS OBRIGATÓRIAS:
1. Mínimo 1 CT por HU/Requirement — cada HU DEVE ter ao menos um CT com "reqId" igual ao seu "reqId".
2. CTs extras para fluxos alternativos e de exceção → vincule ao "reqId" da HU mais relevante.
3. Identificador: CT-${uc.ftId}-[nn] sequencial (01, 02...).
4. "reqId": OBRIGATÓRIO — ID da HU que este CT valida (ex: "${firstReqId}").
5. "fluxo": "Principal", "FA1", "FA2", "FE1" etc. conforme o fluxo coberto.${rnfInstr}
Retorne SOMENTE JSON:
{"cts":[{"identificador":"CT-${uc.ftId}-01","reqId":"${firstReqId}","fluxo":"Principal","tipo":"Funcional","dado":"contexto/estado inicial","e":"pré-condição","quando":"ação realizada","entao":"resultado esperado"},{"identificador":"CT-${uc.ftId}-NF01","reqId":"${firstReqId}","fluxo":"RNF","tipo":"Nao Funcional","dado":"contexto","e":"pre-condicao","quando":"acao","entao":"metrica esperada"}]}`;
  const corrNote = correction ? `\n\n⚠ CORREÇÃO SOLICITADA PELO ANALISTA: ${correction}` : "";
  const raw = await claude(
    `UC:\n${JSON.stringify(uc, null, 2)}\nHUs (Requirements):\n${JSON.stringify(husDoUC, null, 2)}\n\nGere CTs — mínimo 1 por HU.${corrNote}`,
    system, 3000
  );
  const cts = safeJSON(raw)?.cts || [];
  cts.forEach(ct => { ct.ucId = uc.ucId; ct.ftId = uc.ftId; ct.epicId = uc.epicId; });

  // Garante 1 CT por HU que ficou sem cobertura
  const coveredReqs = new Set(cts.map(ct => ct.reqId).filter(Boolean));
  husDoUC.forEach((hu, i) => {
    if (!coveredReqs.has(hu.reqId)) {
      cts.push({
        identificador: `CT-${uc.ftId}-${String(cts.length + 1).padStart(2, "0")}`,
        reqId:   hu.reqId,
        fluxo:   "Principal",
        tipo:    "Funcional",
        dado:    `Usuário autenticado com permissão para ${uc.titulo}`,
        e:       `O sistema está disponível e o usuário possui os dados necessários`,
        quando:  hu.quero || `executar ${uc.titulo}`,
        entao:   (hu.criteriosAceitacao?.[0]?.descricao) || `O sistema executa a ação conforme ${hu.reqId}`,
        ucId:    uc.ucId, ftId: uc.ftId, epicId: uc.epicId, _fallback: true,
      });
    }
  });

  return cts;
}

// ════════════════════════════════════════════════════════════════════
// FILE READING
// ════════════════════════════════════════════════════════════════════

function readAsText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Falha ao ler arquivo")); r.readAsText(file, "utf-8"); });
}
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Falha ao ler arquivo")); r.readAsArrayBuffer(file); });
}
function readAsBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Falha ao ler arquivo")); r.readAsDataURL(file); });
}
async function loadMammoth() {
  if (window.mammoth) return;
  await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"; s.onload = res; s.onerror = () => rej(new Error("Falha ao carregar mammoth.js")); document.head.appendChild(s); });
}
async function extractText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "txt" || ext === "md") return readAsText(file);
  if (ext === "docx" || ext === "doc") {
    await loadMammoth();
    const ab = await readAsArrayBuffer(file);
    const r = await window.mammoth.extractRawText({ arrayBuffer: ab });
    if (!r?.value?.trim()) throw new Error("DOCX sem conteúdo legível.");
    return r.value;
  }
  if (ext === "pdf") {
    const b64 = await readAsBase64(file);
    return claude(
      [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
       { type: "text", text: "Extraia todo o texto deste PDF preservando estrutura. Retorne apenas o texto." }],
      "Extrator de texto. Retorne apenas o conteúdo textual.", 4000
    );
  }
  throw new Error("Formato não suportado. Use PDF, DOCX, DOC, TXT ou MD.");
}

// ════════════════════════════════════════════════════════════════════
// AZURE DEVOPS — cria work items com hierarquia pai
// ════════════════════════════════════════════════════════════════════

async function createAzureWorkItem(org, project, pat, type, title, description, acceptanceCriteria, tags, parentUrl, areaPath, wikiUrl) {
  const url = `/devops/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`;
  const token = btoa(`:${pat}`);
  const body = [
    { op: "add", path: "/fields/System.Title", value: title },
    { op: "add", path: "/fields/System.Description", value: description || "" },
  ];
  if (areaPath) body.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
  if (acceptanceCriteria) body.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: acceptanceCriteria });
  if (tags?.length) body.push({ op: "add", path: "/fields/System.Tags", value: tags.join("; ") });
  if (parentUrl) body.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: parentUrl, attributes: {} } });
  if (wikiUrl) body.push({ op: "add", path: "/relations/-", value: { rel: "Hyperlink", url: wikiUrl, attributes: { comment: "Documentação Wiki" } } });
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json-patch+json", Authorization: `Basic ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 180)}`); }
  return r.json();
}

// ════════════════════════════════════════════════════════════════════
// WIKI — geração de markdown e push via Git REST API
// Templates alinhados com Squad-Cloud-Wiki/documentacao/
// ════════════════════════════════════════════════════════════════════

function toSlug(str) {
  return (str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

// YAML header — criado_em vazio: pipeline preenche via git log
function wikiYaml(titulo, modulo, tipo) {
  return `---\ntitle: "${titulo}"\nmodulo: "${modulo}"\ntipo: "${tipo}"\ndoc_version: "1.0.0"\n# Ciclo: proposto → aprovado → implementado → verificado → satisfeito → obsoleto\nstatus: "proposto"\ncriado_em: ""\nlast_modified: ""\nlast_author: ""\nlast_commit: ""\n---\n\n`;
}

function wikiHistorico() {
  return `\n---\n\n## Historico de Alteracoes\n\n<!-- HISTORICO:START -->\n| Versao | Data | Autor | Commit | Mensagem | Aprovado Por |\n|--------|------|-------|--------|----------|--------------|\n| - | - | - | - | _Aguardando primeiro commit_ | - |\n<!-- HISTORICO:END -->\n`;
}

// ── Índice do módulo ─────────────────────────────────────────────
function wikiModuleIndex(ep, ucsEp, modulo) {
  const titulo = ep.titulo;
  let md = wikiYaml(titulo, modulo, "indice-modulo");
  md += `# ${titulo}\n\n`;
  md += `> Documentacao do modulo **${titulo}**.\n\n`;
  md += `## Indice\n\n`;
  md += `- [Casos de Uso](Casos-de-Uso/Casos-de-Uso)\n`;
  md += `- [Regras de Negocio](Regras-de-Negocio)\n`;
  md += `- [Mensagens de Sistema](Mensagens-de-Sistema)\n`;
  md += `- [Requisitos Funcionais](Requisitos-Funcionais)\n`;
  md += `- [Requisitos Nao Funcionais](Requisitos-Nao-Funcionais)\n`;
  return md + wikiHistorico();
}

// ── Índice de Casos de Uso ───────────────────────────────────────
function wikiUCIndex(ep, ucsEp, modulo) {
  let md = wikiYaml(`Casos de Uso - ${ep.titulo}`, modulo, "indice-casos-de-uso");
  md += `# Casos de Uso - ${ep.titulo}\n\n`;
  md += `| ID | Nome | Status |\n|----|------|--------|\n`;
  ucsEp.forEach(uc => {
    const slug = `${uc.ftId}-${toSlug(uc.titulo)}`;
    md += `| ${uc.ftId} | [${uc.titulo}](${slug}) | Proposto |\n`;
  });
  md += `\n> Siga os padroes em [Padroes e Convencoes](../../COR/Padroes-e-Convencoes)\n`;
  return md + wikiHistorico();
}

// ── Normaliza qualquer formato de referência de passo → "FP-N" ──
// Aceita: "FP-2", "FP2", "fp-2", "passo 2", "2", 2
function normalizePasso(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  const m = s.match(/(\d+)/);
  if (!m) return null;
  return `FP-${m[1]}`;
}

// Garante que refs é sempre array de strings, mesmo se IA retornar string ou null
function safeRefs(refs) {
  if (!refs) return [];
  if (Array.isArray(refs)) return refs.map(String).filter(Boolean);
  return String(refs).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════
// RESOLVER ÓRFÃOS COM IA
// Recebe todos os órfãos (RN/RF/RNF), lacunas e passos disponíveis.
// Retorna sugestões em lote: renomear, vincular ou remover.
// ════════════════════════════════════════════════════════════════════

async function resolverOrfaosIA(orfaosInfo, lacunas, ucs) {
  const allSteps = ucs.flatMap(uc =>
    (uc.fluxoPrincipal || []).map(p => ({
      ftId: uc.ftId,
      ucTitulo: (uc.titulo || "").slice(0, 40),
      passo: p.passo,
      descricao: (p.descricao || "").slice(0, 120),
    }))
  ).slice(0, 100);

  const lacunasInfo = lacunas.map(l => ({
    id: l.id,
    contexto: (l.ocorrencias || [])
      .map(o => `${o.ftId} FP-${o.passo}: ${(o.descricao || "").slice(0, 80)}`)
      .join(" | "),
  }));

  const system = `Você é um analista de requisitos sênior. Processe ÓRFÃOS e LACUNAS e sugira uma ação para cada item.

ÓRFÃO = definido nas HUs/UCs mas nunca referenciado nos passos do fluxo.
LACUNA = referenciado nos passos do fluxo mas sem definição correspondente.

Ações para ÓRFÃO:
1. "renomear" — o ID do órfão diverge de uma lacuna mas representam a mesma regra. novoId = ID da lacuna.
2. "vincular" — pertence semanticamente a um passo do fluxo. Forneça ftId e passo.
3. "remover" — é duplicado, vazio ou irrelevante.

Ações para LACUNA:
4. "remover_ref" — a referência nos passos é inválida ou foi substituída; remove a referência dos passos.
5. "renomear" — existe um órfão semanticamente equivalente. novoId = ID do órfão existente.

Prefira "renomear" quando órfão e lacuna representam a mesma regra com IDs diferentes.
Retorne SOMENTE JSON sem markdown:
{"sugestoes":[{"rnId":"string","acao":"renomear|vincular|remover|remover_ref","novoId":"string ou null","ftId":"string ou null","passo":"string ou null","motivo":"frase curta"}]}`;

  const raw = await claude(
    `ÓRFÃOS:\n${JSON.stringify(orfaosInfo, null, 2)}\n\nLACUNAS (referências sem definição):\n${JSON.stringify(lacunasInfo, null, 2)}\n\nPASSOS DISPONÍVEIS:\n${JSON.stringify(allSteps, null, 2)}\n\nSugira ação para cada ÓRFÃO e cada LACUNA.`,
    system,
    4096,
    "claude-haiku-4-5-20251001"
  );

  return (safeJSON(raw) || recoverPartialJSON(raw))?.sugestoes || [];
}

// ════════════════════════════════════════════════════════════════════
// AUTO-VINCULAR POR origemPasso
// Popula p.refs com RNs cujo origemPasso aponta para aquele passo.
// Determinístico, sem IA — usa dados já presentes no modelo.
// ════════════════════════════════════════════════════════════════════

function autoVincularPorOrigemPasso(ucs, hus) {
  return ucs.map(uc => {
    const husDoUC = hus.filter(h => h.ftId === uc.ftId || h.ucId === uc.ucId);
    // Monta mapa passoNorm → Set de RN IDs via origemPasso
    const refsByPasso = {};
    husDoUC.forEach(hu => {
      (hu.regrasNegocio || []).forEach(rn => {
        if (!rn.id || !rn.origemPasso) return;
        const key = normalizePasso(rn.origemPasso);
        if (!key) return;
        if (!refsByPasso[key]) refsByPasso[key] = new Set();
        refsByPasso[key].add(rn.id);
      });
    });
    if (!Object.keys(refsByPasso).length) return uc;
    const updatedFP = (uc.fluxoPrincipal || []).map(p => {
      const key = normalizePasso(p.passo);
      if (!key || !refsByPasso[key]) return p;
      const merged = new Set([...safeRefs(p.refs), ...refsByPasso[key]]);
      return { ...p, refs: [...merged] };
    });
    return { ...uc, fluxoPrincipal: updatedFP };
  });
}

// ════════════════════════════════════════════════════════════════════
// AUDITORIA DE REFERÊNCIAS
// Detecta lacunas (RN citadas nos passos mas não definidas nas HUs)
// e órfãos (RN definidas nas HUs mas nunca citadas nos passos).
// ════════════════════════════════════════════════════════════════════

function auditarReferencias(ucs, hus) {
  const RN_PATTERN  = /RN-[A-Z]{2,8}-\d{3}/g;
  const RF_PATTERN  = /\bRF-[A-Z]{2,8}-\d{3}\b/g;
  const RNF_PATTERN = /\bRNF-[A-Z]{2,8}-\d{3}\b/g;

  // ── helper: adiciona referência sem duplicar ─────────────────────
  const addRef = (map, id, occ) => {
    if (!map.has(id)) map.set(id, []);
    const existing = map.get(id);
    if (!existing.some(o => o.ftId === occ.ftId && o.passo === occ.passo && o.fonte === occ.fonte))
      existing.push(occ);
  };

  // ── RN — definidos em hu.regrasNegocio ───────────────────────────
  const definidos    = new Set();
  const referenciados = new Map();
  hus.forEach(hu => (hu.regrasNegocio || []).forEach(rn => { if (rn.id) definidos.add(rn.id); }));

  // ── RF — definidos em uc.requisitosFuncionais ────────────────────
  const rfByUC   = new Map();   // rfId → ftId (para saber de qual UC é órfão)
  const referenciadosRF = new Map();
  ucs.forEach(uc => (uc.requisitosFuncionais || []).forEach(r => { if (r.id) rfByUC.set(r.id, uc.ftId); }));
  const definidosRF = new Set(rfByUC.keys());

  // ── RNF — definidos em uc.requisitosNaoFuncionais ────────────────
  const rnfByUC  = new Map();
  const referenciadosRNF = new Map();
  ucs.forEach(uc => (uc.requisitosNaoFuncionais || []).forEach(r => { if (r.id) rnfByUC.set(r.id, uc.ftId); }));
  const definidosRNF = new Set(rnfByUC.keys());

  // ── Varrer passos dos UCs ────────────────────────────────────────
  ucs.forEach(uc => {
    (uc.fluxoPrincipal || []).forEach(p => {
      const occ = { ftId: uc.ftId, ucTitulo: uc.titulo, passo: p.passo, descricao: p.descricao };
      safeRefs(p.refs).forEach(id => {
        if (id.startsWith("RN-"))  addRef(referenciados,   id, { ...occ, fonte: "refs" });
        if (id.startsWith("RF-"))  addRef(referenciadosRF,  id, { ...occ, fonte: "refs" });
        if (id.startsWith("RNF-")) addRef(referenciadosRNF, id, { ...occ, fonte: "refs" });
      });
      ((p.descricao || "").match(RN_PATTERN)  || []).forEach(id => addRef(referenciados,   id, { ...occ, fonte: "inline" }));
      ((p.descricao || "").match(RF_PATTERN)  || []).forEach(id => addRef(referenciadosRF,  id, { ...occ, fonte: "inline" }));
      ((p.descricao || "").match(RNF_PATTERN) || []).forEach(id => addRef(referenciadosRNF, id, { ...occ, fonte: "inline" }));
    });
  });

  // ── Referências implícitas via origemPasso nas RNs das HUs ───────
  // RNs com origemPasso preenchido já estão mapeadas — não são órfãs reais.
  // Alinha a auditoria com a lógica do wikiUCFile que já usa origemPasso.
  hus.forEach(hu => {
    const uc = ucs.find(u => u.ftId === hu.ftId || u.ucId === hu.ucId);
    if (!uc) return;
    (hu.regrasNegocio || []).forEach(rn => {
      if (!rn.id || !rn.origemPasso) return;
      const passoNorm = normalizePasso(rn.origemPasso);
      if (!passoNorm) return;
      const step = (uc.fluxoPrincipal || []).find(p => normalizePasso(p.passo) === passoNorm);
      const occ = {
        ftId: uc.ftId, ucTitulo: uc.titulo,
        passo: step?.passo || rn.origemPasso, descricao: step?.descricao || "",
        fonte: "origemPasso",
      };
      addRef(referenciados, rn.id, occ);
    });
  });

  const mkLacunas = (refs, defs) =>
    [...refs.entries()].filter(([id]) => !defs.has(id)).map(([id, ocorrencias]) => ({ id, ocorrencias })).sort((a, b) => a.id.localeCompare(b.id));
  const mkOrfaos = (defs, refs) =>
    [...defs].filter(id => !refs.has(id)).sort();

  // RF órfão: ucRefs vazio ou aponta apenas para ftIds inexistentes
  // RFs são capacidades do sistema — linkagem via ucRefs, não via p.refs
  const validFtIds = new Set(ucs.map(u => u.ftId));
  const rfItemMap  = new Map();
  ucs.forEach(uc => (uc.requisitosFuncionais || []).forEach(r => { if (r.id) rfItemMap.set(r.id, r); }));
  const orfaosRF = [...definidosRF].filter(id => {
    const rf   = rfItemMap.get(id);
    const refs = rf?.ucRefs || [];
    return refs.length === 0 || !refs.some(ref => validFtIds.has(ref));
  }).sort();

  // RNF não tem ucRefs — é épico-wide e já está dentro de uma UC por definição
  // Considera órfão apenas se o objeto não tiver descrição (incompleto)
  const rnfItemMap = new Map();
  ucs.forEach(uc => (uc.requisitosNaoFuncionais || []).forEach(r => { if (r.id) rnfItemMap.set(r.id, r); }));
  const orfaosRNF = [...definidosRNF].filter(id => {
    const rnf = rnfItemMap.get(id);
    return !rnf?.descricao;
  }).sort();

  return {
    // RN
    definidos, referenciados,
    lacunas:  mkLacunas(referenciados,   definidos),
    orfaos:   mkOrfaos(definidos,        referenciados),
    // RF
    definidosRF, rfByUC, referenciadosRF,
    lacunasRF:  mkLacunas(referenciadosRF,  definidosRF),
    orfaosRF,
    // RNF
    definidosRNF, rnfByUC, referenciadosRNF,
    lacunasRNF:  mkLacunas(referenciadosRNF, definidosRNF),
    orfaosRNF,
  };
}

// ── Caso de Uso individual ───────────────────────────────────────
function wikiUCFile(uc, husDoUC, ep, modulo) {
  const titulo = `${uc.ftId} - ${uc.titulo}`;
  let md = wikiYaml(titulo, modulo, "caso-de-uso");
  md += `# ${titulo}\n\n**Modulo:** ${ep.titulo}\n\n---\n\n`;

  // 1. Descrição
  md += `## 1. Descricao\n\n> ${uc.titulo}${ep.objetivo ? ` — ${ep.objetivo}` : ""}\n\n`;

  // 2. Atores
  md += `## 2. Atores\n\n| Ator | Tipo | Descricao |\n|------|------|----------|\n`;
  const atores = uc.atores || ["Usuario"];
  atores.forEach((a, i) => { md += `| ${a} | ${i === 0 ? "Principal" : "Secundario"} | - |\n`; });
  md += `| Sistema | Secundario | - |\n\n`;

  // 3. Gatilho
  md += `## 3. Gatilho\n\n> ${uc.gatilho || "_A definir — evento ou ação que inicia este caso de uso._"}\n\n`;

  // 4. Pré-condições
  md += `## 4. Pre-condicoes\n\n`;
  const preConds = (uc.precondição || "").split(/[.;]/).map(s => s.trim()).filter(Boolean);
  if (preConds.length) preConds.forEach(c => { md += `- [ ] ${c}.\n`; });
  else md += `- [ ] O usuario deve estar autenticado.\n`;
  md += "\n";

  // 5. Pós-condições
  md += `## 5. Pos-condicoes\n\n`;
  const posConds = (uc.posCondição || "").split(/[.;]/).map(s => s.trim()).filter(Boolean);
  if (posConds.length) posConds.forEach(c => { md += `- [ ] ${c}.\n`; });
  else md += `- [ ] ...\n`;
  md += "\n";

  // Monta mapa passo-normalizado → Set de IDs de RN/MSG
  // Usa normalizePasso para aceitar qualquer formato que a IA retornar
  const refsByPasso = {};
  husDoUC.forEach(h => {
    (h.regrasNegocio || []).forEach(rn => {
      const key = normalizePasso(rn.origemPasso);
      if (key) {
        if (!refsByPasso[key]) refsByPasso[key] = new Set();
        refsByPasso[key].add(rn.id);
      }
    });
  });

  // 6. Fluxo Principal — âncoras + coluna Referências
  md += `## 6. Fluxo Principal\n\n| Passo | Ator | Acao | Referencias |\n|-------|------|------|-------------|\n`;
  (uc.fluxoPrincipal || []).forEach(p => {
    const passoNorm = normalizePasso(p.passo) || `FP-${p.passo}`;
    const passoNum  = passoNorm.replace("FP-", "");
    const anchorId  = `fp-${passoNum}`;
    const ator = /^sistema|^o sistema/i.test(p.descricao) ? "Sistema" : (atores[0] || "Usuario");
    // Merge: refs explícitos da IA + refs inferidos de RN.origemPasso
    // safeRefs garante que refs é sempre array mesmo se IA retornou string
    const refsSet = new Set([...safeRefs(p.refs), ...(refsByPasso[passoNorm] || [])]);
    const refsLinks = [...refsSet]
      .map(id => `[${id}](#${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")})`)
      .join(" · ");
    md += `| <a id="${anchorId}"></a>**${passoNorm}** | ${ator} | ${p.descricao} | ${refsLinks || "—"} |\n`;
  });
  md += "\n";

  // 7. Fluxos Alternativos
  md += `## 7. Fluxos Alternativos\n\n`;
  if ((uc.fluxosAlternativos || []).length) {
    uc.fluxosAlternativos.forEach(a => {
      const anchorId  = a.id.toLowerCase();
      const origemNorm = normalizePasso(a.origemPasso || a.origem);
      const origemRef  = origemNorm
        ? `[${origemNorm}](#${origemNorm.toLowerCase()})`
        : "—";
      md += `### <a id="${anchorId}"></a>${a.id} - ${a.titulo || "Fluxo Alternativo"}\n\n`;
      if (a.descricao) {
        md += `> ${a.descricao}\n\n`;
      } else if (origemNorm) {
        md += `> Este fluxo alternativo se inicia a partir do ${origemRef} do fluxo principal.\n\n`;
      }
      md += `**Ponto de extensão:** ${origemRef}\n\n`;
      md += `| Passo | Ator | Acao |\n|-------|------|------|\n`;
      (a.passos || []).forEach((p, i) => {
        const atorStep = /^sistema|^o sistema/i.test(p) ? "Sistema" : (atores[0] || "Usuário");
        md += `| ${i + 1} | ${atorStep} | ${p} |\n`;
      });
      // Ponto de retorno explícito
      const numFA = (a.passos || []).length;
      const retornoFA = origemNorm
        ? `Retorna ao ${origemRef} do fluxo principal.`
        : "Caso de uso encerra.";
      md += `| ${numFA + 1} | Sistema | ${retornoFA} |\n`;
      md += "\n";
    });
  } else {
    md += `### FA01 - Fluxo Alternativo\n\n> _Descreva quando este fluxo é acionado._\n\n**Ponto de extensão:** [FP-X](#fp-x)\n\n| Passo | Ator | Acao |\n|-------|------|------|\n| 1 | ... | ... |\n| 2 | Sistema | Retorna ao [FP-X](#fp-x) do fluxo principal. |\n\n`;
  }

  // 8. Fluxos de Exceção
  md += `## 8. Fluxos de Excecao\n\n`;
  if ((uc.fluxosExcecao || []).length) {
    uc.fluxosExcecao.forEach(e => {
      const anchorId   = e.id.toLowerCase();
      const origemNorm = normalizePasso(e.origemPasso || e.gatilho);
      const origemRef  = origemNorm
        ? `[${origemNorm}](#${origemNorm.toLowerCase()})`
        : "—";
      const label = e.mensagem ? e.mensagem.slice(0, 50) : (e.id || "Fluxo de Excecao");
      md += `### <a id="${anchorId}"></a>${e.id} - ${label}\n\n`;
      if (e.descricao) {
        md += `> ${e.descricao}\n\n`;
      } else if (origemNorm) {
        md += `> Este fluxo de excecao ocorre a partir do ${origemRef} do fluxo principal.\n\n`;
      }
      md += `**Ponto de extensão:** ${origemRef}\n\n`;
      md += `| Passo | Ator | Acao |\n|-------|------|------|\n`;
      md += `| 1 | Sistema | ${e.mensagem || "Exibe mensagem de erro"} |\n`;
      const retornoFE = e.retorno || (origemNorm ? `Retorna ao ${origemRef} do fluxo principal` : "Caso de uso encerra");
      md += `| 2 | Sistema | ${retornoFE} |\n`;
      md += "\n";
    });
  } else {
    md += `### FE01 - Fluxo de Excecao\n\n> _Descreva quando este fluxo é acionado._\n\n**Ponto de extensão:** [FP-X](#fp-x)\n\n| Passo | Ator | Acao |\n|-------|------|------|\n| 1 | Sistema | Exibe mensagem MSG001 |\n\n`;
  }

  // 9. Regras de Negócio Aplicadas — com âncoras e origem
  const rnsUC = husDoUC.flatMap(h => h.regrasNegocio || []);
  const rnsSeen = new Set();
  const rnsUniq = rnsUC.filter(r => { if (rnsSeen.has(r.id)) return false; rnsSeen.add(r.id); return true; });
  md += `## 9. Regras de Negocio Aplicadas\n\n| ID | Nome | Descricao | Origem no Fluxo |\n|----|------|-----------|----------------|\n`;
  if (rnsUniq.length) {
    rnsUniq.forEach(r => {
      const nome = r.nome || inferRNNome(r.descricao);
      const origemNorm = normalizePasso(r.origemPasso);
      const origemLink = origemNorm ? `[${origemNorm}](#${origemNorm.toLowerCase()})` : "—";
      md += `| <a id="${r.id.toLowerCase()}"></a>${r.id} | ${nome} | ${r.descricao} | ${origemLink} |\n`;
    });
  } else {
    md += `| RN001 | Nome | ... | — |\n`;
  }
  md += "\n";

  // 10. Requisitos Funcionais (derivados das HUs via IA)
  const rfs  = uc.requisitosFuncionais    || [];
  const rnfs = uc.requisitosNaoFuncionais || [];
  md += `## 10. Requisitos Funcionais\n\n| ID | Descricao | Origem no Fluxo |\n|----|-----------|----------------|\n`;
  if (rfs.length) {
    rfs.forEach(r => {
      const origemNorm = normalizePasso(r.origemPasso);
      const origemLink = origemNorm ? `[${origemNorm}](#${origemNorm.toLowerCase()})` : "—";
      md += `| <a id="${r.id.toLowerCase()}"></a>${r.id} | ${r.descricao} | ${origemLink} |\n`;
    });
  } else {
    md += `| RF001 | ... | — |\n`;
  }
  md += "\n";

  // 11. Requisitos Não Funcionais
  md += `## 11. Requisitos Nao Funcionais\n\n| ID | Categoria | Descricao | Metrica |\n|----|-----------|-----------|--------|\n`;
  if (rnfs.length) {
    rnfs.forEach(r => {
      md += `| <a id="${r.id.toLowerCase()}"></a>${r.id} | ${r.categoria || "—"} | ${r.descricao} | ${r.metrica || "A definir"} |\n`;
    });
  } else {
    md += `| RNF001 | Performance | ... | A definir |\n`;
  }
  md += "\n";

  // 12. Requisitos Relacionados
  md += `## 12. Requisitos Relacionados\n\n| ID | Titulo | Tipo |\n|----|--------|------|\n`;
  husDoUC.forEach(h => { md += `| ${h.reqId} | ${h.titulo} | Funcional |\n`; });
  md += "\n";

  // 13. Protótipo / Diagrama
  md += `## 13. Prototipo / Diagrama\n\n> _Inserir imagem ou link para diagrama BPMN/wireframe._\n`;

  // 14. Diagrama de Caso de Uso (Mermaid)
  let mermaid = `\n---\n\n## 14. Diagrama de Caso de Uso\n\n\`\`\`mermaid\nflowchart LR\n`;
  mermaid += `  actor["${atores[0] || 'Usuario'}"]\n`;
  mermaid += `  uc(["${uc.ftId}: ${uc.titulo}"])\n`;
  mermaid += `  actor --> uc\n`;
  (uc.fluxosAlternativos || []).forEach(fa => {
    const faId = fa.id.toLowerCase().replace(/\s/g, '_');
    mermaid += `  fa_${faId}(["${fa.id}: ${fa.titulo || fa.id}"])\n`;
    mermaid += `  uc -.->|extend| fa_${faId}\n`;
  });
  mermaid += `\`\`\`\n`;

  return md + wikiHistorico() + mermaid;
}

// ── Regras de Negócio ────────────────────────────────────────────
function wikiRNFile(ep, ucsEp, husEp, modulo) {
  const titulo = ep.titulo;
  const seen = new Set();
  const rns = [];
  husEp.forEach(h => (h.regrasNegocio || []).forEach(r => {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      rns.push({ ...r, reqId: h.reqId, ucId: h.ucId, ucTitulo: h.ucTitulo || "" });
    }
  }));
  let md = wikiYaml(`Regras de Negocio - ${titulo}`, modulo, "regras-de-negocio");
  md += `# Regras de Negocio - ${titulo}\n\n`;
  md += `## Tabela de Regras\n\n| ID | Nome | Descricao | Origem no Fluxo | Prioridade | Status |\n|----|------|-----------|----------------|-----------|--------|\n`;
  if (rns.length) {
    rns.forEach(r => {
      const nome = r.nome || inferRNNome(r.descricao);
      const origem = r.origemPasso || "—";
      md += `| ${r.id} | ${nome} | ${r.descricao} | ${origem} | Alta | Em elaboracao |\n`;
    });
  } else {
    md += `| RN001 | Nome da Regra | Descricao objetiva | — | Alta | Em elaboracao |\n`;
  }
  md += `\n---\n\n## Detalhamento\n\n`;
  if (rns.length) {
    rns.forEach(r => {
      const nome = r.nome || inferRNNome(r.descricao);
      // Link para o passo de origem dentro do arquivo de UC
      const origemNorm2 = normalizePasso(r.origemPasso);
      let origemLink = "Requisito / Decisao interna";
      if (origemNorm2) {
        // Resolve UC real via lookup para garantir ftId e slug corretos
        const uc = ucsEp.find(u => u.ftId === r.ucId || u.ucId === r.ucId);
        if (uc) {
          const ucSlug = `${uc.ftId}-${toSlug(uc.titulo)}`;
          origemLink = `[${origemNorm2} — ${uc.ftId}](Casos-de-Uso/${ucSlug}#${origemNorm2.toLowerCase().replace(/[^a-z0-9-]/g, "-")})`;
        } else {
          origemLink = origemNorm2;
        }
      }
      md += `### ${r.id} - ${nome}\n\n`;
      md += `**Descricao:** ${r.descricao}\n\n`;
      md += `**Justificativa:** ...\n\n`;
      md += `**Origem no Fluxo:** ${origemLink}\n\n`;
      md += `**Impacto nos modulos:** ${titulo}\n\n`;
      md += `**Excecoes:** ...\n\n`;
    });
  } else {
    md += `### RN001 - Nome da Regra\n\n**Descricao:** ...\n\n**Justificativa:** ...\n\n**Origem no Fluxo:** —\n\n**Impacto nos modulos:** ...\n\n**Excecoes:** ...\n\n`;
  }
  return md + wikiHistorico();
}

// ── Mensagens de Sistema ─────────────────────────────────────────
function extractMsgsFromUCs(ucsEp) {
  const msgs = [];
  let msgIdx = 1;
  ucsEp.forEach(uc => {
    (uc.fluxosExcecao || []).forEach(e => {
      if (e.mensagem) {
        const tipo = /erro|falha|invalido/i.test(e.mensagem) ? "Erro"
                   : /atencao|verifique/i.test(e.mensagem) ? "Alerta"
                   : /sucesso|concluido/i.test(e.mensagem) ? "Sucesso" : "Informacao";
        const acao = tipo === "Erro" ? "Permitir retry" : tipo === "Alerta" ? "Manter tela" : tipo === "Sucesso" ? "Fechar modal" : "Exibir tela vazia";
        const origemNorm4 = normalizePasso(e.origemPasso || e.gatilho);
        const ucSlug = `${uc.ftId}-${toSlug(uc.titulo || uc.ftId)}`;
        const origemLink = origemNorm4
          ? `[${uc.ftId} ${origemNorm4}](Casos-de-Uso/${ucSlug}#${origemNorm4.toLowerCase()})`
          : `${uc.ftId} — ${e.id}`;
        msgs.push({ id: `MSG${String(msgIdx++).padStart(3, "0")}`, tipo, contexto: origemLink, mensagem: e.mensagem, acao });
      }
    });
  });
  return msgs;
}

function wikiMsgFile(ep, ucsEp, modulo) {
  const titulo = ep.titulo;
  let msgs = extractMsgsFromUCs(ucsEp);
  if (!msgs.length) {
    msgs = [
      { id: "MSG001", tipo: "Sucesso",    contexto: "—", mensagem: "Operacao realizada com sucesso.", acao: "Fechar modal" },
      { id: "MSG002", tipo: "Alerta",     contexto: "—", mensagem: "Atencao: verifique os dados informados.", acao: "Manter tela" },
      { id: "MSG003", tipo: "Erro",       contexto: "—", mensagem: "Erro ao processar a solicitacao. Tente novamente.", acao: "Permitir retry" },
      { id: "MSG004", tipo: "Informacao", contexto: "—", mensagem: "Nenhum registro encontrado.", acao: "Exibir tela vazia" },
    ];
  }
  let md = wikiYaml(`Mensagens de Sistema - ${titulo}`, modulo, "mensagens-de-sistema");
  md += `# Mensagens de Sistema - ${titulo}\n\n`;
  md += `## Tabela de Mensagens\n\n| ID | Tipo | Ponto de Origem | Mensagem | Acao Esperada |\n|----|------|-----------------|----------|---------------|\n`;
  msgs.forEach(m => { md += `| ${m.id} | ${m.tipo} | ${m.contexto} | ${m.mensagem} | ${m.acao} |\n`; });
  md += `\n## Legenda\n\n| Tipo | Uso |\n|------|-----|\n`;
  md += `| Sucesso | Operacao concluida com exito |\n`;
  md += `| Alerta | Situacao que requer atencao |\n`;
  md += `| Erro | Falha - requer acao |\n`;
  md += `| Informacao | Mensagem neutra |\n`;
  md += `| Seguranca | Acesso negado / sessao expirada |\n`;
  return md + wikiHistorico();
}

// ── Requisitos Funcionais ────────────────────────────────────────
function wikiRFFile(ep, ucsEp, husEp, modulo) {
  const titulo = ep.titulo;
  // Usa os RF gerados pelo enrichRFRNF em uc.requisitosFuncionais
  const rfs = ucsEp.flatMap(uc =>
    (uc.requisitosFuncionais || []).map(rf => ({ ...rf, ucId: uc.ucId, ftId: uc.ftId, ucTitulo: uc.titulo }))
  );
  let md = wikiYaml(`Requisitos Funcionais - ${titulo}`, modulo, "requisitos-funcionais");
  md += `# Requisitos Funcionais - ${titulo}\n\n`;
  md += `## Tabela\n\n| ID | Descricao | Origem no Fluxo | Prioridade | Status | Casos de Uso | Verificacao |\n|----|-----------|----------------|-----------|--------|--------------|-------------|\n`;
  if (rfs.length) {
    rfs.forEach(rf => {
      const desc   = (rf.descricao || "").slice(0, 80);
      const ucList = (rf.ucRefs || [rf.ftId]).filter(Boolean).join(", ") || rf.ftId || "—";
      md += `| ${rf.id} | ${desc} | ${rf.origemPasso || "—"} | ${rf.prioridade || "Alta"} | Proposto | ${ucList} | ${rf.verificacao || "A definir"} |\n`;
    });
  } else {
    md += `| RF-MOD-001 | O sistema deve... | FP-1 | Alta | Proposto | — | A definir |\n`;
  }
  md += `\n---\n\n## Detalhamento\n\n`;
  if (rfs.length) {
    rfs.forEach(rf => {
      const uc = ucsEp.find(u => u.ftId === (rf.ucRefs?.[0] || rf.ftId) || u.ucId === rf.ucId);
      md += `### ${rf.id}\n\n`;
      md += `**Descricao:** ${rf.descricao}\n\n`;
      md += `**Origem no Fluxo:** ${rf.origemPasso || "—"}\n\n`;
      const ucRefLinks = (rf.ucRefs || (uc ? [uc.ftId] : [])).map(ftId => {
        const u = ucsEp.find(x => x.ftId === ftId);
        return u ? `[${ftId} — ${u.titulo}](Casos-de-Uso/${ftId}-${toSlug(u.titulo)})` : ftId;
      }).join(", ");
      md += `**Casos de Uso:** ${ucRefLinks || "—"}\n\n`;
      md += `**Prioridade:** ${rf.prioridade || "Alta"}\n\n**Status:** Proposto\n\n`;
      md += `**Criterio de Verificacao:** ${rf.verificacao || "A definir"}\n\n`;
    });
  } else {
    md += `### RF-MOD-001\n\n**Descricao:** O sistema deve...\n\n**Origem no Fluxo:** —\n\n**Caso de Uso:** —\n\n**Prioridade:** Alta\n\n**Status:** Proposto\n\n**Criterio de Verificacao:** A definir\n\n`;
  }
  return md + wikiHistorico();
}

// ── Requisitos Não Funcionais ────────────────────────────────────
function wikiRNFFile(ep, ucsEp, modulo) {
  const titulo = ep.titulo;
  // Usa os RNF gerados pelo enrichRFRNF em uc.requisitosNaoFuncionais
  const rnfs = ucsEp.flatMap(uc =>
    (uc.requisitosNaoFuncionais || []).map(rnf => ({ ...rnf, ucId: uc.ucId, ftId: uc.ftId, ucTitulo: uc.titulo }))
  );
  let md = wikiYaml(`Requisitos Nao Funcionais - ${titulo}`, modulo, "requisitos-nao-funcionais");
  md += `# Requisitos Nao Funcionais - ${titulo}\n\n`;
  md += `## Tabela\n\n| ID | Categoria | Descricao | Metrica | Prioridade | Caso de Uso |\n|----|-----------|-----------|---------|------------|-------------|\n`;
  if (rnfs.length) {
    rnfs.forEach(rnf => {
      const desc = (rnf.descricao || "").slice(0, 70);
      md += `| ${rnf.id} | ${rnf.categoria || "—"} | ${desc} | ${rnf.metrica || "A definir"} | ${rnf.prioridade || "Alta"} | ${rnf.ftId} |\n`;
    });
  } else {
    md += `| RNF-MOD-001 | Performance Efficiency | O sistema deve responder em ate 500ms | <= 500ms P95 | Alta | — |\n`;
    md += `| RNF-MOD-002 | Reliability | O sistema deve garantir uptime do modulo | >= 99,5% ao mes | Alta | — |\n`;
    md += `| RNF-MOD-003 | Security | O sistema deve criptografar dados sensiveis | AES-256 | Alta | — |\n`;
  }
  md += `\n---\n\n## Detalhamento por Categoria\n\n`;
  if (rnfs.length) {
    const byCategoria = {};
    rnfs.forEach(rnf => { const cat = rnf.categoria || "Geral"; if (!byCategoria[cat]) byCategoria[cat] = []; byCategoria[cat].push(rnf); });
    Object.entries(byCategoria).forEach(([cat, items]) => {
      md += `### ${cat}\n\n`;
      items.forEach(rnf => {
        const uc = ucsEp.find(u => u.ucId === rnf.ucId);
        const ucSlug = uc ? `${uc.ftId}-${toSlug(uc.titulo)}` : null;
        md += `**${rnf.id}** — ${rnf.descricao}\n`;
        md += `- **Metrica:** ${rnf.metrica || "A definir"}\n`;
        md += `- **Prioridade:** ${rnf.prioridade || "Alta"}\n`;
        md += ucSlug ? `- **Caso de Uso:** [${uc.ftId} — ${uc.titulo}](Casos-de-Uso/${ucSlug})\n` : `- **Caso de Uso:** —\n`;
        md += `\n`;
      });
    });
  } else {
    md += `### Performance Efficiency\n> A definir — tempo de resposta e throughput esperados.\n\n### Security\n> A definir — controles de acesso e criptografia.\n\n### Reliability\n> A definir — capacidade maxima e comportamento sob carga.\n\n### Usability\n> A definir — SLA, janelas de manutencao, RTO/RPO.\n\n### Compatibility\n> A definir — padroes de acessibilidade e UX.\n\n`;
  }
  return md + wikiHistorico();
}

// ════════════════════════════════════════════════════════════════════
// WIKI — COR (módulo transversal)
// Segue exatamente Squad-Cloud-Wiki/documentacao/COR/
// ════════════════════════════════════════════════════════════════════

function wikiCORIndex() {
  let md = wikiYaml("COR - Documentacao Transversal", "COR", "indice-modulo");
  md += `# COR - Documentacao Transversal\n\n`;
  md += `> Centraliza todos os artefatos comuns a todo o sistema.\n\n`;
  md += `## Indice\n\n`;
  md += `- [Casos de Uso](Casos-de-Uso/Casos-de-Uso)\n`;
  md += `- [Regras de Negocio](Regras-de-Negocio-Globais)\n`;
  md += `- [Mensagens de Sistema](Mensagens-de-Sistema-Globais)\n`;
  md += `- [Requisitos Funcionais](Requisitos-Funcionais-Globais)\n`;
  md += `- [Requisitos Nao Funcionais](Requisitos-Nao-Funcionais)\n`;
  md += `- [Arquitetura Geral](Arquitetura-Geral)\n`;
  md += `- [Glossario](Glossario)\n`;
  md += `- [Padroes e Convencoes](Padroes-e-Convencoes)\n`;
  return md + wikiHistorico();
}

function wikiCORUCIndex(corUCs) {
  let md = wikiYaml("Casos de Uso - COR", "COR", "indice-casos-de-uso");
  md += `# Casos de Uso - COR\n\n`;
  if (corUCs.length) {
    md += `| ID | Nome | Status |\n|----|------|--------|\n`;
    corUCs.forEach(uc => {
      const slug = `${uc.ftId}-${toSlug(uc.titulo)}`;
      md += `| ${uc.ftId} | [${uc.titulo}](${slug}) | Proposto |\n`;
    });
  } else {
    md += `| ID | Nome | Status |\n|----|------|--------|\n`;
    md += `| FT001 | Nome da Feature | Proposto |\n`;
  }
  return md + wikiHistorico();
}

function wikiCORRNGlobal(allHus, allUCs) {
  const seen = new Set();
  const rns = [];
  allHus.forEach(h => (h.regrasNegocio || []).forEach(r => {
    if (!seen.has(r.id)) { seen.add(r.id); rns.push({ ...r, reqId: h.reqId, ucId: h.ucId, ucTitulo: h.ucTitulo || "" }); }
  }));
  let md = wikiYaml("Regras de Negocio - COR", "COR", "regras-de-negocio");
  md += `# Regras de Negocio - COR\n\n`;
  md += `## Tabela de Regras\n\n| ID | Nome | Descricao | Origem no Fluxo | Prioridade | Status |\n|----|------|-----------|----------------|-----------|--------|\n`;
  if (rns.length) {
    rns.forEach(r => {
      const nome = r.nome || inferRNNome(r.descricao);
      md += `| ${r.id} | ${nome} | ${r.descricao} | ${r.origemPasso || "—"} | Alta | Em elaboracao |\n`;
    });
  } else {
    md += `| RN001 | Nome da Regra | Descricao objetiva | — | Alta | Em elaboracao |\n`;
  }
  md += `\n---\n\n## Detalhamento\n\n`;
  if (rns.length) {
    rns.forEach(r => {
      const nome = r.nome || inferRNNome(r.descricao);
      const origemNorm3 = normalizePasso(r.origemPasso);
      let origemLink = "Lei / Requisito / Decisao interna";
      if (origemNorm3) {
        const uc = allUCs.find(u => u.ftId === r.ucId || u.ucId === r.ucId);
        if (uc) {
          const ucSlug = `${uc.ftId}-${toSlug(uc.titulo)}`;
          origemLink = `[${origemNorm3} — ${uc.ftId}](Casos-de-Uso/${ucSlug}#${origemNorm3.toLowerCase().replace(/[^a-z0-9-]/g, "-")})`;
        } else {
          origemLink = origemNorm3;
        }
      }
      md += `### ${r.id} - ${nome}\n\n`;
      md += `**Descricao:** ${r.descricao}\n\n**Justificativa:** ...\n\n`;
      md += `**Origem no Fluxo:** ${origemLink}\n\n`;
      md += `**Impacto nos modulos:** ...\n\n**Excecoes:** ...\n\n`;
    });
  } else {
    md += `### RN001 - Nome da Regra\n\n**Descricao:** ...\n\n**Justificativa:** ...\n\n**Origem no Fluxo:** —\n\n**Impacto nos modulos:** ...\n\n**Excecoes:** ...\n\n`;
  }
  return md + wikiHistorico();
}

function wikiCORMSGGlobal(allUCs) {
  let msgs = extractMsgsFromUCs(allUCs);
  if (!msgs.length) {
    msgs = [
      { id: "MSG001", tipo: "Sucesso",    contexto: "—", mensagem: "Operacao realizada com sucesso.", acao: "Fechar modal" },
      { id: "MSG002", tipo: "Alerta",     contexto: "—", mensagem: "Atencao: verifique os dados informados.", acao: "Manter tela" },
      { id: "MSG003", tipo: "Erro",       contexto: "—", mensagem: "Erro ao processar a solicitacao. Tente novamente.", acao: "Permitir retry" },
      { id: "MSG004", tipo: "Informacao", contexto: "—", mensagem: "Nenhum registro encontrado.", acao: "Exibir tela vazia" },
    ];
  }
  let md = wikiYaml("Mensagens de Sistema - COR", "COR", "mensagens-de-sistema");
  md += `# Mensagens de Sistema - COR\n\n`;
  md += `## Tabela de Mensagens\n\n| ID | Tipo | Ponto de Origem | Mensagem | Acao Esperada |\n|----|------|-----------------|----------|---------------|\n`;
  msgs.forEach(m => { md += `| ${m.id} | ${m.tipo} | ${m.contexto} | ${m.mensagem} | ${m.acao} |\n`; });
  md += `\n## Legenda\n\n| Tipo | Uso |\n|------|-----|\n`;
  md += `| Sucesso | Operacao concluida com exito |\n| Alerta | Situacao que requer atencao |\n`;
  md += `| Erro | Falha - requer acao |\n| Informacao | Mensagem neutra |\n| Seguranca | Acesso negado / sessao expirada |\n`;
  return md + wikiHistorico();
}

function wikiCORRFGlobal(allUCs, allHus) {
  // Usa os RF gerados pelo enrichRFRNF em uc.requisitosFuncionais
  const rfs = allUCs.flatMap(uc =>
    (uc.requisitosFuncionais || []).map(rf => ({ ...rf, ucId: uc.ucId, ftId: uc.ftId, ucTitulo: uc.titulo }))
  );
  let md = wikiYaml("Requisitos Funcionais - COR", "COR", "requisitos-funcionais");
  md += `# Requisitos Funcionais - COR\n\n`;
  md += `## Tabela\n\n| ID | Descricao | Origem no Fluxo | Prioridade | Status | Caso de Uso | Verificacao |\n|----|-----------|----------------|-----------|--------|-------------|-------------|\n`;
  if (rfs.length) {
    rfs.forEach(rf => {
      const desc = (rf.descricao || "").slice(0, 80);
      md += `| ${rf.id} | ${desc} | ${rf.origemPasso || "—"} | ${rf.prioridade || "Alta"} | Proposto | ${rf.ftId} | ${rf.verificacao || "A definir"} |\n`;
    });
  } else {
    md += `| RF-COR-001 | O sistema deve... | FP-1 | Alta | Proposto | — | A definir |\n`;
  }
  md += `\n---\n\n## Detalhamento\n\n`;
  if (rfs.length) {
    rfs.forEach(rf => {
      const uc = allUCs.find(u => u.ucId === rf.ucId);
      const ucSlug = uc ? `${uc.ftId}-${toSlug(uc.titulo)}` : null;
      md += `### ${rf.id}\n\n`;
      md += `**Descricao:** ${rf.descricao}\n\n`;
      md += `**Origem no Fluxo:** ${rf.origemPasso || "—"}\n\n`;
      md += ucSlug ? `**Caso de Uso:** [${uc.ftId} — ${uc.titulo}](Casos-de-Uso/${ucSlug})\n\n` : `**Caso de Uso:** —\n\n`;
      md += `**Prioridade:** ${rf.prioridade || "Alta"}\n\n**Status:** Proposto\n\n`;
      md += `**Criterio de Verificacao:** ${rf.verificacao || "A definir"}\n\n`;
    });
  } else {
    md += `### RF-COR-001\n\n**Descricao:** O sistema deve...\n\n**Origem no Fluxo:** —\n\n**Caso de Uso:** —\n\n**Prioridade:** Alta\n\n**Status:** Proposto\n\n**Criterio de Verificacao:** A definir\n\n`;
  }
  return md + wikiHistorico();
}

function wikiCORRNF(allUCs) {
  // Usa os RNF gerados pelo enrichRFRNF em uc.requisitosNaoFuncionais
  const rnfs = (allUCs || []).flatMap(uc =>
    (uc.requisitosNaoFuncionais || []).map(rnf => ({ ...rnf, ucId: uc.ucId, ftId: uc.ftId, ucTitulo: uc.titulo }))
  );
  let md = wikiYaml("Requisitos Nao Funcionais - COR", "COR", "requisitos-nao-funcionais");
  md += `# Requisitos Nao Funcionais - COR\n\n`;
  md += `## Tabela\n\n| ID | Categoria | Descricao | Metrica | Prioridade | Caso de Uso |\n|----|-----------|-----------|---------|------------|-------------|\n`;
  if (rnfs.length) {
    rnfs.forEach(rnf => {
      const desc = (rnf.descricao || "").slice(0, 70);
      md += `| ${rnf.id} | ${rnf.categoria || "—"} | ${desc} | ${rnf.metrica || "A definir"} | ${rnf.prioridade || "Alta"} | ${rnf.ftId} |\n`;
    });
  } else {
    md += `| RNF-COR-001 | Performance Efficiency | O sistema deve responder em ate 500ms | <= 500ms P95 | Alta | — |\n`;
    md += `| RNF-COR-002 | Reliability | O sistema deve garantir uptime global | >= 99,5% ao mes | Alta | — |\n`;
    md += `| RNF-COR-003 | Security | O sistema deve criptografar dados sensiveis | AES-256 | Alta | — |\n`;
  }
  md += `\n---\n\n## Detalhamento por Categoria\n\n`;
  if (rnfs.length) {
    const byCategoria = {};
    rnfs.forEach(rnf => { const cat = rnf.categoria || "Geral"; if (!byCategoria[cat]) byCategoria[cat] = []; byCategoria[cat].push(rnf); });
    Object.entries(byCategoria).forEach(([cat, items]) => {
      md += `### ${cat}\n\n`;
      items.forEach(rnf => {
        const uc = (allUCs || []).find(u => u.ucId === rnf.ucId);
        const ucSlug = uc ? `${uc.ftId}-${toSlug(uc.titulo)}` : null;
        md += `**${rnf.id}** — ${rnf.descricao}\n`;
        md += `- **Metrica:** ${rnf.metrica || "A definir"}\n`;
        md += `- **Prioridade:** ${rnf.prioridade || "Alta"}\n`;
        md += ucSlug ? `- **Caso de Uso:** [${uc.ftId} — ${uc.titulo}](Casos-de-Uso/${ucSlug})\n` : `- **Caso de Uso:** —\n`;
        md += `\n`;
      });
    });
  } else {
    md += `### Performance Efficiency\n> A definir — tempo de resposta e throughput esperados.\n\n### Security\n> A definir — controles de acesso e criptografia.\n\n### Reliability\n> A definir — capacidade maxima e comportamento sob carga.\n\n### Usability\n> A definir — SLA, janelas de manutencao, RTO/RPO.\n\n### Compatibility\n> A definir — padroes de acessibilidade e UX.\n\n`;
  }
  return md + wikiHistorico();
}

function wikiArquiteturaGeral(epicos) {
  let md = wikiYaml("Arquitetura Geral", "COR", "arquitetura-geral");
  md += `# Arquitetura Geral do Sistema\n\n`;
  md += `> _Inserir diagrama C4 / arquitetural aqui._\n\n`;
  md += `## Modulos\n\n| Modulo | Responsabilidade |\n|--------|------------------|\n`;
  md += `| COR | Documentacao transversal |\n`;
  epicos.filter(e => e.id !== "COR").forEach(e => {
    md += `| ${e.titulo} | ${e.objetivo || "—"} |\n`;
  });
  md += `\n## Integracoes Externas\n\n| Sistema | Protocolo | Finalidade |\n|---------|-----------|----------|\n| — | — | — |\n`;
  return md + wikiHistorico();
}

function wikiGlossario(epicos) {
  let md = wikiYaml("Glossario", "COR", "glossario");
  md += `# Glossario\n\n| Termo | Definicao | Modulo |\n|-------|-----------|--------|\n`;
  epicos.filter(e => e.id !== "COR").forEach(e => {
    md += `| ${e.titulo} | ${e.objetivo || "—"} | ${e.titulo} |\n`;
  });
  if (!epicos.filter(e => e.id !== "COR").length) md += `| — | — | — |\n`;
  return md + wikiHistorico();
}

function wikiPadroesConvencoes() {
  let md = wikiYaml("Padroes e Convencoes", "COR", "padroes-e-convencoes");
  md += `# Padroes e Convencoes de Documentacao\n\n`;
  md += `## Nomenclatura de IDs\n\n| Artefato | Prefixo | Exemplo |\n|----------|---------|--------|\n`;
  md += `| Feature (Caso de Uso) | FT | FT001 |\n| Regra de Negocio | RN | RN-PREF-001 |\n`;
  md += `| Requisito Funcional | RF | RF001 |\n| Requisito Nao Funcional | RNF | RNF001 |\n`;
  md += `| Mensagem de Sistema | MSG | MSG001 |\n\n`;
  md += `## Status Padrao\n\n| Valor (YAML) | Significado |\n|--------------|-------------|\n`;
  md += `| em-elaboracao | Documento em criacao |\n| em-revisao | Aguardando aprovacao |\n`;
  md += `| aprovado | Documento vigente |\n| obsoleto | Substituido ou cancelado |\n\n`;
  md += `## Campos do Cabecalho YAML\n\n| Campo | Preenchimento | Responsavel |\n|-------|--------------|-------------|\n`;
  md += `| title | Manual | Autor |\n| modulo | Manual | Autor |\n| tipo | Manual | Autor |\n`;
  md += `| doc_version | Automatico | Pipeline |\n| status | Manual | Autor |\n`;
  md += `| criado_em | Automatico | Pipeline (1o commit) |\n| last_modified | Automatico | Pipeline |\n`;
  md += `| last_author | Automatico | Pipeline |\n| last_commit | Automatico | Pipeline |\n`;
  return md + wikiHistorico();
}

// ── Orquestrador: gera todos os arquivos por épico ───────────────
function generateWikiFiles(epicos, ucs, hus, wikiRoot, produtoTitulo, isCOR) {
  const files = [];
  const corEp  = epicos.find(e => e.id === "COR");
  const modEps = epicos.filter(e => e.id !== "COR");
  const corUCs = corEp ? ucs.filter(u => u.epicId === "COR") : [];
  const corHUs = corEp ? hus.filter(h => h.epicId === "COR") : [];

  // COR sempre na raiz do wikiRoot — nunca dentro de produto
  const corBase = `/${wikiRoot}/COR`;

  // Raiz onde os módulos de negócio ficam:
  //  • isCOR=true  → /{wikiRoot}/COR   (módulos ficam DENTRO da pasta COR)
  //  • produto     → /{wikiRoot}/{prodSlug}
  //  • sem produto → /{wikiRoot}
  const prodSlug = !isCOR && produtoTitulo ? toSlug(produtoTitulo) : "";
  const modRoot  = isCOR ? corBase : (prodSlug ? `/${wikiRoot}/${prodSlug}` : `/${wikiRoot}`);

  // ── .order do wikiRoot ─────────────────────────────────────────
  // Lista COR primeiro, depois produtos ou módulos diretos
  if (isCOR) {
    // Sessão COR: apenas COR aparece na raiz
    files.push({ path: `/${wikiRoot}/.order`, content: "COR" });
  } else if (prodSlug) {
    // Produto: COR + slug do produto
    files.push({ path: `/${wikiRoot}/.order`, content: ["COR", prodSlug].join("\n") });
    // .order dentro da pasta do produto — lista os módulos
    files.push({ path: `/${wikiRoot}/${prodSlug}/.order`, content: modEps.map(e => toSlug(e.titulo)).join("\n") });
  } else {
    // Sem produto: COR + módulos direto na raiz
    files.push({ path: `/${wikiRoot}/.order`, content: ["COR", ...modEps.map(e => toSlug(e.titulo))].join("\n") });
  }

  // ── COR — módulo transversal, sempre na raiz ───────────────────
  // .order interno do COR: itens fixos + módulos de negócio (quando isCOR=true)
  const corFixedOrder = ["COR", "Casos-de-Uso", "Regras-de-Negocio-Globais", "Mensagens-de-Sistema-Globais", "Requisitos-Funcionais-Globais", "Requisitos-Nao-Funcionais", "Arquitetura-Geral", "Glossario", "Padroes-e-Convencoes"];
  const corInternalOrder = isCOR
    ? [...corFixedOrder, ...modEps.map(e => toSlug(e.titulo))]
    : corFixedOrder;

  // Quando isCOR=true: tudo é COR, globais agregam todos os módulos
  // Quando isCOR=false: globais contêm APENAS itens do épico COR, não os de produto
  const globalHUs = isCOR ? hus : corHUs;
  const globalUCs = isCOR ? ucs : corUCs;

  files.push({ path: `${corBase}/COR.md`,                          content: wikiCORIndex() });
  files.push({ path: `${corBase}/Casos-de-Uso/Casos-de-Uso.md`,    content: wikiCORUCIndex(corUCs) });
  files.push({ path: `${corBase}/Regras-de-Negocio-Globais.md`,    content: wikiCORRNGlobal(globalHUs, globalUCs) });
  files.push({ path: `${corBase}/Mensagens-de-Sistema-Globais.md`, content: wikiCORMSGGlobal(globalUCs) });
  files.push({ path: `${corBase}/Requisitos-Funcionais-Globais.md`, content: wikiCORRFGlobal(globalUCs, globalHUs) });
  files.push({ path: `${corBase}/Requisitos-Nao-Funcionais.md`,    content: wikiCORRNF(globalUCs) });
  files.push({ path: `${corBase}/Arquitetura-Geral.md`,            content: wikiArquiteturaGeral(epicos) });
  files.push({ path: `${corBase}/Glossario.md`,                    content: wikiGlossario(epicos) });
  files.push({ path: `${corBase}/Padroes-e-Convencoes.md`,         content: wikiPadroesConvencoes() });
  files.push({ path: `${corBase}/.order`,                          content: corInternalOrder.join("\n") });

  // COR UCs individuais
  const corUCOrder = ["Casos-de-Uso"];
  for (const uc of corUCs) {
    const slug = `${uc.ftId}-${toSlug(uc.titulo)}`;
    corUCOrder.push(slug);
    files.push({ path: `${corBase}/Casos-de-Uso/${slug}.md`, content: wikiUCFile(uc, hus.filter(h => h.ucId === uc.ucId), corEp || { id: "COR", titulo: "COR - Funcionalidades Transversais" }, "COR") });
  }
  files.push({ path: `${corBase}/Casos-de-Uso/.order`, content: corUCOrder.join("\n") });

  // ── Épicos de negócio ──────────────────────────────────────────
  // Quando isCOR=true: ficam dentro de /COR/{modulo}
  // Quando produto: ficam em /{wikiRoot}/{prodSlug}/{modulo}
  // Sem produto:    ficam em /{wikiRoot}/{modulo}
  for (const ep of modEps) {
    const modulo = toSlug(ep.titulo);
    const ucsEp  = ucs.filter(u => u.epicId === ep.id);
    const husEp  = hus.filter(h => h.epicId === ep.id);
    const base   = `${modRoot}/${modulo}`;

    files.push({ path: `${base}/${modulo}.md`,                  content: wikiModuleIndex(ep, ucsEp, modulo) });
    files.push({ path: `${base}/Casos-de-Uso/Casos-de-Uso.md`,  content: wikiUCIndex(ep, ucsEp, modulo) });
    files.push({ path: `${base}/Regras-de-Negocio.md`,           content: wikiRNFile(ep, ucsEp, husEp, modulo) });
    files.push({ path: `${base}/Mensagens-de-Sistema.md`,        content: wikiMsgFile(ep, ucsEp, modulo) });
    files.push({ path: `${base}/Requisitos-Funcionais.md`,       content: wikiRFFile(ep, ucsEp, husEp, modulo) });
    files.push({ path: `${base}/Requisitos-Nao-Funcionais.md`,   content: wikiRNFFile(ep, ucsEp, modulo) });
    files.push({ path: `${base}/.order`, content: [modulo, "Casos-de-Uso", "Regras-de-Negocio", "Mensagens-de-Sistema", "Requisitos-Funcionais", "Requisitos-Nao-Funcionais"].join("\n") });

    const ucOrder = ["Casos-de-Uso"];
    for (const uc of ucsEp) {
      const slug = `${uc.ftId}-${toSlug(uc.titulo)}`;
      ucOrder.push(slug);
      files.push({ path: `${base}/Casos-de-Uso/${slug}.md`, content: wikiUCFile(uc, hus.filter(h => h.ucId === uc.ucId), ep, modulo) });
    }
    files.push({ path: `${base}/Casos-de-Uso/.order`, content: ucOrder.join("\n") });
  }

  return files;
}

// Infere nome semântico de uma RN a partir da descrição
function inferRNNome(descricao) {
  if (!descricao) return "Regra de Negocio";
  const stop = new Set(["o","a","os","as","um","uma","uns","umas","de","do","da","dos","das","no","na","nos","nas","ao","à","pelo","pela","pelos","pelas","em","com","por","para","se","que","é","não","deve","deverá","precisa","toda","todo","todos","todas","quando","caso","ao","ser","ter","foi","são","há","após","antes","entre","desde","até","apenas","somente","cada","qualquer","todo","sem","ou","e","mas","pois","então","já","sempre","nunca","ainda","também","só","mais","menos"]);
  // extrair segmentos relevantes: substantivos após verbos modais ou sujeito implícito
  const s = descricao
    .replace(/[.,;:!?()]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w.toLowerCase()));
  // Prioriza palavras que indicam entidade de negócio (maiúsculas ou substantivos fortes)
  const priority = s.filter(w => /^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕ]/.test(w));
  const pool = priority.length >= 2 ? priority : s;
  const words = pool.slice(0, 4);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "Regra de Negocio";
}

// Mescla versão e histórico do arquivo existente no novo conteúdo gerado
// oldContent = conteúdo atual do repo; newContent = conteúdo recém gerado pelo agente
function mergeDocVersion(newContent, oldContent) {
  const today = new Date().toISOString().split("T")[0];

  // Extrai versão atual do arquivo existente
  const vMatch = oldContent.match(/doc_version:\s*"(\d+)\.(\d+)\.(\d+)"/);
  const [, ma = "1", mi = "0", pa = "0"] = vMatch || [];
  const oldVersion = `${ma}.${mi}.${pa}`;
  const newVersion = `${ma}.${mi}.${parseInt(pa, 10) + 1}`;

  // Extrai linhas de histórico já existentes (sem placeholder)
  const histMatch = oldContent.match(/<!-- HISTORICO:START -->\n\| Versao[^\n]*\n\|[-| ]+\n([\s\S]*?)<!-- HISTORICO:END -->/);
  const oldRows = (histMatch?.[1] || "").replace(/\| - \| - \| - \| - \| _Aguardando primeiro commit_ \|\n?/g, "");

  // Nova linha para a versão que está sendo substituída
  const newRow = `| ${oldVersion} | ${today} | Agente de Requisitos | - | Versao anterior — substituida por ${newVersion} |\n`;

  // Aplica nova versão e last_modified no conteúdo gerado
  let updated = newContent
    .replace(/doc_version:\s*"[^"]*"/, `doc_version: "${newVersion}"`)
    .replace(/last_modified:\s*"[^"]*"/, `last_modified: "${today}"`);

  // Injeta histórico acumulado dentro das tags
  updated = updated.replace(
    /(<!-- HISTORICO:START -->\n\| Versao[^\n]*\n\|[-| ]+\n)([\s\S]*?)(<!-- HISTORICO:END -->)/,
    (_, header, _placeholder, end) => `${header}${newRow}${oldRows}${end}`
  );

  return updated;
}

async function pushToWiki(org, project, pat, repoName, branch, files, commitMsg) {
  const token   = btoa(`:${pat}`);
  const headers = { "Content-Type": "application/json", Authorization: `Basic ${token}` };
  const base    = `/devops/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories`;

  // 1. Obter repo pelo nome — criar automaticamente se não existir
  let repoRes = await fetch(`${base}/${encodeURIComponent(repoName)}?api-version=7.1`, { headers });
  let created = false;
  // Fallback: GET por nome falha com espaços em algumas versões do Azure DevOps.
  // Se 404 ou qualquer falha, tenta listar todos e achar pelo nome exato.
  if (!repoRes.ok) {
    const listAll = await fetch(`${base}?api-version=7.1`, { headers });
    if (listAll.ok) {
      const allRepos = await listAll.json();
      const found = (allRepos.value || []).find(r => r.name === repoName);
      if (found) {
        repoRes = { ok: true, json: () => Promise.resolve(found) };
      }
    }
  }

  if (!repoRes.ok) {
    if (repoRes.status === 404) {
      // Repositório não existe — criar
      const createRes = await fetch(`${base}?api-version=7.1`, {
        method: "POST", headers,
        body: JSON.stringify({ name: repoName }),
      });
      if (createRes.status === 409) {
        // 409 = já existe mas o GET por nome não achou (encoding/timing) — lista novamente
        const retryList = await fetch(`${base}?api-version=7.1`, { headers });
        if (!retryList.ok) throw new Error(`Repositório "${repoName}" já existe mas não foi possível recuperá-lo.`);
        const allRepos = await retryList.json();
        const found = (allRepos.value || []).find(r => r.name === repoName);
        if (!found) throw new Error(`Repositório "${repoName}" já existe mas não foi encontrado na listagem.`);
        repoRes = { ok: true, json: () => Promise.resolve(found) };
      } else if (!createRes.ok) {
        const t = await createRes.text().catch(() => "");
        throw new Error(`Não foi possível criar o repositório "${repoName}" (HTTP ${createRes.status}): ${t.slice(0, 180)}`);
      } else {
        repoRes = createRes;
        created = true;
      }
    } else {
      throw new Error(`Erro ao acessar repositório "${repoName}" (HTTP ${repoRes.status}).`);
    }
  }
  const repo = await repoRes.json();

  // 2. HEAD da branch (ou zero para repositório vazio)
  const refsRes = await fetch(`${base}/${repo.id}/refs?filter=heads/${encodeURIComponent(branch)}&api-version=7.1`, { headers });
  const refs    = refsRes.ok ? await refsRes.json() : { value: [] };
  const oldObjectId = refs.value?.[0]?.objectId || "0000000000000000000000000000000000000000";

  // 3. Listar todos os arquivos existentes no repo (uma única chamada)
  const rootPath = files[0]?.path?.split("/").slice(0, 2).join("/") || "/";
  const listRes = await fetch(
    `${base}/${repo.id}/items?scopePath=${encodeURIComponent(rootPath)}&recursionLevel=Full&api-version=7.1`,
    { headers }
  );
  const existingPaths = new Set();
  if (listRes.ok) {
    const listed = await listRes.json();
    (listed.value || []).forEach(item => existingPaths.add(item.path));
  }

  // 4. Buscar conteúdo atual dos .md existentes (para merge de versão + histórico)
  const existingMdPaths = files.filter(f => f.path.endsWith(".md") && existingPaths.has(f.path)).map(f => f.path);
  const oldContents = {};
  await Promise.all(existingMdPaths.map(async path => {
    try {
      const r = await fetch(
        `${base}/${repo.id}/items?path=${encodeURIComponent(path)}&download=true&api-version=7.1`,
        { headers: { Authorization: `Basic ${token}` } }
      );
      if (r.ok) oldContents[path] = await r.text();
    } catch { /* fallback: sem merge, só bump simples */ }
  }));

  // 5. Montar changes: "add" para novos, "edit" para existentes (nunca "delete")
  let newCount = 0, updatedCount = 0;
  const changes = files.map(f => {
    const exists = existingPaths.has(f.path);
    let content = f.content;
    if (exists) {
      updatedCount++;
      if (f.path.endsWith(".md")) {
        // Se temos o conteúdo antigo, faz merge completo de versão + histórico
        content = oldContents[f.path]
          ? mergeDocVersion(f.content, oldContents[f.path])
          : f.content.replace(/doc_version:\s*"(\d+)\.(\d+)\.(\d+)"/, (_, ma, mi, pa) => `doc_version: "${ma}.${mi}.${parseInt(pa)+1}"`);
      }
      return { changeType: "edit", item: { path: f.path }, newContent: { content: utf8ToB64(content), contentType: "base64encoded" } };
    } else {
      newCount++;
      return { changeType: "add",  item: { path: f.path }, newContent: { content: utf8ToB64(content), contentType: "base64encoded" } };
    }
  });

  // 5. Push único com todos os changes
  const r = await fetch(`${base}/${repo.id}/pushes?api-version=7.1`, {
    method: "POST", headers,
    body: JSON.stringify({ refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId }], commits: [{ comment: commitMsg, changes }] }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Push falhou (HTTP ${r.status}): ${t.slice(0, 220)}`);
  }
  const result = await r.json();
  return { ...result, _stats: { newCount, updatedCount, repoCreated: created } };
}

// ════════════════════════════════════════════════════════════════════
// UI CONSTANTS
// ════════════════════════════════════════════════════════════════════

const PHASES = [
  { key: "upload",     label: "Upload",     icon: "⬆" },
  { key: "chunking",   label: "Extração",   icon: "✂" },
  { key: "epicos",     label: "Épicos",     icon: "◈" },
  { key: "features",   label: "Features",   icon: "◻" },
  { key: "requisitos", label: "Requisitos", icon: "◈" },
  { key: "testes",     label: "Testes",     icon: "◎" },
  { key: "review",     label: "Revisar",    icon: "⊞" },
  { key: "devops",     label: "DevOps",     icon: "▶" },
];

const C = {
  bg: "#F9F9F9",        surface: "#FFFFFF",    border: "#E8ECF5",
  accent: "#39ADE3",    navy: "#00366C",       navyMed: "#07447A",
  cyanLight: "#87D5F6", sectionBg: "#E9F5FA",
  green: "#166534",     amber: "#92400e",      coral: "#9a3412",
  red: "#991b1b",       muted: "#94a3b8",
  text: "#627C89",      textDim: "#74768B",    textBright: "#444762",
  purple: "#00366C",    // mapeado para Navy yTecnologia
};

const TYPE_COLOR = {
  "Épico": "#00366C", "Feature/UC": "#07447A",
  "Requisito/HU": "#39ADE3", "Caso de Teste": "#0284c7",
};

// ════════════════════════════════════════════════════════════════════
// COMPONENT
// ════════════════════════════════════════════════════════════════════

export default function AgenteRequisitos() {
  const [_s] = useState(loadSaved); // load once at mount
  const [phase, setPhase]         = useState(_s.phase ?? 0);
  const [maxPhase, setMaxPhase]   = useState(_s.maxPhase ?? 0);
  const [produtoTitulo, setProdutoTitulo] = useState(_s.produtoTitulo ?? "");
  const [isCOR, setIsCOR]               = useState(_s.isCOR ?? false);
  const [file, setFile]           = useState(null);
  const [chunks, setChunks]     = useState(_s.chunks ?? []);
  const [funcList, setFuncList] = useState(_s.funcList ?? []);
  const [epicos, setEpicos]     = useState(_s.epicos ?? []);
  const [ucs, setUcs]           = useState(_s.ucs ?? []);
  const [hus, setHus]           = useState(_s.hus ?? []);
  const [cts, setCts]           = useState(_s.cts ?? []);
  const [loading, setLoading]   = useState(false);
  const [loadMsg, setLoadMsg]   = useState("");
  const [progress, setProgress] = useState({ cur: 0, total: 0 });
  const [error, setError]       = useState("");
  const [expanded, setExpanded] = useState(null);
  const [selectedWI, setSelectedWI] = useState(() => (_s.hus ?? []).map((_, i) => i));
  const [savedFileName] = useState(_s.fileName ?? null);
  const [apiKey, setApiKeyState] = useState(() => {
    const saved = sessionStorage.getItem("anthropic_key") || "";
    _apiKey = saved;
    return saved;
  });
  const handleApiKey = k => { _apiKey = k; setApiKeyState(k); sessionStorage.setItem("anthropic_key", k); };

  // ── Avança para fase e atualiza maxPhase ──────────────────────────
  const goToPhase = (n) => {
    setPhase(n);
    setMaxPhase(prev => Math.max(prev, n));
  };

  // ── Persiste estado no localStorage ──────────────────────────────
  useEffect(() => {
    try {
      const data = {
        phase, maxPhase, funcList, epicos, ucs, hus, cts, chunks,
        produtoTitulo, isCOR,
        fileName: file?.name ?? savedFileName,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch { /* quota exceeded — silencioso */ }
  }, [phase, maxPhase, funcList, epicos, ucs, hus, cts, chunks]);
  const [azOrg, setAzOrg]         = useState("Rafaelcotrin");
  const [azProject, setAzProject] = useState("Projeto DDA");
  const [azAreaPath, setAzAreaPath] = useState("Projeto DDA");
  const [azPat, setAzPat]         = useState("");
  const [showPat, setShowPat]     = useState(false);
  const [configOpen, setConfigOpen] = useState(false); // começa fechado se org já preenchida
  const [devLog, setDevLog]       = useState([]);
  const [corrEpicos, setCorrEpicos]   = useState("");
  const [corrUCs, setCorrUCs]         = useState("");
  const [corrHUs, setCorrHUs]         = useState("");
  const [corrCTs, setCorrCTs]         = useState("");
  const [azWikiRepo,   setAzWikiRepo]   = useState("");
  const [azWikiBranch, setAzWikiBranch] = useState("main");
  const [azWikiRoot,   setAzWikiRoot]   = useState("documentacao");
  const [wikiLog,      setWikiLog]      = useState([]);
  // Migration mode — NOT persisted in localStorage
  const [migrationMode, setMigrationMode] = useState(false);
  const [migFiles, setMigFiles]           = useState([]);
  const dropRef    = useRef(null);
  const migDropRef = useRef(null);
  const [faqOpen, setFaqOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const setErr = (msg, err) => {
    const full = err ? `${msg}\n\n${err?.stack || err}` : msg;
    console.error("[DEBUG] error:", full);
    setError(full); setLoading(false); setLoadMsg("");
  };
  const log = (msg, cur, total) => { setLoadMsg(msg); if (cur !== undefined) setProgress({ cur, total }); };

  // ── Upload ────────────────────────────────────────────────────────
  async function handleFile(f) {
    setError(""); setFile(f); setLoading(true); log("📂 Lendo arquivo...");
    try {
      const text = await extractText(f);
      if (!text?.trim()) throw new Error("Não foi possível extrair texto do arquivo.");
      log("🧹 Normalizando estrutura do documento...");
      const normalizedText = await fase0_normalizarTexto(text, f.name);
      setChunks(chunkText(normalizedText, 3500));
      goToPhase(1);
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); }
  }

  // ── Migração de documentos existentes ────────────────────────────
  async function handleMigracao() {
    if (!migFiles.length) return;
    setError(""); setLoading(true);
    const allEpicos = [], allUCs = [], allHUs = [];
    let ucIdx = 0, huIdx = 0;
    try {
      for (let i = 0; i < migFiles.length; i++) {
        log(`📦 Migrando ${migFiles[i].name} (${i + 1}/${migFiles.length})...`, i, migFiles.length);
        const text = await extractText(migFiles[i]);
        if (!text?.trim()) throw new Error(`"${migFiles[i].name}": não foi possível extrair texto.`);
        const result = await migrarDocumento(migFiles[i].name, text, allEpicos.length, ucIdx, huIdx, setLoadMsg);

        if (result.epico) {
          result.epico._migrated = true;
          allEpicos.push(result.epico);
        }
        const epicId = result.epico?.id || `EP${pad3(allEpicos.length)}`;
        const epicTitulo = result.epico?.titulo || migFiles[i].name;

        (result.ucs || []).forEach((uc, j) => {
          uc.ftId = `FT${pad3(ucIdx + j + 1)}`;
          uc.ucId = uc.ftId;
          uc.epicId = epicId;
          uc.epicTitulo = epicTitulo;
          uc._migrated = true;
        });
        allUCs.push(...(result.ucs || []));
        ucIdx += (result.ucs || []).length;

        // UCs deste documento (para vincular HUs sem ftId)
        const ucsThisEpic = allUCs.filter(u => u.epicId === epicId);
        (result.hus || []).forEach((hu, j) => {
          hu.reqId = `REQ${pad3(huIdx + j + 1)}`;
          hu.epicId = epicId;
          hu.epicTitulo = epicTitulo;
          // Tenta vincular a HU ao UC correto
          const rawUcRef = hu.ftId || hu.ucId || "";
          const matchedUC = ucsThisEpic.find(u =>
            u.ftId === rawUcRef ||
            u.ucId === rawUcRef ||
            // AI pode ter retornado ID no formato antigo (UC001 → FT001)
            (rawUcRef && u.ftId === rawUcRef.replace(/^UC/, "FT"))
          ) || ucsThisEpic[0]; // fallback: primeiro UC do épico
          hu.ftId = matchedUC?.ftId || "";
          hu.ucId = matchedUC?.ucId || "";
          hu._migrated = true;
          if (hu.workItem) hu.workItem.titulo = hu.titulo;
        });
        allHUs.push(...(result.hus || []));
        huIdx += (result.hus || []).length;
      }

      if (!allEpicos.length) throw new Error("Nenhum épico identificado nos documentos enviados.");

      setFuncList([]);
      setEpicos(allEpicos);
      setUcs(allUCs);

      if (allHUs.length) {
        log("🔎 Analisando nomes das Regras de Negócio...");
        const enriched = await enrichRNNames(allHUs);
        setHus(enriched);
        setSelectedWI(enriched.map((_, i) => i));
        log("📋 Extraindo RF e RNF...");
        setUcs(await enrichRFRNF(enriched, allUCs, allEpicos));
        setCts([]);
        goToPhase(4);
      } else if (allUCs.length) {
        setHus([]); setCts([]);
        goToPhase(3);
      } else {
        goToPhase(2);
      }
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Fase 1 → 2: extrair funcs + gerar Épicos ─────────────────────
  async function handleChunking() {
    setError(""); setLoading(true);
    const allFuncs = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        log(`✂ Analisando chunk ${i + 1}/${chunks.length}...`, i, chunks.length);
        const funcs = await fase1_resumirChunk(chunks[i], i, chunks.length);
        funcs.forEach((f, j) => { f.id = `F${pad3(allFuncs.length + j + 1)}`; });
        allFuncs.push(...funcs);
      }
      if (!allFuncs.length) throw new Error("Nenhuma funcionalidade identificada.");
      setFuncList(allFuncs);
      log(`◈ Agrupando ${allFuncs.length} funcionalidades em Épicos...`);
      const eps = await fase1b_gerarEpicos(allFuncs);
      if (!eps.length) throw new Error("Não foi possível gerar Épicos.");
      setEpicos(eps);
      goToPhase(2);
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Fase 2 → 3: gerar N Features/UCs por Épico ───────────────────
  async function handleUCs() {
    setError(""); setLoading(true);
    const result = [];
    try {
      for (let i = 0; i < epicos.length; i++) {
        log(`◻ Gerando Features para ${epicos[i].id}...`, i, epicos.length);
        const ucsEp = await fase2_gerarUCsParaEpico(epicos[i], funcList, result.length);
        result.push(...ucsEp);
      }
      if (!result.length) throw new Error("Nenhuma Feature (UC) gerada.");
      setUcs(result);
      goToPhase(3);
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Fase 3 → 4: gerar N Requisitos/HUs por UC ────────────────────
  async function handleHUs() {
    setError(""); setLoading(true);
    const result = [];
    const ucsSemHU = [];
    try {
      for (let i = 0; i < ucs.length; i++) {
        const uc = ucs[i];
        log(`◈ Gerando Requisitos para ${uc.ftId}...`, i, ucs.length);
        const rnPfx = ucToRNPrefix(uc.titulo);
        let husUC = await fase3_gerarHUsParaUC(uc, result.length, "", rnPfx, isCOR);

        if (!husUC.length) {
          log(`↺ Retentando ${uc.ftId} (sem HUs na 1ª tentativa)...`, i, ucs.length);
          husUC = await fase3_gerarHUsParaUC(uc, result.length, "", rnPfx, isCOR);
        }

        if (!husUC.length) {
          // Fallback: cria 1 HU básica para não deixar o UC sem cobertura
          ucsSemHU.push(`${uc.ftId} — ${uc.titulo}`);
          husUC = [createFallbackHU(uc, result.length)];
        }

        result.push(...husUC);
      }
      if (!result.length) throw new Error("Nenhum Requisito (HU) gerado.");
      log("🔎 Analisando nomes das Regras de Negócio...");
      const enriched = await enrichRNNames(result);
      setHus(enriched);
      setSelectedWI(enriched.map((_, i) => i));
      log("📋 Extraindo RF e RNF...");
      setUcs(await enrichRFRNF(enriched, ucs, epicos));
      if (ucsSemHU.length) {
        setError(
          `⚠ Alerta: ${ucsSemHU.length} UC(s) não retornaram HUs válidas da IA — foi criada 1 HU básica para cada. Revise usando o painel de correção:\n• ${ucsSemHU.join("\n• ")}`
        );
      }
      goToPhase(4);
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Fase 4 → 5: gerar CTs por UC ─────────────────────────────────
  async function handleCTs() {
    setError(""); setLoading(true);
    const result = [];
    try {
      for (let i = 0; i < ucs.length; i++) {
        log(`◎ Gerando testes para ${ucs[i].ftId}...`, i, ucs.length);
        result.push(...await fase4_gerarCTs(ucs[i], hus.filter(h => h.ucId === ucs[i].ucId), "", (ucs[i].requisitosNaoFuncionais || [])));
      }
      setCts(result);
      goToPhase(5);
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Correção: Épicos ─────────────────────────────────────────────
  async function handleCorrectEpicos() {
    setError(""); setLoading(true);
    try {
      log("◈ Regerando Épicos com correções...");
      const eps = await fase1b_gerarEpicos(funcList, corrEpicos);
      if (!eps.length) throw new Error("Não foi possível gerar Épicos.");
      setEpicos(eps);
      setCorrEpicos("");
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); }
  }

  // ── Correção: UCs ────────────────────────────────────────────────
  async function handleCorrectUCs() {
    setError(""); setLoading(true);
    const result = [];
    try {
      for (let i = 0; i < epicos.length; i++) {
        log(`◻ Regerando Features para ${epicos[i].id}...`, i, epicos.length);
        const ucsEp = await fase2_gerarUCsParaEpico(epicos[i], funcList, result.length, corrUCs);
        result.push(...ucsEp);
      }
      if (!result.length) throw new Error("Nenhuma Feature (UC) gerada.");
      setUcs(result);
      setCorrUCs("");
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Correção: HUs ────────────────────────────────────────────────
  async function handleCorrectHUs() {
    setError(""); setLoading(true);
    const result = [];
    const ucsSemHU = [];
    try {
      for (let i = 0; i < ucs.length; i++) {
        const uc = ucs[i];
        log(`◈ Regerando Requisitos para ${uc.ftId}...`, i, ucs.length);
        let husUC = await fase3_gerarHUsParaUC(uc, result.length, corrHUs, ucToRNPrefix(uc.titulo), isCOR);
        if (!husUC.length) {
          ucsSemHU.push(`${uc.ftId}`);
          husUC = [createFallbackHU(uc, result.length)];
        }
        result.push(...husUC);
      }
      if (!result.length) throw new Error("Nenhum Requisito (HU) gerado.");
      log("🔎 Analisando nomes das Regras de Negócio...");
      const enriched = await enrichRNNames(result);
      setHus(enriched);
      setSelectedWI(enriched.map((_, i) => i));
      log("📋 Extraindo RF e RNF...");
      setUcs(await enrichRFRNF(enriched, ucs, epicos));
      setCorrHUs("");
      if (ucsSemHU.length) setError(`⚠ Alerta: HU básica criada para: ${ucsSemHU.join(", ")}. Revise com o painel de correção.`);
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Correção: CTs ────────────────────────────────────────────────
  async function handleCorrectCTs() {
    setError(""); setLoading(true);
    const result = [];
    try {
      for (let i = 0; i < ucs.length; i++) {
        log(`◎ Regerando testes para ${ucs[i].ftId}...`, i, ucs.length);
        result.push(...await fase4_gerarCTs(ucs[i], hus.filter(h => h.ucId === ucs[i].ucId), corrCTs, (ucs[i].requisitosNaoFuncionais || [])));
      }
      setCts(result);
      setCorrCTs("");
    } catch (e) { setErr(e.message, e); }
    finally { setLoading(false); setLoadMsg(""); setProgress({ cur: 0, total: 0 }); }
  }

  // ── Auditoria de Referências — corrigir lacunas e remover órfãos ─
  const handleFixRef = (ftId, rawPasso, oldId, newId) => {
    setUcs(prev => prev.map(uc => {
      if (uc.ftId !== ftId) return uc;
      return {
        ...uc,
        fluxoPrincipal: (uc.fluxoPrincipal || []).map(p => {
          if (p.passo !== rawPasso) return p;
          const esc = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const newRefs = newId
            ? safeRefs(p.refs).map(r => r === oldId ? newId : r)
            : safeRefs(p.refs).filter(r => r !== oldId);
          const newDesc = newId
            ? (p.descricao || "").replace(new RegExp(esc, "g"), newId)
            : (p.descricao || "").replace(new RegExp(`\\s*\\(?${esc}\\)?`, "g"), "").trim();
          return { ...p, refs: [...new Set(newRefs)], descricao: newDesc };
        }),
      };
    }));
  };

  const handleRemoveOrphan = (rnId) => {
    setHus(prev => prev.map(hu => ({
      ...hu,
      regrasNegocio: (hu.regrasNegocio || []).filter(rn => rn.id !== rnId),
    })));
  };

  const handleRenameOrphan = (oldId, newId) => {
    if (!newId || newId === oldId) return;
    // Renomeia nas regrasNegocio de todas as HUs
    setHus(prev => prev.map(hu => ({
      ...hu,
      regrasNegocio: (hu.regrasNegocio || []).map(rn =>
        rn.id === oldId ? { ...rn, id: newId } : rn
      ),
    })));
    // Atualiza refs e texto inline nos passos (por precaução)
    const esc = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setUcs(prev => prev.map(uc => ({
      ...uc,
      fluxoPrincipal: (uc.fluxoPrincipal || []).map(p => ({
        ...p,
        refs: safeRefs(p.refs).map(r => r === oldId ? newId : r),
        descricao: (p.descricao || "").replace(new RegExp(esc, "g"), newId),
      })),
    })));
  };

  // ── Remove referência dangling de todos os passos (lacuna sem definição) ──
  const handleRemoveLacunaRef = (refId) => {
    setUcs(prev => prev.map(uc => ({
      ...uc,
      fluxoPrincipal: (uc.fluxoPrincipal || []).map(p => ({
        ...p,
        refs: safeRefs(p.refs).filter(r => r !== refId),
      })),
    })));
  };

  // ── Remove item de uc[field] (RF ou RNF) ─────────────────────────
  const handleRemoveOrphanFromUC = (ftId, field, itemId) => {
    setUcs(prev => prev.map(uc => {
      if (uc.ftId !== ftId) return uc;
      return { ...uc, [field]: (uc[field] || []).filter(r => r.id !== itemId) };
    }));
  };

  // ── Renomeia item em uc[field] + atualiza refs nos passos ─────────
  const handleRenameOrphanInUC = (ftId, field, oldId, newId) => {
    if (!newId || newId === oldId) return;
    const esc = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setUcs(prev => prev.map(uc => {
      const updatedField = (uc[field] || []).map(r => r.id === oldId ? { ...r, id: newId } : r);
      const updatedFP = (uc.fluxoPrincipal || []).map(p => ({
        ...p,
        refs: safeRefs(p.refs).map(r => r === oldId ? newId : r),
        descricao: (p.descricao || "").replace(new RegExp(esc, "g"), newId),
      }));
      return uc.ftId === ftId
        ? { ...uc, [field]: updatedField, fluxoPrincipal: updatedFP }
        : { ...uc, fluxoPrincipal: updatedFP };
    }));
  };

  const handleLinkOrphanToStep = (rnId, ftId, rawPasso) => {
    setUcs(prev => prev.map(uc => {
      if (uc.ftId !== ftId) return uc;
      return {
        ...uc,
        fluxoPrincipal: (uc.fluxoPrincipal || []).map(p => {
          if (p.passo !== rawPasso) return p;
          const currentRefs = safeRefs(p.refs);
          if (currentRefs.includes(rnId)) return p;
          return { ...p, refs: [...currentRefs, rnId] };
        }),
      };
    }));
  };

  // ── Reconcilia refs via origemPasso (sem IA) ─────────────────────
  const handleAutoVincular = () => {
    setUcs(prev => autoVincularPorOrigemPasso(prev, hus));
  };

  // ── Enriquece RF/RNF sem reprocessar o pipeline ──────────────────
  const [enrichingRFRNF, setEnrichingRFRNF] = useState(false);
  const handleEnrichRFRNF = async () => {
    if (enrichingRFRNF) return;
    setEnrichingRFRNF(true);
    try {
      const updated = await enrichRFRNF(hus, ucs, epicos);
      setUcs(updated);
    } catch (e) {
      setError(`Erro ao enriquecer RF/RNF: ${e.message}`);
    } finally {
      setEnrichingRFRNF(false);
    }
  };

  // ── Formata HU como HTML para Azure DevOps ───────────────────────
  function huToHtml(hu) {
    const rns = (hu.regrasNegocio || []);
    return [
      `<h3>História de Usuário</h3>`,
      `<p><b>Como</b> ${hu.como || "—"}<br/>`,
      `<b>Quero</b> ${hu.quero || "—"}<br/>`,
      `<b>Para</b> ${hu.para || "—"}</p>`,
      `<hr/>`,
      rns.length ? [
        `<h4>Regras de Negócio</h4>`,
        `<ul>${rns.map(r => `<li><b>${r.id}${r.nome ? ` — ${r.nome}` : ""}</b>: ${r.descricao}</li>`).join("")}</ul>`,
      ].join("") : "",
    ].join("\n");
  }

  function huCriteriosToHtml(hu) {
    const crit = hu.criteriosAceitacao || [];
    if (!crit.length) return hu.workItem?.criteriosAceitacao || "";
    return `<ul>${crit.map(c => `<li><b>${c.id}</b> — ${c.descricao}</li>`).join("")}</ul>`;
  }

  // ── Formata UC como HTML para Feature no Azure DevOps ───────────
  function ucToHtml(uc, husDoUC = []) {
    const atorPrincipal = (uc.atores || [])[0] || "Usuário";
    const inferAtorFA = text => /^sistema|^o sistema/i.test(text || "") ? "Sistema" : atorPrincipal;

    const renderFA = a => {
      const passos = (a.passos || []).map((p, i) =>
        `<li><b>${i + 1}. [${inferAtorFA(p)}]</b> ${p}</li>`
      ).join("");
      const retorno = a.origemPasso
        ? `<li><b>${(a.passos || []).length + 1}. [Sistema]</b> Retorna ao ${a.origemPasso} do fluxo principal.</li>`
        : `<li><b>${(a.passos || []).length + 1}. [Sistema]</b> Caso de uso encerra.</li>`;
      return [
        `<p><b>${a.id} — ${a.titulo || "Fluxo Alternativo"}</b>`,
        a.descricao ? ` — <em>${a.descricao}</em>` : "",
        ` (origem: ${a.origemPasso || "—"})</p>`,
        `<ol>${passos}${retorno}</ol>`,
      ].join("");
    };

    const renderFE = e => {
      const retorno = e.retorno || (e.origemPasso
        ? `Retorna ao ${e.origemPasso} do fluxo principal`
        : "Caso de uso encerra");
      return [
        `<p><b>${e.id}</b>`,
        e.descricao ? ` — <em>${e.descricao}</em>` : "",
        ` (gatilho: ${e.origemPasso || "—"})</p>`,
        `<ol>`,
        `<li><b>1. [Sistema]</b> ${e.mensagem || "Exibe mensagem de erro"}</li>`,
        `<li><b>2. [Sistema]</b> ${retorno}</li>`,
        `</ol>`,
      ].join("");
    };

    // RNs agregadas das HUs vinculadas
    const rnsSeen = new Set();
    const rnsUniq = husDoUC.flatMap(h => h.regrasNegocio || [])
      .filter(r => { if (!r.id || rnsSeen.has(r.id)) return false; rnsSeen.add(r.id); return true; });

    return [
      `<h3>Feature — ${uc.ftId}</h3>`,
      `<p><b>Épico:</b> ${uc.epicId} — ${uc.epicTitulo || ""}</p>`,
      `<p><b>Atores:</b> ${(uc.atores || []).join(", ") || "—"}</p>`,
      `<p><b>Pré-condição:</b> ${uc.precondição || "—"}</p>`,
      `<p><b>Pós-condição:</b> ${uc.posCondição || "—"}</p>`,
      (uc.fluxoPrincipal || []).length
        ? `<h4>Fluxo Principal</h4><ol>${(uc.fluxoPrincipal || []).map(p => `<li><b>FP-${p.passo}:</b> ${p.descricao}</li>`).join("")}</ol>`
        : "",
      (uc.fluxosAlternativos || []).length
        ? `<h4>Fluxos Alternativos</h4>${(uc.fluxosAlternativos || []).map(renderFA).join("")}`
        : "",
      (uc.fluxosExcecao || []).length
        ? `<h4>Fluxos de Exceção</h4>${(uc.fluxosExcecao || []).map(renderFE).join("")}`
        : "",
      rnsUniq.length
        ? `<h4>Regras de Negócio</h4><ul>${rnsUniq.map(r => `<li><b>${r.id}${r.nome ? ` — ${r.nome}` : ""}</b>: ${r.descricao}</li>`).join("")}</ul>`
        : "",
      (uc.requisitosFuncionais || []).length
        ? `<h4>Requisitos Funcionais</h4><ul>${(uc.requisitosFuncionais || []).map(r => `<li><b>${r.id}</b>${r.origemPasso ? ` (${r.origemPasso})` : ""}: ${r.descricao}</li>`).join("")}</ul>`
        : "",
      (uc.requisitosNaoFuncionais || []).length
        ? `<h4>Requisitos Não Funcionais</h4><table border="1" cellpadding="4" style="border-collapse:collapse;width:100%"><tr><th>ID</th><th>Categoria</th><th>Descrição</th><th>Métrica</th></tr>${(uc.requisitosNaoFuncionais || []).map(r => `<tr><td><b>${r.id}</b></td><td>${r.categoria || "—"}</td><td>${r.descricao}</td><td>${r.metrica || "A definir"}</td></tr>`).join("")}</table>`
        : "",
    ].filter(Boolean).join("\n");
  }

  // ── Formata Épico como HTML para Epic no Azure DevOps ───────────
  function epicToHtml(ep) {
    return [
      `<h3>Épico — ${ep.id}</h3>`,
      `<p><b>Objetivo:</b> ${ep.objetivo || "—"}</p>`,
      (ep.manterEntidades || []).length
        ? `<p><b>Entidades (padrão Manter):</b> ${ep.manterEntidades.join(", ")}</p>`
        : "",
    ].filter(Boolean).join("\n");
  }

  // ── Formata CT como HTML para Task no Azure DevOps ──────────────
  function ctToHtml(ct) {
    const row = (label, val) => val ? `<tr><th style="text-align:left;padding:4px 10px 4px 0;white-space:nowrap">${label}</th><td style="padding:4px 0">${val}</td></tr>` : "";
    return [
      `<h4 style="margin:0 0 10px">${ct.identificador} — ${ct.fluxo || ""}${ct.tipo ? ` (${ct.tipo})` : ""}</h4>`,
      `<table style="border-collapse:collapse;font-size:13px;width:100%">`,
      row("DADO que", ct.dado),
      ct.e ? row("E", ct.e) : "",
      row("QUANDO", ct.quando),
      row("ENTÃO", ct.entao),
      `</table>`,
    ].join("");
  }

  // ── DevOps: Épico → Feature → Requirement ────────────────────────
  async function handleDevOps() {
    if (!azOrg || !azProject || !azPat) { setError("Preencha Organização, Projeto e PAT."); return; }
    const selectedHus = hus.filter((_, i) => selectedWI.includes(i));
    if (!selectedHus.length) { setError("Nenhum Requisito selecionado."); return; }
    setError(""); setLoading(true); setDevLog([]);
    const logs = [];
    const epicUrls = {};
    const featureUrls = {};
    const requirementUrls = {};

    // ── Wiki URL helper (liga cada item ao seu documento) ─────────────
    const prodSlugDev = !isCOR && produtoTitulo ? toSlug(produtoTitulo) : "";
    const wikiModRoot = isCOR
      ? `/${azWikiRoot}/COR`
      : (prodSlugDev ? `/${azWikiRoot}/${prodSlugDev}` : `/${azWikiRoot}`);
    const buildWikiUrl = pagePath => {
      if (!azWikiRepo || !pagePath) return null;
      const base = `https://dev.azure.com/${encodeURIComponent(azOrg)}/${encodeURIComponent(azProject)}/_wiki/wikis/${encodeURIComponent(azWikiRepo)}`;
      return `${base}?pagePath=${encodeURIComponent(pagePath)}`;
    };
    const epicWikiUrl  = ep  => buildWikiUrl(`${wikiModRoot}/${toSlug(ep.titulo)}`);
    const ucWikiUrl    = uc  => {
      const ep = epicos.find(e => e.id === uc.epicId);
      if (!ep) return null;
      return buildWikiUrl(`${wikiModRoot}/${toSlug(ep.titulo)}/Casos-de-Uso/${uc.ftId}-${toSlug(uc.titulo)}`);
    };
    const huWikiUrl    = hu  => {
      const uc = ucs.find(u => u.ftId === hu.ftId);
      return uc ? ucWikiUrl(uc) : null;
    };

    for (const epicId of [...new Set(selectedHus.map(h => h.epicId))].filter(Boolean)) {
      const ep = epicos.find(e => e.id === epicId);
      if (!ep) continue;
      log(`🚀 Criando Épico ${epicId}...`);
      try {
        const res = await createAzureWorkItem(azOrg, azProject, azPat, "Epic",
          `${ep.id} — ${ep.titulo}`,
          `<h3>Épico</h3><p><b>Objetivo:</b> ${ep.objetivo || ""}</p>`,
          null, ["Épico", ep.id, isCOR ? "COR" : (produtoTitulo || "")].filter(Boolean), null, azAreaPath, epicWikiUrl(ep));
        epicUrls[epicId] = res.url;
        logs.push({ tipo: "Épico", titulo: `${ep.id} — ${ep.titulo}`, id: res.id, url: res._links?.html?.href, ok: true });
      } catch (e) { logs.push({ tipo: "Épico", titulo: `${ep.id} — ${ep.titulo}`, ok: false, msg: e.message }); }
      setDevLog([...logs]);
    }

    for (const ftId of [...new Set(selectedHus.map(h => h.ftId))].filter(Boolean)) {
      const uc = ucs.find(u => u.ftId === ftId);
      if (!uc) continue;
      log(`🚀 Criando Feature ${ftId}...`);
      const ucDesc = ucToHtml(uc, hus.filter(h => h.ucId === uc.ucId));
      try {
        const res = await createAzureWorkItem(azOrg, azProject, azPat, "Feature",
          `${uc.ftId} — ${uc.titulo}`,
          ucDesc, null, ["Feature", uc.ftId, isCOR ? "COR" : (produtoTitulo || "")].filter(Boolean), epicUrls[uc.epicId] || null, azAreaPath, ucWikiUrl(uc));
        featureUrls[ftId] = res.url;
        logs.push({ tipo: "Feature", titulo: `${uc.ftId} — ${uc.titulo}`, id: res.id, url: res._links?.html?.href, ok: true });
      } catch (e) { logs.push({ tipo: "Feature", titulo: `${uc.ftId} — ${uc.titulo}`, ok: false, msg: e.message }); }
      setDevLog([...logs]);
    }

    for (let i = 0; i < selectedHus.length; i++) {
      const hu = selectedHus[i];
      if (!hu.workItem) continue;
      log(`🚀 Criando Requirement ${i + 1}/${selectedHus.length}...`);
      try {
        const res = await createAzureWorkItem(azOrg, azProject, azPat, "Requirement",
          hu.titulo,
          huToHtml(hu),
          huCriteriosToHtml(hu),
          (hu.workItem.tags || []).concat(["Requisito", hu.reqId, hu.ftId, isCOR ? "COR" : (produtoTitulo || "")]).filter(Boolean),
          featureUrls[hu.ftId] || null,
          azAreaPath, huWikiUrl(hu));
        requirementUrls[hu.reqId] = res.url;
        logs.push({ tipo: "Requirement", titulo: hu.titulo, id: res.id, url: res._links?.html?.href, ok: true });
      } catch (e) { logs.push({ tipo: "Requirement", titulo: hu.titulo, ok: false, msg: e.message }); }
      setDevLog([...logs]);
    }

    // ── Tasks (Casos de Teste) ────────────────────────────────────────
    const ctsToCreate = cts.filter(ct => selectedHus.some(h => h.reqId === ct.reqId || h.ucId === ct.ucId));
    for (let i = 0; i < ctsToCreate.length; i++) {
      const ct = ctsToCreate[i];
      log(`🧪 Criando Task CT ${i + 1}/${ctsToCreate.length}...`);
      const reqUrl = requirementUrls[ct.reqId] || null;
      const body = [
        { op: "add", path: "/fields/System.Title",       value: ct.identificador },
        { op: "add", path: "/fields/System.AreaPath",    value: azAreaPath },
        { op: "add", path: "/fields/System.Description", value: ctToHtml(ct) },
        { op: "add", path: "/fields/System.Tags",        value: ["CT", "Caso de Teste", ct.ftId || "", isCOR ? "COR" : (produtoTitulo || "")].filter(Boolean).join("; ") },
      ];
      // Vincula a Task como filha do Requirement pai via hierarquia
      if (reqUrl) body.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: reqUrl, attributes: {} } });
      const token = btoa(`:${azPat}`);
      const tcUrl = `/devops/${encodeURIComponent(azOrg)}/${encodeURIComponent(azProject)}/_apis/wit/workitems/$Task?api-version=7.1`;
      try {
        const r = await fetch(tcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json-patch+json", Authorization: `Basic ${token}` },
          body: JSON.stringify(body),
        });
        if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 180)}`); }
        const res = await r.json();
        logs.push({ tipo: "Task (CT)", titulo: ct.identificador, id: res.id, url: res._links?.html?.href, ok: true });
      } catch (e) { logs.push({ tipo: "Task (CT)", titulo: ct.identificador, ok: false, msg: e.message }); }
      setDevLog([...logs]);
    }

    setLoading(false); setLoadMsg(""); goToPhase(7);
  }

  // ── Wiki: gera arquivos e faz push no repositório Git ─────────────
  async function handleWiki() {
    if (!azOrg || !azWikiRepo || !azPat) { setError("Preencha Organização, Repositório Wiki e PAT."); return; }
    setError(""); setLoading(true); setWikiLog([]);
    try {
      log("📄 Gerando arquivos markdown...");
      const files = generateWikiFiles(epicos, ucs, hus, azWikiRoot, produtoTitulo, isCOR);
      log(`📤 Enviando ${files.length} arquivo(s) para ${azWikiRepo}/${azWikiBranch}...`);
      const result = await pushToWiki(
        azOrg, azProject, azPat,
        azWikiRepo, azWikiBranch, files,
        `docs: artefatos gerados pelo Agente de Requisitos — ${epicos.length} EP · ${ucs.length} UC · ${hus.length} REQ`
      );
      const stats = result._stats || {};
      const pushed = files.length;
      const msgParts = [];
      if (stats.repoCreated)  msgParts.push(`repositório "${azWikiRepo}" criado`);
      if (stats.newCount)     msgParts.push(`${stats.newCount} arquivo(s) criado(s)`);
      if (stats.updatedCount) msgParts.push(`${stats.updatedCount} versionado(s)`);
      const msg = msgParts.length ? msgParts.join(" · ") : `${pushed} arquivo(s) enviados`;
      setWikiLog([{ ok: true, msg, url: result?.commits?.[0]?.url || result?.url }]);
    } catch (e) {
      setWikiLog([{ ok: false, msg: e.message }]);
      setError(`Wiki: ${e.message}`);
    }
    setLoading(false); setLoadMsg("");
  }

  const toggleWI = i => setSelectedWI(p => p.includes(i) ? p.filter(x => x !== i) : [...p, i]);
  const reset = () => {
    setPhase(0); setMaxPhase(0); setFile(null); setChunks([]); setFuncList([]);
    setEpicos([]); setUcs([]); setHus([]); setCts([]);
    setSelectedWI([]); setDevLog([]); setError(""); setExpanded(null);
    setMigFiles([]); setMigrationMode(false); setProdutoTitulo(""); setIsCOR(false);
    localStorage.removeItem(STORAGE_KEY);
  };

  // ── Render helpers ────────────────────────────────────────────────
  const renderProgressBar = () => {
    if (!progress.total) return null;
    const pct = Math.round((progress.cur / progress.total) * 100);
    return (
      <div style={{ marginTop: 10 }}>
        <div style={{ background: "#dde8f5", borderRadius: 4, height: 3, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg, ${C.accent}aa, ${C.accent})`, transition: "width .35s ease", borderRadius: 4 }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ fontSize: 10, color: C.textDim }}>{progress.cur} / {progress.total}</span>
          <span style={{ fontSize: 10, color: C.accent }}>{pct}%</span>
        </div>
      </div>
    );
  };

  const renderCard = (tipo, id, titulo, conteudo, key, migrated) => {
    const color = TYPE_COLOR[tipo] || C.amber;
    const open = expanded === key;
    // Detecta tipo para render estruturado
    const isCT = tipo === "Caso de Teste";
    const isHU = tipo === "Requisito/HU";
    const isUC = tipo === "Feature/UC";
    return (
      <div key={key} className="card" style={{ border: `1px solid ${migrated ? C.amber + "30" : open ? color + "30" : color + "15"}`, background: open ? "#05070d" : C.surface }}>
        <div className="card-header" onClick={() => setExpanded(open ? null : key)}>
          <span className="badge" style={{ background: color + "18", color }}>{tipo}</span>
          <span style={{ fontSize: 11, color, fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>{id}</span>
          <span style={{ flex: 1, fontSize: 12, color: open ? C.text : C.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{titulo}</span>
          {migrated && <span className="badge" style={{ background: C.amber + "15", color: C.amber, fontSize: 9 }}>migrado</span>}
          <span style={{ color: color + "80", fontSize: 10, marginLeft: 4 }}>{open ? "▲" : "▼"}</span>
        </div>
        {open && (
          <div style={{ borderTop: `1px solid ${color}12`, padding: "12px 14px", maxHeight: 420, overflowY: "auto" }}>
            {isCT ? (
              // BDD card para Casos de Teste
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                {(conteudo || "").split("\n").map((line, i) => {
                  const kw = line.match(/^(DADO que|E |QUANDO|ENTÃO)/);
                  return kw
                    ? <div key={i}><span style={{ color: C.coral, fontWeight: 700, fontSize: 11 }}>{kw[0]}</span><span style={{ color: C.textDim }}>{line.slice(kw[0].length)}</span></div>
                    : <div key={i} style={{ color: C.textDim, fontSize: 11 }}>{line}</div>;
                })}
              </div>
            ) : isHU ? (
              // Cartão estruturado para HU
              <div style={{ fontSize: 12 }}>
                {(conteudo || "").split("\n").slice(0, 6).map((line, i) => {
                  const kw = line.match(/^(Como |Quero |Para )/);
                  if (kw) return <div key={i} style={{ marginBottom: 3 }}><span style={{ color: C.green, fontWeight: 700 }}>{kw[0]}</span><span style={{ color: C.text }}>{line.slice(kw[0].length)}</span></div>;
                  return null;
                })}
                {/* Critérios resumidos */}
                {(conteudo || "").includes("Critérios") && (
                  <div style={{ marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
                    <div style={{ fontSize: 10, color: C.textDim, fontWeight: 700, marginBottom: 4, letterSpacing: "0.08em" }}>CRITÉRIOS DE ACEITAÇÃO</div>
                    {(conteudo || "").split("\n").filter(l => l.trim().startsWith("Critério")).map((l, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#8a9ab0", paddingLeft: 8, borderLeft: `2px solid ${C.green}30`, marginBottom: 3 }}>
                        {l.replace(/^\s*/, "")}
                      </div>
                    ))}
                  </div>
                )}
                {/* Regras de Negócio resumidas */}
                {(conteudo || "").includes("Regras") && (
                  <div style={{ marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
                    <div style={{ fontSize: 10, color: C.textDim, fontWeight: 700, marginBottom: 4, letterSpacing: "0.08em" }}>REGRAS DE NEGÓCIO</div>
                    {(conteudo || "").split("\n").filter(l => l.match(/^\s+(RN-|RN\d)/)).slice(0, 5).map((l, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#8a9ab0", paddingLeft: 8, borderLeft: `2px solid ${C.amber}30`, marginBottom: 3 }}>
                        {l.replace(/^\s*/, "")}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : isUC ? (
              // Fluxo principal para Features
              <div style={{ fontSize: 12 }}>
                {(conteudo || "").split("\n").slice(0, 3).map((l, i) => (
                  <div key={i} style={{ color: C.textDim, marginBottom: 2 }}>{l}</div>
                ))}
                <div style={{ marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
                  <div style={{ fontSize: 10, color: C.textDim, fontWeight: 700, marginBottom: 6, letterSpacing: "0.08em" }}>FLUXO PRINCIPAL</div>
                  {(conteudo || "").split("\n").filter(l => l.match(/^\s+\d+\./)).slice(0, 7).map((l, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                      <span style={{ color: C.accent, fontWeight: 700, fontSize: 11, flexShrink: 0 }}>FP-{i + 1}</span>
                      <span style={{ color: "#8a9ab0", fontSize: 11 }}>{l.replace(/^\s+\d+\.\s*/, "")}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              // Fallback: texto simples
              <div style={{ fontSize: 12, color: "#8a9ab0", whiteSpace: "pre-wrap", lineHeight: 1.75 }}>
                {typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo, null, 2)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const ucToText = uc => {
    let t = `${uc.ftId} — ${uc.titulo}\nÉpico: ${uc.epicId} — ${uc.epicTitulo || ""}\nAtores: ${(uc.atores || []).join(", ")}\nPré-condição: ${uc.precondição || "—"}\n\nFluxo Principal:\n`;
    (uc.fluxoPrincipal || []).forEach(p => { t += `  ${p.passo}. ${p.descricao}\n`; });
    (uc.fluxosAlternativos || []).forEach(a => {
      t += `\nFA — ${a.id} — ${a.titulo || "Fluxo Alternativo"} (origem: ${a.origemPasso || a.origem || "—"})\n`;
      if (a.descricao) t += `  ${a.descricao}\n`;
      (a.passos || []).forEach((p, i) => { t += `  ${i + 1}. ${p}\n`; });
    });
    (uc.fluxosExcecao || []).forEach(e => {
      t += `\nFE — ${e.id} (origem: ${e.origemPasso || e.gatilho || "—"})\n`;
      if (e.descricao) t += `  ${e.descricao}\n`;
      t += `  1. "${e.mensagem}"\n  2. Retorna a: ${e.retorno}\n`;
    });
    t += `\nPós-condição: ${uc.posCondição || "—"}`;
    return t;
  };

  const huToText = hu => {
    let t = `${hu.reqId}\n${hu.ftId} (${hu.epicId})\n\nComo ${hu.como}\nQuero ${hu.quero}\nPara ${hu.para}\n\n`;
    t += `Regras de Negócio:\n`;
    (hu.regrasNegocio || []).forEach(r => { t += `  ${r.id}${r.nome ? ` — ${r.nome}` : ""}: ${r.descricao}\n`; });
    t += `\nCritérios de Aceitação:\n`;
    (hu.criteriosAceitacao || []).forEach(c => { t += `  ${c.id} — ${c.descricao}\n`; });
    return t;
  };

  const ctToText = ct =>
    `${ct.identificador} — Fluxo: ${ct.fluxo} | Tipo: ${ct.tipo}\n\nDADO que ${ct.dado}\nE ${ct.e}\nQUANDO ${ct.quando}\nENTÃO ${ct.entao}`;

  // ════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════

  return (
    <div style={{ fontFamily: "'Roboto','system-ui',sans-serif", background: C.bg, minHeight: "100vh", color: C.text, zoom: 1.2 }}>
      <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Condensed:wght@500;700&family=Nunito:wght@700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet" />
      <style>{`
        * { box-sizing: border-box }
        input, textarea {
          background: #FFFFFF; border: 1px solid #E8ECF5; border-radius: 6px;
          color: #444762; padding: 10px 14px; font-family: inherit; font-size: 13px;
          outline: none; width: 100%; transition: border-color .15s, box-shadow .15s;
        }
        input:focus, textarea:focus { border-color: #39ADE3; box-shadow: 0 0 0 3px #39ADE314 }
        .dg { border-color: #39ADE3 !important; background: #E9F5FA !important }
        ::-webkit-scrollbar { width: 5px; height: 5px }
        ::-webkit-scrollbar-track { background: #F9F9F9 }
        ::-webkit-scrollbar-thumb { background: #E8ECF5; border-radius: 3px }
        ::-webkit-scrollbar-thumb:hover { background: #87D5F6 }
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes fi { from { opacity: 0; transform: translateY(5px) } to { opacity: 1; transform: none } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
        .fi { animation: fi .2s ease both }
        .btn {
          cursor: pointer; border-radius: 6px; font-family: 'Roboto', sans-serif;
          font-weight: 500; font-size: 13px; padding: 11px 22px;
          transition: all .15s; border: none; white-space: nowrap; display: inline-flex;
          align-items: center; gap: 6px;
        }
        .btn:hover:not(:disabled) { filter: brightness(.93); transform: translateY(-1px) }
        .btn:active:not(:disabled) { transform: translateY(0) }
        .btn:disabled { opacity: .4; cursor: not-allowed }
        .wi { transition: background .12s }
        .wi:hover { background: #E9F5FA !important }
        .card { border-radius: 7px; border: 1px solid #E8ECF5; background: #FFFFFF; overflow: hidden; margin-bottom: 6px; transition: border-color .15s, box-shadow .15s }
        .card:hover { border-color: #87D5F6; box-shadow: 0 2px 8px #39ADE30d }
        .card-header { padding: 10px 14px; display: flex; align-items: center; gap: 8px; cursor: pointer }
        .badge { font-size: 10px; padding: 2px 8px; border-radius: 20px; font-weight: 500; letter-spacing: .03em; flex-shrink: 0; background: #E8ECF5; color: #74768B }
        .devops-tab { background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; font-family: inherit; transition: all .15s; padding: 5px 12px; margin-bottom: -1px; font-size: 11px; font-weight: 600 }
        .devops-tab:hover { opacity: .75 }
        .devops-tag { font-size: 10px; padding: 2px 9px; border-radius: 20px; background: #E8ECF5; border: 1px solid #E8ECF5; color: #74768B; font-family: inherit }
        .section-panel { background: #FFFFFF; border: 1px solid #E8ECF5; border-radius: 7px; padding: 16px; margin-bottom: 16px }
        .devops-html-preview table { border-collapse: collapse; width: 100%; margin: 6px 0 }
        .devops-html-preview td, .devops-html-preview th { padding: 4px 10px; border: 1px solid #E8ECF5; font-size: 12px }
        .devops-html-preview th { background: #E9F5FA; color: #444762; font-weight: 600; text-align: left; white-space: nowrap }
        .devops-html-preview ul, .devops-html-preview ol { margin: 4px 0; padding-left: 20px }
        .devops-html-preview li { margin-bottom: 3px; color: #627C89 }
        .devops-html-preview h3 { color: #444762; font-size: 13px; margin: 8px 0 4px; font-family: 'Nunito', sans-serif }
        .devops-html-preview h4 { color: #627C89; font-size: 12px; margin: 8px 0 3px }
        .devops-html-preview p { margin: 3px 0; color: #627C89 }
        .devops-html-preview b { color: #444762 }
        .devops-html-preview hr { border: none; border-top: 1px solid #E8ECF5; margin: 8px 0 }
        .hierarchy-line { border-left: 2px solid; padding-left: 10px }
      `}</style>

      {/* Header */}
      <div style={{ background: "#FFFFFF", borderBottom: `1px solid ${C.border}`, padding: "16px 28px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", boxShadow: "0 2px 8px #00366C0e" }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "linear-gradient(135deg, #00366C, #39ADE3)", flexShrink: 0 }} />
        <span style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 18, background: "linear-gradient(30deg, #00366C 0%, #39ADE3 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", letterSpacing: "-0.01em" }}>Agente de Requisitos</span>
        {(isCOR || produtoTitulo) && (
          <>
            <span style={{ color: C.border, fontSize: 18, margin: "0 2px" }}>│</span>
            <span style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 15, color: isCOR ? C.green : C.accent }}>
              {isCOR ? "COR — Global" : produtoTitulo}
            </span>
          </>
        )}
        <span style={{ color: C.border, fontSize: 16, margin: "0 2px" }}>│</span>
        <span style={{ fontSize: 12, color: C.muted, letterSpacing: "0.06em" }}>
          {epicos.length > 0 && <span style={{ color: C.purple, fontWeight: 700 }}>{epicos.length} EP · </span>}
          {ucs.length > 0 && <span style={{ color: C.accent, fontWeight: 700 }}>{ucs.length} FT/UC · </span>}
          {hus.length > 0 && <span style={{ color: C.green, fontWeight: 700 }}>{hus.length} REQ · </span>}
          {cts.length > 0 && <span style={{ color: C.coral, fontWeight: 700 }}>{cts.length} CT</span>}
          {epicos.length === 0 && <span style={{ color: "#b0bcd0" }}>EP → FT/UC → REQ → CT → DEVOPS</span>}
        </span>
        {maxPhase > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: C.green }}>
              {_s.savedAt ? `💾 salvo ${new Date(_s.savedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "💾 salvo"}
              {savedFileName && ` · ${savedFileName}`}
            </span>
            <button onClick={reset} style={{ background: "none", border: `1px solid ${C.red}50`, borderRadius: 5, color: C.red, fontSize: 11, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
              ✕ limpar
            </button>
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setManualOpen(true)} title="Manual do usuário — passo a passo do app"
            style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textDim, fontSize: 12, padding: "5px 13px", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", transition: "all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = C.green; e.currentTarget.style.color = C.green; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textDim; }}>
            ☰ Manual
          </button>
          <button onClick={() => setFaqOpen(true)} title="Por que trabalhamos assim? Rastreabilidade e auditorias."
            style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textDim, fontSize: 12, padding: "5px 13px", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", transition: "all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textDim; }}>
            ? FAQ
          </button>
          <span style={{ fontSize: 12, color: C.textDim, whiteSpace: "nowrap" }}>API Key</span>
          <input type="password" value={apiKey} onChange={e => handleApiKey(e.target.value)} placeholder="sk-ant-..."
            style={{ width: 210, padding: "6px 12px", fontSize: 12, background: "#f8fafc", border: `1px solid ${apiKey ? C.green : "#cbd5e1"}`, borderRadius: 6, color: C.text, fontFamily: "inherit", outline: "none" }} />
          {apiKey && <span style={{ color: C.green, fontSize: 13, fontWeight: 700 }}>✓</span>}
        </div>
      </div>

      {/* Phase bar */}
      <div style={{ display: "flex", background: "#f8fafc", borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
        {PHASES.map((p, i) => {
          const done = i < maxPhase;
          const active = i === phase;
          const reachable = i <= maxPhase;
          return (
            <div key={p.key}
              onClick={() => reachable && !loading && setPhase(i)}
              title={reachable ? (active ? p.label : `Ir para ${p.label}`) : ""}
              style={{
                flex: "0 0 auto", minWidth: 90, padding: "11px 8px", textAlign: "center",
                cursor: reachable && !loading ? "pointer" : "default",
                borderBottom: `2px solid ${active ? C.navy : done ? C.accent : "transparent"}`,
                color: active ? C.navy : done ? C.accent : "#b0bcd0",
                background: active ? C.sectionBg : "transparent",
                transition: "all .15s", position: "relative",
              }}>
              <div style={{ fontSize: 14, marginBottom: 4, lineHeight: 1 }}>
                {done && !active ? <span style={{ color: C.green, fontSize: 13 }}>✓</span> : p.icon}
              </div>
              <div style={{ fontSize: 10, fontFamily: "'Manrope',sans-serif", fontWeight: 700, letterSpacing: "0.04em" }}>{p.label}</div>
            </div>
          );
        })}
      </div>

      <div style={{ maxWidth: 840, margin: "0 auto", padding: "28px 18px 60px" }}>

        {error && (
          <div className="fi" style={{ background: "#fff5f5", border: `1px solid ${C.red}40`, borderRadius: 8, padding: "11px 14px", marginBottom: 18, color: C.red, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            ⚠ {error}
          </div>
        )}

        {loading && (
          <div className="fi" style={{ background: "#eef6ff", border: `1px solid ${C.accent}35`, borderRadius: 8, padding: "12px 16px", marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ position: "relative", width: 18, height: 18, flexShrink: 0 }}>
                <div style={{ position: "absolute", inset: 0, border: `2px solid ${C.accent}15`, borderRadius: "50%" }} />
                <div style={{ position: "absolute", inset: 0, border: `2px solid ${C.accent}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
              </div>
              <span style={{ color: C.accent, fontSize: 12, flex: 1 }}>{loadMsg}</span>
            </div>
            {renderProgressBar()}
          </div>
        )}

        {/* PHASE 0 — Upload */}
        {phase === 0 && (
          <div className="fi">
            {/* Tipo: COR global ou Produto específico */}
            <div style={{ marginBottom: 22 }}>
              <label style={{ fontSize: 10, color: C.textDim, display: "block", marginBottom: 8, letterSpacing: "0.08em", fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>
                TIPO DE DOCUMENTAÇÃO
              </label>
              <div style={{ display: "flex", gap: 2, background: C.surface, borderRadius: 9, padding: 3, border: `1px solid ${C.border}`, marginBottom: 12 }}>
                <button onClick={() => setIsCOR(true)}
                  style={{ flex: 1, padding: "9px 0", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 12,
                    background: isCOR ? "#070d10" : "transparent",
                    color: isCOR ? C.green : C.textDim,
                    boxShadow: isCOR ? `inset 0 0 0 1px ${C.green}30` : "none",
                    transition: "all .15s" }}>
                  COR — Funcionalidades Globais
                </button>
                <button onClick={() => setIsCOR(false)}
                  style={{ flex: 1, padding: "9px 0", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 12,
                    background: !isCOR ? "#0e1420" : "transparent",
                    color: !isCOR ? C.accent : C.textDim,
                    boxShadow: !isCOR ? `inset 0 0 0 1px ${C.accent}30` : "none",
                    transition: "all .15s" }}>
                  Produto / Funcionalidade
                </button>
              </div>

              {isCOR ? (
                <div style={{ padding: "10px 14px", background: "#f0faf3", border: `1px solid ${C.green}30`, borderRadius: 7, fontSize: 12 }}>
                  <span style={{ color: C.green, fontWeight: 700 }}>COR — Funcionalidades Globais</span>
                  <span style={{ color: C.textDim, marginLeft: 8 }}>Autenticação · Perfis · Auditoria · Configurações do sistema · Notificações globais</span>
                  <div style={{ marginTop: 5, fontSize: 11, color: C.textDim }}>
                    Wiki: <span style={{ color: C.green }}>documentacao/<strong>COR</strong>/...</span>
                    <span style={{ margin: "0 8px", color: C.border }}>·</span>
                    Tag DevOps: <span style={{ color: C.green }}>COR</span>
                  </div>
                </div>
              ) : (
                <div>
                  <input
                    value={produtoTitulo}
                    onChange={e => setProdutoTitulo(e.target.value)}
                    placeholder="ex.: Portal do Cliente, Módulo Fiscal, App Motorista..."
                    style={{ fontSize: 14, background: "#f8fafc", border: `1px solid ${produtoTitulo ? C.accent : "#cbd5e1"}`, borderRadius: 6, color: C.textBright, padding: "11px 14px", fontFamily: "inherit", outline: "none", width: "100%", transition: "border-color .15s" }}
                  />
                  {produtoTitulo && (
                    <div style={{ fontSize: 11, color: C.textDim, marginTop: 5 }}>
                      Wiki: <span style={{ color: C.accent }}>documentacao/<strong>{toSlug(produtoTitulo)}</strong>/...</span>
                      <span style={{ margin: "0 8px", color: C.border }}>·</span>
                      Tag DevOps: <span style={{ color: C.accent }}>{produtoTitulo}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Tab bar */}
            <div style={{ display: "flex", gap: 2, marginBottom: 24, background: C.surface, borderRadius: 9, padding: 3, border: `1px solid ${C.border}` }}>
              <button onClick={() => setMigrationMode(false)}
                style={{ flex: 1, padding: "9px 0", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 12,
                  background: !migrationMode ? "#0e1420" : "transparent",
                  color: !migrationMode ? C.accent : C.textDim,
                  boxShadow: !migrationMode ? `inset 0 0 0 1px ${C.accent}30` : "none",
                  transition: "all .15s" }}>
                Nova Análise
              </button>
              <button onClick={() => setMigrationMode(true)}
                style={{ flex: 1, padding: "9px 0", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 12,
                  background: migrationMode ? "#0e1420" : "transparent",
                  color: migrationMode ? C.amber : C.textDim,
                  boxShadow: migrationMode ? `inset 0 0 0 1px ${C.amber}30` : "none",
                  transition: "all .15s" }}>
                Migrar Documentos
              </button>
            </div>

            {/* Tab: Nova Análise */}
            {!migrationMode && (
              <>
                <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 22, color: C.textBright, marginBottom: 6 }}>Upload da Ata</h2>
                <p style={{ color: C.textDim, fontSize: 13, marginBottom: 24 }}>
                  Gera automaticamente: <span style={{ color: C.purple }}>Épicos (EP)</span> → <span style={{ color: C.accent }}>Features/UCs (FT)</span> → <span style={{ color: C.green }}>Requisitos/HUs (REQ)</span> → <span style={{ color: C.coral }}>Casos de Teste (CT)</span>.
                  Padrão <strong style={{ color: C.accent }}>Manter</strong> aplicado automaticamente para operações CRUD.
                  Suporta <strong>PDF · DOCX · DOC · TXT · MD</strong>.
                </p>
                <div ref={dropRef}
                  onDragOver={e => { e.preventDefault(); dropRef.current?.classList.add("dg"); }}
                  onDragLeave={() => dropRef.current?.classList.remove("dg")}
                  onDrop={e => { e.preventDefault(); dropRef.current?.classList.remove("dg"); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
                  onClick={() => document.getElementById("fi-inp").click()}
                  style={{ border: `1px dashed ${C.muted}`, borderRadius: 12, padding: "52px 24px", textAlign: "center", cursor: "pointer", background: C.surface, transition: "all .2s" }}>
                  <div style={{ fontSize: 36, marginBottom: 14, opacity: .5 }}>⬆</div>
                  <div style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 15, color: C.accent, marginBottom: 6 }}>Clique ou arraste o arquivo</div>
                  <div style={{ fontSize: 12, color: C.muted }}>PDF · DOCX · DOC · TXT · MD</div>
                  {file && <div style={{ marginTop: 14, fontSize: 12, color: "#6a7a90" }}>📎 {file.name} ({(file.size / 1024).toFixed(1)} KB)</div>}
                </div>
                <input id="fi-inp" type="file" accept=".pdf,.docx,.doc,.txt,.md" style={{ display: "none" }} onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
              </>
            )}

            {/* Tab: Migrar Documentos */}
            {migrationMode && (
              <>
                <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 22, color: C.textBright, marginBottom: 6 }}>Migrar Documentos Existentes</h2>
                <p style={{ color: C.textDim, fontSize: 13, marginBottom: 24 }}>
                  Importe documentos de requisitos já elaborados — <span style={{ color: C.amber }}>UC · RF · RNF · RN · Diagramas</span>.
                  A IA lê e mapeia o conteúdo original para o schema, <strong style={{ color: C.amber }}>preservando cada texto, ID e critério sem alterações</strong>.
                  Selecione múltiplos arquivos de uma vez.
                </p>
                <div ref={migDropRef}
                  onDragOver={e => { e.preventDefault(); migDropRef.current?.classList.add("dg"); }}
                  onDragLeave={() => migDropRef.current?.classList.remove("dg")}
                  onDrop={e => {
                    e.preventDefault(); migDropRef.current?.classList.remove("dg");
                    const dropped = Array.from(e.dataTransfer.files);
                    setMigFiles(prev => {
                      const names = new Set(prev.map(f => f.name));
                      return [...prev, ...dropped.filter(f => !names.has(f.name))];
                    });
                  }}
                  onClick={() => document.getElementById("mig-inp").click()}
                  style={{ border: `1px dashed ${C.amber}50`, borderRadius: 12, padding: "40px 24px", textAlign: "center", cursor: "pointer", background: C.surface, transition: "all .2s", marginBottom: 16 }}>
                  <div style={{ fontSize: 32, marginBottom: 12, opacity: .5 }}>📦</div>
                  <div style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 15, color: C.amber, marginBottom: 6 }}>Clique ou arraste os documentos</div>
                  <div style={{ fontSize: 12, color: C.textDim }}>PDF · DOCX · DOC · TXT · MD — múltiplos arquivos</div>
                </div>
                <input id="mig-inp" type="file" accept=".pdf,.docx,.doc,.txt,.md" multiple style={{ display: "none" }}
                  onChange={e => {
                    const added = Array.from(e.target.files || []);
                    setMigFiles(prev => {
                      const names = new Set(prev.map(f => f.name));
                      return [...prev, ...added.filter(f => !names.has(f.name))];
                    });
                    e.target.value = "";
                  }} />

                {/* File list */}
                {migFiles.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8, letterSpacing: "0.05em" }}>
                      {migFiles.length} arquivo(s) selecionado(s)
                    </div>
                    {migFiles.map((f, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, marginBottom: 5 }}>
                        <span style={{ fontSize: 14 }}>{
                          f.name.endsWith(".pdf") ? "📄" :
                          f.name.endsWith(".docx") || f.name.endsWith(".doc") ? "📝" : "📃"
                        }</span>
                        <span style={{ flex: 1, fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                        <span style={{ fontSize: 11, color: C.textDim, flexShrink: 0 }}>{(f.size / 1024).toFixed(1)} KB</span>
                        <button onClick={() => setMigFiles(prev => prev.filter((_, j) => j !== i))}
                          style={{ background: "none", border: `1px solid ${C.red}40`, borderRadius: 4, color: C.red + "90", fontSize: 11, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: "flex", gap: 10 }}>
                  {migFiles.length > 0 && (
                    <button onClick={() => setMigFiles([])}
                      style={{ background: "transparent", border: `1px solid ${C.muted}`, borderRadius: 7, color: C.textDim, fontSize: 13, padding: "11px 22px", cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>
                      Limpar lista
                    </button>
                  )}
                  <button className="btn" onClick={handleMigracao} disabled={loading || migFiles.length === 0}
                    style={{ background: migFiles.length > 0 ? "#100e00" : "transparent", border: `1px solid ${C.amber}`, color: C.amber }}>
                    {loading ? "Migrando..." : `📦 Iniciar Migração (${migFiles.length} arquivo${migFiles.length !== 1 ? "s" : ""})`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* PHASE 1 — Chunks */}
        {phase === 1 && (
          <div className="fi">
            <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 20, color: C.textBright, marginBottom: 4 }}>{file?.name}</h2>
            <p style={{ color: C.textDim, fontSize: 13, marginBottom: 20 }}>
              Dividido em <strong style={{ color: C.accent }}>{chunks.length} chunk(s)</strong>.
              Cada parte será analisada para extrair funcionalidades e agrupar em <strong style={{ color: C.purple }}>Épicos</strong>.
            </p>
            <div style={{ marginBottom: 22 }}>
              {chunks.map((c, i) => (
                <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 7, marginBottom: 6, overflow: "hidden" }}>
                  <div onClick={() => setExpanded(expanded === `c${i}` ? null : `c${i}`)} style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", background: C.surface }}>
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: C.accent + "15", color: C.accent, fontWeight: 600 }}>Chunk {i + 1}</span>
                    <span style={{ fontSize: 11, color: C.textDim }}>{c.length.toLocaleString()} chars</span>
                    <span style={{ marginLeft: "auto", color: C.muted, fontSize: 9 }}>{expanded === `c${i}` ? "▲" : "▼"}</span>
                  </div>
                  {expanded === `c${i}` && (
                    <div style={{ padding: 12, fontSize: 11, color: C.textDim, whiteSpace: "pre-wrap", lineHeight: 1.6, maxHeight: 200, overflowY: "auto", background: "#f8fafc" }}>
                      {c.slice(0, 800)}{c.length > 800 ? "\n[...]" : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn" onClick={() => { setPhase(0); setFile(null); setChunks([]); }} style={{ background: "transparent", border: `1px solid ${C.muted}`, color: C.textDim }}>← Trocar arquivo</button>
              <button className="btn" onClick={handleChunking} disabled={loading} style={{ background: C.purple + "0e", border: `1px solid ${C.purple}`, color: C.purple }}>
                {loading ? "Analisando..." : `✂ Extrair funções e gerar Épicos (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})`}
              </button>
            </div>
          </div>
        )}

        {/* PHASE 2 — Épicos */}
        {phase === 2 && (
          <div className="fi">
            <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 20, color: C.textBright, marginBottom: 4 }}>
              {epicos.length} Épico(s) — {funcList.length} Funcionalidades
            </h2>
            <p style={{ color: C.textDim, fontSize: 13, marginBottom: 18 }}>
              Funcionalidades agrupadas por domínio. Serão geradas <strong style={{ color: C.accent }}>Features (UCs)</strong> para cada Épico.
              {epicos.some(e => (e.manterEntidades || []).length > 0) && (
                <> Padrão <strong style={{ color: C.accent }}>Manter</strong> detectado: {epicos.flatMap(e => e.manterEntidades || []).join(", ")}.</>
              )}
            </p>
            <div style={{ marginBottom: 22 }}>
              {epicos.map((ep, i) => {
                const funcsEp = funcList.filter(f => (ep.funcIds || []).includes(f.id));
                const open = expanded === `ep${i}`;
                return (
                  <div key={i} style={{ border: `1px solid ${C.purple}18`, borderRadius: 8, marginBottom: 8, background: C.surface, overflow: "hidden" }}>
                    <div onClick={() => setExpanded(open ? null : `ep${i}`)} style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                      <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: C.purple + "18", color: C.purple, fontWeight: 600 }}>Épico</span>
                      <span style={{ fontSize: 11, color: C.purple, fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>{ep.id}</span>
                      <span style={{ flex: 1, fontSize: 13, color: C.textBright, fontFamily: "'Manrope',sans-serif", fontWeight: 600 }}>{ep.titulo}</span>
                      <span style={{ fontSize: 10, color: C.textDim, marginRight: 6 }}>{funcsEp.length} func.</span>
                      {(ep.manterEntidades || []).length > 0 && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: C.accent + "18", color: C.accent }}>Manter</span>}
                      <span style={{ color: C.purple, fontSize: 9 }}>{open ? "▲" : "▼"}</span>
                    </div>
                    {open && (
                      <div style={{ borderTop: `1px solid ${C.purple}12`, padding: "10px 14px" }}>
                        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 8 }}>{ep.objetivo}</div>
                        {(ep.manterEntidades || []).length > 0 && (
                          <div style={{ fontSize: 11, color: C.accent, marginBottom: 8 }}>
                            Padrão Manter aplicado: {ep.manterEntidades.join(", ")} → UCs consolidados
                          </div>
                        )}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {funcsEp.map(f => (
                            <span key={f.id} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: "#f0f3fa", border: `1px solid ${C.border}`, color: C.textDim }}>
                              {f.id} · {f.titulo}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <CorrectionPanel
              value={corrEpicos} onChange={setCorrEpicos}
              onRegenerate={handleCorrectEpicos} loading={loading}
              label="Épicos não estão corretos? Descreva a correção e regere."
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn" onClick={() => setPhase(1)} style={{ background: "transparent", border: `1px solid ${C.muted}`, color: C.textDim }}>← Voltar</button>
              <button className="btn" onClick={handleUCs} disabled={loading} style={{ background: C.accent + "0e", border: `1px solid ${C.accent}`, color: C.accent }}>
                {loading ? "Gerando Features..." : `✓ Épicos OK — Gerar Features (${epicos.length} Épico${epicos.length > 1 ? "s" : ""})`}
              </button>
            </div>
          </div>
        )}

        {/* PHASE 3 — Features/UCs */}
        {phase === 3 && (
          <div className="fi">
            <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 20, color: C.textBright, marginBottom: 4 }}>
              {ucs.length} Feature(s)/UC(s) Gerados
            </h2>
            <p style={{ color: C.textDim, fontSize: 13, marginBottom: 18 }}>
              Próximo passo: gerar <strong style={{ color: C.green }}>Requisitos (HUs)</strong> — múltiplos por UC.
            </p>
            <div style={{ marginBottom: 22 }}>
              {epicos.map(ep => {
                const ucsEp = ucs.filter(u => u.epicId === ep.id);
                if (!ucsEp.length) return null;
                return (
                  <div key={ep.id} style={{ marginBottom: 16 }}>
                    <SectionLabel color={C.purple}>{ep.id} — {ep.titulo}</SectionLabel>
                    {ucsEp.map(uc => renderCard("Feature", uc.ftId, uc.titulo, ucToText(uc), `uc${uc.ftId}`, uc._migrated))}
                  </div>
                );
              })}
            </div>
            <CorrectionPanel
              value={corrUCs} onChange={setCorrUCs}
              onRegenerate={handleCorrectUCs} loading={loading}
              label="Features/UCs precisam de ajuste? Descreva a correção e regere."
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn" onClick={() => setPhase(2)} style={{ background: "transparent", border: `1px solid ${C.muted}`, color: C.textDim }}>← Voltar</button>
              <button className="btn" onClick={handleHUs} disabled={loading} style={{ background: C.green + "0e", border: `1px solid ${C.green}`, color: C.green }}>
                {loading ? "Gerando Requisitos..." : `✓ Features OK — Gerar Requisitos (${ucs.length} UC${ucs.length > 1 ? "s" : ""})`}
              </button>
            </div>
          </div>
        )}

        {/* PHASE 4 — Requisitos/HUs */}
        {phase === 4 && (
          <div className="fi">
            <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 20, color: C.textBright, marginBottom: 4 }}>
              {hus.length} Requisito(s) Gerados
              {hus.some(h => h._fallback) && (
                <span style={{ fontSize: 11, marginLeft: 10, color: C.amber, fontFamily: "inherit", fontWeight: 400 }}>
                  ⚠ {hus.filter(h => h._fallback).length} HU(s) básica(s) — revisar
                </span>
              )}
            </h2>
            <p style={{ color: C.textDim, fontSize: 13, marginBottom: 18 }}>
              Próximo passo: gerar <strong style={{ color: C.coral }}>Casos de Teste</strong> para {ucs.length} UC(s).
            </p>
            <div style={{ marginBottom: 22 }}>
              {ucs.map(uc => {
                const husUC = hus.filter(h => h.ucId === uc.ucId);
                if (!husUC.length) return null;
                return (
                  <div key={uc.ucId} style={{ marginBottom: 12 }}>
                    <SectionLabel color={C.accent}>{uc.ftId} — {uc.titulo}</SectionLabel>
                    {husUC.map(hu => renderCard(
                      "Requisito/HU",
                      hu.reqId,
                      hu._fallback ? `⚠ ${hu.titulo} [básica — revisar]` : hu.titulo,
                      huToText(hu),
                      `hu${hu.reqId}`,
                      hu._migrated
                    ))}
                  </div>
                );
              })}
            </div>
            <CorrectionPanel
              value={corrHUs} onChange={setCorrHUs}
              onRegenerate={handleCorrectHUs} loading={loading}
              label="Requisitos/HUs precisam de ajuste? Descreva a correção e regere."
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn" onClick={() => setPhase(3)} style={{ background: "transparent", border: `1px solid ${C.muted}`, color: C.textDim }}>← Voltar</button>
              <button className="btn" onClick={handleCTs} disabled={loading} style={{ background: "#100800", border: `1px solid ${C.coral}`, color: C.coral }}>
                {loading ? "Gerando CTs..." : `✓ Requisitos OK — Gerar Casos de Teste`}
              </button>
            </div>
          </div>
        )}

        {/* PHASE 5 — Testes */}
        {phase === 5 && (
          <div className="fi">
            <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 20, color: C.textBright, marginBottom: 4 }}>
              {cts.length} Caso(s) de Teste
            </h2>
            <p style={{ color: C.textDim, fontSize: 13, marginBottom: 18 }}>
              Pipeline completo: <span style={{ color: C.purple }}>{epicos.length} EP</span> · <span style={{ color: C.accent }}>{ucs.length} FT/UC</span> · <span style={{ color: C.green }}>{hus.length} REQ</span> · <span style={{ color: C.coral }}>{cts.length} CT</span>
            </p>
            <div style={{ marginBottom: 22 }}>
              {cts.map((ct, i) => renderCard("Caso de Teste", ct.identificador, `${ct.fluxo} — ${ct.ftId || ""}`, ctToText(ct), `ct${i}`))}
            </div>
            <CorrectionPanel
              value={corrCTs} onChange={setCorrCTs}
              onRegenerate={handleCorrectCTs} loading={loading}
              label="Casos de Teste precisam de ajuste? Descreva a correção e regere."
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn" onClick={() => setPhase(4)} style={{ background: "transparent", border: `1px solid ${C.muted}`, color: C.textDim }}>← Voltar</button>
              <button className="btn" onClick={() => goToPhase(6)} style={{ background: C.accent + "0e", border: `1px solid ${C.accent}`, color: C.accent }}>
                ✓ Testes OK — Revisar e Enviar ao DevOps →
              </button>
            </div>
          </div>
        )}

        {/* PHASE 6 — Review + DevOps */}
        {phase === 6 && (
          <div className="fi">
            <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 20, color: C.textBright, marginBottom: 8 }}>
              Revisão e Envio ao Azure DevOps
            </h2>
            {/* Pipeline summary */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
              {[
                { label: "Épico", count: epicos.length, color: C.purple },
                { label: "Feature", count: ucs.length, color: C.accent },
                { label: "Requirement", count: hus.length, color: C.green },
                { label: "Task (CT)", count: cts.length, color: C.coral },
              ].map(({ label, count, color }, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "4px 10px", borderRadius: 5, background: color + "12", border: `1px solid ${color}20`, color }}>
                  <strong>{count}</strong> {label}
                </span>
              ))}
              <span style={{ fontSize: 10, color: C.textDim, marginLeft: 4 }}>
                clique em <strong style={{ color: C.accent }}>DevOps ▼</strong> para pré-visualizar cada item antes de enviar
              </span>
            </div>

            {/* Auditoria de Referências */}
            <AuditPanel ucs={ucs} hus={hus} onFixRef={handleFixRef} onRemoveOrphan={handleRemoveOrphan} onRenameOrphan={handleRenameOrphan} onLinkOrphanToStep={handleLinkOrphanToStep} onRemoveOrphanFromUC={handleRemoveOrphanFromUC} onRenameOrphanInUC={handleRenameOrphanInUC} onEnrichRFRNF={handleEnrichRFRNF} enrichingRFRNF={enrichingRFRNF} onAutoVincular={handleAutoVincular} onRemoveLacunaRef={handleRemoveLacunaRef} />

            {/* Barra de seleção rápida */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <SectionLabel color={C.accent}>Work Items — Hierarquia Azure DevOps</SectionLabel>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: C.textDim }}>{selectedWI.length}/{hus.length} selecionados</span>
                <button onClick={() => setSelectedWI(hus.map((_, i) => i))}
                  style={{ background: "none", border: `1px solid ${C.green}30`, borderRadius: 5, color: C.green, fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  Todos
                </button>
                <button onClick={() => setSelectedWI([])}
                  style={{ background: "none", border: `1px solid ${C.muted}`, borderRadius: 5, color: C.textDim, fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  Nenhum
                </button>
              </div>
            </div>

            {/* Hierarquia Epic → Feature → Requirement */}
            {epicos.map(ep => {
              const ucsEp = ucs.filter(u => u.epicId === ep.id);
              // Usa ucId (não epicId) para verificar se o épico tem HUs — epicId nos HUs
              // pode divergir caso os épicos tenham sido regerados após as HUs.
              if (!ucsEp.some(uc => hus.some(h => h.ucId === uc.ucId))) return null;
              const epPreviewKey = `p6ep-${ep.id}`;
              const isEpOpen = expanded === epPreviewKey;
              return (
                <div key={ep.id} style={{ marginBottom: 20 }}>
                  {/* ── Epic ── */}
                  <div style={{ border: `1px solid ${C.purple}30`, borderRadius: 9, overflow: "hidden", marginBottom: 8, background: "#faf8ff" }}>
                    <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="badge" style={{ background: C.purple + "18", color: C.purple }}>Epic</span>
                      <span style={{ fontSize: 11, color: C.purple, fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>{ep.id}</span>
                      <span style={{ flex: 1, fontSize: 12, color: C.textBright, fontFamily: "'Manrope',sans-serif", fontWeight: 600 }}>{ep.titulo}</span>
                      <button
                        onClick={() => setExpanded(isEpOpen ? null : epPreviewKey)}
                        style={{ background: isEpOpen ? C.purple + "15" : "transparent", border: `1px solid ${C.purple}30`, borderRadius: 5, color: C.purple, fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                        {isEpOpen ? "▲ Fechar" : "DevOps ▼"}
                      </button>
                    </div>
                    {isEpOpen && (
                      <div style={{ borderTop: `1px solid ${C.purple}20`, padding: "12px 14px 14px", background: "#f5f3ff" }}>
                        <DevOpsWorkItem type="Epic" typeColor={C.purple}
                          title={`${ep.id} — ${ep.titulo}`}
                          description={epicToHtml(ep)}
                          tags={["Épico", ep.id, isCOR ? "COR" : produtoTitulo].filter(Boolean)} />
                      </div>
                    )}
                  </div>

                  {/* ── Features do Epic ── */}
                  <div className="hierarchy-line" style={{ borderColor: C.purple + "20", paddingLeft: 14, marginLeft: 6 }}>
                    {ucsEp.map(uc => {
                      const husUC = hus.filter(h => h.ucId === uc.ucId);
                      if (!husUC.length) return null;
                      const ftPreviewKey = `p6ft-${uc.ftId}`;
                      const isFtOpen = expanded === ftPreviewKey;
                      return (
                        <div key={uc.ucId} style={{ marginBottom: 10 }}>
                          {/* Feature header */}
                          <div style={{ border: `1px solid ${C.accent}30`, borderRadius: 8, overflow: "hidden", marginBottom: 6, background: "#f5f9ff" }}>
                            <div style={{ padding: "8px 13px", display: "flex", alignItems: "center", gap: 8 }}>
                              <span className="badge" style={{ background: C.accent + "15", color: C.accent }}>Feature</span>
                              <span style={{ fontSize: 11, color: C.accent, fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>{uc.ftId}</span>
                              <span style={{ flex: 1, fontSize: 12, color: C.text }}>{uc.titulo}</span>
                              <span style={{ fontSize: 10, color: C.textDim, marginRight: 4 }}>{husUC.length} req.</span>
                              <button
                                onClick={() => setExpanded(isFtOpen ? null : ftPreviewKey)}
                                style={{ background: isFtOpen ? C.accent + "12" : "transparent", border: `1px solid ${C.accent}25`, borderRadius: 5, color: C.accent, fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                {isFtOpen ? "▲ Fechar" : "DevOps ▼"}
                              </button>
                            </div>
                            {isFtOpen && (
                              <div style={{ borderTop: `1px solid ${C.accent}20`, padding: "12px 14px 14px", background: "#eef6ff" }}>
                                <DevOpsWorkItem type="Feature" typeColor={C.accent}
                                  title={`${uc.ftId} — ${uc.titulo}`}
                                  description={ucToHtml(uc, hus.filter(h => h.ucId === uc.ucId))}
                                  tags={["Feature", uc.ftId, isCOR ? "COR" : produtoTitulo].filter(Boolean)} />
                              </div>
                            )}
                          </div>

                          {/* Requirements */}
                          <div className="hierarchy-line" style={{ borderColor: C.accent + "15", paddingLeft: 12, marginLeft: 4 }}>
                            {husUC.map(hu => {
                              const idx = hus.indexOf(hu);
                              const wi = hu.workItem;
                              if (!wi) return null;
                              const sel = selectedWI.includes(idx);
                              const reqPreviewKey = `p6req-${hu.reqId}`;
                              const isReqOpen = expanded === reqPreviewKey;
                              return (
                                <div key={idx} style={{ border: `1px solid ${sel ? C.green + "60" : C.border}`, borderRadius: 7, marginBottom: 5, background: sel ? "#f0faf4" : C.surface, transition: "all .15s", overflow: "hidden" }}>
                                  <div style={{ padding: "8px 12px", display: "flex", gap: 10, alignItems: "center" }}>
                                    {/* Checkbox area */}
                                    <div className="wi" onClick={() => toggleWI(idx)} style={{ display: "flex", gap: 10, alignItems: "center", flex: 1, cursor: "pointer", minWidth: 0 }}>
                                      <div style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${sel ? C.green : C.muted}`, background: sel ? C.green : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#000", fontWeight: 900, transition: "all .15s" }}>
                                        {sel ? "✓" : ""}
                                      </div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                          <span className="badge" style={{ background: C.green + "12", color: C.green, fontSize: 9 }}>Requirement</span>
                                          <span style={{ fontSize: 11, color: C.green, fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>{hu.reqId}</span>
                                          {hu._fallback && <span className="badge" style={{ background: C.amber + "15", color: C.amber, fontSize: 9 }}>básica</span>}
                                          {hu._migrated && <span className="badge" style={{ background: C.amber + "15", color: C.amber, fontSize: 9 }}>migrado</span>}
                                        </div>
                                        <div style={{ fontSize: 11, color: C.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{wi.titulo}</div>
                                      </div>
                                    </div>
                                    {/* DevOps preview toggle */}
                                    <button
                                      onClick={e => { e.stopPropagation(); setExpanded(isReqOpen ? null : reqPreviewKey); }}
                                      style={{ background: isReqOpen ? C.green + "12" : "transparent", border: `1px solid ${C.green}25`, borderRadius: 5, color: isReqOpen ? C.green : C.textDim, fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0, transition: "all .15s" }}>
                                      {isReqOpen ? "▲ Fechar" : "DevOps ▼"}
                                    </button>
                                  </div>
                                  {/* DevOps Work Item preview */}
                                  {isReqOpen && (
                                    <div style={{ borderTop: `1px solid ${C.border}`, padding: "14px", background: "#f5fafc" }}>
                                      <DevOpsWorkItem
                                        type="Requirement"
                                        typeColor={C.green}
                                        title={wi.titulo || hu.titulo}
                                        description={huToHtml(hu)}
                                        acceptanceCriteria={huCriteriosToHtml(hu)}
                                        tags={(wi.tags || []).concat(["Requisito", hu.reqId, hu.ftId, isCOR ? "COR" : produtoTitulo]).filter(Boolean)} />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Features órfãs — ucId sem épico correspondente (épicos podem ter sido regerados) */}
            {(() => {
              const knownEpicIds = new Set(epicos.map(e => e.id));
              const orphanUCs = ucs.filter(u => !knownEpicIds.has(u.epicId) && hus.some(h => h.ucId === u.ucId));
              if (!orphanUCs.length) return null;
              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ border: `1px solid ${C.amber}30`, borderRadius: 9, overflow: "hidden", marginBottom: 8, background: "#fffdf5" }}>
                    <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="badge" style={{ background: C.amber + "18", color: C.amber }}>⚠</span>
                      <span style={{ flex: 1, fontSize: 12, color: C.amber, fontFamily: "'Manrope',sans-serif", fontWeight: 600 }}>
                        Features sem épico — épico original não encontrado ({orphanUCs.length} feature{orphanUCs.length > 1 ? "s" : ""})
                      </span>
                    </div>
                  </div>
                  <div className="hierarchy-line" style={{ borderColor: C.amber + "20", paddingLeft: 14, marginLeft: 6 }}>
                    {orphanUCs.map(uc => {
                      const husUC = hus.filter(h => h.ucId === uc.ucId);
                      if (!husUC.length) return null;
                      const ftPreviewKey = `p6ft-orphan-${uc.ftId}`;
                      const isFtOpen = expanded === ftPreviewKey;
                      return (
                        <div key={uc.ucId} style={{ marginBottom: 10 }}>
                          <div style={{ border: `1px solid ${C.accent}30`, borderRadius: 8, overflow: "hidden", marginBottom: 6, background: "#f5f9ff" }}>
                            <div style={{ padding: "8px 13px", display: "flex", alignItems: "center", gap: 8 }}>
                              <span className="badge" style={{ background: C.accent + "15", color: C.accent }}>Feature</span>
                              <span style={{ fontSize: 11, color: C.accent, fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>{uc.ftId}</span>
                              <span style={{ flex: 1, fontSize: 12, color: C.text }}>{uc.titulo}</span>
                              <span style={{ fontSize: 10, color: C.textDim, marginRight: 4 }}>{husUC.length} req.</span>
                              <button
                                onClick={() => setExpanded(isFtOpen ? null : ftPreviewKey)}
                                style={{ background: isFtOpen ? C.accent + "12" : "transparent", border: `1px solid ${C.accent}25`, borderRadius: 5, color: C.accent, fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                {isFtOpen ? "▲ Fechar" : "DevOps ▼"}
                              </button>
                            </div>
                            {isFtOpen && (
                              <div style={{ borderTop: `1px solid ${C.accent}20`, padding: "12px 14px 14px", background: "#eef6ff" }}>
                                <DevOpsWorkItem type="Feature" typeColor={C.accent}
                                  title={`${uc.ftId} — ${uc.titulo}`}
                                  description={ucToHtml(uc, hus.filter(h => h.ucId === uc.ucId))}
                                  tags={["Feature", uc.ftId, isCOR ? "COR" : produtoTitulo].filter(Boolean)} />
                              </div>
                            )}
                          </div>
                          <div className="hierarchy-line" style={{ borderColor: C.accent + "15", paddingLeft: 12, marginLeft: 4 }}>
                            {husUC.map(hu => {
                              const idx = hus.indexOf(hu);
                              const wi = hu.workItem;
                              if (!wi) return null;
                              const sel = selectedWI.includes(idx);
                              const reqPreviewKey = `p6req-orphan-${hu.reqId}`;
                              const isReqOpen = expanded === reqPreviewKey;
                              return (
                                <div key={idx} style={{ border: `1px solid ${sel ? C.green + "60" : C.border}`, borderRadius: 7, marginBottom: 5, background: sel ? "#f0faf4" : C.surface, overflow: "hidden" }}>
                                  <div style={{ padding: "8px 12px", display: "flex", gap: 10, alignItems: "center" }}>
                                    <div className="wi" onClick={() => toggleWI(idx)} style={{ display: "flex", gap: 10, alignItems: "center", flex: 1, cursor: "pointer", minWidth: 0 }}>
                                      <div style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${sel ? C.green : C.muted}`, background: sel ? C.green : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#000", fontWeight: 900 }}>
                                        {sel ? "✓" : ""}
                                      </div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                          <span className="badge" style={{ background: C.green + "12", color: C.green, fontSize: 9 }}>Requirement</span>
                                          <span style={{ fontSize: 11, color: C.green, fontFamily: "'Manrope',sans-serif", fontWeight: 700 }}>{hu.reqId}</span>
                                        </div>
                                        <div style={{ fontSize: 11, color: C.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{wi.titulo}</div>
                                      </div>
                                    </div>
                                    <button onClick={e => { e.stopPropagation(); setExpanded(isReqOpen ? null : reqPreviewKey); }}
                                      style={{ background: isReqOpen ? C.green + "12" : "transparent", border: `1px solid ${C.green}25`, borderRadius: 5, color: isReqOpen ? C.green : C.textDim, fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                                      {isReqOpen ? "▲ Fechar" : "DevOps ▼"}
                                    </button>
                                  </div>
                                  {isReqOpen && (
                                    <div style={{ borderTop: `1px solid ${C.border}`, padding: "14px", background: "#f5fafc" }}>
                                      <DevOpsWorkItem type="Requirement" typeColor={C.green}
                                        title={wi.titulo || hu.titulo}
                                        description={huToHtml(hu)}
                                        acceptanceCriteria={huCriteriosToHtml(hu)}
                                        tags={(wi.tags || []).concat(["Requisito", hu.reqId, hu.ftId, isCOR ? "COR" : produtoTitulo]).filter(Boolean)} />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Configuração Azure DevOps + Wiki — painel colapsável */}
            <div style={{ border: `1px solid ${azPat ? C.accent + "30" : C.border}`, borderRadius: 10, marginTop: 20, marginBottom: 20, overflow: "hidden", background: C.surface }}>
              {/* Header do painel */}
              <div
                onClick={() => setConfigOpen(o => !o)}
                style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", background: configOpen ? "#f0f6ff" : C.surface }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.accent }}>CONFIGURAÇÃO AZURE DEVOPS</span>
                {azOrg && <span style={{ fontSize: 10, color: C.textDim }}>{azOrg} / {azProject}</span>}
                {!azPat && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 8, background: C.amber + "18", color: C.amber, fontWeight: 700 }}>PAT pendente</span>}
                {azPat  && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 8, background: C.green + "15", color: C.green, fontWeight: 700 }}>✓ configurado</span>}
                <span style={{ marginLeft: "auto", fontSize: 9, color: C.muted }}>{configOpen ? "▲ Fechar" : "▼ Editar"}</span>
              </div>

              {configOpen && (
                <div style={{ padding: "14px 16px 16px", borderTop: `1px solid ${C.border}` }}>

                  {/* DevOps */}
                  <SectionLabel color={C.accent}>Azure DevOps — Work Items</SectionLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Organização</label>
                      <input value={azOrg} onChange={e => setAzOrg(e.target.value)} placeholder="minha-org" />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Projeto</label>
                      <input value={azProject} onChange={e => setAzProject(e.target.value)} placeholder="meu-projeto" />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Area Path</label>
                      <input value={azAreaPath} onChange={e => setAzAreaPath(e.target.value)} placeholder="Projeto DDA" />
                    </div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Personal Access Token (PAT)</label>
                    <div style={{ position: "relative" }}>
                      <input type={showPat ? "text" : "password"} value={azPat} onChange={e => setAzPat(e.target.value)} placeholder="••••••••••••••••••••••" style={{ paddingRight: 56 }} />
                      <button onClick={() => setShowPat(p => !p)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                        {showPat ? "ocultar" : "mostrar"}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>Permissões necessárias: <strong style={{ color: C.muted }}>Work Items: Read &amp; Write · Code: Read &amp; Write</strong></div>
                  </div>

                  {/* Wiki */}
                  <SectionLabel color={C.purple}>Documentação Wiki (Git)</SectionLabel>
                  <div style={{ fontSize: 11, color: "#6a9a70", marginBottom: 10 }}>
                    Use um <strong style={{ color: C.purple }}>repositório dedicado à documentação</strong> — nunca o repositório de desenvolvimento.
                    Arquivos existentes são <strong style={{ color: C.purple }}>versionados</strong>; arquivos novos são criados. Nenhum arquivo é excluído.
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Tipo / Produto</label>
                    <div style={{ display: "flex", gap: 2, background: C.surface, borderRadius: 8, padding: 3, border: `1px solid ${C.border}`, marginBottom: isCOR ? 0 : 8 }}>
                      <button onClick={() => setIsCOR(true)}
                        style={{ flex: 1, padding: "7px 0", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 11,
                          background: isCOR ? "#070d10" : "transparent", color: isCOR ? C.green : C.textDim,
                          boxShadow: isCOR ? `inset 0 0 0 1px ${C.green}30` : "none", transition: "all .15s" }}>
                        COR — Global
                      </button>
                      <button onClick={() => setIsCOR(false)}
                        style={{ flex: 1, padding: "7px 0", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 11,
                          background: !isCOR ? "#0e1420" : "transparent", color: !isCOR ? C.accent : C.textDim,
                          boxShadow: !isCOR ? `inset 0 0 0 1px ${C.accent}30` : "none", transition: "all .15s" }}>
                        Produto / Funcionalidade
                      </button>
                    </div>
                    {isCOR ? (
                      <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
                        Pasta wiki: <span style={{ color: C.green }}>{azWikiRoot}/<strong>COR</strong>/...</span>
                        <span style={{ margin: "0 8px", color: C.border }}>·</span>
                        Tag DevOps: <span style={{ color: C.green }}>COR</span>
                      </div>
                    ) : (
                      <div>
                        <input value={produtoTitulo} onChange={e => setProdutoTitulo(e.target.value)} placeholder="ex.: Portal do Cliente, Módulo Fiscal..." />
                        {produtoTitulo && (
                          <div style={{ fontSize: 11, color: C.textDim, marginTop: 5 }}>
                            Pasta wiki: <span style={{ color: C.accent }}>{azWikiRoot}/<strong>{toSlug(produtoTitulo)}</strong>/...</span>
                            <span style={{ margin: "0 8px", color: C.border }}>·</span>
                            Tag DevOps: <span style={{ color: C.accent }}>{produtoTitulo}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Repositório de Documentação</label>
                      <input value={azWikiRepo} onChange={e => setAzWikiRepo(e.target.value)} placeholder="ex: docs-squad-cloud" />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Branch</label>
                      <input value={azWikiBranch} onChange={e => setAzWikiBranch(e.target.value)} placeholder="main" />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: C.textDim, marginBottom: 6 }}>Pasta raiz</label>
                      <input value={azWikiRoot} onChange={e => setAzWikiRoot(e.target.value)} placeholder="documentacao" />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>
                    Gera: <span style={{ color: C.purple }}>{epicos.length} módulo(s)</span> · {ucs.length} UC(s) · RF · RN · MSG · RNF por módulo — <strong style={{ color: "#8a78a8" }}>novos criados · existentes versionados · histórico preservado</strong>
                  </div>

                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setPhase(5)} style={{ background: "transparent", border: `1px solid ${C.muted}`, color: C.textDim }}>← Voltar</button>
              <button className="btn" onClick={handleDevOps} disabled={loading || selectedWI.length === 0} style={{ background: C.accent + "0e", border: `1px solid ${C.accent}`, color: C.accent }}>
                {loading ? "Criando..." : `🚀 Work Items EP→FT→REQ→TC (${selectedWI.length} REQ · ${cts.length} CT)`}
              </button>
              <button className="btn" onClick={handleWiki} disabled={loading} style={{ background: C.purple + "0e", border: `1px solid ${C.purple}`, color: C.purple }}>
                {loading ? "Publicando..." : `📄 Publicar Wiki (${epicos.length} módulo${epicos.length > 1 ? "s" : ""})`}
              </button>
            </div>

            {/* Resultado inline do Publicar Wiki */}
            {wikiLog.length > 0 && (
              <div className="fi" style={{ marginTop: 16, background: wikiLog[0].ok ? "#f5f0ff" : "#fff5f5", border: `1px solid ${wikiLog[0].ok ? C.purple + "50" : C.red + "40"}`, borderRadius: 8, padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <span style={{ fontSize: 16, color: wikiLog[0].ok ? C.purple : C.red, flexShrink: 0 }}>{wikiLog[0].ok ? "✓" : "✗"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: wikiLog[0].ok ? C.purple : C.red, fontWeight: 600, marginBottom: wikiLog[0].url ? 4 : 0 }}>
                      {wikiLog[0].ok ? "Wiki publicada com sucesso" : "Falha ao publicar Wiki"}
                    </div>
                    <div style={{ fontSize: 11, color: C.textDim }}>{wikiLog[0].msg}</div>
                    {wikiLog[0].url && (
                      <a href={wikiLog[0].url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, color: C.accent, textDecoration: "none", display: "inline-block", marginTop: 4 }}>
                        Ver commit no repositório ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* PHASE 7 — Done */}
        {phase === 7 && (
          <div className="fi" style={{ paddingTop: 28 }}>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div style={{ width: 56, height: 56, borderRadius: "50%", background: C.green + "15", border: `2px solid ${C.green}40`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", fontSize: 22, color: C.green }}>✓</div>
              <h2 style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 24, color: C.textBright, marginBottom: 6 }}>Publicado com sucesso!</h2>
              <p style={{ color: C.textDim, fontSize: 13 }}>
                {devLog.length > 0 && (() => {
                const ok = devLog.filter(l => l.ok); const err = devLog.filter(l => !l.ok);
                const tcs = ok.filter(l => l.tipo === "Task (CT)");
                return <><strong style={{ color: C.green }}>{ok.length}</strong> item(s) criados{tcs.length > 0 && <> · <strong style={{ color: C.coral }}>{tcs.length} TC</strong></>}{err.length > 0 && <> · <strong style={{ color: C.red }}>{err.length}</strong> com erro</>}</>;
              })()}
                {devLog.length > 0 && wikiLog.length > 0 && <span style={{ color: C.textDim }}> · </span>}
                {wikiLog.length > 0 && <><strong style={{ color: wikiLog[0].ok ? C.purple : C.red }}>Wiki: {wikiLog[0].ok ? wikiLog[0].msg : "falhou"}</strong></>}
              </p>
            </div>

            {devLog.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <SectionLabel color={C.accent}>Work Items</SectionLabel>
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                  {devLog.map((l, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 0", borderBottom: i < devLog.length - 1 ? `1px solid ${C.border}` : "none" }}>
                      <span style={{ color: l.ok ? C.green : C.red, fontSize: 13, marginTop: 1 }}>{l.ok ? "✓" : "✗"}</span>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 10, color: l.tipo === "Épico" ? C.purple : l.tipo === "Feature" ? C.accent : l.tipo === "Task (CT)" ? C.coral : C.green, marginRight: 6 }}>{l.tipo}</span>
                        <span style={{ fontSize: 12, color: C.textDim }}>{l.titulo}</span>
                        {l.id && <span style={{ fontSize: 10, color: C.muted, marginLeft: 6 }}>#{l.id}</span>}
                        {l.url && <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: C.accent, textDecoration: "none", display: "block", marginTop: 2 }}>Abrir no Azure DevOps ↗</a>}
                        {l.msg && <div style={{ fontSize: 11, color: C.red, marginTop: 2 }}>{l.msg.slice(0, 140)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {wikiLog.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <SectionLabel color={C.purple}>Documentação Wiki</SectionLabel>
                <div style={{ background: C.surface, border: `1px solid ${C.purple}20`, borderRadius: 10, padding: 14 }}>
                  {wikiLog.map((l, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 0" }}>
                      <span style={{ color: l.ok ? C.purple : C.red, fontSize: 13 }}>{l.ok ? "✓" : "✗"}</span>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 12, color: l.ok ? C.purple : C.red }}>{l.msg}</span>
                        {l.url && <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: C.accent, textDecoration: "none", display: "block", marginTop: 2 }}>Ver commit ↗</a>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button className="btn" onClick={() => setPhase(6)} style={{ background: "transparent", border: `1px solid ${C.muted}`, color: C.textDim }}>← Voltar</button>
              <button className="btn" onClick={reset} style={{ background: C.surface, border: `1px solid ${C.accent}`, color: C.accent }}>↺ Nova Análise</button>
            </div>
          </div>
        )}
      </div>

      {/* ── LuAI — assistente visual ─────────────────────────────── */}
      <LuAI phase={phase} />

      {/* ── Manual Modal ─────────────────────────────────────────── */}
      {manualOpen && (
        <div onClick={e => e.target === e.currentTarget && setManualOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div style={{ background: "#ffffff", borderRadius: 12, border: `1px solid ${C.border}`, width: "100%", maxWidth: 800, fontFamily: "'Roboto','system-ui',sans-serif", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>

            {/* Header */}
            <div style={{ padding: "18px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12, background: "#f0fdf4", borderRadius: "12px 12px 0 0" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.green }} />
              <span style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 16, color: C.textBright, flex: 1 }}>☰ Manual do Usuário</span>
              <span style={{ fontSize: 11, color: C.muted, marginRight: 8 }}>Guia completo · passo a passo</span>
              <button onClick={() => setManualOpen(false)}
                style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textDim, fontSize: 13, padding: "4px 12px", cursor: "pointer", fontFamily: "inherit" }}>
                ✕ fechar
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: "24px 28px", maxHeight: "75vh", overflowY: "auto" }}>

              {/* Visão geral */}
              <div style={{ marginBottom: 24, padding: "14px 18px", background: "#f0fdf4", border: `1px solid ${C.green}30`, borderRadius: 10 }}>
                <div style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 13, color: C.green, marginBottom: 8 }}>O que é este app?</div>
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  O <strong>Agente de Requisitos</strong> transforma documentos de texto (atas, levantamentos, especificações) em artefatos estruturados de engenharia de software — Épicos, Features/UCs, Requisitos/HUs e Casos de Teste — prontos para serem publicados no <strong>Azure DevOps</strong> e na <strong>Wiki</strong>.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {["PDF · DOCX · TXT · MD", "Modelo de Linguagem (LLM)", "Azure DevOps REST API", "Wiki Git"].map(t => (
                    <span key={t} style={{ fontSize: 10, padding: "3px 10px", borderRadius: 12, background: C.green + "15", color: C.green, fontWeight: 700 }}>{t}</span>
                  ))}
                </div>
              </div>

              {/* Pré-requisitos */}
              <FAQ_Q n="PRÉ-REQ" q="Pré-requisitos antes de começar" accent={C.accent}>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[
                    { label: "Chave Anthropic (sk-ant-...)", desc: "Obtenha em console.anthropic.com. Cole no campo API Key no canto superior direito. O ícone ✓ verde confirma que foi aceita." },
                    { label: "Documento-fonte", desc: "Qualquer arquivo PDF, DOCX, TXT ou MD com a descrição da necessidade de negócio — ata de reunião, levantamento de requisitos, especificação funcional." },
                    { label: "Dados do Azure DevOps (opcional)", desc: "Organização, Projeto, PAT (Personal Access Token) — necessários apenas nas Fases 7 (exportar work items) e 8 (publicar Wiki)." },
                  ].map(({ label, desc }) => (
                    <div key={label} style={{ display: "flex", gap: 10 }}>
                      <span style={{ color: C.accent, flexShrink: 0, fontWeight: 700 }}>▸</span>
                      <div><strong style={{ color: "#0f172a" }}>{label}</strong><br /><span style={{ color: "#475569" }}>{desc}</span></div>
                    </div>
                  ))}
                </div>
              </FAQ_Q>

              {/* Fase 0 */}
              <FAQ_Q n="FASE 0" q="Upload e tipo de documento" accent="#0284c7">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>Arraste ou clique na área de upload para carregar seu arquivo. O app lê PDF, DOCX, TXT e MD.</p>
                  <p>Escolha o <strong>Tipo de Documento</strong> de acordo com o impacto da documentação no sistema:</p>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "8px 0" }}>
                    <div style={{ flex: 1, minWidth: 200, padding: "10px 14px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8 }}>
                      <div style={{ fontWeight: 700, color: "#0369a1", marginBottom: 4 }}>COR do Sistema</div>
                      <div style={{ color: "#475569", fontSize: 11 }}>Use quando o documento <strong>impacta a arquitetura macro</strong> do sistema — mudanças estruturais, novos módulos centrais ou alterações que afetam múltiplas partes do produto.</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 200, padding: "10px 14px", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8 }}>
                      <div style={{ fontWeight: 700, color: "#7c3aed", marginBottom: 4 }}>Produto / Funcionalidade</div>
                      <div style={{ color: "#475569", fontSize: 11 }}>Use quando o documento <strong>não impacta o COR</strong> — evoluções, melhorias ou novas funcionalidades isoladas que não alteram a estrutura central do sistema.</div>
                    </div>
                  </div>
                  <div style={{ padding: "8px 12px", background: "#fefce8", border: "1px solid #fde047", borderRadius: 6, marginTop: 4 }}>
                    <strong style={{ color: "#854d0e" }}>Em ambos os casos</strong>
                    <span style={{ color: "#713f12" }}>, os artefatos gerados seguem a mesma estrutura: Épico → Feature/UC → HU → Caso de Teste. O tipo de documento apenas indica o contexto de impacto para orientar a equipe.</span>
                  </div>
                  <p>Clique em <strong>"Extrair Texto"</strong> para iniciar o processamento.</p>
                </div>
              </FAQ_Q>

              {/* Fase 1 */}
              <FAQ_Q n="FASE 1" q="Extração e resumo do documento" accent="#0284c7">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>O app divide o documento em blocos de texto, envia cada bloco ao modelo de linguagem (LLM) e gera um <strong>resumo consolidado</strong> com as informações relevantes para geração de requisitos.</p>
                  <p>Você pode <strong>editar o texto extraído</strong> antes de avançar — útil para corrigir problemas de OCR ou remover seções irrelevantes (cabeçalhos, rodapés, etc.).</p>
                  <p>Quando satisfeito, clique em <strong>"Gerar Épicos →"</strong>.</p>
                </div>
              </FAQ_Q>

              {/* Fase 2 */}
              <FAQ_Q n="FASE 2" q="Geração de Épicos" accent="#7c3aed">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>O modelo analisa o resumo e identifica as <strong>grandes áreas de negócio</strong>, cada uma gerando um Épico (ex: <em>Conciliação DDA</em>, <em>Gestão de Usuários</em>).</p>
                  <p>Para cada Épico gerado você pode:</p>
                  <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                    <li>Editar título e descrição diretamente</li>
                    <li>Adicionar uma correção no painel amarelo e clicar <strong>"Regerar com esta correção"</strong></li>
                    <li>Remover épicos irrelevantes com o botão ✕</li>
                    <li>Adicionar épicos manualmente com <strong>"+ Novo Épico"</strong></li>
                  </ul>
                  <p>Quando a lista estiver correta, clique em <strong>"Gerar Features/UCs →"</strong>.</p>
                </div>
              </FAQ_Q>

              {/* Fase 3 */}
              <FAQ_Q n="FASE 3" q="Geração de Features / Casos de Uso" accent="#0891b2">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <div style={{ padding: "8px 12px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 6, marginBottom: 10 }}>
                    <strong style={{ color: "#0369a1" }}>Feature e Caso de Uso (UC) são sempre a mesma coisa.</strong>
                    <span style={{ color: "#0c4a6e" }}> Independente do tipo de documento (COR ou Produto/Funcionalidade), os dois termos representam o mesmo conceito: <strong>uma funcionalidade</strong> do sistema descrita pela interação entre um <em>ator</em> e o <em>sistema</em>. São intercambiáveis — usamos ambos para facilitar a associação com as funcionalidades identificadas no documento-fonte.</span>
                  </div>
                  <p style={{ marginTop: 0 }}>Para cada Épico, o modelo identifica as funcionalidades e as estrutura com:</p>
                  <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                    <li><strong>Ator Principal</strong> — quem interage com o sistema (usuário, sistema externo, etc.)</li>
                    <li><strong>Pré-condição</strong> — estado necessário antes da execução</li>
                    <li><strong>Fluxo Principal</strong> — passos numerados da interação esperada entre ator e sistema</li>
                    <li><strong>Fluxo Alternativo</strong> — desvios, erros e exceções ao fluxo principal</li>
                    <li><strong>Pós-condição</strong> — estado do sistema após a execução bem-sucedida</li>
                  </ul>
                  <p>Use o <strong>painel de correção amarelo</strong> (por UC/Feature) para ajustes pontuais sem regeração completa.</p>
                  <p>Ao final, clique em <strong>"Gerar Requisitos/HUs →"</strong>.</p>
                </div>
              </FAQ_Q>

              {/* Fase 4 */}
              <FAQ_Q n="FASE 4" q="Geração de Requisitos / Histórias de Usuário" accent="#0891b2">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>Cada Feature/UC dá origem a múltiplas Histórias de Usuário com:</p>
                  <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                    <li><strong>Regras de Negócio (RN)</strong> — restrições e políticas</li>
                    <li><strong>Requisitos Funcionais (RF)</strong> — o que o sistema deve fazer</li>
                    <li><strong>Requisitos Não-Funcionais (RNF)</strong> — desempenho, segurança, usabilidade</li>
                    <li><strong>Critérios de Aceite</strong> — condições verificáveis de conclusão</li>
                  </ul>
                  <div style={{ padding: "8px 12px", background: "#fefce8", border: "1px solid #fde047", borderRadius: 6, marginTop: 8 }}>
                    <strong style={{ color: "#854d0e" }}>Painel de Auditoria de Referências:</strong>
                    <span style={{ color: "#713f12" }}> verifica automaticamente se todos os IDs de RN/RF/RNF citados nos fluxos estão definidos nas HUs e vice-versa. Lacunas aparecem em vermelho, órfãos em âmbar.</span>
                  </div>
                </div>
              </FAQ_Q>

              {/* Fase 5 */}
              <FAQ_Q n="FASE 5" q="Geração de Casos de Teste" accent="#059669">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>Para cada HU, o app gera Casos de Teste cobrindo os cenários do fluxo principal e alternativo.</p>
                  <p>Cada CT inclui: <strong>Pré-condição · Passos de Execução · Resultado Esperado · Classificação (Funcional / Não-Funcional / Regressão)</strong>.</p>
                  <p>Clique em <strong>"Revisar Tudo →"</strong> para consolidar todos os artefatos na próxima fase.</p>
                </div>
              </FAQ_Q>

              {/* Fase 6 */}
              <FAQ_Q n="FASE 6" q="Revisão consolidada" accent="#d97706">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>Visão completa de todos os artefatos gerados em ordem hierárquica: Épico → UC → HU → CT.</p>
                  <p>Você pode fazer ajustes finais em qualquer artefato antes de exportar. Use os painéis de <strong>correção amarelos</strong> para indicar alterações e regerar apenas o item afetado.</p>
                  <p>Quando aprovado, avance para <strong>"Configurar DevOps →"</strong>.</p>
                </div>
              </FAQ_Q>

              {/* Fase 7 */}
              <FAQ_Q n="FASE 7" q="Criar Itens de Trabalho no Azure DevOps (Work Items)" accent="#0369a1">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <div style={{ padding: "10px 14px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: "#1e40af", marginBottom: 6 }}>O que são itens de trabalho?</div>
                    <div style={{ color: "#1e3a5f" }}>Itens de trabalho (<em>Work Items</em>) são registros rastreáveis dentro do Azure DevOps Boards — o equivalente digital de cartões em um quadro Kanban/Scrum. Cada item tem ID único, responsável, sprint, status e histórico de alterações. São <strong>diferentes da Wiki</strong>: enquanto a Wiki é documentação estática, os work items são entidades ativas que movem o fluxo de desenvolvimento.</div>
                  </div>
                  <p style={{ marginTop: 0 }}>Preencha os campos de configuração:</p>
                  <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                    <li><strong>Organização</strong> — nome da sua org no Azure DevOps (ex: <em>minhaempresa</em>)</li>
                    <li><strong>Projeto</strong> — nome do projeto destino</li>
                    <li><strong>PAT</strong> — Personal Access Token com permissão <em>Work Items (Read &amp; Write)</em></li>
                    <li><strong>Área / Sprint</strong> — opcional, para classificar os itens no board</li>
                  </ul>
                  <p>Clique em <strong>"Exportar Work Items"</strong>. O app cria a seguinte hierarquia no Azure DevOps Boards:</p>
                  <div style={{ margin: "10px 0", padding: "12px 16px", background: "#f8faff", border: "1px solid #dde8f5", borderRadius: 8, fontFamily: "'IBM Plex Mono',monospace" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {[
                        { tipo: "Epic", cor: "#7c3aed", desc: "Área de negócio completa (ex: Conciliação DDA)" },
                        { tipo: "Feature", cor: "#0891b2", desc: "Funcionalidade / Caso de Uso do Épico pai" },
                        { tipo: "Requirement", cor: "#059669", desc: "História de Usuário (HU) vinculada à Feature" },
                        { tipo: "Task", cor: "#d97706", desc: "Caso de Teste associado ao Requirement pai" },
                      ].map(({ tipo, cor, desc }, i) => (
                        <div key={tipo} style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: i * 16 }}>
                          <span style={{ fontSize: 9, color: "#94a3b8" }}>{"└─"}</span>
                          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: cor + "18", color: cor, fontWeight: 700, flexShrink: 0 }}>{tipo}</span>
                          <span style={{ fontSize: 11, color: "#475569" }}>{desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <p>Cada item é criado via REST API com rastreabilidade automática — o Azure DevOps registra o vínculo pai/filho entre os níveis, permitindo navegar de um Epic até seus Tasks diretamente no board.</p>
                  <div style={{ padding: "8px 12px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 6, marginTop: 8 }}>
                    <strong style={{ color: "#0369a1" }}>Dica:</strong>
                    <span style={{ color: "#0c4a6e" }}> o PAT pode ser gerado em <em>Azure DevOps → User Settings → Personal Access Tokens</em>. Defina validade de 30–90 dias e escopo mínimo necessário.</span>
                  </div>
                </div>
              </FAQ_Q>

              {/* Fase 8 */}
              <FAQ_Q n="FASE 8" q="Publicar na Wiki do Azure DevOps" accent="#0369a1">
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>Após exportar os work items, clique em <strong>"Publicar Wiki"</strong> para gerar e enviar a documentação estruturada ao repositório Git da Wiki do seu projeto.</p>
                  <p>A Wiki é gerada com páginas separadas para:</p>
                  <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                    <li>Visão geral do projeto (índice de épicos)</li>
                    <li>Cada UC / Feature (com fluxos e RNs)</li>
                    <li>Cada HU (com RFs, RNFs e critérios de aceite)</li>
                    <li>Casos de Teste por UC</li>
                  </ul>
                  <p>Todos os arquivos são enviados via <strong>Git push para o repositório <code>ProjectName.wiki</code></strong> no Azure DevOps.</p>
                </div>
              </FAQ_Q>

              {/* Migração */}
              <FAQ_Q n="MIGRAÇÃO" q="Modo Migrar Documento existente" accent={C.purple}>
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>Use o botão <strong>"Migrar Documento"</strong> (fase de revisão) quando você já tem um documento de especificação existente e quer publicá-lo na Wiki sem regeração.</p>
                  <p>O app converte o conteúdo do documento para o formato Markdown da Wiki, preservando a estrutura original. Ideal para migrar especificações legadas para o Azure DevOps.</p>
                  <div style={{ padding: "8px 12px", background: "#faf5ff", border: `1px solid ${C.purple}30`, borderRadius: 6, marginTop: 8 }}>
                    <strong style={{ color: C.purple }}>Diferença chave:</strong>
                    <span style={{ color: "#4c1d95" }}> o fluxo principal gera e reestrutura os artefatos. O modo migração apenas converte e publica sem alterar o conteúdo.</span>
                  </div>
                </div>
              </FAQ_Q>

              {/* Persistência */}
              <FAQ_Q n="SESSÃO" q="Persistência e retomada de sessão" accent={C.green}>
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <p style={{ marginTop: 0 }}>Todo o estado do app é salvo automaticamente no <strong>localStorage</strong> do navegador. Se você fechar a aba ou recarregar a página, os artefatos gerados serão restaurados exatamente onde você parou.</p>
                  <p>Use <strong>"✕ limpar"</strong> no topo para iniciar uma nova análise (isso apaga o estado salvo permanentemente).</p>
                  <div style={{ padding: "8px 12px", background: "#f0fdf4", border: `1px solid ${C.green}30`, borderRadius: 6, marginTop: 8 }}>
                    <strong style={{ color: C.green }}>Atenção:</strong>
                    <span style={{ color: "#14532d" }}> a chave API NÃO é salva por segurança — você precisará reinseri-la a cada sessão.</span>
                  </div>
                </div>
              </FAQ_Q>

              {/* Limitações */}
              <FAQ_Q n="LIMITES" q="Limitações conhecidas e boas práticas" accent={C.red}>
                <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.8 }}>
                  <ul style={{ paddingLeft: 18, margin: 0 }}>
                    <li style={{ marginBottom: 6 }}><strong>Documentos grandes (&gt; 50 páginas):</strong> O processamento é feito em chunks. Documentos muito longos podem gerar mais de uma chamada à API, aumentando custo e tempo.</li>
                    <li style={{ marginBottom: 6 }}><strong>PDF com imagens:</strong> O app extrai apenas texto. Diagramas e tabelas em imagem são ignorados.</li>
                    <li style={{ marginBottom: 6 }}><strong>Rastreabilidade de origem:</strong> O elo entre cada artefato gerado e a seção exata do documento fonte ainda não é registrado automaticamente (melhoria planejada).</li>
                    <li style={{ marginBottom: 6 }}><strong>Custo da API:</strong> Cada chamada ao modelo de linguagem consome tokens cobrados pelo provedor de LLM. Para documentos grandes, use a fase de pré-resumo para reduzir os tokens enviados.</li>
                    <li><strong>Azure DevOps PAT:</strong> O token trafega no cliente. Use tokens de validade curta e revogue-os após o uso.</li>
                  </ul>
                </div>
              </FAQ_Q>

              {/* Rodapé */}
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, marginTop: 8, fontSize: 11, color: C.muted, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <span>Agente de Requisitos · Stack: React 19 + Vite + LLM API + Azure DevOps REST</span>
                <span>rafael.cotrin@ytecnologia.com</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── FAQ Modal ────────────────────────────────────────────── */}
      {faqOpen && (
        <div onClick={e => e.target === e.currentTarget && setFaqOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div style={{ background: "#ffffff", borderRadius: 12, border: `1px solid ${C.border}`, width: "100%", maxWidth: 760, fontFamily: "'Roboto','system-ui',sans-serif", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>

            {/* Modal header */}
            <div style={{ padding: "18px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12, background: "#f8fafc", borderRadius: "12px 12px 0 0" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent }} />
              <span style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 16, color: C.textBright, flex: 1 }}>FAQ — Por que trabalhamos assim?</span>
              <button onClick={() => setFaqOpen(false)}
                style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textDim, fontSize: 13, padding: "4px 12px", cursor: "pointer", fontFamily: "inherit" }}>
                ✕ fechar
              </button>
            </div>

            <div style={{ padding: "24px", color: C.text, fontSize: 13, lineHeight: 1.75 }}>

              {/* Intro */}
              <div style={{ background: "#f0f7ff", border: `1px solid ${C.accent}25`, borderRadius: 8, padding: "12px 16px", marginBottom: 24, fontSize: 12, color: C.textDim }}>
                Documento de referência para a equipe de operação, gestão e auditores de conformidade. Explica a estratégia de decomposição de documentos e sua relação com padrões de mercado.
              </div>

              {/* ── Seção 1 ── */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 14, color: C.accent, marginBottom: 16, paddingBottom: 8, borderBottom: `2px solid ${C.accent}20` }}>
                  Seção 1 — Para a Operação e Gestão
                </div>

                <FAQ_Q n="1.1" q="Por que um único documento vira tantos outros?">
                  Documentos de levantamento são escritos para <b>leitura humana</b> — misturam linguagem natural, ambiguidades e diferentes níveis de detalhe no mesmo texto. Sistemas, equipes e ferramentas como o Azure DevOps precisam de informações <b>estruturadas e separadas por propósito</b>:
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10, fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {["Artefato","Para quem","O que representa"].map(h => <th key={h} style={{ padding: "6px 10px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.textDim, fontWeight: 700, fontSize: 11 }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["Épico","Gestão / PO","Uma área de negócio completa"],
                        ["Feature / Caso de Uso","Analista / Arquiteto","Um comportamento específico do sistema"],
                        ["Requisito / História de Usuário","Desenvolvedor","O que um usuário precisa fazer e por quê"],
                        ["Caso de Teste","QA","Como verificar se o que foi pedido foi entregue"],
                      ].map(([a, b, c]) => (
                        <tr key={a} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: "6px 10px", fontWeight: 700, color: C.accent, fontSize: 12 }}>{a}</td>
                          <td style={{ padding: "6px 10px", color: C.textDim, fontSize: 12 }}>{b}</td>
                          <td style={{ padding: "6px 10px", color: C.text, fontSize: 12 }}>{c}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </FAQ_Q>

                <FAQ_Q n="1.2" q="O que significa 'rastreabilidade'?">
                  Rastreabilidade é a capacidade de responder perguntas como:
                  <ul style={{ marginTop: 8, paddingLeft: 18, color: C.textDim }}>
                    <li style={{ marginBottom: 4 }}><i>"Este requisito foi pedido por quem e está em qual documento?"</i></li>
                    <li style={{ marginBottom: 4 }}><i>"Se essa regra de negócio mudar, quais telas, testes e work items são afetados?"</i></li>
                    <li><i>"Este caso de teste cobre qual necessidade de negócio?"</i></li>
                  </ul>
                  <p style={{ marginTop: 8 }}>Sem rastreabilidade, cada mudança exige investigação manual. Com ela, o impacto de qualquer alteração pode ser mapeado rapidamente.</p>
                </FAQ_Q>

                <FAQ_Q n="1.3" q="Por que isso importa para auditorias?">
                  Organizações auditadas por certificações de qualidade (CMMI, MPS.BR, ISO) precisam evidenciar que <b>cada requisito tem origem identificável e cobertura de teste comprovada</b>. O apontamento mais comum sem isso:
                  <div style={{ background: "#fff5f5", border: `1px solid #991b1b30`, borderRadius: 6, padding: "10px 14px", margin: "10px 0", fontSize: 12, color: "#991b1b", fontStyle: "italic" }}>
                    "Não foi possível rastrear o requisito REQ-042 até uma necessidade de negócio documentada."
                  </div>
                  Esse tipo de apontamento pode bloquear homologações, certificações e contratos.
                </FAQ_Q>

                <FAQ_Q n="1.4" q="Qual é a limitação atual e o que estamos fazendo?">
                  O processo gera artefatos bem estruturados e os vincula entre si (Épico → Feature → Requisito → Teste). A limitação conhecida é que o <b>elo de volta ao documento fonte</b> (qual seção originou cada requisito) ainda não é registrado automaticamente. Isso está mapeado como melhoria planejada.
                </FAQ_Q>
              </div>

              {/* ── Seção 2 ── */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 800, fontSize: 14, color: C.purple, marginBottom: 16, paddingBottom: 8, borderBottom: `2px solid ${C.purple}20` }}>
                  Seção 2 — Para Analistas e Auditores
                </div>

                <FAQ_Q n="2.1" q="Fundamentação normativa da abordagem" accent={C.purple}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {["Norma / Framework","Requisito relevante"].map(h => <th key={h} style={{ padding: "6px 10px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.textDim, fontWeight: 700, fontSize: 11 }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["ISO/IEC/IEEE 29148:2018","Rastreabilidade bidirecional entre necessidades de stakeholders, requisitos de sistema e software"],
                        ["CMMI ML2 — REQM SP 1.4","Manter rastreabilidade bidirecional entre requisitos e produtos de trabalho"],
                        ["MPS.BR nível G — GRE","Cada requisito deve ter origem rastreável até uma necessidade de negócio documentada"],
                        ["BABOK v3","Rastreabilidade deve cobrir todo o ciclo de vida, do elicitado ao verificado"],
                        ["UML 2.5.1","Define «trace», «derive» e «refine» para relações entre artefatos de diferentes níveis de abstração"],
                      ].map(([n, r]) => (
                        <tr key={n} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: "6px 10px", fontWeight: 700, color: C.purple, fontSize: 11, whiteSpace: "nowrap" }}>{n}</td>
                          <td style={{ padding: "6px 10px", color: C.textDim, fontSize: 12 }}>{r}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </FAQ_Q>

                <FAQ_Q n="2.2" q="O que o processo implementa hoje" accent={C.purple}>
                  <div style={{ fontFamily: "monospace", fontSize: 11, background: "#f8fafc", border: `1px solid ${C.border}`, borderRadius: 6, padding: "12px 14px", color: C.textDim, lineHeight: 1.9, marginBottom: 10 }}>
                    Documento Fonte<br/>
                    {"    └── "}Épico (EP001)<br/>
                    {"            └── "}Feature / UC (FT001)<br/>
                    {"                    ├── "}Requisito / HU (REQ001, REQ002...)<br/>
                    {"                    │       └── "}Caso de Teste (CT-FT001-01, 02...)<br/>
                    {"                    ├── "}Regras de Negócio (RN-PREF-001...)<br/>
                    {"                    ├── "}Requisitos Funcionais (RF-PREF-001...)<br/>
                    {"                    └── "}Requisitos Não Funcionais (RNF-PREF-001...)
                  </div>
                  Cada artefato carrega referência ao nível acima: <code style={{ color: C.accent }}>epicId</code>, <code style={{ color: C.accent }}>ftId/ucId</code>, <code style={{ color: C.accent }}>reqId</code> e <code style={{ color: C.accent }}>origemPasso</code> nas RNs, RFs e RNFs.
                </FAQ_Q>

                <FAQ_Q n="2.3" q="Lacunas conhecidas e risco associado" accent={C.purple}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#fff5f5" }}>
                        {["Lacuna","Norma impactada","Risco"].map(h => <th key={h} style={{ padding: "6px 10px", textAlign: "left", borderBottom: `1px solid #99000020`, color: "#991b1b", fontWeight: 700, fontSize: 11 }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["Ausência de «trace» ao trecho do documento fonte","ISO 29148 §6.2.5 · CMMI REQM SP 1.4","Apontamento de rastreabilidade em auditoria ML2+"],
                        ["ID de versão do documento fonte não registrado nos artefatos","CMMI REQM SP 1.3","Impossibilidade de detectar impacto de mudanças"],
                        ["Matriz de rastreabilidade bidirecional não gerada automaticamente","MPS.BR GRE — resultado RE4","Auditoria manual necessária"],
                      ].map(([l, n, r]) => (
                        <tr key={l} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: "6px 10px", color: "#991b1b", fontSize: 11 }}>{l}</td>
                          <td style={{ padding: "6px 10px", color: C.textDim, fontSize: 11 }}>{n}</td>
                          <td style={{ padding: "6px 10px", color: C.text, fontSize: 11 }}>{r}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </FAQ_Q>

                <FAQ_Q n="2.4" q="Por que mesmo assim esta abordagem é superior ao documento único" accent={C.purple}>
                  <ul style={{ paddingLeft: 18, color: C.textDim, marginTop: 4 }}>
                    {[
                      "Não há separação de audiência — o mesmo documento precisa servir ao gestor, ao desenvolvedor e ao QA, gerando ambiguidades inevitáveis.",
                      "Não há cobertura de testes verificável — sem vínculo formal entre o que foi especificado e o que foi testado.",
                      "Não há integração com o ciclo de desenvolvimento — documento fica desconectado das ferramentas de gestão (Azure DevOps).",
                      "Mudanças são invisíveis — sem histórico de versão por artefato, apenas por documento completo.",
                    ].map((item, i) => <li key={i} style={{ marginBottom: 6, fontSize: 12 }}>{item}</li>)}
                  </ul>
                  <div style={{ background: "#f0faf4", border: `1px solid ${C.green}30`, borderRadius: 6, padding: "10px 14px", marginTop: 10, fontSize: 12, color: "#166534" }}>
                    A abordagem decomposta, mesmo com a lacuna de rastreabilidade de origem, <b>reduz substancialmente o risco operacional</b> e cria uma base auditável que um documento único nunca oferece.
                  </div>
                </FAQ_Q>

                {/* Plano de melhoria */}
                <div style={{ background: "#f8f4ff", border: `1px solid ${C.purple}25`, borderRadius: 8, padding: "14px 16px", marginTop: 8 }}>
                  <div style={{ fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 12, color: C.purple, marginBottom: 10 }}>Plano de Melhoria de Conformidade</div>
                  {[
                    "Registrar origemDocumento (arquivo, versão, seção) em cada artefato gerado",
                    "Gerar matriz de rastreabilidade bidirecional como artefato de saída",
                    "Implementar detecção de impacto: dado um documento atualizado, identificar artefatos afetados",
                    "Publicar hash SHA-256 do documento fonte junto aos artefatos (imutabilidade de origem)",
                  ].map((item, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 12 }}>
                      <span style={{ color: C.purple, flexShrink: 0 }}>☐</span>
                      <span style={{ color: C.textDim }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Referências */}
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, fontSize: 11, color: C.muted }}>
                <span style={{ fontWeight: 700, color: C.textDim }}>Referências: </span>
                ISO/IEC/IEEE 29148:2018 · CMMI for Development v2.0 — REQM · MPS.BR Guia Parte 2: Nível G · BABOK v3 Cap.6 · OMG UML 2.5.1 §7.8
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Componente: Painel de Auditoria de Referências ───────────────
function AuditPanel({ ucs, hus, onFixRef, onRemoveOrphan, onRenameOrphan, onLinkOrphanToStep, onRemoveOrphanFromUC, onRenameOrphanInUC, onEnrichRFRNF, enrichingRFRNF, onAutoVincular, onRemoveLacunaRef }) {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedOrphan, setExpandedOrphan] = useState(null);
  const [orphanNewId, setOrphanNewId] = useState("");
  const [linkStep, setLinkStep] = useState("");   // "ftId|||passo"
  const [suggestions, setSuggestions] = useState([]);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [dismissedIds, setDismissedIds] = useState(new Set());
  const audit = useMemo(() => auditarReferencias(ucs, hus), [ucs, hus]);
  const { lacunas, orfaos, definidos,
          lacunasRF, orfaosRF, definidosRF, rfByUC,
          lacunasRNF, orfaosRNF, definidosRNF, rnfByUC } = audit;
  const total = lacunas.length + orfaos.length + lacunasRF.length + orfaosRF.length + lacunasRNF.length + orfaosRNF.length;
  const totalOrfaos = orfaos.length + orfaosRF.length + orfaosRNF.length;

  const CR = "#991b1b";   // vermelho — lacunas
  const CA = "#92400e";   // âmbar   — órfãos
  const CG = "#166534";   // verde   — tudo OK
  const CI = "#6d28d9";   // índigo  — IA

  const borderColor = lacunas.length ? CR + "40" : orfaos.length ? CA + "40" : CG + "30";
  const bg          = lacunas.length ? "#fff5f5" : orfaos.length ? "#fffbf0" : "#f0faf4";

  const semRFGlobal  = ucs.every(u => !(u.requisitosFuncionais    || []).length);
  const semRNFGlobal = ucs.every(u => !(u.requisitosNaoFuncionais || []).length);
  // Sempre visível quando há UCs — permite re-gerar após mudança de prompt ou correção
  const showEnrichBtn = ucs.length > 0;

  const handleResolverOrfaos = async () => {
    if (resolving) return;
    setResolving(true);
    setResolveError("");
    setSuggestions([]);
    setDismissedIds(new Set());
    try {
      const orfaosRNInfo = orfaos.map(id => {
        const rn = hus.flatMap(h => h.regrasNegocio || []).find(r => r.id === id);
        return { id, nome: rn?.nome || "", descricao: rn?.descricao || "", tipo: "RN" };
      });
      const orfaosRFInfo = orfaosRF.map(id => {
        const item = ucs.flatMap(u => u.requisitosFuncionais || []).find(r => r.id === id);
        return { id, descricao: item?.descricao || "", tipo: "RF", ownerFtId: rfByUC.get(id) };
      });
      const orfaosRNFInfo = orfaosRNF.map(id => {
        const item = ucs.flatMap(u => u.requisitosNaoFuncionais || []).find(r => r.id === id);
        return { id, descricao: item?.descricao || "", tipo: "RNF", ownerFtId: rnfByUC.get(id) };
      });
      const allOrfaosInfo = [...orfaosRNInfo, ...orfaosRFInfo, ...orfaosRNFInfo];
      const allLacunas = [...lacunas, ...lacunasRF, ...lacunasRNF];
      const result = await resolverOrfaosIA(allOrfaosInfo, allLacunas, ucs);
      // Enriquece sugestões com tipo/ownerFtId — órfãos pelo mapa, lacunas pelo ID
      const enriched = result.map(sug => {
        const info = allOrfaosInfo.find(o => o.id === sug.rnId);
        const isLacuna = !info && allLacunas.some(l => l.id === sug.rnId);
        const tipo = info?.tipo || (isLacuna ? "LACUNA" : null);
        return { ...sug, tipo, ownerFtId: info?.ownerFtId || null };
      });
      setSuggestions(enriched);
    } catch (e) {
      setResolveError(e.message);
    } finally {
      setResolving(false);
    }
  };

  const applySuggestion = (sug) => {
    const { tipo, ownerFtId } = sug;
    if (!tipo) return;
    if (sug.acao === "renomear" && sug.novoId) {
      if (tipo === "RN")  onRenameOrphan(sug.rnId, sug.novoId);
      if (tipo === "RF")  onRenameOrphanInUC(ownerFtId, "requisitosFuncionais",    sug.rnId, sug.novoId);
      if (tipo === "RNF") onRenameOrphanInUC(ownerFtId, "requisitosNaoFuncionais", sug.rnId, sug.novoId);
    } else if (sug.acao === "vincular" && sug.ftId && sug.passo) {
      onLinkOrphanToStep(sug.rnId, sug.ftId, String(sug.passo));
    } else if (sug.acao === "remover") {
      if (tipo === "RN")  onRemoveOrphan(sug.rnId);
      if (tipo === "RF")  onRemoveOrphanFromUC(ownerFtId, "requisitosFuncionais",    sug.rnId);
      if (tipo === "RNF") onRemoveOrphanFromUC(ownerFtId, "requisitosNaoFuncionais", sug.rnId);
    } else if (sug.acao === "remover_ref") {
      onRemoveLacunaRef(sug.rnId);
    }
    setDismissedIds(prev => new Set([...prev, sug.rnId]));
  };

  const applyAll = () => {
    suggestions.filter(s => !dismissedIds.has(s.rnId)).forEach(applySuggestion);
    setSuggestions([]);
  };

  const pendingSuggestions = suggestions.filter(s => !dismissedIds.has(s.rnId));
  const acaoBadge = { renomear: { label: "renomear", bg: "#fef3c7", color: "#92400e" }, vincular: { label: "vincular", bg: "#ede9fe", color: "#6d28d9" }, remover: { label: "remover", bg: "#fee2e2", color: "#991b1b" }, remover_ref: { label: "remover ref", bg: "#fde8d8", color: "#9a3412" } };

  return (
    <div style={{ marginBottom: 16, border: `1px solid ${borderColor}`, borderRadius: 8, overflow: "hidden", background: bg }}>
      {/* Header */}
      <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <div onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: total > 0 ? (lacunas.length ? CR : CA) : CG }}>
            AUDITORIA DE REFERÊNCIAS
          </span>
          {lacunas.length > 0 && (
            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: CR + "18", color: CR, fontWeight: 700 }}>
              {lacunas.length} lacuna{lacunas.length > 1 ? "s" : ""}
            </span>
          )}
          {orfaos.length > 0 && (
            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: CA + "18", color: CA, fontWeight: 700 }}>
              {orfaos.length} órfão{orfaos.length > 1 ? "s" : ""}
            </span>
          )}
          {total === 0 && (
            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: CG + "18", color: CG, fontWeight: 700 }}>✓ OK</span>
          )}
          <span style={{ fontSize: 9, color: "#94a3b8" }}>{open ? "▲" : "▼"}</span>
        </div>
        {/* Botão Auto-vincular — vincula RNs com origemPasso sem IA */}
        {ucs.length > 0 && (
          <button
            onClick={() => { onAutoVincular(); if (!open) setOpen(true); }}
            title={totalOrfaos > 0 ? "Vincula automaticamente RNs com origemPasso preenchido — sem IA" : "Re-executar auto-vinculação via origemPasso"}
            style={{
              fontSize: 10, padding: "4px 12px", borderRadius: 5, flexShrink: 0,
              border: "1px solid #0369a1", color: "#0369a1",
              background: "#f0f9ff", cursor: "pointer", fontWeight: 600,
            }}>
            ⚡ Auto-vincular
          </button>
        )}
        {/* Botão Resolver Órfãos com IA — visível quando há UCs */}
        {ucs.length > 0 && (
          <button
            onClick={() => { if (!open) setOpen(true); handleResolverOrfaos(); }}
            disabled={resolving}
            title={totalOrfaos > 0 ? "Usar IA para sugerir vinculação dos órfãos sem origemPasso" : "Re-executar análise de órfãos com IA"}
            style={{
              fontSize: 10, padding: "4px 12px", borderRadius: 5, flexShrink: 0,
              border: `1px solid ${CI}`, color: resolving ? "#94a3b8" : CI,
              background: resolving ? "#f1f5f9" : "#f5f3ff",
              cursor: resolving ? "not-allowed" : "pointer", fontWeight: 600,
            }}>
            {resolving ? "⏳ Analisando…" : "✦ Resolver com IA"}
          </button>
        )}
        {/* Botão RF/RNF — visível mesmo com o painel fechado */}
        {showEnrichBtn && (
          <button
            onClick={onEnrichRFRNF}
            disabled={enrichingRFRNF}
            title={semRFGlobal && semRNFGlobal ? "Nenhum RF/RNF extraído — clique para gerar" : "Re-gerar RF/RNF consolidados por épico"}
            style={{
              fontSize: 10, padding: "4px 12px", borderRadius: 5, flexShrink: 0,
              border: "1px solid #0369a1", color: enrichingRFRNF ? "#94a3b8" : "#0369a1",
              background: enrichingRFRNF ? "#f1f5f9" : "#f0f9ff",
              cursor: enrichingRFRNF ? "not-allowed" : "pointer", fontWeight: 600,
            }}>
            {enrichingRFRNF ? "⏳ Extraindo…" : "✦ Enriquecer RF/RNF"}
          </button>
        )}
      </div>

      {open && (
        <div style={{ borderTop: "1px solid #e2e8f0", padding: "12px 14px" }}>

          {/* ── Sugestões da IA ── */}
          {resolveError && (
            <div style={{ fontSize: 11, color: CR, background: "#fff5f5", border: `1px solid ${CR}30`, borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}>
              Erro ao consultar IA: {resolveError}
            </div>
          )}
          {pendingSuggestions.length > 0 && (
            <div style={{ marginBottom: 16, border: `1px solid ${CI}30`, borderRadius: 7, overflow: "hidden", background: "#faf5ff" }}>
              <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${CI}20` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: CI, letterSpacing: "0.06em", flex: 1 }}>
                  SUGESTÕES DA IA — {pendingSuggestions.length} órfão{pendingSuggestions.length > 1 ? "s" : ""} analisado{pendingSuggestions.length > 1 ? "s" : ""}
                </span>
                <button
                  onClick={applyAll}
                  style={{ fontSize: 10, padding: "4px 14px", borderRadius: 4, border: `1px solid ${CI}60`, color: CI, background: "#ede9fe", cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>
                  Aplicar Todos
                </button>
                <button
                  onClick={() => setSuggestions([])}
                  style={{ fontSize: 10, padding: "4px 10px", borderRadius: 4, border: "1px solid #cbd5e1", color: "#64748b", background: "transparent", cursor: "pointer", flexShrink: 0 }}>
                  Descartar
                </button>
              </div>
              {pendingSuggestions.map(sug => {
                const badge = acaoBadge[sug.acao] || acaoBadge.remover;
                return (
                  <div key={sug.rnId} style={{ padding: "8px 12px", borderBottom: `1px solid ${CI}10`, display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: CA, fontFamily: "monospace" }}>{sug.rnId}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: badge.bg, color: badge.color, letterSpacing: "0.05em" }}>{badge.label}</span>
                        {sug.acao === "renomear" && sug.novoId && (
                          <span style={{ fontSize: 10, color: "#166534", fontFamily: "monospace" }}>→ {sug.novoId}</span>
                        )}
                        {sug.acao === "vincular" && sug.ftId && (
                          <span style={{ fontSize: 10, color: CI, fontFamily: "monospace" }}>→ {sug.ftId} FP-{sug.passo}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: "#64748b" }}>{sug.motivo}</div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                      <button
                        onClick={() => applySuggestion(sug)}
                        style={{ fontSize: 10, padding: "3px 10px", borderRadius: 4, border: `1px solid ${CI}50`, color: CI, background: "#ede9fe", cursor: "pointer", fontWeight: 600 }}>
                        Aplicar
                      </button>
                      <button
                        onClick={() => setDismissedIds(prev => new Set([...prev, sug.rnId]))}
                        style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #cbd5e1", color: "#94a3b8", background: "transparent", cursor: "pointer" }}>
                        Ignorar
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Lacunas ── */}
          {lacunas.length > 0 && (
            <div style={{ marginBottom: orfaos.length > 0 ? 16 : 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: CR, marginBottom: 8, letterSpacing: "0.06em" }}>
                LACUNAS — referências sem definição ({lacunas.length})
              </div>
              {lacunas.map(({ id, ocorrencias }) => {
                const isEx = expandedId === id;
                return (
                  <div key={id} style={{ border: `1px solid ${CR}25`, borderRadius: 6, marginBottom: 6, overflow: "hidden" }}>
                    {/* Cabeçalho da lacuna */}
                    <div onClick={() => setExpandedId(isEx ? null : id)}
                      style={{ padding: "7px 12px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", background: isEx ? CR + "08" : "transparent" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: CR, fontFamily: "monospace" }}>{id}</span>
                      <span style={{ fontSize: 10, color: "#64748b" }}>
                        {ocorrencias.length} ocorrência{ocorrencias.length > 1 ? "s" : ""}
                      </span>
                      <span style={{ marginLeft: "auto", fontSize: 9, color: "#94a3b8" }}>{isEx ? "▲" : "▼"}</span>
                    </div>
                    {/* Lista de ocorrências + controles */}
                    {isEx && (
                      <div style={{ padding: "8px 12px 10px", borderTop: `1px solid ${CR}15` }}>
                        {ocorrencias.map((oc, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 0", borderBottom: i < ocorrencias.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#0369a1", marginBottom: 3 }}>
                                {oc.ftId} / FP-{oc.passo}
                                <span style={{ fontSize: 9, color: "#94a3b8", marginLeft: 6 }}>({oc.fonte})</span>
                              </div>
                              <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.4 }}>
                                {(oc.descricao || "").slice(0, 90)}{(oc.descricao || "").length > 90 ? "…" : ""}
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                              {/* Remapear para RN existente */}
                              <select
                                defaultValue=""
                                onChange={e => { if (e.target.value) { onFixRef(oc.ftId, oc.passo, id, e.target.value); e.target.value = ""; } }}
                                style={{ fontSize: 10, padding: "3px 6px", borderRadius: 4, border: "1px solid #cbd5e1", color: "#334155", background: "#f8fafc", cursor: "pointer", maxWidth: 180 }}>
                                <option value="">↔ remapear para...</option>
                                {[...definidos].sort().map(rnId => (
                                  <option key={rnId} value={rnId}>{rnId}</option>
                                ))}
                              </select>
                              {/* Remover referência */}
                              <button
                                onClick={() => onFixRef(oc.ftId, oc.passo, id, null)}
                                title="Remove esta referência do passo"
                                style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: `1px solid ${CR}40`, color: CR, background: "transparent", cursor: "pointer" }}>
                                ✕ remover
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Órfãos ── */}
          {orfaos.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: CA, marginBottom: 8, letterSpacing: "0.06em" }}>
                ÓRFÃOS — definidos mas nunca referenciados ({orfaos.length})
              </div>
              {orfaos.map(id => {
                const rn = hus.flatMap(h => h.regrasNegocio || []).find(r => r.id === id);
                const isOrEx = expandedOrphan === id;
                // Todos os passos disponíveis para vincular
                const allSteps = ucs.flatMap(uc =>
                  (uc.fluxoPrincipal || []).map(p => ({
                    value: `${uc.ftId}|||${p.passo}`,
                    label: `${uc.ftId} — ${(uc.titulo || "").slice(0, 28)} / FP-${p.passo}`,
                  }))
                );
                const matchesLacuna = lacunas.some(l => l.id === orphanNewId.trim());
                return (
                  <div key={id} style={{ border: `1px solid ${CA}25`, borderRadius: 6, marginBottom: 6, overflow: "hidden" }}>
                    {/* ── Cabeçalho ── */}
                    <div
                      onClick={() => { setExpandedOrphan(isOrEx ? null : id); setOrphanNewId(id); setLinkStep(""); }}
                      style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: isOrEx ? CA + "08" : "transparent" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: CA, fontFamily: "monospace", marginRight: 8 }}>{id}</span>
                        {rn?.nome && <span style={{ fontSize: 10, color: "#64748b" }}>{rn.nome}</span>}
                        {rn?.descricao && (
                          <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                            {rn.descricao.slice(0, 90)}{rn.descricao.length > 90 ? "…" : ""}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); onRemoveOrphan(id); }}
                        title="Remove esta regra de todas as HUs"
                        style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: `1px solid ${CA}40`, color: CA, background: "transparent", cursor: "pointer", flexShrink: 0 }}>
                        Remover
                      </button>
                      <span style={{ fontSize: 9, color: "#94a3b8", flexShrink: 0 }}>{isOrEx ? "▲" : "▼ ajustar"}</span>
                    </div>

                    {/* ── Painel de ajuste ── */}
                    {isOrEx && (
                      <div style={{ padding: "10px 12px 12px", borderTop: `1px solid ${CA}15`, background: "#fffdf5" }}>

                        {/* Renomear ID */}
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: CA, letterSpacing: "0.07em", marginBottom: 6 }}>RENOMEAR ID</div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input
                              value={orphanNewId}
                              onChange={e => setOrphanNewId(e.target.value.toUpperCase())}
                              style={{ flex: 1, fontSize: 11, padding: "4px 8px", borderRadius: 4, border: `1px solid ${matchesLacuna ? "#166534" : "#cbd5e1"}`, fontFamily: "monospace", outline: "none", background: matchesLacuna ? "#f0fdf4" : "#fff" }}
                            />
                            <button
                              disabled={!orphanNewId.trim() || orphanNewId.trim() === id}
                              onClick={() => { onRenameOrphan(id, orphanNewId.trim()); setExpandedOrphan(null); }}
                              style={{ fontSize: 10, padding: "4px 12px", borderRadius: 4, border: `1px solid ${CA}60`, color: CA, background: "transparent", cursor: orphanNewId.trim() && orphanNewId.trim() !== id ? "pointer" : "not-allowed", opacity: orphanNewId.trim() && orphanNewId.trim() !== id ? 1 : 0.4, flexShrink: 0 }}>
                              Confirmar
                            </button>
                          </div>
                          {matchesLacuna && (
                            <div style={{ fontSize: 10, color: "#166534", marginTop: 4 }}>
                              ✓ Corresponde a uma lacuna — renomear vai resolver as duas inconsistências.
                            </div>
                          )}
                        </div>

                        {/* Vincular a passo */}
                        <div>
                          <div style={{ fontSize: 9, fontWeight: 700, color: CA, letterSpacing: "0.07em", marginBottom: 6 }}>VINCULAR A UM PASSO</div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <select
                              value={linkStep}
                              onChange={e => setLinkStep(e.target.value)}
                              style={{ flex: 1, fontSize: 10, padding: "4px 6px", borderRadius: 4, border: "1px solid #cbd5e1", color: "#334155", background: "#f8fafc", cursor: "pointer" }}>
                              <option value="">Selecione UC / passo...</option>
                              {allSteps.map(({ value, label }) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                            <button
                              disabled={!linkStep}
                              onClick={() => {
                                if (!linkStep) return;
                                const [ftId, passo] = linkStep.split("|||");
                                onLinkOrphanToStep(id, ftId, passo);
                                setLinkStep("");
                                setExpandedOrphan(null);
                              }}
                              style={{ fontSize: 10, padding: "4px 12px", borderRadius: 4, border: `1px solid ${CA}60`, color: CA, background: "transparent", cursor: linkStep ? "pointer" : "not-allowed", opacity: linkStep ? 1 : 0.4, flexShrink: 0 }}>
                              Vincular
                            </button>
                          </div>
                        </div>

                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── RF e RNF (reutiliza a mesma lógica de exibição) ── */}
          {[
            { label: "RF", color: "#0369a1", lacunas: lacunasRF, orfaos: orfaosRF, definidos: definidosRF, byUC: rfByUC, field: "requisitosFuncionais",    getItem: (id) => ucs.flatMap(u => u.requisitosFuncionais    || []).find(r => r.id === id) },
            { label: "RNF", color: "#0f766e", lacunas: lacunasRNF, orfaos: orfaosRNF, definidos: definidosRNF, byUC: rnfByUC, field: "requisitosNaoFuncionais", getItem: (id) => ucs.flatMap(u => u.requisitosNaoFuncionais || []).find(r => r.id === id) },
          ].map(({ label, color, lacunas: lacs, orfaos: orfs, definidos: defs, byUC, field, getItem }) => {
            if (!lacs.length && !orfs.length) return null;
            return (
              <div key={label} style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 8, letterSpacing: "0.06em" }}>
                  {label} — {lacs.length > 0 && <span style={{ color: CR }}>{lacs.length} lacuna{lacs.length > 1 ? "s" : ""}  </span>}
                  {orfs.length > 0 && <span style={{ color: CA }}>{orfs.length} órfão{orfs.length > 1 ? "s" : ""}</span>}
                </div>

                {/* Lacunas RF/RNF */}
                {lacs.map(({ id, ocorrencias }) => {
                  const isEx = expandedId === `${label}:${id}`;
                  return (
                    <div key={id} style={{ border: `1px solid ${CR}25`, borderRadius: 6, marginBottom: 6, overflow: "hidden" }}>
                      <div onClick={() => setExpandedId(isEx ? null : `${label}:${id}`)}
                        style={{ padding: "7px 12px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", background: isEx ? CR + "08" : "transparent" }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: CR, fontFamily: "monospace" }}>{id}</span>
                        <span style={{ fontSize: 10, color: "#64748b" }}>{ocorrencias.length} ocorrência{ocorrencias.length > 1 ? "s" : ""}</span>
                        <span style={{ marginLeft: "auto", fontSize: 9, color: "#94a3b8" }}>{isEx ? "▲" : "▼"}</span>
                      </div>
                      {isEx && (
                        <div style={{ padding: "8px 12px 10px", borderTop: `1px solid ${CR}15` }}>
                          {ocorrencias.map((oc, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 0", borderBottom: i < ocorrencias.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 10, fontFamily: "monospace", color: color, marginBottom: 3 }}>{oc.ftId} / FP-{oc.passo} <span style={{ fontSize: 9, color: "#94a3b8" }}>({oc.fonte})</span></div>
                                <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.4 }}>{(oc.descricao || "").slice(0, 90)}{(oc.descricao || "").length > 90 ? "…" : ""}</div>
                              </div>
                              <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                                <select defaultValue="" onChange={e => { if (e.target.value) { onFixRef(oc.ftId, oc.passo, id, e.target.value); e.target.value = ""; } }}
                                  style={{ fontSize: 10, padding: "3px 6px", borderRadius: 4, border: "1px solid #cbd5e1", color: "#334155", background: "#f8fafc", cursor: "pointer", maxWidth: 180 }}>
                                  <option value="">↔ remapear para...</option>
                                  {[...defs].sort().map(rnId => <option key={rnId} value={rnId}>{rnId}</option>)}
                                </select>
                                <button onClick={() => onFixRef(oc.ftId, oc.passo, id, null)}
                                  style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: `1px solid ${CR}40`, color: CR, background: "transparent", cursor: "pointer" }}>
                                  ✕ remover
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Órfãos RF/RNF */}
                {orfs.map(id => {
                  const item = getItem(id);
                  const ownerFtId = byUC.get(id);
                  const isOrEx = expandedOrphan === `${label}:${id}`;
                  const matchesLacuna = [...(label === "RF" ? lacunasRF : lacunasRNF)].some(l => l.id === orphanNewId.trim());
                  const allSteps = ucs.flatMap(uc => (uc.fluxoPrincipal || []).map(p => ({ value: `${uc.ftId}|||${p.passo}`, label: `${uc.ftId} — ${(uc.titulo || "").slice(0, 28)} / FP-${p.passo}` })));
                  return (
                    <div key={id} style={{ border: `1px solid ${CA}25`, borderRadius: 6, marginBottom: 5, overflow: "hidden" }}>
                      <div onClick={() => { setExpandedOrphan(isOrEx ? null : `${label}:${id}`); setOrphanNewId(id); setLinkStep(""); }}
                        style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: isOrEx ? CA + "08" : "transparent" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: CA, fontFamily: "monospace", marginRight: 8 }}>{id}</span>
                          {item?.categoria && <span style={{ fontSize: 10, color: "#64748b" }}>{item.categoria}</span>}
                          {item?.descricao && <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>{item.descricao.slice(0, 90)}{item.descricao.length > 90 ? "…" : ""}</div>}
                        </div>
                        <button onClick={e => { e.stopPropagation(); onRemoveOrphanFromUC(ownerFtId, field, id); }}
                          style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: `1px solid ${CA}40`, color: CA, background: "transparent", cursor: "pointer", flexShrink: 0 }}>
                          Remover
                        </button>
                        <span style={{ fontSize: 9, color: "#94a3b8", flexShrink: 0 }}>{isOrEx ? "▲" : "▼ ajustar"}</span>
                      </div>
                      {isOrEx && (
                        <div style={{ padding: "10px 12px 12px", borderTop: `1px solid ${CA}15`, background: "#fffdf5" }}>
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, color: CA, letterSpacing: "0.07em", marginBottom: 6 }}>RENOMEAR ID</div>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input value={orphanNewId} onChange={e => setOrphanNewId(e.target.value.toUpperCase())}
                                style={{ flex: 1, fontSize: 11, padding: "4px 8px", borderRadius: 4, border: `1px solid ${matchesLacuna ? "#166534" : "#cbd5e1"}`, fontFamily: "monospace", outline: "none", background: matchesLacuna ? "#f0fdf4" : "#fff" }} />
                              <button disabled={!orphanNewId.trim() || orphanNewId.trim() === id}
                                onClick={() => { onRenameOrphanInUC(ownerFtId, field, id, orphanNewId.trim()); setExpandedOrphan(null); }}
                                style={{ fontSize: 10, padding: "4px 12px", borderRadius: 4, border: `1px solid ${CA}60`, color: CA, background: "transparent", cursor: orphanNewId.trim() && orphanNewId.trim() !== id ? "pointer" : "not-allowed", opacity: orphanNewId.trim() && orphanNewId.trim() !== id ? 1 : 0.4, flexShrink: 0 }}>
                                Confirmar
                              </button>
                            </div>
                            {matchesLacuna && <div style={{ fontSize: 10, color: "#166534", marginTop: 4 }}>✓ Corresponde a uma lacuna — renomear vai resolver as duas inconsistências.</div>}
                          </div>
                          <div>
                            <div style={{ fontSize: 9, fontWeight: 700, color: CA, letterSpacing: "0.07em", marginBottom: 6 }}>VINCULAR A UM PASSO</div>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <select value={linkStep} onChange={e => setLinkStep(e.target.value)}
                                style={{ flex: 1, fontSize: 10, padding: "4px 6px", borderRadius: 4, border: "1px solid #cbd5e1", color: "#334155", background: "#f8fafc", cursor: "pointer" }}>
                                <option value="">Selecione UC / passo...</option>
                                {allSteps.map(({ value, label: l }) => <option key={value} value={value}>{l}</option>)}
                              </select>
                              <button disabled={!linkStep} onClick={() => { if (!linkStep) return; const [ftId, passo] = linkStep.split("|||"); onLinkOrphanToStep(id, ftId, passo); setLinkStep(""); setExpandedOrphan(null); }}
                                style={{ fontSize: 10, padding: "4px 12px", borderRadius: 4, border: `1px solid ${CA}60`, color: CA, background: "transparent", cursor: linkStep ? "pointer" : "not-allowed", opacity: linkStep ? 1 : 0.4, flexShrink: 0 }}>
                                Vincular
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {total === 0 && (
            <div style={{ fontSize: 12, color: CG, textAlign: "center", padding: "8px 0" }}>
              Todas as referências estão definidas e utilizadas.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Componente: Azure DevOps Work Item Preview ──────────────────
function DevOpsWorkItem({ type, typeColor, title, description, acceptanceCriteria, tags }) {
  const [tab, setTab] = useState("desc");
  const tabs = [
    { key: "desc", label: "Descrição" },
    ...(acceptanceCriteria ? [{ key: "ac", label: "Critérios de Aceite" }] : []),
    ...(tags?.length ? [{ key: "tags", label: `Tags (${tags.length})` }] : []),
  ];
  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      {/* Work Item header mock */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10, padding: "10px 12px", background: "#f8faff", border: `1px solid ${typeColor}25`, borderRadius: 6 }}>
        <div style={{ width: 3, minHeight: 28, borderRadius: 2, background: typeColor, flexShrink: 0, alignSelf: "stretch" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: typeColor + "18", color: typeColor, fontWeight: 700, letterSpacing: "0.05em", flexShrink: 0 }}>{type}</span>
            <span style={{ fontSize: 10, color: "#64748b" }}>Azure DevOps · Boards</span>
          </div>
          <div style={{ fontSize: 13, color: "#0f172a", fontWeight: 600, lineHeight: 1.4 }}>{title}</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #dde8f5", marginBottom: 0 }}>
        {tabs.map(({ key, label }) => (
          <button key={key} className="devops-tab"
            onClick={() => setTab(key)}
            style={{ color: tab === key ? typeColor : "#4a6070", borderBottomColor: tab === key ? typeColor : "transparent" }}>
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="devops-html-preview" style={{ background: "#f9fbff", border: "1px solid #dde8f5", borderTop: "none", borderRadius: "0 0 7px 7px", padding: "12px 14px", maxHeight: 300, overflowY: "auto", fontSize: 12, lineHeight: 1.7 }}>
        {tab === "desc" && (
          description
            ? <div dangerouslySetInnerHTML={{ __html: description }} />
            : <em style={{ color: "#3a4a5a" }}>Sem descrição.</em>
        )}
        {tab === "ac" && (
          acceptanceCriteria
            ? <div dangerouslySetInnerHTML={{ __html: acceptanceCriteria }} />
            : <em style={{ color: "#3a4a5a" }}>Sem critérios definidos.</em>
        )}
        {tab === "tags" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 0" }}>
            {(tags || []).map((t, i) => <span key={i} className="devops-tag">{t}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Componente: LuAI — assistente visual fixo ───────────────────
const LUAI_TIPS = [
  "Olá! Sou o Lu, seu assistente. Carregue um documento PDF, DOCX, TXT ou MD para começarmos!",
  "Documento carregado! Revise o texto extraído e clique em Gerar Épicos quando estiver pronto.",
  "Épicos gerados! Verifique se as grandes áreas de negócio fazem sentido antes de continuar.",
  "Features e Casos de Uso prontos! Confira os fluxos principal e alternativo de cada UC.",
  "Requisitos gerados! Olha o painel de Auditoria — se tiver alertas em vermelho, vale corrigir.",
  "Casos de Teste criados! Garanta que cada requisito tem pelo menos um CT de cobertura.",
  "Revisão completa! Tudo aprovado? Então é hora de ir para o Azure DevOps!",
  "Configure sua organização e PAT do Azure DevOps e exporte os work items.",
];

function LuAI({ phase }) {
  const [visible, setVisible]   = useState(true);
  const [bubble,  setBubble]    = useState(true);
  const [waving,  setWaving]    = useState(false);
  const tip = LUAI_TIPS[Math.min(phase, LUAI_TIPS.length - 1)];

  // Reexibe o balão sempre que a fase muda
  useEffect(() => {
    setBubble(true);
    setWaving(true);
    const t = setTimeout(() => setWaving(false), 1200);
    return () => clearTimeout(t);
  }, [phase]);

  if (!visible) return (
    <button
      onClick={() => { setVisible(true); setBubble(true); }}
      title="Chamar Lu"
      style={{ position: "fixed", bottom: 20, right: 20, zIndex: 900, width: 44, height: 44, borderRadius: "50%", border: "2px solid #39ADE3", background: "#fff", cursor: "pointer", fontSize: 20, boxShadow: "0 4px 16px #00366C22", transition: "all .2s" }}>
      🙂
    </button>
  );

  return (
    <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 900, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10, pointerEvents: "none" }}>

      {/* Balão de dica */}
      {bubble && (
        <div style={{ pointerEvents: "auto", maxWidth: 240, background: "#FFFFFF", border: "1px solid #E8ECF5", borderRadius: "12px 12px 4px 12px", padding: "12px 14px", boxShadow: "0 4px 20px #00366C18", position: "relative", animation: "luSlide .3s ease" }}>
          <button
            onClick={() => setBubble(false)}
            style={{ position: "absolute", top: 6, right: 8, background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#94a3b8", lineHeight: 1, pointerEvents: "auto" }}>✕</button>
          <div style={{ fontFamily: "'Roboto',sans-serif", fontSize: 12, color: "#444762", lineHeight: 1.6, paddingRight: 14 }}>
            {tip}
          </div>
          <div style={{ marginTop: 8, fontSize: 10, fontFamily: "'Manrope',sans-serif", fontWeight: 700, color: "#39ADE3", letterSpacing: "0.06em" }}>LU · ASSISTENTE</div>
        </div>
      )}

      {/* Avatar */}
      <div style={{ pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <div
          onClick={() => setBubble(b => !b)}
          title={bubble ? "Fechar dica" : "Ver dica"}
          style={{
            width: 134, height: 134, borderRadius: "50%",
            overflow: "hidden", cursor: "pointer",
            border: "3px solid #39ADE3",
            background: "#14243a",
            boxShadow: "0 4px 20px #00366C30",
            position: "relative",
            animation: waving ? "luWave .6s ease 2" : "luFloat 3s ease-in-out infinite",
            transition: "transform .2s",
          }}>
          <img src="/luai.jpg" alt="Lu — Assistente" style={{ width: "100%", height: "100%", objectFit: "contain", transform: "scale(1.4)" }} />
        </div>
        <button
          onClick={() => setVisible(false)}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#94a3b8", fontFamily: "'Roboto',sans-serif", padding: 0 }}>
          minimizar
        </button>
      </div>

      <style>{`
        @keyframes luFloat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
        @keyframes luWave  { 0%,100%{transform:rotate(0deg)} 25%{transform:rotate(-8deg)} 75%{transform:rotate(8deg)} }
        @keyframes luSlide { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
      `}</style>
    </div>
  );
}

function FAQ_Q({ n, q, children, accent = "#0369a1" }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 14, border: "1px solid #e8ecf5", borderRadius: 8, overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer", background: open ? accent + "06" : "#fafbfd" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: accent, fontFamily: "'Manrope',sans-serif", flexShrink: 0 }}>{n}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#334155", flex: 1 }}>{q}</span>
        <span style={{ fontSize: 9, color: "#94a3b8" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ padding: "12px 14px", borderTop: "1px solid #e8ecf5", fontSize: 12, color: "#475569", lineHeight: 1.75, background: "#ffffff" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children, color }) {
  return (
    <div style={{ fontSize: 10, color: color || "#1e2a40", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 2, height: 10, borderRadius: 1, background: color || "#1e2a40", flexShrink: 0 }} />
      {children}
    </div>
  );
}

function CorrectionPanel({ value, onChange, onRegenerate, loading, label }) {
  const C_amber = "#fbbf24";
  return (
    <div style={{ background: "#fffbf0", border: `1px solid ${C_amber}50`, borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: C_amber + "cc", fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        <span style={{ width: 2, height: 10, borderRadius: 1, background: C_amber, flexShrink: 0, display: "inline-block" }} />
        {label}
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Ex: Separar o épico X em dois. Renomear UC de Manter Veículo para Cadastrar Veículo. Adicionar RN sobre prazo máximo..."
        rows={2}
        style={{ width: "100%", background: "#fff9e8", border: `1px solid ${value ? C_amber : "#e8d8a0"}`, borderRadius: 6, color: "#7c4a0a", padding: "9px 12px", fontFamily: "inherit", fontSize: 12, outline: "none", resize: "vertical", lineHeight: 1.6, transition: "border-color .15s" }}
      />
      <button
        onClick={onRegenerate}
        disabled={loading || !value.trim()}
        style={{ marginTop: 8, cursor: value.trim() && !loading ? "pointer" : "not-allowed", opacity: value.trim() && !loading ? 1 : 0.35, background: value.trim() ? "#100b00" : "transparent", border: `1px solid ${C_amber}60`, color: C_amber, borderRadius: 7, fontFamily: "'Manrope',sans-serif", fontWeight: 700, fontSize: 12, padding: "8px 18px", transition: "all .15s", display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span>↺</span> {loading ? "Regerando..." : "Regerar com esta correção"}
      </button>
    </div>
  );
}
