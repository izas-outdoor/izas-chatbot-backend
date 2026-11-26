/* ==========================================================================
   📨 AVISO POR CORREO AL CLIENTE CUANDO LE CONTESTA UN AGENTE
   ==========================================================================
   El cliente que pide un agente puede dejar su correo. Cuando el agente
   responde, esperamos unos minutos (para agrupar varios mensajes) y, si el
   cliente no los ha visto en el chat, se los mandamos por correo.

   🔐 El correo se construye SOLO con "email_pending", que únicamente se rellena
   desde /api/chat/agent-reply (autenticado). Nunca desde "conversation": ese
   historial incluye texto que llega del navegador del cliente y alguien podría
   colar un mensaje falso para enviarlo desde nuestro dominio.

   Todo el estado vive en chat_sessions (no en memoria), así un reinicio del
   servidor no pierde envíos pendientes.
   ========================================================================== */

const DELAY_MS = Number(process.env.EMAIL_DELAY_MS) || 2 * 60 * 1000;
const SWEEP_MS = Number(process.env.EMAIL_SWEEP_MS) || 30 * 1000;
const RETRY_MS = Number(process.env.EMAIL_RETRY_MS) || 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// ⏳ Plazo de conservación del correo del cliente (provisional: pendiente de que
// lo confirme quien lleva protección de datos).
const RETENTION_DAYS = Number(process.env.EMAIL_RETENTION_DAYS) || 90;
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;

const FROM = 'Atención al cliente Izas Outdoor <web@izas-outdoor.com>';
const REPLY_TO = 'info@izas-outdoor.com';
const SUBJECT = 'Respuesta a tu consulta en Izas Outdoor';
const PRIVACY_URL = 'https://www.izas-outdoor.com/policies/privacy-policy';

const EMAIL_REGEX = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function buildEmail(messages) {
    const intro = "Te escribimos porque pediste hablar con un agente en el chat de nuestra web, izas-outdoor.com, y nos dejaste este correo.";
    const footer = "Recibes este mensaje porque se solicitó asistencia en nuestro chat con esta dirección. Si no has sido tú, puedes ignorarlo.";
    const text = [
        "Hola:", "", intro, "", "Nuestro equipo te ha respondido:", "",
        messages.map(m => m.content).join("\n\n"), "",
        "Si necesitas algo más sobre esta consulta, responde a este correo.", "",
        "Un saludo,", "Equipo de Izas Outdoor", "",
        footer, `Política de privacidad: ${PRIVACY_URL}`
    ].join("\n");

    const blocks = messages.map(m =>
        `<div style="background:#f4f5f6;border-radius:8px;padding:12px 16px;margin:0 0 10px">${escapeHtml(m.content).replace(/\n/g, "<br>")}</div>`
    ).join("");
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:560px">
<p>Hola:</p>
<p>${intro}</p>
<p><b>Nuestro equipo te ha respondido:</b></p>
${blocks}
<p>Si necesitas algo más sobre esta consulta, responde a este correo.</p>
<p>Un saludo,<br>Equipo de Izas Outdoor</p>
<p style="color:#888;font-size:12px;border-top:1px solid #ddd;padding-top:10px">${footer}<br><a href="${PRIVACY_URL}" style="color:#888">Política de privacidad</a></p>
</div>`;

    return { from: FROM, reply_to: REPLY_TO, subject: SUBJECT, text, html };
}

export function setupCustomerEmail({ app, supabase, fetch, agentMarker, agentCloseMarker }) {

    const update = (sessionId, values) =>
        supabase.from('chat_sessions').update(values).eq('session_id', sessionId);

    async function getRow(sessionId, columns) {
        const { data, error } = await supabase
            .from('chat_sessions').select(columns).eq('session_id', sessionId).single();
        return error ? null : data;
    }

    // Sesiones que han pedido un agente desde el último arranque. Hace falta porque
    // si el cliente sigue escribiendo antes de que le contesten, el bot puede
    // cambiar la etiqueta de la conversación y ya no parecería derivada.
    const requestedAgent = new Set();
    function markHandoff(sessionId) {
        requestedAgent.add(sessionId);
        if (requestedAgent.size > 5000) requestedAgent.delete(requestedAgent.values().next().value);
    }

    // ¿La conversación está ahora mismo en manos de un agente (o pidiéndolo)?
    function isHandedOff(row) {
        const conversation = row.conversation || [];
        for (let i = conversation.length - 1; i >= 0; i--) {
            const c = conversation[i]?.content;
            if (typeof c !== 'string') continue;
            if (c.startsWith(agentCloseMarker)) break;
            if (c.startsWith(agentMarker)) return true;
        }
        return row.category === 'DERIVACION_HUMANA';
    }

    /* ---------- El cliente deja su correo (ruta pública, la llama el widget) ---------- */
    app.post("/api/chat/email", async (req, res) => {
        const { session_id, email } = req.body || {};
        const clean = typeof email === 'string' ? email.trim().toLowerCase() : "";
        if (typeof session_id !== 'string' || !session_id) return res.status(400).json({ error: "Falta session_id" });
        if (clean.length > 254 || !EMAIL_REGEX.test(clean)) return res.status(400).json({ error: "Correo no válido" });

        try {
            const row = await getRow(session_id, 'conversation, category, customer_email, email_notified_at');
            if (!row || !(isHandedOff(row) || requestedAgent.has(session_id))) return res.status(409).json({ error: "La conversación no está pendiente de un agente" });

            // Puede corregirlo (errata) mientras no haya contestado nadie. En cuanto
            // hay respuesta de un agente o un envío, queda fijado: así nadie puede
            // desviar a otra dirección las respuestas de otra persona.
            if (row.customer_email && row.customer_email !== clean) {
                const agentAlreadyReplied = (row.conversation || []).some(m => String(m?.content || "").startsWith(agentMarker));
                if (agentAlreadyReplied || row.email_notified_at) {
                    return res.status(409).json({ error: "El correo ya no se puede cambiar" });
                }
            }

            const { error } = await update(session_id, { customer_email: clean, customer_email_at: new Date().toISOString() });
            if (error) throw error;
            // No devolvemos nunca el correo guardado.
            res.json({ success: true });
        } catch (error) {
            console.error("❌ Error guardando correo del cliente:", error.message || error);
            res.status(500).json({ error: "Error interno" });
        }
    });

    /* ---------- El widget avisa de que el cliente ha VISTO las respuestas ---------- */
    // seen_until = timestamp del último mensaje de agente mostrado con el chat
    // abierto y la pestaña visible. Lo posterior sigue pendiente de enviar.
    app.post("/api/chat/seen", async (req, res) => {
        const { session_id, seen_until } = req.body || {};
        const until = Date.parse(seen_until);
        if (typeof session_id !== 'string' || !session_id || Number.isNaN(until)) {
            return res.status(400).json({ error: "Faltan datos" });
        }
        try {
            const row = await getRow(session_id, 'email_pending');
            const pending = row?.email_pending || [];
            if (pending.length > 0) {
                const rest = pending.filter(m => Date.parse(m.at) > until);
                if (rest.length < pending.length) {
                    const values = { customer_seen_at: new Date().toISOString(), email_pending: rest.length ? rest : null };
                    if (!rest.length) Object.assign(values, { email_due_at: null, email_status: 'visto', email_error: null });
                    await update(session_id, values);
                }
            }
            res.json({ success: true });
        } catch (error) {
            console.error("❌ Error marcando respuesta como vista:", error.message || error);
            res.status(500).json({ error: "Error interno" });
        }
    });

    /* ---------- Un agente contesta: dejamos el aviso programado ---------- */
    // Nunca lanza: si falla el aviso, la respuesta del agente ya está guardada.
    async function queueAgentReply(sessionId, content, timestamp) {
        try {
            const row = await getRow(sessionId, 'customer_email, email_pending');
            if (!row?.customer_email) return;
            const pending = [...(row.email_pending || []), { content, at: timestamp }];
            const { error } = await update(sessionId, {
                email_pending: pending,
                email_due_at: new Date(Date.now() + DELAY_MS).toISOString(), // se reinicia con cada mensaje: se agrupan
                email_status: 'pendiente',
                email_error: null
            });
            if (error) throw error;
        } catch (error) {
            console.error(`❌ No se pudo programar el aviso al cliente (sesión ${sessionId}):`, error.message || error);
        }
    }

    /* ---------- Envío de lo que ya ha vencido ---------- */
    async function sendDue(row) {
        // "Reservamos" el envío: solo sigue quien consiga vaciar email_due_at, así
        // dos ejecuciones a la vez no mandan el correo dos veces.
        const { data: claimed } = await supabase
            .from('chat_sessions').update({ email_due_at: null })
            .eq('session_id', row.session_id).eq('email_due_at', row.email_due_at)
            .select('customer_email, email_pending');
        const job = claimed?.[0];
        if (!job?.customer_email || !job.email_pending?.length) return;

        const sending = job.email_pending;
        let failure = null;
        try {
            if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY no configurada");
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...buildEmail(sending), to: [job.customer_email] })
            });
            if (!response.ok) failure = `Resend ${response.status}: ${(await response.text()).slice(0, 300)}`;
        } catch (error) {
            failure = error.message || String(error);
        }

        // Releemos: mientras enviábamos, el agente puede haber escrito más.
        const latest = (await getRow(row.session_id, 'email_pending'))?.email_pending || [];
        const sentKeys = new Set(sending.map(m => m.at));

        if (!failure) {
            const rest = latest.filter(m => !sentKeys.has(m.at));
            const values = { email_pending: rest.length ? rest : null, email_notified_at: new Date().toISOString(), email_error: null };
            if (!rest.length) values.email_status = 'enviado';
            await update(row.session_id, values);
            console.log(`📨 Respuesta enviada por correo al cliente (sesión ${row.session_id})`);
            return;
        }

        const attempts = Math.max(0, ...sending.map(m => m.attempts || 0)) + 1;
        const values = {
            email_status: 'error',
            email_error: failure,
            email_pending: latest.map(m => sentKeys.has(m.at) ? { ...m, attempts } : m)
        };
        if (attempts < MAX_ATTEMPTS) values.email_due_at = new Date(Date.now() + RETRY_MS).toISOString();
        await update(row.session_id, values);
        console.error(`❌ Error enviando respuesta al cliente (sesión ${row.session_id}, intento ${attempts}/${MAX_ATTEMPTS}): ${failure}`);
    }

    let sweeping = false;
    async function sweep() {
        if (sweeping) return;
        sweeping = true;
        try {
            const { data, error } = await supabase
                .from('chat_sessions').select('session_id, email_due_at')
                .lte('email_due_at', new Date().toISOString()).limit(20);
            if (error) throw error;
            for (const row of data || []) await sendDue(row);
        } catch (error) {
            console.error("❌ Error revisando avisos pendientes:", error.message || error);
        } finally {
            sweeping = false;
        }
    }

    /* ---------- Borrado de correos pasado el plazo de conservación ---------- */
    async function purgeOldEmails() {
        const limit = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const { error } = await supabase
            .from('chat_sessions')
            .update({ customer_email: null, customer_email_at: null, email_due_at: null, email_pending: null, email_error: null })
            .lt('customer_email_at', limit);
        if (error) console.error("❌ Error borrando correos caducados:", error.message || error);
    }

    function start() {
        setInterval(sweep, SWEEP_MS);
        setInterval(purgeOldEmails, RETENTION_SWEEP_MS);
        purgeOldEmails();
        sweep();
    }

    return { queueAgentReply, markHandoff, start };
}
