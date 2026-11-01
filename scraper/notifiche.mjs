// Invia le notifiche: verifiche di domani (15:00) e compiti non spuntati (20:00), ora italiana.
// Variabili: IMPORT_SECRET; opzionale TIPO=verifiche|compiti per forzare (prova manuale).
import webpush from "web-push";

const SB_URL = process.env.SUPABASE_URL || "https://ukjpemlqushmuakswoww.supabase.co";
const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_zqMoAof9UjILkFp2TlDPtQ_-1BfpDjN";
const { IMPORT_SECRET } = process.env;
const APP_URL = "https://francescoprodige.github.io/compiti/";

async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

// Data e ora attuali in Italia
const ora = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "numeric", hour12: false }).format(new Date());
const oggiIt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date()); // YYYY-MM-DD
function prossimoGiornoScuola(iso) {
  const d = new Date(iso + "T12:00:00Z");
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
const nomeGiorno = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("it-IT", { weekday: "long", timeZone: "UTC" });

// 15 o 16 (se GitHub parte in ritardo) -> verifiche; 20 o 21 -> compiti. Mai due volte nello stesso giorno.
const h = Number(ora);
let tipo = process.env.TIPO || (h === 15 || h === 16 ? "verifiche" : h === 20 || h === 21 ? "compiti" : "");
const forzato = !!process.env.TIPO;
// Il sabato niente notifiche: quelle per il lunedì arrivano venerdì e domenica.
const giornoSett = new Date(oggiIt + "T12:00:00Z").getUTCDay();
if (!forzato && giornoSett === 6) { console.log("Sabato: nessuna notifica."); process.exit(0); }
if (!tipo) { console.log(`Ora italiana ${ora}: nessuna notifica da inviare.`); process.exit(0); }

const giorno = prossimoGiornoScuola(oggiIt);
const quando = new Date(giorno) - new Date(oggiIt) > 86400000 ? nomeGiorno(giorno) : "domani";
const d = await rpc("dati_notifiche", { segreto: IMPORT_SECRET, p_giorno: giorno });
const chiave = `${tipo}-${oggiIt}`;
if (!forzato && d.gia_inviate && d.gia_inviate[chiave]) { console.log("Già inviate oggi:", chiave); process.exit(0); }

const nomi = Object.fromEntries((d.figli || []).map((f) => [f.id, f.nome]));
const nome = (id) => nomi[id] || id;
let titolo = "", corpo = "";
if (tipo === "verifiche") {
  if (!d.verifiche.length) { console.log("Nessuna verifica per", giorno); if (!forzato) process.exit(0); titolo = "Prova notifiche"; corpo = `Nessuna verifica ${quando}.`; }
  else {
    titolo = `Verifiche ${quando}`;
    const per = {};
    for (const v of d.verifiche) (per[v.figlio] ||= []).push(`${v.tipo.toLowerCase()} di ${v.materia.toLowerCase()}${v.stato === "confermata" ? "" : " (da confermare)"}`);
    corpo = Object.entries(per).map(([f, l]) => `${nome(f)}: ${l.join(", ")}`).join("\n");
  }
} else {
  const per = {};
  for (const c of d.compiti) { per[c.figlio] ||= { tot: 0, mancano: [] }; per[c.figlio].tot++; if (!c.fatto) per[c.figlio].mancano.push(c.materia.toLowerCase()); }
  const conMancanti = Object.entries(per).filter(([, x]) => x.mancano.length);
  if (!conMancanti.length) { console.log("Tutto spuntato per", giorno); if (!forzato) process.exit(0); titolo = "Prova notifiche"; corpo = `Compiti per ${quando}: tutto spuntato.`; }
  else {
    titolo = `Compiti per ${quando} ancora da fare`;
    corpo = conMancanti.map(([f, x]) => `${nome(f)}: ${x.mancano.join(", ")}`).join("\n");
    const ok = Object.entries(per).filter(([, x]) => !x.mancano.length).map(([f]) => nome(f));
    if (ok.length) corpo += `\nTutto fatto: ${ok.join(", ")}`;
  }
}

webpush.setVapidDetails("mailto:compiti-bot@users.noreply.github.com", d.vapid_public, d.vapid_private);
const payload = JSON.stringify({ title: titolo, body: corpo, tag: tipo, url: APP_URL });
const scadute = [];
let inviate = 0;
for (const s of d.iscrizioni.filter((s) => s[tipo])) {
  try { await webpush.sendNotification(s.sub, payload, { TTL: 6 * 3600 }); inviate++; }
  catch (e) { console.warn("Invio fallito:", e.statusCode, e.body || e.message); if (e.statusCode === 404 || e.statusCode === 410) scadute.push(s.endpoint); }
}
await rpc("esito_notifiche", { segreto: IMPORT_SECRET, p_chiave: forzato ? `prova-${Date.now()}` : chiave, p_scadute: scadute });
console.log(`${titolo}: inviate ${inviate}, scadute ${scadute.length}`);
