import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from "fs";
import cors from "cors";
import { COLOR_CONCEPTS, CONCEPTS } from "./concepts.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: "*", // en producción lo cerramos
}));
app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------------- Query helpers ---------------- */

function includesWord(q, word) {
  const w = ` ${word.toLowerCase()} `;
  return q.includes(w);
}


function colorVariants(base) {
  const variants = [base];

  // Plural
  if (base.endsWith("o")) {
    variants.push(base.replace(/o$/, "a"));    // femenino singular
    variants.push(base + "s");                 // masculino plural
    variants.push(base.replace(/o$/, "os"));   // masculino plural (igual que anterior)
    variants.push(base.replace(/o$/, "as"));   // femenino plural
  } else if (base.endsWith("z")) {
    variants.push(base.replace(/z$/, "ces"));  // plural especial
  } else if (/[aeiouáéíóú]$/i.test(base)) {
    variants.push(base + "s");                 // plural regular con vocal final
  } else {
    variants.push(base + "es");                // plural consonante irregular
  }

  return variants.filter(Boolean);
}

/* ---------------- Query normalizer ---------------- */

function normalizeQuery(query) {
  let q = ` ${query.toLowerCase()} `;

  /* --------- CONCEPTOS DE PRODUCTO --------- */

  Object.values(CONCEPTS).forEach(concept => {
    // 1. Si el usuario escribe un sinónimo → añadir canonical
    for (const match of concept.matches) {
      if (includesWord(q, match)) {
        q += ` ${concept.canonical}`;
        break;
      }
    }

    // 2. Si el canonical está presente → añadir variantes
    if (includesWord(q, concept.canonical)) {
      q += " " + concept.matches.join(" ");
    }
  });

  /* --------- COLORES --------- */

  Object.values(COLOR_CONCEPTS).forEach(color => {
    const variants = colorVariants(color.canonical);

    if (variants.some(v => includesWord(q, v))) {
      q += " " + color.matches.join(" ") + " ";
    }
  });

  return q;
}

/* ---------------- GraphQL helper ---------------- */

async function fetchGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) console.error("❌ GraphQL Error:", json.errors);
  return json.data;
}

/* ---------------- Helpers ---------------- */

function safeParse(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function metafieldToText(key, value) {
  const label = key.replace("custom.", "").replaceAll("_", " ");

  if (Array.isArray(value)) return `${label}: ${value.join(", ")}`;
  if (typeof value === "object") return `${label}: ${JSON.stringify(value)}`;

  return `${label}: ${value}`;
}

/* ---------------- Products fetch ---------------- */

async function getAllProducts() {
  let hasNextPage = true;
  let cursor = null;
  const products = [];

  const query = `
    query getProducts($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            id title description productType tags handle
            images(first: 1) { edges { node { url } } }
            body_html
            
            # --- RECUPERAMOS LAS OPCIONES (Aquí están los colores limpios) ---
            options {
              name
              values
            }
            
            variants(first: 50) {
              edges { node { id title price image { url } } }
            }
            metafields(first: 20) { edges { node { namespace key value } } }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const data = await fetchGraphQL(query, { cursor });
    const edges = data.products.edges;

    edges.forEach(({ node }) => {
      const cleanId = node.id.split("/").pop();

      const variantsClean = node.variants.edges.map(v => ({
        id: v.node.id.split("/").pop(),
        title: v.node.title,
        price: v.node.price,
        image: v.node.image?.url || "",
      }));

      products.push({
        id: cleanId,
        title: node.title,
        handle: node.handle,
        description: node.description,
        body_html: node.body_html, // AÑADIDO PARA TENER MÁS INFO
        productType: node.productType,
        price: node.variants.edges[0]?.node.price || "Consultar",
        tags: node.tags,
        image: node.images.edges[0]?.node.url || "",

        // --- GUARDAMOS LAS OPCIONES ---
        options: node.options.map(o => ({ name: o.name, values: o.values })),

        variants: variantsClean,
        metafields: Object.fromEntries(
          node.metafields.edges.map(m => [`${m.node.namespace}.${m.node.key}`, safeParse(m.node.value)])
        ),
      });
    });

    hasNextPage = data.products.pageInfo.hasNextPage;
    if (hasNextPage) cursor = edges[edges.length - 1].cursor;
  }
  return products;
}

/* ---------------- AI INDEX ---------------- */
let aiIndex = [];
let faqIndex = [];
const INDEX_FILE = "./ai-index.json";
const FAQ_FILE = "./faqs.json";

function buildAIText(product) {
  return `TIPO: ${product.productType}\nTITULO: ${product.title}\nDESC: ${product.description}\nTAGS: ${product.tags.join(", ")}`;
}

async function loadIndexes() {
  // 1. Productos
  if (fs.existsSync(INDEX_FILE)) {
    console.log("📦 Cargando productos desde caché...");
    aiIndex = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } else {
    console.log("🤖 Indexando productos en Shopify (esto puede tardar)...");
    const products = await getAllProducts();
    for (const p of products) {
      const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: buildAIText(p) });
      aiIndex.push({ ...p, embedding: emb.data[0].embedding });
    }
    fs.writeFileSync(INDEX_FILE, JSON.stringify(aiIndex));
  }
  console.log(`✅ Productos listos: ${aiIndex.length}`);

  // 2. FAQs
  if (fs.existsSync(FAQ_FILE)) {
    const rawFaqs = JSON.parse(fs.readFileSync(FAQ_FILE, "utf8"));
    faqIndex = [];
    console.log("🤖 Indexando FAQs...");
    for (const f of rawFaqs) {
      const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: f.question });
      faqIndex.push({ ...f, embedding: emb.data[0].embedding });
    }
    console.log(`✅ FAQs listas: ${faqIndex.length}`);
  }
}

/* --- Helper de refinamiento --- */
async function refineQuery(userQuery, history) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Eres un experto en entender el contexto de una conversación de compras.
        
        TU OBJETIVO:
        Traducir lo que dice el usuario a una búsqueda clara para una base de datos vectorial.

        REGLAS DE CONTEXTO:
        1. Mira el último mensaje del ASISTENTE en el historial. ¿Mencionó algún producto específico?
        2. Si el usuario hace una pregunta de seguimiento (ej: "¿qué colores tiene?", "¿y en rosa?", "¿es impermeable?"), DEBES incluir el NOMBRE DEL PRODUCTO en tu traducción.
        3. Si el usuario dice solo colores (ej: "están en negro y rosa"), asume que se refiere al producto anterior y genera: "chaqueta [Nombre] color negro y rosa".
        `
      },
      ...history.slice(-4), 
      { role: "user", content: userQuery }
    ],
    temperature: 0
  });
  return response.choices[0].message.content;
}

/* ---------------- Similarity ---------------- */

function cosineSimilarity(a, b) {
  return a.reduce((acc, val, i) => acc + val * b[i], 0); 
}

// --- LIMPIEZA DE TEXTO (NUEVO) ---
function cleanText(text) {
  if (!text) return "Sin información";
  return text
    .replace(/<[^>]*>?/gm, " ") // Elimina HTML
    .replace(/\s+/g, " ")       // Elimina espacios extra
    .trim()
    .substring(0, 600);         // Limita longitud
}

/* --- ENDPOINT PRINCIPAL (MODIFICADO CON MEMORIA VISUAL) --- */
app.post("/api/ai/search", async (req, res) => {
  const { q, history, visible_ids } = req.body; // <--- ACEPTAMOS visible_ids
  if (!q) return res.status(400).json({ error: "Falta query" });

  try {
    const optimizedQuery = await refineQuery(q, history || []);

    if (aiIndex.length === 0) await loadIndexes();

    // 1. RECUPERAR PRODUCTOS VISIBLES (MEMORIA VISUAL)
    let contextProducts = [];
    if (visible_ids && visible_ids.length > 0) {
      contextProducts = aiIndex.filter(p => visible_ids.map(String).includes(String(p.id)));
    }

    // 2. EMBEDDING
    const embResponse = await openai.embeddings.create({ model: "text-embedding-3-large", input: optimizedQuery });
    const vector = embResponse.data[0].embedding;

    // 3. BÚSQUEDA VECTORIAL (NUEVOS CANDIDATOS)
    const searchResults = aiIndex
      .map(p => ({ ...p, score: cosineSimilarity(vector, p.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    // 4. COMBINAR: PRIORIDAD A LO VISIBLE
    const combinedCandidates = new Map();

    // Primero añadimos los que ya está viendo (Contexto fuerte)
    contextProducts.forEach(p => combinedCandidates.set(String(p.id), p));

    // Luego rellenamos con la búsqueda nueva hasta tener máx 10
    searchResults.forEach(p => {
      if (combinedCandidates.size < 10) {
        combinedCandidates.set(String(p.id), p);
      }
    });

    const finalCandidatesList = Array.from(combinedCandidates.values());

    // 5. FAQs
    const faqResults = faqIndex
      .map(f => ({ ...f, score: cosineSimilarity(vector, f.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    // 6. PREPARACIÓN DE CONTEXTO (Usando cleanText y marcando visibles)
    const productsContext = finalCandidatesList.map(p => {
        const colorOption = p.options ? p.options.find(o => o.name.match(/color|cor/i)) : null;
        const officialColors = colorOption ? colorOption.values.join(", ") : "Único";
        const cleanDescription = cleanText(p.body_html || p.description);
        const cleanSpecs = p.metafields ? JSON.stringify(p.metafields) : "Sin especificaciones";
        
        // Marcamos si el producto está visible actualmente para que la IA lo sepa
        const isVisible = visible_ids && visible_ids.map(String).includes(String(p.id)) ? "(EN PANTALLA)" : "";

        return `
        PRODUCTO ${isVisible}:
        - ID: ${p.id}
        - Título: ${p.title}
        - Precio: ${p.price} €
        - Colores: ${officialColors}
        - Descripción: ${cleanDescription}
        - Specs: ${cleanSpecs}
        `;
    }).join("\n\n");

    // 7. IA CEREBRO TOTAL
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Eres un asistente experto de Izas.
              
              CONTEXTO ACTUAL:
              El usuario está viendo estos productos: ${visible_ids ? visible_ids.length : 0} productos.
              Si te pide "diferencias", "cuál es mejor" o detalles, REFIÉRETE PRINCIPALMENTE A LOS PRODUCTOS MARCADOS COMO "(EN PANTALLA)" en la lista de abajo, a menos que la pregunta sea claramente una búsqueda nueva.

              TU MISIÓN:
              Analiza la intención. Decide si busca PRODUCTOS (Escaparate) o INFORMACIÓN (Detalles/Comparar).

              MODO A: ESCAPARATE / BUSCADOR
              (Ej: "Quiero chaqueta", "Enséñame algo para hombre")
              - JSON "reply": Frase de introducción breve con nombres de productos.
              - JSON "products": [Lista de IDs].
              - PROHIBIDO EN MODO A: No pongas precios ni specs en el texto.

              MODO B: INFORMACIÓN / DETALLES / PRECIOS
              (Ej: "¿Cuánto cuesta?", "¿Qué colores tiene?", "¿Diferencias?", "¿Cuál es mejor?")
              - JSON "reply": Responde a la pregunta exacta usando los datos de abajo. Si compara, usa las descripciones y specs.
              - JSON "products": [] (Vacío, para no repetir tarjetas).
              - REGLA: Si pregunta PRECIO o COLORES, DILO.
              
              Responde SOLO JSON:
              {
                "reply": "Texto...",
                "products": [ { "id": "ID" } ]
              }
              
              CONTEXTO FAQs:
              ${faqResults.map(f => `- P: ${f.question} | R: ${f.answer}`).join("\n")}
              
              CANDIDATOS PRODUCTOS (Data Source):
              ${productsContext}
              `
        },
        ...history.slice(-2).map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: q }
      ]
    });

    const aiContent = JSON.parse(completion.choices[0].message.content);

    // 8. PROCESAMIENTO ROBUSTO DE IDs (Soporta strings y objetos)
    const seenIds = new Set(); 

    const finalProducts = (aiContent.products || []).map(aiProd => {
      // Manejamos si la IA devuelve ID directo o objeto {id: ...}
      const targetId = typeof aiProd === 'object' ? aiProd.id : aiProd;
      
      const original = finalCandidatesList.find(p => String(p.id) === String(targetId));

      if (!original || seenIds.has(original.id)) return null;

      seenIds.add(original.id);

      let displayImage = original.image;
      let displayUrlParams = "";

      if (typeof aiProd === 'object' && aiProd.variant_id && original.variants) {
        const variantData = original.variants.find(v => String(v.id) === String(aiProd.variant_id));
        if (variantData) {
          if (variantData.image) displayImage = variantData.image;
          displayUrlParams = `?variant=${variantData.id}`;
        }
      }

      return {
        ...original,
        displayImage,
        displayUrlParams
      };
    }).filter(Boolean);

    res.json({ products: finalProducts, text: aiContent.reply });

  } catch (error) {
    console.error("❌ ERROR:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

/* ---------------- Start ---------------- */
app.listen(PORT, async () => {
  console.log(`🚀 Server en http://localhost:${PORT}`);
  await loadIndexes();
});