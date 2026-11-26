/* ==========================================================================
   🕒 HISTORIAL GUARDADO: la base de datos manda
   ==========================================================================
   El widget envía el historial SIN horas. Antes se guardaba tal cual encima de
   la conversación, y con cada mensaje se borraban las horas de todos los
   anteriores (y lo que no estuviera en el navegador, como el "Sí, gracias" del
   feedback). Ahora se parte de lo ya guardado y del navegador solo se añade lo
   que de verdad falta.
   ========================================================================== */

// El backend guarda las respuestas del bot con un "[CONTEXTO SISTEMA: ...]" que
// el navegador no tiene: se ignora al comparar.
function messageKey(m) {
    return `${m.role}|${String(m.content ?? "").replace(/\n?\[CONTEXTO SISTEMA:[\s\S]*$/, "")}`;
}

export function mergeConversation(stored, clientHistory, { now, reservedPrefixes = [] }) {
    const base = Array.isArray(stored) ? stored : [];
    const client = Array.isArray(clientHistory) ? clientHistory : [];

    // ¿Qué mensajes del navegador no están guardados? Se cuenta, para no perder
    // un mensaje que se repite (p. ej. dos veces la misma respuesta de feedback).
    const available = new Map();
    base.forEach(m => available.set(messageKey(m), (available.get(messageKey(m)) || 0) + 1));
    let lastKnown = -1;
    const isNew = client.map((m, i) => {
        const key = messageKey(m);
        const left = available.get(key) || 0;
        if (left > 0) { available.set(key, left - 1); lastKnown = i; return false; }
        return true;
    });

    // Solo se añaden los nuevos que van DETRÁS del último conocido. Nunca se
    // acepta del navegador un mensaje que se haga pasar por un agente, ni su
    // hora: se pone la del servidor.
    const added = client
        .filter((m, i) => i > lastKnown && isNew[i])
        .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .filter(m => !reservedPrefixes.some(prefix => m.content.startsWith(prefix)))
        .map(m => ({ role: m.role, content: m.content, timestamp: now }));

    return [...base, ...added];
}
