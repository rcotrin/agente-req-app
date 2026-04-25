// ────────────────────────────────────────────────────────────────────────────
// RAG local — embeddings OpenAI + busca por similaridade cosseno no browser
// Modelo: text-embedding-3-small (1536 dims, barato, rápido)
// Proxy: /openai → https://api.openai.com (vite.config + vercel.json)
// ────────────────────────────────────────────────────────────────────────────

const EMBED_MODEL = "text-embedding-3-small";
const CHUNK_WORDS = 300;   // ~400 tokens por chunk (safe para input)
const CHUNK_OVERLAP = 50;  // sobreposição para não cortar contexto

// Divide texto em chunks com sobreposição
function chunkText(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += CHUNK_WORDS - CHUNK_OVERLAP) {
    const slice = words.slice(i, i + CHUNK_WORDS).join(" ");
    if (slice.length > 80) chunks.push(slice); // ignora chunks minúsculos
  }
  return chunks;
}

// Gera embeddings via OpenAI (batch de até 100 textos por chamada)
async function fetchEmbeddings(texts, apiKey) {
  const res = await fetch("/openai/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI embeddings ${res.status}: ${err?.error?.message || res.statusText}`);
  }
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

// Similaridade cosseno entre dois vetores
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Constrói o índice: chunks + seus embeddings
// Retorna: [{ text, embedding }]
export async function buildIndex(normalizedText, apiKey, onProgress) {
  const chunks = chunkText(normalizedText);
  if (!chunks.length) return [];

  onProgress?.(`Gerando embeddings para ${chunks.length} trechos do documento…`);

  // OpenAI aceita até 2048 textos por request, mas limitamos a 100 para segurança
  const BATCH = 100;
  const allEmbeddings = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const embeddings = await fetchEmbeddings(batch, apiKey);
    allEmbeddings.push(...embeddings);
    if (chunks.length > BATCH)
      onProgress?.(`Embeddings: ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }

  return chunks.map((text, i) => ({ text, embedding: allEmbeddings[i] }));
}

// Busca os top-k chunks mais similares à query
// Retorna: string com os trechos concatenados (pronto para injetar no prompt)
export async function queryIndex(index, queryText, apiKey, topK = 5) {
  if (!index?.length) return "";
  const [qEmbed] = await fetchEmbeddings([queryText], apiKey);
  const ranked = index
    .map(item => ({ text: item.text, score: cosineSim(item.embedding, qEmbed) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return ranked.map(r => r.text).join("\n\n---\n\n");
}
