import express from "express";
import "dotenv/config";
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from "fs";
import cors from "cors";
import { COLOR_CONCEPTS, CONCEPTS } from "./concepts.js";
import { createClient } from "@supabase/supabase-js";

/* --- INFORMACIÓN DE MARCA (CEREBRO FIJO) --- */
/* --- INFORMACIÓN DE MARCA (CEREBRO FIJO) --- */
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
- Vendemos principalmente en nuestra web oficial (donde está todo el catálogo y mejores ofertas).
- También tenemos presencia en Marketplaces como Decathlon, Amazon, Sprinter y El Corte Inglés.
- Tiendas físicas propias y distribuidores autorizados.

CALIDAD:
Usamos costuras termoselladas en prendas impermeables y patrones ergonómicos para la libertad de movimiento.
`;
const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
          id 
          title 
          description 
          productType 
          tags 
          handle
          images(first: 1) { edges { node { url } } }
          descriptionHtml 
          
          # Opciones generales del producto (ej: ["Color", "Talla"])
          options {
            name
            values
          }
          
          # --- DATOS EN TIEMPO REAL: Tallas, Colores, Stock y Precio ---
          variants(first: 50) {
            edges {
              node {
                id
                title
                price # <-- NUEVO: Precio de esta talla/color
                availableForSale
                inventoryQuantity
                selectedOptions { # <-- NUEVO: Separa limpiamente el color y la talla
                  name
                  value
                }
              }
            }
          }
          
          metafields(first: 20) { edges { node { namespace key value } } }
        }
      }
    }
  }
  `;

  while (hasNextPage) {
    const data = await fetchGraphQL(query, { cursor });

    // Si hay error en la query, data será null y romperá aquí.
    if (!data || !data.products) {
      console.error("❌ Error grave recuperando productos. Revisa los permisos de Shopify.");
      break;
    }

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

        // Mapeamos descriptionHtml a body_html para mantener compatibilidad con tu código de limpieza
        body_html: node.descriptionHtml,

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

/* ---------------- ORDER HELPER CON CORRECCIÓN DE LINKS ---------------- */
async function getOrderStatus(orderId, userEmail) {
  const cleanId = orderId.replace("#", "").trim();

  const query = `
    query getOrder($query: String!) {
      orders(first: 1, query: $query) {
        nodes {
          name
          email
          displayFulfillmentStatus
          
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          
          fulfillments(first: 3) {
            trackingInfo(first: 1) {
              number
              url
              company
            }
          }
          
          lineItems(first: 5) {
            edges {
              node {
                title
                quantity
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await fetchGraphQL(query, { query: `name:${cleanId}` });

    if (!data || !data.orders || data.orders.nodes.length === 0) {
      return { found: false, reason: "not_found" };
    }

    const order = data.orders.nodes[0];

    if (order.email.toLowerCase().trim() !== userEmail.toLowerCase().trim()) {
      return { found: false, reason: "email_mismatch" };
    }

    const tracking = order.fulfillments[0]?.trackingInfo[0];
    const items = order.lineItems.edges.map(e => `${e.node.quantity}x ${e.node.title}`).join(", ");
    const price = order.totalPriceSet?.shopMoney?.amount || "";

    // --- LOGICA DE TRANSPORTISTAS Y LINKS ---
    let carrierName = tracking?.company || "Empresa de transporte";
    let finalTrackingUrl = tracking?.url || null; // Por defecto, usamos el de Shopify

    // 1. Correos Express
    if (carrierName === "0002") {
      carrierName = "Correos Express";
    }

    // 2. DHL (Corrección de nombre y LINK)
    if (carrierName === "0003") {
      carrierName = "DHL";
      // Si tenemos el número, forzamos el enlace oficial de DHL España
      if (tracking?.number) {
        finalTrackingUrl = `https://www.dhl.com/es-es/home/tracking.html?tracking-id=${tracking.number}&submit=1`;
      }
    }

    return {
      found: true,
      data: {
        id: order.name,
        status: order.displayFulfillmentStatus,
        trackingNumber: tracking?.number || "No disponible aún",
        trackingUrl: finalTrackingUrl, // <--- Usamos nuestra URL corregida
        carrier: carrierName,
        items: items,
        price: price
      }
    };

  } catch (error) {
    console.error("❌ Error buscando pedido:", error);
    return { found: false, reason: "error" };
  }
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
  // En producción (Render), el sistema de archivos es efímero. 
  // Siempre intentamos cargar de disco primero por si reiniciamos rápido, 
  // pero si falla, descargamos de nuevo.
  if (fs.existsSync(INDEX_FILE)) {
    console.log("📦 Cargando productos desde caché...");
    try {
      aiIndex = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    } catch (e) {
      console.log("⚠️ Error leyendo caché, reindexando...");
      aiIndex = [];
    }
  }

  if (aiIndex.length === 0) {
    console.log("🤖 Indexando productos en Shopify (esto puede tardar)...");
    const products = await getAllProducts();
    for (const p of products) {
      const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: buildAIText(p) });
      aiIndex.push({ ...p, embedding: emb.data[0].embedding });
    }
    // Intentamos guardar en disco (aunque en Render se borrará al redesplegar)
    try { fs.writeFileSync(INDEX_FILE, JSON.stringify(aiIndex)); } catch (e) { }
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
// Función para convertir las variantes de Shopify a texto para la IA
function formatStockForAI(variantsEdges) {
    if (!variantsEdges || variantsEdges.length === 0) return "Sin información de stock.";

    let stockInfo = "STOCK Y PRECIOS ACTUALES:\n";

    variantsEdges.forEach(edge => {
        const variant = edge.node;
        const price = variant.price;
        const qty = variant.inventoryQuantity;
        const isAvailable = variant.availableForSale;

        // Extraemos Color y Talla limpiamente
        let color = "";
        let size = "";
        
        variant.selectedOptions.forEach(opt => {
            if (opt.name.toLowerCase() === "color") color = opt.value;
            if (opt.name.toLowerCase().includes("talla") || opt.name.toLowerCase() === "size") size = opt.value;
        });

        // Si no detecta opciones separadas, usa el título por defecto (ej: "Rojo / M")
        const variantName = (color && size) ? `${color} - Talla ${size}` : variant.title;

        // Determinamos el estado del stock
        let status = "";
        if (isAvailable && qty > 0) {
            status = qty <= 2 ? `🟢 ¡SOLO QUEDAN ${qty} UNIDADES!` : `🟢 ${qty} en stock`;
        } else {
            status = "🔴 AGOTADO";
        }

        // Añadimos la línea al resumen
        stockInfo += `- ${variantName}: ${status} (${price}€)\n`;
    });

    return stockInfo;
}

/* --- ENDPOINT PRINCIPAL (CEREBRO TOTAL + LOGS AGRUPADOS) --- */
app.post("/api/ai/search", async (req, res) => {
  const { q, history, visible_ids, session_id } = req.body;
  if (!q) return res.status(400).json({ error: "Falta query" });

  try {
    // ---------------------------------------------------------
    // 1. DETECCIÓN INTELIGENTE DE PEDIDOS
    // ---------------------------------------------------------
    let emailMatch = q.match(/[\w.-]+@[\w.-]+\.\w+/);
    let orderMatch = q.match(/#?(\d{4,})/);

    if ((!emailMatch || !orderMatch) && history) {
      const reversedHistory = [...history].reverse();
      const historyText = reversedHistory.map(h => h.content).join(" ");
      if (!emailMatch) emailMatch = historyText.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (!orderMatch) orderMatch = historyText.match(/#?(\d{4,})/);
    }

    let orderData = null;
    if (orderMatch && emailMatch) {
      const orderId = orderMatch[1];
      const email = emailMatch[0];
      console.log(`🔎 Buscando pedido ${orderId} para ${email}...`);

      const result = await getOrderStatus(orderId, email);
      if (result.found) {
        orderData = `[DATOS_ENCONTRADOS]
            ID: ${result.data.id}
            ESTADO_RAW: ${result.data.status}
            TRACKING: ${result.data.trackingNumber}
            LINK: ${result.data.trackingUrl || "No disponible"}
            CARRIER: ${result.data.carrier}
            ITEMS: ${result.data.items}
            PRECIO: ${result.data.price}`;
      } else if (result.reason === "email_mismatch") {
        orderData = "❌ ERROR SEGURIDAD: El email no coincide con el del pedido.";
      } else {
        orderData = "❌ ERROR: No existe ningún pedido con ese número.";
      }
    }

    // ---------------------------------------------------------
    // 2. PREPARACIÓN DE BÚSQUEDA DE PRODUCTOS
    // ---------------------------------------------------------
    const optimizedQuery = await refineQuery(q, history || []);
    if (aiIndex.length === 0) await loadIndexes();

    let contextProducts = [];
    if (visible_ids && visible_ids.length > 0) {
      contextProducts = aiIndex.filter(p => visible_ids.map(String).includes(String(p.id)));
    }

    const embResponse = await openai.embeddings.create({ model: "text-embedding-3-large", input: optimizedQuery });
    const vector = embResponse.data[0].embedding;

    const searchResults = aiIndex
      .map(p => ({ ...p, score: cosineSimilarity(vector, p.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const faqResults = faqIndex
      .map(f => ({ ...f, score: cosineSimilarity(vector, f.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    const combinedCandidates = new Map();
    contextProducts.forEach(p => combinedCandidates.set(String(p.id), p));
    searchResults.forEach(p => {
      if (combinedCandidates.size < 10) combinedCandidates.set(String(p.id), p);
    });
    const finalCandidatesList = Array.from(combinedCandidates.values());

    const productsContext = finalCandidatesList.map(p => {
      const colorOption = p.options ? p.options.find(o => o.name.match(/color|cor/i)) : null;
      const officialColors = colorOption ? colorOption.values.join(", ") : "Único";
      const cleanDescription = cleanText(p.body_html || p.description);
      const stockText = formatStockForAI(p.variants ? p.variants.edges : null);

      const isVisible = visible_ids && visible_ids.map(String).includes(String(p.id)) ? "(EN PANTALLA - USUARIO LO ESTÁ VIENDO)" : "";

      return `PRODUCTO ${isVisible}:
        - ID: ${p.id}
        - Título: ${p.title}
        - Precio: ${p.price} €
        - Colores: ${officialColors}
        - Descripción: ${cleanDescription}
        - Specs: ${JSON.stringify(p.metafields)}
        - Stock: ${stockText}`;
    }).join("\n\n");

    // ---------------------------------------------------------
    // 3. CEREBRO IA (PROMPT CORREGIDO)
    // ---------------------------------------------------------
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Eres Sazi, el asistente virtual oficial de Izas Outdoor. Tu tono es cercano, profesional y aventurero.

              ⛔ REGLAS DE SEGURIDAD (IMPORTANTE):
              1. COMPETENCIA Y CANALES DE VENTA:
                 - COMPARACIONES: No compares productos con otras marcas (Trango, North Face, etc.).Decathlon, Sprinter, Amazon y El Corte Inglés no es competencia directa, son distribuidores.
                 - CANALES DE VENTA (Decathlon, Amazon...): SI PREGUNTAN SI VENDEMOS ALLÍ: No mientas. Di: "Sí, colaboramos con partners como Decathlon o Amazon, pero te recomiendo comprar aquí en nuestra web oficial para acceder a todo el catálogo, ofertas exclusivas y garantía directa."

              2. CONOCIMIENTO:
                 - Usa "PRODUCTOS DISPONIBLES" para respuestas concretas.
                 - Usa "DATOS DE MARCA" (abajo) para hablar de calidad general o tecnologías.
                 - Si no sabes algo, di: "No tengo ese dato ahora mismo".

              --- MODOS DE RESPUESTA ---

              MODO A: ESCAPARATE / BUSCADOR
              - JSON "reply": Vende el producto. "Esta es nuestra mejor opción...".
              - JSON "products": [IDs encontrados].

              MODO B: COMPARACIÓN / DETALLES
              - Explica usando los datos técnicos.

              MODO C: RASTREO DE PEDIDOS
              - Si ves "[DATOS_ENCONTRADOS]", USA ESTRICTAMENTE ESTA PLANTILLA VISUAL:
                "📋 **Estado del pedido [ID]:**
                
                • **Estado:** [Traduce: FULFILLED->"✅ Enviado" | UNFULFILLED->"📦 En preparación"]
                • **Transportista:** [CARRIER]
                • **Tracking:** [TRACKING]
                • **Enlace:** <a href='[LINK]' target='_blank'>Pincha aquí para ver dónde está</a>
                • **Artículos:** [ITEMS]"

                (Nota: Si [LINK] es "No disponible", NO pongas la línea del enlace).

              - Si faltan datos: "Por motivos de seguridad, para consultar el estado necesito que me indiques tu número de pedido y el email de compra."

              --- DATOS ---

              DATOS PEDIDO LIVE:
              ${orderData || "N/A"}

              DATOS DE MARCA (Calidad/Tecnología/Distribución):
              ${BRAND_INFO}

              FAQs:
              ${faqResults.map(f => `P:${f.question} R:${f.answer}`).join("\n")}
              
              PRODUCTOS DISPONIBLES:
              ${productsContext}

              Responde JSON: { "reply": "...", "products": [...], "category": "ETIQUETA" }
              Etiquetas: LOGISTICA, PRODUCTO, COMPARATIVA, ATENCION_CLIENTE, OTRO.
              `
        },
        ...history.slice(-2).map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: q }
      ]
    });

    const aiContent = JSON.parse(completion.choices[0].message.content);

    // ---------------------------------------------------------
    // 4. PROCESADO DE RESPUESTA
    // ---------------------------------------------------------
    const seenIds = new Set();
    const finalProducts = (aiContent.products || []).map(aiProd => {
      const targetId = typeof aiProd === 'object' ? aiProd.id : aiProd;
      const original = finalCandidatesList.find(p => String(p.id) === String(targetId));
      if (!original || seenIds.has(original.id)) return null;
      seenIds.add(original.id);

      let displayImage = original.image;
      let displayUrlParams = "";
      if (typeof aiProd === 'object' && aiProd.variant_id && original.variants) {
        const v = original.variants.find(v => String(v.id) === String(aiProd.variant_id));
        if (v) { if (v.image) displayImage = v.image; displayUrlParams = `?variant=${v.id}`; }
      }
      return { ...original, displayImage, displayUrlParams };
    }).filter(Boolean);

    // ---------------------------------------------------------
    // 5. GUARDADO EN SUPABASE
    // ---------------------------------------------------------
    const currentSessionId = session_id || "anonimo";
    const newInteraction = [
      { role: "user", content: q, timestamp: new Date() },
      { role: "assistant", content: aiContent.reply, timestamp: new Date() }
    ];
    const fullHistoryToSave = [...(history || []), ...newInteraction];

    supabase.from('chat_sessions').upsert({
      session_id: currentSessionId,
      conversation: fullHistoryToSave,
      category: aiContent.category || "GENERAL",
      updated_at: new Date()
    }, { onConflict: 'session_id' })
      .then(({ error }) => {
        if (error) console.error("❌ Error Supabase:", error);
      });

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