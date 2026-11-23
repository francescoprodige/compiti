// Edge Function "notifiche": chiamata ogni 15 minuti da pg_cron.
// - 15:00 verifiche del prossimo giorno di scuola (non il sabato)
// - 20:00 compiti non spuntati del prossimo giorno di scuola
// - nuovi voti e note: avviso generico ai soli telefoni dei genitori, tra le 8 e le 21
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const APP_URL = "https://francescoprodige.github.io/compiti/";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function romaOra() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { oggi: `${p.year}-${p.month}-${p.day}`, ora: Number(p.hour) % 24, sabato: p.weekday === "Sat" };
}
function prossimoGiornoScuola(iso: string) {
  const d = new Date(iso + "T12:00:00Z");
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
const nomeGiorno = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("it-IT", { weekday: "long", timeZone: "UTC" });
const elenco = (a: string[]) => a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " e " + a[a.length - 1];

async function config() {
  const { data } = await db.from("config").select("k,v");
  return Object.fromEntries((data || []).map((r) => [r.k, r.v]));
}
async function meta(k: string) {
  const { data } = await db.from("meta").select("v").eq("k", k).maybeSingle();
  return data?.v;
}
async function segnaInviata(chiave: string) {
  const prima = (await meta("notifiche_inviate")) || {};
  await db.from("meta").upsert({ k: "notifiche_inviate", v: { ...prima, [chiave]: new Date().toISOString() }, aggiornato_il: new Date().toISOString() });
}

async function invia(iscr: any[], payload: object, log: string[]) {
  let ok = 0;
  for (const s of iscr) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" }); ok++; }
    catch (e: any) {
      log.push(`ERR ${String(s.endpoint).slice(-10)} ${e.statusCode} ${e.body || e.message}`);
      if (e.statusCode === 404 || e.statusCode === 410) await db.from("iscrizioni").update({ attiva: false }).eq("endpoint", s.endpoint);
    }
  }
  return ok;
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const cfg = await config();
  if (!body.key || body.key !== cfg.cron_key) return new Response("no", { status: 401 });
  webpush.setVapidDetails("mailto:compiti-bot@users.noreply.github.com", cfg.vapid_public, cfg.vapid_private);

  const { oggi, ora, sabato } = romaOra();
  const prova: string | undefined = body.prova; // "verifiche" | "compiti" | "voti"
  const log: string[] = [`${oggi} ore ${ora}${prova ? " prova " + prova : ""}`];
  const { data: iscr } = await db.from("iscrizioni").select("*").eq("attiva", true);
  const figli = Object.fromEntries(((await meta("figli")) || []).map((f: any) => [f.id, f.nome]));
  const nome = (id: string) => figli[id] || id;
  const gia = (await meta("notifiche_inviate")) || {};
  const giorno = prossimoGiornoScuola(oggi);
  const quando = (new Date(giorno).getTime() - new Date(oggi).getTime()) > 86400000 ? nomeGiorno(giorno) : "domani";

  // 1) Verifiche alle 15
  if (prova === "verifiche" || (!prova && ora === 15 && !sabato && !gia[`verifiche-${oggi}`])) {
    const { data: v } = await db.from("verifiche").select("figlio,materia,tipo,stato,scelta").eq("data", giorno).eq("rimosso", false);
    const lista = (v || []).filter((x) => x.scelta !== "esclusa");
    if (lista.length || prova) {
      const per: Record<string, string[]> = {};
      for (const x of lista) (per[x.figlio] ||= []).push(`${x.tipo.toLowerCase()} di ${x.materia.toLowerCase()}${(x.scelta || x.stato) === "confermata" ? "" : " (da confermare)"}`);
      const corpo = Object.entries(per).map(([f, l]) => `${nome(f)}: ${l.join(", ")}`).join("\n") || `Nessuna verifica ${quando}.`;
      const n = await invia((iscr || []).filter((s) => s.verifiche), { title: `Verifiche ${quando}`, body: corpo, tag: "verifiche", url: APP_URL }, log);
      log.push(`verifiche: ${n}`);
    }
    if (!prova) await segnaInviata(`verifiche-${oggi}`);
  }

  // 2) Compiti non spuntati alle 20
  if (prova === "compiti" || (!prova && ora === 20 && !gia[`compiti-${oggi}`])) {
    const { data: c } = await db.from("compiti").select("figlio,materia,fatto").eq("data", giorno).eq("rimosso", false).order("materia");
    const per: Record<string, { mancano: string[] }> = {};
    for (const x of c || []) { per[x.figlio] ||= { mancano: [] }; if (!x.fatto) per[x.figlio].mancano.push(x.materia.toLowerCase()); }
    const mancanti = Object.entries(per).filter(([, x]) => x.mancano.length);
    if (mancanti.length || prova) {
      let corpo = mancanti.map(([f, x]) => `${nome(f)}: ${x.mancano.join(", ")}`).join("\n") || "Tutto spuntato.";
      const ok = Object.entries(per).filter(([, x]) => !x.mancano.length).map(([f]) => nome(f));
      if (ok.length && mancanti.length) corpo += `\nTutto fatto: ${ok.join(", ")}`;
      const n = await invia((iscr || []).filter((s) => s.compiti), { title: `Compiti per ${quando} ancora da fare`, body: corpo, tag: "compiti", url: APP_URL }, log);
      log.push(`compiti: ${n}`);
    }
    if (!prova) await segnaInviata(`compiti-${oggi}`);
  }

  // 3) Nuovi voti e note: solo genitori, tra le 8 e le 21
  if (prova === "voti" || (!prova && ora >= 8 && ora < 21)) {
    const { data: nv } = await db.from("voti").select("id,figlio").eq("notificato", false);
    const { data: nn } = await db.from("note").select("id,figlio").eq("notificato", false);
    if ((nv || []).length || (nn || []).length || prova) {
      const fv = [...new Set((nv || []).map((x) => nome(x.figlio)))];
      const fn = [...new Set((nn || []).map((x) => nome(x.figlio)))];
      const righe: string[] = [];
      if (fv.length) righe.push(`${(nv || []).length > 1 ? "Nuovi voti" : "Nuovo voto"} per ${elenco(fv)}`);
      if (fn.length) righe.push(`${(nn || []).length > 1 ? "Nuove note" : "Nuova nota"} per ${elenco(fn)}`);
      const titolo = righe[0] || "Prova: nuovi voti e note";
      const n = await invia((iscr || []).filter((s) => s.genitore && s.voti), { title: titolo, body: righe.slice(1).join("\n") || "Apri l'area genitori per vedere.", tag: "voti", url: APP_URL + "#genitori" }, log);
      log.push(`voti/note: ${n}`);
      if (!prova) {
        if ((nv || []).length) await db.from("voti").update({ notificato: true }).in("id", nv!.map((x) => x.id));
        if ((nn || []).length) await db.from("note").update({ notificato: true }).in("id", nn!.map((x) => x.id));
      }
    }
  }

  await db.from("debug_pagine").upsert({ nome: "notifiche-ultimo-invio", url: "edge", testo: log.join("\n"), quando: new Date().toISOString() });
  return new Response(log.join("\n"), { headers: { "content-type": "text/plain" } });
});
