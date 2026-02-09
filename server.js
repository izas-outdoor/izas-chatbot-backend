/* ==========================================================================
   🚀 SERVIDOR IZAS OUTDOOR CHATBOT (MASTER VERSION)
   ========================================================================== */

import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from "fs";
import cors from "cors";
import { COLOR_CONCEPTS, CONCEPTS } from "./concepts.js"; 
import { createClient } from "@supabase/supabase-js";

/* --- 🏢 INFORMACIÓN DE MARCA --- */
const BRAND_INFO = `
SOBRE IZAS OUTDOOR:
Somos una marca especializada en ropa de montaña, trekking y outdoor.
Nuestra filosofía es ofrecer la máxima calidad y tecnología a precios accesibles.

TECNOLOGÍAS CLAVE:
- Mount-Loft: Fibras ultraligeras con propiedades térmicas similares a la pluma, pero resistentes al agua.
- AWPS (All Weather Protection System): Membranas cortavientos e impermeables transpirables.
- Dry: Tejidos que expulsan el sudor y secan rápido.
- Softshell: Tejido tricapa que combina capa exterior repelente, membrana cortavientos e interior térmico.

DISTRIBUCIÓN Y VENTA:
- Web oficial (catálogo completo).
- Decathlon, Amazon, Sprinter, El Corte Inglés, Tiendas físicas.

CALIDAD: Costuras termoselladas y patrones ergonómicos.
`;

/* --- ⚙️ CONFIGURACIÓN --- */
const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors({ origin: "*" }));
app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


/* ==========================================================================
   🛠️ HELPERS
   ========================================================================== */
function includesWord(q, word) { const w = ` ${word.toLowerCase()} `; return q.includes(w); }

function colorVariants(base) {
  const variants = [base];
  if (base.endsWith("o")) { variants.push(base.replace(/o$/, "a"), base + "s", base.replace(/o$/, "os"), base.replace(/o$/, "as")); }
  else if (base.endsWith("z")) { variants.push(base.replace(/z$/, "ces")); }
  else if (/[aeiouáéíóú]$/i.test(base)) { variants.push(base + "s"); }
  else { variants.push(base + "es"); }
  return variants.filter(Boolean);
}

function normalizeQuery(query) {
  let q = ` ${query.toLowerCase()} `;
  Object.values(CONCEPTS).forEach(concept => {
    for (const match of concept.matches) { if (includesWord(q, match)) { q += ` ${concept.canonical}`; break; } }
    if (includesWord(q, concept.canonical)) q += " " + concept.matches.join(" ");
  });
  Object.values(COLOR_CONCEPTS).forEach(color => {
    const variants = colorVariants(color.canonical);
    if (variants.some(v => includesWord(q, v))) q += " " + color.matches.join(" ") + " ";
  });
  
  // Normalización de Tallas (XXL -> 2XL)
  q = q.replace(/\b(xxl|xxxl|xxxxl)\b/gi, match => {
      const m = match.toLowerCase();
      if (m === 'xxl') return '2xl';
      if (m === 'xxxl') return '3xl';
      if (m === 'xxxxl') return '4xl';
      return match;
  });

  return q;
}

function cleanText(text) {
  if (!text) return "Sin información";
  return text.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim().substring(0, 600);
}

function cosineSimilarity(a, b) { return a.reduce((acc, val, i) => acc + val * b[i], 0); }
function safeParse(value) { try { return JSON.parse(value); } catch { return value; } }

/* ==========================================================================
   🛍️ CONEXIÓN SHOPIFY
   ========================================================================== */
async function fetchGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: "POST", headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  return json.data;
}

async function getAllProducts() {
  let hasNextPage = true, cursor = null; const products = [];
  const query = `query getProducts($cursor: String) { products(first: 50, after: $cursor, query: "status:active") { pageInfo { hasNextPage } edges { cursor node { id title description productType tags handle images(first: 1) { edges { node { url } } } descriptionHtml options { name values } variants(first: 100) { edges { node { id title price availableForSale inventoryQuantity selectedOptions { name value } } } } metafields(first: 20) { edges { node { namespace key value } } } } } } }`;
  while (hasNextPage) {
    const data = await fetchGraphQL(query, { cursor });
    if (!data?.products) break;
    data.products.edges.forEach(({ node }) => {
      const variantsClean = node.variants.edges.map(v => ({ id: (v.node.id || "").split("/").pop(), title: v.node.title, price: v.node.price, image: v.node.image?.url || "", availableForSale: v.node.availableForSale, inventoryQuantity: v.node.inventoryQuantity, selectedOptions: v.node.selectedOptions }));
      products.push({ id: node.id.split("/").pop(), title: node.title, handle: node.handle, description: node.description, body_html: node.descriptionHtml, productType: node.productType, price: node.variants.edges[0]?.node.price || "Consultar", tags: node.tags, image: node.images.edges[0]?.node.url || "", options: node.options.map(o => ({ name: o.name, values: o.values })), variants: variantsClean, metafields: Object.fromEntries(node.metafields.edges.map(m => [`${m.node.namespace}.${m.node.key}`, safeParse(m.node.value)])) });
    });
    hasNextPage = data.products.pageInfo.hasNextPage; if (hasNextPage) cursor = data.products.edges[data.products.edges.length - 1].cursor;
  }
  return products;
}

// ⚡ LIVE STOCK CHECK: Actualiza el stock de productos específicos en tiempo real
async function getLiveStockForProducts(products) {
    if (!products || products.length === 0) return products;
    console.log("⚡ Actualizando stock en tiempo real para", products.length, "productos...");
    const productIds = products.map(p => `gid://shopify/Product/${p.id}`);

    const query = `
    query getNodes($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          variants(first: 100) {
            edges {
              node {
                id
                title
                inventoryQuantity
                availableForSale
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
    `;

    try {
        const data = await fetchGraphQL(query, { ids: productIds });
        if (!data || !data.nodes) return products;

        return products.map(p => {
            const freshNode = data.nodes.find(n => n && n.id.endsWith(`/${p.id}`));
            if (!freshNode) return p; 

            const freshVariants = freshNode.variants.edges.map(v => ({
                id: v.node.id.split("/").pop(),
                title: v.node.title,
                price: p.variants.find(oldV => oldV.id === v.node.id.split("/").pop())?.price || "Consultar",
                image: p.variants.find(oldV => oldV.id === v.node.id.split("/").pop())?.image || "",
                inventoryQuantity: v.node.inventoryQuantity,
                availableForSale: v.node.availableForSale,
                selectedOptions: v.node.selectedOptions
            }));
            return { ...p, variants: freshVariants };
        });
    } catch (error) {
        console.error("❌ Error actualizando stock live:", error);
        return products; 
    }
}

async function getOrderStatus(orderId, userEmail) {
  const cleanId = orderId.replace("#", "").trim();
  const query = `query getOrder($query: String!) { orders(first: 1, query: $query) { nodes { name email displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } fulfillments { trackingInfo { number url company } } lineItems(first: 10) { edges { node { title quantity } } } } } }`;
  try {
    const data = await fetchGraphQL(query, { query: `name:${cleanId}` });
    if (!data?.orders?.nodes?.length) return { found: false, reason: "not_found" };
    const order = data.orders.nodes[0];
    if (order.email.toLowerCase().trim() !== userEmail.toLowerCase().trim()) return { found: false, reason: "email_mismatch" };
    
    const tracking = order.fulfillments?.[0]?.trackingInfo?.[0];
    let carrier = tracking?.company || (order.displayFulfillmentStatus === "UNFULFILLED" ? "Pendiente" : "Agencia");
    let trackingUrl = tracking?.url || null;
    if (carrier === "0002") carrier = "Correos Express";
    if (carrier === "0003") { carrier = "DHL"; if (tracking?.number) trackingUrl = `https://www.dhl.com/es-es/home/tracking.html?tracking-id=${tracking.number}&submit=1`; }
    
    return { found: true, data: { id: order.name, status: order.displayFulfillmentStatus, trackingNumber: tracking?.number || "N/A", trackingUrl, carrier, items: order.lineItems.edges.map(e => `${e.node.quantity}x ${e.node.title}`).join(", "), price: order.totalPriceSet?.shopMoney?.amount } };
  } catch { return { found: false, reason: "error" }; }
}

/* ==========================================================================
   🤖 CEREBRO IA
   ========================================================================== */
let aiIndex = [], faqIndex = [];
const INDEX_FILE = "./ai-index.json", FAQ_FILE = "./faqs.json";
function buildAIText(p) { return `TIPO: ${p.productType}\nTITULO: ${p.title}\nDESC: ${p.description}\nTAGS: ${p.tags.join(", ")}`; }

async function loadIndexes() {
  if (fs.existsSync(INDEX_FILE)) try { aiIndex = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); } catch {}
  if (!aiIndex.length) {
    console.log("🤖 Indexando productos...");
    const products = await getAllProducts();
    for (const p of products) { const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: buildAIText(p) }); aiIndex.push({ ...p, embedding: emb.data[0].embedding }); }
    try { fs.writeFileSync(INDEX_FILE, JSON.stringify(aiIndex)); } catch {}
  }
  if (fs.existsSync(FAQ_FILE)) {
    const rawFaqs = JSON.parse(fs.readFileSync(FAQ_FILE, "utf8")); faqIndex = [];
    for (const f of rawFaqs) { const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: f.question }); faqIndex.push({ ...f, embedding: emb.data[0].embedding }); }
  }
  console.log(`✅ Cerebro listo: ${aiIndex.length} productos, ${faqIndex.length} FAQs`);
}

async function refineQuery(userQuery, history) {
  const response = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: `Eres un experto en búsquedas eCommerce. Contexto histórico es clave. Si busca "Naluns", busca SOLO el nombre principal.` }, ...history.slice(-4), { role: "user", content: userQuery }], temperature: 0 });
  return response.choices[0].message.content;
}

function formatStockForAI(variants) {
  if (!variants?.length) return "Sin info stock.";
  const stock = {};
  variants.forEach(v => {
    if (v.availableForSale && v.inventoryQuantity > 0) {
      let color = "Único", size = "Única";
      v.selectedOptions?.forEach(o => { if (o.name.match(/color|cor/i)) color = o.value; if (o.name.match(/talla|size/i)) size = o.value; });
      if (!stock[color]) stock[color] = [];
      stock[color].push(v.inventoryQuantity <= 2 ? `${size} (¡últimas!)` : size);
    }
  });
  return Object.entries(stock).map(([c, s]) => `- ${c}: ${s.join(", ")}`).join("\n") || "Agotado";
}

/* ==========================================================================
   🧠 CORE AI (ENDPOINT PRINCIPAL)
   ========================================================================== */
app.post("/api/ai/search", async (req, res) => {
  const { q, history, visible_ids, session_id } = req.body;
  if (!q) return res.status(400).json({ error: "Falta query" });

  try {
    // 1. Detección Pedidos
    let emailMatch = q.match(/[\w.-]+@[\w.-]+\.\w+/), orderMatch = q.match(/#?(\d{4,})/);
    if ((!emailMatch || !orderMatch) && history) {
      const hText = [...history].reverse().map(h => h.content).join(" ");
      if (!emailMatch) emailMatch = hText.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (!orderMatch) orderMatch = hText.match(/#?(\d{4,})/);
    }
    let orderData = null, securityWarning = null;
    if (orderMatch && emailMatch) {
      const res = await getOrderStatus(orderMatch[1], emailMatch[0]);
      orderData = res.found ? `[DATOS_ENCONTRADOS]\nID:${res.data.id}\nESTADO:${res.data.status}\nTRACK:${res.data.trackingNumber}\nLINK:${res.data.trackingUrl}` : "❌ Error pedido.";
    } else if (orderMatch) securityWarning = "FALTA_EMAIL"; else if (emailMatch) securityWarning = "FALTA_PEDIDO_ID";

    // 2. Búsqueda
    const normalizedQuery = normalizeQuery(q); 
    const optimizedQuery = await refineQuery(normalizedQuery, history || []);
    if (!aiIndex.length) await loadIndexes();

    const embResponse = await openai.embeddings.create({ model: "text-embedding-3-large", input: optimizedQuery });
    const vector = embResponse.data[0].embedding;

    const versionMatch = optimizedQuery.match(/\b(v\d+|ii|iii)\b/i);
    const targetVersion = versionMatch ? versionMatch[0].toLowerCase() : null;

    const searchResults = aiIndex.map(p => {
      let score = cosineSimilarity(vector, p.embedding);
      const titleLower = p.title.toLowerCase();
      const queryLower = optimizedQuery.toLowerCase().trim();
      if (queryLower.split(" ").some(kw => kw.length > 3 && titleLower.includes(kw))) score += 0.3;
      if (targetVersion) score += titleLower.includes(targetVersion) ? 0.4 : -0.3;
      return { ...p, score };
    }).sort((a, b) => b.score - a.score).slice(0, 8);

    const faqResults = faqIndex.map(f => ({ ...f, score: cosineSimilarity(vector, f.embedding) })).sort((a, b) => b.score - a.score).slice(0, 2);

    const combinedCandidates = new Map();
    if (visible_ids) aiIndex.filter(p => visible_ids.map(String).includes(String(p.id))).forEach(p => combinedCandidates.set(String(p.id), p));
    searchResults.forEach(p => { if (combinedCandidates.size < 10) combinedCandidates.set(String(p.id), p); });
    
    let finalCandidatesList = Array.from(combinedCandidates.values());

    // 🔥 LIVE STOCK: Actualizamos datos con Shopify antes de dárselos a GPT
    finalCandidatesList = await getLiveStockForProducts(finalCandidatesList);

    const productsContext = finalCandidatesList.map(p => `PRODUCTO: ID:${p.id} Título:${p.title} Precio:${p.price} Stock:${formatStockForAI(p.variants)}`).join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.1,
      messages: [
        { role: "system", content: `Eres el asistente de Izas Outdoor. Reglas: 1. Recomienda web oficial. 2. Stock breve. 3. JSON: { "reply": "...", "products": [...] } DATOS: ${securityWarning || "OK"} PEDIDO: ${orderData || "N/A"} PRODS: ${productsContext} BRAND: ${BRAND_INFO}` },
        ...(history || []).slice(-2), { role: "user", content: q }
      ]
    });

    const rawContent = completion.choices[0].message.content;
    console.log("RAW OPENAI RESPONSE:", rawContent);

    // ---------------------------------------------------------
    // 4. 🖼️ PROCESADO FINAL BLINDADO (SANITIZACIÓN)
    // ---------------------------------------------------------
    function extractJSON(str) {
        const first = str.indexOf('{');
        const last = str.lastIndexOf('}');
        if (first !== -1 && last !== -1) {
            return JSON.parse(str.substring(first, last + 1));
        }
        return JSON.parse(str); 
    }

    let aiContent;
    try {
        aiContent = extractJSON(rawContent);
    } catch (err) {
        console.error("❌ ERROR PARSEANDO JSON:", err);
        aiContent = { reply: "He encontrado estos productos:", products: [], category: "ERROR_JSON" };
    }

    const finalProducts = (aiContent.products || []).map(aiProd => {
        const targetId = typeof aiProd === 'object' ? aiProd.id : aiProd;
        const original = finalCandidatesList.find(p => String(p.id) === String(targetId));
        
        if (!original) return null;

        // SANITIZACIÓN
        const safeProduct = {
            ...original,
            title: original.title || "Producto Izas",
            price: original.price || "0.00",
            image: original.image || "https://cdn.shopify.com/s/files/1/0000/0000/t/1/assets/no-image.jpg",
            variants: original.variants || [],
            options: original.options || []
        };

        let displayImage = safeProduct.image;
        let displayUrlParams = "";
        
        if (typeof aiProd === 'object' && aiProd.variant_id && safeProduct.variants.length > 0) {
            const v = safeProduct.variants.find(v => String(v.id) === String(aiProd.variant_id));
            if (v) { 
                if (v.image) displayImage = v.image; 
                displayUrlParams = `?variant=${v.id}`; 
            }
        }
        
        return { ...safeProduct, displayImage, displayUrlParams };
    }).filter(Boolean);

    // ---------------------------------------------------------
    // 5. 💾 GUARDADO EN SUPABASE
    // ---------------------------------------------------------
    let enrichedReply = aiContent.reply;
    if (finalProducts.length > 0) {
        const productNames = finalProducts.map(p => p.title).join(", ");
        enrichedReply += `\n[CONTEXTO SISTEMA: Productos mostrados: ${productNames}]`;
    }

    const currentSessionId = session_id || "anonimo";
    
    // Recuperar historial previo si existe
    const fullHistory = [...(history || [])];
    fullHistory.push({ role: "user", content: q });
    fullHistory.push({ role: "assistant", content: enrichedReply });

    supabase.from('chat_sessions').upsert({
      session_id: currentSessionId,
      conversation: fullHistory,
      category: aiContent.category || "GENERAL", updated_at: new Date()
    }, { onConflict: 'session_id' }).then(({ error }) => { if (error) console.error("Error Supabase:", error); });

    res.json({ text: aiContent.reply, products: finalProducts, isSizeContext: /talla|guia/i.test(q) });

  } catch (error) { console.error("ERROR:", error); res.status(500).json({ error: "Error interno" }); }
});

app.listen(PORT, async () => { console.log(`🚀 Server en ${PORT}`); await loadIndexes(); });

/* ==========================================================================
   📝 ENDPOINT PARA GUARDAR LOGS MANUALES (Feedback, Botones, etc.)
   ========================================================================== */
app.post("/api/chat/log", async (req, res) => {
  const { session_id, role, content } = req.body;
  if (!session_id || !role || !content) return res.status(400).json({ error: "Faltan datos" });

  try {
    const { data: session } = await supabase.from('chat_sessions').select('conversation').eq('session_id', session_id).single();
    let history = session && session.conversation ? session.conversation : [];
    history.push({ role: role, content: content, timestamp: new Date() });
    const { error } = await supabase.from('chat_sessions').upsert({ session_id: session_id, conversation: history, updated_at: new Date() });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: "Error interno" }); }
});
